// Grafana ingress. Design spec: bugboss/docs/architecture.md, Job 1.
//
// Two things here fail in deliberately opposite directions.
//
// VERIFICATION FAILS CLOSED. The endpoint is reachable from the internet
// (Grafana Cloud posts to it over a public ALB), and an unauthenticated one
// lets anyone open incidents, spend agent turns and write into an engineering
// Slack channel. So a missing secret rejects every delivery rather than
// waving them through, which is the one failure in this file that must not
// fail open.
//
// EVIDENCE GATHERING FAILS LOUD. A query that could not run comes back as an
// Evidence entry saying so, never as an empty result. "Nothing matched" is
// grounds to reject a known cause; "we could not look" is grounds to open an
// incident, and collapsing the two would make a Loki outage read as a week in
// which no known cause ever matched.

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  Evidence,
  IncomingRequest,
  RawSignal,
  Signal,
  SignalAdapter,
} from "../types";
import { RESOLUTION_POLICY_LABEL } from "./human";
import { makeAlarm, makeLog } from "../logging";

export const GRAFANA_SOURCE = "grafana";

export const SIGNATURE_HEADER = "X-Grafana-Alerting-Signature";

// Grafana has no default name for this one: the contact point names the header
// it puts the Unix timestamp in, and omitting it makes Grafana sign the body
// alone. We require it, so an unnamed timestamp header is a rejected delivery
// rather than a silently replayable one.
export const TIMESTAMP_HEADER = "X-Grafana-Alerting-Timestamp";

// Skew is allowed in both directions. Grafana Cloud's clock and ours are both
// NTP-disciplined, so a delivery more than this far out is a replay or a
// misconfiguration, and neither should be ingested.
export const REPLAY_WINDOW_SECONDS = 300;

// The annotation carrying the alert's known-cause registry, serialised onto
// the rule by omni's packages/gp-api/deploy/components/alerting. THE NAME IS A
// CONTRACT WITH THAT FILE: renaming it on either side makes every alert look
// like it has no known causes, which fails safe but removes every pre-fetched
// piece of evidence triage was going to run on. A rename leaves no error to
// find, so the share of alerts arriving with none is logged on every delivery
// and a registry that parses but drops entries alarms.
export const KNOWN_CAUSES_ANNOTATION = "known_causes";

export const SLUG_LABEL = "alert_slug";
export const ENVIRONMENT_LABEL = "environment";
export const RULE_NAME_LABEL = "alertname";

// RawSignal.labels is the only structured carrier a signal has, so Grafana's
// annotations and delivery metadata ride in it alongside the real labels.
// Prefixed rather than merged flat: an annotation named `summary` would
// otherwise shadow a label named `summary`, and triage keys off labels.
export const ANNOTATION_PREFIX = "annotation_";
export const META_PREFIX = "grafana_";

// Caps, ported from omni's alert_filter/evidence.py where they were sized
// against the real Loki bill. Cost is the constraint, not latency: an
// evidence query runs on every firing of its alert and Loki bills the bytes it
// decompresses, so an under-narrowed query is an invoice rather than an error.
export const MAX_QUERIES_PER_ALERT = 6;
export const MAX_LINES = 50;
export const MAX_LINE_BYTES = 2_000;

// Wider than any rule's own evaluation window, because by the time a
// notification has been grouped, routed and delivered the lines that caused it
// are already minutes behind.
export const LOOKBACK_SECONDS = 3_600;

export const QUERY_TIMEOUT_MS = 8_000;

const METRIC_RESULT_TYPES = new Set(["matrix", "vector"]);

// Recent alerts kept to make the known-cause share visible. Sized to a burst,
// not to a day.
const COVERAGE_WINDOW = 100;

const log = makeLog("grafana");

const alarm = makeAlarm("grafana");

export interface KnownCause {
  id: string;
  summary: string;
  /** A LogQL query. Absent when the notification's own labels settle it. */
  evidence: string | null;
  confirmedBy: string;
  action: "suppress" | "annotate";
  ticket: string | null;
}

/** Milliseconds, both bounds. The client converts to Loki's nanoseconds. */
export interface LokiQueryOptions {
  start: number;
  end: number;
  limit: number;
}

export type LokiQuery = (
  logql: string,
  options: LokiQueryOptions,
) => Promise<string[]>;

/** Throws when the request is not an authentic Grafana delivery. */
export type GrafanaVerifier = (req: IncomingRequest) => void;

export interface GrafanaConfig {
  /** HMAC shared secret. Absent means no delivery can be verified. */
  secret?: string;
  /** Defaults to `secret`, for a contact point configured with one value. */
  basicAuthPassword?: string;
  signatureHeader?: string;
  timestampHeader?: string;
  replayWindowSeconds?: number;
  loki?: LokiQuery;
  now?: () => number;
  /**
   * Replaces the whole HMAC + basic auth check. A TEST SEAM ONLY: passing one
   * in production is how this endpoint becomes an open one.
   */
  verifier?: GrafanaVerifier;
}

const headerValue = (
  req: IncomingRequest,
  name: string,
): string | undefined => {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
};

const equalSecrets = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so the length is compared
  // first and non-constant-time. The length of a hex digest is public.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const mapping = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // A non-string is dropped rather than coerced. Every consumer treats a
    // present key as a fact, and `environment` in particular picks the log
    // stream an evidence query reads, where "undefined" would be a real stream
    // name that matches nothing.
    if (typeof entry === "string" && entry.length > 0) out[key] = entry;
  }
  return out;
};

const status = (value: unknown): string | null => {
  const raw = text(value);
  return raw ? raw.trim().toLowerCase() : null;
};

export interface ParsedKnownCauses {
  causes: KnownCause[];
  /** Entries the annotation carried that could never match, so were dropped. */
  malformed: number;
  /** The annotation was unreadable, as opposed to absent or an empty list. */
  unreadable: boolean;
}

export const readKnownCauses = (raw: string | undefined): ParsedKnownCauses => {
  if (!raw) return { causes: [], malformed: 0, unreadable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed annotation yields no causes, which is the same outcome for
    // triage as an alert that declares none. It is not the same event, so it
    // is reported separately: this annotation is a contract with omni's
    // alerting component and a broken one is invisible everywhere else.
    return { causes: [], malformed: 0, unreadable: true };
  }
  if (!Array.isArray(parsed)) {
    return { causes: [], malformed: 0, unreadable: true };
  }

  const causes: KnownCause[] = [];
  let malformed = 0;
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      malformed++;
      continue;
    }
    const cause = item as Record<string, unknown>;
    const id = text(cause.id);
    const summary = text(cause.summary);
    const confirmedBy = text(cause.confirmedBy);
    const action = text(cause.action);
    // A cause with no id cannot be named in a suppress decision and one with
    // no confirmedBy cannot be confirmed against anything, so both are dropped
    // rather than carried as a cause that can never match.
    if (!id || !summary || !confirmedBy) {
      malformed++;
      continue;
    }
    if (action !== "suppress" && action !== "annotate") {
      malformed++;
      continue;
    }
    causes.push({
      id,
      summary,
      evidence: text(cause.evidence),
      confirmedBy,
      action,
      ticket: text(cause.ticket),
    });
  }
  return { causes, malformed, unreadable: false };
};

/** The causes alone, for callers with nothing to do about what was dropped. */
export const parseKnownCauses = (raw: string | undefined): KnownCause[] =>
  readKnownCauses(raw).causes;

const truncate = (line: string): string => {
  const encoded = Buffer.from(line, "utf8");
  if (encoded.length <= MAX_LINE_BYTES) return line;
  // Cut on a byte boundary and repair the edge. The limit is about prompt
  // bytes, so slicing by characters would let a line of multi-byte content
  // pass the check and blow the budget.
  const cut = encoded.subarray(0, MAX_LINE_BYTES).toString("utf8");
  return `${cut.replace(/�+$/, "")} …[truncated]`;
};

export const linesFrom = (payload: unknown): string[] => {
  const body = payload as { data?: { resultType?: unknown; result?: unknown } };
  const data = body?.data;
  if (!data || typeof data !== "object") return [];
  if (METRIC_RESULT_TYPES.has(String(data.resultType))) return [];

  const lines: string[] = [];
  const result = Array.isArray(data.result) ? data.result : [];
  for (const stream of result) {
    if (typeof stream !== "object" || stream === null) continue;
    // A matrix sample's [ts, value] pair is shaped exactly like a log entry's
    // [ns, line], so the per-entry marker is checked as well as resultType.
    // Without it the value "42" reaches triage as a log line reading 42.
    if ("metric" in stream) continue;
    const values = (stream as { values?: unknown }).values;
    for (const entry of Array.isArray(values) ? values : []) {
      if (Array.isArray(entry) && entry.length >= 2) {
        lines.push(truncate(String(entry[1])));
      }
      if (lines.length >= MAX_LINES) return lines;
    }
  }
  return lines;
};

/**
 * The default Loki client. Credentials are read at call time rather than at
 * import, so this module stays importable in a test that has no Loki.
 */
export const createLokiQuery = (): LokiQuery => async (logql, options) => {
  const base = process.env.LOKI_URL;
  const user = process.env.LOKI_USER;
  const token = process.env.LOKI_TOKEN;
  if (!base || !user || !token) {
    throw new Error("Loki credentials are not configured");
  }

  const params = new URLSearchParams({
    query: logql,
    start: String(Math.trunc(options.start * 1_000_000)),
    end: String(Math.trunc(options.end * 1_000_000)),
    limit: String(options.limit),
    // Newest first, so a truncated result is the recent end of the window
    // rather than an arbitrary slice of it.
    direction: "backward",
  });

  const credentials = Buffer.from(`${user}:${token}`, "utf8").toString(
    "base64",
  );

  let res: Response;
  try {
    res = await fetch(
      `${base.replace(/\/+$/, "")}/loki/api/v1/query_range?${params}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Basic ${credentials}`,
        },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new Error(`Loki unreachable (${(err as Error).name})`);
  }

  // The status, never the body. A Loki error body echoes the query, and the
  // query is registry text that reaches a model prompt downstream.
  if (!res.ok) throw new Error(`Loki returned HTTP ${res.status}`);

  try {
    return linesFrom(await res.json());
  } catch {
    throw new Error("Loki returned a body that was not JSON");
  }
};

const describeCause = (cause: KnownCause, lines: string[]): string => {
  const head = [
    `known cause ${cause.id} (${cause.action}): ${cause.summary}`,
    `confirmed by: ${cause.confirmedBy}`,
    cause.ticket ? `ticket: ${cause.ticket}` : null,
    lines.length === 0
      ? "the evidence query matched no lines"
      : `${lines.length} matching line(s), newest first:`,
  ].filter((part): part is string => part !== null);
  return [...head, ...lines].join("\n");
};

const renderBody = (
  annotations: Record<string, string>,
  alert: Record<string, unknown>,
  root: Record<string, unknown>,
): string => {
  const values = alert.values;
  const rendered =
    typeof values === "object" && values !== null && !Array.isArray(values)
      ? Object.entries(values as Record<string, unknown>)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(", ")
      : "";

  const truncated = Number(root.truncatedAlerts ?? 0);

  return [
    annotations.summary ?? null,
    annotations.description ?? null,
    rendered ? `values: ${rendered}` : null,
    text(alert.startsAt) ? `started: ${alert.startsAt}` : null,
    text(alert.endsAt) ? `ended: ${alert.endsAt}` : null,
    text(alert.generatorURL) ? `alert: ${alert.generatorURL}` : null,
    text(alert.dashboardURL) ? `dashboard: ${alert.dashboardURL}` : null,
    text(alert.panelURL) ? `panel: ${alert.panelURL}` : null,
    text(alert.silenceURL) ? `silence: ${alert.silenceURL}` : null,
    text(root.externalURL) ? `grafana: ${root.externalURL}` : null,
    Number.isFinite(truncated) && truncated > 0
      ? `NOTE: Grafana truncated ${truncated} further alert(s) from this delivery`
      : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n");
};

export const createGrafanaAdapter = (
  config: GrafanaConfig = {},
): SignalAdapter => {
  const now = config.now ?? Date.now;
  const loki = config.loki ?? createLokiQuery();
  const replayWindow = config.replayWindowSeconds ?? REPLAY_WINDOW_SECONDS;


  /**
   * Whether each recent alert arrived declaring any known cause. The share is
   * the only place the KNOWN_CAUSES_ANNOTATION contract shows: renaming it on
   * the omni side makes every alert look like it declares none, which removes
   * every pre-fetched piece of evidence without erroring anywhere, so the
   * share is logged on every delivery.
   */
  const causeCoverage: boolean[] = [];

  const verify: GrafanaVerifier =
    config.verifier ??
    ((req) => {
      const secret = config.secret;
      if (!secret) {
        throw new Error(
          "grafana ingress: no webhook secret is configured, so no delivery can be verified",
        );
      }

      const signature = headerValue(
        req,
        config.signatureHeader ?? SIGNATURE_HEADER,
      );
      if (!signature) {
        throw new Error("grafana ingress: missing signature header");
      }

      const stamp = headerValue(req, config.timestampHeader ?? TIMESTAMP_HEADER);
      if (!stamp) {
        throw new Error("grafana ingress: missing timestamp header");
      }
      const seconds = Number(stamp);
      if (!Number.isFinite(seconds)) {
        throw new Error("grafana ingress: timestamp header is not a number");
      }
      if (Math.abs(now() / 1000 - seconds) > replayWindow) {
        throw new Error("grafana ingress: timestamp outside the replay window");
      }

      const expected = createHmac("sha256", secret)
        .update(`${stamp}:${req.rawBody}`, "utf8")
        .digest("hex");
      if (!equalSecrets(signature.trim(), expected)) {
        throw new Error("grafana ingress: signature mismatch");
      }

      const expectedPassword = config.basicAuthPassword ?? secret;
      const authorization = headerValue(req, "authorization") ?? "";
      if (!/^basic /i.test(authorization)) {
        throw new Error("grafana ingress: missing basic auth");
      }
      let decoded: string;
      try {
        decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString(
          "utf8",
        );
      } catch {
        throw new Error("grafana ingress: unreadable basic auth");
      }
      const colon = decoded.indexOf(":");
      // The user is ignored; only the password is checked, which is what the
      // existing gpbot-alert-filter contact point already sends.
      const password = colon === -1 ? "" : decoded.slice(colon + 1);
      if (!equalSecrets(password, expectedPassword)) {
        throw new Error("grafana ingress: basic auth mismatch");
      }
    });

  const parse = async (req: IncomingRequest): Promise<RawSignal[]> => {
    verify(req);

    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      throw new Error("grafana ingress: body was not JSON");
    }
    if (typeof payload !== "object" || payload === null) {
      throw new Error("grafana ingress: body was not an object");
    }

    const root = payload as Record<string, unknown>;
    const deliveryResolved = status(root.status) === "resolved";
    const groupLabels = mapping(root.groupLabels);
    const commonLabels = mapping(root.commonLabels);
    const commonAnnotations = mapping(root.commonAnnotations);
    const receiver = text(root.receiver);
    const groupKey = text(root.groupKey);
    const externalURL = text(root.externalURL);

    const rawTruncated = Number(root.truncatedAlerts ?? 0);
    const truncatedAlerts = Number.isFinite(rawTruncated) ? rawTruncated : 0;
    if (truncatedAlerts > 0) {
      alarm("alerts_truncated", {
        truncatedAlerts,
        receiver,
        groupKey,
        note: "Grafana dropped these alerts from the delivery and they arrive nowhere else; the contact point needs maxAlerts: 0",
      });
    }

    const alerts = Array.isArray(root.alerts) ? root.alerts : [];
    const signals: RawSignal[] = [];

    for (const entry of alerts) {
      if (typeof entry !== "object" || entry === null) continue;
      const alert = entry as Record<string, unknown>;
      const fingerprint = text(alert.fingerprint);
      // Without a fingerprint there is no dedup key, so a Grafana retry would
      // open a second incident for the same alert.
      if (!fingerprint) continue;

      // A resolved notification is discarded outright. An alert that fired
      // means something needed attention, and an alert that stopped firing on
      // its own does not mean it no longer does -- it means the symptom went
      // away. Only an agent closes an incident, on evidence it went and got.
      if (deliveryResolved || status(alert.status) === "resolved") continue;

      // The alert's own labels win, with the group's as fallback. That order
      // is what keeps four grouped per-route alerts distinguishable:
      // groupLabels hold only what the group is keyed by.
      const labels = {
        ...groupLabels,
        ...commonLabels,
        ...mapping(alert.labels),
      };
      const annotations = {
        ...commonAnnotations,
        ...mapping(alert.annotations),
      };

      const declared = readKnownCauses(annotations[KNOWN_CAUSES_ANNOTATION]);
      if (declared.unreadable || declared.malformed > 0) {
        alarm("known_causes_malformed", {
          fingerprint,
          slug: labels[SLUG_LABEL] ?? null,
          unreadable: declared.unreadable,
          malformed: declared.malformed,
          note: "these causes can never match, so triage runs without the evidence they name",
        });
      }
      causeCoverage.push(declared.causes.length > 0);
      if (causeCoverage.length > COVERAGE_WINDOW) causeCoverage.shift();

      const carried: Record<string, string> = { ...labels };
      for (const [key, value] of Object.entries(annotations)) {
        carried[`${ANNOTATION_PREFIX}${key}`] = value;
      }
      const meta: Record<string, string | null> = {
        status: status(alert.status) ?? "firing",
        receiver,
        group_key: groupKey,
        external_url: externalURL,
        generator_url: text(alert.generatorURL),
        silence_url: text(alert.silenceURL),
        dashboard_url: text(alert.dashboardURL),
        panel_url: text(alert.panelURL),
        starts_at: text(alert.startsAt),
        ends_at: text(alert.endsAt),
      };
      for (const [key, value] of Object.entries(meta)) {
        if (value) carried[`${META_PREFIX}${key}`] = value;
      }
      if (truncatedAlerts > 0) {
        carried[`${META_PREFIX}truncated_alerts`] = String(truncatedAlerts);
      }
      carried[RESOLUTION_POLICY_LABEL] = "auto";

      const startedAt = Date.parse(String(alert.startsAt ?? ""));

      signals.push({
        source: GRAFANA_SOURCE,
        sourceId: fingerprint,
        kind: "alert",
        title:
          annotations.summary ??
          labels[RULE_NAME_LABEL] ??
          labels[SLUG_LABEL] ??
          "Grafana alert",
        body: renderBody(annotations, alert, root),
        labels: carried,
        reportedBy: null,
        openedAt: Number.isFinite(startedAt) ? startedAt : now(),
      });
    }

    const withCauses = causeCoverage.filter((has) => has).length;
    log("parsed", {
      alerts: signals.length,
      truncatedAlerts,
      recentAlerts: causeCoverage.length,
      recentWithKnownCauses: withCauses,
      zeroCauseRate:
        causeCoverage.length === 0
          ? 0
          : Math.round((1 - withCauses / causeCoverage.length) * 1000) / 1000,
    });

    return signals;
  };

  const prefetchEvidence = async (signal: RawSignal): Promise<Evidence[]> => {
    const causes = parseKnownCauses(
      signal.labels[`${ANNOTATION_PREFIX}${KNOWN_CAUSES_ANNOTATION}`],
    ).filter((cause): cause is KnownCause & { evidence: string } =>
      Boolean(cause.evidence),
    );

    const end = now();
    const start = end - LOOKBACK_SECONDS * 1_000;
    const run = causes.slice(0, MAX_QUERIES_PER_ALERT);

    const gathered = await Promise.all(
      run.map(async (cause): Promise<Evidence> => {
        try {
          const lines = await loki(cause.evidence, {
            start,
            end,
            limit: MAX_LINES,
          });
          return {
            query: cause.evidence,
            summary: describeCause(cause, lines.slice(0, MAX_LINES)),
            artifactKey: null,
          };
        } catch (err) {
          return {
            query: cause.evidence,
            summary:
              `known cause ${cause.id}: EVIDENCE UNAVAILABLE, the query could not be run ` +
              `(${(err as Error).message}). This is not the same as matching nothing: ` +
              `the cause is neither confirmed nor ruled out.`,
            artifactKey: null,
          };
        }
      }),
    );

    // Causes past the cap are reported as unchecked rather than dropped, so
    // the ceiling is visible in the incident instead of on an invoice.
    for (const cause of causes.slice(MAX_QUERIES_PER_ALERT)) {
      gathered.push({
        query: cause.evidence,
        summary:
          `known cause ${cause.id}: NOT CHECKED, this alert declares more than ` +
          `${MAX_QUERIES_PER_ALERT} causes with evidence queries.`,
        artifactKey: null,
      });
    }

    return gathered;
  };

  return {
    source: GRAFANA_SOURCE,
    parse,
    dedupKey: (signal) => `${signal.source}:${signal.sourceId}`,
    prefetchEvidence,
  };
};
