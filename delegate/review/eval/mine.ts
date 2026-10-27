import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { ReviewRecordSchema, isLockKey } from "../schema";
import type { ReviewRecord } from "../schema";

// Proposes eval-case candidates from production reviews. A human confirms
// each one; this tool only reads and never writes the scenario manifest.

const REVIEW_BUCKET = process.env.REVIEW_BUCKET ?? "delegate-reviews";
const FIX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_FIX_WORDS = ["fix", "bug", "revert", "hotfix", "race", "timeout"];
const FETCH_CONCURRENCY = 16;

export interface MinedRecord {
  key: string;
  record: ReviewRecord;
}

export interface MergeInfo {
  mergedAt: string;
  mergeSha: string;
}

export interface FixFile {
  path: string;
  patch: string;
}

export interface FixCommit {
  sha: string;
  subject: string;
  isMerge: boolean;
  files: FixFile[];
}

export interface ReviewComment {
  id: number;
  inReplyToId?: number;
  author: string;
  body: string;
}

// Injected so tests need no network. Real implementations shell out to gh.
export interface Runners {
  prMerge: (repo: string, pr: number) => Promise<MergeInfo | null>;
  commitsBetween: (repo: string, since: string, until: string) => Promise<FixCommit[]>;
  prFiles: (repo: string, pr: number) => Promise<FixFile[]>;
  prComments: (repo: string, pr: number) => Promise<ReviewComment[]>;
}

export interface MissedCandidate {
  kind: "missed";
  key: string;
  repo: string;
  pr: number;
  fixCommit: string;
  overlappingPaths: string[];
  message: string;
  overlapLines: number;
  score: number;
}

export interface RefutedCandidate {
  kind: "refuted";
  key: string;
  repo: string;
  pr: number;
  findings: { path: string; line: number; body: string }[];
  replies: string[];
  mergedSha: string;
}

export type Candidate = MissedCandidate | RefutedCandidate;

interface Line {
  line: number;
  text: string;
}

const readBody = async (body: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// Lists every page of the bucket: the omni prefix alone holds over 1,000 keys.
export const listRecordKeys = async (
  client: S3Client,
  opts: { repo?: string; since?: Date } = {},
): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: REVIEW_BUCKET,
        Prefix: opts.repo ? `reviews/${opts.repo}/` : "reviews/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || isLockKey(obj.Key)) continue;
      if (opts.since && obj.LastModified && obj.LastModified < opts.since) continue;
      keys.push(obj.Key);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return keys;
};

// Eval replays and records that no longer parse (a trigger this code does not
// know yet) are dropped. Of the rest, the latest record per head sha wins.
export const selectRecords = (
  raw: { key: string; json: unknown }[],
): { records: MinedRecord[]; skipped: number } => {
  const latest = new Map<string, MinedRecord>();
  let skipped = 0;
  for (const { key, json } of raw) {
    const parsed = ReviewRecordSchema.safeParse(json);
    if (!parsed.success || parsed.data.trigger === "eval") {
      skipped++;
      continue;
    }
    const record = parsed.data;
    const id = `${record.repo}/${record.prNumber}/${record.headSha}`;
    const prior = latest.get(id);
    if (!prior || prior.record.finishedAt < record.finishedAt) latest.set(id, { key, record });
  }
  return { records: [...latest.values()], skipped };
};

export const loadRecords = async (
  client: S3Client,
  opts: { repo?: string; since?: Date } = {},
): Promise<{ records: MinedRecord[]; skipped: number }> => {
  const keys = await listRecordKeys(client, opts);
  const raw = await mapLimit(keys, FETCH_CONCURRENCY, async (key) => {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: REVIEW_BUCKET, Key: key }));
      return { key, json: JSON.parse(await readBody(res.Body)) as unknown };
    } catch (err) {
      console.warn(`mine: failed to fetch ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return { key, json: null };
    }
  });
  return selectRecords(raw);
};

// Hunk text of one file's patch: added and removed lines with their line
// numbers on the new and old side respectively.
export const patchLines = (patch: string): { added: Line[]; removed: Line[] } => {
  const added: Line[] = [];
  const removed: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split("\n")) {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (text.startsWith("+")) {
      added.push({ line: newLine++, text: text.slice(1) });
    } else if (text.startsWith("-")) {
      removed.push({ line: oldLine++, text: text.slice(1) });
    } else if (text.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  return { added, removed };
};

// Splits a full unified diff into per-file hunk text, keyed by the new path.
export const splitDiff = (diff: string): FixFile[] => {
  const files: FixFile[] = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const at = section.search(/^@@ /m);
    if (at === -1) continue;
    const header = section.slice(0, at);
    const path = header.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (path) files.push({ path, patch: section.slice(at) });
  }
  return files;
};

const isSubstantive = (text: string): boolean => /[A-Za-z0-9_]{4,}/.test(text);

// A fix commit overlaps the approved diff where it removes a line the diff
// added. Matching is by line text per path: the fix's line numbers sit on a
// later tree than the approved head, so numbers would not line up.
export const findOverlap = (
  approvedDiff: string,
  fixFiles: FixFile[],
): { paths: string[]; lines: number } => {
  const addedByPath = new Map<string, Set<string>>();
  for (const f of splitDiff(approvedDiff)) {
    addedByPath.set(
      f.path,
      new Set(patchLines(f.patch).added.map((l) => l.text.trim()).filter(isSubstantive)),
    );
  }
  const paths: string[] = [];
  let lines = 0;
  for (const f of fixFiles) {
    const added = addedByPath.get(f.path);
    if (!added) continue;
    const hits = patchLines(f.patch).removed.filter((l) => added.has(l.text.trim())).length;
    if (hits > 0) {
      paths.push(f.path);
      lines += hits;
    }
  }
  return { paths, lines };
};

const LOW_SIGNAL_PATH = /\.mdx?$|(^|\/)e2e\/|\.(e2e|spec)\.[jt]sx?$|copy/i;

const isFixShaped = (subject: string, words: string[]): boolean =>
  new RegExp(`\\b(${words.join("|")})`, "i").test(subject);

export const scoreFix = (
  subject: string,
  overlap: { paths: string[]; lines: number },
  words: string[] = DEFAULT_FIX_WORDS,
): number => {
  let score = Math.min(overlap.lines, 10);
  if (isFixShaped(subject, words)) score += 10;
  if (overlap.paths.every((p) => LOW_SIGNAL_PATH.test(p))) score -= 10;
  return score;
};

export const missedCandidates = (
  mined: MinedRecord,
  commits: FixCommit[],
  mergeSha: string,
  words: string[] = DEFAULT_FIX_WORDS,
): MissedCandidate[] => {
  const out: MissedCandidate[] = [];
  for (const commit of commits) {
    // A merge commit's subject carries the branch name, which almost always
    // holds a ticket id and often "fix"; only a commit's own subject counts.
    if (commit.isMerge || commit.sha === mergeSha) continue;
    const overlap = findOverlap(mined.record.bundle.diff, commit.files);
    if (overlap.paths.length === 0) continue;
    out.push({
      kind: "missed",
      key: mined.key,
      repo: mined.record.repo,
      pr: mined.record.prNumber,
      fixCommit: commit.sha,
      overlappingPaths: overlap.paths,
      message: commit.subject,
      overlapLines: overlap.lines,
      score: scoreFix(commit.subject, overlap, words),
    });
  }
  return out;
};

// A delegate comment is refuted when every flagged line is still in the merged
// PR and the author replied on every finding thread.
export const refutedCandidate = (
  mined: MinedRecord,
  mergedFiles: FixFile[],
  comments: ReviewComment[],
  mergedSha: string,
): RefutedCandidate | null => {
  const { record, key } = mined;
  if (record.verdict !== "comment" || record.findings.length === 0) return null;

  const mergedAdded = new Map<string, Set<string>>();
  for (const f of mergedFiles) {
    mergedAdded.set(f.path, new Set(patchLines(f.patch).added.map((l) => l.text)));
  }
  const reviewedAdded = new Map<string, Line[]>();
  for (const f of splitDiff(record.bundle.diff)) reviewedAdded.set(f.path, patchLines(f.patch).added);

  const replies: string[] = [];
  for (const finding of record.findings) {
    const root = comments.find((c) => c.id === finding.commentId);
    if (!root) return null;
    const reply = comments.filter((c) => c.inReplyToId === root.id && c.author !== root.author);
    if (reply.length === 0) return null;
    replies.push(...reply.map((c) => c.body));

    const end = finding.endLine ?? finding.line;
    const flagged = (reviewedAdded.get(finding.path) ?? []).filter(
      (l) => l.line >= finding.line && l.line <= end,
    );
    const stillThere = mergedAdded.get(finding.path);
    if (flagged.length === 0 || !stillThere || !flagged.every((l) => stillThere.has(l.text))) return null;
  }

  return {
    kind: "refuted",
    key,
    repo: record.repo,
    pr: record.prNumber,
    findings: record.findings.map((f) => ({ path: f.path, line: f.line, body: f.body })),
    replies,
    mergedSha,
  };
};

export interface MineOptions {
  kind?: "missed" | "refuted";
  fixWords?: string[];
  limit?: number;
}

export const mine = async (
  records: MinedRecord[],
  runners: Runners,
  opts: MineOptions = {},
): Promise<Candidate[]> => {
  const words = opts.fixWords ?? DEFAULT_FIX_WORDS;
  const merges = new Map<string, Promise<MergeInfo | null>>();
  const merged = (repo: string, pr: number) => {
    const id = `${repo}/${pr}`;
    if (!merges.has(id)) merges.set(id, runners.prMerge(repo, pr));
    return merges.get(id)!;
  };

  const missed: MissedCandidate[] = [];
  const refuted: RefutedCandidate[] = [];
  for (const mined of records) {
    const { repo, prNumber, verdict } = mined.record;
    if (verdict === "approve" && opts.kind !== "refuted") {
      const merge = await merged(repo, prNumber);
      if (!merge) continue;
      const until = new Date(new Date(merge.mergedAt).getTime() + FIX_WINDOW_MS).toISOString();
      const commits = await runners.commitsBetween(repo, merge.mergedAt, until);
      missed.push(...missedCandidates(mined, commits, merge.mergeSha, words));
    } else if (verdict === "comment" && opts.kind !== "missed") {
      const merge = await merged(repo, prNumber);
      if (!merge) continue;
      const [files, comments] = await Promise.all([
        runners.prFiles(repo, prNumber),
        runners.prComments(repo, prNumber),
      ]);
      const found = refutedCandidate(mined, files, comments, merge.mergeSha);
      if (found) refuted.push(found);
    }
  }
  const ranked = [...missed.sort((a, b) => b.score - a.score), ...refuted];
  return opts.limit === undefined ? ranked : ranked.slice(0, opts.limit);
};

const run = promisify(execFile);

const gh = async (args: string[]): Promise<string> => {
  const { stdout } = await run("gh", args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
};

interface RestCommit {
  sha: string;
  commit: { message: string };
  parents: unknown[];
  files?: { filename: string; patch?: string }[];
}

export const ghRunners: Runners = {
  prMerge: async (repo, pr) => {
    const out = JSON.parse(await gh(["pr", "view", String(pr), "--repo", repo, "--json", "mergedAt,mergeCommit"])) as {
      mergedAt: string | null;
      mergeCommit: { oid: string } | null;
    };
    return out.mergedAt && out.mergeCommit ? { mergedAt: out.mergedAt, mergeSha: out.mergeCommit.oid } : null;
  },
  commitsBetween: async (repo, since, until) => {
    const list = JSON.parse(
      await gh(["api", "--paginate", "--slurp", `repos/${repo}/commits?since=${since}&until=${until}&per_page=100`]),
    ) as RestCommit[][];
    return mapLimit(list.flat(), 8, async (c) => {
      const full = JSON.parse(await gh(["api", `repos/${repo}/commits/${c.sha}`])) as RestCommit;
      return {
        sha: c.sha,
        subject: c.commit.message.split("\n")[0],
        isMerge: c.parents.length > 1,
        files: (full.files ?? []).flatMap((f) => (f.patch ? [{ path: f.filename, patch: f.patch }] : [])),
      };
    });
  },
  prFiles: async (repo, pr) => {
    const files = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/files?per_page=100`])) as {
      filename: string;
      patch?: string;
    }[][];
    return files.flat().flatMap((f) => (f.patch ? [{ path: f.filename, patch: f.patch }] : []));
  },
  prComments: async (repo, pr) => {
    const comments = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/comments?per_page=100`])) as {
      id: number;
      in_reply_to_id?: number;
      user: { login: string };
      body: string;
    }[][];
    return comments.flat().map((c) => ({
      id: c.id,
      inReplyToId: c.in_reply_to_id,
      author: c.user.login,
      body: c.body,
    }));
  },
};

const parseFlags = (args: string[]): Record<string, string> => {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i];
    const value = args[i + 1];
    if (!arg.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`mine: expected "--flag value", got "${arg}"`);
    }
    flags[arg.slice(2)] = value;
  }
  return flags;
};

const main = async () => {
  const flags = parseFlags(process.argv.slice(2));
  const kind = flags.kind;
  if (kind !== undefined && kind !== "missed" && kind !== "refuted") {
    throw new Error(`mine: --kind must be missed or refuted, got "${kind}"`);
  }
  const since = flags.since ? new Date(flags.since) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error(`mine: invalid --since "${flags.since}"`);

  const { records, skipped } = await loadRecords(new S3Client({}), { repo: flags.repo, since });
  console.error(`mine: ${records.length} records (${skipped} skipped: eval or unparseable)`);

  const candidates = await mine(records, ghRunners, {
    kind,
    fixWords: flags["fix-words"]?.split(",").map((w) => w.trim()).filter(Boolean),
    limit: flags.limit ? Number(flags.limit) : undefined,
  });
  const jsonl = candidates.map((c) => JSON.stringify(c)).join("\n");
  if (flags.out) writeFileSync(flags.out, jsonl ? `${jsonl}\n` : "");
  else if (jsonl) console.log(jsonl);
  console.error(`mine: ${candidates.length} candidates`);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
