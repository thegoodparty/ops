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

export const ReviewOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    findings: z.array(FindingSchema),
    summary: z.string().min(1),
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

// A posted finding with its id, for the harness paths that act on one
// specific finding: a reconsideration decides it by id, and settled findings
// are kept once each by id. The reviewer never sees the id.
export const IdentifiedFindingSchema = PriorFindingSchema.extend({
  id: z.string().uuid(),
});
export type IdentifiedFinding = z.infer<typeof IdentifiedFindingSchema>;

// A finding the bot withdrew after a human answered it in its thread. Later
// reviews of the PR see it so they do not raise the same concern again.
export const SettledFindingSchema = IdentifiedFindingSchema.extend({
  reason: z.string(),
});
export type SettledFinding = z.infer<typeof SettledFindingSchema>;

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
  settledFindings: z.array(SettledFindingSchema).optional(),
});
export type Bundle = z.infer<typeof BundleSchema>;

// `delegate reconsider`: the agent's input is the open findings a human has
// answered in their threads, and its whole deliverable is one decision per
// finding. It cannot add a finding; a reconsideration only ever removes them.
export const ThreadReplySchema = z.object({
  role: z.enum(["human", "reviewer"]),
  login: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type ThreadReply = z.infer<typeof ThreadReplySchema>;

export const DisputeSchema = z.object({
  finding: IdentifiedFindingSchema,
  replies: z.array(ThreadReplySchema),
});
export type Dispute = z.infer<typeof DisputeSchema>;

export const ReconsiderOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    decisions: z.array(
      z.object({
        findingId: z.string().uuid(),
        decision: z.enum(["withdraw", "maintain"]),
        reason: z.string().min(1),
      }),
    ),
    summary: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
  }),
]);
export type ReconsiderOutput = z.infer<typeof ReconsiderOutputSchema>;

export const ReconsiderationSchema = z.object({
  reconsideredRunId: z.string().uuid(),
  triggeredBy: z.string().optional(),
  disputes: z.array(DisputeSchema),
  output: ReconsiderOutputSchema,
});
export type Reconsideration = z.infer<typeof ReconsiderationSchema>;

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
  trigger: z.enum(["webhook", "re-review", "reconsider", "eval"]),
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
  findings: z.array(PostedFindingSchema),
  droppedFindings: z.array(FindingSchema).default([]),
  settledFindings: z.array(SettledFindingSchema).optional(),
  reconsideration: ReconsiderationSchema.optional(),
  reviewId: z.number().int().optional(),
  tipMovedTo: z.string().optional(),
  error: z.string().optional(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const recordKey = (repo: string, prNumber: number, headSha: string, runId: string) =>
  `reviews/${repo}/${prNumber}/${headSha}/${runId}.json`;

// A reconsideration locks on the record it reconsiders, so a duplicate
// comment cannot run it twice, but a later round (after the bot answers and
// a human replies again) can. Both keys end in /lock so listRecords skips them.
export const lockKey = (
  repo: string,
  prNumber: number,
  headSha: string,
  reconsideredRunId?: string,
) =>
  reconsideredRunId
    ? `reviews/${repo}/${prNumber}/${headSha}/reconsider/${reconsideredRunId}/lock`
    : `reviews/${repo}/${prNumber}/${headSha}/lock`;
