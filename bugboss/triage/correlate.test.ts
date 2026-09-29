import assert from "node:assert/strict";
import { test } from "node:test";

import type { IncidentDigest } from "../types";
import {
  judgeMerge,
  runCorrelation,
  type CorrelationRequest,
} from "./correlate";
import { resetFallbackRates } from "./health";
import { emptyModelUsage } from "./model";
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
  usage: emptyModelUsage(),
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

// --- which incident survives ----------------------------------------------

/**
 * The line this replaces read `into: req.incidentId`, which made the survivor
 * whichever agent happened to call report_root_cause first. Incident 79 lost
 * a thread with four days of conversation to one opened minutes before; 81
 * merged the right way round the same week, out of the same rule. The
 * direction was a coin toss in both.
 */
test("the older incident survives, even when the newer one found the cause", async () => {
  const db = fakeDb(["s1"]);
  const { model } = scripted([
    proposeCall([
      { incidentId: "79", confident: true, reason: "same webhook, same column" },
    ]),
  ]);

  const result = await runCorrelation(
    { model, db, budgetMs: 2000 },
    request({
      incidentId: "82",
      openIncidents: [
        digest({ id: "82", status: "FIXING" }),
        digest({ id: "79" }),
      ],
    }),
  );

  assert.deepEqual(result.merges, [
    { incidentId: "82", into: "79", reason: "same webhook, same column" },
  ]);
});

test("the whole group elects one survivor rather than flipping pair by pair", async () => {
  const db = fakeDb(["s1"]);
  const { model } = scripted([
    proposeCall([
      { incidentId: "40", confident: true, reason: "same cause as 40" },
      { incidentId: "55", confident: true, reason: "same cause as 55" },
    ]),
  ]);

  const result = await runCorrelation(
    { model, db, budgetMs: 2000 },
    request({
      incidentId: "82",
      openIncidents: [
        digest({ id: "82", status: "FIXING" }),
        digest({ id: "40" }),
        digest({ id: "55" }),
      ],
    }),
  );

  // Flipped per pair this would send 82 into 40 and 55 into 82, and applyMerge
  // declines the second because 82 is MERGED by then -- two thirds of one bug
  // left open with an agent on each.
  assert.deepEqual(
    result.merges.map((m) => m.into),
    ["40", "40"],
    "everything lands on the most established incident in the group",
  );
  assert.deepEqual(
    result.merges.map((m) => m.incidentId).sort(),
    ["55", "82"],
  );
});

test("a candidate the model was unsure about does not get a vote on the survivor", async () => {
  const db = fakeDb(["s1"]);
  const { model } = scripted([
    proposeCall([
      { incidentId: "40", confident: false, reason: "might be the same" },
      { incidentId: "90", confident: true, reason: "definitely the same" },
    ]),
  ]);

  const result = await runCorrelation(
    { model, db, budgetMs: 2000 },
    request({
      incidentId: "82",
      openIncidents: [
        digest({ id: "82", status: "FIXING" }),
        digest({ id: "40" }),
        digest({ id: "90" }),
      ],
    }),
  );

  assert.deepEqual(result.merges, [
    { incidentId: "90", into: "82", reason: "definitely the same" },
  ]);
});

// --- an agent asking, rather than a root cause triggering ------------------

/**
 * The same judgement from the other direction. An agent that has read
 * another incident and thinks it is the same bug gets to say so; what it
 * does not get is the decision, or the direction.
 */
test("an agreed proposal comes back pointed at the established incident", async () => {
  const { model } = scripted([
    proposeCall([{ incidentId: "79", confident: true, reason: "same pool" }]),
  ]);

  const { merge, fellBack } = await judgeMerge(
    { model, db: fakeDb(["s1"]), budgetMs: 2000 },
    {
      incidentId: "82",
      withIncidentId: "79",
      reason: "both exhaust the same connection pool",
      openIncidents: [
        digest({ id: "82", status: "FIXING" }),
        digest({ id: "79" }),
      ],
    },
  );

  assert.equal(fellBack, false);
  // The agent asked from 82 and 82 is the one absorbed. Which record
  // survives is not the asker's to pick and not the model's either.
  assert.deepEqual(merge, { incidentId: "82", into: "79", reason: "same pool" });
});

test("an unconfident answer is no merge, and is not a failure", async () => {
  const { model } = scripted([
    proposeCall([{ incidentId: "79", confident: false, reason: "maybe" }]),
  ]);

  const { merge, fellBack } = await judgeMerge(
    { model, db: fakeDb(["s1"]), budgetMs: 2000 },
    {
      incidentId: "82",
      withIncidentId: "79",
      reason: "both are 500s",
      openIncidents: [
        digest({ id: "82", status: "FIXING" }),
        digest({ id: "79" }),
      ],
    },
  );

  assert.equal(merge, null);
  assert.equal(
    fellBack,
    false,
    "a considered no is not the same answer as nothing having compared them",
  );
});

test("a dead model says so, rather than passing for a considered no", async () => {
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("bedrock is down")),
  };

  const { result, alarms } = await capture(() =>
    judgeMerge(
      { model, db: fakeDb(["s1"]), budgetMs: 2000 },
      {
        incidentId: "82",
        withIncidentId: "79",
        reason: "both exhaust the same connection pool",
        openIncidents: [
          digest({ id: "82", status: "FIXING" }),
          digest({ id: "79" }),
        ],
      },
    ),
  );

  assert.equal(result.merge, null);
  // The agent is going to repeat one of two sentences into a Slack thread,
  // and they point at different next moves: stop asking, or ask a person.
  assert.equal(result.fellBack, true);
  assert.ok(alarms.some((a) => a.event === "merge_request_unjudged"));
});

test("an incident that is not open is not put in front of the model at all", async () => {
  const { model, requests } = scripted([]);

  const { merge, fellBack } = await judgeMerge(
    { model, db: fakeDb(["s1"]), budgetMs: 2000 },
    {
      incidentId: "82",
      withIncidentId: "79",
      reason: "the same pool",
      openIncidents: [
        digest({ id: "82", status: "FIXING" }),
        digest({ id: "79", status: "CLOSED" }),
      ],
    },
  );

  assert.equal(merge, null);
  assert.equal(fellBack, false);
  assert.equal(requests.length, 0, "and nothing was spent finding that out");
});
