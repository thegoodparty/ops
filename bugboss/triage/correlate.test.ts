import assert from "node:assert/strict";
import { test } from "node:test";

import type { IncidentDigest } from "../types";
import { runCorrelation, type CorrelationRequest } from "./correlate";
import { resetFallbackRates } from "./health";
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

/** An empty merge list is a normal answer, so the alarm is the only tell. */
const capture = async <T>(run: () => Promise<T>) => {
  const alarms: Record<string, unknown>[] = [];
  const original = console.error;
  console.error = (line: unknown) => alarms.push(JSON.parse(String(line)));
  try {
    return { result: await run(), alarms };
  } finally {
    console.error = original;
  }
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

// --- no merges must not be able to mean two different things --------------

test("a model fallback alarms rather than reading as 'compared everything, found nothing'", async () => {
  resetFallbackRates();
  const db = fakeDb(["s1", "s2"]);
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("bedrock threw a 500")),
  };

  const { result, alarms } = await capture(() =>
    runCorrelation(
      { model, db, budgetMs: 1000 },
      request({
        openIncidents: [
          digest({ id: "inc-1", status: "FIXING" }),
          digest({ id: "inc-2" }),
        ],
      }),
    ),
  );

  assert.deepEqual(result.merges, []);
  const [fellBack] = alarms.filter((a) => a.event === "fell_back");
  assert.ok(fellBack, "an empty merge list cannot be the only trace of a dead model");
  assert.equal(fellBack.component, "correlate");
  assert.equal(fellBack.level, "error");
  assert.equal(fellBack.candidates, 1, "the alarm says how many comparisons never happened");
  assert.equal(fellBack.recentCalls, 1);
  assert.equal(fellBack.fallbackRate, 1);
});

test("a failed attached-signal read alarms instead of reporting an empty split", async () => {
  resetFallbackRates();
  const db: IncidentReader = {
    query: () => {
      throw new Error("SQLITE_BUSY: database is locked");
    },
  };
  const { model, requests } = scripted([]);

  const { result, alarms } = await capture(() =>
    runCorrelation(
      { model, db, budgetMs: 1000 },
      request({
        openIncidents: [
          digest({ id: "inc-1", status: "FIXING" }),
          digest({ id: "inc-2" }),
        ],
      }),
    ),
  );

  assert.deepEqual(result, { merges: [], splits: [], fellBack: true });
  assert.equal(requests.length, 0, "there is nothing to correlate against an unread incident");
  const [failed] = alarms.filter((a) => a.event === "split_read_failed");
  assert.ok(failed, "a database failure is a different fault from a model failure");
  assert.equal(failed.level, "error");
  assert.match(String(failed.error), /database is locked/);
});
