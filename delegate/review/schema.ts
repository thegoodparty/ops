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
  priorFindingId: z.string().uuid().optional(),
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

// A prior finding as the agent sees it on re-review: its id (so it can be
// carried forward via priorFindingId) and where it was posted.
export const PriorFindingSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  line: z.number().int(),
  body: z.string(),
  category: FindingSchema.shape.category,
  headSha: z.string(),
});
export type PriorFinding = z.infer<typeof PriorFindingSchema>;

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
});
export type Bundle = z.infer<typeof BundleSchema>;

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
  findings: z.array(PostedFindingSchema),
  droppedFindings: z.array(FindingSchema).default([]),
  reviewId: z.number().int().optional(),
  tipMovedTo: z.string().optional(),
  error: z.string().optional(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const recordKey = (repo: string, prNumber: number, headSha: string, runId: string) =>
  `reviews/${repo}/${prNumber}/${headSha}/${runId}.json`;

export const lockKey = (repo: string, prNumber: number, headSha: string) =>
  `reviews/${repo}/${prNumber}/${headSha}/lock`;
