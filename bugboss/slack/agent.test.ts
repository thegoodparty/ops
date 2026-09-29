import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
// The turn loop this agent runs on is named in the composition root, next to
// the Bedrock client it drives. Its behaviour is the Slack agent's behaviour,
// so it is tested here with the rest of that surface.
import { createSlackAgentModel } from "../index";
import type { ModelClient, ModelReply, ModelRequest } from "../triage";
import {
  MAX_SQL_ROWS,
  SLACK_AGENT_BUDGET_MS,
  SLACK_AGENT_MAX_TURNS,
  SLACK_AGENT_SYSTEM,
  SlackAgent,
  assertReadOnlySql,
  buildTools,
  createMemoryThreadLock,
  incidentSessionPrefix,
  slackSessionPrefix,
  type ObjectStore,
  type SlackAgentRun,
  type SlackAgentTool,
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

/**
 * What Slack answers with. The ts is the only part that varies between two
 * messages in one channel, which is what the real linker relies on.
 */
const permalinkFor = (messageTs: string, channel = CHANNEL): string =>
  `https://goodparty.slack.com/archives/${channel}/p${messageTs.replaceAll(".", "")}`;

const fakeLinker = {
  permalink: (messageTs: string, channel?: string) =>
    Promise.resolve(permalinkFor(messageTs, channel)),
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
      ...fakeLinker,
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
    const [, query] = buildTools({ db, store, linker: fakeLinker, threadTs: null });
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
    const [, query] = buildTools({ db, store, linker: fakeLinker, threadTs: null });
    const out = await query.run({ sql: "SELECT * FROM signal" });

    assert.equal(out.split("\n").length, MAX_SQL_ROWS + 1, "rows are capped");
    assert.match(out, /first 50 shown/);
    for (const line of out.split("\n").slice(0, MAX_SQL_ROWS)) {
      // 2000 exactly, not "under 2200". The old slack-agent truncate sliced
      // to the cap and then appended its marker on top, so the slack the
      // number carried was the overshoot, and it grew with the row.
      assert.ok(line.length <= 2000, `each row is capped: ${line.length}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("prefix binding", () => {
  test("the tool specs are byte-identical across builds and database states", async () => {
    const specs = () =>
      JSON.stringify(
        buildTools({ db, store: memoryStore().store, linker: fakeLinker, threadTs: null }).map(
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
      buildTools({ db, store: memoryStore().store, linker: fakeLinker, threadTs: null }).map((t) => t.name),
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
        ...fakeLinker,
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
        ...fakeLinker,
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
      posts[0].text.includes(`<${permalinkFor("100.0")}|that thread>`),
      "whoever reads this was not there and cannot reconstruct a thread from a ts",
    );
    assert.ok(
      lines.some((line) => line.includes("failure_reply_failed")),
      "and the apology failing is logged on its own, not swallowed",
    );
  });

  test("a permalink that fails costs the link, not the alert", async () => {
    const { store } = memoryStore();
    const posts: { channel?: string; text: string }[] = [];
    const agent = new SlackAgent({
      db,
      store,
      slack: {
        permalink: () => Promise.reject(new Error("ratelimited")),
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

    assert.equal(posts.length, 1, "an alert lost to a second failure is the worst case");
    assert.match(posts[0].text, /thread 100\.0/, "named the bare way instead");
    assert.ok(!posts[0].text.includes("goodparty.slack.com"));
    assert.ok(
      lines.some((line) => line.includes("failure_alert_permalink_failed")),
      "degrading is not swallowing",
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
    const [, , read] = buildTools({ db, store, linker: fakeLinker, threadTs: null });

    const out = await read.run({ incidentId: "inc-1", tailLines: 2 });
    assert.match(out, /3 entries, last 2/);
    assert.doesNotMatch(out, /"role":"user"/);
  });

  test("a missing session says so rather than inventing one", async () => {
    const { store } = memoryStore();
    const [, , read] = buildTools({ db, store, linker: fakeLinker, threadTs: null });
    const out = await read.run({ incidentId: "inc-404" });
    assert.match(out, /No session under sessions\/incident\/inc-404\//);
  });
});

// ---------------------------------------------------------------------------

describe("an incident named outside its own thread is linkable", () => {
  const withThread = (id: string, threadTs: string) =>
    db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = ? WHERE id = ?").run(
        threadTs,
        id,
      );
    });

  test("the model is handed the link when it is standing somewhere else", async () => {
    await withThread("inc-1", "400.0");
    const { store } = memoryStore();
    const [get] = buildTools({
      db,
      store,
      linker: fakeLinker,
      threadTs: "100.0",
    });

    const out = await get.run({ incidentId: "inc-1" });

    assert.match(
      out,
      new RegExp(`"threadPermalink": "${permalinkFor("400.0")}"`),
      "a reader in another thread has no other way to reach it",
    );
  });

  test("and denied it inside that incident's own thread", async () => {
    await withThread("inc-1", "400.0");
    const { store } = memoryStore();
    const [get] = buildTools({
      db,
      store,
      linker: fakeLinker,
      threadTs: "400.0",
    });

    const out = await get.run({ incidentId: "inc-1" });

    // Withheld rather than merely discouraged: an instruction the model can
    // forget is not what stops it linking to where the reader already is.
    assert.match(out, /"threadPermalink": null/);
    assert.doesNotMatch(out, /goodparty\.slack\.com/);
  });

  test("an incident with no thread yet has nothing to point at", async () => {
    const { store } = memoryStore();
    const [get] = buildTools({
      db,
      store,
      linker: fakeLinker,
      threadTs: "100.0",
    });

    const out = await get.run({ incidentId: "inc-1" });

    assert.match(out, /"threadPermalink": null/);
  });

  test("a link Slack refuses costs the link, not the answer", async () => {
    await withThread("inc-1", "400.0");
    const { store } = memoryStore();
    const [get] = buildTools({
      db,
      store,
      linker: { permalink: () => Promise.reject(new Error("ratelimited")) },
      threadTs: "100.0",
    });

    let out = "";
    const lines = await captureLogs(async () => {
      out = await get.run({ incidentId: "inc-1" });
    });

    assert.match(out, /"id": "inc-1"/, "the incident is still reported");
    assert.match(out, /"threadPermalink": null/, "and the model writes it bare");
    assert.ok(
      lines.some((line) => line.includes('"permalink_failed"')),
      "degrading is not swallowing",
    );
  });

  test("a whole query's worth of incidents is one round trip", async () => {
    await db.withWrite((d) => {
      const stmt = d.prepare(
        "INSERT INTO incident (id, status, owner, firstSignalAt, slackThreadTs) VALUES (?, 'INVESTIGATING', 'agent', 1, ?)",
      );
      for (let i = 2; i <= 6; i++) stmt.run(`inc-${i}`, `${i}00.0`);
    });
    const asked: string[] = [];
    const { store } = memoryStore();
    const [, query] = buildTools({
      db,
      store,
      linker: {
        permalink: (ts) => {
          asked.push(ts);
          return Promise.resolve(permalinkFor(ts));
        },
      },
      threadTs: "100.0",
    });

    const out = await query.run({
      sql: "SELECT id, slackThreadTs FROM incident WHERE slackThreadTs IS NOT NULL ORDER BY id",
    });

    for (let i = 2; i <= 6; i++) {
      assert.match(out, new RegExp(`"threadPermalink":"${permalinkFor(`${i}00.0`)}"`));
    }
    assert.deepEqual(asked.length, 5, "the fake learns nothing; the real one asks once");
  });

  test("Slack going down partway does not turn fifty rows into fifty waits", async () => {
    await db.withWrite((d) => {
      const stmt = d.prepare(
        "INSERT INTO incident (id, status, owner, firstSignalAt, slackThreadTs) VALUES (?, 'INVESTIGATING', 'agent', 1, ?)",
      );
      for (let i = 2; i <= 6; i++) stmt.run(`inc-${i}`, `${i}00.0`);
    });
    let asked = 0;
    const { store } = memoryStore();
    const [, query] = buildTools({
      db,
      store,
      linker: {
        permalink: () => {
          asked++;
          return Promise.reject(new Error("ratelimited"));
        },
      },
      threadTs: "100.0",
    });

    let out = "";
    await captureLogs(async () => {
      out = await query.run({
        sql: "SELECT id, slackThreadTs FROM incident WHERE slackThreadTs IS NOT NULL ORDER BY id",
      });
    });

    assert.equal(asked, 1, "it stops asking a Slack that just said no");
    assert.equal(
      out.split("\n").filter((l) => l.includes('"threadPermalink":null')).length,
      5,
      "and every row still comes back",
    );
  });

  test("rows that are not incidents are left alone", async () => {
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt) VALUES ('s-1','grafana','fp-1','alert','pool','b',1)",
      ).run();
    });
    const { store } = memoryStore();
    const [, query] = buildTools({
      db,
      store,
      linker: fakeLinker,
      threadTs: "100.0",
    });

    const out = await query.run({ sql: "SELECT id, title FROM signal" });

    assert.doesNotMatch(out, /threadPermalink/);
  });

  test("the thread the answer is written into is the one the tools are built for", async () => {
    await withThread("inc-1", "400.0");
    const { store } = memoryStore();
    const posts: string[] = [];
    const agent = new SlackAgent({
      db,
      store,
      slack: {
        ...fakeLinker,
        post: (_threadTs, text) => {
          posts.push(text);
          return Promise.resolve({ ts: "x" });
        },
        replies: () => Promise.resolve([]),
      },
      // Standing in for the model doing what it is told: look the incident up
      // and say what came back.
      model: {
        run: async (req) => ({ text: await req.tools[0].run({ incidentId: "inc-1" }) }),
      },
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
    });

    await agent.handle(mention({ threadTs: "999.0", ts: "999.1" }));
    assert.ok(
      posts.join("").includes(permalinkFor("400.0")),
      "asked about incident 1 from another thread, it has the link",
    );

    posts.length = 0;
    await agent.handle(mention({ threadTs: "400.0", ts: "400.1" }));
    assert.ok(
      !posts.join("").includes(permalinkFor("400.0")),
      "asked in incident 1's own thread, it has nothing to self-link with",
    );
  });

  test("the prompt still tells the model to link", () => {
    assert.match(SLACK_AGENT_SYSTEM, /threadPermalink/);
    assert.match(SLACK_AGENT_SYSTEM, /<permalink\|incident 4>/);
  });
});

// ---------------------------------------------------------------------------

/** One tool, so a run can be scripted turn by turn without a database. */
const countingTool = (results: string[]) => ({
  name: "get_incident",
  description: "Read one incident in full.",
  inputSchema: { type: "object" } as Record<string, unknown>,
  run: (input: Record<string, unknown>) => {
    results.push(String(input.incidentId));
    return Promise.resolve(`${String(input.incidentId)} is FIXING, owner agent`);
  },
});

const runRequest = (
  tools: SlackAgentTool[],
  maxTurns: number,
): SlackAgentRun => ({
  system: SLACK_AGENT_SYSTEM,
  tools,
  sessionKey: "sessions/slack/C0DEVALERTS/100.0/",
  fresh: true,
  input: "<@U0HUMAN> asks: what is the state of the various incidents?",
  maxTurns,
});

describe("a run that uses its whole budget", () => {
  test("answers with what it read instead of an apology", async () => {
    const { store } = memoryStore();
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      complete: (request) => {
        requests.push(request);
        // The wrap-up is the call that arrives with nothing to call.
        if (request.tools.length === 0) {
          return Promise.resolve({
            text: "Two of the three are open and I read inc-1; I did not reach inc-2.",
            toolCalls: [],
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: "",
          toolCalls: [
            {
              id: `call-${requests.length}`,
              name: "get_incident",
              input: { incidentId: "inc-1" },
            },
          ],
        } satisfies ModelReply);
      },
    };

    const reads: string[] = [];
    let answer = "";
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(model, store).run(
        runRequest([countingTool(reads)], 3),
      );
      answer = result.text;
    });

    assert.equal(requests.length, 4, "three turns, then one wrap-up");
    assert.deepEqual(requests[3].tools, [], "the wrap-up cannot call another tool");
    assert.match(requests[3].system, /you cannot call another tool/);
    assert.equal(
      requests[3].messages.filter((m) => m.role === "user").length,
      1,
      "the wrap-up rides on the system prompt, not a user turn behind tool results",
    );
    assert.ok(
      requests[3].messages.some(
        (m) => m.role === "toolResult" && m.text.includes("inc-1 is FIXING"),
      ),
      "the wrap-up is written from what the run had already read",
    );
    assert.match(answer, /did not reach inc-2/);
    assert.doesNotMatch(answer, /ran out of turns/);
    assert.ok(
      lines.some((l) => l.includes("slack_agent_turns_exhausted")),
      "running out of turns is still a visible event",
    );
  });

  test("keeps its own prose when the wrap-up itself fails", async () => {
    const { store } = memoryStore();
    const model: ModelClient = {
      complete: (request) => {
        if (request.tools.length === 0) {
          return Promise.reject(new Error("bedrock throttled"));
        }
        return Promise.resolve({
          text: "So far: inc-1 is being worked by an agent.",
          toolCalls: [
            { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
          ],
        } satisfies ModelReply);
      },
    };

    let answer = "";
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(model, store).run(
        runRequest([countingTool([])], 2),
      );
      answer = result.text;
    });

    assert.match(answer, /inc-1 is being worked/);
    assert.ok(lines.some((l) => l.includes("slack_agent_wrap_up_failed")));
  });

  test("leaves a transcript the next mention can still resume", async () => {
    const { store } = memoryStore();
    const seen: ModelRequest[] = [];
    let wrapUpFails = true;
    const model: ModelClient = {
      complete: (request) => {
        seen.push(request);
        if (request.tools.length === 0) {
          return wrapUpFails
            ? Promise.reject(new Error("bedrock throttled"))
            : Promise.resolve({ text: "", toolCalls: [] } satisfies ModelReply);
        }
        // The second mention answers straight away, so what it is asked with
        // is the transcript the failed run left behind.
        if (!wrapUpFails) {
          return Promise.resolve({
            text: "inc-1 is still being worked.",
            toolCalls: [],
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
          ],
        } satisfies ModelReply);
      },
    };

    const harness = createSlackAgentModel(model, store);
    await captureLogs(() => harness.run(runRequest([countingTool([])], 2)));

    wrapUpFails = false;
    seen.length = 0;
    await captureLogs(() =>
      harness.run({ ...runRequest([countingTool([])], 2), fresh: false }),
    );

    // Tool results and a question are both user messages to the model, so a
    // question sitting directly behind them is two user turns in a row and
    // the call is rejected before it starts.
    const resumed = seen[0].messages;
    const question = resumed.map((m) => m.role).lastIndexOf("user");
    assert.ok(question > 0, "the resumed run asked its question");
    assert.equal(
      resumed[question - 1].role,
      "assistant",
      "the next question lands behind an assistant turn, not behind tool results",
    );
  });

  test("says it ran out of steps, and how many, when the wrap-up has nothing either", async () => {
    const { store } = memoryStore();
    // Burns every turn on tool calls, so the budget really does run out, and
    // then answers the wrap-up with nothing.
    const model: ModelClient = {
      complete: (request) =>
        Promise.resolve(
          request.tools.length === 0
            ? ({ text: "", toolCalls: [] } satisfies ModelReply)
            : ({
                text: "",
                toolCalls: [
                  { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
                ],
              } satisfies ModelReply),
        ),
    };

    let answer = "";
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(model, store).run(
        runRequest([countingTool([])], 4),
      );
      answer = result.text;
    });

    // The four minutes of silence are the only thing the reader experienced,
    // so the reply has to name what caused them and how much it bought.
    assert.match(answer, /ran out of steps/);
    assert.match(answer, /\b4\b/, "and how many, so the wait has a size");
    assert.match(
      answer,
      /under a minute|about a minute|about \d+ minutes/,
      "and how long, which is what they actually waited",
    );
    assert.match(answer, /narrow it instead/);
    // Asking again spends the same budget the same way, so advice to do that
    // costs the reader another wait for the same non-answer.
    assert.doesNotMatch(answer, /[Aa]sk me again/);
    // A pointer to a log group is a second task for somebody already in the
    // middle of one, and whoever owns the budget has the alarm already.
    assert.doesNotMatch(answer, /logs/);
    assert.ok(lines.some((l) => l.includes("slack_agent_turns_exhausted")));
    assert.ok(lines.some((l) => l.includes("slack_agent_no_answer")));
    // The wrap-up answered, it just answered with nothing, so it never threw
    // and `wrap_up_failed` never fired. That is how a run holding everything
    // it read posted an apology with nobody told.
    assert.ok(lines.some((l) => l.includes("slack_agent_wrap_up_empty")));
    assert.ok(!lines.some((l) => l.includes("slack_agent_wrap_up_failed")));
  });

  test("does not claim it ran out of steps when it did not", async () => {
    // One turn, no tool calls, no text. The budget was never touched, so
    // blaming it would be a fabrication and "ask me again" is the right
    // advice rather than the wrong one.
    const { store } = memoryStore();
    const model: ModelClient = {
      complete: () => Promise.resolve({ text: "", toolCalls: [] } satisfies ModelReply),
    };

    let answer = "";
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(model, store).run(
        runRequest([countingTool([])], 4),
      );
      answer = result.text;
    });

    assert.doesNotMatch(answer, /ran out of steps/);
    assert.match(answer, /Ask me again/);
    assert.ok(
      !lines.some((l) => l.includes("slack_agent_turns_exhausted")),
      "nothing was exhausted",
    );
    assert.ok(lines.some((l) => l.includes("slack_agent_no_answer")));
  });
});

// ---------------------------------------------------------------------------

describe("the turn budget", () => {
  /** What was open the day a question about all of them went unanswered. */
  const OPEN_INCIDENTS = 11;

  test("covers reading every open incident and still answering", async () => {
    const { store } = memoryStore();
    const reads: string[] = [];
    let turn = 0;
    const model: ModelClient = {
      complete: () => {
        turn++;
        // The shape the real run took: one broad query, then depth on each
        // open incident, then the answer.
        if (turn === 1 || turn > OPEN_INCIDENTS + 1) {
          return Promise.resolve({
            text: `All ${OPEN_INCIDENTS} are accounted for.`,
            toolCalls: turn === 1
              ? [{ id: "q", name: "get_incident", input: { incidentId: "inc-0" } }]
              : [],
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: "",
          toolCalls: [
            {
              id: `call-${turn}`,
              name: "get_incident",
              input: { incidentId: `inc-${turn}` },
            },
          ],
        } satisfies ModelReply);
      },
    };

    let answer = "";
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(model, store).run(
        runRequest([countingTool(reads)], SLACK_AGENT_MAX_TURNS),
      );
      answer = result.text;
    });

    assert.equal(reads.length, OPEN_INCIDENTS + 1);
    assert.match(answer, new RegExp(`All ${OPEN_INCIDENTS} are accounted for`));
    assert.ok(
      !lines.some((l) => l.includes("slack_agent_turns_exhausted")),
      "the worst reasonable shape fits inside the budget",
    );
  });

  test("the thread lock outlives the longest run the budget allows", async () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store } = memoryStore();
    const leases: number[] = [];
    const agent = new SlackAgent({
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null },
      lock: {
        acquire: (_key, ttlMs) => {
          leases.push(ttlMs);
          return Promise.resolve(true);
        },
        release: () => Promise.resolve(),
      },
    });

    await agent.handle(mention());

    assert.equal(
      leases[0],
      (SLACK_AGENT_MAX_TURNS + 1) * SLACK_AGENT_BUDGET_MS,
      "a lease shorter than the run lets a second mention corrupt the session",
    );
  });

  test("is what the agent asks for when nothing overrides it", async () => {
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

    await agent.handle(mention());

    assert.equal(model.runs[0].maxTurns, SLACK_AGENT_MAX_TURNS);
  });
});

// ---------------------------------------------------------------------------

describe("asking the right tool", () => {
  test("the prompt sends a many-incident question to one query", () => {
    assert.match(SLACK_AGENT_SYSTEM, /more than one incident is a query_incidents question/i);
    assert.match(SLACK_AGENT_SYSTEM, /FROM incident i/);
    assert.match(SLACK_AGENT_SYSTEM, /WHERE i\.status IN \('INVESTIGATING','FIXING'\)/);
  });

  test("the prompt says what an on-call answer contains", () => {
    assert.match(SLACK_AGENT_SYSTEM, /blocked on a person/i);
    assert.match(SLACK_AGENT_SYSTEM, /needs nothing from them/i);
    assert.match(SLACK_AGENT_SYSTEM, /About 200 words/);
    assert.match(SLACK_AGENT_SYSTEM, /Plain terms/);
  });
});

// ---------------------------------------------------------------------------

describe("read_agent_session", () => {
  const sessionKeyFor = (id: string) => `sessions/incident/${id}/session.jsonl`;

  const turn = (text: string) =>
    JSON.stringify({ type: "message", message: { role: "assistant", content: text } });

  const readSession = async (lines: string[]) => {
    const { store, objects } = memoryStore();
    objects.set(sessionKeyFor("inc-1"), lines.join("\n"));
    const tools = buildTools({ db, store, linker: fakeLinker, threadTs: null });
    const tool = tools.find((t) => t.name === "read_agent_session");
    assert.ok(tool);
    return tool.run({ incidentId: "inc-1" });
  };

  // The whole reason a 9.5-hour run sat dead: the tail of a killed transcript
  // and the tail of a finished one read the same, so a human asking what
  // happened got the last turn and had to guess.
  test("says a run was killed rather than leaving the reader to infer it", async () => {
    const out = await readSession([turn("checks are green, asking for a merge")]);
    assert.match(out, /was killed after 1 turns/);
  });

  // Two bounds compose here: the exit-record line this PR prepends to the
  // header, and the session reader's own cap. Asserted at a size nobody
  // would choose, because a bound checked at a plausible input is a bound
  // that holds until somebody waits longer.
  test("the outcome line comes out of the session budget, not on top of it", async () => {
    const out = await readSession(
      Array.from({ length: 20_000 }, (_, i) => turn(`${i} ${"x".repeat(500)}`)),
    );
    assert.ok(
      out.length <= 24_000,
      `MAX_SESSION_CHARS is 24000 but the reader returned ${out.length}`,
    );
    // And it survives the cut, because it is in the head the cap keeps.
    assert.match(out, /was killed after 20000 turns/);
  });

  test("says a run ended on purpose when it did", async () => {
    const out = await readSession([
      turn("closing this out"),
      JSON.stringify({
        type: "custom",
        customType: "bugboss_exit",
        data: { reason: "completed", at: 1, attempt: 1 },
      }),
    ]);
    assert.match(out, /ended on purpose \(completed\)/);
  });
});
