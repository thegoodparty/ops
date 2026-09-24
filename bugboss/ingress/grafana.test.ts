import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  ANNOTATION_PREFIX,
  KNOWN_CAUSES_ANNOTATION,
  MAX_LINES,
  MAX_LINE_BYTES,
  MAX_QUERIES_PER_ALERT,
  META_PREFIX,
  createGrafanaAdapter,
  linesFrom,
  parseKnownCauses,
  type KnownCause,
  type LokiQuery,
} from "./grafana";
import type { IncomingRequest, RawSignal, Signal } from "../types";

const SECRET = "grafana-shared-secret";
const NOW = 1_764_000_000_000;
const now = () => NOW;

const basic = (password: string) =>
  `Basic ${Buffer.from(`grafana:${password}`, "utf8").toString("base64")}`;

const sign = (body: string, stamp: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`${stamp}:${body}`, "utf8").digest("hex");

const request = (
  body: unknown,
  overrides: {
    stamp?: string;
    signature?: string;
    password?: string;
    headers?: Record<string, string>;
  } = {},
): IncomingRequest => {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const stamp = overrides.stamp ?? String(Math.floor(NOW / 1000));
  return {
    rawBody,
    headers: {
      "x-grafana-alerting-signature":
        overrides.signature ?? sign(rawBody, stamp),
      "x-grafana-alerting-timestamp": stamp,
      authorization: basic(overrides.password ?? SECRET),
      ...overrides.headers,
    },
  };
};

const firing = (fingerprint: string, extra: Record<string, unknown> = {}) => ({
  receiver: "bugboss",
  status: "firing",
  groupKey: "{}/{alertname=\"x\"}",
  externalURL: "https://goodparty.grafana.net",
  groupLabels: { alertname: "campaigns-route-errors" },
  commonLabels: { environment: "prod" },
  commonAnnotations: {},
  truncatedAlerts: 0,
  alerts: [
    {
      status: "firing",
      fingerprint,
      labels: { alert_slug: "campaigns-route-errors", environment: "prod" },
      annotations: { summary: "[PROD] Route errors detected" },
      startsAt: "2026-09-24T12:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "https://goodparty.grafana.net/alerting/grafana/abc/view",
      ...extra,
    },
  ],
});

const adapter = (overrides = {}) =>
  createGrafanaAdapter({ secret: SECRET, now, loki: async () => [], ...overrides });

// --- verification: this is the part that must fail closed -----------------

test("rejects every delivery when no secret is configured", async () => {
  const a = createGrafanaAdapter({ now, loki: async () => [] });
  await assert.rejects(
    a.parse(request(firing("fp-1"))),
    /no webhook secret is configured/,
    "an absent secret must reject, never wave a delivery through",
  );
});

test("accepts a correctly signed delivery", async () => {
  const signals = await adapter().parse(request(firing("fp-1")));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].sourceId, "fp-1");
});

test("rejects a signature computed with the wrong secret", async () => {
  const body = JSON.stringify(firing("fp-1"));
  const stamp = String(Math.floor(NOW / 1000));
  await assert.rejects(
    adapter().parse(
      request(body, { stamp, signature: sign(body, stamp, "not-the-secret") }),
    ),
    /signature mismatch/,
  );
});

test("rejects a tampered body under a valid signature", async () => {
  const original = JSON.stringify(firing("fp-1"));
  const stamp = String(Math.floor(NOW / 1000));
  const signature = sign(original, stamp);
  const tampered = JSON.stringify(firing("fp-EVIL"));
  await assert.rejects(
    adapter().parse(request(tampered, { stamp, signature })),
    /signature mismatch/,
  );
});

test("rejects a signature that omits the timestamp from the digest", async () => {
  // Grafana signs `timestamp:body` whenever a timestamp header is configured.
  // A body-only digest is either an older sender or a replay attempt.
  const body = JSON.stringify(firing("fp-1"));
  const stamp = String(Math.floor(NOW / 1000));
  const bodyOnly = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  await assert.rejects(
    adapter().parse(request(body, { stamp, signature: bodyOnly })),
    /signature mismatch/,
  );
});

test("rejects a signature of a different length without throwing", async () => {
  // timingSafeEqual throws on unequal buffers, so the length guard has to run
  // first or a short signature is a 500 rather than a 401.
  await assert.rejects(
    adapter().parse(request(firing("fp-1"), { signature: "deadbeef" })),
    /signature mismatch/,
  );
});

test("rejects a missing signature header", async () => {
  const req = request(firing("fp-1"));
  delete req.headers["x-grafana-alerting-signature"];
  await assert.rejects(adapter().parse(req), /missing signature header/);
});

test("rejects a missing timestamp header", async () => {
  const req = request(firing("fp-1"));
  delete req.headers["x-grafana-alerting-timestamp"];
  await assert.rejects(adapter().parse(req), /missing timestamp header/);
});

test("rejects a non-numeric timestamp", async () => {
  const body = JSON.stringify(firing("fp-1"));
  await assert.rejects(
    adapter().parse(
      request(body, { stamp: "yesterday", signature: sign(body, "yesterday") }),
    ),
    /timestamp header is not a number/,
  );
});

test("rejects a replayed delivery outside the window", async () => {
  const stamp = String(Math.floor(NOW / 1000) - 3600);
  const body = JSON.stringify(firing("fp-1"));
  await assert.rejects(
    adapter().parse(request(body, { stamp, signature: sign(body, stamp) })),
    /outside the replay window/,
  );
});

test("rejects a timestamp far in the future", async () => {
  const stamp = String(Math.floor(NOW / 1000) + 3600);
  const body = JSON.stringify(firing("fp-1"));
  await assert.rejects(
    adapter().parse(request(body, { stamp, signature: sign(body, stamp) })),
    /outside the replay window/,
  );
});

test("accepts a delivery at the edge of the replay window", async () => {
  const stamp = String(Math.floor(NOW / 1000) - 300);
  const body = JSON.stringify(firing("fp-1"));
  const signals = await adapter().parse(
    request(body, { stamp, signature: sign(body, stamp) }),
  );
  assert.equal(signals.length, 1);
});

test("rejects a missing or wrong basic auth password", async () => {
  const req = request(firing("fp-1"));
  delete req.headers.authorization;
  await assert.rejects(adapter().parse(req), /missing basic auth/);

  await assert.rejects(
    adapter().parse(request(firing("fp-1"), { password: "wrong" })),
    /basic auth mismatch/,
  );
});

test("basic auth ignores the user and checks only the password", async () => {
  const body = JSON.stringify(firing("fp-1"));
  const stamp = String(Math.floor(NOW / 1000));
  const signals = await adapter().parse({
    rawBody: body,
    headers: {
      "x-grafana-alerting-signature": sign(body, stamp),
      "x-grafana-alerting-timestamp": stamp,
      authorization: `Basic ${Buffer.from(`anyone:${SECRET}`).toString("base64")}`,
    },
  });
  assert.equal(signals.length, 1);
});

test("basic auth can use a secret distinct from the HMAC one", async () => {
  const a = createGrafanaAdapter({
    secret: SECRET,
    basicAuthPassword: "a-different-password",
    now,
    loki: async () => [],
  });
  await assert.rejects(
    a.parse(request(firing("fp-1"))),
    /basic auth mismatch/,
  );
  const signals = await a.parse(
    request(firing("fp-1"), { password: "a-different-password" }),
  );
  assert.equal(signals.length, 1);
});

test("header names are matched case-insensitively", async () => {
  const body = JSON.stringify(firing("fp-1"));
  const stamp = String(Math.floor(NOW / 1000));
  const signals = await adapter().parse({
    rawBody: body,
    headers: {
      "X-Grafana-Alerting-Signature": sign(body, stamp),
      "X-Grafana-Alerting-Timestamp": stamp,
      Authorization: basic(SECRET),
    },
  });
  assert.equal(signals.length, 1);
});

test("a verifier override replaces the whole check", async () => {
  const a = createGrafanaAdapter({ verifier: () => {}, now, loki: async () => [] });
  const signals = await a.parse({ headers: {}, rawBody: JSON.stringify(firing("fp-1")) });
  assert.equal(signals.length, 1);
});

// --- parsing ---------------------------------------------------------------

test("carries labels, annotations and delivery metadata onto the signal", async () => {
  const [signal] = await adapter().parse(request(firing("fp-1")));

  assert.equal(signal.source, "grafana");
  assert.equal(signal.kind, "alert");
  assert.equal(signal.reportedBy, null);
  assert.equal(signal.title, "[PROD] Route errors detected");
  assert.equal(signal.openedAt, Date.parse("2026-09-24T12:00:00Z"));

  assert.equal(signal.labels.alert_slug, "campaigns-route-errors");
  assert.equal(signal.labels.environment, "prod");
  assert.equal(
    signal.labels[`${ANNOTATION_PREFIX}summary`],
    "[PROD] Route errors detected",
  );
  assert.equal(signal.labels[`${META_PREFIX}status`], "firing");
  assert.equal(signal.labels[`${META_PREFIX}receiver`], "bugboss");
  assert.match(signal.labels[`${META_PREFIX}generator_url`], /alerting/);
  assert.equal(signal.labels.resolution_policy, "auto");
  assert.match(signal.body, /Route errors detected/);
});

test("an alert's own labels win over the group's", async () => {
  const payload = firing("fp-1");
  payload.groupLabels = { environment: "dev", alertname: "grouped" } as never;
  const [signal] = await adapter().parse(request(payload));
  assert.equal(
    signal.labels.environment,
    "prod",
    "reading the group first would make grouped per-route alerts identical",
  );
});

test("a grouped delivery yields one signal per firing alert", async () => {
  const payload = firing("fp-1");
  payload.alerts.push({ ...payload.alerts[0], fingerprint: "fp-2" });
  const signals = await adapter().parse(request(payload));
  assert.deepEqual(
    signals.map((s: RawSignal) => s.sourceId),
    ["fp-1", "fp-2"],
  );
});

test("resolved entries inside a firing delivery are not signals", async () => {
  const payload = firing("fp-1");
  payload.alerts.push({
    ...payload.alerts[0],
    fingerprint: "fp-gone",
    status: "resolved",
  });
  const signals = await adapter().parse(request(payload));
  assert.deepEqual(signals.map((s: RawSignal) => s.sourceId), ["fp-1"]);
});

test("an alert with no fingerprint is dropped", async () => {
  const payload = firing("fp-1");
  delete (payload.alerts[0] as Record<string, unknown>).fingerprint;
  const signals = await adapter().parse(request(payload));
  assert.equal(signals.length, 0, "no fingerprint means no dedup key");
});

test("truncatedAlerts is surfaced rather than silently dropped", async () => {
  const payload = { ...firing("fp-1"), truncatedAlerts: 4 };
  const [signal] = await adapter().parse(request(payload));
  assert.equal(signal.labels[`${META_PREFIX}truncated_alerts`], "4");
  assert.match(signal.body, /truncated 4 further alert/);
});

test("an unreadable body throws rather than defaulting", async () => {
  const stamp = String(Math.floor(NOW / 1000));
  await assert.rejects(
    adapter().parse(request("not json", { stamp, signature: sign("not json", stamp) })),
    /body was not JSON/,
  );
});

test("dedup keys on (grafana, fingerprint)", async () => {
  const [signal] = await adapter().parse(request(firing("fp-1")));
  assert.equal(adapter().dedupKey(signal), "grafana:fp-1");
});

// --- resolution ------------------------------------------------------------

test("isResolved keys off Grafana's resolved notification", async () => {
  const a = adapter();
  const [raw] = await a.parse(request(firing("fp-1")));
  const signal = { ...raw, id: "sig-1", incidentId: null, explained: false, closedAt: null } as Signal;

  assert.equal(await a.isResolved(signal), false);

  const resolved = { ...firing("fp-1"), status: "resolved" };
  await a.parse(request(resolved));
  assert.equal(await a.isResolved(signal), true);

  // Firing again reopens ground the resolution claimed, so the stale
  // resolution must not outlive it.
  await a.parse(request(firing("fp-1")));
  assert.equal(await a.isResolved(signal), false);
});

// --- evidence --------------------------------------------------------------

const cause = (id: string, evidence?: string): Partial<KnownCause> => ({
  id,
  summary: `${id} summary`,
  confirmedBy: `${id} confirmation`,
  action: "suppress",
  ...(evidence ? { evidence } : {}),
});

const withCauses = (causes: unknown[]) =>
  firing("fp-1", {
    annotations: {
      summary: "[PROD] Route errors detected",
      [KNOWN_CAUSES_ANNOTATION]: JSON.stringify(causes),
    },
  });

test("parseKnownCauses drops entries that could never match", () => {
  const causes = parseKnownCauses(
    JSON.stringify([
      cause("good", '{app="x"} |= "boom"'),
      { summary: "no id", confirmedBy: "x", action: "suppress" },
      { id: "no-confirmation", summary: "s", action: "suppress" },
      { id: "bad-action", summary: "s", confirmedBy: "c", action: "escalate" },
      "not an object",
    ]),
  );
  assert.deepEqual(causes.map((c) => c.id), ["good"]);
  assert.equal(causes[0].evidence, '{app="x"} |= "boom"');
});

test("parseKnownCauses treats a malformed annotation as no causes", () => {
  assert.deepEqual(parseKnownCauses("{not json"), []);
  assert.deepEqual(parseKnownCauses(JSON.stringify({ not: "a list" })), []);
  assert.deepEqual(parseKnownCauses(undefined), []);
});

test("runs each known cause's LogQL query and returns the lines", async () => {
  const seen: string[] = [];
  const loki: LokiQuery = async (logql, options) => {
    seen.push(logql);
    assert.equal(options.limit, MAX_LINES);
    assert.equal(options.end, NOW);
    assert.equal(options.start, NOW - 3_600_000);
    return ["line one", "line two"];
  };
  const a = createGrafanaAdapter({ secret: SECRET, now, loki });
  const [signal] = await a.parse(
    request(withCauses([cause("timeout", '{app="gp-api"} |= "57014"')])),
  );

  const evidence = await a.prefetchEvidence(signal);
  assert.deepEqual(seen, ['{app="gp-api"} |= "57014"']);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].query, '{app="gp-api"} |= "57014"');
  assert.match(evidence[0].summary, /known cause timeout \(suppress\)/);
  assert.match(evidence[0].summary, /timeout confirmation/);
  assert.match(evidence[0].summary, /line one/);
  assert.equal(evidence[0].artifactKey, null);
});

test("a cause with no evidence query runs nothing", async () => {
  const a = createGrafanaAdapter({
    secret: SECRET,
    now,
    loki: async () => {
      throw new Error("should not be called");
    },
  });
  const [signal] = await a.parse(request(withCauses([cause("label-only")])));
  assert.deepEqual(await a.prefetchEvidence(signal), []);
});

test("a failed query is reported, never collapsed into an empty result", async () => {
  const a = createGrafanaAdapter({
    secret: SECRET,
    now,
    loki: async () => {
      throw new Error("Loki returned HTTP 503");
    },
  });
  const [signal] = await a.parse(
    request(withCauses([cause("timeout", '{app="gp-api"}')])),
  );
  const [evidence] = await a.prefetchEvidence(signal);
  assert.match(evidence.summary, /EVIDENCE UNAVAILABLE/);
  assert.match(evidence.summary, /HTTP 503/);
  assert.match(evidence.summary, /neither confirmed nor ruled out/);
});

test("caps evidence queries and says which were skipped", async () => {
  let calls = 0;
  const a = createGrafanaAdapter({
    secret: SECRET,
    now,
    loki: async () => {
      calls++;
      return [];
    },
  });
  const causes = Array.from({ length: MAX_QUERIES_PER_ALERT + 2 }, (_, i) =>
    cause(`c${i}`, `{app="gp-api"} |= "${i}"`),
  );
  const [signal] = await a.parse(request(withCauses(causes)));
  const evidence = await a.prefetchEvidence(signal);

  assert.equal(calls, MAX_QUERIES_PER_ALERT, "the cap is on queries actually run");
  assert.equal(evidence.length, MAX_QUERIES_PER_ALERT + 2);
  const skipped = evidence.filter((e) => /NOT CHECKED/.test(e.summary));
  assert.equal(skipped.length, 2, "skipped causes stay visible, not dropped");
});

test("caps returned lines at MAX_LINES", async () => {
  const a = createGrafanaAdapter({
    secret: SECRET,
    now,
    loki: async () => Array.from({ length: 200 }, (_, i) => `line ${i}`),
  });
  const [signal] = await a.parse(
    request(withCauses([cause("noisy", '{app="gp-api"}')])),
  );
  const [evidence] = await a.prefetchEvidence(signal);
  assert.match(evidence.summary, /50 matching line\(s\)/);
  assert.equal(evidence.summary.split("\n").filter((l) => l.startsWith("line ")).length, MAX_LINES);
});

// --- the Loki response reader ---------------------------------------------

test("linesFrom truncates a line on a byte boundary", () => {
  const long = "x".repeat(MAX_LINE_BYTES + 500);
  const [line] = linesFrom({
    data: { resultType: "streams", result: [{ stream: {}, values: [["1", long]] }] },
  });
  assert.ok(line.endsWith("…[truncated]"));
  assert.ok(Buffer.from(line, "utf8").length < MAX_LINE_BYTES + 50);
});

test("linesFrom truncates multi-byte content without splitting a character", () => {
  const long = "é".repeat(MAX_LINE_BYTES);
  const [line] = linesFrom({
    data: { resultType: "streams", result: [{ stream: {}, values: [["1", long]] }] },
  });
  assert.ok(!line.includes("�"), "a split code point must be repaired, not passed on");
});

test("linesFrom reads no lines out of a metric result", () => {
  assert.deepEqual(
    linesFrom({ data: { resultType: "matrix", result: [{ metric: {}, values: [["1", "42"]] }] } }),
    [],
    'a metric sample "42" must not reach triage looking like a log line',
  );
  assert.deepEqual(
    linesFrom({ data: { resultType: "streams", result: [{ metric: {}, values: [["1", "42"]] }] } }),
    [],
  );
});

test("linesFrom copes with a body it does not recognise", () => {
  assert.deepEqual(linesFrom(null), []);
  assert.deepEqual(linesFrom({}), []);
  assert.deepEqual(linesFrom({ data: { result: "nope" } }), []);
});
