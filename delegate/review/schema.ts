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

// An addition a `consistent` diff makes that the bound step does not name: a
// path or an AWS resource, plus why the step's own goal needs it. A step's
// enumeration is exemplary rather than exhaustive (case 5's vocabulary in
// `docs/plan-gated-merges.md`), and this is where the model has to name the
// pieces it added anyway, so a human can check the addition instead of taking
// it on trust. Only meaningful on a `consistent` answer; the verdict
// deliberately did not gain a fourth member, because `unclear` still has to
// mean "I cannot tell".
export const PlanAdditionSchema = z.object({
  item: z.string().min(1),
  why: z.string().min(1),
});
export type PlanAddition = z.infer<typeof PlanAdditionSchema>;

// A plan sentence that is stale, or that contradicts the design's own diagram
// or decisions. That is a defect in the document, not a difference in the
// diff, so it does not make a change inconsistent: it is recorded for the
// human who owns `docs/` while the answer stays `consistent`.
export const PlanDefectSchema = z.object({
  text: z.string().min(1),
  problem: z.string().min(1),
});
export type PlanDefect = z.infer<typeof PlanDefectSchema>;

// The justification an `inconsistent` answer owes the reader: what the bound
// step actually says, in its own words, and what the diff does instead. A
// verdict with no departure is unfalsifiable -- ops#414's review 5701013152
// posted "not consistent with the plan" with no plan sentence and no diff
// hunk, which a human can neither check nor rebut -- so the schema requires
// the two halves rather than letting the body fall back to a generic sentence.
export const PlanDepartureSchema = z.object({
  plan: z.string().min(1),
  diff: z.string().min(1),
});
export type PlanDeparture = z.infer<typeof PlanDepartureSchema>;

// The justification an `unclear` answer owes: what could not be determined,
// and what would settle it. `unclear` is a question, not a shrug: it says
// enough that the next reader knows what to look at.
export const PlanUncertaintySchema = z.object({
  unknown: z.string().min(1),
  settle: z.string().min(1),
});
export type PlanUncertainty = z.infer<typeof PlanUncertaintySchema>;

// The one model judgement in a plan-gated review: is the diff consistent with
// the plan the PR names? Everything else about the gate is deterministic.
// `gates.ts` reads this only when a plan reached the model, and anything
// other than `consistent` -- including a missing answer -- is a flag (case 5
// of `docs/plan-gated-merges.md`). Optional so a run with no plan (every
// ungated run) simply omits it; stored records use the looser
// StoredPlanConsistencySchema below, so a record written before this landed
// still parses and still replays.
//
// The three answers are a discriminated union because each owes the reader a
// different justification, and requiring it here is what makes the rule fail
// closed: an `inconsistent` or `unclear` answer without its detail is a schema
// failure, so the run retries or fails instead of posting an unfalsifiable
// verdict. The enum deliberately stays at three members.
export const PlanConsistencySchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("consistent"),
    reasoning: z.string().min(1),
    // Optional: a consistent answer with nothing to add carries neither, and a
    // record written before they existed still parses.
    additions: z.array(PlanAdditionSchema).optional(),
    planDefects: z.array(PlanDefectSchema).optional(),
  }),
  z.object({
    verdict: z.literal("inconsistent"),
    reasoning: z.string().min(1),
    departure: PlanDepartureSchema,
  }),
  z.object({
    verdict: z.literal("unclear"),
    reasoning: z.string().min(1),
    uncertainty: PlanUncertaintySchema,
  }),
]);
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

// Records written before the justification requirement carry an `inconsistent`
// or `unclear` answer with only a verdict and reasoning. They still parse and
// still replay -- the verdict is what the gate and the eval scorer read, and a
// review body is never rendered from a stored record -- so the record schema is
// deliberately looser than the model-output schema above. A new answer is a
// subset of this shape, so nothing written after this lands needs the second
// schema.
export const StoredPlanConsistencySchema = z.object({
  verdict: z.enum(["consistent", "inconsistent", "unclear"]),
  reasoning: z.string().min(1),
  additions: z.array(PlanAdditionSchema).optional(),
  planDefects: z.array(PlanDefectSchema).optional(),
  departure: PlanDepartureSchema.optional(),
  uncertainty: PlanUncertaintySchema.optional(),
});
export type StoredPlanConsistency = z.infer<typeof StoredPlanConsistencySchema>;

export const StoredReviewOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    findings: z.array(FindingSchema),
    summary: z.string().min(1),
    planConsistency: StoredPlanConsistencySchema.optional(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
  }),
]);
export type StoredReviewOutput = z.infer<typeof StoredReviewOutputSchema>;

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
  output: StoredReviewOutputSchema.nullable(),
  verdict: z.enum(["approve", "comment", "failed"]),
  action: z.enum(["approved", "commented", "failed", "skipped"]),
  gates: z.array(z.string()),
  // The findings half of the verdict, beside `gating` rather than inside it:
  // `findingsVerdict` is what the reviewer found (or did not), `gating` is
  // whether the bot was allowed to approve at all. Keeping them apart is what
  // makes "clean, blocked by the gate" joinable without parsing the comment,
  // and it is why the count and the summary are not repeated here -- they are
  // `findings`/`droppedFindings` and `output.summary` already. Optional: absent
  // on records written before this field and on ungated runs
  // (`DELEGATE_GATING_MODE=off`), where the verdict already says this much.
  findingsVerdict: z.enum(["none", "findings"]).optional(),
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
