import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { listRecordKeys, mine, missedCandidates, refutedCandidate, scoreFix, selectRecords } from "./mine";
import type { FixCommit, MinedRecord, Runners } from "./mine";
import type { ReviewRecord } from "../schema";

const APPROVED_DIFF = [
  "diff --git a/src/tags.ts b/src/tags.ts",
  "index 111..222 100644",
  "--- a/src/tags.ts",
  "+++ b/src/tags.ts",
  "@@ -10,3 +10,5 @@ export const tag = async () => {",
  "   const name = input.name",
  "+  const existing = await db.tag.findUnique({ where: { name } })",
  "+  if (!existing) await db.tag.create({ data: { name } })",
  "   return name",
  "",
].join("\n");

const makeRecord = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  runId: randomUUID(),
  repo: "thegoodparty/omni",
  prNumber: 2368,
  baseSha: "aaaaaa",
  headSha: "bbbbbb",
  trigger: "webhook",
  agentVersion: "1.0.0",
  model: "claude-opus-5-5",
  startedAt: "2026-10-06T00:00:00.000Z",
  finishedAt: "2026-10-06T00:01:00.000Z",
  wallTimeMs: 60000,
  costUsd: 1,
  bundle: {
    repo: "thegoodparty/omni",
    prNumber: 2368,
    baseRef: "main",
    baseSha: "aaaaaa",
    headSha: "bbbbbb",
    author: "dev",
    title: "Tag issues",
    body: "",
    diff: APPROVED_DIFF,
    changedFiles: ["src/tags.ts"],
    priorFindings: [],
  },
  output: { status: "complete", findings: [], summary: "ok" },
  verdict: "approve",
  action: "approved",
  gates: [],
  findings: [],
  droppedFindings: [],
  ...overrides,
});

const mined = (record: ReviewRecord, key = `reviews/${record.repo}/${record.prNumber}/${record.headSha}/${record.runId}.json`): MinedRecord => ({
  key,
  record,
});

const fixPatch = [
  "@@ -10,5 +10,6 @@ export const tag = async () => {",
  "   const name = input.name",
  "-  const existing = await db.tag.findUnique({ where: { name } })",
  "-  if (!existing) await db.tag.create({ data: { name } })",
  "+  await db.tag.upsert({ where: { name }, create: { name }, update: {} })",
  "   return name",
].join("\n");

const fixCommit = (overrides: Partial<FixCommit> = {}): FixCommit => ({
  sha: "81bc332479",
  subject: "Fix tag creation race",
  isMerge: false,
  committedAt: "2026-10-08T00:00:00.000Z",
  files: [{ path: "src/tags.ts", patch: fixPatch }],
  ...overrides,
});

test("an added line later removed by a fix commit is flagged with its path", () => {
  const found = missedCandidates(mined(makeRecord()), [fixCommit()], "mergesha");
  assert.equal(found.length, 1);
  assert.equal(found[0].fixCommit, "81bc332479");
  assert.deepEqual(found[0].overlappingPaths, ["src/tags.ts"]);
  assert.equal(found[0].overlapLines, 2);
  assert.equal(found[0].message, "Fix tag creation race");
});

test("a fix that only removes lines the approved diff did not add is not flagged", () => {
  const untouched = fixCommit({
    files: [{ path: "src/tags.ts", patch: "@@ -1,2 +1,1 @@\n-const unrelated = 1\n+const unrelated = 2" }],
  });
  assert.deepEqual(missedCandidates(mined(makeRecord()), [untouched], "mergesha"), []);
});

test("a same-text removal in a path the approved diff did not touch is not flagged", () => {
  const elsewhere = fixCommit({ files: [{ path: "src/other.ts", patch: fixPatch }] });
  assert.deepEqual(missedCandidates(mined(makeRecord()), [elsewhere], "mergesha"), []);
});

test("merge commits and the PR's own merge commit are never fix commits", () => {
  const found = missedCandidates(
    mined(makeRecord()),
    [fixCommit({ isMerge: true, sha: "m1" }), fixCommit({ sha: "mergesha" })],
    "mergesha",
  );
  assert.deepEqual(found, []);
});

test("a fix: commit outranks a chore: commit with the same overlap", () => {
  const overlap = { paths: ["src/tags.ts"], lines: 2 };
  assert.ok(scoreFix("fix: tag race", overlap) > scoreFix("chore: tidy tags", overlap));
});

test("a ticket id in the subject does not make a commit fix-shaped", () => {
  const overlap = { paths: ["src/tags.ts"], lines: 2 };
  assert.equal(scoreFix("ENG-11491 tidy tags", overlap), scoreFix("tidy tags", overlap));
});

test("a fix touching only markdown or e2e specs is down-ranked", () => {
  const code = { paths: ["src/tags.ts"], lines: 2 };
  assert.ok(scoreFix("fix: x", code) > scoreFix("fix: x", { paths: ["docs/tags.md"], lines: 2 }));
  assert.ok(scoreFix("fix: x", code) > scoreFix("fix: x", { paths: ["e2e/tags.spec.ts"], lines: 2 }));
});

test("custom fix words replace the defaults", () => {
  const overlap = { paths: ["src/tags.ts"], lines: 2 };
  assert.ok(scoreFix("Batch the writes", overlap, ["batch"]) > scoreFix("Fix the writes", overlap, ["batch"]));
});

test("listing walks every page and skips lock objects", async () => {
  const pages: Record<string, { Contents: { Key: string; LastModified: Date }[]; NextContinuationToken?: string }> = {
    start: {
      Contents: [
        { Key: "reviews/r/1/h/a.json", LastModified: new Date("2026-10-06") },
        { Key: "reviews/r/1/h/lock", LastModified: new Date("2026-10-06") },
      ],
      NextContinuationToken: "t2",
    },
    t2: { Contents: [{ Key: "reviews/r/2/h/b.json", LastModified: new Date("2026-10-06") }] },
  };
  const tokens: (string | undefined)[] = [];
  const client = {
    send: async (cmd: { input: { ContinuationToken?: string } }) => {
      tokens.push(cmd.input.ContinuationToken);
      return pages[cmd.input.ContinuationToken ?? "start"];
    },
  } as unknown as S3Client;

  assert.deepEqual(await listRecordKeys(client), ["reviews/r/1/h/a.json", "reviews/r/2/h/b.json"]);
  assert.deepEqual(tokens, [undefined, "t2"]);
});

test("listing skips objects older than --since", async () => {
  const client = {
    send: async () => ({
      Contents: [
        { Key: "reviews/r/1/h/old.json", LastModified: new Date("2026-09-01") },
        { Key: "reviews/r/1/h/new.json", LastModified: new Date("2026-10-10") },
      ],
    }),
  } as unknown as S3Client;
  assert.deepEqual(await listRecordKeys(client, { since: new Date("2026-10-05") }), ["reviews/r/1/h/new.json"]);
});

test("eval-trigger and unparseable records are excluded, the latest per head sha wins", () => {
  const first = makeRecord({ finishedAt: "2026-10-06T00:01:00.000Z" });
  const second = makeRecord({ finishedAt: "2026-10-06T00:09:00.000Z" });
  const { records, skipped } = selectRecords([
    { key: "k1", json: first },
    { key: "k2", json: second },
    { key: "k3", json: makeRecord({ trigger: "eval" }) },
    { key: "k4", json: { ...makeRecord(), trigger: "reconsider" } },
    { key: "k5", json: null },
  ]);
  assert.deepEqual(records.map((r) => r.key), ["k2"]);
  assert.equal(skipped, 3);
});

const blocked = (commentId: number) =>
  makeRecord({
    verdict: "comment",
    action: "commented",
    findings: [
      {
        id: randomUUID(),
        commentId,
        path: "src/tags.ts",
        line: 11,
        body: "findUnique then create races",
        category: "bugs",
        confidence: "high",
        anchorAdjusted: false,
      },
    ],
  });

const mergedFiles = [{ path: "src/tags.ts", patch: APPROVED_DIFF.slice(APPROVED_DIFF.indexOf("@@ ")) }];
const comments = [
  { id: 7, author: "delegate-bot", body: "finding" },
  { id: 8, inReplyToId: 7, author: "dev", body: "findUnique is guarded by a unique index" },
];

test("a finding replied to with its line unchanged at merge is a refuted candidate", () => {
  const found = refutedCandidate(mined(blocked(7)), mergedFiles, comments, "mergesha");
  assert.deepEqual(found?.replies, ["findUnique is guarded by a unique index"]);
  assert.equal(found?.mergedSha, "mergesha");
  assert.deepEqual(found?.findings, [{ path: "src/tags.ts", line: 11, body: "findUnique then create races" }]);
});

test("a finding whose line changed before merge is excluded", () => {
  const changed = [{ path: "src/tags.ts", patch: "@@ -10,3 +10,3 @@\n   const name = input.name\n+  await db.tag.upsert({ where: { name } })\n   return name" }];
  assert.equal(refutedCandidate(mined(blocked(7)), changed, comments, "mergesha"), null);
});

test("a finding with no reply from another author is excluded", () => {
  const selfReply = [comments[0], { id: 8, inReplyToId: 7, author: "delegate-bot", body: "ok" }];
  assert.equal(refutedCandidate(mined(blocked(7)), mergedFiles, selfReply, "mergesha"), null);
});

test("mine reads merge info once per PR and honors --kind", async () => {
  let prMergeCalls = 0;
  const runners: Runners = {
    prMerge: async () => {
      prMergeCalls++;
      return { mergedAt: "2026-10-07T00:00:00.000Z", mergeSha: "mergesha" };
    },
    listCommits: async () => [fixCommit()],
    commitFiles: async () => fixCommit().files,
    prFiles: async () => mergedFiles,
    prComments: async () => comments,
  };
  const approve = mined(makeRecord({ headSha: "h1" }));
  const approveEarlier = mined(makeRecord({ headSha: "h2" }));
  const block = mined(blocked(7), "k-block");

  const all = await mine([approve, approveEarlier, block], runners);
  assert.deepEqual(all.map((c) => c.kind), ["missed", "missed", "refuted"]);
  assert.equal(prMergeCalls, 1);

  const onlyRefuted = await mine([approve, block], runners, { kind: "refuted" });
  assert.deepEqual(onlyRefuted.map((c) => c.kind), ["refuted"]);
});

test("mine skips PRs that never merged", async () => {
  const runners: Runners = {
    prMerge: async () => null,
    listCommits: async () => assert.fail("no commits lookup for an unmerged PR"),
    commitFiles: async () => assert.fail("no commit hydration for an unmerged PR"),
    prFiles: async () => assert.fail("no files lookup for an unmerged PR"),
    prComments: async () => assert.fail("no comments lookup for an unmerged PR"),
  };
  assert.deepEqual(await mine([mined(makeRecord())], runners), []);
});

test("a finding on a context line surfaces when the merged diff left that line alone", () => {
  const record = blocked(7);
  record.findings[0].line = 10;
  const found = refutedCandidate(mined(record), mergedFiles, comments, "mergesha");
  assert.equal(found?.findings[0].line, 10);
});

test("a finding on a context line is excluded when the merged diff removed that line", () => {
  const record = blocked(7);
  record.findings[0].line = 10;
  const changed = [{ path: "src/tags.ts", patch: "@@ -10,3 +10,3 @@\n-  const name = input.name\n+  const name = input.title\n   return name" }];
  assert.equal(refutedCandidate(mined(record), changed, comments, "mergesha"), null);
});

test("each commit is hydrated at most once across overlapping windows", async () => {
  const commit = (sha: string, committedAt: string) => ({ sha, subject: "Fix tag race", isMerge: false, committedAt });
  const listed = [
    commit("c1", "2026-10-08T00:00:00.000Z"),
    commit("c2", "2026-10-12T00:00:00.000Z"),
    commit("c3", "2026-10-30T00:00:00.000Z"),
  ];
  const mergedAtByPr: Record<number, string> = {
    1: "2026-10-07T00:00:00.000Z",
    2: "2026-10-10T00:00:00.000Z",
    3: "2026-10-20T00:00:00.000Z",
  };
  const hydrations: string[] = [];
  let listCalls = 0;
  const runners: Runners = {
    prMerge: async (_repo, pr) => ({ mergedAt: mergedAtByPr[pr], mergeSha: `m${pr}` }),
    listCommits: async () => {
      listCalls++;
      return listed;
    },
    commitFiles: async (_repo, sha) => {
      hydrations.push(sha);
      return fixCommit().files;
    },
    prFiles: async () => [],
    prComments: async () => [],
  };
  const records = [1, 2, 3].map((pr) =>
    mined(makeRecord({ prNumber: pr, bundle: { ...makeRecord().bundle, prNumber: pr } })),
  );

  const found = await mine(records, runners);
  assert.equal(listCalls, 1);
  assert.deepEqual([...hydrations].sort(), ["c1", "c2", "c3"]);
  // PR 1 sees c1 and c2, PR 2 sees c2, PR 3 sees c3 only.
  assert.deepEqual(
    found.map((c) => c.kind === "missed" && `${c.pr}:${c.fixCommit}`).sort(),
    ["1:c1", "1:c2", "2:c2", "3:c3"],
  );
});
