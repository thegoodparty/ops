import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Db } from "../db";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Context, ToolExecutionApi } from "./harness";
import {
  SQL_POLL_SECONDS,
  createSidecarSqlPort,
  createSqlQueryTool,
  renderSqlOutcome,
  runSqlQuery,
  type SidecarReply,
  type SqlQueryDeps,
  type SqlRequestPort,
  type SqlRequestView,
} from "./sql";
import { MAX_BLOCK_SECONDS } from "./tools";
import type { WaitOptions, WaitResult } from "./wait";

const json = (status: number, body: unknown): SidecarReply => ({
  status,
  text: JSON.stringify(body),
});

const view = (overrides: Partial<SqlRequestView> = {}): SqlRequestView => ({
  requestId: "req-1",
  status: "pending",
  ...overrides,
});

/** A sidecar that answers each read from a script, then repeats the last. */
const scripted = (options: {
  create?: SidecarReply;
  reads: SidecarReply[];
}): SqlRequestPort & { created: unknown[]; read: string[] } => {
  const created: unknown[] = [];
  const read: string[] = [];
  return {
    created,
    read,
    createSqlRequest: async (args) => {
      created.push(args);
      return options.create ?? json(201, { requestId: "req-1" });
    },
    getSqlRequest: async (requestId) => {
      read.push(requestId);
      return options.reads[Math.min(read.length - 1, options.reads.length - 1)];
    },
  };
};

/**
 * waitUntil's loop on a clock that only moves when it sleeps, so a wait costs
 * no real time. `end` decides what interrupts it, after which check.
 */
const fakeTime = (end: (checks: number) => "inbox" | "aborted" | null = () => null) => {
  let t = 0;
  const slept: number[] = [];
  const wait = async <T>(options: WaitOptions<T>): Promise<WaitResult<T>> => {
    const deadline = t + options.timeoutMs;
    let value: T | undefined;
    for (let checks = 1; ; checks += 1) {
      const state = await options.check();
      value = state.value;
      if (state.done) return { ended: "met", value, steers: [] };
      const ended = end(checks);
      if (ended) return { ended, value, steers: ended === "inbox" ? ["The Boss says: stop"] : [] };
      if (t >= deadline) return { ended: "timeout", value, steers: [] };
      const ms = Math.min(options.intervalMs, deadline - t);
      slept.push(ms);
      t += ms;
    }
  };
  return { slept, now: () => t, wait: wait as SqlQueryDeps["wait"] };
};

const ARGS = { sql: "select id from campaign", reason: "which campaign" };

test("an approved query polls until it runs and comes back whole", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, slug: `campaign-${i}-${"x".repeat(200)}` }));
  const port = scripted({
    reads: [
      json(200, view()),
      json(200, view({ status: "running" })),
      json(200, view({ status: "done", decidedBy: "U07", columns: ["id", "slug"], rows, rowCount: 200 })),
    ],
  });
  const time = fakeTime();

  const outcome = await runSqlQuery(ARGS, { port, ...time });

  assert.deepEqual(port.created, [ARGS]);
  assert.deepEqual(port.read, ["req-1", "req-1", "req-1"]);
  assert.deepEqual(time.slept, [SQL_POLL_SECONDS * 1000, SQL_POLL_SECONDS * 1000]);
  const text = renderSqlOutcome(outcome);
  assert.match(text, /approved by Slack user U07\. 200 rows/);
  // Never cut: every row the database returned is in the result.
  const payload = JSON.parse(text.slice(text.indexOf("{")));
  assert.deepEqual(payload, { columns: ["id", "slug"], rows });
});

test("a refused, expired or failed request says who decided and why", async () => {
  for (const settled of [
    view({ status: "refused", decidedBy: "U09" }),
    view({ status: "expired" }),
    view({ status: "failed", decidedBy: "U07", error: "canceling statement due to statement timeout" }),
  ]) {
    const outcome = await runSqlQuery(ARGS, { port: scripted({ reads: [json(200, settled)] }), ...fakeTime() });
    const text = renderSqlOutcome(outcome);
    assert.match(text, new RegExp(`is ${settled.status}`));
    if (settled.decidedBy) assert.match(text, new RegExp(settled.decidedBy));
    if (settled.error) assert.ok(text.includes(settled.error));
  }
});

test("a requestId resumes the earlier request rather than asking again", async () => {
  const port = scripted({ reads: [json(200, view({ requestId: "req-9", status: "done", rows: [], columns: [] }))] });

  await runSqlQuery({ ...ARGS, requestId: "req-9" }, { port, ...fakeTime() });

  assert.deepEqual(port.created, []);
  assert.deepEqual(port.read, ["req-9"]);
});

test("a wait that reaches the block cap returns pending with the id to call again with", async () => {
  const port = scripted({ reads: [json(200, view())] });
  const time = fakeTime();

  const outcome = await runSqlQuery(ARGS, { port, ...time });

  assert.equal(outcome.kind, "waiting");
  assert.equal(time.now(), MAX_BLOCK_SECONDS * 1000);
  const text = renderSqlOutcome(outcome);
  assert.match(text, /STILL WAITING on request req-1/);
  assert.match(text, /requestId "req-1"/);
  assert.equal(port.created.length, 1, "asked once");
});

test("a lost request says the runner restarted and to ask again", async () => {
  const outcome = await runSqlQuery(ARGS, {
    port: scripted({ reads: [json(200, view()), json(404, { error: "not found" })] }),
    ...fakeTime(),
  });
  assert.deepEqual(outcome, { kind: "lost", requestId: "req-1" });
  assert.match(renderSqlOutcome(outcome), /was lost \(the SQL runner restarted\)\. Ask again\./);
});

test("a refused create comes back in the sidecar's words, and nothing is polled", async () => {
  const port = scripted({
    create: json(409, { error: "incident 41 already has a pending request" }),
    reads: [json(200, view())],
  });

  const outcome = await runSqlQuery(ARGS, { port, ...fakeTime() });

  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(port.read, []);
  const text = renderSqlOutcome(outcome);
  assert.match(text, /HTTP 409/);
  assert.ok(text.includes('{"error":"incident 41 already has a pending request"}'));
  assert.match(text, /call again with its requestId/);
});

test("a read the Boss cannot answer ends the wait with what it said", async () => {
  const outcome = await runSqlQuery(ARGS, {
    port: scripted({ reads: [json(502, { error: "the SQL runner could not be reached: ECONNREFUSED" })] }),
    ...fakeTime(),
  });
  assert.equal(outcome.kind, "unreadable");
  const text = renderSqlOutcome(outcome);
  assert.match(text, /HTTP 502/);
  assert.match(text, /ECONNREFUSED/);
});

test("a message queued for the agent ends the wait, with the id to resume it", async () => {
  const outcome = await runSqlQuery(ARGS, {
    port: scripted({ reads: [json(200, view())] }),
    ...fakeTime((checks) => (checks === 2 ? "inbox" : null)),
  });
  assert.deepEqual(outcome, { kind: "waiting", requestId: "req-1", status: "pending", endedBy: "interrupt" });
  const text = renderSqlOutcome(outcome);
  assert.match(text, /STOPPED WAITING on request req-1, still pending \(interrupted\)/);
  assert.match(text, /requestId "req-1"/);
});

test("the conversation's abort ends the wait and says so", async () => {
  const outcome = await runSqlQuery(ARGS, {
    port: scripted({ reads: [json(200, view())] }),
    ...fakeTime(() => "aborted"),
  });
  assert.deepEqual(outcome, { kind: "waiting", requestId: "req-1", status: "pending", endedBy: "deadline" });
});

/**
 * Enough of a tool call for the real waitUntil: an inbox watch the test can
 * push a steer through, and memos that outlive one call the way Pi Durable's
 * outlive a crash.
 */
const fakeCall = (memos = new Map<string, unknown>()) => {
  let deliver: ((value: unknown) => Promise<void>) | null = null;
  let watching: () => void = () => {};
  const watched = new Promise<void>((resolve) => {
    watching = resolve;
  });
  const api = {
    conversationId: 1,
    watchDoc: async () => ({
      value: { items: [] },
      start: (listener: (value: unknown) => Promise<void>) => {
        deliver = listener;
        watching();
      },
      stop: async () => {},
    }),
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  } as unknown as ToolExecutionApi;
  const steer = (text: string) => deliver?.({ items: [{ id: 1, mode: "steer", content: text }] });
  return { api, memos, steer, watched };
};

const CTX = {} as Context;

test("a steer cuts the real wait short, and the request is remembered for a rerun", async () => {
  const port = scripted({ reads: [json(200, view())] });
  const tool = await createSqlQueryTool({ portFor: async () => port, pollSeconds: 60 });
  const call = fakeCall();

  const started = Date.now();
  const pending = tool.execute(ARGS as never, call.api, CTX);
  // Pi loads on the first wait, so the steer goes once the inbox is watched.
  void call.watched.then(() => setTimeout(() => void call.steer("The Boss says: hold on"), 20));
  const result = await pending;

  assert.ok(Date.now() - started < 5000, "the steer cut the sleep short");
  const text = (result.content?.[0] as { text: string }).text;
  assert.match(text, /STOPPED WAITING on request req-1, still pending \(interrupted\)/);
  assert.equal(call.memos.get("sent"), "req-1");
});

test("a rerun after a crash resumes the request it made instead of asking twice", async () => {
  const port = scripted({ reads: [json(200, view({ status: "done", columns: [], rows: [] }))] });
  const tool = await createSqlQueryTool({ portFor: async () => port, pollSeconds: 1 });
  const call = fakeCall(new Map([["sent", "req-1"]]));

  const result = await tool.execute(ARGS as never, call.api, CTX);

  assert.deepEqual(port.created, [], "the premise of replay safety: nothing is posted again");
  assert.deepEqual(port.read, ["req-1"]);
  assert.match((result.content?.[0] as { text: string }).text, /Request req-1 ran/);
  assert.equal(tool.replay, "safe");
});

// ---------------------------------------------------------------------------
// The Boss's side: the thread lookup and the forward to the sidecar
// ---------------------------------------------------------------------------

const SQL_INCIDENT = "41";
const THREADLESS = "43";

interface SidecarCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Enough S3 for Db: nothing to restore, and every snapshot PUT succeeds. Not
 * the composition root's createMemoryS3, so this file does not load the whole
 * Boss to test one port.
 */
const emptyS3 = (): S3Client =>
  ({
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      }
      return {};
    },
  }) as unknown as S3Client;

const withDb = async (run: (db: Db) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "bugboss-sql-"));
  const db = await Db.open({
    path: join(dir, "test.db"),
    bucket: "bugboss-test",
    key: "db/test.db",
    s3: emptyS3(),
  });
  try {
    await db.withWrite((w) => {
      w.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, slackThreadTs) VALUES (?, 'INVESTIGATING', 1, ?)",
      ).run(SQL_INCIDENT, "1727700000.000100");
      w.prepare(
        "INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', 1)",
      ).run(THREADLESS);
    });
    await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const sidecarPort = (
  db: Db,
  incidentId: string,
  options: { sqlRunnerUrl?: string; sidecar?: (call: SidecarCall) => Response | Promise<Response> },
) => {
  const calls: SidecarCall[] = [];
  const port = createSidecarSqlPort({
    db,
    incidentId,
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
  });
  return { port, calls };
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

const bodyOf = (reply: SidecarReply) => JSON.parse(reply.text) as Record<string, unknown>;

test("a SQL request goes to the sidecar with the incident's own thread, not one the agent names", () =>
  withDb(async (db) => {
    const { port, calls } = sidecarPort(db, SQL_INCIDENT, {
      sqlRunnerUrl: "http://127.0.0.1:8790/",
      sidecar: () => Response.json({ requestId: "4b6f" }, { status: 201 }),
    });
    const res = await port.createSqlRequest({
      sql: "select 1",
      reason: "check",
      threadTs: "1.2",
      incidentId: 99,
    } as unknown as { sql: string; reason: string });

    assert.equal(res.status, 201);
    assert.deepEqual(bodyOf(res), { requestId: "4b6f" });
    assert.deepEqual(calls, [
      {
        method: "POST",
        url: "http://127.0.0.1:8790/requests",
        body: { incidentId: 41, threadTs: "1727700000.000100", sql: "select 1", reason: "check" },
      },
    ]);
  }));

test("the sidecar's refusals reach the agent verbatim, status and all", () =>
  withDb(async (db) => {
    for (const [status, error] of [
      [400, "drop the semicolon"],
      [409, "incident 41 already has a pending request"],
      [503, "rotation group not configured"],
    ] as const) {
      const { port } = sidecarPort(db, SQL_INCIDENT, {
        sqlRunnerUrl: "http://127.0.0.1:8790",
        sidecar: () => Response.json({ error }, { status }),
      });
      const { result, alarms } = await alarmsDuring(() => port.createSqlRequest(ARGS));
      assert.deepEqual(result, { status, text: JSON.stringify({ error }) });
      // A refusal the sidecar meant is not a fault; a 5xx is.
      assert.equal(alarms.some((line) => /sql_runner_error/.test(line)), status >= 500);
    }
  }));

test("a SQL request with nowhere to ask is refused out loud, and the sidecar is never called", () =>
  withDb(async (db) => {
    const unset = sidecarPort(db, SQL_INCIDENT, {
      sidecar: () => Response.json({ requestId: "x" }, { status: 201 }),
    });
    const noUrl = await alarmsDuring(() => unset.port.createSqlRequest(ARGS));
    assert.equal(noUrl.result.status, 503);
    assert.match(String(bodyOf(noUrl.result).error), /BUGBOSS_SQL_RUNNER_URL/);
    assert.equal(noUrl.alarms.filter((line) => /sql_runner_unconfigured/.test(line)).length, 1);
    assert.equal(unset.calls.length, 0);

    const threadless = sidecarPort(db, THREADLESS, {
      sqlRunnerUrl: "http://127.0.0.1:8790",
      sidecar: () => Response.json({ requestId: "x" }, { status: 201 }),
    });
    const noThread = await alarmsDuring(() => threadless.port.createSqlRequest(ARGS));
    assert.equal(noThread.result.status, 409);
    assert.match(String(bodyOf(noThread.result).error), /no Slack thread/);
    assert.equal(noThread.alarms.filter((line) => /sql_request_no_thread/.test(line)).length, 1);
    assert.equal(threadless.calls.length, 0);

    const unknown = sidecarPort(db, "999", {
      sqlRunnerUrl: "http://127.0.0.1:8790",
      sidecar: () => Response.json({ requestId: "x" }, { status: 201 }),
    });
    const missing = await alarmsDuring(() => unknown.port.createSqlRequest(ARGS));
    assert.equal(missing.result.status, 404);
    assert.equal(missing.alarms.filter((line) => /sql_request_unknown_incident/.test(line)).length, 1);
    assert.equal(unknown.calls.length, 0);
  }));

test("an unreachable sidecar is an error the agent can read and an alarm somebody can", () =>
  withDb(async (db) => {
    const { port } = sidecarPort(db, SQL_INCIDENT, { sqlRunnerUrl: "http://127.0.0.1:8790" });

    const create = await alarmsDuring(() => port.createSqlRequest(ARGS));
    assert.equal(create.result.status, 502);
    assert.match(String(bodyOf(create.result).error), /ECONNREFUSED/);
    assert.equal(create.alarms.filter((line) => /sql_runner_unreachable/.test(line)).length, 1);

    const read = await alarmsDuring(() => port.getSqlRequest("4b6f"));
    assert.equal(read.result.status, 502);
    assert.equal(read.alarms.filter((line) => /sql_runner_unreachable/.test(line)).length, 1);
  }));

test("reading a SQL request proxies the sidecar's answer, a 404 included", () =>
  withDb(async (db) => {
    const done = {
      requestId: "4b6f",
      status: "done",
      decidedBy: "U01",
      columns: ["id"],
      rows: [{ id: 1 }],
      rowCount: 1,
    };
    const { port, calls } = sidecarPort(db, SQL_INCIDENT, {
      sqlRunnerUrl: "http://127.0.0.1:8790",
      sidecar: (call) =>
        call.url.endsWith("/requests/4b6f")
          ? Response.json(done)
          : Response.json({ error: "not found" }, { status: 404 }),
    });

    const found = await port.getSqlRequest("4b6f");
    assert.equal(found.status, 200);
    assert.deepEqual(bodyOf(found), done);

    const lost = await alarmsDuring(() => port.getSqlRequest("gone"));
    assert.equal(lost.result.status, 404);
    assert.deepEqual(lost.alarms, [], "a lost request is the sidecar restarting, not a fault");
    assert.deepEqual(
      calls.map((call) => [call.method, call.url]),
      [
        ["GET", "http://127.0.0.1:8790/requests/4b6f"],
        ["GET", "http://127.0.0.1:8790/requests/gone"],
      ],
    );
  }));

test("a request id cannot move the sidecar path", () =>
  withDb(async (db) => {
    const { port, calls } = sidecarPort(db, SQL_INCIDENT, {
      sqlRunnerUrl: "http://127.0.0.1:8790",
      sidecar: () => Response.json({}),
    });
    const res = await port.getSqlRequest("../health");
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  }));
