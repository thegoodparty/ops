import type {
  LogLine,
  Sample,
  TelemetryBatch,
  TelemetryGenerator,
} from "../../sim/telemetry/types";

// Synthetic telemetry for the merge-behind scenario: false pages from rules
// that could not evaluate. Nothing here is exported from production. The
// shapes follow incident 87: gp-api healthy throughout, memory near 17%, and
// Grafana's query path degrading in bursts, during which most rule
// evaluations fail and every rule provisioned with execErrState Alerting
// fires with values of -1.
//
// In production one degradation lasted 84 minutes. Here the fault state
// degrades once an hour for 12 to 25 minutes, so the pages keep coming for
// the whole run. Healthy is the same world without the bursts.
//
// Every event is drawn from a PRNG seeded by (seed, kind, slot), never by the
// window asked for, so backfill and any split of live windows agree.

const GP_API = { service_name: "gp-api", deployment_environment_name: "prod" };
const STATE_HISTORY = { service_name: "grafana", deployment_environment_name: "prod", from: "state-history" };

const INSTANCES = ["ip-10-20-1-11.sim.internal", "ip-10-20-2-37.sim.internal"];

const ROUTES = [
  { endpoint: "GET /v1/users/me", url: "/v1/users/me", ms: 25 },
  { endpoint: "GET /v1/campaigns/mine", url: "/v1/campaigns/mine", ms: 60 },
  { endpoint: "GET /v1/health", url: "/v1/health", ms: 4 },
  { endpoint: "GET /v1/outreach", url: "/v1/outreach", ms: 90 },
];

// The three rules that paged together, by their provisioned titles.
const RULES = [
  { title: "High memory utilization", uid: "evalhighmemory01", slug: "high-memory" },
  { title: "Health check probe failures", uid: "evalhealthprobe01", slug: "health-check-probe-failure" },
  {
    title: "[People] Person id repoint blocked, left for manual resolution",
    uid: "evalrepoint01",
    slug: "people-person-id-repoint-collision",
  },
];

// About 216 rules on a one-minute interval.
const EVALUATIONS_PER_SECOND = 3.6;
const FAILED_SHARE_IN_BURST = 0.88;

const MINUTE = 60_000;
const HOUR = 3_600_000;

const mulberry32 = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const slotRng = (seed: number, kind: number, slot: number) =>
  mulberry32((seed * 2_654_435_761) ^ (kind * 40_503) ^ slot);

const hex = (rng: () => number, n: number) =>
  Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");

const requestId = (rng: () => number) =>
  `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-a${hex(rng, 3)}-${hex(rng, 12)}`;

const burstOf = (seed: number, hour: number) => {
  const rng = slotRng(seed, 3, hour);
  const start = hour * HOUR + Math.floor((5 + rng() * 35) * MINUTE);
  return { start, end: start + Math.floor((12 + rng() * 13) * MINUTE) };
};

const transition = (ts: number, rule: (typeof RULES)[number], previous: string, current: string): LogLine => ({
  ts,
  labels: STATE_HISTORY,
  line: JSON.stringify({
    schemaVersion: 1,
    previous,
    current,
    ...(current.includes("Error")
      ? { error: "[sse.dataQueryError] failed to execute query [A]: context deadline exceeded" }
      : {}),
    values: current.includes("Error") ? { A: -1, C: -1 } : {},
    condition: "C",
    ruleTitle: rule.title,
    ruleUID: rule.uid,
    labels: { alertname: rule.title, alert_slug: rule.slug, environment: "prod" },
  }),
});

const generate = (from: number, to: number, state: "fault" | "healthy", seed: number): TelemetryBatch => {
  const logs: LogLine[] = [];
  const samples: Sample[] = [];
  const inWindow = (ts: number) => ts >= from && ts < to;

  for (let s = Math.ceil(from / 5000); s * 5000 < to; s++) {
    const rng = slotRng(seed, 1, s);
    const route = ROUTES[Math.floor(rng() * ROUTES.length)];
    const ts = s * 5000 + Math.floor(rng() * 5000);
    logs.push({
      ts,
      labels: { ...GP_API, service_instance_id: INSTANCES[Math.floor(rng() * INSTANCES.length)] },
      line: JSON.stringify({
        level: 30,
        time: ts,
        msg: "Request completed",
        requestId: requestId(rng),
        request: { method: route.endpoint.split(" ")[0], url: route.url, endpoint: route.endpoint },
        response: { statusCode: 200, bytes: Math.floor(200 + rng() * 4_000) },
        responseTimeMs: Math.max(2, Math.round(route.ms * (0.4 + rng() * 1.4))),
      }),
    });
  }

  const bursts =
    state === "fault"
      ? Array.from({ length: Math.floor(to / HOUR) - Math.floor(from / HOUR) + 1 }, (_, i) => burstOf(seed, Math.floor(from / HOUR) + i))
      : [];
  const degraded = (ts: number) => bursts.some((b) => ts >= b.start && ts < b.end);

  for (const b of bursts) {
    for (const [i, rule] of RULES.entries()) {
      const fired = b.start + 30_000 + i * 20_000;
      const cleared = b.end + 30_000 + i * 20_000;
      if (inWindow(fired)) logs.push(transition(fired, rule, "Normal", "Alerting (Error)"));
      if (inWindow(cleared)) logs.push(transition(cleared, rule, "Alerting (Error)", "Normal"));
    }
  }

  for (let m = Math.ceil(from / MINUTE); m * MINUTE < to; m++) {
    const ts = m * MINUTE;
    const rng = slotRng(seed, 2, m);
    for (const instance of INSTANCES) {
      samples.push({
        ts,
        metric: "system_memory_utilization",
        labels: { ...GP_API, service_instance_id: instance, system_memory_state: "used" },
        value: 0.15 + rng() * 0.04,
      });
    }
    const evaluations = EVALUATIONS_PER_SECOND * (0.97 + rng() * 0.06);
    samples.push({
      ts,
      metric: "grafanacloud_grafana_instance_alerting_rule_evaluations_total:rate5m",
      labels: {},
      value: evaluations,
    });
    samples.push({
      ts,
      metric: "grafanacloud_grafana_instance_alerting_rule_evaluation_failures_total:rate5m",
      labels: {},
      value: degraded(ts) ? evaluations * FAILED_SHARE_IN_BURST * (0.95 + rng() * 0.1) : 0,
    });
  }

  logs.sort((a, b) => a.ts - b.ts);
  return { logs, samples };
};

const generator: TelemetryGenerator = {
  backfill: ({ alertAt, hoursBefore, seed }) => generate(alertAt - hoursBefore * HOUR, alertAt, "fault", seed),
  live: ({ from, to, state, seed }) => generate(from, to, state, seed),
};

export default generator;
