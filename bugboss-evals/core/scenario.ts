import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const Seconds = z.number().int().nonnegative();

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    sourceIncident: z.number().int().positive(),
    omni: z
      .object({
        baseSha: z.string().regex(/^[0-9a-f]{7,40}$/),
        packages: z.array(z.string()).min(1),
        // A commit whose tree fixes the fault. Only the check's own tests use
        // it, to prove the check fails at baseSha and passes here. The agent
        // and the judge never see it.
        provingFixSha: z.string().regex(/^[0-9a-f]{7,40}$/),
      })
      .strict(),
    alert: z
      .object({ file: z.string(), refireEverySeconds: Seconds })
      .strict(),
    // Synthetic, generated from the scenario, never exported from prod. The
    // module default-exports a TelemetryGenerator (sim/telemetry/types.ts).
    telemetry: z
      .object({
        generator: z.string(),
        backfillHoursBefore: z.number().positive(),
      })
      .strict(),
    aws: z.object({ data: z.string() }).strict(),
    ci: z.object({ visible: z.array(z.string()).min(1) }).strict(),
    check: z
      .object({
        setup: z.string().nullable(),
        command: z.string(),
        timeoutSeconds: Seconds,
        runsAt: z.literal("deploy"),
      })
      .strict(),
    reviewer: z.object({ requestChangesOnce: z.boolean() }).strict(),
    persona: z
      .object({
        file: z.string(),
        model: z.string(),
        replyDelaySeconds: z.tuple([Seconds, Seconds]),
        mergeDelaySeconds: Seconds,
      })
      .strict(),
    chaos: z
      .object({ restartBugbossAfterSeconds: Seconds.nullable() })
      .strict(),
    caps: z
      .object({
        wallClockSeconds: Seconds,
        modelUsd: z.number().positive(),
        quietMinutes: z.number().positive(),
      })
      .strict(),
    reference: z.string(),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

export interface LoadedScenario {
  scenario: Scenario;
  dir: string;
}

export const loadScenario = (scenarioJsonPath: string): LoadedScenario => ({
  scenario: ScenarioSchema.parse(
    JSON.parse(readFileSync(scenarioJsonPath, "utf8")),
  ),
  dir: dirname(scenarioJsonPath),
});

export const scenarioPath = (root: string, id: string): string =>
  join(root, "scenarios", id, "scenario.json");
