import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Result } from "./replay";

// Main's replay results, keyed by a hash of everything main's replay executes
// that can change its output. Unrelated merges leave it alone, so the cache
// stays warm. The bucket is the review bucket; the eval role may write only
// under this prefix.
const REVIEW_BUCKET = process.env.REVIEW_BUCKET ?? "delegate-reviews";
const CACHE_ROOT = "eval-cache/main";

// What pull downloaded, so push can skip it. Not a .json file, so result
// loaders that glob *.json never read it.
export const PULLED_MARKER = ".cache-pulled";

// `flat` is the pairwise layout (<dir>/<caseId>.json, one result per case);
// `runs` is the expected suite's (<dir>/<caseId>/run-<n>.json). Remotely both
// are <suite>/<caseId>/run-<n>.json, with the single pairwise result as run-1.
export type CacheLayout = "flat" | "runs";

// The agent, the framework and review code it runs through, and the pinned
// SDK. The whole review tree is hashed, so an eval-code edit costs a replay
// but a stale baseline is never served.
const REPLAY_INPUTS = ["delegate/agents", "delegate/framework", "delegate/review", "package-lock.json"];

export const replayKey = (repoDir: string): string => {
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: repoDir, input, encoding: "utf-8", timeout: 30_000 }).trim();
  const ids = git(["rev-parse", ...REPLAY_INPUTS.map((p) => `HEAD:${p}`)]);
  return git(["hash-object", "--stdin"], `${ids}\n`);
};

// Whether a cached result came from a main commit with this checkout's
// reviewer. A result's variant is `main-<sha>`; the reviewer is the
// `delegate/agents` tree at that sha. A sha the checkout can't resolve is not
// the same reviewer. Needs full history.
export const sameReviewerAs = (repoDir: string): ((result: Result) => boolean) => {
  const tree = (rev: string): string | null => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rev}:delegate/agents`], {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }).trim();
    } catch {
      return null;
    }
  };
  const current = tree("HEAD");
  const seen = new Map<string, string | null>();
  return (result) => {
    const m = /^main-([0-9a-f]{7,40})$/.exec(result.variant ?? "");
    if (!m || current === null) return false;
    if (!seen.has(m[1])) seen.set(m[1], tree(m[1]));
    return seen.get(m[1]) === current;
  };
};

export const cachePrefix = (replayKey: string, suite: string): string =>
  `${CACHE_ROOT}/${replayKey}/${suite}/`;

const toRemote = (layout: CacheLayout, local: string): string | null => {
  if (layout === "runs") return /^[^/]+\/run-\d+\.json$/.test(local) ? local : null;
  return /^[^/.][^/]*\.json$/.test(local) ? `${local.slice(0, -".json".length)}/run-1.json` : null;
};

const toLocal = (layout: CacheLayout, remote: string): string | null => {
  if (layout === "runs") return /^[^/]+\/run-\d+\.json$/.test(remote) ? remote : null;
  const m = /^([^/]+)\/run-1\.json$/.exec(remote);
  return m ? `${m[1]}.json` : null;
};

const localFiles = (layout: CacheLayout, dir: string): string[] => {
  if (!existsSync(dir)) return [];
  if (layout === "flat") return readdirSync(dir).filter((f) => toRemote("flat", f));
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(dir, d.name)).map((f) => `${d.name}/${f}`))
    .filter((f) => toRemote("runs", f));
};

const readPulled = (dir: string): Set<string> => {
  const marker = join(dir, PULLED_MARKER);
  return new Set(existsSync(marker) ? readFileSync(marker, "utf-8").split("\n").filter(Boolean) : []);
};

export const readBody = async (body: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export interface CacheOptions {
  key: string;
  suite: string;
  layout: CacheLayout;
  dir: string;
}

export const pullCache = async (opts: CacheOptions, client: S3Client = new S3Client({})): Promise<string[]> => {
  const prefix = cachePrefix(opts.key, opts.suite);
  const pulled: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: REVIEW_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      const local = obj.Key ? toLocal(opts.layout, obj.Key.slice(prefix.length)) : null;
      if (!local) continue;
      const got = await client.send(new GetObjectCommand({ Bucket: REVIEW_BUCKET, Key: obj.Key }));
      const path = join(opts.dir, local);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, await readBody(got.Body));
      pulled.push(local);
    }
    token = res.NextContinuationToken;
  } while (token);
  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(join(opts.dir, PULLED_MARKER), pulled.map((p) => `${p}\n`).join(""));
  return pulled;
};

const HISTORY_CONCURRENCY = 16;

// Main's earlier expected-suite runs under other replay keys, kept when
// `sameReviewer` accepts them. The key changes with any edit under
// delegate/review, eval code included, so the current key alone often holds
// only one check's three runs, too few to tell a stable case from a lucky
// streak. Written as <dir>/<caseId>/run-<n>.json, numbered per case, and
// never pushed back to the cache.
export const pullHistory = async (
  opts: { key: string; suitePrefix: string; dir: string; sameReviewer: (result: Result) => boolean },
  client: S3Client = new S3Client({}),
): Promise<number> => {
  const perCase = new Map<string, number>();
  let kept = 0;
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: REVIEW_BUCKET, Prefix: `${CACHE_ROOT}/`, ContinuationToken: token }),
    );
    const wanted = (res.Contents ?? []).flatMap((obj) => {
      const m = obj.Key ? /^eval-cache\/main\/([^/]+)\/([^/]+)\/([^/]+)\/run-\d+\.json$/.exec(obj.Key) : null;
      return m && obj.Key && m[1] !== opts.key && m[2].startsWith(opts.suitePrefix) ? [{ key: obj.Key, caseId: m[3] }] : [];
    });
    for (let i = 0; i < wanted.length; i += HISTORY_CONCURRENCY) {
      const batch = await Promise.all(
        wanted.slice(i, i + HISTORY_CONCURRENCY).map(async (w) => {
          const got = await client.send(new GetObjectCommand({ Bucket: REVIEW_BUCKET, Key: w.key }));
          return { caseId: w.caseId, result: JSON.parse(await readBody(got.Body)) as Result };
        }),
      );
      for (const { caseId, result } of batch) {
        if (!isCacheable(result) || !opts.sameReviewer(result)) continue;
        const n = (perCase.get(caseId) ?? 0) + 1;
        perCase.set(caseId, n);
        mkdirSync(join(opts.dir, caseId), { recursive: true });
        writeFileSync(join(opts.dir, caseId, `run-${n}.json`), JSON.stringify(result));
        kept++;
      }
    }
    token = res.NextContinuationToken;
  } while (token);
  mkdirSync(opts.dir, { recursive: true });
  return kept;
};

export const isAlreadyExists = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  // 412 when the key exists; 409 when another If-None-Match put on the same new
  // key is still in flight, as two evals racing after a cache-busting merge are.
  return (
    e.name === "PreconditionFailed" ||
    e.name === "ConditionalRequestConflict" ||
    e.$metadata?.httpStatusCode === 412 ||
    e.$metadata?.httpStatusCode === 409
  );
};

// A result is cached only when the replay finished with a review. An error, or
// an output that reports `failed`, counts as a failed run and is retried on the
// next eval. Both layouts and the expected replay's skip-existing check use
// this one rule.
export const isCacheable = (result: Result): boolean =>
  !result.error && result.output?.status === "complete";

export interface PushSummary {
  pushed: string[];
  skippedPulled: string[];
  skippedErrored: string[];
  skippedExisting: string[];
}

// Uncacheable results are never uploaded (see isCacheable), so a case that is
// partly done caches the runs that finished and the rest are retried.
// If-None-Match makes an existing key a no-op, so two evals
// racing on the same tree can't overwrite each other.
export const pushCache = async (opts: CacheOptions, client: S3Client = new S3Client({})): Promise<PushSummary> => {
  const prefix = cachePrefix(opts.key, opts.suite);
  const pulled = readPulled(opts.dir);
  const summary: PushSummary = { pushed: [], skippedPulled: [], skippedErrored: [], skippedExisting: [] };
  for (const local of localFiles(opts.layout, opts.dir)) {
    if (pulled.has(local)) {
      summary.skippedPulled.push(local);
      continue;
    }
    const body = readFileSync(join(opts.dir, local), "utf-8");
    if (!isCacheable(JSON.parse(body) as Result)) {
      summary.skippedErrored.push(local);
      continue;
    }
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: REVIEW_BUCKET,
          Key: `${prefix}${toRemote(opts.layout, local)}`,
          Body: body,
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
      summary.pushed.push(local);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      summary.skippedExisting.push(local);
    }
  }
  return summary;
};
