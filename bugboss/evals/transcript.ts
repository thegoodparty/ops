import { readFile } from "node:fs/promises";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  text: string;
  isError: boolean;
  /**
   * Our tools refuse a call by returning text that starts `error:` with
   * `isError: false`, so a check keyed on `isError` alone misses every one.
   */
  refused: boolean;
}

export interface Turn {
  index: number;
  entryId: string;
  startedAt: number;
  api: string;
  stopReason: string;
  errorMessage: string | null;
  usage: Usage;
  toolCalls: ToolCall[];
  results: ToolResult[];
  launch: number;
}

export interface Exit {
  at: number;
  reason: string;
  error: string | null;
  launch: number;
}

export interface Transcript {
  id: string;
  startedAt: number;
  systemPrompt: string;
  toolNames: string[];
  turns: Turn[];
  exits: Exit[];
  launches: number;
}

type Json = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

const parseUsage = (raw: unknown): Usage => {
  const usage = (raw ?? {}) as Json;
  const cost = (usage.cost ?? {}) as Json;
  return {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    cacheWrite1h: num(usage.cacheWrite1h),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
      total: num(cost.total),
    },
  };
};

const resultText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((part: Json) => part.type === "text")
        .map((part: Json) => String(part.text ?? ""))
        .join("\n")
    : "";

export const isRefusal = (text: string, isError: boolean): boolean =>
  isError || text.trimStart().startsWith("error:");

export const parseTranscript = (id: string, jsonl: string): Transcript => {
  const entries = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Json);

  const transcript: Transcript = {
    id,
    startedAt: 0,
    systemPrompt: "",
    toolNames: [],
    turns: [],
    exits: [],
    launches: 0,
  };
  const byCallId = new Map<string, Turn>();

  for (const entry of entries) {
    if (entry.type === "session") {
      transcript.startedAt = Date.parse(String(entry.timestamp));
      continue;
    }
    if (entry.type === "custom" && entry.customType === "bugboss_prompt") {
      const data = entry.data as Json;
      transcript.systemPrompt = String(data.systemPrompt ?? "");
      transcript.toolNames = (data.toolNames as string[]) ?? [];
      continue;
    }
    if (entry.type === "custom" && entry.customType === "bugboss_exit") {
      const data = entry.data as Json;
      transcript.exits.push({
        at: num(data.at) || Date.parse(String(entry.timestamp)),
        reason: String(data.reason ?? ""),
        error: typeof data.error === "string" ? data.error : null,
        launch: transcript.launches - 1,
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Json;
    if (message.role === "user") {
      transcript.launches += 1;
      continue;
    }
    if (message.role === "assistant") {
      const content = (message.content as Json[]) ?? [];
      const turn: Turn = {
        index: transcript.turns.length + 1,
        entryId: String(entry.id),
        startedAt: num(message.timestamp) || Date.parse(String(entry.timestamp)),
        api: String(message.api ?? ""),
        stopReason: String(message.stopReason ?? ""),
        errorMessage:
          typeof message.errorMessage === "string" ? message.errorMessage : null,
        usage: parseUsage(message.usage),
        toolCalls: content
          .filter((part) => part.type === "toolCall")
          .map((part) => ({
            id: String(part.id),
            name: String(part.name),
            args: (part.arguments as Record<string, unknown>) ?? {},
          })),
        results: [],
        launch: Math.max(0, transcript.launches - 1),
      };
      for (const call of turn.toolCalls) byCallId.set(call.id, turn);
      transcript.turns.push(turn);
      continue;
    }
    if (message.role === "toolResult") {
      const text = resultText(message.content);
      const isError = message.isError === true;
      const owner = byCallId.get(String(message.toolCallId));
      owner?.results.push({
        toolCallId: String(message.toolCallId),
        toolName: String(message.toolName),
        text,
        isError,
        refused: isRefusal(text, isError),
      });
    }
  }
  return transcript;
};

export const readTranscript = async (
  path: string,
  id = path.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
): Promise<Transcript> => parseTranscript(id, await readFile(path, "utf8"));

export const contextOf = (usage: Usage): number =>
  usage.input + usage.cacheRead + usage.cacheWrite;

/** A turn the provider billed. Error turns in the crash loop bill nothing. */
export const isBilled = (turn: Turn): boolean => contextOf(turn.usage) > 0;
