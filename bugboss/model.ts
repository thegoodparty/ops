// The model seam the Boss's own bounded calls are written against: triage,
// root-cause correlation, the inbound-language read and the Slack agent.
//
// It lives beside types.ts rather than inside triage/ because four modules in
// three directories build against it, and the one that owns it should not be
// one of its callers.
//
// The interface is deliberately smaller than any SDK's -- one call, tools in,
// text and tool calls out. Two reasons. These calls run inside the Boss
// process on a wall-clock budget, so they must not inherit a harness's
// session, resume and streaming machinery; and the end-to-end test has to
// substitute a fake without standing up Bedrock.

export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ModelTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ModelToolCall[] }
  | { role: "toolResult"; toolCallId: string; text: string; isError?: boolean };

export interface ModelRequest {
  system: string;
  messages: ModelTurn[];
  tools: ModelToolSpec[];
  maxTokens: number;
  /** Aborted when the call's wall-clock budget runs out. */
  signal: AbortSignal;
}

/**
 * What one request cost, as Bedrock reported it.
 *
 * Tokens rather than dollars, for the reason the incident row already stores
 * tokens: a price table goes stale silently, and tokens plus `modelId`
 * multiply out correctly whenever they are asked. `costUsd` rides along as
 * what the provider priced this request at while it ran, and is only ever
 * presented as a derived estimate.
 */
export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  modelId: string | null;
  /**
   * Requests that reached the model. Not decoration: tokens are never
   * legitimately zero for a request that got a reply, so calls above zero
   * next to a zero total is the signature of a reader that has drifted from
   * what the provider reports -- which is how the agent's own usage
   * accounting went wrong once already.
   */
  calls: number;
}

export const emptyModelUsage = (): ModelUsage => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  modelId: null,
  calls: 0,
});

/**
 * Add one request's usage onto a running total, in place.
 *
 * In place because the total has to survive a throw. A bounded call that
 * times out, or exhausts its rounds, or never produces a valid answer has
 * still spent every token it spent, and every one of those paths leaves
 * through an exception. A usage figure returned alongside the answer would
 * count only the calls that succeeded, which is precisely backwards: the
 * storm worth costing is the one where triage fell back 67 times.
 */
export const addModelUsage = (total: ModelUsage, one: ModelUsage): void => {
  total.tokensIn += one.tokensIn;
  total.tokensOut += one.tokensOut;
  total.cacheRead += one.cacheRead;
  total.cacheWrite += one.cacheWrite;
  total.costUsd += one.costUsd;
  total.calls += one.calls;
  total.modelId = one.modelId ?? total.modelId;
};

/**
 * Thrown by a `ModelClient` when a request reached the model and failed.
 *
 * It carries the usage because that is the only way a caller can bank what a
 * failed call spent: every failure path out of a bounded call is an
 * exception, so a figure returned beside the answer would count only the
 * calls that worked.
 */
export class ModelRequestFailed extends Error {
  constructor(
    message: string,
    readonly usage: ModelUsage,
  ) {
    super(message);
    this.name = "ModelRequestFailed";
  }
}

/**
 * Usage flattened for a log line or an alarm payload.
 *
 * The dollar figure is renamed rather than passed through, because this is
 * the shape a person reads and `costUsd` reads like a fact. It is arithmetic
 * over a price table that goes stale silently whenever AWS moves a rate, so
 * the tokens next to it are the record and this is a derived estimate. Doing
 * the renaming here makes that structural rather than something three call
 * sites have to remember.
 */
export const usageForLog = (usage: ModelUsage) => ({
  tokensIn: usage.tokensIn,
  tokensOut: usage.tokensOut,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  modelCalls: usage.calls,
  modelId: usage.modelId,
  costUsdEstimate: usage.costUsd,
});

export interface ModelReply {
  text: string;
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}
