import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Db } from "../db";
import { createMemoryS3 } from "../index";
import { createToolApiRoutes } from "../http/toolapi";
import { mintAgentToken } from "../toolapi";
import type { ToolApi } from "../types";
import { createBossClient } from "./run";
import {
  SQL_POLL_SECONDS,
  createSqlQueryTool,
  renderSqlOutcome,
  runSqlQuery,
  type SidecarReply,
  type SqlRequestPort,
  type SqlRequestView,
} from "./sql";
import { MAX_BLOCK_SECONDS, createWaitInterrupt } from "./tools";

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

/** A clock that only moves when the tool sleeps, so a wait costs no real time. */
const fakeTime = () => {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
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

test("a Boss message ends the wait, and the next wait starts clean", async () => {
  const waits = createWaitInterrupt();
  const tool = await createSqlQueryTool({
    port: scripted({ reads: [json(200, view())] }),
    waitSignal: waits.signal,
    pollSeconds: 60,
  });

  const started = Date.now();
  const pending = tool.execute("call-1", ARGS as never, undefined, undefined, undefined as never);
  setTimeout(() => waits.interrupt(), 20);
  const result = await pending;

  assert.ok(Date.now() - started < 5000, "the interrupt cut the sleep short");
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /STOPPED WAITING on request req-1, still pending \(interrupted\)/);
  assert.match(text, /requestId "req-1"/);
  assert.equal(waits.signal().aborted, false);
});

test("the harness deadline ends the wait and says so", async () => {
  const deadline = new AbortController();
  deadline.abort();
  const outcome = await runSqlQuery(ARGS, {
    port: scripted({ reads: [json(200, view())] }),
    signal: deadline.signal,
    ...fakeTime(),
  });
  assert.deepEqual(outcome, { kind: "waiting", requestId: "req-1", status: "pending", endedBy: "deadline" });
});

test("the Boss client reaches the SQL routes and hands back the sidecar's status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bugboss-sql-"));
  const db = await Db.open({
    path: join(dir, "test.db"),
    bucket: "bugboss-test",
    key: "db/test.db",
    s3: createMemoryS3(),
  });
  try {
    await db.withWrite((w) => {
      w.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, slackThreadTs) VALUES ('12', 'INVESTIGATING', 1, '1.5')",
      ).run();
    });
    const sidecar: string[] = [];
    const app = createToolApiRoutes({
      db,
      tokenSecret: "s",
      toolApiFor: () => ({}) as ToolApi,
      wakeBoss: () => {},
      noteEscalated: () => {},
      sqlRunnerUrl: "http://sidecar",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        sidecar.push(`${init?.method} ${String(input)}`);
        return String(input).endsWith("/requests")
          ? Response.json({ error: "drop the semicolon" }, { status: 400 })
          : Response.json(view({ requestId: "abc", status: "done", columns: [], rows: [] }));
      }) as typeof fetch,
    });
    const client = createBossClient({
      baseUrl: "http://boss",
      incidentId: "12",
      authToken: mintAgentToken("s", { incidentId: "12", attempt: 1 }, 3600),
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(String(input).replace("http://boss", ""), init)) as typeof fetch,
    });

    const refused = await client.createSqlRequest({ sql: "select 1;", reason: "r" });
    assert.deepEqual(refused, { status: 400, text: JSON.stringify({ error: "drop the semicolon" }) });
    const read = await client.getSqlRequest("abc");
    assert.equal(read.status, 200);
    assert.equal((JSON.parse(read.text) as SqlRequestView).status, "done");
    assert.deepEqual(sidecar, ["POST http://sidecar/requests", "GET http://sidecar/requests/abc"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
