/**
 * The neutral shape every eval measure is written against: model requests
 * with their usage, the tool calls each one made and the results that came
 * back, and timestamps. Nothing here is specific to any harness. An adapter
 * turns a recorded source into a Trace: `adapters/proxy-log.ts` reads the
 * model proxy's log, which sees every request whatever sent it.
 */

export type Ttl = "5m" | "1h";

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

/** One model request and its response. */
export interface Turn {
  index: number;
  id: string;
  startedAt: number;
  model: string;
  /** The cache lifetime this request's writes got, as the adapter knows it. */
  cacheTtl: Ttl;
  stopReason: string;
  error: string | null;
  usage: Usage;
  toolCalls: ToolCall[];
  results: ToolResult[];
  /** Which process sent it; a new process is a relaunch. */
  launch: number;
}

export interface Exit {
  at: number;
  reason: string;
  error: string | null;
  launch: number;
}

export interface Trace {
  id: string;
  startedAt: number;
  model: string;
  systemPrompt: string;
  toolNames: string[];
  turns: Turn[];
  exits: Exit[];
  launches: number;
}

export const isRefusal = (text: string, isError: boolean): boolean =>
  isError || text.trimStart().startsWith("error:");

export const contextOf = (usage: Usage): number =>
  usage.input + usage.cacheRead + usage.cacheWrite;

/** A turn the provider billed. Error turns in the crash loop bill nothing. */
export const isBilled = (turn: Turn): boolean => contextOf(turn.usage) > 0;
