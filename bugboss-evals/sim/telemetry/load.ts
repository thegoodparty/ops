import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  LogLine,
  Sample,
  TelemetryBatch,
  TelemetryGenerator,
} from "./types";

export class GeneratorLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorLoadError";
  }
}

export const loadGenerator = async (
  scenarioDir: string,
  generatorFile: string,
): Promise<TelemetryGenerator> => {
  const path = isAbsolute(generatorFile)
    ? generatorFile
    : join(scenarioDir, generatorFile);
  const mod = (await import(pathToFileURL(path).href)) as {
    default?: Partial<TelemetryGenerator> & {
      default?: Partial<TelemetryGenerator>;
    };
  };
  // tsx under CommonJS wraps an ESM default export one level deeper.
  const candidate =
    mod.default && typeof mod.default.backfill === "function"
      ? mod.default
      : mod.default?.default;
  if (
    !candidate ||
    typeof candidate.backfill !== "function" ||
    typeof candidate.live !== "function"
  ) {
    throw new GeneratorLoadError(
      `${path} must default-export a TelemetryGenerator with backfill() and live()`,
    );
  }
  return candidate as TelemetryGenerator;
};

// Well under Loki's 4 MiB gRPC message limit: the push body is JSON, and the
// distributor forwards it to the ingester as protobuf of a different size.
const MAX_LOKI_BODY_BYTES = 1024 * 1024;

const labelKey = (labels: Record<string, string>): string =>
  JSON.stringify(
    Object.keys(labels)
      .sort()
      .map((name) => [name, labels[name]]),
  );

const nanos = (ms: number): string =>
  `${BigInt(Math.round(ms * 1_000_000))}`;

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

export const lokiBatches = (logs: LogLine[]): LokiStream[][] => {
  const sorted = [...logs].sort((a, b) => a.ts - b.ts);
  const batches: LokiStream[][] = [];
  let current = new Map<string, LokiStream>();
  let size = 0;
  const flush = () => {
    if (current.size > 0) batches.push([...current.values()]);
    current = new Map();
    size = 0;
  };
  for (const log of sorted) {
    const entry: [string, string] = [nanos(log.ts), log.line];
    const entrySize = Buffer.byteLength(log.line) + 40;
    const key = labelKey(log.labels);
    const headerSize = current.has(key) ? 0 : Buffer.byteLength(key) + 32;
    if (size > 0 && size + entrySize + headerSize > MAX_LOKI_BODY_BYTES) {
      flush();
    }
    let stream = current.get(key);
    if (!stream) {
      stream = { stream: { ...log.labels }, values: [] };
      current.set(key, stream);
      size += Buffer.byteLength(key) + 32;
    }
    stream.values.push(entry);
    size += entrySize;
  }
  flush();
  return batches;
};

export const pushLoki = async (
  baseUrl: string,
  logs: LogLine[],
  tenant: string,
): Promise<void> => {
  for (const streams of lokiBatches(logs)) {
    const response = await fetch(`${baseUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-scope-orgid": tenant },
      body: JSON.stringify({ streams }),
    });
    if (!response.ok) {
      throw new Error(
        `loki push failed: ${response.status} ${await response.text()}`,
      );
    }
  }
};

const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
};

const tag = (field: number, wire: number): number[] => varint(field * 8 + wire);

const lengthDelimited = (field: number, bytes: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([...tag(field, 2), ...varint(bytes.length)]),
    bytes,
  ]);

const encodeLabel = (name: string, value: string): Buffer =>
  Buffer.concat([
    lengthDelimited(1, Buffer.from(name, "utf8")),
    lengthDelimited(2, Buffer.from(value, "utf8")),
  ]);

const encodeSample = (value: number, ts: number): Buffer => {
  const double = Buffer.alloc(8);
  double.writeDoubleLE(value);
  return Buffer.concat([
    Buffer.from(tag(1, 1)),
    double,
    Buffer.from([...tag(2, 0), ...varint(Math.round(ts))]),
  ]);
};

interface Series {
  labels: [string, string][];
  samples: { ts: number; value: number }[];
}

const toSeries = (samples: Sample[]): Series[] => {
  const byKey = new Map<string, Series>();
  for (const sample of samples) {
    const all: Record<string, string> = {
      ...sample.labels,
      __name__: sample.metric,
    };
    const labels = Object.keys(all)
      .sort()
      .map((name): [string, string] => [name, all[name]]);
    const key = JSON.stringify(labels);
    let series = byKey.get(key);
    if (!series) {
      series = { labels, samples: [] };
      byKey.set(key, series);
    }
    series.samples.push({ ts: sample.ts, value: sample.value });
  }
  for (const series of byKey.values()) {
    series.samples.sort((a, b) => a.ts - b.ts);
  }
  return [...byKey.values()];
};

export const encodeWriteRequest = (series: Series[]): Buffer =>
  Buffer.concat(
    series.map((one) =>
      lengthDelimited(
        1,
        Buffer.concat([
          ...one.labels.map(([name, value]) =>
            lengthDelimited(1, encodeLabel(name, value)),
          ),
          ...one.samples.map((s) => lengthDelimited(2, encodeSample(s.value, s.ts))),
        ]),
      ),
    ),
  );

const SNAPPY_CHUNK = 65536;

export const snappyLiteral = (input: Buffer): Buffer => {
  const parts: Buffer[] = [Buffer.from(varint(input.length))];
  for (let offset = 0; offset < input.length; offset += SNAPPY_CHUNK) {
    const chunk = input.subarray(offset, offset + SNAPPY_CHUNK);
    const n = chunk.length - 1;
    if (n < 60) {
      parts.push(Buffer.from([n << 2]));
    } else if (n < 0x100) {
      parts.push(Buffer.from([60 << 2, n]));
    } else if (n < 0x10000) {
      parts.push(Buffer.from([61 << 2, n & 0xff, n >> 8]));
    } else {
      parts.push(Buffer.from([62 << 2, n & 0xff, (n >> 8) & 0xff, n >> 16]));
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
};

const SAMPLES_PER_WRITE = 20_000;

export const pushPrometheus = async (
  baseUrl: string,
  samples: Sample[],
  tenant: string,
): Promise<void> => {
  const series = toSeries(samples.map((s) => ({ ...s, labels: { ...s.labels, [RUN_LABEL]: tenant } })));
  let batch: Series[] = [];
  let count = 0;
  const send = async () => {
    if (batch.length === 0) return;
    const response = await fetch(`${baseUrl}/api/v1/write`, {
      method: "POST",
      headers: {
        "content-encoding": "snappy",
        "content-type": "application/x-protobuf",
        "x-prometheus-remote-write-version": "0.1.0",
      },
      body: new Uint8Array(snappyLiteral(encodeWriteRequest(batch))),
    });
    if (!response.ok) {
      throw new Error(
        `prometheus remote write failed: ${response.status} ${await response.text()}`,
      );
    }
    batch = [];
    count = 0;
  };
  for (const one of series) {
    for (let i = 0; i < one.samples.length; i += SAMPLES_PER_WRITE) {
      const slice = one.samples.slice(i, i + SAMPLES_PER_WRITE);
      if (count > 0 && count + slice.length > SAMPLES_PER_WRITE) await send();
      batch.push({ labels: one.labels, samples: slice });
      count += slice.length;
    }
  }
  await send();
};

export interface PushCounts {
  logs: number;
  samples: number;
}

/**
 * One stack serves every run. Loki keeps each run's logs apart as a tenant;
 * Prometheus has no tenants, so each run's samples carry this label and
 * prom-label-proxy enforces it on every query from that run's Grafana org.
 */
export const RUN_LABEL = "eval_run";

export const pushBatch = async (
  urls: { lokiUrl: string; prometheusUrl: string; tenant: string },
  batch: TelemetryBatch,
): Promise<PushCounts> => {
  await pushLoki(urls.lokiUrl, batch.logs, urls.tenant);
  await pushPrometheus(urls.prometheusUrl, batch.samples, urls.tenant);
  return { logs: batch.logs.length, samples: batch.samples.length };
};
