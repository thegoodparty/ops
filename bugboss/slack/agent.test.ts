import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import {
  MAX_SQL_ROWS,
  SLACK_AGENT_SYSTEM,
  SlackAgent,
  assertReadOnlySql,
  buildTools,
  createMemoryThreadLock,
  incidentSessionPrefix,
  slackSessionPrefix,
  type ObjectStore,
  type SlackAgentRun,
  type SlackMention,
  tsAfter,
  type SlackMessage,
} from "./agent";

const BOT = "U0BUGBOSS";
const ALERT_CHANNEL = "C0ALERTS";
const CHANNEL = "C0DEVALERTS";
const ALERT = "C0BUGBOSS";
const ROTATION = "S0ROTATION";

/** Both consoles, because a failure the thread cannot carry lands there. */
const captureLogs = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => lines.push(String(line));
  console.error = (line: unknown) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
};

const noS3 = (): S3Client =>
  ({
    send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        const err = new Error("cold start");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

const memoryStore = () => {
  const objects = new Map<string, string>();
  const store: ObjectStore = {
    get: (key) => Promise.resolve(objects.get(key) ?? null),
    put: (key, body) => {
      objects.set(key, body);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix))),
  };
  return { store, objects };
};

const fakeModel = () => {
  const runs: SlackAgentRun[] = [];
  const state = { reply: "answered", hold: false, gates: [] as (() => void)[] };
  return {
    runs,
    state,
    /** Lets every held run through. One gate per in-flight run. */
    release: () => {
      for (const open of state.gates.splice(0)) open();
    },
    model: {
      run: async (req: SlackAgentRun) => {
        runs.push(req);
        if (state.hold) {
          await new Promise<void>((resolve) => {
            state.gates.push(resolve);
          });
        }
        return { text: state.reply };
      },
    },
  };
};

const fakeSlack = () => {
  const posts: { threadTs: string | null; text: string; channel?: string }[] = [];
  const state = {
    replies: [] as SlackMessage[],
    calls: [] as { channel: string; threadTs: string; oldest?: string }[],
  };
  return {
    posts,
    state,
    client: {
      post: (threadTs: string | null, text: string, channel?: string) => {
        posts.push({ threadTs, text, channel });
        return Promise.resolve({ ts: `ts-${posts.length}` });
      },
      replies: (args: { channel: string; threadTs: string; oldest?: string }) => {
        state.calls.push(args);
        return Promise.resolve(state.replies);
      },
    },
  };
};

const mention = (over: Partial<SlackMention> = {}): SlackMention => ({
  channel: CHANNEL,
  threadTs: "100.0",
  ts: "100.0",
  user: "U0HUMAN",
  text: `<@${BOT}> what is open right now?`,
  ...over,
});

let dir: string;
let db: Db;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-slackagent-"));
  db = await Db.open({
    path: join(dir, "agent.db"),
    bucket: "bugboss-test",
    key: "state/db",
    s3: noS3(),
  });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.withWrite((d) => {
    d.prepare("DELETE FROM thread_reply").run();
    d.prepare("DELETE FROM signal").run();
    d.prepare("DELETE FROM incident").run();
    d.prepare(
      "INSERT INTO incident (id, status, owner, firstSignalAt) VALUES ('inc-1','INVESTIGATING','agent',1)",
    ).run();
  });
});

// ---------------------------------------------------------------------------

describe("SQL access is read-only", () => {
  test("the guard accepts reads", () => {
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
      assert.doesNotThrow(() => assertReadOnlySql(sql), sql);
    }
  });

  test("the guard rejects every write shape", () => {
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
      assert.throws(() => assertReadOnlySql(sql), `must reject: ${sql}`);
    }
  });

  test("the connection underneath is read-only, not just the guard", () => {
    // A guard is a message; this is the boundary. RETURNING makes it a
    // statement better-sqlite3 will happily run as a reader, so what stops it
    // is SQLite itself.
    assert.throws(
      () => db.query("DELETE FROM incident RETURNING id"),
      /readonly|read-only/i,
    );
    assert.throws(
      () => db.query("INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt) VALUES ('s','x','y','alert','t','b',1) RETURNING id"),
      /readonly|read-only/i,
    );
    assert.equal(db.query("SELECT id FROM incident").length, 1, "nothing was written");
  });

  test("the tool refuses a write and leaves the row alone", async () => {
    const { store } = memoryStore();
    const [, query] = buildTools({ db, store });
    const out = await query.run({ sql: "DELETE FROM incident" });

    assert.match(out, /^Rejected: /);
    assert.equal(db.query("SELECT id FROM incident").length, 1);
  });

  test("results are bounded", async () => {
    await db.withWrite((d) => {
      const stmt = d.prepare(
        "INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt) VALUES (?, 'grafana', ?, 'alert', 'x', ?, 1)",
      );
      for (let i = 0; i < MAX_SQL_ROWS + 10; i++) {
        stmt.run(`s-${i}`, `fp-${i}`, "y".repeat(5000));
      }
    });

    const { store } = memoryStore();
    const [, query] = buildTools({ db, store });
    const out = await query.run({ sql: "SELECT * FROM signal" });

    assert.equal(out.split("\n").length, MAX_SQL_ROWS + 1, "rows are capped");
    assert.match(out, /first 50 shown/);
    for (const line of out.split("\n").slice(0, MAX_SQL_ROWS)) {
      assert.ok(line.length < 2200, "each row is capped");
    }
  });
});

// ---------------------------------------------------------------------------

describe("prefix binding", () => {
  test("the tool specs are byte-identical across builds and database states", async () => {
    const specs = () =>
      JSON.stringify(
        buildTools({ db, store: memoryStore().store }).map(
          ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
        ),
      );

    const before = specs();
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident (id, status, owner, firstSignalAt) VALUES ('inc-2','FIXING','human',2)",
      ).run();
    });

    assert.equal(specs(), before);
    assert.deepEqual(
      buildTools({ db, store: memoryStore().store }).map((t) => t.name),
      ["get_incident", "query_incidents", "read_agent_session"],
      "order is part of the prefix",
    );
  });

  test("nothing nondeterministic leaked into the system prompt", () => {
    assert.doesNotMatch(
      SLACK_AGENT_SYSTEM,
      /\d{4}-\d{2}-\d{2}|\d{10,}|\/Users\/|\/tmp\/|[0-9a-f]{40}/,
    );
  });

  test("two runs in one thread send the same system and tools", async () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store } = memoryStore();
    const agent = new SlackAgent({
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    await agent.handle(mention({ ts: "100.0" }));
    await agent.handle(mention({ ts: "200.0" }));

    assert.equal(model.runs.length, 2);
    assert.equal(model.runs[0].system, model.runs[1].system);
    assert.equal(
      JSON.stringify(model.runs[0].tools.map((t) => [t.name, t.inputSchema])),
      JSON.stringify(model.runs[1].tools.map((t) => [t.name, t.inputSchema])),
    );
  });
});

// ---------------------------------------------------------------------------

describe("the per-thread lock", () => {
  test("a held thread cannot be acquired twice", async () => {
    const lock = createMemoryThreadLock();
    assert.equal(await lock.acquire("a", 60_000), true);
    assert.equal(await lock.acquire("a", 60_000), false);
    assert.equal(await lock.acquire("b", 60_000), true, "other threads are free");
    await lock.release("a");
    assert.equal(await lock.acquire("a", 60_000), true);
  });

  test("a lock left behind by a dead run expires", async () => {
    const lock = createMemoryThreadLock();
    await lock.acquire("a", -1);
    assert.equal(await lock.acquire("a", 60_000), true);
  });

  test("a second mention while the first is running does not start a second run", async () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store } = memoryStore();
    const agent = new SlackAgent({
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    model.state.hold = true;
    const first = agent.handle(mention({ ts: "100.0" }));
    await new Promise((resolve) => setImmediate(resolve));

    await agent.handle(mention({ ts: "100.1" }));
    assert.equal(model.runs.length, 1, "one run, one session writer");
    assert.match(slack.posts[0].text, /Still working on the previous question/);

    model.state.hold = false;
    model.release();
    await first;

    assert.equal(model.runs.length, 1);
    assert.equal(slack.posts.length, 2);
  });

  test("the lock is released once the run finishes, including after a failure", async () => {
    const slack = fakeSlack();
    const { store } = memoryStore();
    let calls = 0;
    const agent = new SlackAgent({
      db,
      store,
      slack: slack.client,
      model: {
        run: async () => {
          calls++;
          if (calls === 1) throw new Error("bedrock said no");
          return { text: "second time lucky" };
        },
      },
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    await agent.handle(mention({ ts: "100.0" }));
    assert.match(slack.posts[0].text, /could not finish/);

    await agent.handle(mention({ ts: "200.0" }));
    assert.equal(calls, 2, "the thread is not wedged");
    assert.equal(slack.posts[1].text, "second time lucky");
  });

  test("different threads run at the same time", async () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store } = memoryStore();
    const agent = new SlackAgent({
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    model.state.hold = true;
    const a = agent.handle(mention({ threadTs: "100.0", ts: "100.0" }));
    await new Promise((resolve) => setImmediate(resolve));
    const b = agent.handle(mention({ threadTs: "900.0", ts: "900.0" }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(model.runs.length, 2);
    model.state.hold = false;
    model.release();
    await Promise.all([a, b]);
  });
});

// ---------------------------------------------------------------------------

describe("session persistence", () => {
  const build = () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store, objects } = memoryStore();
    const agent = new SlackAgent({
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });
    return { model, slack, store, objects, agent };
  };

  test("the session is keyed by thread, not by incident", () => {
    assert.equal(slackSessionPrefix(CHANNEL, "100.0"), `sessions/slack/${CHANNEL}/100.0/`);
    assert.equal(incidentSessionPrefix("inc-1"), "sessions/incident/inc-1/");
  });

  test("the first mention starts clean and reads no thread", async () => {
    const { model, slack, agent } = build();
    await agent.handle(mention({ ts: "100.0" }));

    assert.equal(model.runs[0].fresh, true);
    assert.equal(model.runs[0].sessionKey, `sessions/slack/${CHANNEL}/100.0/`);
    assert.equal(slack.state.calls.length, 0, "nothing to catch up on");
  });

  test("a resume loads the session and fetches only what it missed", async () => {
    const { model, slack, objects, agent } = build();
    await agent.handle(mention({ ts: "100.0" }));

    slack.state.replies = [
      { user: "U0OTHER", botId: null, text: "the deploy went out at 14:02", ts: "150.0" },
      { user: null, botId: "B0AGENT", text: "hypothesis: bad column", ts: "160.0" },
      { user: "U0HUMAN", botId: null, text: "already seen", ts: "90.0" },
    ];
    await agent.handle(mention({ ts: "200.0", text: `<@${BOT}> and now?` }));

    const second = model.runs[1];
    assert.equal(second.fresh, false, "it resumes its own session");
    assert.deepEqual(slack.state.calls[0], {
      channel: CHANNEL,
      threadTs: "100.0",
      oldest: "100.0",
    });
    assert.match(second.input, /the deploy went out at 14:02/);
    assert.doesNotMatch(second.input, /hypothesis: bad column/, "bot posts are not replayed");
    assert.doesNotMatch(second.input, /already seen/, "nothing before the watermark");
    assert.match(second.input, /and now\?$/, "the question comes last");
    assert.ok(objects.get(`sessions/slack/${CHANNEL}/100.0/state.json`));
  });

  test("a thread idle for more than seven days starts clean", async () => {
    const { model, objects, agent } = build();
    await agent.handle(mention({ ts: "100.0" }));

    const key = `sessions/slack/${CHANNEL}/100.0/state.json`;
    objects.set(
      key,
      JSON.stringify({
        lastSeenTs: "100.0",
        lastActivityAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    );
    await agent.handle(mention({ ts: "200.0" }));

    assert.equal(model.runs[1].fresh, true);
  });

  test("unreadable state says so instead of looking like amnesia", async () => {
    const { model, objects, agent } = build();
    objects.set(`sessions/slack/${CHANNEL}/100.0/state.json`, "{ truncated");

    const lines = await captureLogs(() => agent.handle(mention({ ts: "200.0" })));

    assert.equal(model.runs[0].fresh, true, "it starts clean, not on garbage");
    assert.ok(
      lines.some((line) => line.includes("state_unusable")),
      "dropping every reply since the last answer must not be silent",
    );
  });

  test("a state write that fails after the answer does not retract it", async () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store } = memoryStore();
    const agent = new SlackAgent({
      db,
      store: { ...store, put: () => Promise.reject(new Error("s3 500")) },
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    const lines = await captureLogs(() => agent.handle(mention({ ts: "100.0" })));

    assert.equal(slack.posts.length, 1, "nothing contradicts the answer");
    assert.equal(slack.posts[0].text, "answered");
    assert.ok(lines.some((line) => line.includes("state_write_failed")));
  });

  test("a throttled thread fetch costs context, not the answer", async () => {
    const model = fakeModel();
    const { store } = memoryStore();
    const posts: string[] = [];
    const agent = new SlackAgent({
      db,
      store,
      slack: {
        post: (_threadTs, text) => {
          posts.push(text);
          return Promise.resolve({ ts: "x" });
        },
        replies: () => Promise.reject(new Error("ratelimited")),
      },
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    await agent.handle(mention({ ts: "100.0" }));
    await agent.handle(mention({ ts: "200.0" }));

    assert.equal(model.runs.length, 2);
    assert.equal(posts[1], "answered");
  });
});

// ---------------------------------------------------------------------------

describe("Slack timestamps", () => {
  test("the watermark comparison is not a string compare", () => {
    assert.equal(tsAfter("90.0", "100.0"), false, "9 > 1 only lexicographically");
    assert.equal(tsAfter("1758700000.000100", "1758700000.000099"), true);
    assert.equal(tsAfter("1758700000.000099", "1758700000.000100"), false);
    assert.equal(tsAfter("1758700001.000000", "1758700000.999999"), true);
    assert.equal(tsAfter("100.0", "100.0"), false, "equal is not after");
    assert.equal(tsAfter("100.1", "100"), true, "a missing fraction is zero");
  });
});

describe("when the answer itself fails", () => {
  test("a failure the thread cannot carry goes where the thread is not", async () => {
    const { store } = memoryStore();
    const posts: { channel?: string; text: string }[] = [];
    const agent = new SlackAgent({
      db,
      store,
      slack: {
        post: (_threadTs, text, channel) => {
          if (channel === CHANNEL) {
            return Promise.reject(new Error("channel_not_found"));
          }
          posts.push({ channel, text });
          return Promise.resolve({ ts: "ts-1" });
        },
        replies: () => Promise.resolve([]),
      },
      model: { run: () => Promise.reject(new Error("bedrock said no")) },
      config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION },
    });

    const lines = await captureLogs(() => agent.handle(mention({ ts: "100.0" })));

    assert.equal(posts.length, 1, "someone was told");
    assert.equal(posts[0].channel, ALERT, "not through the channel that failed");
    assert.match(posts[0].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
    assert.ok(
      lines.some((line) => line.includes("failure_reply_failed")),
      "and the apology failing is logged on its own, not swallowed",
    );
  });
});

describe("reading another agent's session", () => {
  test("it finds the archived session under the incident prefix", async () => {
    const { store, objects } = memoryStore();
    objects.set(
      "sessions/incident/inc-1/session.jsonl",
      ["{\"role\":\"user\"}", "{\"role\":\"assistant\"}", "{\"role\":\"tool\"}"].join("\n"),
    );
    const [, , read] = buildTools({ db, store });

    const out = await read.run({ incidentId: "inc-1", tailLines: 2 });
    assert.match(out, /3 entries, last 2/);
    assert.doesNotMatch(out, /"role":"user"/);
  });

  test("a missing session says so rather than inventing one", async () => {
    const { store } = memoryStore();
    const [, , read] = buildTools({ db, store });
    const out = await read.run({ incidentId: "inc-404" });
    assert.match(out, /No session under sessions\/incident\/inc-404\//);
  });
});
