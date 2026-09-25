import assert from "node:assert/strict";
import { test } from "node:test";

import { resetFallbackRates } from "./health";
import type { IncidentDigest, RawSignal, TriageContext } from "../types";
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

const fakeDb = (
  opts: {
    signalIds?: string[];
    statuses?: Record<string, string>;
    owners?: Record<string, string>;
  } = {},
) => {
  const queries: string[] = [];
  const db: IncidentReader = {
    query: <T>(sql: string, params: unknown[] = []): T[] => {
      queries.push(sql);
      if (/from\s+signal/i.test(sql)) {
        return (opts.signalIds ?? []).map((id) => ({ id })) as unknown as T[];
      }
      if (/select\s+owner/i.test(sql)) {
        const owner = opts.owners?.[String(params[0])];
        return (owner ? [{ owner }] : []) as unknown as T[];
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
    },
    decideCall({
      action: "new_incident",
      reason: "this slug has never produced a real incident",
    }),
  ]);

  const outcome = await runTriage({ model, db, budgetMs: 2000 }, context());

  assert.equal(outcome.decision.action, "new_incident");
  assert.equal(queries.length, 1);
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

// --- owner is a separate axis from status --------------------------------

test("refuses to attach to an incident a human has taken over", async () => {
  const { db } = fakeDb({ owners: { "inc-7": "human" } });
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
    "an open status does not mean an agent is coming back to it",
  );
  assert.match(outcome.decision.reason, /owned by a human/);
  assert.equal(outcome.fellBack, false);
});

test("still attaches when an agent owns the incident", async () => {
  const { db } = fakeDb({ owners: { "inc-7": "agent" } });
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

test("a human-owned RESOLVED incident is still a recurrence, not an owner refusal", async () => {
  const { db } = fakeDb({ owners: { "inc-9": "human" } });
  const { model } = scripted([
    decideCall({ action: "attach", incidentId: "inc-9", reason: "identical to the one we closed" }),
  ]);

  const outcome = await runTriage(
    { model, db, budgetMs: 2000 },
    context({ openIncidents: [digest({ id: "inc-9", status: "RESOLVED" })] }),
  );

  assert.equal(
    outcome.recurrenceOf,
    "inc-9",
    "who owns it must not cost us the evidence that the resolution was wrong",
  );
  assert.match(outcome.decision.reason, /RESOLVED/);
});
