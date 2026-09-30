import { createServer, type IncomingMessage, type Server } from "node:http";

import { loadGenerator, pushBatch, type PushCounts } from "./load";
import type { TelemetryBatch, TelemetryGenerator } from "./types";

export type EmitterState = "fault" | "healthy";

export interface EmitterSnapshot {
  state: EmitterState;
  backfilled: PushCounts | null;
  emitted: PushCounts;
  switches: { at: number; state: EmitterState }[];
  lastEmitAt: number | null;
  errors: { at: number; error: string }[];
}

export interface Emitter {
  backfill(): Promise<PushCounts>;
  tick(): Promise<void>;
  setState(state: EmitterState): void;
  snapshot(): EmitterSnapshot;
  reset(): void;
}

export const createEmitter = (options: {
  generator: TelemetryGenerator;
  alertAt: number;
  hoursBefore: number;
  seed: number;
  push: (batch: TelemetryBatch) => Promise<PushCounts>;
  now?: () => number;
}): Emitter => {
  const now = options.now ?? Date.now;
  let state: EmitterState = "fault";
  let backfilled: PushCounts | null = null;
  let emitted: PushCounts = { logs: 0, samples: 0 };
  let switches: { at: number; state: EmitterState }[] = [];
  let errors: { at: number; error: string }[] = [];
  let lastEmitAt: number | null = null;
  // Live data starts where the backfill ends, so there is no gap and no overlap.
  let lastTo = options.alertAt;
  let ticking = false;

  return {
    backfill: async () => {
      const counts = await options.push(
        options.generator.backfill({
          alertAt: options.alertAt,
          hoursBefore: options.hoursBefore,
          seed: options.seed,
        }),
      );
      backfilled = counts;
      return counts;
    },
    tick: async () => {
      if (ticking) return;
      ticking = true;
      const to = now();
      try {
        if (to <= lastTo) return;
        const counts = await options.push(
          options.generator.live({
            from: lastTo,
            to,
            state,
            seed: options.seed,
          }),
        );
        // Advanced only on success, so a failed window is re-sent next tick.
        lastTo = to;
        lastEmitAt = to;
        emitted = {
          logs: emitted.logs + counts.logs,
          samples: emitted.samples + counts.samples,
        };
      } catch (error) {
        errors.push({
          at: to,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        ticking = false;
      }
    },
    setState: (next) => {
      if (next === state) return;
      state = next;
      switches.push({ at: now(), state: next });
    },
    snapshot: () => ({
      state,
      backfilled,
      emitted: { ...emitted },
      switches: [...switches],
      lastEmitAt,
      errors: [...errors],
    }),
    reset: () => {
      state = "fault";
      emitted = { logs: 0, samples: 0 };
      switches = [];
      errors = [];
    },
  };
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export const createControlServer = (
  emitter: Emitter,
  token?: string,
): Server =>
  createServer((req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "/").split("?")[0];
    if (!path.startsWith("/__control/")) return send(404, { error: "not found" });
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return send(401, { error: "unauthorized" });
    }
    if (req.method === "GET" && path === "/__control/health") {
      return send(200, { status: "ok" });
    }
    if (req.method === "GET" && path === "/__control/state") {
      return send(200, emitter.snapshot());
    }
    if (req.method === "POST" && path === "/__control/reset") {
      emitter.reset();
      return send(200, { ok: true });
    }
    if (req.method === "POST" && path === "/__control/state") {
      readBody(req).then(
        (raw) => {
          let parsed: { state?: string };
          try {
            parsed = JSON.parse(raw) as { state?: string };
          } catch {
            return send(400, { error: "body is not JSON" });
          }
          if (parsed.state !== "fault" && parsed.state !== "healthy") {
            return send(400, { error: "state must be fault or healthy" });
          }
          emitter.setState(parsed.state);
          send(200, emitter.snapshot());
        },
        (error: Error) => send(500, { error: error.message }),
      );
      return;
    }
    send(404, { error: "not found" });
  });

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const waitReady = async (url: string, deadlineMs: number): Promise<void> => {
  const until = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status} ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} not ready after ${deadlineMs}ms: ${last}`);
};

const main = async () => {
  const lokiUrl = required("LOKI_URL");
  const prometheusUrl = required("PROMETHEUS_URL");
  const generator = await loadGenerator(
    required("SCENARIO_DIR"),
    required("TELEMETRY_GENERATOR"),
  );
  const emitter = createEmitter({
    generator,
    alertAt: Number(required("ALERT_AT")),
    hoursBefore: Number(required("BACKFILL_HOURS")),
    seed: Number(process.env.SEED ?? 0),
    push: (batch) => pushBatch({ lokiUrl, prometheusUrl }, batch),
  });
  const server = createControlServer(emitter, process.env.CONTROL_TOKEN);
  server.listen(
    Number(process.env.CONTROL_PORT ?? 9005),
    process.env.CONTROL_HOST ?? "0.0.0.0",
  );
  await waitReady(`${lokiUrl}/ready`, 180_000);
  await waitReady(`${prometheusUrl}/-/ready`, 180_000);
  const counts = await emitter.backfill();
  console.log(JSON.stringify({ event: "telemetry_backfilled", ...counts }));
  const interval = Number(process.env.INTERVAL_SECONDS ?? 15) * 1000;
  setInterval(() => void emitter.tick(), interval);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => process.exit(0));
  }
};

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "telemetry_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  });
}
