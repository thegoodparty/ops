// Slack does not render Markdown. It renders mrkdwn, which is a different
// language that happens to look like Markdown: `*bold*` not `**bold**`,
// `<url|label>` not `[label](url)`, no headings, no tables, no auto-numbered
// lists. Text written as Markdown does not degrade in Slack, it renders wrong
// — `## Root cause` appears with the hashes, a pipe table is a wall of pipes.
//
// The escaping is the part that bites hardest. Slack reads `<...>` as an
// entity, so one `<` in a quoted log line swallows everything after it and the
// API still returns success. `&`, `<` and `>` have to become `&amp;`, `&lt;`
// and `&gt;` everywhere Slack renders text, code spans and code blocks
// included.
//
// Two kinds of text reach Slack here and they are escaped differently:
//
// - Values. Signal titles, slugs, ids, numbers, anything out of telemetry.
//   They are data, never formatting, so `mrkdwn` escapes every interpolation.
// - Model prose. Root causes, evidence, hand-off briefs, post-mortems, the
//   answers the Slack agent writes. The model is told to write mrkdwn, so
//   `toMrkdwn` keeps the formatting it meant, converts the Markdown it slipped
//   into anyway, and escapes everything else.
//
// Nothing here is used on the way *into* the database. The stored root cause
// and post-mortem are what the agent wrote; conversion happens at the Slack
// boundary, so a later reader — the Slack agent querying `incident` — gets the
// source rather than `&lt;`-riddled markup.

import { makeLog } from "../logging";

const log = makeLog("slack-format");

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * The three characters Slack treats as markup. Ampersand goes first: escaping
 * it after `<` would turn the `&` of `&lt;` into `&amp;lt;`.
 *
 * Deliberately not idempotent. `escape("&amp;")` is `"&amp;amp;"`, because a
 * log line that literally contains `&amp;` has to survive, and "already
 * escaped?" is not a question this can answer. Nothing upstream pre-escapes:
 * the agent prompt tells the model to write the raw characters.
 */
export const escape = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Pre-rendered mrkdwn, exempt from escaping. Explicit, so it is greppable. */
export interface Raw {
  readonly raw: string;
}

export const raw = (markup: string): Raw => ({ raw: markup });

export type Value = string | number | Raw;

const interpolate = (value: Value, index: number): string => {
  if (typeof value === "string") return escape(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`mrkdwn interpolation #${index} is ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === "object" && value !== null && typeof value.raw === "string") {
    return value.raw;
  }
  // An undefined field interpolated into a template renders the word
  // "undefined" into the incident thread and nothing anywhere says so. The
  // types already forbid it; this is what makes a type hole loud.
  throw new Error(
    `mrkdwn interpolation #${index} is not a string, a finite number or raw()`,
  );
};

/**
 * Template tag for Boss-authored mrkdwn. The literal parts are the formatting
 * and are left alone; every interpolation is escaped unless it is `raw()`.
 */
export const mrkdwn = (
  parts: TemplateStringsArray,
  ...values: Value[]
): string =>
  parts.reduce(
    (out, part, index) =>
      index === 0 ? part : out + interpolate(values[index - 1], index) + part,
    "",
  );

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * What may appear inside `<@…>` and `<#…>`. Slack ids are opaque, so this is
 * not a shape check: it is the set of characters that cannot break out of the
 * entity. `<`, `>`, `&`, `|` and whitespace are what would, and escaping is
 * not an option here — a mention is only a mention as those exact bytes.
 */
const ENTITY_ID = /^[A-Za-z0-9._-]+$/;

/** Throws rather than posting `<@>` or a half-entity that eats the line. */
export const userMention = (userId: string): string => {
  if (!ENTITY_ID.test(userId)) {
    throw new Error(`unusable Slack user id: ${JSON.stringify(userId)}`);
  }
  return `<@${userId}>`;
};

export const channelLink = (channelId: string): string => {
  if (!ENTITY_ID.test(channelId)) {
    throw new Error(`unusable Slack channel id: ${JSON.stringify(channelId)}`);
  }
  return `<#${channelId}>`;
};

/**
 * A link, as `<url|label>`. The label cannot contain a pipe — Slack splits on
 * the first one and there is no escape for it — so pipes in a label become
 * slashes rather than silently truncating the label at the first pipe.
 */
export const link = (url: string, label?: string): string => {
  if (!url.trim()) throw new Error("link() needs a url");
  const target = escape(url.trim());
  const text = label?.trim();
  return text ? `<${target}|${escape(text).replaceAll("|", "/")}>` : `<${target}>`;
};

/** Slack has no list markup, so a bullet is a literal character we type. */
export const bullets = (items: readonly string[]): string =>
  items.map((item) => `• ${item}`).join("\n");

// ---------------------------------------------------------------------------
// Model prose -> mrkdwn
// ---------------------------------------------------------------------------

/**
 * The spans of model prose that survive untouched.
 *
 * Code first, so a `**` inside a fenced block stays what the agent typed. Then
 * the two entity forms an agent may legitimately write: a user or channel
 * reference, and a link.
 *
 * Broadcasts — `<!here>`, `<!channel>`, `<!subteam^S…>` — are deliberately
 * absent. Which three events earn a ping is the Boss's decision (`relay.ts`,
 * MENTION_EVENTS), and at twenty incidents a week an agent that can page the
 * rotation for itself is how the rotation gets muted. They fall through to
 * escaping, so they render as literal text rather than disappearing.
 */
const SEGMENT = new RegExp(
  [
    "(",
    "```[\\s\\S]*?```", // fenced block
    "|```[\\s\\S]*", // an unterminated fence still means "this is code"
    "|`[^`\\n]+`", // inline code
    "|<[@#][A-Z0-9]+(?:\\|[^<>|]*)?>", // user or channel
    "|<(?:https?://|mailto:)[^<>|\\s]+(?:\\|[^<>|]*)?>", // link
    ")",
  ].join(""),
);

const isDivider = (line: string): boolean => {
  const body = line.trim();
  return /^[|\-:\s]+$/.test(body) && body.includes("|") && body.includes("--");
};

const isTableRow = (line: string): boolean => line.trim().startsWith("|");

/**
 * A pipe table is unreadable in Slack and there is no markup that fixes it, so
 * the columns are kept the only way Slack keeps columns: a monospaced block.
 * The `|---|---|` divider goes, since it is Markdown's way of marking a header
 * row and carries nothing once the table is just text.
 */
const convertTables = (text: string): string => {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && isTableRow(lines[end])) end++;
    const block = lines.slice(i, end);
    if (block.length >= 2 && block.some(isDivider)) {
      out.push("```", ...block.filter((line) => !isDivider(line)), "```");
    } else {
      out.push(...block);
    }
    i = end;
  }
  return out.join("\n");
};

const convertProse = (text: string): string => {
  let out = escape(text);
  out = convertTables(out);
  // Slack has no headings at any level. A bold line on its own is the
  // substitute, and it is what the agent is told to write.
  out = out.replace(/^([ \t]*)#{1,6}[ \t]+(.+?)[ \t]*$/gm, "$1*$2*");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  out = out.replace(/__([^_\n]+)__/g, "*$1*");
  out = out.replace(/~~([^~\n]+)~~/g, "~$1~");
  // Already escaped, so this builds the entity directly rather than going
  // through link(), which escapes what it is given.
  out = out.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) =>
      label.trim() ? `<${url}|${label.replaceAll("|", "/")}>` : `<${url}>`,
  );
  out = out.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  return out;
};

/**
 * Render model-authored prose as mrkdwn.
 *
 * The model is instructed to write mrkdwn already (`agent/prompt.ts`), so this
 * is the backstop rather than the mechanism: it converts the Markdown that
 * slips through anyway, and it does the escaping, which the model is told not
 * to attempt by hand.
 */
export const toMrkdwn = (text: string): string =>
  text
    .split(SEGMENT)
    .map((segment, index) =>
      index % 2 === 0
        ? convertProse(segment)
        : // Odd indices are the captured spans. An entity is those exact bytes
          // or it is not an entity; code is escaped like everything else,
          // because Slack renders `&lt;` inside a code block as `<`.
          segment.startsWith("<")
          ? segment
          : escape(segment),
    )
    .join("");

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

/**
 * Per-message budget. `chat.postMessage` accepts 40,000 characters and
 * truncates past it, which is the failure this avoids: a post-mortem cut mid
 * sentence with a 200 OK. 3,000 is Slack's own per-block ceiling and about as
 * much as anyone reads in one message.
 */
export const MAX_MESSAGE_CHARS = 3000;

/** Room for the `_(2/3)_` marker, which is added after chunking. */
const CONTINUATION_RESERVE = 16;

/** Room for a fence the split has to close and reopen. */
const FENCE_RESERVE = 8;

const hardSplit = (line: string, size: number): string[] => {
  if (line.length <= size) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const space = window.lastIndexOf(" ");
    const cut = space > size * 0.6 ? space : size;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
};

/**
 * Split one message into as many as it needs, on line boundaries.
 *
 * A post-mortem is long by design and truncation is the one outcome that
 * cannot be recovered from by reading further, so the remainder becomes the
 * next message in the same thread. A code fence open at a split is closed and
 * reopened, otherwise the rest of the post-mortem renders as code.
 */
export const splitForSlack = (
  text: string,
  max: number = MAX_MESSAGE_CHARS,
): string[] => {
  if (!Number.isInteger(max) || max < 200) {
    throw new Error(`splitForSlack needs a budget of 200 or more, got ${max}`);
  }
  if (text.length <= max) return [text];

  const budget = max - CONTINUATION_RESERVE;
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let openFence = false;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push([...current, ...(openFence ? ["```"] : [])].join("\n"));
    current = [];
    length = 0;
  };

  const push = (line: string) => {
    if (current.length === 0 && openFence) {
      current.push("```");
      length += 4;
    }
    current.push(line);
    length += line.length + 1;
  };

  for (const line of text.split("\n")) {
    for (const piece of hardSplit(line, budget - FENCE_RESERVE)) {
      if (length + piece.length + 1 > budget && current.length > 0) flush();
      push(piece);
      if (piece.trimStart().startsWith("```")) openFence = !openFence;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks.map((chunk, index) => `${chunk}\n_(${index + 1}/${chunks.length})_`);
};

/**
 * Convert, split, and post every part into the same thread. The first ts is
 * returned because that is the message the rest hang off.
 *
 * A split is not a failure, but it is a thing that happened to somebody's
 * post-mortem, so it is said out loud rather than inferred from the channel.
 */
export const postProse = async (
  post: (text: string) => Promise<{ ts: string }>,
  text: string,
  context: Record<string, unknown> = {},
): Promise<{ ts: string }> => {
  const parts = splitForSlack(toMrkdwn(text));
  if (parts.length > 1) log("message_split", { ...context, parts: parts.length });
  let first: { ts: string } | null = null;
  for (const part of parts) {
    const posted = await post(part);
    first = first ?? posted;
  }
  if (!first) throw new Error("splitForSlack produced no message to post");
  return first;
};
