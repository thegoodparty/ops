/**
 * The `IdentityGroupSync` metrics of "Observability" in
 * `docs/google-group-sync.md`.
 *
 * The Lambda's own role writes them (`PutMetricData`, conditioned on this
 * namespace in `group-sync-lambda.ts`), so the same code path works in a test
 * through a fake sink. `run.ts` emits a pair's whole metric set in one `put`
 * call, including the zeros -- an alarm on `Removed > 0` needs data to
 * evaluate, so a no-op run must not look like a missing one.
 *
 * The heartbeat is the absence of `Success`, which is why a pair that aborts
 * emits its counts and `Aborted` but never `Success`.
 */
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";

export const METRIC_NAMESPACE = "IdentityGroupSync";

/** The plan's metric names, in one place so a typo cannot invent a metric. */
export const METRIC_NAMES = {
  success: "Success",
  added: "Added",
  removed: "Removed",
  failed: "Failed",
  toCreate: "ToCreate",
  skipped: "Skipped",
  sourceMemberCount: "SourceMemberCount",
  targetMemberCount: "TargetMemberCount",
  aborted: "Aborted",
  removalCapTripped: "RemovalCapTripped",
  runDurationMs: "RunDurationMs",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

export type MetricValue = {
  name: MetricName;
  value: number;
  /** `Count` for counters, `Milliseconds` for the duration. */
  unit?: "Count" | "Milliseconds";
  /** Extra dimensions beyond the always-present `PairId`. */
  dimensions?: Record<string, string>;
};

/** The sink `run.ts` writes through. */
export interface Metrics {
  put(pairId: string, values: MetricValue[]): void;
  flush(): Promise<void>;
}

/**
 * The real sink: buffers a run's metrics and publishes them in as few
 * `PutMetricData` calls as the API allows.
 *
 * A publish failure is logged and swallowed rather than thrown. The run has
 * already happened by the time this is called, and turning a metrics outage
 * into an abort would tell the operator the sync failed when it did not; the
 * heartbeat's absence is the signal that something is wrong with the pipeline.
 */
export class CloudWatchMetrics implements Metrics {
  private readonly client: CloudWatchClient;
  private readonly buffer: MetricDatum[] = [];

  constructor(client?: CloudWatchClient) {
    this.client = client ?? new CloudWatchClient({});
  }

  put(pairId: string, values: MetricValue[]): void {
    for (const value of values) {
      this.buffer.push({
        MetricName: value.name,
        Value: value.value,
        Unit: value.unit ?? "Count",
        Dimensions: [
          { Name: "PairId", Value: pairId },
          ...Object.entries(value.dimensions ?? {}).map(([Name, Value]) => ({
            Name,
            Value,
          })),
        ],
      });
    }
  }

  async flush(): Promise<void> {
    // The API takes up to 1000 metric data per call; a run of a handful of
    // pairs is one call.
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, 1000);
      try {
        await this.client.send(
          new PutMetricDataCommand({
            Namespace: METRIC_NAMESPACE,
            MetricData: batch,
          }),
        );
      } catch (err) {
        console.log(
          JSON.stringify({
            level: "error",
            message: "PutMetricData failed; the run's counts are in the audit log",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
}

/** A sink that keeps what it was handed, for the tests. */
export const memoryMetrics = (): {
  metrics: Metrics;
  records: Array<{ pairId: string; values: MetricValue[] }>;
} => {
  const records: Array<{ pairId: string; values: MetricValue[] }> = [];
  return {
    records,
    metrics: {
      put(pairId, values) {
        records.push({ pairId, values });
      },
      async flush() {
        // Nothing to publish.
      },
    },
  };
};
