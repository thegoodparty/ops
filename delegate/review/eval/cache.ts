import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Result } from "./replay";

// Main's replay results, keyed by the git tree sha of main's delegate/agents/.
// The tree changes only when reviewer code does, so unrelated merges keep the
// cache warm. The bucket is the review bucket; the eval role may write only
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

export const cachePrefix = (tree: string, suite: string): string =>
  `${CACHE_ROOT}/${tree}/${suite}/`;

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

const readBody = async (body: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export interface CacheOptions {
  tree: string;
  suite: string;
  layout: CacheLayout;
  dir: string;
}

export const pullCache = async (opts: CacheOptions, client: S3Client = new S3Client({})): Promise<string[]> => {
  const prefix = cachePrefix(opts.tree, opts.suite);
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

const isAlreadyExists = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "PreconditionFailed" || e.$metadata?.httpStatusCode === 412;
};

export interface PushSummary {
  pushed: string[];
  skippedPulled: string[];
  skippedErrored: string[];
  skippedExisting: string[];
}

// An errored replay counts as a failed run and is retried on the next eval, so
// it is never cached. If-None-Match makes an existing key a no-op, so two evals
// racing on the same tree can't overwrite each other.
export const pushCache = async (opts: CacheOptions, client: S3Client = new S3Client({})): Promise<PushSummary> => {
  const prefix = cachePrefix(opts.tree, opts.suite);
  const pulled = readPulled(opts.dir);
  const summary: PushSummary = { pushed: [], skippedPulled: [], skippedErrored: [], skippedExisting: [] };
  for (const local of localFiles(opts.layout, opts.dir)) {
    if (pulled.has(local)) {
      summary.skippedPulled.push(local);
      continue;
    }
    const body = readFileSync(join(opts.dir, local), "utf-8");
    if ((JSON.parse(body) as Result).error) {
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
