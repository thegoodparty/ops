// The loopback routes that are not ToolApi: the Boss's inbox, the
// outstanding-question marker, the wait marker monitor keeps while it is
// blocked on a person, and the non-draining directive read message_boss
// polls.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import Database from "better-sqlite3";

import { unseenByBoss } from "../boss/inbox";
import { Db } from "../db";
import { createMemoryS3 } from "../index";
import { mintAgentToken } from "../toolapi";
import type { BossInboxItem, Directive, ToolApi } from "../types";
import { createToolApiRoutes } from "./toolapi";

const SECRET = "test-secret";
const INCIDENT = "inc-7";
const OTHER = "inc-8";

let dir: string;
let db: Db;
let app: ReturnType<typeof createToolApiRoutes>;
let clock = 1_000_000;
let reached = 0;
let dbPath: string;
const wakes: { incidentId: string; unseen: BossInboxItem[] }[] = [];
const escalationsNoted: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-http-"));
  dbPath = join(dir, "test.db");
  db = await Db.open({
    path: dbPath,
    bucket: "bugboss-test",
    key: "db/test.db",
    s3: createMemoryS3(),
  });
  await db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', ?)",
    ).run(INCIDENT, clock);
    w.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', ?)",
    ).run(OTHER, clock);
  });

  app = createToolApiRoutes({
    db,
    tokenSecret: SECRET,
    toolApiFor: () => {
      reached += 1;
      return {
        reportRootCause: async (args: unknown) => ({ ok: true, data: args, directives: [] }),
      } as unknown as ToolApi;
    },
    wakeBoss: (incidentId) => {
      const reader = new Database(dbPath, { readonly: true });
      try {
        wakes.push({ incidentId, unseen: unseenByBoss(reader, incidentId) });
      } finally {
        reader.close();
      }
    },
    noteEscalated: (incidentId) => {
      escalationsNoted.push(incidentId);
    },
    now: () => clock,
  });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const authed = (path: string, init: RequestInit = {}) =>
  app.request(`/incidents/${INCIDENT}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: INCIDENT, attempt: 1 }, 3600)}`,
      ...(init.headers ?? {}),
    },
  });

const ask = (message: string) =>
  authed("/pending-question", { method: "POST", body: JSON.stringify({ message }) });

test("a replayed question keeps its watermark, a different one gets a new one", async () => {
  clock = 1_000_000;
  const first = (await (await ask("Can someone merge the PR?")).json()) as {
    message: string;
    askedAt: number;
  };
  assert.equal(first.askedAt, 1_000_000);

  clock = 2_000_000;
  const replayed = (await (await ask("Can someone merge the PR?")).json()) as {
    askedAt: number;
  };
  assert.equal(replayed.askedAt, 1_000_000, "a replay resumes the original wait");

  // A SIGKILL mid-wait leaves the marker behind. The next, different question
  // has to replace it, or it is never posted and the agent waits out its whole
  // timeout on an answer to something nobody was asked.
  clock = 3_000_000;
  const different = (await (await ask("Should I roll back the deploy?")).json()) as {
    message: string;
    askedAt: number;
  };
  assert.equal(different.message, "Should I roll back the deploy?");
  assert.equal(different.askedAt, 3_000_000);
  assert.deepEqual(Object.keys(different).sort(), ["askedAt", "message"]);

  const read = (await (await authed("/pending-question")).json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(read, {
    message: "Should I roll back the deploy?",
    askedAt: 3_000_000,
  });

  await authed("/pending-question", { method: "DELETE" });
});

test("the poll reads pending directives without draining them", async () => {
  await db.withWrite((w) => {
    for (const payload of [
      { type: "resumed_after", seconds: 420 },
      { type: "merged", into: "inc-9" },
    ]) {
      w.prepare(
        "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
      ).run(INCIDENT, JSON.stringify(payload), clock);
    }
  });

  const read = async () =>
    (await (await authed("/directives")).json()) as {
      id: number;
      directive: Directive;
    }[];

  const first = await read();
  assert.deepEqual(
    first.map((entry) => entry.directive),
    [
      { type: "resumed_after", seconds: 420 },
      { type: "merged", into: "inc-9" },
    ],
  );
  assert.deepEqual(
    (await read()).map((entry) => entry.directive),
    [
      { type: "resumed_after", seconds: 420 },
      { type: "merged", into: "inc-9" },
    ],
    "a second poll sees the same directives; the drain belongs to get_incident",
  );
  assert.equal(
    db.query("SELECT id FROM pending_directive WHERE incidentId = ?", [INCIDENT]).length,
    2,
  );

  // The wait consumes only the one directive it answered.
  const gone = await authed(`/directives/${first[1].id}`, { method: "DELETE" });
  assert.equal(gone.status, 204);
  assert.deepEqual(
    (await read()).map((entry) => entry.directive),
    [{ type: "resumed_after", seconds: 420 }],
  );
});

test("a directive cannot be consumed out of another incident's queue", async () => {
  const [remaining] = db.query<{ id: number }>(
    "SELECT id FROM pending_directive WHERE incidentId = ?",
    [INCIDENT],
  );

  const crossed = await app.request(`/incidents/inc-other/directives/${remaining.id}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: INCIDENT, attempt: 1 }, 3600)}`,
    },
  });
  assert.equal(crossed.status, 403);
  assert.equal(
    db.query("SELECT id FROM pending_directive WHERE incidentId = ?", [INCIDENT]).length,
    1,
  );

  const garbage = await authed("/directives/not-a-number", { method: "DELETE" });
  assert.equal(garbage.status, 400);
});

test("the directive read is scoped by the token like every other route", async () => {
  const anonymous = await app.request(`/incidents/${INCIDENT}/directives`);
  assert.equal(anonymous.status, 401);

  const crossed = await app.request("/incidents/inc-other/directives", {
    headers: {
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: INCIDENT, attempt: 1 }, 3600)}`,
    },
  });
  assert.equal(crossed.status, 403);
});

const tokenFor = (incidentId: string) =>
  `Bearer ${mintAgentToken(SECRET, { incidentId, attempt: 1 }, 3600)}`;

const sendToBoss = (body: unknown, incidentId = INCIDENT) =>
  app.request(`/incidents/${incidentId}/boss-inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: tokenFor(incidentId),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const inboxOf = (incidentId: string) =>
  db.query<BossInboxItem>(
    "SELECT id, incidentId, kind, text, createdAt, seenAt FROM boss_inbox WHERE incidentId = ? ORDER BY id",
    [incidentId],
  );

const clearInbox = () =>
  db.withWrite((w) => {
    w.prepare("DELETE FROM boss_inbox").run();
  });

test("the Boss is woken only once the row it is woken for is committed", async () => {
  await clearInbox();
  wakes.length = 0;

  const res = await sendToBoss({ kind: "question", text: "Can someone merge the PR?" });
  assert.equal(res.status, 200);
  const { id } = (await res.json()) as { id: number };

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].incidentId, INCIDENT);
  assert.deepEqual(
    wakes[0].unseen.map((row) => ({ id: row.id, kind: row.kind, text: row.text })),
    [{ id, kind: "question", text: "Can someone merge the PR?" }],
    "a separate connection already sees the row when the wake fires",
  );
  assert.equal(wakes[0].unseen[0].seenAt, null);
});

test("the agent's own escalation brief tells the dispatcher, and nothing else sent up does", async () => {
  await clearInbox();
  escalationsNoted.length = 0;

  for (const kind of ["message", "question"]) {
    assert.equal((await sendToBoss({ kind, text: `a ${kind}`, ownBrief: true })).status, 200);
  }
  assert.equal(
    (await sendToBoss({ kind: "escalation", text: "still waiting on a person, 2h" })).status,
    200,
  );
  assert.deepEqual(
    escalationsNoted,
    [],
    "the premise: a message, a question and a harness rung are not the agent's brief",
  );

  assert.equal(
    (await sendToBoss({ kind: "escalation", text: "needs a person", ownBrief: true })).status,
    200,
  );
  assert.deepEqual(escalationsNoted, [INCIDENT]);
});

test("text reaches the inbox whole, with no length limit", async () => {
  await clearInbox();
  wakes.length = 0;
  const long = Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n");
  assert.ok(long.length > 4_000, "the premise: longer than any Slack budget");

  const res = await sendToBoss({ kind: "message", text: long });
  assert.equal(res.status, 200);
  assert.equal(inboxOf(INCIDENT)[0].text, long);
});

test("a rejected body writes nothing and wakes nobody", async () => {
  await clearInbox();
  wakes.length = 0;

  for (const [body, why] of [
    [{ kind: "shout", text: "hello" }, "a kind the Boss does not know"],
    [{ kind: "message", text: "" }, "empty text"],
    [{ kind: "message", text: "   \n " }, "whitespace-only text"],
    [{ kind: "message" }, "missing text"],
    ["not json", "a body that is not JSON"],
  ] as const) {
    const res = await sendToBoss(body);
    assert.equal(res.status, 400, why);
    assert.ok(((await res.json()) as { error: string }).error, why);
  }

  assert.equal(inboxOf(INCIDENT).length, 0);
  assert.equal(wakes.length, 0);
});

test("an unknown incident is a 404, not a row the Boss can never act on", async () => {
  wakes.length = 0;
  const res = await sendToBoss({ kind: "message", text: "hello" }, "inc-missing");
  assert.equal(res.status, 404);
  assert.equal(inboxOf("inc-missing").length, 0);
  assert.equal(wakes.length, 0);
});

test("a token for one incident cannot write to another's inbox", async () => {
  await clearInbox();
  wakes.length = 0;
  assert.ok(
    db.get("SELECT id FROM incident WHERE id = ?", [OTHER]),
    "the premise: the target incident exists, so only the token stops the write",
  );

  const crossed = await app.request(`/incidents/${OTHER}/boss-inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: tokenFor(INCIDENT),
    },
    body: JSON.stringify({ kind: "escalation", text: "wake up" }),
  });
  assert.equal(crossed.status, 403);

  const anonymous = await app.request(`/incidents/${INCIDENT}/boss-inbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "message", text: "hello" }),
  });
  assert.equal(anonymous.status, 401);

  assert.equal(inboxOf(OTHER).length, 0);
  assert.equal(inboxOf(INCIDENT).length, 0);
  assert.equal(wakes.length, 0);
});

test("escalations are counted for this incident only, and only since the moment asked", async () => {
  await clearInbox();
  await db.withWrite((w) => {
    const insert = w.prepare(
      "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES (?, ?, ?, ?)",
    );
    insert.run(INCIDENT, "escalation", "first", 1_000);
    insert.run(INCIDENT, "escalation", "second", 2_000);
    insert.run(INCIDENT, "escalation", "third", 3_000);
    insert.run(INCIDENT, "question", "not an escalation", 5_000);
    insert.run(INCIDENT, "message", "not an escalation", 6_000);
    insert.run(OTHER, "escalation", "someone else's", 7_000);
  });

  const escalations = async (since?: number) =>
    (await (
      await authed(
        since === undefined
          ? "/boss-inbox/escalations"
          : `/boss-inbox/escalations?since=${since}`,
      )
    ).json()) as { count: number; lastAt: number | null };

  assert.deepEqual(await escalations(), { count: 3, lastAt: 3_000 });
  assert.deepEqual(await escalations(0), { count: 3, lastAt: 3_000 });
  assert.deepEqual(
    await escalations(2_000),
    { count: 2, lastAt: 3_000 },
    "since is inclusive",
  );
  assert.deepEqual(await escalations(3_001), { count: 0, lastAt: null });

  const bad = await authed("/boss-inbox/escalations?since=yesterday");
  assert.equal(bad.status, 400);
});

test("an escalation sent through the route is one the count sees", async () => {
  await clearInbox();
  const since = Date.now();
  await sendToBoss({ kind: "escalation", text: "still no answer" });
  await sendToBoss({ kind: "question", text: "is anyone there?" });

  const counted = (await (
    await authed(`/boss-inbox/escalations?since=${since}`)
  ).json()) as { count: number; lastAt: number | null };
  assert.equal(counted.count, 1);
  assert.ok(counted.lastAt !== null && counted.lastAt >= since);
});

test("the escalation count is scoped by the token", async () => {
  const crossed = await app.request(`/incidents/${OTHER}/boss-inbox/escalations`, {
    headers: { authorization: tokenFor(INCIDENT) },
  });
  assert.equal(crossed.status, 403);
});

test("model arguments are validated before they reach a tool", async () => {
  const before = reached;
  const res = await authed("/root-cause", { method: "POST", body: "{}" });

  assert.equal(res.status, 200, "the model reads this as a correctable tool result");
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /cause/);
  assert.match(body.error, /explainedSignalIds/);
  assert.equal(reached, before, "an invalid call never reaches the tool API");
});

test("unknown keys are stripped rather than passed through", async () => {
  const res = await authed("/root-cause", {
    method: "POST",
    body: JSON.stringify({
      cause: "bad column",
      explainedSignalIds: ["s1"],
      incidentId: "inc-other",
    }),
  });

  const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, { cause: "bad column", explainedSignalIds: ["s1"] });
});

const startWait = (command: string, waitingFor = "someone to merge omni#2150") =>
  authed("/pending-wait", { method: "POST", body: JSON.stringify({ command, waitingFor }) });

type WaitRow = {
  command: string;
  startedAt: number;
  pings: number;
  lastPingAt: number | null;
};

test("a replayed wait keeps its clock and its nudge count", async () => {
  clock = 1_000_000;
  const first = (await (await startWait("gh pr view 2150")).json()) as WaitRow;
  assert.deepEqual(first, {
    command: "gh pr view 2150",
    startedAt: 1_000_000,
    pings: 0,
    lastPingAt: null,
  });

  clock = 4_600_000;
  const pinged = (await (
    await authed("/pending-wait/ping", { method: "POST" })
  ).json()) as WaitRow;
  assert.equal(pinged.pings, 1);
  assert.equal(pinged.lastPingAt, 4_600_000);

  // The restart. Without this the elapsed clock would start over and the
  // nudge count would be lost, so the resumed agent would nudge again.
  clock = 5_000_000;
  const replayed = (await (await startWait("gh pr view 2150")).json()) as WaitRow;
  assert.equal(replayed.startedAt, 1_000_000);
  assert.equal(replayed.pings, 1);
  assert.equal(replayed.lastPingAt, 4_600_000);

  // clearWait does not run when the child is SIGKILLed mid-wait, so a marker
  // outlives its wait. A different command is a different wait and inherits
  // neither the clock nor the count.
  clock = 6_000_000;
  const next = (await (await startWait("gh run list --commit abc")).json()) as WaitRow;
  assert.deepEqual(next, {
    command: "gh run list --commit abc",
    startedAt: 6_000_000,
    pings: 0,
    lastPingAt: null,
  });

  await authed("/pending-wait", { method: "DELETE" });
  assert.equal(
    db.get<WaitRow>("SELECT command FROM pending_wait WHERE incidentId = ?", [
      INCIDENT,
    ]),
    undefined,
  );
});

test("a wait keeps the agent's label, and a replay can reword it without restarting the clock", async () => {
  clock = 1_000_000;
  await startWait("gh pr view 2189", "someone to merge omni#2189");
  clock = 2_000_000;
  await startWait("gh pr view 2189", "someone to merge omni#2189 or #2195");
  assert.deepEqual(
    db.get("SELECT waitingFor, startedAt FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    { waitingFor: "someone to merge omni#2189 or #2195", startedAt: 1_000_000 },
  );
  await authed("/pending-wait", { method: "DELETE" });
});

test("a wait replayed from before the label existed is kept, and keeps any label it had", async () => {
  const res = await startWait("gh pr view 2189", "  ");
  assert.equal(res.status, 200, "a replayed wait must resume, so it is not refused");
  assert.deepEqual(
    db.get("SELECT waitingFor FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    { waitingFor: null },
    "no label, which the board renders as the fallback",
  );
  await startWait("gh pr view 2189", "someone to merge omni#2189");
  await startWait("gh pr view 2189", "");
  assert.deepEqual(
    db.get("SELECT waitingFor FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    { waitingFor: "someone to merge omni#2189" },
    "a later unlabelled replay does not erase a label",
  );
  await authed("/pending-wait", { method: "DELETE" });
});

test("counting a nudge against no wait is an error, not a new wait", async () => {
  const res = await authed("/pending-wait/ping", { method: "POST" });
  assert.equal(res.status, 404);
  assert.equal(
    db.get<WaitRow>("SELECT command FROM pending_wait WHERE incidentId = ?", [
      INCIDENT,
    ]),
    undefined,
    "a missing marker is not invented at the moment of the fault",
  );
});

test("the timeline reads back without a drain, and only for the caller's incident", async () => {
  await db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident_timeline_event (incidentId, kind, occurredAt, recordedAt, summary, evidenceUrl)
       VALUES (?, 'first_error', 5, 6, 'first 502', NULL), (?, 'first_error', 5, 6, 'not yours', NULL)`,
    ).run(INCIDENT, OTHER);
    w.prepare("INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)").run(
      INCIDENT,
      JSON.stringify({ type: "stop", reason: "still queued" }),
      clock,
    );
  });

  const events = (await (await authed("/timeline")).json()) as { summary: string }[];

  assert.deepEqual(events.map((event) => event.summary), ["first 502"]);
  const queued = db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_directive WHERE incidentId = ?",
    [INCIDENT],
  )[0].n;
  assert.ok(queued >= 1, "reading the timeline drains nothing");
});

test("a timeline event is validated before it reaches the tool API", async () => {
  const before = reached;
  const bad = await authed("/timeline", {
    method: "POST",
    body: JSON.stringify({ kind: "vibes", occurredAt: 5, summary: "hm" }),
  });
  assert.equal(((await bad.json()) as { ok: boolean }).ok, false);
  assert.equal(reached, before);
});

test("the timeline route takes the harness's goal_verdict kind", async () => {
  const before = reached;
  await authed("/timeline", {
    method: "POST",
    body: JSON.stringify({ kind: "goal_verdict", occurredAt: 5, summary: "root_cause met: shown" }),
  });
  assert.equal(reached, before + 1, "it reached the tool API");
});

// --- request_sql_query: the Boss names the thread and forwards -------------

const SQL_INCIDENT = "41";
const THREADLESS = "43";

interface SidecarCall {
  method: string;
  url: string;
  body: unknown;
}

const sqlApp = async (options: {
  sqlRunnerUrl?: string;
  sidecar?: (call: SidecarCall) => Response | Promise<Response>;
}) => {
  await seedSqlIncidents();
  const calls: SidecarCall[] = [];
  const routes = createToolApiRoutes({
    db,
    tokenSecret: SECRET,
    toolApiFor: () => ({}) as ToolApi,
    wakeBoss: () => {},
    noteEscalated: () => {},
    sqlRunnerUrl: options.sqlRunnerUrl,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      if (!options.sidecar) throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
      return options.sidecar(call);
    }) as typeof fetch,
    now: () => clock,
  });
  const as = (incidentId: string) => async (path: string, init: RequestInit = {}) =>
    routes.request(`/incidents/${incidentId}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintAgentToken(SECRET, { incidentId, attempt: 1 }, 3600)}`,
      },
    });
  return { calls, as };
};

const alarmsDuring = async <T>(run: () => Promise<T>): Promise<{ result: T; alarms: string[] }> => {
  const alarms: string[] = [];
  const real = console.error;
  console.error = (line: string) => alarms.push(line);
  try {
    return { result: await run(), alarms };
  } finally {
    console.error = real;
  }
};

const askSql = (body: unknown = { sql: "select id from campaign", reason: "which campaign" }) => ({
  method: "POST",
  body: JSON.stringify(body),
});

// Inserted on first use rather than in a second `before`, which node:test
// does not order after the one that opens the database.
let sqlIncidents: Promise<void> | null = null;
const seedSqlIncidents = (): Promise<void> =>
  (sqlIncidents ??= db.withWrite((w) => {
    w.prepare(
      "INSERT INTO incident (id, status, firstSignalAt, slackThreadTs) VALUES (?, 'INVESTIGATING', ?, ?)",
    ).run(SQL_INCIDENT, clock, "1727700000.000100");
    w.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', ?)",
    ).run(THREADLESS, clock);
  }));

test("a SQL request goes to the sidecar with the incident's own thread, not one the agent names", async () => {
  const { calls, as } = await sqlApp({
    sqlRunnerUrl: "http://127.0.0.1:8790/",
    sidecar: () => Response.json({ requestId: "4b6f" }, { status: 201 }),
  });

  const res = await as(SQL_INCIDENT)(
    "/sql-requests",
    askSql({ sql: "select 1", reason: "check", threadTs: "1.2", incidentId: 99 }),
  );

  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { requestId: "4b6f" });
  assert.deepEqual(calls, [
    {
      method: "POST",
      url: "http://127.0.0.1:8790/requests",
      body: { incidentId: 41, threadTs: "1727700000.000100", sql: "select 1", reason: "check" },
    },
  ]);
});

test("the sidecar's refusals reach the agent verbatim, status and all", async () => {
  for (const [status, error] of [
    [400, "drop the semicolon"],
    [409, "incident 41 already has a pending request"],
    [503, "rotation group not configured"],
  ] as const) {
    const { as } = await sqlApp({
      sqlRunnerUrl: "http://127.0.0.1:8790",
      sidecar: () => Response.json({ error }, { status }),
    });
    const { result: res, alarms } = await alarmsDuring(() =>
      as(SQL_INCIDENT)("/sql-requests", askSql()),
    );
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error });
    // A refusal the sidecar meant is not a fault; a 5xx is.
    assert.equal(alarms.some((line) => /sql_runner_error/.test(line)), status >= 500);
  }
});

test("a SQL request with nowhere to ask is refused out loud, and the sidecar is never called", async () => {
  const unset = await sqlApp({ sidecar: () => Response.json({ requestId: "x" }, { status: 201 }) });
  const noUrl = await alarmsDuring(() => unset.as(SQL_INCIDENT)("/sql-requests", askSql()));
  assert.equal(noUrl.result.status, 503);
  assert.match(((await noUrl.result.json()) as { error: string }).error, /BUGBOSS_SQL_RUNNER_URL/);
  assert.equal(noUrl.alarms.filter((line) => /sql_runner_unconfigured/.test(line)).length, 1);
  assert.equal(unset.calls.length, 0);

  const threadless = await sqlApp({
    sqlRunnerUrl: "http://127.0.0.1:8790",
    sidecar: () => Response.json({ requestId: "x" }, { status: 201 }),
  });
  const noThread = await alarmsDuring(() => threadless.as(THREADLESS)("/sql-requests", askSql()));
  assert.equal(noThread.result.status, 409);
  assert.match(((await noThread.result.json()) as { error: string }).error, /no Slack thread/);
  assert.equal(noThread.alarms.filter((line) => /sql_request_no_thread/.test(line)).length, 1);
  assert.equal(threadless.calls.length, 0);
});

test("an unreachable sidecar is an error the agent can read and an alarm somebody can", async () => {
  const { as } = await sqlApp({ sqlRunnerUrl: "http://127.0.0.1:8790" });

  const create = await alarmsDuring(() => as(SQL_INCIDENT)("/sql-requests", askSql()));
  assert.equal(create.result.status, 502);
  assert.match(((await create.result.json()) as { error: string }).error, /ECONNREFUSED/);
  assert.equal(create.alarms.filter((line) => /sql_runner_unreachable/.test(line)).length, 1);

  const read = await alarmsDuring(() => as(SQL_INCIDENT)("/sql-requests/4b6f"));
  assert.equal(read.result.status, 502);
  assert.equal(read.alarms.filter((line) => /sql_runner_unreachable/.test(line)).length, 1);
});

test("reading a SQL request proxies the sidecar's answer, a 404 included", async () => {
  const done = {
    requestId: "4b6f",
    status: "done",
    decidedBy: "U01",
    columns: ["id"],
    rows: [{ id: 1 }],
    rowCount: 1,
  };
  const { calls, as } = await sqlApp({
    sqlRunnerUrl: "http://127.0.0.1:8790",
    sidecar: (call) =>
      call.url.endsWith("/requests/4b6f")
        ? Response.json(done)
        : Response.json({ error: "not found" }, { status: 404 }),
  });

  const found = await as(SQL_INCIDENT)("/sql-requests/4b6f");
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), done);

  const lost = await alarmsDuring(() => as(SQL_INCIDENT)("/sql-requests/gone"));
  assert.equal(lost.result.status, 404);
  assert.deepEqual(lost.alarms, [], "a lost request is the sidecar restarting, not a fault");
  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ["GET", "http://127.0.0.1:8790/requests/4b6f"],
      ["GET", "http://127.0.0.1:8790/requests/gone"],
    ],
  );
});

test("a request id cannot move the sidecar path", async () => {
  const { calls, as } = await sqlApp({
    sqlRunnerUrl: "http://127.0.0.1:8790",
    sidecar: () => Response.json({}),
  });
  const res = await as(SQL_INCIDENT)(`/sql-requests/${encodeURIComponent("../health")}`);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("the SQL routes are scoped by the token like every other route", async () => {
  const { calls, as } = await sqlApp({
    sqlRunnerUrl: "http://127.0.0.1:8790",
    sidecar: () => Response.json({ requestId: "x" }, { status: 201 }),
  });
  const res = await app.request(`/incidents/${SQL_INCIDENT}/sql-requests`, {
    ...askSql(),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mintAgentToken(SECRET, { incidentId: THREADLESS, attempt: 1 }, 3600)}`,
    },
  });
  assert.equal(res.status, 403);
  assert.equal((await as(SQL_INCIDENT)("/sql-requests", { method: "POST", body: "nope" })).status, 400);
  assert.equal(calls.length, 0);
});
