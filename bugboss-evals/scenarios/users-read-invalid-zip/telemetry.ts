import type {
  LogLine,
  TelemetryBatch,
  TelemetryGenerator,
} from "../../sim/telemetry/types";

// Synthetic gp-api logs for the users-read-invalid-zip scenario. Nothing here
// came from production: the line shapes follow gp-api's pino output (Request
// received, Request completed, the ZodResponseInterceptor error), and every
// id, name and instance is invented.
//
// The fault is GET /v1/users answering 500 when the page it builds holds a
// user whose stored zip fails the signup-form postal-code rule. In prod that
// was 16 failures in 30 days against about 2,350 successes: far too sparse
// for a three-hour run, where the agent would see nothing. So the rate is
// compressed. Admin list and search calls arrive about every three minutes,
// and one in five lands on a page with a bad row, which gives three to five
// 500s an hour. The ratio of failures to successes is higher than prod's; the
// shape (only some searches fail, the same search can fail repeatedly, every
// failure names a data.N.zip issue) is the same.
//
// Events are generated per minute from (seed, minute), so a live window cut
// at any boundary returns exactly the lines a longer window would, and the
// two sides of a pair see the same world.

const MINUTE = 60_000;

const INSTANCES = ["ip-10-20-1-11.sim.internal", "ip-10-20-2-37.sim.internal"];

const SEARCH_NAMES = [
  "Avery",
  "Blake",
  "Casey",
  "Devon",
  "Emery",
  "Finley",
  "Harper",
  "Jordan",
  "Morgan",
  "Quinn",
  "Reese",
  "Rowan",
];

// Background traffic, so a query for the route has to select it rather than
// read everything. Weighted by how often each appears per minute.
const OTHER_ROUTES: { endpoint: string; url: string; perMinute: number }[] = [
  { endpoint: "GET /v1/users/me", url: "/v1/users/me", perMinute: 6 },
  { endpoint: "GET /v1/campaigns/mine", url: "/v1/campaigns/mine", perMinute: 4 },
  { endpoint: "GET /v1/health", url: "/v1/health", perMinute: 4 },
  {
    endpoint: "GET /v1/elections/races-by-year",
    url: "/v1/elections/races-by-year?year=2026",
    perMinute: 1,
  },
];

const ADMIN_CALLS_PER_MINUTE = 1 / 3;
const FAULT_SHARE = 0.2;

const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const bucketRng = (seed: number, minute: number) =>
  mulberry32((Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(minute | 0, 0x85ebca6b)) >>> 0);

const hex = (rnd: () => number, n: number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(rnd() * 16).toString(16);
  return s;
};

const uuid = (rnd: () => number) =>
  `${hex(rnd, 8)}-${hex(rnd, 4)}-4${hex(rnd, 3)}-a${hex(rnd, 3)}-${hex(rnd, 12)}`;

// A Poisson count by inversion; rates here are small.
const poisson = (rnd: () => number, mean: number) => {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = rnd();
  while (p > limit) {
    k++;
    p *= rnd();
  }
  return k;
};

const labels = (instance: string) => ({
  service_name: "gp-api",
  deployment_environment_name: "prod",
  service_instance_id: instance,
});

const line = (ts: number, instance: string, body: Record<string, unknown>): LogLine => ({
  ts,
  labels: labels(instance),
  line: JSON.stringify(body),
});

const STACK_500 = [
  "InternalServerErrorException: Response validation failed",
  "    at /app/dist/src/shared/interceptors/ZodResponse.interceptor.js:34:27",
  "    at /app/node_modules/rxjs/dist/cjs/internal/operators/map.js:10:37",
  "    at OperatorSubscriber._this._next (/app/node_modules/rxjs/dist/cjs/internal/operators/OperatorSubscriber.js:33:21)",
].join("\n");

const request = (
  out: LogLine[],
  rnd: () => number,
  ts: number,
  endpoint: string,
  url: string,
  fail: { index: number } | null,
) => {
  const instance = INSTANCES[Math.floor(rnd() * INSTANCES.length)];
  const requestId = uuid(rnd);
  const req = { method: endpoint.split(" ")[0], endpoint, url };
  out.push(line(ts, instance, { level: 30, msg: "Request received", requestId, request: req }));
  // Every draw happens whatever the outcome, so turning a failure into a
  // success does not shift the rest of the minute's sequence.
  const took = Math.round(40 + rnd() * (fail ? 300 : 180));
  const bytes = Math.round(900 + rnd() * 9000);
  if (fail) {
    out.push(
      line(ts + took - 2, instance, {
        level: 50,
        msg: "Response validation failed:",
        requestId,
        request: req,
        context: "ZodResponseInterceptor",
        issues: [{ path: `data.${fail.index}.zip`, code: "custom", message: "Must be valid Zip code" }],
      }),
    );
    out.push(
      line(ts + took - 1, instance, {
        level: 50,
        msg: "Response validation failed",
        requestId,
        request: req,
        exception_type: "InternalServerErrorException",
        exception_message: "Response validation failed",
        exception_stacktrace: STACK_500,
        statusCode: 500,
      }),
    );
  }
  const status = fail ? 500 : 200;
  const completed: Record<string, unknown> = {
    level: fail ? 50 : 30,
    msg: "Request completed",
    requestId,
    request: req,
    response: { statusCode: status, bytes: fail ? 89 : bytes },
    responseTimeMs: took,
  };
  if (fail) {
    completed["exception.type"] = "Object";
    completed["exception.message"] = "failed with status code 500";
  }
  out.push(line(ts + took, instance, completed));
};

const minuteEvents = (seed: number, minute: number, state: "fault" | "healthy") => {
  const rnd = bucketRng(seed, minute);
  const out: LogLine[] = [];
  const start = minute * MINUTE;
  for (const route of OTHER_ROUTES) {
    const n = poisson(rnd, route.perMinute);
    for (let i = 0; i < n; i++) {
      request(out, rnd, start + Math.floor(rnd() * MINUTE), route.endpoint, route.url, null);
    }
  }
  const admin = poisson(rnd, ADMIN_CALLS_PER_MINUTE);
  for (let i = 0; i < admin; i++) {
    const ts = start + Math.floor(rnd() * MINUTE);
    const search = rnd() < 0.7;
    const name = SEARCH_NAMES[Math.floor(rnd() * SEARCH_NAMES.length)];
    const offset = rnd() < 0.8 ? 0 : 20;
    const url = search
      ? `/v1/users?limit=20&offset=${offset}&firstName=${name}`
      : `/v1/users?limit=20&offset=${offset}`;
    // Drawn in both states so the healthy world is the fault world with the
    // failures turned into successes, not a different sequence of requests.
    const hit = rnd() < FAULT_SHARE;
    const index = Math.floor(rnd() * 20);
    request(out, rnd, ts, "GET /v1/users", url, state === "fault" && hit ? { index } : null);
  }
  return out;
};

const generate = (from: number, to: number, state: "fault" | "healthy", seed: number): TelemetryBatch => {
  const logs: LogLine[] = [];
  for (let m = Math.floor(from / MINUTE); m * MINUTE < to; m++) {
    for (const l of minuteEvents(seed, m, state)) {
      if (l.ts >= from && l.ts < to) logs.push(l);
    }
  }
  logs.sort((a, b) => a.ts - b.ts);
  // The route alert is log-backed, and the incident's evidence is all in
  // Loki, so this scenario writes no metric series.
  return { logs, samples: [] };
};

const generator: TelemetryGenerator = {
  // The bug was latent for weeks before it paged, so the whole backfill is in
  // the fault state.
  backfill: ({ alertAt, hoursBefore, seed }) =>
    generate(alertAt - hoursBefore * 3_600_000, alertAt, "fault", seed),
  live: ({ from, to, state, seed }) => generate(from, to, state, seed),
};

export default generator;
