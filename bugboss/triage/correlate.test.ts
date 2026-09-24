import assert from "node:assert/strict";
import { test } from "node:test";

import type { IncidentDigest } from "../types";
import { runCorrelation, type CorrelationRequest } from "./correlate";
import type { ModelClient, ModelReply, ModelRequest } from "./model";
import type { IncidentReader } from "./sql";

const digest = (over: Partial<IncidentDigest> = {}): IncidentDigest => ({
  id: "inc-1",
  status: "INVESTIGATING",
  rootCause: null,
  signalTitles: ["[PROD] Route errors detected"],
  ageSeconds: 300,
  ...over,
});

const request = (over: Partial<CorrelationRequest> = {}): CorrelationRequest => ({
  incidentId: "inc-1",
  rootCause: "The pro upgrade webhook wrote isPro to the wrong column",
  explainedSignalIds: ["s1"],
  openIncidents: [digest({ id: "inc-1", status: "FIXING" })],
  ...over,
});

const proposeCall = (merges: unknown[]): ModelReply => ({
  text: "",
  toolCalls: [{ id: "call-1", name: "propose", input: { merges } }],
});

const scripted = (replies: ModelReply[]) => {
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    complete: (req) => {
      requests.push(req);
      const reply = replies.shift();
      return reply
        ? Promise.resolve(reply)
        : Promise.reject(new Error("fake model: nothing scripted"));
    },
  };
  return { model, requests };
};

const fakeDb = (signalIds: string[] = []) => {
  const db: IncidentReader = {
    query: <T>(sql: string): T[] =>
      (/from\s+signal/i.test(sql)
        ? signalIds.map((id) => ({ id }))
        : []) as unknown as T[],
  };
  return db;
};

test("splits out every attached signal the root cause does not explain", async () => {
  const db = fakeDb(["s1", "s2", "s3"]);
  const { model } = scripted([proposeCall([])]);

  const result = await runCorrelation(
    { model, db, budgetMs: 2000 },
    request({
      explainedSignalIds: ["s1"],
      openIncidents: [
        digest({ id: "inc-1", status: "FIXING" }),
        digest({ id: "inc-2" }),
      ],
    }),
  );

  assert.deepEqual(
    result.splits.map((s) => s.signalIds),
    [["s2"], ["s3"]],
  );
  assert.ok(result.splits.every((s) => s.target === "NEW"));
  assert.equal(result.merges.length, 0);
  assert.equal(result.fellBack, false);
});

test("splits even when the model call fails", async () => {
  const db = fakeDb(["s1", "s2"]);
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("bedrock threw a 500")),
  };

  const result = await runCorrelation(
    { model, db, budgetMs: 1000 },
    request({
      explainedSignalIds: ["s1"],
      openIncidents: [
        digest({ id: "inc-1", status: "FIXING" }),
        digest({ id: "inc-2" }),
      ],
    }),
  );

  assert.deepEqual(
    result.splits.map((s) => s.signalIds),
    [["s2"]],
  );
  assert.equal(result.merges.length, 0);
  assert.equal(result.fellBack, true);
});

test("merges only a confident match on a mergeable incident", async () => {
  const db = fakeDb(["s1"]);
  const { model, requests } = scripted([
    proposeCall([
      { incidentId: "inc-2", confident: true, reason: "same webhook, same column" },
      { incidentId: "inc-2", confident: true, reason: "duplicate of the above" },
      { incidentId: "inc-3", confident: false, reason: "might be the same" },
      { incidentId: "inc-4", confident: true, reason: "looks identical" },
      { incidentId: "inc-1", confident: true, reason: "itself" },
      { incidentId: "inc-99", confident: true, reason: "not a real incident" },
    ]),
  ]);

  const result = await runCorrelation(
    { model, db, budgetMs: 2000 },
    request({
      openIncidents: [
        digest({ id: "inc-1", status: "FIXING" }),
        digest({ id: "inc-2", status: "INVESTIGATING" }),
        digest({ id: "inc-3", status: "FIXING" }),
        digest({ id: "inc-4", status: "RESOLVED" }),
      ],
    }),
  );

  assert.deepEqual(result.merges, [
    { incidentId: "inc-2", into: "inc-1", reason: "same webhook, same column" },
  ]);

  const prompt = requests[0].messages[0];
  assert.equal(prompt.role, "user");
  assert.ok(
    prompt.role === "user" && !prompt.text.includes("inc-4"),
    "a RESOLVED incident is never offered as a merge candidate",
  );
});

test("does not call the model when there is nothing to merge into", async () => {
  const db = fakeDb(["s1"]);
  const { model, requests } = scripted([]);

  const result = await runCorrelation(
    { model, db, budgetMs: 2000 },
    request({ openIncidents: [digest({ id: "inc-1", status: "FIXING" })] }),
  );

  assert.equal(requests.length, 0);
  assert.deepEqual(result, { merges: [], splits: [], fellBack: false });
});
