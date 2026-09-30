import type {
  LogLine,
  Sample,
  TelemetryBatch,
  TelemetryGenerator,
} from "../../sim/telemetry/types";

// Synthetic gp-api telemetry for the eCanvasser sync timeout. Nothing here is
// exported from production: the shapes follow gp-api's pino "Request
// completed" line and the rates are scaled down from what incident 2 saw.
//
// Every event is drawn from a PRNG seeded by (seed, time slot), never by the
// window being asked for, so backfill and any split of live windows produce
// the same lines for the same instant. That is what lets two sides of a pair,
// and a restarted loader, see one world.
//
// The fault is chronic: a handful of campaigns carry a door-knocking backlog
// of hundreds to thousands of unattributed interactions, and each sync of one
// runs attribution inline, one ~800ms voter lookup at a time, until the
// gateway severs it at ~120s. The line then has no status code, which is what
// the route-errors rule counts. Healthy is the same traffic after any fix that
// bounds the request: those syncs answer 200 inside the window.

const STREAM = {
  service_name: "gp-api",
  deployment_environment_name: "prod",
};

const SYNC_ENDPOINT = "POST /v1/ecanvasser/:id/sync";

// Campaign ids and backlogs are invented. The large ones are the ones that
// time out; the rest sync in seconds and are what a healthy route looks like.
const CAMPAIGNS: { id: number; backlog: number }[] = [
  { id: 910_101, backlog: 1_780 },
  { id: 910_102, backlog: 940 },
  { id: 910_103, backlog: 610 },
  { id: 910_104, backlog: 2_450 },
  { id: 910_105, backlog: 320 },
  { id: 910_106, backlog: 1_120 },
  { id: 910_107, backlog: 0 },
  { id: 910_108, backlog: 12 },
  { id: 910_109, backlog: 0 },
  { id: 910_110, backlog: 40 },
  { id: 910_111, backlog: 3 },
  { id: 910_112, backlog: 0 },
];

const LOOKUP_MS = 800;
const GATEWAY_MS = 120_000;

// Background routes, so the stream is not only the fault. Weights are the
// share of requests; latencies are a typical median.
const ROUTES: { endpoint: string; url: string; weight: number; ms: number }[] = [
  { endpoint: "GET /v1/users/me", url: "/v1/users/me", weight: 30, ms: 25 },
  { endpoint: "GET /v1/campaigns/mine", url: "/v1/campaigns/mine", weight: 20, ms: 60 },
  { endpoint: "GET /v1/contacts", url: "/v1/contacts", weight: 12, ms: 900 },
  { endpoint: "GET /v1/ecanvasser/mine/summary", url: "/v1/ecanvasser/mine/summary", weight: 6, ms: 40 },
  { endpoint: "GET /v1/voters/door-knocking/packs", url: "/v1/voters/door-knocking/packs", weight: 4, ms: 1_400 },
  { endpoint: "POST /v1/outreach", url: "/v1/outreach", weight: 3, ms: 220 },
  { endpoint: "GET /v1/elections/races-by-year", url: "/v1/elections/races-by-year", weight: 5, ms: 180 },
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
): LogLine => ({
  ts,
  labels: STREAM,
  line: JSON.stringify({
    level: "info",
    time: ts,
    msg: "Request completed",
    requestId: requestId(rng),
    request: { method: endpoint.split(" ")[0], url, endpoint },
    response: { statusCode, bytes: statusCode === null ? null : Math.floor(200 + rng() * 4_000) },
    responseTimeMs,
    user: `user_sim${hex(rng, 10)}`,
  }),
});

const attribution = (
  ts: number,
  campaignId: number,
  matched: number,
  skipped: number,
  deferred: number | null,
): LogLine => ({
  ts,
  labels: STREAM,
  line: JSON.stringify({
    level: "info",
    time: ts,
    context: "EcanvasserAttributionService",
    msg: "Door-knock attribution complete",
    campaignId,
    matched,
    skipped,
    ...(deferred === null ? {} : { deferred }),
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

  // Syncs. The door-knocking page syncs with force: true on open, so a
  // campaign re-syncs whenever someone opens it, roughly every 20-40 minutes
  // in working hours. Slots are minutes; a sync's lines can land up to half an
  // hour after it starts, so the scan starts that far back.
  const minuteFrom = Math.floor(from / 60_000) - 30;
  for (let m = minuteFrom; m * 60_000 < to; m++) {
    for (const campaign of CAMPAIGNS) {
      const rng = slotRng(seed, 2 + campaign.id, m);
      if (rng() > 1 / 30) continue;
      const start = m * 60_000 + Math.floor(rng() * 60_000);
      const url = `/v1/ecanvasser/${campaign.id}/sync`;
      const fetchMs = 2_000 + Math.floor(rng() * 4_000);
      const lookups = Math.round(campaign.backlog * (0.7 + rng() * 0.2));
      const attributionMs = lookups * LOOKUP_MS * (0.85 + rng() * 0.3);

      if (state === "fault") {
        if (fetchMs + attributionMs >= GATEWAY_MS) {
          // Severed by the gateway. The handler keeps going after the caller
          // is gone, so attribution still logs, much later, having matched
          // nothing.
          const cut = start + GATEWAY_MS - Math.floor(rng() * 1_300);
          if (inWindow(cut)) logs.push(completed(cut, rng, SYNC_ENDPOINT, url, null, cut - start));
          const done = start + Math.round(fetchMs + attributionMs);
          if (inWindow(done)) logs.push(attribution(done, campaign.id, 0, lookups, null));
        } else {
          const done = start + Math.round(fetchMs + attributionMs);
          if (inWindow(done)) {
            logs.push(attribution(done - 5, campaign.id, 0, lookups, null));
            logs.push(completed(done, rng, SYNC_ENDPOINT, url, 201, done - start));
          }
        }
      } else {
        const bounded = Math.min(attributionMs, 45_000 + rng() * LOOKUP_MS);
        const done = start + Math.round(fetchMs + bounded);
        const reached = Math.min(lookups, Math.floor(bounded / LOOKUP_MS));
        if (inWindow(done)) {
          logs.push(attribution(done - 5, campaign.id, 0, reached, lookups - reached));
          logs.push(completed(done, rng, SYNC_ENDPOINT, url, 201, done - start));
        }
      }
    }
  }

  logs.sort((a, b) => a.ts - b.ts);

  // gp-api's recorded route-error metric, one sample a minute for the sync
  // route, derived from the lines above so PromQL and LogQL agree.
  const samples: Sample[] = [];
  for (let m = Math.ceil(from / 60_000); m * 60_000 < to; m++) {
    const end = m * 60_000;
    const count = logs.filter(
      (l) =>
        l.ts >= end - 60_000 &&
        l.ts < end &&
        l.line.includes('"statusCode":null') &&
        l.line.includes(SYNC_ENDPOINT),
    ).length;
    samples.push({
      ts: end,
      metric: "gp_api:route_errors:count1m",
      labels: { request_endpoint: SYNC_ENDPOINT },
      value: count,
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
