import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { ReviewRecordSchema } from "../schema";
import type { ReviewRecord } from "../schema";

const REVIEW_BUCKET = process.env.REVIEW_BUCKET ?? "delegate-reviews";

const readBody = async (body: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export interface LoadOptions {
  from: string;
  repo?: string;
  limit?: number;
  onlyComplete?: boolean;
}

const applyFilters = (records: ReviewRecord[], opts: LoadOptions): ReviewRecord[] => {
  let result = records;
  if (opts.repo) result = result.filter((r) => r.repo === opts.repo);
  if (opts.onlyComplete) result = result.filter((r) => r.output?.status === "complete");
  if (opts.limit !== undefined) result = result.slice(0, opts.limit);
  return result;
};

const loadFromDir = (dir: string): ReviewRecord[] => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const records: ReviewRecord[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    } catch {
      console.warn(`cases: invalid JSON in ${file}`);
      continue;
    }
    const result = ReviewRecordSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`cases: invalid ReviewRecord in ${file}: ${result.error.message}`);
      continue;
    }
    records.push(result.data);
  }
  return records;
};

const loadFromS3 = async (client: S3Client): Promise<ReviewRecord[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: REVIEW_BUCKET,
        Prefix: "reviews/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && !obj.Key.endsWith("/lock")) {
        keys.push(obj.Key);
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  const records: ReviewRecord[] = [];
  for (const key of keys) {
    let text: string;
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: REVIEW_BUCKET, Key: key }),
      );
      text = await readBody(res.Body);
    } catch (err) {
      console.warn(
        `cases: failed to fetch ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(`cases: invalid JSON at ${key}`);
      continue;
    }
    const result = ReviewRecordSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`cases: invalid ReviewRecord at ${key}: ${result.error.message}`);
      continue;
    }
    records.push(result.data);
  }
  return records;
};

export const loadCases = async (
  opts: LoadOptions,
  client: S3Client = new S3Client({}),
): Promise<ReviewRecord[]> => {
  const records =
    opts.from === "s3" ? await loadFromS3(client) : loadFromDir(opts.from);
  return applyFilters(records, opts);
};

export const saveCases = (records: ReviewRecord[], dir: string): void => {
  mkdirSync(dir, { recursive: true });
  for (const record of records) {
    writeFileSync(
      join(dir, `${record.runId}.json`),
      JSON.stringify(record, null, 2),
    );
  }
};
