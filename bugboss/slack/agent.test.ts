import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import { indexIncident, toMatchQuery } from "../db/search";
// The turn loop this agent runs on is named in the composition root, next to
// the Bedrock client it drives. Its behaviour is the Slack agent's behaviour,
// so it is tested here with the rest of that surface.
import { createSlackAgentModel } from "../index";
import { emptyModelUsage, ModelRequestFailed } from "../model";
import type {
  ModelReply,
  ModelRequest,
  ModelTurn,
  ModelUsage,
  SizedModelClient,
} from "../triage";
import type { BossCommandDeps, CloseIncident } from "../boss/commands";
import { recordForBoss } from "../boss/inbox";
import type { Directive } from "../types";
import {
  compactTranscript,
  MAX_SQL_ROWS,
  SLACK_AGENT_BUDGET_MS,
  SLACK_AGENT_RESERVE_TOKENS,
  SLACK_AGENT_MAX_TURNS,
  SLACK_AGENT_SYSTEM,
  SlackAgent,
  buildTools,
  createMemoryThreadLock,
  incidentSessionPrefix,
  slackSessionPrefix,
  STAY_SILENT_TOOL,
  type ObjectStore,
  type OpenIncident,
  type SlackAgentModel,
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

/** The status card's summary call, for runs that never ask for a card. */
const noSummaryModel = {
  complete: () => Promise.reject(new Error("no summary expected in this test")),
};

/** The report ingest, for runs that never file one. */
const refuseOpen = () => Promise.reject(new Error("no report expected in this test"));

const toolExtras = () => ({
  silence: { allowed: true, reason: null as string | null },
  openIncident: refuseOpen,
  reporter: null,
  status: {
    summarise: () => Promise.reject(new Error("no summary expected in this test")),
    cache: new Map<string, { position: number; text: string }>(),
    now: Date.now,
  },
});

const fakeModel = () => {
  const runs: SlackAgentRun[] = [];
  const state = {
    reply: "answered",
    hold: false,
    gates: [] as (() => void)[],
    /** When set, the run calls stay_silent with this reason, as a model would. */
    silence: null as string | null,
  };
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
        if (state.silence !== null) {
          const tool = req.tools.find((t) => t.name === "stay_silent");
          if (!tool) throw new Error("the Boss has no stay_silent tool");
          await tool.run({ reason: state.silence });
        }
        if (state.hold) {
          await new Promise<void>((resolve) => {
            state.gates.push(resolve);
          });
        }
        return { text: state.reply, usage: emptyModelUsage() };
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

const refuseClose: CloseIncident = () =>
  Promise.resolve({ ok: false, error: "closing is not what this test is about" });

const commandDeps = (over: Partial<BossCommandDeps> = {}): BossCommandDeps => ({
  db,
  threads: {
    post: () => Promise.resolve({ ts: "ts-command" }),
    permalink: (ts: string) => Promise.resolve(permalinkFor(ts)),
  },
  closeIncident: refuseClose,
  rotationGroupId: ROTATION,
  ...over,
});

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
    d.prepare("DELETE FROM boss_inbox").run();
    d.prepare("DELETE FROM pending_directive").run();
    d.prepare("DELETE FROM pending_question").run();
    d.prepare("DELETE FROM incident_wait").run();
    d.prepare("DELETE FROM signal").run();
    d.prepare("DELETE FROM incident_thread").run();
    d.prepare("DELETE FROM incident").run();
    d.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES ('inc-1','INVESTIGATING',1)",
    ).run();
  });
});

// ---------------------------------------------------------------------------

describe("SQL access is read-only", () => {
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
    const [, query] = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });
    const out = await query.run({ sql: "DELETE FROM incident" });

    assert.match(out, /^Rejected: /);
    assert.equal(db.query("SELECT id FROM incident").length, 1);
  });

  // The Slack agent runs the same guard triage does now, so what it accepts
  // and what it refuses is settled in triage/triage.test.ts. What is left to
  // check here is the wiring: that a refusal still reaches the model as
  // "Rejected: <reason>" carrying that guard's words, and that a query the
  // shared guard accepts actually runs.
  test("a refusal carries the shared guard's reason in this surface's shape", async () => {
    const { store } = memoryStore();
    const [, query] = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });

    assert.equal(
      await query.run({ sql: "SELECT 1; DROP TABLE incident" }),
      "Rejected: one statement at a time; remove the extra ';'",
    );
    assert.equal(await query.run({ sql: "   " }), "Rejected: empty query");
    assert.equal(
      await query.run({ sql: "UPDATE incident SET status='CLOSED'" }),
      "Rejected: read-only access: statements must start with SELECT, WITH or EXPLAIN",
    );
    assert.equal(
      await query.run({ sql: "WITH t AS (SELECT 1) UPDATE incident SET status='CLOSED'" }),
      "Rejected: read-only access: UPDATE is not allowed",
    );
  });

  test("a read the guard accepts runs, semicolon and quoted keywords included", async () => {
    const { store } = memoryStore();
    const [, query] = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });

    assert.match(await query.run({ sql: "SELECT id FROM incident;" }), /inc-1/);
    assert.equal(
      await query.run({
        sql: "SELECT id FROM incident WHERE rootCause LIKE '%DROP TABLE%'",
      }),
      "0 rows.",
    );
  });

  test("get_incident carries the incident and its signals whole", async () => {
    // It used to be cut at 100,000 characters. Unreachable on most
    // incidents and not on all of them -- an incident that ran for days
    // with a wide alert body is exactly the one somebody asks about -- and
    // the cut landed on JSON, so what came back would not even parse.
    const tail = "and the write path saturated first";
    await db.withWrite((d) => {
      d.prepare(
        `INSERT INTO incident (id, status, owner, prUrls, firstSignalAt, postmortem)
         VALUES ('inc-wide','INVESTIGATING','agent','[]',1,?)`,
      ).run(`${"y".repeat(150_000)} ${tail}`);
      d.prepare(
        "INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt, incidentId) VALUES (?, 'grafana', ?, 'alert', ?, 'b', 1, 'inc-wide')",
      ).run("s-wide", "fp-wide", `${"t".repeat(20_000)} ${tail}`);
    });

    const { store } = memoryStore();
    const tool = buildTools({ db, store, ...toolExtras(), commands: commandDeps() }).find((t) => t.name === "get_incident");
    assert.ok(tool);
    const out = await tool.run({ incidentId: "inc-wide" });

    assert.ok(out.includes(tail), "the end of the signal body is there");
    assert.doesNotThrow(() => JSON.parse(out), "and it is still JSON");
  });

  test("stay_silent refuses, and records nothing, on a run that must answer", async () => {
    const { store } = memoryStore();
    const build = (allowed: boolean) => {
      const extras = toolExtras();
      extras.silence.allowed = allowed;
      const tool = buildTools({ db, store, ...extras, commands: commandDeps() }).find((t) => t.name === STAY_SILENT_TOOL);
      assert.ok(tool);
      return { tool, silence: extras.silence };
    };

    const allowed = build(true);
    assert.match(await allowed.tool.run({ reason: "two people talking" }), /^Silence recorded/, "premise: where silence is allowed it is recorded");
    assert.equal(allowed.silence.reason, "two people talking");

    const tagged = build(false);
    assert.match(await tagged.tool.run({ reason: "two people talking" }), /^Refused: this message tags you/);
    assert.equal(tagged.silence.reason, null);
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
    const [, query] = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });
    const out = await query.run({ sql: "SELECT * FROM signal" });

    assert.equal(out.split("\n").length, MAX_SQL_ROWS + 1, "rows are capped");
    assert.match(out, /first 50 shown/);
    // Rows, and only rows. Each one comes back whole: a row cut at 2,000
    // characters is a row the model reads as complete and answers off, and
    // what got cut was whichever column happened to be last. The bound on
    // the context is `compactTranscript`, which drops whole rounds.
    for (const line of out.split("\n").slice(0, MAX_SQL_ROWS)) {
      assert.ok(line.includes("y".repeat(5000)), "the row is whole");
      assert.ok(!line.includes("truncated"));
    }
  });
});

// ---------------------------------------------------------------------------

describe("search_incidents on the Slack agent", () => {
  const searchTool = () => {
    const { store } = memoryStore();
    const tool = buildTools({ db, store, ...toolExtras(), commands: commandDeps() }).find(
      (t) => t.name === "search_incidents",
    );
    assert.ok(tool, "the Slack agent can reach the search triage has");
    return tool;
  };

  const seedClosed = async () => {
    await db.withWrite((w) => {
      w.prepare("DELETE FROM incident_fts").run();
      w.prepare(
        `INSERT INTO incident
           (id, status, owner, prUrls, firstSignalAt, resolvedAt, closedAt,
            postmortem, rootCause, resolvedEvidence)
         VALUES ('inc-old','CLOSED','agent','[]',1000,2000,3000,?,?,'the alert went quiet')`,
      ).run(
        "## Summary\nthe connection pool ran out under the morning spike",
        "the connection pool was exhausted",
      );
      indexIncident(w, "inc-old");
    });
  };

  /**
   * Text that reduces to no searchable terms, and does so by the length rule
   * rather than by the stopword list.
   *
   * `toMatchQuery` drops a term that is under MIN_TERM_CHARS *or* is a
   * stopword. A fixture leaning on the second is tautological: a sentence of
   * common words is unsearchable only for as long as those exact words stay
   * on the list, and if one leaves it the input becomes a real search
   * returning zero hits -- so this test would quietly stop distinguishing
   * "nothing like this" from "no search ran" and still pass. The premise is
   * asserted below rather than assumed, so shrinking either rule fails here
   * loudly instead.
   */
  const UNSEARCHABLE = "a b c";

  // The three answers the tool has to keep apart. Somebody asking "have we
  // seen this before" gets a wrong answer from two of them collapsing: a
  // search that never ran, reported as nothing found, reads as "this is new".
  test("a hit, nothing in the corpus, and a search that never ran stay three answers", async () => {
    await seedClosed();
    const tool = searchTool();

    const hit = await tool.run({ text: "connection pool exhausted" });
    const nothing = await tool.run({ text: "certificate rotation expiry" });
    const never = await tool.run({ text: UNSEARCHABLE });

    // The fixture's premise, checked: this text reaches FTS5 with no query
    // at all, while the other two do produce one. Without this the test
    // rests on a word list it does not own.
    assert.equal(toMatchQuery(UNSEARCHABLE), null, "the unsearchable fixture became searchable");
    assert.notEqual(toMatchQuery("certificate rotation expiry"), null, "the empty-corpus fixture stopped searching");

    assert.match(hit, /inc-old/);
    assert.match(hit, /connection pool was exhausted/);
    assert.match(nothing, /^0 matches/);
    assert.match(never, /^error:/);
    assert.match(never, /did not run/);
    assert.notEqual(
      nothing,
      never,
      "one answer for both is the bug: the agent cannot tell it failed to search",
    );
  });

  test("a hit carries the recorded cause whole", async () => {
    // It used to be cut at 300 characters. The search is how an agent finds
    // the same cause coming back through a different alert, and what makes
    // that judgement is the cause -- the excerpt beside it is only where the
    // words matched.
    const tail = "and only on the write path, which has a pool of its own";
    await db.withWrite((w) => {
      w.prepare("DELETE FROM incident_fts").run();
      w.prepare(
        `INSERT INTO incident
           (id, status, owner, prUrls, firstSignalAt, resolvedAt, closedAt,
            postmortem, rootCause, resolvedEvidence)
         VALUES ('inc-long','CLOSED','agent','[]',1000,2000,3000,?,?,'quiet')`,
      ).run(
        "## Summary\nthe connection pool ran out under the morning spike",
        `${"c".repeat(2000)} ${tail}`,
      );
      indexIncident(w, "inc-long");
    });

    const hit = await searchTool().run({ text: "connection pool exhausted" });

    assert.match(hit, /inc-long/);
    assert.ok(hit.includes(tail), "the end of the cause is there");
    assert.doesNotMatch(hit, /truncated/);
  });

  test("the prompt tells the model the tool exists and how to read it", () => {
    assert.match(SLACK_AGENT_SYSTEM, /- search_incidents:/);
    assert.match(SLACK_AGENT_SYSTEM, /the search did not run/);
  });
});

// ---------------------------------------------------------------------------

describe("prefix binding", () => {
  test("the tool specs are byte-identical across builds and database states", async () => {
    const specs = () =>
      JSON.stringify(
        buildTools({ db, store: memoryStore().store, ...toolExtras(), commands: commandDeps() }).map(
          ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
        ),
      );

    const before = specs();
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident (id, status, firstSignalAt) VALUES ('inc-2','FIXING',2)",
      ).run();
    });

    assert.equal(specs(), before);
    assert.deepEqual(
      buildTools({ db, store: memoryStore().store, ...toolExtras(), commands: commandDeps() }).map((t) => t.name),
      [
        "get_incident",
        "query_incidents",
        "read_agent_session",
        "search_incidents",
        "incident_board",
        "incident_status",
        "stay_silent",
        "open_incident",
        "message_agent",
        "close_incident",
        "merge_incidents",
        "stop_agent",
        "page_rotation",
      ],
      "order is part of the prefix, and the write tools come after the reads",
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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

describe("an untagged follow-up in a thread the Boss is already in", () => {
  const build = () => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store } = memoryStore();
    const agent = new SlackAgent({
      summaryModel: noSummaryModel,
      openIncident: refuseOpen,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
    });
    return { model, slack, agent };
  };

  test("may choose silence, which posts nothing and is logged", async () => {
    const { model, slack, agent } = build();
    model.state.reply = "";
    model.state.silence = "they are talking to each other";
    const lines = await captureLogs(() => agent.handle(mention({ ts: "100.2", text: "lunch?", tagged: false })));
    assert.equal(model.runs[0].allowSilence, true, "premise: the harness was told silence is allowed");
    assert.equal(slack.posts.length, 0);
    assert.ok(lines.some((l) => l.includes('"event":"stay_silent"') && l.includes("talking to each other")));
  });

  test("an empty run without stay_silent is a failure the thread hears about", async () => {
    const { model, slack, agent } = build();
    model.state.reply = "";
    const lines = await captureLogs(() => agent.handle(mention({ ts: "100.2", text: "can you close incident 2?", tagged: false })));
    assert.ok(lines.some((l) => l.includes("followup_run_silent_unchosen") && l.includes('"level":"error"')));
    assert.equal(slack.posts.length, 1);
    assert.match(slack.posts[0].text, /could not finish/);
  });

  test("a tagged mention is never allowed silence", async () => {
    const { model, agent } = build();
    await captureLogs(() => agent.handle(mention({ ts: "100.3" })));
    assert.equal(model.runs[0].allowSilence, false);
  });
});

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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: {
        run: async () => {
          calls++;
          if (calls === 1) throw new Error("bedrock said no");
          return { text: "second time lucky", usage: emptyModelUsage() };
        },
      },
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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

  test("a long message somebody typed is replayed whole", async () => {
    // Each missed reply used to be cut at 2,000 characters on its way into
    // the prompt. It is a person catching the agent up on what they know,
    // and the pasted log or the sentence at the end is the part they went
    // to the trouble for.
    const { model, slack, agent } = build();
    await agent.handle(mention({ ts: "100.0" }));

    const tail = "and it only started after the Tuesday deploy";
    slack.state.replies = [
      {
        user: "U0OTHER",
        botId: null,
        text: `${"l".repeat(20_000)}\n${tail}`,
        ts: "150.0",
      },
    ];
    await agent.handle(mention({ ts: "200.0", text: `<@${BOT}> and now?` }));

    const second = model.runs[1];
    assert.ok(second.input.includes(tail), "the end of what they wrote is there");
    assert.ok(second.input.includes("l".repeat(20_000)), "and so is the rest");
    assert.doesNotMatch(second.input, /truncated/);
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store: { ...store, put: () => Promise.reject(new Error("s3 500")) },
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
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
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
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
      config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
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
      config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
  test("it finds the archived session under the incident prefix, and counts turns", async () => {
    const { store, objects } = memoryStore();
    const said = (text: string) =>
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    objects.set(
      "sessions/incident/inc-1/session.jsonl",
      [said("first look"), said("second look"), said("third look")].join("\n"),
    );
    const [, , read] = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });

    const out = await read.run({ incidentId: "inc-1", turns: 2 });
    assert.match(out, /3 turns, last 2/);
    assert.match(out, /third look/);
    assert.doesNotMatch(out, /first look/);
    assert.doesNotMatch(out, /"role":/, "a rendering, not the JSONL");
  });

  test("a missing session says so rather than inventing one", async () => {
    const { store } = memoryStore();
    const [, , read] = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });
    const out = await read.run({ incidentId: "inc-404" });
    assert.match(out, /No session under sessions\/incident\/inc-404\//);
  });
});

// ---------------------------------------------------------------------------

/**
 * Linking used to live here: the tools handed back a `threadPermalink` and
 * the system prompt asked the model to write `<permalink|incident 4>` with
 * it. A prompt instruction is followed probabilistically, so some answers
 * linked and some did not and the casing wandered inside one message.
 *
 * Rendering is code now (`slack/incidents.ts`), running over every outbound
 * message from every surface, and it is tested there and end to end. What is
 * left here is the guard that the second mechanism does not come back: a
 * model holding one way to link and the client holding another is the
 * arrangement that produced the inconsistency.
 */
describe("the Slack agent hands back no links of its own", () => {
  const withThread = (id: string, threadTs: string) =>
    db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = ? WHERE id = ?").run(
        threadTs,
        id,
      );
    });

  test("get_incident reports the thread ts, never a url", async () => {
    await withThread("inc-1", "400.0");
    const [get] = buildTools({ db, store: memoryStore().store, ...toolExtras(), commands: commandDeps() });

    const out = await get.run({ incidentId: "inc-1" });

    assert.match(out, /"slackThreadTs": "400.0"/, "the row is still whole");
    assert.doesNotMatch(out, /threadPermalink/);
    assert.doesNotMatch(out, /goodparty\.slack\.com/);
  });

  test("query_incidents does not decorate a row that names a thread", async () => {
    await withThread("inc-1", "400.0");
    const [, query] = buildTools({ db, store: memoryStore().store, ...toolExtras(), commands: commandDeps() });

    const out = await query.run({
      sql: "SELECT id, slackThreadTs FROM incident WHERE slackThreadTs IS NOT NULL",
    });

    assert.match(out, /"inc-1"/);
    assert.doesNotMatch(out, /threadPermalink/);
  });

  /**
   * The instruction that used to live here is what this change removed. It
   * asked the model to write `<permalink|incident 4>` itself, and putting it
   * back would not merely be redundant: an assembled link and a rendered one
   * would nest.
   */
  test("the prompt no longer asks the model to build links itself", () => {
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /<permalink\|/);
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /assemble a Slack URL/);
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /threadPermalink/);
    assert.match(SLACK_AGENT_SYSTEM, /capitalised and linked to its thread for you/);
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
    return Promise.resolve(`${String(input.incidentId)} is FIXING, an agent is on it`);
  },
});

/**
 * A window wide enough that nothing in these tests compacts. Compaction has
 * its own tests, which set it deliberately small; here it would only be a
 * second thing going on.
 */
const TEST_CONTEXT_WINDOW = 1_000_000;

const runRequest = (
  tools: SlackAgentTool[],
  maxTurns: number,
): SlackAgentRun => ({
  system: SLACK_AGENT_SYSTEM,
  tools,
  sessionKey: "sessions/slack/C0DEVALERTS/100.0/",
  fresh: true,
  input: "<@U0HUMAN> says: what is the state of the various incidents?",
  maxTurns,
  allowSilence: false,
});

describe("a run that uses its whole budget", () => {
  test("answers with what it read instead of an apology", async () => {
    const { store } = memoryStore();
    const requests: ModelRequest[] = [];
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: (request) => {
        requests.push(request);
        // The wrap-up is the call that arrives with nothing to call.
        if (request.tools.length === 0) {
          return Promise.resolve({
            text: "Two of the three are open and I read inc-1; I did not reach inc-2.",
            toolCalls: [],
            usage: emptyModelUsage(),
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
          usage: emptyModelUsage(),
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
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: (request) => {
        if (request.tools.length === 0) {
          return Promise.reject(new Error("bedrock throttled"));
        }
        return Promise.resolve({
          text: "So far: inc-1 is being worked by an agent.",
          toolCalls: [
            { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
          ],
          usage: emptyModelUsage(),
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
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: (request) => {
        seen.push(request);
        if (request.tools.length === 0) {
          return wrapUpFails
            ? Promise.reject(new Error("bedrock throttled"))
            : Promise.resolve({
                text: "",
                toolCalls: [],
                usage: emptyModelUsage(),
              } satisfies ModelReply);
        }
        // The second mention answers straight away, so what it is asked with
        // is the transcript the failed run left behind.
        if (!wrapUpFails) {
          return Promise.resolve({
            text: "inc-1 is still being worked.",
            toolCalls: [],
            usage: emptyModelUsage(),
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
          ],
          usage: emptyModelUsage(),
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
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: (request) =>
        Promise.resolve(
          request.tools.length === 0
            ? ({
                text: "",
                toolCalls: [],
                usage: emptyModelUsage(),
              } satisfies ModelReply)
            : ({
                text: "",
                toolCalls: [
                  { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
                ],
                usage: emptyModelUsage(),
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
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: () =>
        Promise.resolve({
          text: "",
          toolCalls: [],
          usage: emptyModelUsage(),
        } satisfies ModelReply),
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

describe("a run that may stay silent", () => {
  const narratingThen = (finalText: string): SizedModelClient => {
    let calls = 0;
    return {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: () => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            text: "Let me look at the incident first.",
            toolCalls: [
              { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
            ],
            usage: emptyModelUsage(),
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: finalText,
          toolCalls: [],
          usage: emptyModelUsage(),
        } satisfies ModelReply);
      },
    };
  };

  test("hands back nothing, not narration or an apology, when the last turn says nothing", async () => {
    const { store } = memoryStore();
    const reads: string[] = [];
    let answer: string | null = null;
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(narratingThen(""), store).run({
        ...runRequest([countingTool(reads)], 3),
        allowSilence: true,
      });
      answer = result.text;
    });

    assert.deepEqual(reads, ["inc-1"], "the narrating turn really did call a tool first");
    assert.equal(answer, "");
    assert.ok(!lines.some((l) => l.includes("slack_agent_no_answer")));
  });

  test("hands back only the final turn's text", async () => {
    const { store } = memoryStore();
    const reads: string[] = [];
    const result = await createSlackAgentModel(
      narratingThen("inc-1 is being worked by an agent."),
      store,
    ).run({ ...runRequest([countingTool(reads)], 3), allowSilence: true });

    assert.deepEqual(reads, ["inc-1"]);
    assert.equal(result.text, "inc-1 is being worked by an agent.");
  });

  test("a mention without silence still answers from the narration rather than apologising", async () => {
    const { store } = memoryStore();
    const result = await createSlackAgentModel(narratingThen(""), store).run(
      runRequest([countingTool([])], 3),
    );
    assert.equal(result.text, "Let me look at the incident first.");
  });
});

// ---------------------------------------------------------------------------

/** A tool the harness executes but never asks anything about, so it can stand in for close_incident, message_agent, or any other write tool called alongside stay_silent. */
const spyTool = (name: string, calls: unknown[]) => ({
  name,
  description: "test tool",
  inputSchema: { type: "object" } as Record<string, unknown>,
  run: (input: Record<string, unknown>) => {
    calls.push(input);
    return Promise.resolve(`${name} ran`);
  },
});

const staySilentTool = (reasons: string[]) => ({
  name: STAY_SILENT_TOOL,
  description: "test stay_silent",
  inputSchema: { type: "object" } as Record<string, unknown>,
  run: (input: Record<string, unknown>) => {
    reasons.push(String(input.reason));
    return Promise.resolve(
      "Silence recorded. The run ends here; anything else you write in this turn is discarded, not posted.",
    );
  },
});

describe("stay_silent is terminal", () => {
  test("a tool called in the same turn still runs, and nothing more is requested once stay_silent is called", async () => {
    const { store } = memoryStore();
    const closeCalls: unknown[] = [];
    const reasons: string[] = [];
    let completions = 0;
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: () => {
        completions++;
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-close", name: "close_incident", input: { reason: "evidence" } },
            { id: "call-silent", name: STAY_SILENT_TOOL, input: { reason: "the closed notice already says it" } },
          ],
          usage: emptyModelUsage(),
        } satisfies ModelReply);
      },
    };

    const result = await createSlackAgentModel(model, store).run({
      ...runRequest([spyTool("close_incident", closeCalls), staySilentTool(reasons)], 5),
      allowSilence: true,
    });

    assert.equal(completions, 1, "stay_silent ends the run before a second request goes out");
    assert.equal(closeCalls.length, 1, "close_incident, called in the same turn, still ran");
    assert.deepEqual(reasons, ["the closed notice already says it"]);
    assert.equal(result.text, "", "nothing is posted once silence is chosen");
  });

  test("discards text written in the same turn as stay_silent, and logs the discard", async () => {
    const { store } = memoryStore();
    const reasons: string[] = [];
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: () =>
        Promise.resolve({
          text: "Here is an answer anyway.",
          toolCalls: [
            { id: "call-silent", name: STAY_SILENT_TOOL, input: { reason: "two people talking to each other" } },
          ],
          usage: emptyModelUsage(),
        } satisfies ModelReply),
    };

    let answer = "";
    const lines = await captureLogs(async () => {
      const result = await createSlackAgentModel(model, store).run({
        ...runRequest([staySilentTool(reasons)], 5),
        allowSilence: true,
      });
      answer = result.text;
    });

    assert.equal(answer, "", "the narration written alongside the tool call is never posted");
    assert.deepEqual(reasons, ["two people talking to each other"]);
    assert.ok(
      lines.some((l) => l.includes("slack_agent_stay_silent_text_discarded")),
      "the discard is logged",
    );
  });

  test("on a run that must answer, stay_silent ends nothing and the answer already written is posted", async () => {
    const { store } = memoryStore();
    let completions = 0;
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: () => {
        completions++;
        return Promise.resolve(
          completions === 1
            ? ({
                text: "Incident 94 is fixed; the PR merged an hour ago.",
                toolCalls: [{ id: "call-silent", name: STAY_SILENT_TOOL, input: { reason: "nothing more to add" } }],
                usage: emptyModelUsage(),
              } satisfies ModelReply)
            : ({ text: "", toolCalls: [], usage: emptyModelUsage() } satisfies ModelReply),
        );
      },
    };
    const refusing = {
      ...staySilentTool([]),
      run: () => Promise.resolve("Refused: this message tags you, so it is always answered. Write your reply."),
    };

    const result = await createSlackAgentModel(model, store).run({
      ...runRequest([refusing], 5),
      allowSilence: false,
    });

    assert.equal(completions, 2, "the refusal went back to the model instead of ending the run");
    assert.equal(result.text, "Incident 94 is fixed; the PR merged an hour ago.");
  });

  test("does not exhaust the budget or run a wrap-up when stay_silent is called on the final turn", async () => {
    const { store } = memoryStore();
    const reasons: string[] = [];
    let completions = 0;
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: () => {
        completions++;
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-silent", name: STAY_SILENT_TOOL, input: { reason: "nothing here is for me" } }],
          usage: emptyModelUsage(),
        } satisfies ModelReply);
      },
    };

    const lines = await captureLogs(async () => {
      await createSlackAgentModel(model, store).run({
        ...runRequest([staySilentTool(reasons)], 1),
        allowSilence: true,
      });
    });

    assert.equal(completions, 1, "the single turn the budget allowed, and nothing after it");
    assert.ok(!lines.some((l) => l.includes("slack_agent_turns_exhausted")));
  });
});

describe("the turn budget", () => {
  /** What was open the day a question about all of them went unanswered. */
  const OPEN_INCIDENTS = 11;

  test("covers reading every open incident and still answering", async () => {
    const { store } = memoryStore();
    const reads: string[] = [];
    let turn = 0;
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
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
            usage: emptyModelUsage(),
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
          usage: emptyModelUsage(),
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
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

  // Status used to be composed by the model, and came out a different shape
  // every time it was asked. It is rendered by code now, so what the prompt
  // has to carry is that the card is pasted, not rewritten.
  test("the prompt sends status questions to the rendered card and the board, verbatim", () => {
    assert.match(SLACK_AGENT_SYSTEM, /call incident_status and post the card exactly as it comes back/);
    assert.match(SLACK_AGENT_SYSTEM, /at most one sentence of your own/);
    assert.match(SLACK_AGENT_SYSTEM, /Never rewrite, reorder, reformat or summarise the card/);
    assert.match(SLACK_AGENT_SYSTEM, /"what needs me\?" is incident_board, pasted as it comes back/);
    assert.match(SLACK_AGENT_SYSTEM, /About 200 words/);
    assert.match(SLACK_AGENT_SYSTEM, /Plain terms/);
  });
});

// ---------------------------------------------------------------------------

describe("what a question cost", () => {
  const spent = (tokens: number): ModelUsage => ({
    tokensIn: tokens,
    tokensOut: 1,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: tokens / 1000,
    modelId: "anthropic.test",
    calls: 1,
  });

  test("every turn is banked, the wrap-up included", async () => {
    const { store } = memoryStore();
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: (request) =>
        Promise.resolve(
          request.tools.length === 0
            ? ({
                text: "inc-1 is being worked, and that is as far as I got.",
                toolCalls: [],
                usage: spent(5),
              } satisfies ModelReply)
            : ({
                text: "",
                toolCalls: [
                  { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
                ],
                usage: spent(100),
              } satisfies ModelReply),
        ),
    };

    let usage = emptyModelUsage();
    await captureLogs(async () => {
      usage = (
        await createSlackAgentModel(model, store).run(runRequest([countingTool([])], 2))
      ).usage;
    });

    assert.equal(usage.calls, 3, "two turns and the wrap-up");
    assert.equal(usage.tokensIn, 205);
    assert.equal(usage.modelId, "anthropic.test");
  });

  // A wrap-up that failed still spent what it spent, and this is the run that
  // most needs costing: it is the one that cost the most and answered least.
  test("a wrap-up that throws still reports what it spent", async () => {
    const { store } = memoryStore();
    const model: SizedModelClient = {
      contextWindow: TEST_CONTEXT_WINDOW,
      complete: (request) =>
        request.tools.length === 0
          ? Promise.reject(new ModelRequestFailed("bedrock throttled", spent(7)))
          : Promise.resolve({
              text: "inc-1 is being worked.",
              toolCalls: [
                { id: "call-1", name: "get_incident", input: { incidentId: "inc-1" } },
              ],
              usage: spent(100),
            } satisfies ModelReply),
    };

    let usage = emptyModelUsage();
    await captureLogs(async () => {
      usage = (
        await createSlackAgentModel(model, store).run(runRequest([countingTool([])], 1))
      ).usage;
    });

    assert.equal(usage.calls, 2, "the failed wrap-up is a call that happened");
    assert.equal(usage.tokensIn, 107);
  });

  test("the answered line carries the tokens", async () => {
    const { store } = memoryStore();
    const slack = fakeSlack();
    const agent = new SlackAgent({
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: { run: () => Promise.resolve({ text: "two are open.", usage: spent(120) }) },
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
    });

    const lines = await captureLogs(() => agent.handle(mention()));
    const answered = lines.find((l) => l.includes('"event":"answered"'));
    assert.ok(answered, "the run was answered");
    const parsed = JSON.parse(answered) as Record<string, unknown>;
    assert.equal(parsed.tokensIn, 120);
    assert.equal(parsed.modelCalls, 1);
    assert.equal(parsed.modelId, "anthropic.test");
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
    const tools = buildTools({ db, store, ...toolExtras(), commands: commandDeps() });
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

  // The reader used to cut its own answer at 24,000 characters, and then
  // handed back raw JSONL lines instead, sixty of which were 199,928
  // characters in prod. The bound is a count of turns now, and nothing is cut.
  test("the tail is the turns asked for, bounded by count rather than width", async () => {
    const out = await readSession(
      Array.from({ length: 20_000 }, (_, i) => turn(`turn number ${i} checked the deploy`)),
    );

    assert.match(out, /was killed after 20000 turns/);
    assert.match(out, /20000 turns, last 15/);
    assert.ok(out.includes("turn number 19999 checked the deploy"), "the last turn is there, whole");
    assert.ok(out.includes("turn number 19985 checked the deploy"), "and so are the fifteen asked for");
    assert.ok(!out.includes("turn number 19984 "), "and nothing before them");
    assert.ok(!out.includes("truncated"));
  });

  // The Slack agent is what a human asks "what did incident 7 cost", and it
  // answers out of this tool result. A dollar figure that does not say it is
  // an estimate gets quoted back as though somebody had seen a bill.
  test("reports spend, and never states the dollar figure as a fact", async () => {
    const priced = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "us.anthropic.claude-opus-5",
        usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cost: { total: 18.51 } },
      },
    });
    const out = await readSession([priced, priced]);
    assert.match(out, /spend: 2 turns, 740 tokens on us\.anthropic\.claude-opus-5/);
    assert.match(out, /estimated cost \$37\.02/);
    assert.match(out, /not an invoiced figure/);
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

// ---------------------------------------------------------------------------

/**
 * What replaced the per-result character caps. The difference is the whole
 * point and is what each of these asserts: a tool result lands whole, and
 * what gives way when the transcript will not fit is the oldest complete
 * round rather than the middle of a row.
 */
describe("compacting the transcript instead of cutting results", () => {
  const round = (n: number, width: number): ModelTurn[] => [
    { role: "user", text: `question ${n}` },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: `call-${n}`, name: "query_incidents", input: {} }],
    },
    { role: "toolResult", toolCallId: `call-${n}`, text: `${n}:${"r".repeat(width)}` },
  ];

  test("a transcript that fits is handed back untouched", () => {
    const messages = [...round(1, 100), ...round(2, 100)];
    const { messages: kept, dropped } = compactTranscript(messages, 1_000_000);

    assert.equal(dropped, 0);
    assert.deepEqual(kept, messages);
  });

  test("the oldest rounds go, whole, and the newest work stays", () => {
    // Four rounds at 30k characters each against a window that leaves room
    // for roughly two of them.
    const messages = [1, 2, 3, 4].flatMap((n) => round(n, 30_000));
    const window = SLACK_AGENT_RESERVE_TOKENS + 25_000;

    const { messages: kept, dropped } = compactTranscript(messages, window);

    assert.ok(dropped > 0, "something had to give");
    const text = kept.map((turn) => turn.text).join("\n");
    assert.ok(text.includes(`4:${"r".repeat(30_000)}`), "the newest result is whole");
    assert.ok(!text.includes("1:"), "the oldest round is gone");
    // Nothing anywhere is a fragment of a result.
    for (const turn of kept) {
      if (turn.role !== "toolResult") continue;
      assert.match(turn.text, /^\d+:r{30000}$/, "a result is whole or it is absent");
    }
  });

  test("the cut lands on a round boundary, never between a call and its result", () => {
    const messages = [1, 2, 3, 4, 5].flatMap((n) => round(n, 30_000));
    const { messages: kept } = compactTranscript(
      messages,
      SLACK_AGENT_RESERVE_TOKENS + 25_000,
    );

    // Anthropic rejects a tool result that does not sit behind the assistant
    // message that called for it, so a transcript opening on one is a 400
    // rather than a smaller request.
    assert.equal(kept[0]?.role, "user");
    for (const [index, turn] of kept.entries()) {
      if (turn.role !== "toolResult") continue;
      assert.equal(kept[index - 1]?.role, "assistant", "a result follows its call");
    }
  });

  test("the model is told rounds are gone rather than left to infer it", () => {
    const messages = [1, 2, 3, 4].flatMap((n) => round(n, 30_000));
    const { messages: kept, dropped } = compactTranscript(
      messages,
      SLACK_AGENT_RESERVE_TOKENS + 25_000,
    );

    // On a user turn rather than as a turn of its own: two consecutive user
    // messages is a shape the request builder rejects.
    assert.equal(kept[0]?.role, "user");
    assert.match(kept[0].text, new RegExp(`${dropped} earlier turns`));
    assert.match(kept[0].text, /no longer in context/);
  });

  test("the question survives a cut that reached past it", () => {
    // One mention is one user turn and then however many tool rounds it
    // takes, so the cut routinely lands inside the run rather than on a
    // mention boundary -- and a transcript that opens on the third round
    // of an investigation, with nothing saying what was asked, is a model
    // answering a question it cannot see.
    const messages: ModelTurn[] = [
      { role: "user", text: "what is the state of the various incidents?" },
      ...[1, 2, 3, 4].flatMap((n) => round(n, 30_000).slice(1)),
    ];

    const { messages: kept } = compactTranscript(
      messages,
      SLACK_AGENT_RESERVE_TOKENS + 25_000,
    );

    assert.equal(kept[0]?.role, "user");
    assert.ok(kept[0].text.includes("what is the state of the various incidents?"));
    assert.equal(kept[1]?.role, "assistant", "and a round follows it");
  });

  test("a second compaction folds its count into the first note, not on top of it", () => {
    // A long run compacts more than once, and the second pass lands on a
    // head turn the first pass already wrote a note onto. Stacked, the
    // model is told "4 earlier turns are gone" twice when the truth is
    // eight -- two claims that are each wrong, in place of one that is
    // right, in the one sentence whose whole job is to be accurate about
    // what it cannot see.
    const tail = (n: number): ModelTurn[] => [
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: `c${n}`, name: "query_incidents", input: {} }],
      },
      { role: "toolResult", toolCallId: `c${n}`, text: `${n}:${"r".repeat(30_000)}` },
    ];
    const window = SLACK_AGENT_RESERVE_TOKENS + 25_000;
    const question = "what is the state of the various incidents?";

    const first = compactTranscript(
      [{ role: "user", text: question }, ...[1, 2, 3, 4].flatMap(tail)],
      window,
    );
    const second = compactTranscript(
      [...first.messages, ...tail(5), ...tail(6)],
      window,
    );

    const head = second.messages[0];
    assert.equal(head.role, "user");
    const notes = head.text.match(/earlier turns? in this thread/g) ?? [];
    assert.equal(notes.length, 1, `one note, not ${notes.length}`);
    // And it stands for everything gone, not just this pass.
    assert.match(head.text, /\[8 earlier turns/);
    assert.ok(head.text.endsWith(question), "the question is still the last thing in it");
  });

  test("a note in the part being dropped carries its count forward too", () => {
    // The other half of the same accounting. Across mentions the surviving
    // head is a *later* question with no note of its own, and the noted
    // turn is in the region going away -- so its count leaves with it
    // unless it is carried, and the running total silently understates
    // what the model has lost.
    const tail = (n: number): ModelTurn[] => [
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: `c${n}`, name: "query_incidents", input: {} }],
      },
      { role: "toolResult", toolCallId: `c${n}`, text: `${n}:${"r".repeat(30_000)}` },
    ];
    const window = SLACK_AGENT_RESERVE_TOKENS + 25_000;

    // A head that already carries a note, produced rather than hand-written
    // so the test does not encode the note's wording.
    const first = compactTranscript(
      [
        { role: "user", text: "the first question" },
        ...[1, 2, 3, 4].flatMap(tail),
      ],
      window,
    );
    const noted = first.messages[0];
    assert.match(noted.text, /\[4 earlier turns/, "the fixture's premise");

    // A later mention: a fresh question and more rounds behind it.
    const second = compactTranscript(
      [noted, ...tail(5), { role: "user", text: "the second question" }, ...tail(6), ...tail(7)],
      window,
    );

    const head = second.messages[0];
    assert.equal(head.role, "user");
    assert.ok(head.text.endsWith("the second question"), "the live question survives");
    // Three turns went this pass and the note that went with them stood for
    // four more.
    assert.match(head.text, /\[7 earlier turns/);
    assert.equal((head.text.match(/earlier turns? in this thread/g) ?? []).length, 1);
  });

  test("one round larger than the window is kept rather than cut to fit", () => {
    // The same trade the incident agent makes. A result this size fails
    // loudly at the provider, and the reader is told the question was too
    // big -- which beats being answered off half a row.
    const messages = round(1, 5_000_000);
    const { messages: kept, dropped } = compactTranscript(messages, 200_000);

    assert.equal(dropped, 0);
    assert.deepEqual(kept, messages);
  });
});

describe("the turn loop compacts before it asks, not after", () => {
  /** A window that fits the reserve and about one wide result. */
  const NARROW = SLACK_AGENT_RESERVE_TOKENS + 20_000;

  const wideTool = (width: number): SlackAgentTool => ({
    name: "query_incidents",
    description: "Run one read-only SQL SELECT.",
    inputSchema: { type: "object" } as Record<string, unknown>,
    run: () => Promise.resolve("w".repeat(width)),
  });

  test("a wide tool result reaches the model whole, and older rounds go instead", async () => {
    const { store } = memoryStore();
    const requests: ModelRequest[] = [];
    const model: SizedModelClient = {
      contextWindow: NARROW,
      complete: (request) => {
        requests.push(request);
        // Three tool-calling turns, then an answer.
        if (requests.length > 3) {
          return Promise.resolve({
            text: "here is what I found",
            toolCalls: [],
            usage: emptyModelUsage(),
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: `call-${requests.length}`, name: "query_incidents", input: {} },
          ],
          usage: emptyModelUsage(),
        } satisfies ModelReply);
      },
    };

    const result = await createSlackAgentModel(model, store).run(
      runRequest([wideTool(25_000)], 6),
    );

    assert.equal(result.text, "here is what I found");
    // Every result the model was shown is a whole one. This is the
    // assertion the old caps failed: they made each result narrow enough to
    // fit, which is a row the model reads as complete and answers off.
    for (const request of requests) {
      for (const turn of request.messages) {
        if (turn.role !== "toolResult") continue;
        assert.equal(turn.text, "w".repeat(25_000), "a result arrives whole");
      }
    }
    // And the last request is smaller than the sum of everything that
    // happened, which is only true if something was dropped.
    const last = requests[requests.length - 1];
    assert.ok(
      last.messages.filter((turn) => turn.role === "toolResult").length < 3,
      "older rounds gave way rather than the results being narrowed",
    );
  });

  test("what it persists is a transcript the next mention can resume", async () => {
    // The failure this is here for does not show up in the run that causes
    // it. Compaction rewrites the array that is then written to the store,
    // and a follow-up mention loads that array back -- so a transcript left
    // opening on a tool result, or on two user turns, breaks hours later in
    // another process with nothing pointing back at the run that wrote it.
    const { store, objects } = memoryStore();
    const requests: ModelRequest[] = [];
    const model: SizedModelClient = {
      contextWindow: NARROW,
      complete: (request) => {
        requests.push(request);
        if (requests.length > 3) {
          return Promise.resolve({
            text: "here is what I found",
            toolCalls: [],
            usage: emptyModelUsage(),
          } satisfies ModelReply);
        }
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: `call-${requests.length}`, name: "query_incidents", input: {} },
          ],
          usage: emptyModelUsage(),
        } satisfies ModelReply);
      },
    };

    const run = runRequest([wideTool(25_000)], 6);
    await createSlackAgentModel(model, store).run(run);

    const stored = objects.get(`${run.sessionKey}transcript.json`);
    assert.ok(stored, "the transcript is written");
    const turns = JSON.parse(stored) as ModelTurn[];

    assert.ok(turns.length > 0);
    assert.equal(turns[0].role, "user", "a transcript has to open on a user turn");
    assert.equal(
      turns[turns.length - 1].role,
      "assistant",
      "and must not end on tool results, or the next load puts two user turns together",
    );
    for (const [index, turn] of turns.entries()) {
      if (turn.role === "toolResult") {
        assert.equal(turns[index - 1]?.role, "assistant", "no orphaned result");
      }
      if (turn.role === "user" && index > 0) {
        assert.notEqual(turns[index - 1]?.role, "user", "no two user turns together");
      }
    }
    // It is the compacted one, not the whole history re-saved -- otherwise
    // the next question re-grows the context and compacts it again, every
    // time.
    assert.ok(
      turns.filter((turn) => turn.role === "toolResult").length < 3,
      "the compacted transcript is what was persisted",
    );
  });
});

// ---------------------------------------------------------------------------

describe("the Boss in an incident thread", () => {
  const THREAD = "500.000100";

  const seed = async () => {
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, slackThreadTs, summary) VALUES ('7','FIXING',5,?,'Checkout failing')",
      ).run(THREAD);
    });
  };

  const build = (over: { closeIncident?: CloseIncident } = {}) => {
    const model = fakeModel();
    const slack = fakeSlack();
    const { store, objects } = memoryStore();
    const agent = new SlackAgent({
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION, incidentChannel: CHANNEL },
      closeIncident: over.closeIncident ?? refuseClose,
    });
    return { model, slack, store, objects, agent };
  };

  const human = (ts: string, text: string) => ({ kind: "human" as const, user: "U0HUMAN", text, ts });

  const opening: SlackMessage = {
    user: BOT,
    botId: "B0BUGBOSS",
    text: "*Checkout 5xx above 2%* -- opened by a Grafana alert",
    ts: THREAD,
  };

  test("a fresh session is told which incident this is and reads the whole thread, BugBoss posts included", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [
      opening,
      { user: BOT, botId: "B0BUGBOSS", text: "*Root cause found* -- the pool is too small", ts: "500.000200" },
      { user: "U0HUMAN", botId: null, text: "is this why checkout is slow?", ts: "500.000300" },
    ];

    await agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "is this why checkout is slow?") });

    assert.equal(model.runs.length, 1);
    assert.equal(slack.state.calls.length, 1, "a fresh session fetches the thread");
    assert.equal(slack.state.calls[0].threadTs, THREAD);
    assert.equal(slack.state.calls[0].channel, CHANNEL);
    assert.equal(slack.state.calls[0].oldest, undefined, "the whole thread, not a stretch of it");
    const input = model.runs[0].input;
    assert.match(input, /incident 7\. Status: FIXING\. Title: Checkout failing\./);
    assert.match(input, /BugBoss: \*Checkout 5xx above 2%\*/, "the opening message is the record");
    assert.match(input, /BugBoss: \*Root cause found\*/, "and so is every transition notice");
    assert.match(input, /<@U0HUMAN>: is this why checkout is slow\?/);
    assert.equal(model.runs[0].sessionKey, slackSessionPrefix(CHANNEL, THREAD));
    assert.equal(model.runs[0].allowSilence, true);
  });

  test("a resume reads everything since the watermark, bot posts included, except its own replies", async () => {
    await seed();
    const { model, slack, agent } = build();
    // Slack-shaped ts for what the Boss posts, so its own reply can come back
    // in the fetch the way it would in production.
    const post = slack.client.post;
    slack.client.post = async (threadTs, text, channel) => {
      await post(threadTs, text, channel);
      return { ts: `500.00040${slack.posts.length}` };
    };
    slack.state.replies = [opening, { user: "U0HUMAN", botId: null, text: "first", ts: "500.000300" }];
    model.state.reply = "It is, yes.";
    await agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "first") });
    assert.equal(slack.posts[0].text, "It is, yes.");
    assert.equal(slack.posts[0].threadTs, THREAD);
    assert.equal(slack.posts[0].channel, CHANNEL);

    slack.state.replies = [
      opening,
      { user: "U0HUMAN", botId: null, text: "first", ts: "500.000300" },
      { user: BOT, botId: "B0BUGBOSS", text: "It is, yes.", ts: "500.000401" },
      { user: BOT, botId: "B0BUGBOSS", text: "*Incident 7 resolved*", ts: "500.000500" },
      { user: "U0OTHER", botId: null, text: "second", ts: "500.000600" },
    ];
    await agent.handleIncident({ incidentId: "7", trigger: human("500.000600", "second") });

    assert.equal(model.runs.length, 2);
    assert.equal(model.runs[1].fresh, false);
    assert.equal(slack.state.calls[1].oldest, "500.000300");
    const input = model.runs[1].input;
    assert.match(input, /BugBoss: \*Incident 7 resolved\*/, "a notice posted since is shown");
    assert.match(input, /<@U0OTHER>: second/);
    assert.doesNotMatch(input, /It is, yes\./, "its own reply is already in its session");
    assert.doesNotMatch(input, /<@U0HUMAN>: first/, "nothing from before the watermark");
  });

  test("an agent's unseen rows are in the input as the agent's, and are seen once the run is over", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [opening];
    await db.withWrite((w) => {
      recordForBoss(w, { incidentId: "7", kind: "question", text: "Can someone confirm the deploy at 14:02 was a rollback?" });
      recordForBoss(w, { incidentId: "7", kind: "message", text: "PR opened." });
      recordForBoss(w, { incidentId: "7", kind: "escalation", text: "Still waiting after 2 hours." });
    });

    await agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } });

    const input = model.runs[0].input;
    assert.match(input, /From incident 7's agent, not seen by you before \(3\)/);
    assert.match(input, /\[question -- it is blocked until you answer it with message_agent\] Can someone confirm/);
    assert.match(input, /\[message\] PR opened\./);
    assert.match(input, /\[escalation -- it needs a person\] Still waiting/);
    assert.equal(
      db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length,
      0,
      "every row it was shown is marked",
    );
  });

  test("a run that fails leaves the rows unseen for the next one, and nobody in the thread is told", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const agent = new SlackAgent({
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store: memoryStore().store,
      slack: slack.client,
      model: { run: () => Promise.reject(new Error("bedrock said no")) },
      config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
    });
    await db.withWrite((w) => recordForBoss(w, { incidentId: "7", kind: "question", text: "q?" }));

    await captureLogs(() => agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } }));

    assert.equal(db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length, 1);
    assert.equal(slack.posts.length, 0, "an inbox run has nobody waiting in the thread");
  });

  test("a failed run a person triggered tells them", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const agent = new SlackAgent({
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store: memoryStore().store,
      slack: slack.client,
      model: { run: () => Promise.reject(new Error("bedrock said no")) },
      config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
    });
    await captureLogs(() => agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "hello?") }));
    assert.equal(slack.posts.length, 1);
    assert.match(slack.posts[0].text, /could not finish/);
    assert.equal(slack.posts[0].threadTs, THREAD);
  });

  test("a chosen silence posts nothing, and logs why at info", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [opening];
    model.state.reply = "";
    model.state.silence = "two people are talking to each other";
    const lines = await captureLogs(() =>
      agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "@dana can you look at this?") }),
    );
    assert.equal(model.runs.length, 1, "premise: the Boss did read it");
    assert.equal(slack.posts.length, 0);
    const chose = lines.find((l) => l.includes('"stay_silent"'));
    assert.ok(chose, "the silence is logged");
    assert.match(chose, /two people are talking to each other/);
    assert.match(chose, /"level":"info"/);
    assert.ok(lines.some((l) => l.includes("incident_answered") && l.includes('"spoke":false')));
  });

  test("a second message while the thread's run is in flight is not answered busy, and the same holder runs it", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [opening, { user: "U0HUMAN", botId: null, text: "first", ts: "500.000300" }];
    model.state.hold = true;

    const first = agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "first") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(model.runs.length, 1, "premise: the first run is in flight and holds the thread");

    // Slack has not caught up with the second message yet: it is only in the
    // trigger, which is the case the in-memory queue is for.
    await agent.handleIncident({ incidentId: "7", trigger: human("500.000400", "second, while you were thinking") });
    assert.equal(model.runs.length, 1, "no second run beside the first -- one session writer");
    assert.equal(slack.posts.length, 0, "and no busy reply");
    assert.doesNotMatch(model.runs[0].input, /second, while you were thinking/, "premise: the first run never saw it");

    model.state.hold = false;
    model.release();
    await first;

    assert.equal(model.runs.length, 2, "the holder ran again before letting go");
    assert.match(model.runs[1].input, /<@U0HUMAN>: second, while you were thinking/);
    assert.doesNotMatch(model.runs[1].input, /<@U0HUMAN>: first/, "the first message is not repeated");
    assert.ok(slack.posts.every((p) => !/Still working/.test(p.text)));
  });

  test("an agent row landing mid-run is read before the lock is released, even with no wake", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [opening];
    model.state.hold = true;

    const first = agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "status?") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(model.runs.length, 1);
    await db.withWrite((w) =>
      recordForBoss(w, { incidentId: "7", kind: "question", text: "Is the 14:02 deploy a rollback?" }),
    );
    assert.doesNotMatch(model.runs[0].input, /14:02/, "premise: the row was not there for the first run");

    model.state.hold = false;
    model.release();
    await first;

    assert.equal(model.runs.length, 2);
    assert.match(model.runs[1].input, /\[question -- it is blocked until you answer it with message_agent\] Is the 14:02 deploy a rollback\?/);
    assert.equal(db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length, 0);
  });

  test("a run with nothing new says nothing and spends nothing", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [opening];
    await agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "hi") });
    await agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } });
    assert.equal(model.runs.length, 1, "the wake had nothing behind it");
  });

  test("the agent's outstanding question is named in the input", async () => {
    await seed();
    const { model, slack, agent } = build();
    slack.state.replies = [opening];
    await db.withWrite((w) =>
      w
        .prepare("INSERT INTO pending_question (incidentId, messageTs, askedAt, message) VALUES ('7','',?,?)")
        .run(Date.now() - 5 * 60_000, "Was the 14:02 deploy a rollback?"),
    );
    await agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "yes it was") });
    assert.match(model.runs[0].input, /blocked on a question it asked 5 minute\(s\) ago.*Was the 14:02 deploy a rollback\?/);
  });

  test("an incident with no thread alarms and leaves its rows for later", async () => {
    await db.withWrite((d) => {
      d.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES ('8','INVESTIGATING',5)").run();
      recordForBoss(d, { incidentId: "8", kind: "question", text: "q?" });
    });
    const { model, agent } = build();
    const lines = await captureLogs(() => agent.handleIncident({ incidentId: "8", trigger: { kind: "inbox" } }));
    assert.equal(model.runs.length, 0);
    assert.ok(lines.some((l) => l.includes("incident_thread_missing")));
    assert.equal(db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("the Boss's write tools", () => {
  const tool = (name: string, over: Partial<BossCommandDeps> = {}) => {
    const found = buildTools({ db, store: memoryStore().store, ...toolExtras(), commands: commandDeps(over) }).find(
      (t) => t.name === name,
    );
    assert.ok(found, name);
    return found;
  };

  const directives = (incidentId: string): Directive[] =>
    db
      .query<{ payload: string }>("SELECT payload FROM pending_directive WHERE incidentId = ? ORDER BY id", [incidentId])
      .map((r) => JSON.parse(r.payload) as Directive);

  const EVIDENCE = "The error rate query has read zero for the last two hours and the agent's session shows the rollback deployed at 14:02.";

  test("message_agent hands the agent a boss_message", async () => {
    assert.equal(directives("inc-1").length, 0, "premise: nothing pending");
    const out = await tool("message_agent").run({ incidentId: "inc-1", text: "Dana says it was a rollback." });
    assert.match(out, /^Sent/);
    const [sent] = directives("inc-1");
    assert.equal(sent.type, "boss_message");
    assert.equal(sent.type === "boss_message" && sent.text, "Dana says it was a rollback.");
  });

  test("message_agent refuses an incident no agent is working", async () => {
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, resolvedAt, closedAt, postmortem) VALUES ('c1','CLOSED',1,2,3,'pm')",
      ).run();
    });
    const out = await tool("message_agent").run({ incidentId: "c1", text: "hello" });
    assert.match(out, /^Rejected: incident c1 is CLOSED/);
    assert.equal(directives("c1").length, 0);
  });

  test("close_incident goes through the tool API's close and refuses a reason that is not evidence", async () => {
    const calls: { incidentId: string; reason: string }[] = [];
    const closeIncident: CloseIncident = (args) => {
      calls.push(args);
      return Promise.resolve({ ok: true, from: "FIXING" });
    };
    const close = tool("close_incident", { closeIncident });

    assert.match(await close.run({ incidentId: "inc-1", reason: "fixed" }), /^Rejected: close_incident needs a reason that is evidence/);
    assert.equal(calls.length, 0, "a one-word reason never reaches the transition");

    const out = await close.run({ incidentId: "inc-1", reason: EVIDENCE });
    assert.deepEqual(calls, [{ incidentId: "inc-1", reason: EVIDENCE }]);
    assert.match(out, /closed \(it was FIXING\)/);
  });

  test("close_incident hands a refusal back as a refusal", async () => {
    const out = await tool("close_incident", {
      closeIncident: () => Promise.resolve({ ok: false, error: "incident inc-1 is MERGED" }),
    }).run({ incidentId: "inc-1", reason: EVIDENCE });
    assert.equal(out, "Rejected: incident inc-1 is MERGED");
  });

  test("merge_incidents keeps the older incident, moves the signals, and tells both threads through announce", async () => {
    await db.withWrite((d) => {
      d.prepare("INSERT INTO incident (id, status, firstSignalAt, slackThreadTs) VALUES ('11','FIXING',1,'600.1')").run();
      d.prepare("INSERT INTO incident (id, status, firstSignalAt, slackThreadTs) VALUES ('12','INVESTIGATING',2,'700.1')").run();
      d.prepare(
        "INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt, incidentId) VALUES ('s12','grafana','fp12','alert','t','b',2,'12')",
      ).run();
    });
    const posts: { threadTs: string | null; text: string }[] = [];
    const merge = tool("merge_incidents", {
      threads: {
        post: (threadTs, text) => {
          posts.push({ threadTs, text });
          return Promise.resolve({ ts: "x" });
        },
        permalink: (ts) => Promise.resolve(permalinkFor(ts)),
      },
    });

    // Named the wrong way round on purpose: the older record survives.
    const out = await merge.run({ fromIncidentId: "11", intoIncidentId: "12", reason: EVIDENCE });

    assert.match(out, /Incident 12 is now part of incident 11/);
    assert.equal(db.get<{ status: string }>("SELECT status FROM incident WHERE id = '12'")?.status, "MERGED");
    assert.equal(db.get<{ incidentId: string }>("SELECT incidentId FROM signal WHERE id = 's12'")?.incidentId, "11");
    assert.deepEqual(directives("12"), [{ type: "merged", into: "11" }]);
    assert.equal(directives("11")[0]?.type, "new_signals");
    assert.equal(posts[0].threadTs, "700.1", "the absorbed thread is told first");
    assert.match(posts[0].text, /same problem as incident 11/);
    assert.equal(posts[1].threadTs, "600.1");
    assert.match(posts[1].text, /Incident 12 is the same problem as this one/);
  });

  test("merge_incidents refuses what cannot take signals, and moves nothing", async () => {
    await db.withWrite((d) => {
      d.prepare("INSERT INTO incident (id, status, firstSignalAt, resolvedAt) VALUES ('21','RESOLVED',1,2)").run();
      d.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES ('22','FIXING',2)").run();
    });
    const out = await tool("merge_incidents").run({ fromIncidentId: "22", intoIncidentId: "21", reason: EVIDENCE });
    assert.match(out, /^Rejected: incident 21 is RESOLVED/);
    assert.equal(directives("22").length, 0);
  });

  test("stop_agent pushes a stop carrying the reason", async () => {
    const out = await tool("stop_agent").run({ incidentId: "inc-1", reason: EVIDENCE });
    assert.match(out, /will stop/);
    assert.deepEqual(directives("inc-1"), [{ type: "stop", reason: EVIDENCE }]);
  });

  test("page_rotation posts the rotation mention through code, into the incident's thread", async () => {
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = '800.1' WHERE id = 'inc-1'").run();
    });
    const posts: { threadTs: string | null; text: string }[] = [];
    const out = await tool("page_rotation", {
      threads: {
        post: (threadTs, text) => {
          posts.push({ threadTs, text });
          return Promise.resolve({ ts: "x" });
        },
        permalink: (ts) => Promise.resolve(permalinkFor(ts)),
      },
    }).run({ incidentId: "inc-1", reason: "The agent needs someone with prod access to confirm the migration ran." });
    assert.match(out, /has been paged/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].threadTs, "800.1");
    assert.ok(posts[0].text.startsWith(`<!subteam^${ROTATION}> `), posts[0].text);
  });

  test("a mention the model writes itself still posts as literal text", async () => {
    const { model, slack, agent } = (() => {
      const model = fakeModel();
      const slack = fakeSlack();
      const agent = new SlackAgent({
        openIncident: refuseOpen,
        summaryModel: noSummaryModel,
        db,
        store: memoryStore().store,
        slack: slack.client,
        model: model.model,
        config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: ROTATION, incidentChannel: CHANNEL },
        closeIncident: refuseClose,
      });
      return { model, slack, agent };
    })();
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = '800.1' WHERE id = 'inc-1'").run();
    });
    model.state.reply = `<!subteam^${ROTATION}> wake up`;
    await agent.handleIncident({ incidentId: "inc-1", trigger: { kind: "human", user: "U0HUMAN", text: "x", ts: "800.2" } });
    assert.equal(slack.posts.length, 1);
    assert.ok(!slack.posts[0].text.startsWith("<!subteam^"), slack.posts[0].text);
  });
});

// ---------------------------------------------------------------------------

describe("open_incident", () => {
  const recordingOpen = () => {
    const filed: Parameters<OpenIncident>[0][] = [];
    const open: OpenIncident = (report) => {
      filed.push(report);
      return Promise.resolve([{ incidentId: "91", action: "new_incident", reason: "new" }]);
    };
    return { filed, open };
  };

  const agentWith = (open: OpenIncident, model: SlackAgentModel) =>
    new SlackAgent({
      openIncident: open,
      summaryModel: noSummaryModel,
      db,
      store: memoryStore().store,
      slack: fakeSlack().client,
      model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
    });

  const filing = (report: Record<string, unknown>) => ({
    run: async (req: SlackAgentRun) => {
      const tool = req.tools.find((t) => t.name === "open_incident");
      if (!tool) throw new Error("the Boss has no open_incident tool");
      return { text: await tool.run(report), usage: emptyModelUsage() };
    },
  });

  test("a report from a mention is filed for the person who sent it, never a name in the input", async () => {
    const { filed, open } = recordingOpen();
    const reply = { text: "" };
    const model = filing({ report: "exports are stuck at 0%", reportedBy: "U0SOMEONEELSE" });
    await agentWith(open, {
      run: async (req) => {
        const out = await model.run(req);
        reply.text = out.text;
        return out;
      },
    }).handle(mention({ ts: "300.0", threadTs: "300.0", text: `<@${BOT}> exports are stuck at 0%` }));

    assert.deepEqual(filed, [
      {
        text: "exports are stuck at 0%",
        reportedBy: "U0HUMAN",
        channel: CHANNEL,
        threadTs: null,
        messageTs: "300.0",
      },
    ]);
    assert.match(reply.text, /incident 91\b/);
  });

  test("a run no person started cannot file one", async () => {
    const { filed, open } = recordingOpen();
    const tool = buildTools({
      db,
      store: memoryStore().store,
      ...toolExtras(),
      openIncident: open,
      reporter: null,
      commands: commandDeps(),
    }).find((t) => t.name === "open_incident")!;

    assert.match(await tool.run({ report: "something broke" }), /^Refused/);
    assert.deepEqual(filed, []);
  });

  test("a mention is framed as something said, not a question", async () => {
    const model = fakeModel();
    const slack = fakeSlack();
    slack.state.replies = [
      { user: "U0OTHER", botId: null, text: "the rule was a leftover test", ts: "401.0" },
    ];
    const { store } = memoryStore();
    const agent = new SlackAgent({
      openIncident: refuseOpen,
      summaryModel: noSummaryModel,
      db,
      store,
      slack: slack.client,
      model: model.model,
      config: { botUserId: BOT, alertChannel: ALERT_CHANNEL, rotationGroupId: null, incidentChannel: CHANNEL },
      closeIncident: refuseClose,
    });
    const said = "Can you close incident 2? See my latest message in that incident thread for why.";
    await agent.handle(mention({ ts: "400.0", threadTs: "400.0", text: `<@${BOT}> hello` }));
    await agent.handle(mention({ ts: "402.0", threadTs: "400.0", text: `<@${BOT}> ${said}` }));

    const input = model.runs.at(-1)!.input;
    assert.ok(input.endsWith(`<@U0HUMAN> says: ${said}`), input);
    // The framing this replaced, which told the Boss every mention was a question.
    assert.ok(!input.includes(`<@U0HUMAN> asks: ${said}`));
    assert.ok(input.includes("<@U0OTHER>: the rule was a leftover test"), "the history came too");
  });
});
