// Triage (Job 2) and root-cause correlation (Job 2b). Design spec:
// bugboss/docs/architecture.md.
//
// Both are advisory. The caller applies what comes back through `assign`, and
// neither entry point throws: triage degrades to opening an incident,
// correlation degrades to proposing no merge.

import type { TriageContext, TriageDecision } from "../types";
import {
  runCorrelation,
  type CorrelationRequest,
  type CorrelationResult,
} from "./correlate";
import type { ModelClient } from "./model";
import type { IncidentReader } from "./sql";
import { runTriage, type TriageOutcome } from "./triage";

export interface TriageConfig {
  model: ModelClient;
  db: IncidentReader;
  /** Wall clock for one call. Defaults to 55s, under the spec's 60s target. */
  budgetMs?: number;
  maxRounds?: number;
  maxTokens?: number;
}

export interface Triage {
  /** Exactly one decision per signal. */
  decide(ctx: TriageContext): Promise<TriageDecision>;
  /**
   * The same decision, plus the `recurrenceOf` pointer the incident row
   * needs, which `TriageDecision` has nowhere to carry.
   */
  decideDetailed(ctx: TriageContext): Promise<TriageOutcome>;
  correlate(req: CorrelationRequest): Promise<CorrelationResult>;
}

export const createTriage = (config: TriageConfig): Triage => ({
  decide: async (ctx) => (await runTriage(config, ctx)).decision,
  decideDetailed: (ctx) => runTriage(config, ctx),
  correlate: (req) => runCorrelation(config, req),
});

export { runTriage } from "./triage";
export { runCorrelation } from "./correlate";
export { prepareQuery, QUERY_TOOL, SEARCH_TOOL, searchTool } from "./sql";
export {
  conclusiveRecurrence,
  findRecurrenceCandidates,
  renderRecurrence,
  CANDIDATE_LOOKBACK_MS,
  RECURRENCE_WINDOW_MS,
} from "./recurrence";
export { runStructuredCall } from "./model";
// The seam itself lives in ../model.ts. Re-exported here because slack/ has
// always reached the Boss's model surface through this barrel, and a caller
// that gets the types from one module and the helpers from another is how the
// two drift.
export { addModelUsage, emptyModelUsage, ModelRequestFailed, usageForLog } from "../model";
// Not triage's alone: it tracks the fallback rate of every bounded model
// call the Boss makes, including the inbound-language read in slack/.
export { recordCall, resetFallbackRates, SUSTAINED_FALLBACK_RATE } from "./health";
export type { FallbackRate } from "./health";

export type { TriageDeps, TriageOutcome } from "./triage";
export type {
  CorrelateDeps,
  CorrelationRequest,
  CorrelationResult,
  MergeProposal,
} from "./correlate";
export type { IncidentReader } from "./sql";
export type { RecurrenceCandidate } from "./recurrence";
export type {
  LoopTool,
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelToolCall,
  ModelToolSpec,
  ModelUsage,
  ModelTurn,
  StructuredCall,
} from "./model";
