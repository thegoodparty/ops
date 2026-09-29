import assert from "node:assert/strict";
import { test } from "node:test";

import { resetFallbackRates } from "./health";
import type { IncidentDigest, RawSignal, TriageContext } from "../types";
import { emptyModelUsage, ModelRequestFailed } from "./model";
import type { ModelClient, ModelReply, ModelRequest } from "./model";
import {
  attachedSignalIds,
  incidentStatus,
  prepareQuery,
  type IncidentReader,
} from "./sql";
import { runTriage } from "./triage";

const KNOWN_CAUSES = JSON.stringify([
  {
    id: "statement-timeout",
    summary: "A Postgres statement timeout during the nightly refresh",
    confirmedBy: "Every matched line carries Code: 57014",
    action: "suppress",
  },
  {
    id: "peerly-degraded",
    summary: "Peerly's API is degraded upstream",
    confirmedBy: "Every matched line carries peerly upstream 503",
    action: "annotate",
  },
]);

const signal = (over: Partial<RawSignal> = {}): RawSignal => ({
  source: "grafana",
  sourceId: "fp-1",
  kind: "alert",
  title: "[PROD] Route errors detected",
  body: "500s on POST /campaigns",
  labels: { alert_slug: "campaigns-route-errors", environment: "prod" },
  reportedBy: null,
  openedAt: 1_758_700_000_000,
  ...over,
});

const digest = (over: Partial<IncidentDigest> = {}): IncidentDigest => ({
  id: "inc-1",
  status: "INVESTIGATING",
  rootCause: null,
  signalTitles: ["[PROD] Route errors detected"],
  ageSeconds: 180,
  ...over,
});

const context = (over: Partial<TriageContext> = {}): TriageContext => ({
  signal: signal(),
  evidence: [],
  openIncidents: [],
  ...over,
});

const decideCall = (input: Record<string, unknown>): ModelReply => ({
  text: "",
  toolCalls: [{ id: "call-1", name: "decide", input }],
  usage: emptyModelUsage(),
});

const scripted = (replies: ModelReply[]) => {
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    complete: (request) => {
      requests.push(request);
      const reply = replies.shift();
      return reply
        ? Promise.resolve(reply)
        : Promise.reject(new Error("fake model: nothing scripted"));
    },
  };
  return { model, requests };
};

/** Matches the recurrence lookup, which is the only read that joins the two. */
const RECURRENCE_SQL = /JOIN incident/i;

/** The row shape `findRecurrenceCandidates` reads, as the fake serves it. */
interface RecurrenceRow {
  incidentId: string;
  status: string;
  rootCause: string | null;
  resolvedEvidence: string | null;
  resolvedAt: number;
  signalTitle: string;
}

const fakeDb = (
  opts: {
    signalIds?: string[];
    statuses?: Record<string, string>;
    recurrence?: RecurrenceRow[];
  } = {},
) => {
  const queries: string[] = [];
  const db: IncidentReader = {
    query: <T>(sql: string, params: unknown[] = []): T[] => {
      queries.push(sql);
      // Ahead of the signal branch: the recurrence read joins signal to
      // incident and would otherwise be answered with bare signal ids.
      if (RECURRENCE_SQL.test(sql)) {
        const rows = opts.recurrence ?? [];
        return (/sourceId = \?/.test(sql) ? rows : []) as unknown as T[];
      }
      if (/from\s+signal/i.test(sql)) {
        return (opts.signalIds ?? []).map((id) => ({ id })) as unknown as T[];
      }
      const status = opts.statuses?.[String(params[0])];
      return (status ? [{ status }] : []) as unknown as T[];
    },
  };
  return { db, queries };
};

/** A dead triage model must be legible as structured stderr, not as an info log. */
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

const broken = (message: string): IncidentReader => ({
  query: () => {
    throw new Error(message);
  },
});

test("falls back to new_incident when the model call fails", async () => {
  const { db } = fakeDb();
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("bedrock threw a 500")),
  };

  const outcome = await runTriage({ model, db, budgetMs: 1000 }, context());

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(outcome.fellBack, true);
  assert.match(outcome.decision.reason, /bedrock threw a 500/);
});

test("falls back to new_incident when the call runs past its budget", async () => {
  const { db } = fakeDb();
  const model: ModelClient = { complete: () => new Promise<ModelReply>(() => {}) };

  const outcome = await runTriage({ model, db, budgetMs: 25 }, context());

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(outcome.fellBack, true);
});

test("retries an invalid answer, then falls back to new_incident", async () => {
  const { db } = fakeDb();
  const invalid = () => decideCall({ action: "attach", reason: "forgot the id" });
  const { model, requests } = scripted([invalid(), invalid(), invalid(), invalid()]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000, maxRounds: 6 },
    context({ openIncidents: [digest()] }),
  );

  assert.ok(requests.length > 1, "the model gets another chance before we give up");
  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(outcome.fellBack, true);
});

test("attaches across FIXING, because the alert keeps firing during review", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({
      action: "attach",
      incidentId: "inc-7",
      reason: "same route, same error, fix still in review",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-7", status: "FIXING" })] }),
  );

  assert.deepEqual(outcome.decision, {
    action: "attach",
    incidentId: "inc-7",
    reason: "same route, same error, fix still in review",
  });
  assert.equal(outcome.recurrenceOf, null);
  assert.equal(outcome.fellBack, false);
});

test("never attaches across RESOLVED; it is a recurrence instead", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({
      action: "attach",
      incidentId: "inc-9",
      reason: "identical to the incident we just closed out",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-9", status: "RESOLVED" })] }),
  );

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(outcome.recurrenceOf, "inc-9");
  assert.equal(outcome.fellBack, false);
  assert.match(outcome.decision.reason, /RESOLVED/);
});

test("a conclusive match outranks the RESOLVED incident the model picked", async () => {
  // The two pointers come from different places: the model names whatever
  // RESOLVED incident it found in the digest, while a conclusive candidate is
  // an exact (source, sourceId) match in the db. This path used to stamp the
  // model's choice inline and drop the fact, sending the agent to the wrong
  // post-mortem.
  const { db } = fakeDb({ recurrence: [priorRow()] });
  const { model } = scripted([
    decideCall({
      action: "attach",
      incidentId: "inc-9",
      reason: "identical to the incident we just closed out",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-9", status: "RESOLVED" })] }),
  );

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(
    outcome.recurrenceOf,
    "41",
    "the exact-key match is a fact about the delivery; the attach target is a judgement",
  );
  assert.match(outcome.decision.reason, /RESOLVED/);
  assert.match(outcome.decision.reason, /recurrence of 41/);
});

test("refuses to attach to an incident that is not open", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({ action: "attach", incidentId: "inc-does-not-exist", reason: "match" }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-1" })] }),
  );

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(outcome.recurrenceOf, null);
});

test("never suppresses something a person reported", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({
      action: "suppress",
      knownCauseId: "statement-timeout",
      reason: "the evidence matches a declared suppress cause",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({
      signal: signal({
        source: "human",
        kind: "bug_report",
        reportedBy: "U123",
        title: "pro upgrades look broken",
        body: "probably the statement-timeout thing again",
        labels: {
          never_suppress: "true",
          annotation_known_causes: KNOWN_CAUSES,
        },
      }),
    }),
  );

  assert.equal(outcome.decision.action, "new_incident");
  assert.match(outcome.decision.reason, /person reported/);
});

test("refuses a suppression naming a cause the alert never declared", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({
      action: "suppress",
      knownCauseId: "invented-cause",
      reason: "seen this before",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({
      signal: signal({
        labels: { alert_slug: "x", annotation_known_causes: KNOWN_CAUSES },
      }),
    }),
  );

  assert.equal(outcome.decision.action, "new_incident");
  assert.match(outcome.decision.reason, /invented-cause/);
});

test("refuses to suppress on a cause declared annotate", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({
      action: "suppress",
      knownCauseId: "peerly-degraded",
      reason: "peerly is down again",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({
      signal: signal({
        labels: { alert_slug: "x", annotation_known_causes: KNOWN_CAUSES },
      }),
      evidence: [
        {
          query: '{service_name="gp-api"} |= "peerly"',
          summary: "9 lines, all peerly upstream 503",
          artifactKey: null,
        },
      ],
    }),
  );

  assert.equal(outcome.decision.action, "new_incident");
  assert.match(outcome.decision.reason, /annotate/);
});

test("suppresses when the pre-fetched evidence names the cause", async () => {
  const { db } = fakeDb();
  const { model } = scripted([
    decideCall({
      action: "suppress",
      knownCauseId: "statement-timeout",
      reason: "every matched line carries Code: 57014",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({
      signal: signal({
        labels: {
          alert_slug: "nightly-refresh-errors",
          annotation_known_causes: KNOWN_CAUSES,
        },
      }),
      evidence: [
        {
          query: '{service_name="gp-api"} |= "57014"',
          summary: "14 lines, all carrying Code: 57014",
          artifactKey: null,
        },
      ],
    }),
  );

  assert.deepEqual(outcome.decision, {
    action: "suppress",
    knownCauseId: "statement-timeout",
    reason: "every matched line carries Code: 57014",
  });
});

test("keeps a recurrence pointer only when it names something already fixed", async () => {
  const { db } = fakeDb({ statuses: { "inc-3": "CLOSED", "inc-4": "INVESTIGATING" } });
  const { model } = scripted([
    decideCall({ action: "new_incident", recurrenceOf: "inc-3", reason: "back again" }),
    decideCall({ action: "new_incident", recurrenceOf: "inc-4", reason: "unrelated" }),
  ]);

  const first = await runTriage({ model, db, budgetMs: 2000 }, context());
  const second = await runTriage({ model, db, budgetMs: 2000 }, context());

  assert.equal(first.recurrenceOf, "inc-3");
  assert.equal(second.recurrenceOf, null);
});

test("can reach the incident database before deciding", async () => {
  const { db, queries } = fakeDb();
  const { model, requests } = scripted([
    {
      text: "",
      toolCalls: [
        {
          id: "q1",
          name: "query_incidents",
          input: {
            sql: "SELECT id, resolvedAt FROM incident WHERE rootCause LIKE '%campaigns%'",
          },
        },
      ],
      usage: emptyModelUsage(),
    },
    decideCall({
      action: "new_incident",
      reason: "this slug has never produced a real incident",
    }),
  ]);

  const outcome = await runTriage({ model, db, budgetMs: 2000 }, context());

  assert.equal(outcome.decision.action, "new_incident");
  // The recurrence lookup is deterministic and runs before the call, so what
  // this test is about is the reads the *model* made: exactly one.
  assert.equal(queries.filter((sql) => !RECURRENCE_SQL.test(sql)).length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1)?.role, "toolResult");
});

test("the database tool takes one read and nothing else", () => {
  assert.deepEqual(prepareQuery("SELECT 1;"), { sql: "SELECT 1" });
  assert.ok("error" in prepareQuery("DELETE FROM incident"));
  assert.ok("error" in prepareQuery("SELECT 1; DROP TABLE incident"));
  assert.ok("error" in prepareQuery("   "));
});

// --- a fallback must be loud, and its rate visible ------------------------

test("a fallback alarms at error level and carries the recent rate", async () => {
  resetFallbackRates();
  const { db } = fakeDb();
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("model id is not available")),
  };

  const { alarms } = await capture(() =>
    runTriage({ model, db, budgetMs: 1000 }, context()),
  );

  const fellBack = alarms.filter((a) => a.event === "fell_back");
  assert.equal(fellBack.length, 1, "a dead model cannot be an info-level log");
  assert.equal(fellBack[0].component, "triage");
  assert.equal(fellBack[0].level, "error");
  assert.equal(fellBack[0].recentFallbacks, 1);
  assert.equal(fellBack[0].recentCalls, 1);
  assert.equal(fellBack[0].fallbackRate, 1);
});

test("a sustained fallback rate alarms as its own event", async () => {
  resetFallbackRates();
  const { db } = fakeDb();
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("ThrottlingException")),
  };

  const { alarms } = await capture(async () => {
    for (let i = 0; i < 10; i++) {
      await runTriage({ model, db, budgetMs: 1000 }, context());
    }
  });

  const sustained = alarms.filter((a) => a.event === "triage_model_unusable");
  assert.equal(sustained.length, 1, "the rate crosses the threshold once, on the tenth call");
  assert.equal(sustained[0].fallbackRate, 1);
  assert.equal(sustained[0].recentCalls, 10);
});

test("a healthy stream keeps the rate low, so one failure stays one event", async () => {
  resetFallbackRates();
  const { db } = fakeDb();
  let calls = 0;
  const model: ModelClient = {
    complete: () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("one transient 500"))
        : Promise.resolve(decideCall({ action: "new_incident", reason: "new" }));
    },
  };

  const { alarms } = await capture(async () => {
    for (let i = 0; i < 12; i++) {
      await runTriage({ model, db, budgetMs: 2000 }, context());
    }
  });

  assert.equal(alarms.filter((a) => a.event === "fell_back").length, 1);
  assert.equal(
    alarms.filter((a) => a.event === "triage_model_unusable").length,
    0,
    "a few percent is normal and must not alarm as a dead model",
  );
});

// --- a failed read is not an answer ---------------------------------------

test("a failed read throws rather than answering 'no such incident'", () => {
  const db = broken("SQLITE_BUSY: database is locked");
  assert.throws(() => incidentStatus(db, "3"), /database is locked/);
  assert.throws(() => attachedSignalIds(db, "3"), /database is locked/);
});

test("a failed status read falls back loudly instead of dropping the recurrence", async () => {
  resetFallbackRates();
  const db = broken("SQLITE_BUSY: database is locked");
  const { model } = scripted([
    decideCall({ action: "new_incident", recurrenceOf: "7", reason: "back again" }),
  ]);

  const { result, alarms } = await capture(() =>
    runTriage({ model, db, budgetMs: 2000 }, context()),
  );

  assert.equal(result.fellBack, true, "a broken database must not read as a clean decision");
  assert.match(result.decision.reason, /database is locked/);
  assert.equal(alarms.filter((a) => a.event === "fell_back").length, 1);
});

// --- the attach decision re-reads the row, it does not trust the digest ---
//
// `openIncidents` is a snapshot taken before the model call, and the call can
// take tens of seconds. Every one of these gives the digest one status and
// the database another, which is the only way to tell which of the two the
// refusals are reading.

test("refuses to attach to an incident that was merged away mid-decision", async () => {
  const { db } = fakeDb({ statuses: { "inc-7": "MERGED" } });
  const { model } = scripted([
    decideCall({
      action: "attach",
      incidentId: "inc-7",
      reason: "same route, same error, still firing",
    }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-7", status: "INVESTIGATING" })] }),
  );

  assert.equal(
    outcome.decision.action,
    "new_incident",
    "the digest still says INVESTIGATING, so an attach here would park a signal on a dead row",
  );
  assert.match(outcome.decision.reason, /inc-7 is MERGED/);
  assert.equal(outcome.fellBack, false);
});

test("still attaches when the row says what the digest said", async () => {
  const { db } = fakeDb({ statuses: { "inc-7": "FIXING" } });
  const { model } = scripted([
    decideCall({ action: "attach", incidentId: "inc-7", reason: "same problem" }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-7", status: "FIXING" })] }),
  );

  assert.deepEqual(outcome.decision, {
    action: "attach",
    incidentId: "inc-7",
    reason: "same problem",
  });
});

test("an incident that resolves mid-decision takes the RESOLVED branch", async () => {
  const { db } = fakeDb({ statuses: { "inc-9": "RESOLVED" } });
  const { model } = scripted([
    decideCall({ action: "attach", incidentId: "inc-9", reason: "identical to the one we closed" }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-9", status: "INVESTIGATING" })] }),
  );

  // Two separate things have to hold for this to work, and they used to be
  // protected by two different mechanisms that both went when `owner` did.
  //
  // First, the refusal. This branch used to sit above a guard refusing any
  // attach to a human-owned incident, and the order was load-bearing: put the
  // owner check first and an incident firing again after resolution stopped
  // being a recurrence at all. The guard is gone, so nothing can pre-empt
  // this branch any more and the ordering it depended on cannot be broken by
  // a future reorder. What replaced the guard is the status re-read above --
  // the digest is a snapshot from before a model call that runs for tens of
  // seconds, so on exactly this path it is the stale copy.
  assert.equal(outcome.decision.action, "new_incident");
  assert.match(outcome.decision.reason, /inc-9 is RESOLVED/);
  // Second, the pointer. `recurrencePointer` preferred that same stale digest,
  // so it answered null precisely when a delivery is a recurrence. Both
  // failures had one symptom -- the signal proving a resolution premature
  // opening a fresh incident with nothing linking it back -- so both are
  // asserted here rather than in two tests that could each pass alone.
  assert.equal(outcome.recurrenceOf, "inc-9");
});

// --- recurrence -----------------------------------------------------------

const RESOLVED_AT = 1_758_700_000_000 - 6 * 86_400_000;

const priorRow = (over: Partial<RecurrenceRow> = {}): RecurrenceRow => ({
  incidentId: "41",
  status: "CLOSED",
  rootCause: "the nightly refresh held a lock past its statement timeout",
  resolvedEvidence: "zero matching lines for 90 minutes after the deploy",
  resolvedAt: RESOLVED_AT,
  signalTitle: "[PROD] Route errors detected",
  ...over,
});

test("an exact-key match inside the window is a recurrence without the model", async () => {
  const { db } = fakeDb({ recurrence: [priorRow()] });
  const { model } = scripted([
    decideCall({ action: "new_incident", reason: "nothing open looks like this" }),
  ]);

  const outcome = await runTriage({ model, db, budgetMs: 2000 }, context());

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(
    outcome.recurrenceOf,
    "41",
    "the same signal reopening resolved ground is a fact, not a judgement",
  );
  assert.equal(outcome.recurrenceChecked, true);
  assert.match(outcome.decision.reason, /recurrence of 41/);
});

test("the candidates reach the prompt, with their root causes", async () => {
  const { db } = fakeDb({ recurrence: [priorRow()] });
  const { model, requests } = scripted([
    decideCall({ action: "new_incident", reason: "opening one" }),
  ]);

  await runTriage({ model, db, budgetMs: 2000 }, context());

  const prompt = (() => {
    const first = requests[0]?.messages[0];
    return first && first.role === "user" ? first.text : "";
  })();
  assert.match(prompt, /RECURRENCE CANDIDATES/);
  assert.match(prompt, /41 \| CLOSED/);
  assert.match(prompt, /statement timeout/);
  assert.match(prompt, /CONCLUSIVE/);
});

test("an exact match older than the window is offered, not asserted", async () => {
  const { db } = fakeDb({
    recurrence: [priorRow({ resolvedAt: 1_758_700_000_000 - 40 * 86_400_000 })],
  });
  const { model, requests } = scripted([
    decideCall({ action: "new_incident", reason: "different shape entirely" }),
  ]);

  const outcome = await runTriage({ model, db, budgetMs: 2000 }, context());

  assert.equal(
    outcome.recurrenceOf,
    null,
    "a fingerprint is stable for the life of the rule, so 40 days on is history",
  );
  assert.doesNotMatch((() => {
    const first = requests[0]?.messages[0];
    return first && first.role === "user" ? first.text : "";
  })(), /CONCLUSIVE/);
});

test("a resolution that landed while the alert was still firing still counts", async () => {
  const { db } = fakeDb({
    recurrence: [priorRow({ resolvedAt: 1_758_700_000_000 + 30_000 })],
  });
  const { model } = scripted([
    decideCall({ action: "new_incident", reason: "still going" }),
  ]);

  const outcome = await runTriage({ model, db, budgetMs: 2000 }, context());

  assert.equal(outcome.recurrenceOf, "41");
});

test("a dead model does not cost us the recurrence pointer", async () => {
  resetFallbackRates();
  const { db } = fakeDb({ recurrence: [priorRow()] });
  const model: ModelClient = {
    complete: () => Promise.reject(new Error("bedrock threw a 500")),
  };

  const { result } = await capture(() =>
    runTriage({ model, db, budgetMs: 1000 }, context()),
  );

  assert.equal(result.fellBack, true);
  assert.equal(
    result.recurrenceOf,
    "41",
    "the pointer is computed before the call and must not depend on it",
  );
});

test("a failed recurrence lookup alarms and never reads as 'not a recurrence'", async () => {
  resetFallbackRates();
  const { model } = scripted([
    decideCall({ action: "new_incident", reason: "opening one" }),
  ]);
  let calls = 0;
  const db: IncidentReader = {
    query: <T>(sql: string): T[] => {
      calls += 1;
      if (RECURRENCE_SQL.test(sql)) throw new Error("SQLITE_BUSY: database is locked");
      return [] as unknown as T[];
    },
  };

  const { result, alarms } = await capture(() =>
    runTriage({ model, db, budgetMs: 2000 }, context()),
  );

  assert.equal(
    alarms.filter((a) => a.event === "recurrence_lookup_failed").length,
    1,
    "a broken lookup must not be indistinguishable from a clean 'nothing matched'",
  );
  assert.equal(result.recurrenceChecked, false);
  assert.equal(result.decision.action, "new_incident", "the signal is still placed");
  assert.ok(calls > 0);
});

test("an unavailable lookup says so in the prompt instead of showing an empty list", async () => {
  resetFallbackRates();
  const { model, requests } = scripted([
    decideCall({ action: "new_incident", reason: "opening one" }),
  ]);
  const db: IncidentReader = {
    query: <T>(sql: string): T[] => {
      if (RECURRENCE_SQL.test(sql)) throw new Error("SQLITE_BUSY");
      return [] as unknown as T[];
    },
  };

  await capture(() => runTriage({ model, db, budgetMs: 2000 }, context()));

  const prompt = (() => {
    const first = requests[0]?.messages[0];
    return first && first.role === "user" ? first.text : "";
  })();
  assert.match(prompt, /RECURRENCE CANDIDATES UNAVAILABLE/);
  assert.doesNotMatch(prompt, /no incident in the last 90 days/);
});

test("suppressing a recurrence is allowed but never quiet", async () => {
  resetFallbackRates();
  const { db } = fakeDb({ recurrence: [priorRow()] });
  const { model } = scripted([
    decideCall({
      action: "suppress",
      knownCauseId: "statement-timeout",
      reason: "the evidence matches the declared cause",
    }),
  ]);

  const { result, alarms } = await capture(() =>
    runTriage(
      { model, db, budgetMs: 2000 },
      context({
        signal: signal({ labels: { annotation_known_causes: KNOWN_CAUSES } }),
      }),
    ),
  );

  assert.equal(result.decision.action, "suppress");
  // The two fields are the downstream contract, and they are what tells a
  // suppressed recurrence from a lookup that never ran: checked with no
  // pointer means the registry said suppress, not that we failed to look.
  assert.equal(
    result.recurrenceChecked,
    true,
    "the lookup ran -- the pointer is dropped because the registry says suppress, not because we failed to check",
  );
  assert.equal(
    result.recurrenceOf,
    null,
    "suppress keeps recurrenceOf null: assign has nowhere to store it and the alarm is the record",
  );
  assert.equal(
    alarms.filter((a) => a.event === "recurrence_suppressed").length,
    1,
    "dropping the one delivery that contradicts a resolution is the failure this exists to catch",
  );
});

// ---------------------------------------------------------------------------
// What the decision cost
// ---------------------------------------------------------------------------

/** A reply with real numbers on it, so a zero total cannot pass by default. */
const priced = (
  reply: Omit<ModelReply, "usage">,
  over: Partial<ModelReply["usage"]> = {},
): ModelReply => ({
  ...reply,
  usage: {
    ...emptyModelUsage(),
    tokensIn: 900,
    tokensOut: 120,
    costUsd: 0.004,
    modelId: "us.anthropic.claude-sonnet-5",
    calls: 1,
    ...over,
  },
});

test("a decision carries what it spent", async () => {
  resetFallbackRates();
  const { model } = scripted([
    priced(decideCall({ action: "new_incident", reason: "nothing matches" })),
  ]);

  const outcome = await runTriage({ model, db: fakeDb().db }, context());

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(outcome.usage.tokensIn, 900);
  assert.equal(outcome.usage.tokensOut, 120);
  assert.equal(outcome.usage.calls, 1);
  assert.equal(outcome.usage.modelId, "us.anthropic.claude-sonnet-5");
});

test("a decision that took several rounds carries all of them", async () => {
  resetFallbackRates();
  const { model } = scripted([
    priced({ text: "", toolCalls: [{ id: "q", name: "query_incidents", input: { sql: "select 1" } }] }),
    priced(decideCall({ action: "new_incident", reason: "nothing matches" })),
  ]);

  const outcome = await runTriage({ model, db: fakeDb().db }, context());

  // Summed, not last-write-wins: a decision that looked things up cost more
  // than one request and the record has to say so.
  assert.equal(outcome.usage.calls, 2);
  assert.equal(outcome.usage.tokensIn, 1800);
});

test("a fallback carries what the dead call spent before it gave up", async () => {
  resetFallbackRates();
  // Prose every round, so the loop exhausts its rounds and triage falls back.
  const { model } = scripted([
    priced({ text: "probably fine", toolCalls: [] }),
    priced({ text: "still probably fine", toolCalls: [] }),
  ]);

  const outcome = await runTriage({ model, db: fakeDb().db, maxRounds: 2 }, context());

  assert.equal(outcome.fellBack, true);
  assert.equal(outcome.decision.action, "new_incident");
  // The whole point. Today's storm ran 67 of these in five minutes and every
  // incident it opened recorded a cost of zero -- not free, uncounted.
  assert.equal(outcome.usage.calls, 2);
  assert.ok(outcome.usage.tokensIn > 0, "a fallback reported no tokens");
  assert.ok(outcome.usage.costUsd > 0, "a fallback reported no cost");
});

test("a decision carries the tokens of a request that died in transport", async () => {
  resetFallbackRates();
  // The shape the rounds-exhausted test does not reach: the first request
  // answers, the second fails at the provider. Its tokens arrive on the
  // throw rather than in a reply, and that is the only path that can bank
  // them -- a throttled storm is exactly when the bill matters most.
  const replies = [
    priced({ text: "", toolCalls: [{ id: "q", name: "query_incidents", input: { sql: "select 1" } }] }),
  ];
  const model: ModelClient = {
    complete: () => {
      const reply = replies.shift();
      if (reply) return Promise.resolve(reply);
      return Promise.reject(
        new ModelRequestFailed("ThrottlingException", {
          ...emptyModelUsage(),
          tokensIn: 700,
          costUsd: 0.003,
          calls: 1,
        }),
      );
    },
  };

  const outcome = await runTriage({ model, db: fakeDb().db }, context());

  assert.equal(outcome.fellBack, true);
  assert.equal(outcome.usage.calls, 2, "the failed request was not counted");
  assert.equal(outcome.usage.tokensIn, 1600);
  assert.ok(outcome.usage.costUsd > 0.006, "the failed request's cost was dropped");
});

// ---------------------------------------------------------------------------
// One SQL guard, the stronger of the two that used to exist
// ---------------------------------------------------------------------------

const refused = (sql: string): string => {
  const result = prepareQuery(sql);
  assert.ok("error" in result, `expected a refusal for: ${sql}`);
  return "error" in result ? result.error : "";
};

const allowed = (sql: string): string => {
  const result = prepareQuery(sql);
  assert.ok("sql" in result, `expected this to be allowed: ${sql}`);
  return "sql" in result ? result.sql : "";
};

test("the guard reads code, not the raw text", () => {
  // The reason the checks run over a stripped copy. Both of these are single
  // legitimate SELECTs, and the old triage guard refused the first outright
  // because it looked for ";" in the raw string. A false refusal on a
  // correct query is worse than it sounds: the model cannot tell it from a
  // real syntax error, so it rewrites a query that was right.
  allowed("SELECT * FROM signal WHERE body LIKE '%;%'");
  allowed("SELECT * FROM signal WHERE title = 'DROP TABLE incident'");
  allowed("SELECT 1 -- ; DROP TABLE incident");
  allowed("SELECT 1 /* DELETE FROM incident */");
});

test("the guard refuses a write however it is spelled", () => {
  // The keyword scan the triage guard did not have at all. Every one of these
  // opens with SELECT or WITH, so an opener check alone passes them.
  for (const sql of [
    "WITH x AS (SELECT 1) DELETE FROM incident",
    "SELECT 1; DROP TABLE incident",
    "WITH x AS (SELECT 1) SELECT * FROM x; PRAGMA journal_mode = delete",
    "SELECT * FROM incident RETURNING id",
    "WITH t AS (UPDATE incident SET status = 'CLOSED' RETURNING id) SELECT * FROM t",
  ]) {
    assert.match(refused(sql), /read-only access|one statement/i);
  }
});

test("EXPLAIN is allowed, because reading a plan is reading", () => {
  // The Slack agent's guard allowed it and triage's did not, for no reason
  // anybody recorded. Unifying on the stricter guard would have taken this
  // away from the surface that had it.
  allowed("EXPLAIN QUERY PLAN SELECT * FROM signal WHERE sourceId = 'fp-1'");
});

test("the guard still answers the cases it always answered", () => {
  assert.deepEqual(prepareQuery("SELECT 1;"), { sql: "SELECT 1" });
  assert.match(refused("DELETE FROM incident"), /read-only access/);
  assert.match(refused("   "), /empty query/);
  // Refusals are returned, never thrown. Both callers hand the string back to
  // the model as a tool result, and a throw would have to be caught at each
  // one to become the same thing.
  assert.doesNotThrow(() => prepareQuery("DROP TABLE incident"));
});

// Moved here with the guard itself, from the copy that used to live in
// slack/agent.ts. Every shape that copy asserted is asserted against the one
// that replaced it: a case dropped during the merge is exactly how the
// weaker of the two guards ended up on the hot path unnoticed.
test("every read the Slack agent's guard accepted is still accepted", () => {
  for (const sql of [
    "SELECT * FROM incident",
    "  select id from signal where explained = 0  ",
    "WITH open AS (SELECT * FROM incident WHERE status='INVESTIGATING') SELECT count(*) FROM open",
    "SELECT name, sql FROM sqlite_master WHERE type='table'",
    "SELECT * FROM incident WHERE rootCause LIKE '%delete the row%'",
    "SELECT 1 -- DROP TABLE incident",
    "SELECT id FROM incident;",
    "EXPLAIN QUERY PLAN SELECT * FROM signal WHERE incidentId = 'x'",
  ]) {
    allowed(sql);
  }
});

test("every write the Slack agent's guard rejected is still rejected", () => {
  for (const sql of [
    "DELETE FROM incident",
    "UPDATE incident SET status='CLOSED'",
    "INSERT INTO incident (id) VALUES ('x')",
    "DROP TABLE incident",
    "SELECT 1; DROP TABLE incident",
    "SELECT 1;DELETE FROM signal",
    "PRAGMA journal_mode = DELETE",
    "ATTACH DATABASE '/tmp/evil.db' AS evil",
    "VACUUM INTO '/tmp/copy.db'",
    "DELETE FROM incident RETURNING id",
    "WITH x AS (DELETE FROM signal RETURNING id) SELECT * FROM x",
    "",
    "   ",
  ]) {
    refused(sql);
  }
});
