import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { startS3 } from "./s3";

test("BugBoss's own S3 client, configured only by AWS_ENDPOINT_URL_S3, round-trips through the stand-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "s3-"));
  const { url, server } = await startS3(root);
  const saved = { ...process.env };
  Object.assign(process.env, {
    AWS_ENDPOINT_URL_S3: url,
    AWS_ACCESS_KEY_ID: "fake",
    AWS_SECRET_ACCESS_KEY: "fake",
    AWS_REGION: "us-west-2",
  });
  try {
    const s3 = new S3Client({});
    await s3.send(new PutObjectCommand({ Bucket: "b", Key: "sessions/inc-1.jsonl", Body: "line\n" }));
    assert.equal(readFileSync(join(root, "b", "sessions", "inc-1.jsonl"), "utf8"), "line\n");
    const got = await s3.send(new GetObjectCommand({ Bucket: "b", Key: "sessions/inc-1.jsonl" }));
    assert.equal(await got.Body!.transformToString(), "line\n");
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: "b", Prefix: "sessions/" }));
    assert.deepEqual(listed.Contents?.map((c) => c.Key), ["sessions/inc-1.jsonl"]);
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: "b", Key: "missing" })), { name: "NoSuchKey" });
  } finally {
    process.env = saved;
    server.close();
  }
});
