import { contextOf, isBilled, type Transcript } from "./transcript";

export interface EmbeddedDoc {
  path: string;
  chars: number;
}

/** The `<document path="...">` blocks the prompt composer embeds. */
export const embeddedDocs = (systemPrompt: string): EmbeddedDoc[] =>
  [
    ...systemPrompt.matchAll(/<document path="([^"]*)">[\s\S]*?<\/document>/g),
  ].map((match) => ({ path: match[1], chars: match[0].length }));

/**
 * Characters of each tool definition mcp-grafana v1.6.1 serves under
 * `GRAFANA_MCP_ARGS`, measured as JSON of name, description and input schema
 * from its own `tools/list` on 2026-09-29. Public schema sizes, not data.
 */
export const GRAFANA_TOOL_CHARS: Record<string, number> = {
  analyze_loki_labels: 1591,
  check_datasources_health: 491,
  diff_tempo_traces: 1647,
  get_dashboard_by_uid: 1191,
  get_dashboard_panel_queries: 1245,
  get_dashboard_property: 1224,
  get_dashboard_summary: 466,
  get_datasource: 618,
  get_tempo_trace: 366,
  get_tempo_traceql_docs: 760,
  list_dashboard_versions: 644,
  list_datasources: 983,
  list_loki_label_names: 1176,
  list_loki_label_values: 1460,
  list_prometheus_label_names: 1580,
  list_prometheus_label_values: 1719,
  list_prometheus_metric_metadata: 867,
  list_prometheus_metric_names: 1482,
  list_tempo_attribute_names: 636,
  list_tempo_attribute_values: 807,
  query_loki_logs: 3595,
  query_loki_patterns: 1357,
  query_loki_stats: 1724,
  query_prometheus: 1665,
  query_prometheus_histogram: 1541,
  query_tempo_metrics: 1292,
  search_dashboards: 881,
  search_folders: 324,
  search_tempo_traces: 707,
};

const GRAFANA_PREFIX = "grafana_";

export interface ToolUse {
  /** Grafana tools the newest transcript was offered. */
  offered: string[];
  /** Grafana tools any transcript in the corpus called. */
  used: string[];
  unusedChars: number;
  /** Offered tools with no measured size, so the trim is not overstated silently. */
  unmeasured: string[];
}

export const grafanaToolUse = (transcripts: Transcript[]): ToolUse => {
  const newest = [...transcripts].sort((a, b) => b.startedAt - a.startedAt)[0];
  const offered = (newest?.toolNames ?? [])
    .filter((name) => name.startsWith(GRAFANA_PREFIX))
    .map((name) => name.slice(GRAFANA_PREFIX.length));
  const called = new Set<string>();
  for (const transcript of transcripts) {
    for (const turn of transcript.turns) {
      for (const call of turn.toolCalls) {
        if (call.name.startsWith(GRAFANA_PREFIX)) {
          called.add(call.name.slice(GRAFANA_PREFIX.length));
        }
      }
    }
  }
  const used = offered.filter((name) => called.has(name));
  const unused = offered.filter((name) => !called.has(name));
  return {
    offered,
    used,
    unusedChars: unused.reduce(
      (sum, name) => sum + (GRAFANA_TOOL_CHARS[name] ?? 0),
      0,
    ),
    unmeasured: unused.filter((name) => GRAFANA_TOOL_CHARS[name] === undefined),
  };
};

export interface Calibration {
  /** Characters per token of the system prompt, one sample per launch used. */
  charsPerToken: number[];
  /** Tokens of the tool-definition block, read off cross-incident cache hits. */
  toolBlockTokens: number[];
}

/**
 * A fresh incident whose first turn read a small slice from cache got that
 * slice from a sibling incident with the same toolset: the tool block, which
 * sits before the system prompt and is identical across incidents. What was
 * written on that turn is then the system prompt plus the kickoff message,
 * which measures characters per token on our own prompt.
 */
export const calibrate = (transcripts: Transcript[]): Calibration => {
  const charsPerToken: number[] = [];
  const toolBlockTokens: number[] = [];
  for (const transcript of transcripts) {
    const first = transcript.turns.find(isBilled);
    if (!first || first.launch !== 0 || !transcript.systemPrompt) continue;
    const { cacheRead } = first.usage;
    const context = contextOf(first.usage);
    if (cacheRead <= 0 || cacheRead > 0.5 * context) continue;
    toolBlockTokens.push(cacheRead);
    charsPerToken.push(transcript.systemPrompt.length / (context - cacheRead));
  }
  return { charsPerToken, toolBlockTokens };
};

export const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
