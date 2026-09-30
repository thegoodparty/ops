import { readFileSync } from "node:fs";
import { z } from "zod";

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
  })
  .strict();

export type ReplayCase = z.infer<typeof ReplayCaseSchema>;

export const loadCase = (path: string): ReplayCase =>
  ReplayCaseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
