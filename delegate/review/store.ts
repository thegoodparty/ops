import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { ReviewRecordSchema, recordKey, lockKey } from "./schema";
import type { ReviewRecord } from "./schema";

const BUCKET = process.env.REVIEW_BUCKET ?? "delegate-reviews";

const readBody = async (body: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export const createStore = (client: S3Client = new S3Client({})) => {
  const acquireLock = async (
    repo: string,
    prNumber: number,
    headSha: string
  ): Promise<boolean> => {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: lockKey(repo, prNumber, headSha),
          Body: JSON.stringify({ acquiredAt: new Date().toISOString() }),
          IfNoneMatch: "*",
        })
      );
      return true;
    } catch (err: unknown) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (status === 412 || status === 409) return false;
      throw err;
    }
  };

  const releaseLock = async (repo: string, prNumber: number, headSha: string): Promise<void> => {
    await client.send(
      new DeleteObjectCommand({ Bucket: BUCKET, Key: lockKey(repo, prNumber, headSha) })
    );
  };

  const lockAcquiredAt = async (
    repo: string,
    prNumber: number,
    headSha: string
  ): Promise<Date | undefined> => {
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: lockKey(repo, prNumber, headSha) })
      );
      const parsed = JSON.parse(await readBody(res.Body)) as { acquiredAt?: string };
      return parsed.acquiredAt ? new Date(parsed.acquiredAt) : undefined;
    } catch (err: unknown) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (status === 404) return undefined;
      throw err;
    }
  };

  const putRecord = async (record: ReviewRecord): Promise<void> => {
    ReviewRecordSchema.parse(record);
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: recordKey(record.repo, record.prNumber, record.headSha, record.runId),
        Body: JSON.stringify(record),
        ContentType: "application/json",
      })
    );
  };

  const listRecords = async (
    repo: string,
    prNumber: number
  ): Promise<ReviewRecord[]> => {
    const prefix = `reviews/${repo}/${prNumber}/`;
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
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
      const res = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(res.Body));
      } catch {
        console.warn(`store: invalid JSON at ${key}`);
        continue;
      }

      const result = ReviewRecordSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(`store: invalid ReviewRecord at ${key}:`, result.error.message);
        continue;
      }
      records.push(result.data);
    }

    return records.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  };

  const latestRecord = async (
    repo: string,
    prNumber: number
  ): Promise<ReviewRecord | undefined> => {
    const records = await listRecords(repo, prNumber);
    return records[records.length - 1];
  };

  return { acquireLock, releaseLock, lockAcquiredAt, putRecord, listRecords, latestRecord };
};
