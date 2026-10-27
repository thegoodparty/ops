import { z } from "zod";

// The agent's whole deliverable. A finding is a blocker by definition; the
// verdict is derived (zero findings = approve), never emitted by the model.
export const FindingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  body: z.string().min(1),
  suggestion: z.string().optional(),
  category: z.enum([
    "bugs",
    "security",
    "tests",
    "conventions",
    "ai-rules",
    "cross-file",
    "thematic",
  ]),
  confidence: z.enum(["high", "medium"]),
});
export type Finding = z.infer<typeof FindingSchema>;

// The one model judgement in a plan-gated review: is the diff consistent with
// the plan the PR names? Everything else about the gate is deterministic, and
// the verdict does not read this yet — step 1 of `docs/plan-gated-merges.md`
// adds the field and the eval cases that score it, step 4 wires it into the
// verdict. Optional so a run with no plan (every production run today) and
// every record written before this landed still parse and still replay.
export const PlanConsistencySchema = z.object({
  verdict: z.enum(["consistent", "inconsistent", "unclear"]),
  reasoning: z.string().min(1),
});
export type PlanConsistency = z.infer<typeof PlanConsistencySchema>;

export const ReviewOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    findings: z.array(FindingSchema),
    summary: z.string().min(1),
    planConsistency: PlanConsistencySchema.optional(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
  }),
]);
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// A prior finding as the agent sees it on re-review: where it was posted and
// what it said. Deliberately carries no id — the agent re-emits every finding
// it still sees, and the harness reconciles them to prior findings by
// path/category/line. Identity is not the model's job.
export const PriorFindingSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  body: z.string(),
  category: FindingSchema.shape.category,
  headSha: z.string(),
});
export type PriorFinding = z.infer<typeof PriorFindingSchema>;

// The plan a gated PR is judged against: the path the PR binds, the blob sha
// it was read at, and its text. Optional because no production run populates
// it yet — step 4 fetches it at the base ref and the prompt only asks the
// consistency question when it is here.
export const PlanSchema = z.object({
  path: z.string().min(1),
  blobSha: z.string().min(1),
  text: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

// Everything the agent is allowed to know. Built deterministically before
// the agent runs; the agent has no network and no GitHub token, so if it is
// not here the agent cannot see it. The bundle is persisted on the record so
// a run can be replayed as an eval case without touching GitHub again.
export const BundleSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int(),
  baseRef: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  author: z.string(),
  title: z.string(),
  body: z.string(),
  diff: z.string(),
  changedFiles: z.array(z.string()),
  priorFindings: z.array(PriorFindingSchema),
  plan: PlanSchema.optional(),
});
export type Bundle = z.infer<typeof BundleSchema>;

// The gate's decision, recorded so a run is auditable after the fact and so a
// `shadow` run is distinguishable from an `enforce` one. Every field is
// optional or defaulted: a record written before the gate existed still parses
// and still replays. `flags` is a list of stable names (`GatingFlag` in
// `gating.ts`), not prose, because step 5 counts them.
export const GatingSchema = z.object({
  mode: z.enum(["off", "shadow", "enforce"]),
  binding: z
    .object({
      path: z.string().optional(),
      step: z.number().int().optional(),
    })
    .default({}),
  baseRef: z.string(),
  // Present only when the plan was read at `main` and is usable.
  plan: z
    .object({
      path: z.string().min(1),
      blobSha: z.string().min(1),
    })
    .optional(),
  authority: z
    .object({
      checked: z.boolean(),
      ownedPaths: z.array(z.string()),
      reason: z.string(),
    })
    .default({ checked: false, ownedPaths: [], reason: "" }),
  flags: z.array(z.string()).default([]),
});
export type Gating = z.infer<typeof GatingSchema>;

export const PostedFindingSchema = FindingSchema.extend({
  id: z.string().uuid(),
  commentId: z.number().int().optional(),
  threadId: z.string().optional(),
  anchorAdjusted: z.boolean().default(false),
  demoted: z.boolean().optional(),
});
export type PostedFinding = z.infer<typeof PostedFindingSchema>;

export const ReviewRecordSchema = z.object({
  runId: z.string().uuid(),
  repo: z.string(),
  prNumber: z.number().int(),
  baseSha: z.string(),
  headSha: z.string(),
  trigger: z.enum(["webhook", "re-review", "eval"]),
  agentVersion: z.string(),
  model: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  wallTimeMs: z.number(),
  costUsd: z.number().nullable(),
  bundle: BundleSchema,
  output: ReviewOutputSchema.nullable(),
  verdict: z.enum(["approve", "comment", "failed"]),
  action: z.enum(["approved", "commented", "failed", "skipped"]),
  gates: z.array(z.string()),
  // Absent when the gate did not run: `DELEGATE_GATING_MODE=off` (the default)
  // or a repo that has not adopted gating. Presence is what tells a reader the
  // verdict was gated at all.
  gating: GatingSchema.optional(),
  findings: z.array(PostedFindingSchema),
  droppedFindings: z.array(FindingSchema).default([]),
  reviewId: z.number().int().optional(),
  tipMovedTo: z.string().optional(),
  error: z.string().optional(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const recordKey = (repo: string, prNumber: number, headSha: string, runId: string) =>
  `reviews/${repo}/${prNumber}/${headSha}/${runId}.json`;

export const lockKey = (repo: string, prNumber: number, headSha: string, name = "lock") =>
  `reviews/${repo}/${prNumber}/${headSha}/${name}`;

export const isLockKey = (key: string) => /\/lock(-after-\d+)?$/.test(key);
