// The adapter registry. Design spec: bugboss/docs/architecture.md, Job 1.
//
// Keyed by source name because Signal.source is a free string rather than a
// union: a new source is an adapter and a registry entry, not a type change.
//
// Note that a registry key is the INGRESS CHANNEL, while Signal.source is the
// signal taxonomy, and the two differ for one pair on purpose. The "slack" and
// "human" adapters both emit signals with source "human" — the spec says a
// report is the same signal whether it arrived by @bugboss or by MCP — so
// their dedup keys collide, which is what stops one report from opening two
// incidents when it arrives down both paths.

import type { SignalAdapter } from "../types";

import { createGrafanaAdapter, type GrafanaConfig } from "./grafana";
import { createHumanAdapter, type HumanConfig } from "./human";
import { createSlackAdapter, type SlackConfig } from "./slack";

export interface IngressRegistry {
  get(source: string): SignalAdapter;
  has(source: string): boolean;
  list(): string[];
}

export const createIngressRegistry = (
  adapters: SignalAdapter[],
): IngressRegistry => {
  const bySource = new Map<string, SignalAdapter>();
  for (const adapter of adapters) {
    if (bySource.has(adapter.source)) {
      throw new Error(`Duplicate ingress adapter for source "${adapter.source}"`);
    }
    bySource.set(adapter.source, adapter);
  }

  return {
    get: (source) => {
      const adapter = bySource.get(source);
      if (!adapter) {
        throw new Error(
          `No ingress adapter for source "${source}". Available: ${[
            ...bySource.keys(),
          ].join(", ")}`,
        );
      }
      return adapter;
    },
    has: (source) => bySource.has(source),
    list: () => [...bySource.keys()],
  };
};

export interface IngressConfig {
  grafana?: GrafanaConfig;
  slack?: SlackConfig;
  human?: HumanConfig;
}

/** The three adapters BugBoss launches with. */
export const createIngress = (config: IngressConfig = {}): IngressRegistry =>
  createIngressRegistry([
    createGrafanaAdapter(config.grafana),
    createSlackAdapter(config.slack),
    createHumanAdapter(config.human),
  ]);

export {
  createGrafanaAdapter,
  createLokiQuery,
  parseKnownCauses,
  GRAFANA_SOURCE,
  KNOWN_CAUSES_ANNOTATION,
  ANNOTATION_PREFIX,
  META_PREFIX,
  SLUG_LABEL,
  ENVIRONMENT_LABEL,
  RULE_NAME_LABEL,
  MAX_QUERIES_PER_ALERT,
  MAX_LINES,
  MAX_LINE_BYTES,
  LOOKBACK_SECONDS,
} from "./grafana";
export type {
  GrafanaConfig,
  GrafanaVerifier,
  KnownCause,
  LokiQuery,
  LokiQueryOptions,
} from "./grafana";

export {
  createSlackAdapter,
  classifySlackEvent,
  createSlackVerifier,
  SLACK_SOURCE,
  REPORT_VERBS,
} from "./slack";
export type {
  SlackClassification,
  SlackConfig,
  SlackMessage,
  SlackVerifier,
} from "./slack";

export {
  createHumanAdapter,
  humanSignal,
  isNeverSuppressed,
  HUMAN_SOURCE,
  NEVER_SUPPRESS_LABEL,
  RESOLUTION_POLICY_LABEL,
  REPORTED_VIA_LABEL,
  SLACK_CHANNEL_LABEL,
  SLACK_THREAD_TS_LABEL,
  SLACK_MESSAGE_TS_LABEL,
} from "./human";
export type { HumanConfig, HumanReport, ReportedVia } from "./human";
