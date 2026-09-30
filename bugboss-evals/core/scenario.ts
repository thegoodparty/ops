import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

// A behaviour the base gates cannot see, checked once the run ends
// (core/gates.ts). Patterns are case-insensitive regular expressions.
const ScenarioGateSchema = z.discriminatedUnion("kind", [
  // A bot post in the incident thread after the merge, within the bound.
  z.object({ id: z.string(), kind: z.literal("thread_after_merge"), pattern: z.string(), withinSeconds: z.number().int().positive() }).strict(),
  // The thread's top message stops matching, within the bound of the merge.
  z.object({ id: z.string(), kind: z.literal("header_clears_after_merge"), pattern: z.string(), withinSeconds: z.number().int().positive() }).strict(),
  // The incident reaches one of these statuses within the bound of the merge.
  z.object({ id: z.string(), kind: z.literal("status_after_merge"), statuses: z.array(z.string()).min(1), withinSeconds: z.number().int().positive() }).strict(),
  // The agent takes a model turn within the bound of the merge: it woke.
  z.object({ id: z.string(), kind: z.literal("turn_after_merge"), withinSeconds: z.number().int().positive() }).strict(),
  // One of these tool calls, its arguments matching, comes before the first edit or write.
  z.object({ id: z.string(), kind: z.literal("before_first_edit"), tools: z.array(z.string()).min(1), pattern: z.string() }).strict(),
  // The first sentence of the recorded root cause.
  z.object({ id: z.string(), kind: z.literal("root_cause"), pattern: z.string(), notPattern: z.string().optional() }).strict(),
  // A file the first pull request changes.
  z.object({ id: z.string(), kind: z.literal("first_pr_touches"), pattern: z.string() }).strict(),
  // Some call to one of these tools has arguments matching.
  z.object({ id: z.string(), kind: z.literal("agent_says"), tools: z.array(z.string()).min(1), pattern: z.string() }).strict(),
  // No bot post and no message_boss or escalate call matches.
  z.object({ id: z.string(), kind: z.literal("never_says"), pattern: z.string() }).strict(),
]);

export type ScenarioGate = z.infer<typeof ScenarioGateSchema>;

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
        // When the human merges an approved, green PR. `green`: at once.
        // `asked`: only once the thread shows the agent waiting on a merge,
        // then `delaySeconds` later, and the human says nothing about it.
        merge: z
          .object({ after: z.enum(["green", "asked"]), delaySeconds: z.number().int().nonnegative() })
          .strict()
          .default({ after: "green", delaySeconds: 0 }),
      })
      .strict(),
    wallClockSeconds: z.number().int().positive(),
    reference: z.string(),
    gates: z.array(ScenarioGateSchema).default([]),
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
  "missed-merge",
  "alert-vs-user-harm",
  "alert-vs-user-harm-paid-alert",
];

