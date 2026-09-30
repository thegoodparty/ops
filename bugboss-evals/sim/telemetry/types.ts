export interface LogLine {
  ts: number;
  labels: Record<string, string>;
  line: string;
}

export interface Sample {
  ts: number;
  metric: string;
  labels: Record<string, string>;
  value: number;
}

export interface TelemetryBatch {
  logs: LogLine[];
  samples: Sample[];
}

// Deterministic for a given seed, so two sides of a pair see the same world.
export interface TelemetryGenerator {
  backfill(args: {
    alertAt: number;
    hoursBefore: number;
    seed: number;
  }): TelemetryBatch;
  live(args: {
    from: number;
    to: number;
    state: "fault" | "healthy";
    seed: number;
  }): TelemetryBatch;
}
