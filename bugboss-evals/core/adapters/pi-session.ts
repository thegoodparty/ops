import { readFile } from "node:fs/promises";

import {
  isRefusal,
  type Trace,
  type Ttl,
  type Turn,
  type Usage,
} from "../trace";

/**
 * Reads Pi's session.jsonl into a Trace. Everything Pi-specific about the
 * format stays in this file.
 */

/**
 * Runs before about 02:35 UTC 2026-09-29 went through the Converse path, whose
 * effective cache TTL was five minutes; after it, InvokeModel, which honours
 * the 1h TTL. Pi records the path in `api`, and the timestamp is the fallback
 * for a turn that does not carry it.
 */
export const INVOKE_MODEL_CUTOVER = Date.parse("2026-09-29T02:35:00Z");

export const cacheTtlOf = (api: string, startedAt: number): Ttl => {
  if (api.includes("converse")) return "5m";
  if (api.includes("invoke")) return "1h";
  return startedAt < INVOKE_MODEL_CUTOVER ? "5m" : "1h";
};

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

export const parsePiSession = (id: string, jsonl: string): Trace => {
  const entries = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Json);

  const transcript: Trace = {
    id,
    startedAt: 0,
    model: "",
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
      if (typeof data.modelId === "string") transcript.model = data.modelId;
      continue;
    }
    if (entry.type === "model_change" && typeof entry.modelId === "string") {
      transcript.model ||= entry.modelId;
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
      const startedAt =
        num(message.timestamp) || Date.parse(String(entry.timestamp));
      const usage = parseUsage(message.usage);
      const turn: Turn = {
        index: transcript.turns.length + 1,
        id: String(entry.id),
        startedAt,
        model: String(message.model ?? transcript.model),
        cacheTtl:
          usage.cacheWrite1h > 0
            ? "1h"
            : cacheTtlOf(String(message.api ?? ""), startedAt),
        stopReason: String(message.stopReason ?? ""),
        error:
          typeof message.errorMessage === "string" ? message.errorMessage : null,
        usage,
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

export const readPiSession = async (
  path: string,
  id = path.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
): Promise<Trace> => parsePiSession(id, await readFile(path, "utf8"));

