import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecisions, collectDisputes, threadReplies } from "./reconsider";
import type { ThreadComment } from "./github";
import type { PostedFinding, ReviewRecord } from "./schema";

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";

const finding = (id: string, threadId?: string): PostedFinding => ({
  id,
  path: "src/a.ts",
  line: 3,
  body: "retry can loop",
  category: "bugs",
  confidence: "high",
  anchorAdjusted: false,
  commentId: 100,
  threadId,
});

const record = (findings: PostedFinding[]): ReviewRecord =>
  ({ headSha: "abc", findings, droppedFindings: [] }) as unknown as ReviewRecord;

const reply = (overrides: Partial<ThreadComment>): ThreadComment => ({
  databaseId: 1,
  body: "reply",
  createdAt: "2026-10-12T10:00:00Z",
  authorAssociation: "MEMBER",
  byViewer: false,
  authorLogin: "dev",
  authorIsUser: true,
  ...overrides,
});

test("threadReplies keeps the bot's own replies and trusted humans, nobody else", () => {
  const out = threadReplies([
    reply({ body: "member" }),
    reply({ body: "collaborator", authorAssociation: "COLLABORATOR" }),
    reply({ body: "outsider", authorAssociation: "NONE" }),
    reply({ body: "contributor", authorAssociation: "CONTRIBUTOR" }),
    reply({ body: "other bot", authorIsUser: false, authorAssociation: "MEMBER" }),
    reply({ body: "us", byViewer: true, authorIsUser: false, authorAssociation: "NONE" }),
  ]);
  assert.deepEqual(
    out.map((r) => [r.role, r.body]),
    [
      ["human", "member"],
      ["human", "collaborator"],
      ["reviewer", "us"],
    ],
  );
});

test("a finding is disputed only when a trusted human spoke after the bot last did", () => {
  const rec = record([finding(F1, "t1"), finding(F2, "t2")]);
  const threads = [
    { id: "t1", replies: [reply({ body: "evidence" })] },
    { id: "t2", replies: [reply({ body: "old" }), reply({ body: "Still blocking", byViewer: true, authorIsUser: false })] },
  ];
  const disputes = collectDisputes(rec, threads);
  assert.deepEqual(disputes.map((d) => d.finding.id), [F1]);
  assert.equal(disputes[0].finding.headSha, "abc");

  threads[1].replies.push(reply({ body: "new evidence" }));
  assert.deepEqual(collectDisputes(rec, threads).map((d) => d.finding.id), [F1, F2]);
});

test("an outsider's reply does not open a dispute", () => {
  const rec = record([finding(F1, "t1")]);
  const threads = [{ id: "t1", replies: [reply({ authorAssociation: "NONE" })] }];
  assert.deepEqual(collectDisputes(rec, threads), []);
});

test("a finding with no thread cannot be disputed", () => {
  assert.deepEqual(collectDisputes(record([finding(F1)]), []), []);
});

const disputesFor = (rec: ReviewRecord, ids: string[]) =>
  collectDisputes(
    rec,
    ids.map((id) => ({ id: `t-${id}`, replies: [reply({})] })),
  );

test("applyDecisions splits withdrawn from open and keeps undisputed findings open", () => {
  const rec = record([finding(F1, `t-${F1}`), finding(F2, `t-${F2}`)]);
  const applied = applyDecisions(rec, disputesFor(rec, [F1]), {
    status: "complete",
    decisions: [{ findingId: F1, decision: "withdraw", reason: "the test run covers it" }],
    summary: "s",
  });
  assert.ok(!("error" in applied));
  assert.deepEqual(applied.withdrawn.map((w) => [w.finding.id, w.reason]), [[F1, "the test run covers it"]]);
  assert.deepEqual(applied.maintained.map((m) => m.finding.id), [F2]);
});

test("applyDecisions fails on an id it was not asked about", () => {
  const rec = record([finding(F1, `t-${F1}`), finding(F2, `t-${F2}`)]);
  const applied = applyDecisions(rec, disputesFor(rec, [F1]), {
    status: "complete",
    decisions: [
      { findingId: F1, decision: "maintain", reason: "r" },
      { findingId: F2, decision: "withdraw", reason: "r" },
    ],
    summary: "s",
  });
  assert.ok("error" in applied);
  assert.match(applied.error, /not asked about/);
});

test("applyDecisions fails on a missing or duplicated decision", () => {
  const rec = record([finding(F1, `t-${F1}`), finding(F2, `t-${F2}`)]);
  const disputes = disputesFor(rec, [F1, F2]);
  const missing = applyDecisions(rec, disputes, {
    status: "complete",
    decisions: [{ findingId: F1, decision: "withdraw", reason: "r" }],
    summary: "s",
  });
  assert.ok("error" in missing);
  assert.match(missing.error, /no decision/);

  const dup = applyDecisions(rec, disputes, {
    status: "complete",
    decisions: [
      { findingId: F1, decision: "withdraw", reason: "r" },
      { findingId: F1, decision: "maintain", reason: "r" },
      { findingId: F2, decision: "withdraw", reason: "r" },
    ],
    summary: "s",
  });
  assert.ok("error" in dup);
  assert.match(dup.error, /more than one/);
});
