import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    sourceIncident: z.number().int().positive(),
    omni: z
      .object({
        baseSha: Sha,
        // A commit whose tree fixes the fault. Only the check's own proof and
        // the zero-spend stub use it; the agent and the judge never see it.
        provingFixSha: Sha,
      })
      .strict(),
    alert: z
      .object({ file: z.string(), refireEverySeconds: z.number().int().positive() })
      .strict(),
    // Synthetic, generated from the scenario, never exported from prod. The
    // module default-exports a TelemetryGenerator (sim/telemetry/types.ts).
    telemetry: z
      .object({ generator: z.string(), backfillHoursBefore: z.number().positive() })
      .strict(),
    // What the sandbox's visible CI runs on every pull request.
    ci: z.array(z.string()).min(1),
    // The hidden check, run once a merge "deploys". Never in visible CI.
    check: z
      .object({
        setup: z.string(),
        command: z.string(),
        timeoutSeconds: z.number().int().positive(),
      })
      .strict(),
    // The scripted on-call human. A bot question matching `when` gets `say`;
    // anything else gets "I don't know more, proceed."
    human: z
      .object({
        facts: z.array(z.object({ when: z.string(), say: z.string() }).strict()),
      })
      .strict(),
    wallClockSeconds: z.number().int().positive(),
    reference: z.string(),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

export interface LoadedScenario {
  scenario: Scenario;
  dir: string;
}

export const SCENARIOS_DIR = join(__dirname, "..", "scenarios");

export const loadScenario = (id: string, root = SCENARIOS_DIR): LoadedScenario => {
  const dir = join(root, id);
  return {
    scenario: ScenarioSchema.parse(JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"))),
    dir,
  };
};

export const SCENARIO_IDS = [
  "ecanvasser-sync-timeout",
  "users-read-invalid-zip",
  "p2p-phone-list-late-cap",
];

