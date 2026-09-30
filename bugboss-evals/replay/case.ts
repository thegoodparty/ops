import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { loadScenario } from "../core/scenario";

const Step = z
  .object({
    on: z.enum(["message", "question", "escalation", "any"]),
    approveAndMerge: z.boolean().optional(),
    reply: z.string().optional(),
  })
  .strict();

/**
 * One Tier 2 case: the after-PR phase of one real incident. The file holds
 * where the checkpoint lives and how the phase is driven, never the
 * checkpoint itself, which is production data read from S3 at runtime.
 */
export const ReplayCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    sourceIncident: z.number().int().positive(),
    phase: z.literal("post_pr"),
    checkpoint: z
      .object({
        session: z.string().regex(/^s3:\/\/[^/]+\/.+\.jsonl$/),
        /** Which PR's opening to cut at, 1-based. */
        prOrdinal: z.number().int().positive(),
      })
      .strict(),
    /** The on-call human, scripted. Steps are played in order against what the agent sends the Boss. */
    script: z.array(Step).min(1),
    /** CI verdicts for each new head SHA, in order; the last one repeats. */
    ci: z
      .object({
        verdicts: z
          .array(z.object({ conclusion: z.enum(["success", "failure"]), log: z.string().optional() }).strict())
          .min(1),
      })
      .strict(),
    stop: z.object({ turnCap: z.number().int().positive() }).strict(),
    caps: z
      .object({
        wallClockSeconds: z.number().int().positive(),
        modelUsd: z.number().positive(),
      })
      .strict(),
    /**
     * The Tier 1 scenario this incident became, when there is one. Its
     * synthetic telemetry then answers the post-merge queries; without one,
     * Grafana is absent and the agent's confirmation has nothing to read.
     */
    scenario: z.string().nullable(),
    /**
     * Required, and only allowed, when `scenario` is null: the incident has
     * no human-vetted reference, so the judge compares the sides against
     * each other and the report says so for this case.
     */
    noVettedReference: z.literal(true).optional(),
  })
  .strict()
  .refine((c) => (c.scenario === null) === (c.noVettedReference === true), {
    message: "a case names a scenario or sets noVettedReference: true, exactly one",
  });

export type ReplayCase = z.infer<typeof ReplayCaseSchema>;

export const SCENARIOS_DIR = join(__dirname, "..", "scenarios");

export type CaseReference =
  | { vetted: true; scenario: string; reference: string; alert: unknown }
  | { vetted: false };

/**
 * The scenario behind a case: its vetted reference and its alert. A case that
 * names a scenario which is missing, or which came from another incident, is
 * an error, never a quiet fall back to judging without a reference.
 */
export const referenceFor = (c: ReplayCase, scenariosDir = SCENARIOS_DIR): CaseReference => {
  if (c.scenario === null) return { vetted: false };
  const json = join(scenariosDir, c.scenario, "scenario.json");
  if (!existsSync(json)) throw new Error(`case ${c.id} names scenario ${c.scenario}, which has no ${json}`);
  const { scenario, dir } = loadScenario(json);
  if (scenario.sourceIncident !== c.sourceIncident) {
    throw new Error(
      `case ${c.id} is incident ${c.sourceIncident} but scenario ${c.scenario} is incident ${scenario.sourceIncident}`,
    );
  }
  return {
    vetted: true,
    scenario: scenario.id,
    reference: readFileSync(join(dir, scenario.reference), "utf8"),
    alert: JSON.parse(readFileSync(join(dir, scenario.alert.file), "utf8")) as unknown,
  };
};

export const loadCase = (path: string): ReplayCase =>
  ReplayCaseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
