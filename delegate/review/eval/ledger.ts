import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { isAlreadyExists, readBody } from "./cache";

// The spend of one hill-climb run id, kept as one object per measured
// dispatch instead of one object that is read, edited and rewritten. An entry
// is written once with If-None-Match, so the role that writes entries can
// neither edit nor delete earlier ones, and two dispatches can never lose
// each other's entry to an overwrite.
const REVIEW_BUCKET = process.env.REVIEW_BUCKET ?? "delegate-reviews";
export const LEDGER_ROOT = "eval-cache/ledger";

export const RUN_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export const ModeSchema = z.enum(["dry-run", "inner", "tune", "gate"]);
export type EvalRunMode = z.infer<typeof ModeSchema>;

const INNER_USD_PER_CASE = 4;
const USD_PER_RUN = 1.3;
const RUNS_PER_CASE = 3;

// `caseCount` is the cases the mode replays: the ids given for inner, the tune
// cases for tune, every case for gate. Reruns and main's own baseline replay
// are not in the estimate; main's is cached and not charged to the run.
export const estimateUsd = (mode: EvalRunMode, caseCount: number): number => {
  const usd =
    mode === "inner"
      ? caseCount * INNER_USD_PER_CASE
      : mode === "dry-run"
        ? 0
        : caseCount * RUNS_PER_CASE * USD_PER_RUN;
  return Math.round(usd * 100) / 100;
};

const EntrySchema = z.object({
  mode: ModeSchema,
  costUsd: z.number().finite().nonnegative(),
  budgetUsd: z.number().finite().positive(),
  at: z.string(),
  ghRunId: z.string().regex(/^\d+$/),
  ghRunAttempt: z.string().regex(/^\d+$/),
  branchSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type LedgerEntry = z.infer<typeof EntrySchema>;

const prefixFor = (runId: string): string => {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`bad run id: ${runId}`);
  return `${LEDGER_ROOT}/${runId}/`;
};

export const readLedger = async (runId: string, client: S3Client = new S3Client({})): Promise<LedgerEntry[]> => {
  const prefix = prefixFor(runId);
  const entries: LedgerEntry[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: REVIEW_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const got = await client.send(new GetObjectCommand({ Bucket: REVIEW_BUCKET, Key: obj.Key }));
      entries.push(EntrySchema.parse(JSON.parse(await readBody(got.Body))));
    }
    token = res.NextContinuationToken;
  } while (token);
  return entries;
};

export interface BudgetCheck {
  budgetUsd: number;
  spentUsd: number;
  estimateUsd: number;
  remainingUsd: number;
  ok: boolean;
}

// The lowest budget ever stated for the run id wins, so a later dispatch can
// shrink the budget but never raise it.
export const checkBudget = (entries: LedgerEntry[], requestedBudgetUsd: number, estimate: number): BudgetCheck => {
  const budgetUsd = Math.min(requestedBudgetUsd, ...entries.map((e) => e.budgetUsd));
  const spentUsd = Math.round(entries.reduce((sum, e) => sum + e.costUsd, 0) * 100) / 100;
  const remainingUsd = Math.round((budgetUsd - spentUsd) * 100) / 100;
  return { budgetUsd, spentUsd, estimateUsd: estimate, remainingUsd, ok: estimate <= remainingUsd };
};

// Returns false when this run attempt's entry for the mode already exists, as
// when the ledger job itself is re-run within the same attempt; the cost was
// recorded the first time.
export const addEntry = async (
  runId: string,
  entry: LedgerEntry,
  client: S3Client = new S3Client({}),
): Promise<boolean> => {
  const parsed = EntrySchema.parse(entry);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: REVIEW_BUCKET,
        Key: `${prefixFor(runId)}${parsed.ghRunId}-${parsed.ghRunAttempt}-${parsed.mode}.json`,
        Body: JSON.stringify(parsed, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );
    return true;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    return false;
  }
};

// Sums `costUsd` over every <dir>/<case>/run-<n>.json, the expected suite's
// layout. A run with no valid recorded cost counts as zero.
export const sumResultCosts = (dirs: string[]): { costUsd: number; runs: number } => {
  let costUsd = 0;
  let runs = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of readdirSync(join(dir, d.name)).filter((n) => /^run-\d+\.json$/.test(n))) {
        runs++;
        try {
          const result = JSON.parse(readFileSync(join(dir, d.name, f), "utf-8")) as { costUsd?: unknown };
          if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd > 0) {
            costUsd += result.costUsd;
          }
        } catch {
          // Candidate code writes these files; an unreadable one counts as zero and the estimate floors the charge.
        }
      }
    }
  }
  return { costUsd: Math.round(costUsd * 100) / 100, runs };
};

// What a run is charged: what its results reported, but never less than the
// estimate it was admitted on, so a run whose results are missing or
// understated is still billed.
export const chargedUsd = (reportedUsd: number | null, estimate: number): number =>
  Math.max(reportedUsd !== null && Number.isFinite(reportedUsd) ? reportedUsd : 0, estimate);
