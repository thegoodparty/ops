import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  GeneratorLoadError,
  backfill,
  loadGenerator,
  lokiBatches,
  pushLoki,
  pushPrometheus,
  snappyLiteral,
} from "./load";
import type { LogLine, Sample, TelemetryGenerator } from "./types";

const readVarint = (buf: Buffer, at: number): [number, number] => {
  let value = 0;
  let scale = 1;
  let pos = at;
  for (;;) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, pos];
    scale *= 0x80;
  }
};

const unsnappyLiteral = (buf: Buffer): Buffer => {
  const [length, start] = readVarint(buf, 0);
  const parts: Buffer[] = [];
  let pos = start;
  while (pos < buf.length) {
    const tagByte = buf[pos++];
    assert.equal(tagByte & 3, 0, "only literal elements are expected");
    let n = tagByte >> 2;
    if (n >= 60) {
      const bytes = n - 59;
      n = 0;
      for (let i = 0; i < bytes; i++) n += buf[pos + i] * 256 ** i;
      pos += bytes;
    }
    parts.push(buf.subarray(pos, pos + n + 1));
    pos += n + 1;
  }
  const out = Buffer.concat(parts);
  assert.equal(out.length, length);
  return out;
};

type Field = { field: number; wire: number; value: Buffer | number };

const fields = (buf: Buffer): Field[] => {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, next] = readVarint(buf, pos);
    pos = next;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [value, after] = readVarint(buf, pos);
      out.push({ field, wire, value });
      pos = after;
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.readDoubleLE(pos) });
      pos += 8;
    } else if (wire === 2) {
      const [length, after] = readVarint(buf, pos);
      out.push({ field, wire, value: buf.subarray(after, after + length) });
      pos = after + length;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return out;
};

const decodeWriteRequest = (buf: Buffer) =>
  fields(buf).map((ts) => {
    const parts = fields(ts.value as Buffer);
    return {
      labels: parts
        .filter((p) => p.field === 1)
        .map((p) => {
          const [name, value] = fields(p.value as Buffer);
          return [
            (name.value as Buffer).toString("utf8"),
            (value.value as Buffer).toString("utf8"),
          ];
        }),
      samples: parts
        .filter((p) => p.field === 2)
        .map((p) => {
          const [value, ts] = fields(p.value as Buffer);
          return { value: value.value as number, ts: ts.value as number };
        }),
    };
  });

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const fakeBackend = async (status = 204) => {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(status);
      res.end(status >= 400 ? "rejected: out of bounds" : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => server.close() };
};

describe("snappy literal encoding", () => {
  test("round-trips every literal length form", () => {
    for (const size of [0, 1, 59, 60, 61, 255, 256, 257, 65535, 65536, 200_000]) {
      const input = Buffer.alloc(size, 7);
      for (let i = 0; i < size; i++) input[i] = i % 251;
      assert.deepEqual(unsnappyLiteral(snappyLiteral(input)), input, `size ${size}`);
    }
  });
});

describe("pushPrometheus", () => {
  test("sends a remote write 1.0 request with sorted labels and time-ordered samples", async () => {
    const backend = await fakeBackend();
    const t0 = Date.UTC(2026, 8, 1);
    const samples: Sample[] = [
      { ts: t0 + 2000, metric: "up", labels: { job: "b", env: "x" }, value: 1 },
      { ts: t0, metric: "up", labels: { job: "b", env: "x" }, value: 0.5 },
      { ts: t0, metric: "errors_total", labels: { route: "/v1" }, value: 3 },
    ];
    await pushPrometheus(backend.url, samples);
    backend.close();

    assert.equal(backend.received.length, 1);
    const [req] = backend.received;
    assert.equal(req.path, "/api/v1/write");
    assert.equal(req.headers["content-encoding"], "snappy");
    assert.equal(req.headers["content-type"], "application/x-protobuf");
    assert.equal(req.headers["x-prometheus-remote-write-version"], "0.1.0");
    const series = decodeWriteRequest(unsnappyLiteral(req.body));
    assert.deepEqual(series, [
      {
        labels: [["__name__", "up"], ["env", "x"], ["job", "b"]],
        samples: [
          { value: 0.5, ts: t0 },
          { value: 1, ts: t0 + 2000 },
        ],
      },
      {
        labels: [["__name__", "errors_total"], ["route", "/v1"]],
        samples: [{ value: 3, ts: t0 }],
      },
    ]);
  });

  test("throws with the backend's body on a rejection", async () => {
    const backend = await fakeBackend(400);
    await assert.rejects(
      pushPrometheus(backend.url, [
        { ts: 1, metric: "m", labels: {}, value: 1 },
      ]),
      /400 rejected: out of bounds/,
    );
    backend.close();
  });
});

describe("pushLoki", () => {
  test("groups by label set with nanosecond timestamps in time order", async () => {
    const backend = await fakeBackend();
    const logs: LogLine[] = [
      { ts: 3000, labels: { service_name: "a" }, line: "third" },
      { ts: 1000, labels: { service_name: "a" }, line: "first" },
      { ts: 2000, labels: { service_name: "b" }, line: "other" },
    ];
    await pushLoki(backend.url, logs);
    backend.close();

    assert.equal(backend.received.length, 1);
    assert.equal(backend.received[0].path, "/loki/api/v1/push");
    const body = JSON.parse(backend.received[0].body.toString("utf8")) as {
      streams: { stream: Record<string, string>; values: [string, string][] }[];
    };
    assert.deepEqual(body.streams, [
      {
        stream: { service_name: "a" },
        values: [
          ["1000000000", "first"],
          ["3000000000", "third"],
        ],
      },
      { stream: { service_name: "b" }, values: [["2000000000", "other"]] },
    ]);
  });

  test("splits a large push so no request is over about 4 MB", () => {
    const line = "x".repeat(10_000);
    const logs: LogLine[] = Array.from({ length: 1000 }, (_, i) => ({
      ts: i,
      labels: { service_name: "a" },
      line,
    }));
    const batches = lokiBatches(logs);
    assert.ok(batches.length >= 3);
    for (const batch of batches) {
      assert.ok(JSON.stringify({ streams: batch }).length < 4.5 * 1024 * 1024);
    }
    assert.equal(
      batches.flatMap((b) => b.flatMap((s) => s.values)).length,
      1000,
      "nothing is dropped",
    );
  });

  test("throws with Loki's body on a rejection", async () => {
    const backend = await fakeBackend(400);
    await assert.rejects(
      pushLoki(backend.url, [{ ts: 1, labels: { a: "b" }, line: "l" }]),
      /loki push failed: 400 rejected/,
    );
    backend.close();
  });
});

describe("loadGenerator", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "telemetry-gen-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("loads a module that default-exports a generator", async () => {
    writeFileSync(
      join(dir, "good.ts"),
      `export default {
        backfill: () => ({ logs: [], samples: [] }),
        live: () => ({ logs: [], samples: [] }),
      };\n`,
    );
    const generator = await loadGenerator(dir, "good.ts");
    assert.deepEqual(generator.live({ from: 0, to: 1, state: "fault", seed: 1 }), {
      logs: [],
      samples: [],
    });
  });

  test("refuses a module without backfill and live", async () => {
    writeFileSync(join(dir, "bad.ts"), "export default { backfill: () => 1 };\n");
    await assert.rejects(loadGenerator(dir, "bad.ts"), GeneratorLoadError);
  });

  test("loads a real scenario generator from the evals-scenarios branch when it is fetched", async (t) => {
    const ref = "origin/evals-scenarios";
    const path = "bugboss-evals/scenarios/ecanvasser-sync-timeout/telemetry.ts";
    const shown = spawnSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
    });
    if (shown.status !== 0) {
      t.skip(`${ref} is not fetched here`);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "telemetry-real-"));
    try {
      const scenarioDir = join(root, "bugboss-evals/scenarios/ecanvasser-sync-timeout");
      mkdirSync(scenarioDir, { recursive: true });
      mkdirSync(join(root, "bugboss-evals/sim/telemetry"), { recursive: true });
      writeFileSync(join(scenarioDir, "telemetry.ts"), shown.stdout);
      writeFileSync(
        join(root, "bugboss-evals/sim/telemetry/types.ts"),
        execFileSync("cat", [resolve(__dirname, "types.ts")], { encoding: "utf8" }),
      );
      const generator = await loadGenerator(scenarioDir, "telemetry.ts");
      const alertAt = Date.UTC(2026, 8, 1, 12);
      const first = generator.backfill({ alertAt, hoursBefore: 1, seed: 1 });
      const second = generator.backfill({ alertAt, hoursBefore: 1, seed: 1 });
      assert.ok(first.logs.length + first.samples.length > 0);
      assert.deepEqual(first, second, "deterministic per seed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const docker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe("backfill into real Loki and Prometheus", { skip: docker ? false : "docker is not available" }, () => {
  const composeDir = resolve(__dirname, "../compose");
  const names = [`telemetry-test-loki-${process.pid}`, `telemetry-test-prom-${process.pid}`];
  let lokiUrl = "";
  let prometheusUrl = "";

  const hostPort = (name: string, port: number): string =>
    execFileSync("docker", ["port", name, `${port}/tcp`], { encoding: "utf8" })
      .split("\n")[0]
      .trim()
      .replace("0.0.0.0", "127.0.0.1");

  const waitFor = async (url: string) => {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      try {
        if ((await fetch(url)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${url} never became ready`);
  };

  before(async () => {
    execFileSync("docker", [
      "run", "-d", "--rm", "--name", names[0], "-p", "127.0.0.1::3100",
      "-v", `${composeDir}/loki.yaml:/etc/loki/local-config.yaml:ro`,
      "grafana/loki:3.4.2", "-config.file=/etc/loki/local-config.yaml",
    ]);
    execFileSync("docker", [
      "run", "-d", "--rm", "--name", names[1], "-p", "127.0.0.1::9090",
      "-v", `${composeDir}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`,
      "prom/prometheus:v3.2.1", "--config.file=/etc/prometheus/prometheus.yml",
      "--web.enable-remote-write-receiver",
    ]);
    lokiUrl = `http://${hostPort(names[0], 3100)}`;
    prometheusUrl = `http://${hostPort(names[1], 9090)}`;
    await waitFor(`${lokiUrl}/ready`);
    await waitFor(`${prometheusUrl}/-/ready`);
  }, { timeout: 300_000 });

  after(() => {
    spawnSync("docker", ["rm", "-f", ...names], { stdio: "ignore" });
  });

  test("accepts and serves samples from six hours ago", { timeout: 120_000 }, async () => {
    const alertAt = Date.now();
    const generator: TelemetryGenerator = {
      backfill: ({ alertAt: at, hoursBefore }) => {
        const start = at - hoursBefore * 3600_000;
        const logs: LogLine[] = [];
        const samples: Sample[] = [];
        for (let ts = start; ts < at; ts += 600_000) {
          logs.push({ ts, labels: { service_name: "gp-api" }, line: `request ${ts}` });
          samples.push({ ts, metric: "sim_errors_total", labels: { service: "gp-api" }, value: (ts - start) / 600_000 });
        }
        return { logs, samples };
      },
      live: () => ({ logs: [], samples: [] }),
    };
    const counts = await backfill({ generator, lokiUrl, prometheusUrl, alertAt, hoursBefore: 6, seed: 1 });
    assert.deepEqual(counts, { logs: 36, samples: 36 });

    const start = alertAt - 6 * 3600_000 - 60_000;
    const lokiQuery = new URLSearchParams({
      query: '{service_name="gp-api"}',
      start: `${start}000000`,
      end: `${alertAt}000000`,
      limit: "1000",
    });
    let lokiValues = 0;
    for (let i = 0; i < 20 && lokiValues < 36; i++) {
      const loki = (await (await fetch(`${lokiUrl}/loki/api/v1/query_range?${lokiQuery}`)).json()) as {
        data: { result: { values: [string, string][] }[] };
      };
      lokiValues = loki.data.result.reduce((n, r) => n + r.values.length, 0);
      if (lokiValues < 36) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(lokiValues, 36, "every backfilled line is queryable, the oldest six hours back");

    const promQuery = new URLSearchParams({
      query: "sim_errors_total",
      // Aligned to the samples: with a 600s step and the 5m lookback, a grid
      // offset from them would find nothing at every step.
      start: String((alertAt - 6 * 3600_000) / 1000),
      end: String(alertAt / 1000),
      step: "600",
    });
    let values: [number, string][] = [];
    let raw = "";
    for (let i = 0; i < 20 && values.length < 30; i++) {
      raw = await (await fetch(`${prometheusUrl}/api/v1/query_range?${promQuery}`)).text();
      const prom = JSON.parse(raw) as {
        data: { result: { values: [number, string][] }[] };
      };
      values = prom.data.result.flatMap((r) => r.values);
      if (values.length < 30) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(values.length >= 30, `got ${values.length} points: ${raw}`);
    assert.ok(
      values[0][0] * 1000 < alertAt - 5 * 3600_000,
      "the earliest point is from more than five hours before the alert",
    );
  });
});
