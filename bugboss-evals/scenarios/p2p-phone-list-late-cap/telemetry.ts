import type {
  LogLine,
  Sample,
  TelemetryBatch,
  TelemetryGenerator,
} from "../../sim/telemetry/types";

// Synthetic gp-api telemetry for the phone-list recipient cap that could only
// trip after the caller was gone. Nothing here is exported from production:
// the lines follow gp-api's pino "Request completed" shape and the latencies
// follow what incident 5 measured (~2.17s per 1,000-row voter page, the
// gateway severing at ~120s).
//
// Production saw about ten over-cap requests in 30 days. A live eval run lasts
// hours, so over-cap attempts are compressed to roughly two an hour: rare
// enough that most phone lists are fine, frequent enough that the fault stays
// visible for the whole run.
//
// Every event is drawn from a PRNG seeded by (seed, time slot), never by the
// window asked for, so backfill and any split of live windows agree on what
// happened at a given instant.

const STREAM = {
  service_name: "gp-api",
  deployment_environment_name: "prod",
};

const ENDPOINT = "POST /v1/p2p/phone-list";
const URL = "/v1/p2p/phone-list";

const CAP = 100_000;
const PAGE_ROWS = 1_000;
const PAGE_MS = 2_170;
const GATEWAY_MS = 120_000;

const ROUTES: { endpoint: string; url: string; weight: number; ms: number }[] = [
  { endpoint: "GET /v1/users/me", url: "/v1/users/me", weight: 30, ms: 25 },
  { endpoint: "GET /v1/campaigns/mine", url: "/v1/campaigns/mine", weight: 20, ms: 60 },
  { endpoint: "GET /v1/contacts", url: "/v1/contacts", weight: 12, ms: 900 },
  { endpoint: "GET /v1/contacts/stats", url: "/v1/contacts/stats", weight: 6, ms: 1_300 },
  { endpoint: "GET /v1/outreach", url: "/v1/outreach", weight: 5, ms: 90 },
  { endpoint: "POST /v1/outreach", url: "/v1/outreach", weight: 3, ms: 220 },
  { endpoint: "GET /v1/p2p/phone-lists", url: "/v1/p2p/phone-lists", weight: 2, ms: 140 },
];
const ROUTE_WEIGHT = ROUTES.reduce((sum, r) => sum + r.weight, 0);

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

const completed = (
  ts: number,
  rng: () => number,
  endpoint: string,
  url: string,
  statusCode: number | null,
  responseTimeMs: number,
  extra: Record<string, unknown> = {},
): LogLine => ({
  ts,
  labels: STREAM,
  line: JSON.stringify({
    level: statusCode !== null && statusCode >= 500 ? "error" : "info",
    time: ts,
    msg: "Request completed",
    requestId: requestId(rng),
    request: { method: endpoint.split(" ")[0], url, endpoint },
    response: {
      statusCode,
      bytes: statusCode === null ? null : Math.floor(200 + rng() * 4_000),
    },
    responseTimeMs,
    user: `user_sim${hex(rng, 10)}`,
    ...extra,
  }),
});

const refusal = (ts: number, rng: () => number, matched: number): LogLine => ({
  ts,
  labels: STREAM,
  line: JSON.stringify({
    level: "warn",
    time: ts,
    context: "ExceptionsFilter",
    msg: `Audience exceeds the ${CAP} recipient limit`,
    requestId: requestId(rng),
    exception_type: "BadRequestException",
    status: 400,
    matched,
  }),
});

const generate = (
  from: number,
  to: number,
  state: "fault" | "healthy",
  seed: number,
): TelemetryBatch => {
  const logs: LogLine[] = [];
  const inWindow = (ts: number) => ts >= from && ts < to;

  // About one request a second of background traffic.
  for (let s = Math.ceil(from / 1000); s * 1000 < to; s++) {
    const rng = slotRng(seed, 1, s);
    let pick = rng() * ROUTE_WEIGHT;
    const route = ROUTES.find((r) => (pick -= r.weight) < 0) ?? ROUTES[0];
    const ms = Math.max(3, Math.round(route.ms * (0.4 + rng() * 1.4)));
    const status = rng() < 0.004 ? 404 : rng() < 0.01 ? 401 : 200;
    logs.push(completed(s * 1000 + Math.floor(rng() * 1000), rng, route.endpoint, route.url, status, ms));
  }

  // Phone lists, one slot a minute. Most audiences are a few thousand voters
  // and answer in seconds either way. About one in thirty minutes someone
  // builds a list for a whole large district, which is the over-cap case.
  // A fault request's last line lands ~220s after it starts, so the scan
  // starts that far back.
  for (let m = Math.floor(from / 60_000) - 5; m * 60_000 < to; m++) {
    const rng = slotRng(seed, 2, m);
    const start = m * 60_000 + Math.floor(rng() * 60_000);

    if (rng() < 1 / 6) {
      const matched = 800 + Math.floor(rng() * 20_000);
      const ms = Math.round((Math.ceil(matched / PAGE_ROWS) * PAGE_MS + 1_500) * (0.9 + rng() * 0.2));
      const done = start + ms;
      if (inWindow(done)) logs.push(completed(done, rng, ENDPOINT, URL, 201, ms));
    }

    if (rng() < 1 / 30) {
      const matched = 120_000 + Math.floor(rng() * 180_000);
      if (state === "fault") {
        // The cap is checked on the recipient that crosses it, so the 400 is
        // only reachable after 100 pages. The gateway gives up first.
        const cut = start + GATEWAY_MS - Math.floor(rng() * 900);
        if (inWindow(cut)) logs.push(completed(cut, rng, ENDPOINT, URL, null, cut - start));
        const tripped = start + Math.round((CAP / PAGE_ROWS + 1) * PAGE_MS * (0.95 + rng() * 0.1));
        if (inWindow(tripped)) logs.push(refusal(tripped, rng, CAP + 1));
      } else {
        const ms = 1_800 + Math.floor(rng() * 1_500);
        const done = start + ms;
        if (inWindow(done)) {
          logs.push(refusal(done - 3, rng, matched));
          logs.push(completed(done, rng, ENDPOINT, URL, 400, ms));
        }
      }
    }
  }

  logs.sort((a, b) => a.ts - b.ts);

  // gp-api's recorded route-error series for this route, one sample a
  // minute, derived from the lines above so PromQL and LogQL agree. A null
  // status only counts past 30s, as the rule counts it.
  const counted = logs
    .filter((l) => {
      if (!l.line.includes(ENDPOINT)) return false;
      const parsed = JSON.parse(l.line) as { response?: { statusCode: number | null }; responseTimeMs?: number };
      return parsed.response?.statusCode === null && (parsed.responseTimeMs ?? 0) > 30_000;
    })
    .map((l) => l.ts);
  const samples: Sample[] = [];
  for (let m = Math.ceil(from / 60_000); m * 60_000 < to; m++) {
    const end = m * 60_000;
    const value = counted.filter((ts) => ts >= end - 60_000 && ts < end).length;
    samples.push({
      ts: end,
      metric: "gp_api:route_errors:count1m",
      labels: { request_endpoint: ENDPOINT },
      value,
    });
  }

  return { logs, samples };
};

const generator: TelemetryGenerator = {
  backfill: ({ alertAt, hoursBefore, seed }) =>
    generate(alertAt - hoursBefore * 3_600_000, alertAt, "fault", seed),
  live: ({ from, to, state, seed }) => generate(from, to, state, seed),
};

export default generator;
