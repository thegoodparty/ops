// An incident agent's session, as the Boss reads it: one entry per turn,
// saying what the agent called and what came back, rather than the JSONL.
//
// The raw tail is what the Boss used to get, and sixty lines of it was
// 199,928 characters in prod -- file reads, test output and whole scripts --
// after which the Boss's next turn produced nothing at all. So this is bounded
// by a count of turns, and every text in it is either whole or described.
// Nothing is cut mid-content: a quarter of a stack trace reads as the whole
// thing, and that is the failure the repo-wide rule exists to prevent.

/** Longest text shown whole. Past it, a whole first unit or a description. */
const EXCERPT_CHARS = 400;

/** Longest argument or one-line result shown inline on a tool-call line. */
const INLINE_CHARS = 120;

interface TextPart {
  type: "text";
  text: string;
}
interface ThinkingPart {
  type: "thinking";
  thinking?: string;
  redacted?: boolean;
}
interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, JsonValue>;
}
interface OtherPart {
  type: "image" | string;
}
type Part = TextPart | ThinkingPart | ToolCallPart | OtherPart;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SessionLine {
  type?: string;
  timestamp?: string;
  customType?: string;
  data?: { reason?: string };
  message?: {
    role?: string;
    content?: string | Part[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
  };
}

const count = (n: number): string => n.toLocaleString("en-US");

const plural = (n: number, noun: string): string =>
  `${count(n)} ${noun}${n === 1 ? "" : "s"}`;

const quote = (text: string): string => `"${text}"`;

const lineCount = (text: string): number => text.split("\n").length;

/**
 * A text whole if it is short; else its first paragraph or first line whole,
 * labelled as the first of however many; else a description of its size.
 * Never a slice: every unit returned is one the author wrote as a unit.
 */
export const excerpt = (raw: string, noun: string): string => {
  const text = raw.trim();
  if (text.length <= EXCERPT_CHARS) return quote(text);
  const paragraphs = text.split(/\n\s*\n/);
  if (paragraphs.length > 1 && paragraphs[0].trim().length <= EXCERPT_CHARS) {
    return `${quote(paragraphs[0].trim())} (first of ${count(paragraphs.length)} paragraphs)`;
  }
  const lines = text.split("\n");
  if (lines.length > 1 && lines[0].trim().length <= EXCERPT_CHARS) {
    return `${quote(lines[0].trim())} (first of ${count(lines.length)} lines)`;
  }
  return `(${count(text.length)} characters of ${noun}, not shown)`;
};

const describeString = (key: string, value: string): string => {
  if (value.length <= INLINE_CHARS && !value.includes("\n")) return quote(value);
  const lines = value.split("\n");
  const first = lines[0].trim();
  const shape =
    lines.length > 1
      ? `a ${count(lines.length)}-line, ${count(value.length)}-character ${key}`
      : `a ${count(value.length)}-character ${key}`;
  return first && first.length <= INLINE_CHARS
    ? `${shape} whose first line is ${quote(first)}`
    : shape;
};

const describeArg = (key: string, value: JsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") return describeString(key, value);
  const json = JSON.stringify(value);
  if (json.length <= INLINE_CHARS) return json;
  return Array.isArray(value)
    ? `(a list of ${plural(value.length, "item")})`
    : `(an object with ${plural(Object.keys(value).length, "key")})`;
};

const PATH_KEYS = ["path", "file_path", "filePath", "file"];

const pathOf = (args: Record<string, JsonValue>): string | null => {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return null;
};

const partsOf = (content: string | Part[] | undefined): Part[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);

const textOf = (parts: Part[]): string =>
  parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");

const outcomeOf = (
  call: ToolCallPart,
  result: NonNullable<SessionLine["message"]> | undefined,
): string => {
  if (!result) return "→ no result recorded";
  const parts = partsOf(result.content);
  const text = textOf(parts).trim();
  const images = parts.filter((p) => p.type === "image").length;
  const extra = images > 0 ? ` (+${plural(images, "image")})` : "";
  if (result.isError) {
    const first = text.split("\n")[0].trim();
    if (!first) return `→ error, no message${extra}`;
    return first.length <= EXCERPT_CHARS
      ? `→ error: ${first}${lineCount(text) > 1 ? ` (first of ${count(lineCount(text))} lines)` : ""}${extra}`
      : `→ error, ${count(text.length)} characters of error output${extra}`;
  }
  if (!text) return `→ ok, empty${extra}`;
  if (text.length <= INLINE_CHARS && !text.includes("\n")) return `→ ok: ${quote(text)}${extra}`;
  const path = pathOf(call.arguments ?? {});
  if (path && /read/i.test(call.name)) {
    return `→ read ${count(text.length)} characters from ${path}${extra}`;
  }
  return `→ ok, ${count(text.length)} characters over ${plural(lineCount(text), "line")}${extra}`;
};

const clock = (timestamp: string | undefined): string => {
  if (!timestamp) return "";
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "";
  return ` (${at.toISOString().substring(11, 19)}Z)`;
};

type Item =
  | { kind: "turn"; number: number; entry: SessionLine; parts: Part[] }
  | { kind: "note"; line: string };

export const renderSessionTurns = (
  body: string,
  turns: number,
): { text: string; totalTurns: number; shownTurns: number } => {
  const items: Item[] = [];
  const results = new Map<string, NonNullable<SessionLine["message"]>>();
  let torn = 0;
  let totalTurns = 0;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: SessionLine;
    try {
      entry = JSON.parse(trimmed) as SessionLine;
    } catch {
      torn += 1;
      continue;
    }
    if (entry.type === "compaction") {
      items.push({ kind: "note", line: "(earlier history was compacted into a summary here)" });
      continue;
    }
    if (entry.type === "custom") {
      if (entry.customType === "bugboss_exit" && entry.data?.reason) {
        items.push({ kind: "note", line: `Run ended: ${entry.data.reason}${clock(entry.timestamp)}` });
      }
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "assistant") {
      totalTurns += 1;
      items.push({ kind: "turn", number: totalTurns, entry, parts: partsOf(message.content) });
    } else if (message.role === "toolResult" && message.toolCallId) {
      results.set(message.toolCallId, message);
    } else if (message.role === "user") {
      const text = textOf(partsOf(message.content)).trim();
      items.push({
        kind: "note",
        line: text ? `Input to the agent: ${excerpt(text, "input")}` : "Input to the agent (no text)",
      });
    }
  }

  const wanted = Math.max(0, Math.floor(turns));
  const firstShown = totalTurns - wanted + 1;
  const start =
    wanted === 0
      ? items.length
      : Math.max(
          0,
          items.findIndex((item) => item.kind === "turn" && item.number >= firstShown),
        );

  const out: string[] = [];
  const hidden = Math.max(0, totalTurns - wanted);
  if (hidden > 0) out.push(`(${plural(hidden, "earlier turn")} not shown)`);
  if (torn > 0) out.push(`(${plural(torn, "unreadable line")} skipped)`);

  let shownTurns = 0;
  for (const item of items.slice(start)) {
    if (item.kind === "note") {
      out.push(item.line);
      continue;
    }
    shownTurns += 1;
    out.push(`Turn ${item.number}${clock(item.entry.timestamp)}`);
    for (const part of item.parts) {
      if (part.type === "thinking") {
        const thinking = part as ThinkingPart;
        if (thinking.redacted) out.push("  thought: (redacted reasoning)");
        else if (thinking.thinking?.trim()) out.push(`  thought: ${excerpt(thinking.thinking, "reasoning")}`);
      } else if (part.type === "text") {
        const text = (part as TextPart).text;
        if (text.trim()) out.push(`  wrote: ${excerpt(text, "text")}`);
      }
    }
    for (const part of item.parts) {
      if (part.type !== "toolCall") continue;
      const call = part as ToolCallPart;
      const args = Object.entries(call.arguments ?? {})
        .map(([key, value]) => `${key}: ${describeArg(key, value)}`)
        .join(", ");
      out.push(`  ${call.name}(${args}) ${outcomeOf(call, results.get(call.id))}`);
    }
    const message = item.entry.message;
    if (message?.stopReason === "error" || message?.errorMessage) {
      out.push(
        `  the model call failed${message.errorMessage ? `: ${excerpt(message.errorMessage, "error text")}` : ""}`,
      );
    }
  }

  return { text: out.join("\n"), totalTurns, shownTurns };
};
