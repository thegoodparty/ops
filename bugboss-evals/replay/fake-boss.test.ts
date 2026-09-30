import assert from "node:assert/strict";
import { test } from "node:test";

import type { IncidentView } from "../../bugboss/types";
import { createFakeBoss, type MergeOutcome } from "./fake-boss";

const VIEW = {
  incident: { id: "7", status: "FIXING", summary: null, rootCause: "a cause", prUrls: [], postmortem: null },
  signals: [],
  evidence: [],
  priorIncident: null,
  absorbed: [],
} as unknown as IncidentView;

const merges = (outcomes: MergeOutcome[]) => {
  const calls: number[] = [];
  return {
    calls,
    merge: async () => {
      calls.push(calls.length);
      return outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    },
  };
};

test("the first thing the resumed agent reads is resumed_after", async () => {
  const boss = createFakeBoss({ view: VIEW, script: [{ on: "any", reply: "hi" }], merge: merges([]).merge });
  const response = await boss.client.getIncident();
  assert.deepEqual(response.directives, [{ type: "resumed_after", seconds: 0 }]);
  assert.equal((response.data as IncidentView).incident.id, "7");
  // Drained by the ToolApi read, as the real API does.
  assert.deepEqual((await boss.client.getIncident()).directives, []);
});

test("a question is answered by a step that approves, merges and replies", async () => {
  const m = merges([{ merged: true, sha: "abc1234", detail: "merged" }]);
  let t = 100;
  const boss = createFakeBoss({
    view: VIEW,
    script: [{ on: "question", approveAndMerge: true, reply: "Merged." }],
    merge: m.merge,
    now: () => t++,
  });
  await boss.client.getIncident();
  await boss.client.tellBoss("question", "CI is green and the review approves. Please merge.");
  const pending = await boss.client.peekDirectives();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].directive.type, "boss_message");
  await boss.client.consumeDirective(pending[0].id);
  assert.deepEqual(await boss.client.peekDirectives(), []);
  const record = boss.record();
  assert.equal(record.merges[0].merged, true);
  assert.equal(record.inbox[0].kind, "question");
});

test("a refused merge is reported honestly, and a later step can retry", async () => {
  const m = merges([
    { merged: false, sha: null, detail: "merge 405: required status checks have not passed" },
    { merged: true, sha: "abc1234", detail: "merged" },
  ]);
  const boss = createFakeBoss({
    view: VIEW,
    script: [
      { on: "any", approveAndMerge: true, reply: "Merged." },
      { on: "any", approveAndMerge: true, reply: "Merged." },
      { on: "any", approveAndMerge: true, reply: "Merged." },
    ],
    merge: m.merge,
  });
  await boss.client.tellBoss("message", "PR is up");
  const first = (await boss.client.peekDirectives()).find((p) => p.directive.type === "boss_message");
  assert.match(JSON.stringify(first), /GitHub refused: merge 405/);
  await boss.client.tellBoss("question", "please merge");
  await boss.client.tellBoss("message", "thanks");
  // Merged on the second step; the third does not merge twice.
  assert.equal(m.calls.length, 2);
});

test("a step keyed on a kind waits for that kind", async () => {
  const boss = createFakeBoss({ view: VIEW, script: [{ on: "question", reply: "yes" }], merge: merges([]).merge });
  await boss.client.tellBoss("message", "fyi");
  assert.equal((await boss.client.peekDirectives()).filter((p) => p.directive.type === "boss_message").length, 0);
  await boss.client.tellBoss("question", "may I?");
  assert.equal((await boss.client.peekDirectives()).filter((p) => p.directive.type === "boss_message").length, 1);
});

test("transitions are recorded with their evidence and the view moves with them", async () => {
  const boss = createFakeBoss({ view: VIEW, script: [{ on: "any" }], merge: merges([]).merge });
  await boss.client.reportResolved({ prUrls: ["u"], evidence: "sum(rate(...)) is 0 since the deploy" });
  await boss.client.reportAnalysis({ postmortem: "PM", usersImpacted: 0, impactQuery: "q" });
  const view = (await boss.client.getIncident()).data as IncidentView;
  assert.equal(view.incident.status, "CLOSED");
  const record = boss.record();
  assert.equal(record.resolved[0].evidence, "sum(rate(...)) is 0 since the deploy");
  assert.equal(record.analysis?.postmortem, "PM");
});

test("wait and question markers behave like the real ones", async () => {
  const boss = createFakeBoss({ view: VIEW, script: [{ on: "any" }], merge: merges([]).merge });
  const first = await boss.client.recordWait("gh pr view");
  const again = await boss.client.recordWait("gh pr view");
  assert.equal(first.startedAt, again.startedAt);
  assert.equal((await boss.client.recordPing()).pings, 1);
  await boss.client.recordPending("q?");
  assert.equal((await boss.client.getPending())?.message, "q?");
  await boss.client.tellBoss("escalation", "help");
  assert.equal((await boss.client.escalationsSince(0)).count, 1);
});
