// The Boss through the real harness: a Pi Durable harness over MemoryStorage,
// the real Boss extension and runtime, the real database and the real tools.
// Only the model (a scripted faux provider) and Slack are fakes, so what
// these assert is what a thread would see.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";

import { Db } from "../db";
import { indexIncident, toMatchQuery } from "../db/search";
import { openBugbossHarness, loadPi, type BugbossHarness, type ConversationId, type EntryRecord, type Extension, type UsageState } from "../agent/harness";
import type { AgentLine, BossCommandDeps, CloseIncident } from "../boss/commands";
import type { AgentNotice } from "../toolapi";
import { recordForBoss } from "../boss/inbox";
import type { ModelClient } from "../model";
import {
  BOSS_EXTENSION,
  MAX_SQL_ROWS,
  SILENCE_RECORDED,
  SLACK_AGENT_MAX_TURNS,
  SLACK_AGENT_SYSTEM,
  STAY_SILENT_TOOL,
  SUMMARY_UNAVAILABLE,
  SlackAgent,
  WRAP_UP_INSTRUCTION,
  buildTools,
  createBossExtension,
  createBossRuntime,
  describeSpend,
  tsAfter,
  type AgentTranscripts,
  type BossCall,
  type BossRuntime,
  type OpenIncident,
  type SlackMention,
  type SlackMessage,
  type ToolDeps,
} from "./agent";
import type { GhExec } from "./gh";

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

/** The report ingest, for runs that never file one. */
const refuseOpen = () => Promise.reject(new Error("no report expected in this test"));

const refuseClose: CloseIncident = () =>
  Promise.resolve({ ok: false, error: "closing is not what this test is about" });

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
        return Promise.resolve({ ts: `990.${String(posts.length).padStart(6, "0")}` });
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

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

type Faux = typeof import("@earendil-works/pi-ai/providers/faux");
let faux: Faux;
let durable: Awaited<ReturnType<typeof loadPi>>["durable"];
let typebox: typeof import("typebox");

type Script = (transcript: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>;

let callIds = 0;
const say = (text: string): AssistantMessage => faux.fauxAssistantMessage(text ? [faux.fauxText(text)] : []);
const call = (name: string, args: Record<string, unknown>, text = ""): AssistantMessage =>
  faux.fauxAssistantMessage(
    [...(text ? [faux.fauxText(text)] : []), faux.fauxToolCall(name, args as never, { id: `c${++callIds}` })],
    { stopReason: "toolUse" },
  );
const calls = (list: [string, Record<string, unknown>][], text = ""): AssistantMessage =>
  faux.fauxAssistantMessage(
    [
      ...(text ? [faux.fauxText(text)] : []),
      ...list.map(([name, args]) => faux.fauxToolCall(name, args as never, { id: `c${++callIds}` })),
    ],
    { stopReason: "toolUse" },
  );
const failure = (message: string): AssistantMessage =>
  faux.fauxAssistantMessage([], { stopReason: "error", errorMessage: message });

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : ((content ?? []) as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

/** The pi-ai 1.0 transcript carries the prompt sections as system messages. */
const isBoss = (t: TranscriptContext): boolean =>
  t.messages.some((m) => m.role === "system" && JSON.stringify(m).includes("You are BugBoss, the incident commander"));
const userTexts = (t: TranscriptContext): string[] =>
  t.messages.filter((m) => m.role === "user").map((m) => contentText(m.content));
const lastUser = (t: TranscriptContext): string => userTexts(t).at(-1) ?? "";
const results = (t: TranscriptContext): { name: string; text: string; isError: boolean }[] =>
  t.messages.flatMap((m) =>
    m.role === "toolResult" ? [{ name: m.toolName, text: contentText(m.content), isError: m.isError }] : [],
  );
/** Responses since the newest user message: the turn this request is. */
const turnOf = (t: TranscriptContext): number => {
  const lastUserAt = t.messages.map((m) => m.role).lastIndexOf("user");
  return t.messages.slice(lastUserAt).filter((m) => m.role === "assistant").length;
};
const systemOf = (t: TranscriptContext): string =>
  JSON.stringify(t.messages.filter((m) => m.role === "system"));

// ---------------------------------------------------------------------------
// The harness under test
// ---------------------------------------------------------------------------

let dir: string;
let db: Db;
const open: { close(): Promise<void> }[] = [];

before(async () => {
  faux = await import("@earendil-works/pi-ai/providers/faux");
  durable = (await loadPi()).durable;
  typebox = await import("typebox");
  dir = mkdtempSync(join(tmpdir(), "bugboss-slackagent-"));
  db = await Db.open({
    path: join(dir, "agent.db"),
    bucket: "bugboss-test",
    key: "state/db",
    s3: noS3(),
  });
});

after(async () => {
  for (const h of open.splice(0)) await h.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const h of open.splice(0)) await h.close();
  notified.length = 0;
  await db.withWrite((d) => {
    for (const table of [
      "boss_thread",
      "boss_inbox",
      "pending_question",
      "incident_wait",
      "signal",
      "incident_thread",
      "incident_action",
      "incident",
    ]) {
      d.prepare(`DELETE FROM ${table}`).run();
    }
    d.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES ('inc-1','INVESTIGATING',1)",
    ).run();
  });
});

const notified: AgentNotice[] = [];

const commandBase = (over: Partial<Omit<BossCommandDeps, "agents">> = {}): Omit<BossCommandDeps, "agents"> => ({
  db,
  notifier: { notify: (incidentId, directive) => notified.push({ incidentId, directive }) },
  threads: {
    post: () => Promise.resolve({ ts: "ts-command" }),
    permalink: (ts: string) => Promise.resolve(permalinkFor(ts)),
  },
  closeIncident: refuseClose,
  rotationGroupId: ROTATION,
  ...over,
});

interface BossOptions {
  script: Script;
  slack?: ReturnType<typeof fakeSlack>;
  maxTurns?: number;
  commands?: Partial<Omit<BossCommandDeps, "agents">>;
  openIncident?: OpenIncident;
  gh?: GhExec | null;
  summary?: ModelClient;
  /** Extensions for incident-agent conversations in the same harness. */
  extensions?: Extension[];
  now?: () => number;
  wrap?: (runtime: BossRuntime) => BossRuntime;
  config?: Partial<{ alertChannel: string; rotationGroupId: string | null; incidentChannel: string }>;
}

const MODEL = { provider: "faux", modelId: "faux-1" };

const bossOn = async (o: BossOptions) => {
  const provider = faux.fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const requests: TranscriptContext[] = [];
  const step = (t: TranscriptContext) => {
    requests.push(t);
    return o.script(t);
  };
  provider.setResponses(Array.from({ length: 400 }, () => step));
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const models = createModels();
  models.setProvider(provider.provider);

  const slack = o.slack ?? fakeSlack();
  let bh: BugbossHarness | undefined;
  const harness = () => {
    if (!bh) throw new Error("the harness is not open yet");
    return bh;
  };
  const extension = await createBossExtension({
    db,
    commands: commandBase(o.commands),
    status: {
      summarise: (rendered) => {
        if (!o.summary) return Promise.reject(new Error("no summary expected in this test"));
        return o.summary.complete({ system: "", messages: [{ role: "user", text: rendered }], tools: [], maxTokens: 300, signal: AbortSignal.timeout(30_000) }).then((r) => r.text);
      },
      cache: new Map(),
      now: o.now ?? Date.now,
    },
    openIncident: o.openIncident ?? refuseOpen,
    gh: o.gh ?? null,
    slack: slack.client,
    harness,
    maxTurns: o.maxTurns,
  });
  const reports: unknown[] = [];
  bh = await openBugbossHarness({
    storage: new durable.MemoryStorage(),
    models,
    extensions: [extension, ...(o.extensions ?? [])],
    shellEnv: () => ({}),
    settings: { retry: { enabled: false } },
    onReport: (error) => reports.push(error),
  });
  open.push(bh);
  const base = createBossRuntime({ db, harness, extension, model: MODEL, maxTurns: o.maxTurns, now: o.now });
  const runtime = o.wrap ? o.wrap(base) : base;
  const agent = new SlackAgent({
    db,
    slack: slack.client,
    runtime,
    config: {
      botUserId: BOT,
      alertChannel: o.config?.alertChannel ?? ALERT_CHANNEL,
      rotationGroupId: o.config?.rotationGroupId ?? null,
      incidentChannel: o.config?.incidentChannel ?? CHANNEL,
    },
  });
  return { agent, runtime, bh: harness(), requests, slack, reports, provider, extension };
};

/** The thread's conversation, as boss_thread recorded it. */
const threadConversation = (threadTs: string, channel = CHANNEL): ConversationId => {
  const row = db.get<{ conversationId: number }>(
    "SELECT conversationId FROM boss_thread WHERE channel = ? AND threadTs = ?",
    [channel, threadTs],
  );
  assert.ok(row?.conversationId, `no conversation recorded for ${channel}/${threadTs}`);
  return row.conversationId as ConversationId;
};

/** A gate a scripted response waits on, so a run can be held in flight. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// ---------------------------------------------------------------------------
// The tools, called directly
// ---------------------------------------------------------------------------

const noTranscripts: AgentTranscripts = { read: () => Promise.resolve(null) };

const recordingAgents = () => {
  const told: { incidentId: string; text: string; requestId: string | undefined }[] = [];
  const stopped: { incidentId: string; reason: string }[] = [];
  const agents: AgentLine = {
    tell: (incidentId, text, requestId) => {
      told.push({ incidentId, text, requestId });
      return Promise.resolve(true);
    },
    stop: (incidentId, reason) => {
      stopped.push({ incidentId, reason });
      return Promise.resolve(true);
    },
  };
  return { told, stopped, agents };
};

const toolDeps = (over: Partial<ToolDeps> = {}, commands: Partial<BossCommandDeps> = {}): ToolDeps => ({
  db,
  commands: { ...commandBase(), agents: recordingAgents().agents, ...commands },
  status: {
    summarise: () => Promise.reject(new Error("no summary expected in this test")),
    cache: new Map<string, { position: number; text: string }>(),
    now: Date.now,
  },
  openIncident: refuseOpen,
  gh: null,
  slack: { replies: () => Promise.reject(new Error("no Slack read expected in this test")) },
  transcripts: noTranscripts,
  ...over,
});

const answering: BossCall = { taskId: "7", conversationId: 1, run: { allowSilence: false, reporter: null } };
const mayBeSilent: BossCall = { ...answering, run: { allowSilence: true, reporter: null } };

type BossTool = ReturnType<typeof buildTools>[number];

const toolNamed = (name: string, deps: ToolDeps = toolDeps()): BossTool => {
  const found = buildTools(deps).find((t) => t.name === name);
  assert.ok(found, name);
  return found;
};

/** Every tool but stay_silent answers with text; this says so in the type. */
const run = async (tool: BossTool, input: Record<string, unknown>, at: BossCall = answering): Promise<string> => {
  const out = await tool.run(input, at);
  assert.equal(typeof out, "string", `${tool.name} answered with a control, not text`);
  return out as string;
};

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
    const out = await run(toolNamed("query_incidents"), { sql: "DELETE FROM incident" });
    assert.match(out, /^Rejected: /);
    assert.equal(db.query("SELECT id FROM incident").length, 1);
  });

  // The Slack agent runs the same guard triage does, so what it accepts and
  // what it refuses is settled in triage/triage.test.ts. What is left to
  // check here is the wiring: that a refusal still reaches the model as
  // "Rejected: <reason>" carrying that guard's words, and that a query the
  // shared guard accepts actually runs.
  test("a refusal carries the shared guard's reason in this surface's shape", async () => {
    const query = toolNamed("query_incidents");
    assert.equal(
      await run(query, { sql: "SELECT 1; DROP TABLE incident" }),
      "Rejected: one statement at a time; remove the extra ';'",
    );
    assert.equal(await run(query, { sql: "   " }), "Rejected: empty query");
    assert.equal(
      await run(query, { sql: "UPDATE incident SET status='CLOSED'" }),
      "Rejected: read-only access: statements must start with SELECT, WITH or EXPLAIN",
    );
    assert.equal(
      await run(query, { sql: "WITH t AS (SELECT 1) UPDATE incident SET status='CLOSED'" }),
      "Rejected: read-only access: UPDATE is not allowed",
    );
  });

  test("a read the guard accepts runs, semicolon and quoted keywords included", async () => {
    const query = toolNamed("query_incidents");
    assert.match(await run(query, { sql: "SELECT id FROM incident;" }), /inc-1/);
    assert.equal(
      await run(query, { sql: "SELECT id FROM incident WHERE rootCause LIKE '%DROP TABLE%'" }),
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

    const out = await run(toolNamed("get_incident"), { incidentId: "inc-wide" });

    assert.ok(out.includes(tail), "the end of the signal body is there");
    assert.doesNotThrow(() => JSON.parse(out), "and it is still JSON");
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

    const out = await run(toolNamed("query_incidents"), { sql: "SELECT * FROM signal" });

    assert.equal(out.split("\n").length, MAX_SQL_ROWS + 1, "rows are capped");
    assert.match(out, /first 50 shown/);
    // Rows, and only rows. Each one comes back whole: a row cut at 2,000
    // characters is a row the model reads as complete and answers off, and
    // what got cut was whichever column happened to be last.
    for (const line of out.split("\n").slice(0, MAX_SQL_ROWS)) {
      assert.ok(line.includes("y".repeat(5000)), "the row is whole");
      assert.ok(!line.includes("truncated"));
    }
  });
});

describe("stay_silent", () => {
  test("ends the run where silence is allowed, and refuses, recording nothing, where it is not", async () => {
    const tool = toolNamed(STAY_SILENT_TOOL);
    assert.deepEqual(await tool.run({ reason: "two people talking" }, mayBeSilent), {
      text: SILENCE_RECORDED,
      terminate: true,
    });
    assert.match(await run(tool, { reason: "two people talking" }), /^Refused: this message tags you/);
    assert.match(await run(tool, { reason: "  " }, mayBeSilent), /^Refused: say why/);
  });
});

// ---------------------------------------------------------------------------

describe("search_incidents on the Slack agent", () => {
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
   * rather than by the stopword list. The premise is asserted below rather
   * than assumed, so shrinking either rule fails here loudly instead.
   */
  const UNSEARCHABLE = "a b c";

  // The three answers the tool has to keep apart. Somebody asking "have we
  // seen this before" gets a wrong answer from two of them collapsing: a
  // search that never ran, reported as nothing found, reads as "this is new".
  test("a hit, nothing in the corpus, and a search that never ran stay three answers", async () => {
    await seedClosed();
    const tool = toolNamed("search_incidents");

    const hit = await run(tool, { text: "connection pool exhausted" });
    const nothing = await run(tool, { text: "certificate rotation expiry" });
    const never = await run(tool, { text: UNSEARCHABLE });

    assert.equal(toMatchQuery(UNSEARCHABLE), null, "the unsearchable fixture became searchable");
    assert.notEqual(toMatchQuery("certificate rotation expiry"), null, "the empty-corpus fixture stopped searching");

    assert.match(hit, /inc-old/);
    assert.match(hit, /connection pool was exhausted/);
    assert.match(nothing, /^0 matches/);
    assert.match(never, /^error:/);
    assert.match(never, /did not run/);
    assert.notEqual(nothing, never, "one answer for both is the bug: the agent cannot tell it failed to search");
  });

  test("a hit carries the recorded cause whole", async () => {
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

    const hit = await run(toolNamed("search_incidents"), { text: "connection pool exhausted" });

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

describe("the tool list is stable", () => {
  test("the tool specs are byte-identical across builds and database states", async () => {
    const specs = () =>
      JSON.stringify(buildTools(toolDeps()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));

    const before = specs();
    await db.withWrite((d) => {
      d.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES ('inc-2','FIXING',2)").run();
    });

    assert.equal(specs(), before);
    assert.deepEqual(
      buildTools(toolDeps()).map((t) => t.name),
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
        "gh",
        "read_slack_link",
        "grant_turns",
      ],
      "order is part of every request, and the write tools come after the reads",
    );
  });

  test("nothing nondeterministic leaked into the system prompt", () => {
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /\d{4}-\d{2}-\d{2}|\d{10,}|\/Users\/|\/tmp\/|[0-9a-f]{40}/);
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
 * message from every surface. What is left here is the guard that the second
 * mechanism does not come back.
 */
describe("the Slack agent hands back no links of its own", () => {
  const withThread = (id: string, threadTs: string) =>
    db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = ? WHERE id = ?").run(threadTs, id);
    });

  test("get_incident reports the thread ts, never a url", async () => {
    await withThread("inc-1", "400.0");
    const out = await run(toolNamed("get_incident"), { incidentId: "inc-1" });
    assert.match(out, /"slackThreadTs": "400.0"/, "the row is still whole");
    assert.doesNotMatch(out, /threadPermalink/);
    assert.doesNotMatch(out, /goodparty\.slack\.com/);
  });

  test("query_incidents does not decorate a row that names a thread", async () => {
    await withThread("inc-1", "400.0");
    const out = await run(toolNamed("query_incidents"), {
      sql: "SELECT id, slackThreadTs FROM incident WHERE slackThreadTs IS NOT NULL",
    });
    assert.match(out, /"inc-1"/);
    assert.doesNotMatch(out, /threadPermalink/);
  });

  test("the prompt does not ask the model to build links itself", () => {
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /<permalink\|/);
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /assemble a Slack URL/);
    assert.doesNotMatch(SLACK_AGENT_SYSTEM, /threadPermalink/);
    assert.match(SLACK_AGENT_SYSTEM, /capitalised and linked to its thread for you/);
  });
});

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

// ---------------------------------------------------------------------------

describe("read_agent_session", () => {
  const said = (text: string, extra: object = {}): EntryRecord =>
    ({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1, ...extra }] }) as unknown as EntryRecord;

  const noUsage: UsageState = { models: {}, tools: {} };

  const reading = (entries: EntryRecord[], o: { busy?: boolean; usage?: UsageState } = {}) =>
    toolNamed(
      "read_agent_session",
      toolDeps({
        transcripts: {
          read: (incidentId) =>
            Promise.resolve(incidentId === "inc-1" ? { entries, busy: o.busy ?? false, usage: o.usage ?? noUsage } : null),
        },
      }),
    );

  test("counts turns and shows the last ones asked for, rendered rather than raw", async () => {
    const out = await run(reading([said("first look"), said("second look"), said("third look")]), { incidentId: "inc-1", turns: 2 });
    assert.match(out, /3 turns, last 2/);
    assert.match(out, /third look/);
    assert.doesNotMatch(out, /first look/);
    assert.doesNotMatch(out, /"role":/, "a rendering, not the entries");
  });

  // The reader used to cut its own answer at 24,000 characters, and then
  // handed back raw JSONL lines instead, sixty of which were 199,928
  // characters in prod. The bound is a count of turns now, and nothing is cut.
  test("the tail is the turns asked for, bounded by count rather than width", async () => {
    const out = await run(
      reading(Array.from({ length: 20_000 }, (_, i) => said(`turn number ${i} checked the deploy`))),
      { incidentId: "inc-1" },
    );
    assert.match(out, /20000 turns, last 15/);
    assert.ok(out.includes("turn number 19999 checked the deploy"), "the last turn is there, whole");
    assert.ok(out.includes("turn number 19985 checked the deploy"), "and so are the fifteen asked for");
    assert.ok(!out.includes("turn number 19984 "), "and nothing before them");
    assert.ok(!out.includes("truncated"));
  });

  // The whole reason a 9.5-hour run sat dead: the tail of a killed run and
  // the tail of a finished one read the same.
  test("says whether a run is in progress, and how the last one ended when not", async () => {
    assert.match(await run(reading([said("checking")], { busy: true }), { incidentId: "inc-1" }), /-- a run is in progress/);
    assert.match(await run(reading([said("checking", { stopReason: "aborted" })]), { incidentId: "inc-1" }), /stopped before it finished/);
    assert.match(await run(reading([said("closing this out")]), { incidentId: "inc-1" }), /ended with an answer/);
  });

  // The Slack agent is what a human asks "what did incident 7 cost", and it
  // answers out of this tool result. A dollar figure that does not say it is
  // an estimate gets quoted back as though somebody had seen a bill.
  test("reports spend from the conversation's usage and the dispatcher's turns, never the dollars as a fact", async () => {
    await db.withWrite((d) => d.prepare("UPDATE incident SET turnsUsed = 2 WHERE id = 'inc-1'").run());
    const bucket = (output: number, total: number) => ({
      input: 10,
      output,
      cacheRead: 300,
      cacheWrite: 40,
      totalTokens: 350 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    });
    const usage: UsageState = {
      models: {
        "amazon-bedrock/us.anthropic.claude-opus-5": bucket(40, 37),
        "amazon-bedrock/us.anthropic.claude-haiku-5": bucket(5, 0.02),
      },
      tools: { report_resolved: bucket(0, 0) },
    };
    const out = await run(reading([said("a"), said("b")], { usage }), { incidentId: "inc-1" });
    assert.match(out, /spend: 2 turns, 1095 tokens on us\.anthropic\.claude-opus-5/, "named for the model that wrote the most");
    assert.match(out, /estimated cost \$37\.02/);
    assert.match(out, /not an invoiced figure/);
  });

  test("an incident with no conversation says so rather than inventing one", async () => {
    assert.match(await run(reading([]), { incidentId: "inc-404" }), /^No incident inc-404\./);
    await db.withWrite((d) => d.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES ('inc-9','FIXING',2)").run());
    assert.match(await run(reading([]), { incidentId: "inc-9" }), /has no conversation yet/);
  });

  test("describeSpend names no model when nothing was recorded", () => {
    assert.equal(describeSpend({ models: {}, tools: {} }, 0), "0 turns, 0 tokens on an unrecorded model");
  });
});

// ---------------------------------------------------------------------------

describe("the Boss's write tools", () => {
  const EVIDENCE = "The error rate query has read zero for the last two hours and the agent's session shows the rollback deployed at 14:02.";

  const closed = () =>
    db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, resolvedAt, closedAt, postmortem) VALUES ('c1','CLOSED',1,2,3,'pm')",
      ).run();
    });

  test("message_agent tells the agent, keyed on its own call, and lifts a wait on a person but not a spent budget", async () => {
    const { told, agents } = recordingAgents();
    await db.withWrite((d) => {
      d.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES ('inc-2','FIXING',2)").run();
      d.prepare(
        "INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt) VALUES ('inc-1','someone to confirm the rollback',NULL,1,1)",
      ).run();
      d.prepare(
        "INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt) VALUES ('inc-2','a person to decide; the turn budget is spent',NULL,0,1)",
      ).run();
    });
    const tool = toolNamed("message_agent", toolDeps({}, { agents }));

    assert.match(await run(tool, { incidentId: "inc-1", text: "Dana says it was a rollback." }), /^Sent/);
    assert.match(await run(tool, { incidentId: "inc-2", text: "Keep going." }, { ...answering, taskId: "8" }), /^Sent/);

    assert.deepEqual(told, [
      { incidentId: "inc-1", text: "The Boss says: Dana says it was a rollback.", requestId: "boss:7" },
      { incidentId: "inc-2", text: "The Boss says: Keep going.", requestId: "boss:8" },
    ]);
    assert.equal(db.query("SELECT 1 FROM incident_wait WHERE incidentId = 'inc-1'").length, 0, "the wait on a person is lifted");
    assert.equal(db.query("SELECT 1 FROM incident_wait WHERE incidentId = 'inc-2'").length, 1, "a spent budget takes grant_turns");
  });

  test("message_agent refuses an incident no agent is working, and says so when there is no conversation yet", async () => {
    await closed();
    const { told, agents } = recordingAgents();
    assert.match(await run(toolNamed("message_agent", toolDeps({}, { agents })), { incidentId: "c1", text: "hello" }), /^Rejected: incident c1 is CLOSED/);
    assert.equal(told.length, 0);

    const none: AgentLine = { tell: () => Promise.resolve(false), stop: () => Promise.resolve(false) };
    assert.match(
      await run(toolNamed("message_agent", toolDeps({}, { agents: none })), { incidentId: "inc-1", text: "hello" }),
      /^Not sent: incident inc-1's agent has not started its first run/,
    );
  });

  test("message_agent that cannot reach the agent says so and alarms", async () => {
    const broken: AgentLine = { tell: () => Promise.reject(new Error("harness closed")), stop: () => Promise.resolve(false) };
    let out = "";
    const lines = await captureLogs(async () => {
      out = await run(toolNamed("message_agent", toolDeps({}, { agents: broken })), { incidentId: "inc-1", text: "hello" });
    });
    assert.match(out, /^Failed: the message did not reach the agent/);
    assert.ok(lines.some((l) => l.includes("agent_message_failed") && l.includes('"level":"error"')));
  });

  const granted = (incidentId: string): number | undefined =>
    db.get<{ grantedTurns: number }>("SELECT grantedTurns FROM incident WHERE id = ?", [incidentId])?.grantedTurns;

  test("grant_turns adds to the incident's grant and records why", async () => {
    const grant = toolNamed("grant_turns");
    assert.match(await run(grant, { incidentId: "inc-1", turns: 40, reason: EVIDENCE }), /^Granted 40 turns/);
    assert.match(await run(grant, { incidentId: "inc-1", turns: 10, reason: EVIDENCE }), /50 granted in total/);
    assert.equal(granted("inc-1"), 50);
    assert.equal(
      db.query("SELECT id FROM incident_action WHERE incidentId = 'inc-1' AND action = 'turns_granted'").length,
      2,
    );
  });

  test("grant_turns refuses a count out of range, and a reason that is not evidence", async () => {
    const grant = toolNamed("grant_turns");
    for (const turns of [0, -5, 201, 2.5, "50"]) {
      assert.match(await run(grant, { incidentId: "inc-1", turns, reason: EVIDENCE }), /^Rejected: turns must be/, String(turns));
    }
    assert.match(await run(grant, { incidentId: "inc-1", turns: 50, reason: "asked" }), /^Rejected: grant_turns needs a reason/);
    assert.equal(granted("inc-1"), 0);
  });

  test("grant_turns refuses a closed incident", async () => {
    await closed();
    assert.match(await run(toolNamed("grant_turns"), { incidentId: "c1", turns: 50, reason: EVIDENCE }), /^Rejected: incident c1 is CLOSED/);
    assert.equal(granted("c1"), 0);
  });

  test("close_incident goes through the tool API's close and refuses a reason that is not evidence", async () => {
    const asked: { incidentId: string; reason: string }[] = [];
    const closeIncident: CloseIncident = (args) => {
      asked.push(args);
      return Promise.resolve({ ok: true, from: "FIXING" });
    };
    const close = toolNamed("close_incident", toolDeps({}, { closeIncident }));

    assert.match(await run(close, { incidentId: "inc-1", reason: "fixed" }), /^Rejected: close_incident needs a reason that is evidence/);
    assert.equal(asked.length, 0, "a one-word reason never reaches the transition");

    const out = await run(close, { incidentId: "inc-1", reason: EVIDENCE });
    assert.deepEqual(asked, [{ incidentId: "inc-1", reason: EVIDENCE }]);
    assert.match(out, /closed \(it was FIXING\)/);
  });

  test("close_incident hands a refusal back as a refusal", async () => {
    const out = await run(
      toolNamed("close_incident", toolDeps({}, { closeIncident: () => Promise.resolve({ ok: false, error: "incident inc-1 is MERGED" }) })),
      { incidentId: "inc-1", reason: EVIDENCE },
    );
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
    const merge = toolNamed(
      "merge_incidents",
      toolDeps({}, {
        threads: {
          post: (threadTs, text) => {
            posts.push({ threadTs, text });
            return Promise.resolve({ ts: "x" });
          },
          permalink: (ts) => Promise.resolve(permalinkFor(ts)),
        },
      }),
    );

    // Named the wrong way round on purpose: the older record survives.
    const out = await run(merge, { fromIncidentId: "11", intoIncidentId: "12", reason: EVIDENCE });

    assert.match(out, /Incident 12 is now part of incident 11/);
    assert.deepEqual(
      notified.map((n) => [n.incidentId, n.directive.type]),
      [["12", "merged"], ["11", "new_signals"]],
      "each agent is told once the move has committed",
    );
    assert.equal(db.get<{ status: string }>("SELECT status FROM incident WHERE id = '12'")?.status, "MERGED");
    assert.equal(db.get<{ incidentId: string }>("SELECT incidentId FROM signal WHERE id = 's12'")?.incidentId, "11");
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
    const out = await run(toolNamed("merge_incidents"), { fromIncidentId: "22", intoIncidentId: "21", reason: EVIDENCE });
    assert.match(out, /^Rejected: incident 21 is RESOLVED/);
    assert.deepEqual(notified, []);
    assert.equal(db.get<{ status: string }>("SELECT status FROM incident WHERE id = '22'")?.status, "FIXING");
  });

  test("stop_agent stops the agent with the reason, and refuses what has nothing running", async () => {
    const { stopped, agents } = recordingAgents();
    const stop = toolNamed("stop_agent", toolDeps({}, { agents }));
    assert.match(await run(stop, { incidentId: "inc-1", reason: EVIDENCE }), /has stopped/);
    assert.deepEqual(stopped, [{ incidentId: "inc-1", reason: EVIDENCE }]);

    await closed();
    assert.match(await run(stop, { incidentId: "c1", reason: EVIDENCE }), /^Rejected: incident c1 is CLOSED/);
    assert.match(await run(stop, { incidentId: "inc-1", reason: "wrong" }), /^Rejected: stop_agent needs a reason/);
    assert.equal(stopped.length, 1);
  });

  test("page_rotation posts the rotation mention through code, into the incident's thread", async () => {
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = '800.1' WHERE id = 'inc-1'").run();
    });
    const posts: { threadTs: string | null; text: string }[] = [];
    const out = await run(
      toolNamed(
        "page_rotation",
        toolDeps({}, {
          threads: {
            post: (threadTs, text) => {
              posts.push({ threadTs, text });
              return Promise.resolve({ ts: "x" });
            },
            permalink: (ts) => Promise.resolve(permalinkFor(ts)),
          },
        }),
      ),
      { incidentId: "inc-1", reason: "The agent needs someone with prod access to confirm the migration ran." },
    );
    assert.match(out, /has been paged/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].threadTs, "800.1");
    assert.ok(posts[0].text.startsWith(`<!subteam^${ROTATION}> `), posts[0].text);
  });

  test("open_incident refuses a run no person started", async () => {
    const filed: unknown[] = [];
    const tool = toolNamed("open_incident", toolDeps({ openIncident: (r) => (filed.push(r), Promise.resolve([])) }));
    assert.match(await run(tool, { report: "something broke" }), /^Refused/);
    assert.deepEqual(filed, []);
  });
});

// ---------------------------------------------------------------------------
// A mention, through the harness
// ---------------------------------------------------------------------------

describe("one conversation per thread", () => {
  test("a second mention in a thread resumes its conversation, with the same prompt and tools", async () => {
    const boss = await bossOn({ script: (t) => say(`answered ${userTexts(t).length}`) });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));
    await captureLogs(() => boss.agent.handle(mention({ ts: "200.0", text: `<@${BOT}> and now?` })));

    assert.equal(boss.requests.length, 2);
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["answered 1", "answered 2"]);
    assert.match(userTexts(boss.requests[1])[0], /what is open right now\?/, "the first question is still in context");
    assert.equal(systemOf(boss.requests[0]), systemOf(boss.requests[1]), "nothing about the prompt changed between runs");
    assert.equal(
      db.query("SELECT conversationId FROM boss_thread WHERE channel = ? AND threadTs = '100.0'", [CHANNEL]).length,
      1,
      "the thread is a boss_thread row naming its conversation",
    );
  });

  test("different threads are different conversations, answered at the same time", async () => {
    const both = gate();
    let inFlight = 0;
    const boss = await bossOn({
      script: async (t) => {
        inFlight += 1;
        if (inFlight === 2) both.open();
        let guard: NodeJS.Timeout | undefined;
        await Promise.race([
          both.opened,
          new Promise((_, reject) => {
            guard = setTimeout(() => reject(new Error("threads ran one after another")), 5_000);
          }),
        ]).finally(() => clearTimeout(guard));
        return say(`answering ${lastUser(t)}`);
      },
    });
    await captureLogs(() =>
      Promise.all([
        boss.agent.handle(mention({ threadTs: "100.0", ts: "100.0", text: `<@${BOT}> first` })),
        boss.agent.handle(mention({ threadTs: "900.0", ts: "900.0", text: `<@${BOT}> second` })),
      ]),
    );
    assert.equal(boss.slack.posts.length, 2);
    assert.notEqual(threadConversation("100.0"), threadConversation("900.0"));
  });

  test("a second mention while the first is running queues behind it, and is never told the Boss is busy", async () => {
    const held = gate();
    let reached!: () => void;
    const first = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const boss = await bossOn({
      script: async (t) => {
        if (userTexts(t).length === 1) {
          reached();
          await held.opened;
          return say("first answer");
        }
        return say("second answer");
      },
    });
    let running: Promise<void> | undefined;
    await captureLogs(async () => {
      running = boss.agent.handle(mention({ ts: "100.0" }));
      await first;
      const second = boss.agent.handle(mention({ ts: "100.5", text: `<@${BOT}> also this` }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(boss.requests.length, 1, "one run at a time in one thread");
      assert.equal(boss.slack.posts.length, 0, "and no busy reply");
      held.open();
      await Promise.all([running, second]);
    });

    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["first answer", "second answer"]);
    const queued = boss.requests[1].messages;
    assert.equal(queued.filter((m) => m.role === "assistant").length, 1, "the second run reads behind the first answer");
    assert.match(lastUser(boss.requests[1]), /also this$/);
  });

  test("a run that fails says so, and does not wedge the thread", async () => {
    let calls = 0;
    const boss = await bossOn({ script: () => (++calls === 1 ? failure("bedrock said no") : say("second time lucky")) });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));
    assert.match(boss.slack.posts[0].text, /could not finish/);

    await captureLogs(() => boss.agent.handle(mention({ ts: "200.0" })));
    assert.equal(calls, 2, "the thread is not wedged");
    assert.equal(boss.slack.posts[1].text, "second time lucky");
  });
});

describe("what the Boss is shown of a thread", () => {
  test("the first mention in its own thread reads nothing more", async () => {
    const boss = await bossOn({ script: () => say("ok") });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));
    assert.equal(boss.slack.state.calls.length, 0, "nothing to catch up on");
    assert.equal(lastUser(boss.requests[0]), "<@U0HUMAN> says: what is open right now?");
  });

  test("a first mention in a reply thread reads what was said above it", async () => {
    // Prod, 2026-09-30: a support lead reported a double charge, an engineer
    // replied "@bugboss please log an incident for this", and the Boss,
    // handed only that line, asked what "this" was.
    const slack = fakeSlack();
    slack.state.replies = [
      { user: "U0NATE", botId: null, text: "A candidate got double charged for one text today.", ts: "100.0" },
      { user: null, botId: "B0GRAFANA", text: "[PROD] Route errors on POST /v1/payments/events", ts: "110.0" },
      { user: BOT, botId: "B0BUGBOSS", text: "an earlier BugBoss post", ts: "115.0" },
      { user: "U0SWAIN", botId: null, text: `<@${BOT}> please log an incident for this`, ts: "120.0" },
      { user: "U0NATE", botId: null, text: "said after the tag", ts: "130.0" },
    ];
    const boss = await bossOn({ script: () => say("ok"), slack });
    await captureLogs(() =>
      boss.agent.handle(mention({ ts: "120.0", threadTs: "100.0", text: `<@${BOT}> please log an incident for this` })),
    );

    const input = lastUser(boss.requests[0]);
    assert.equal(slack.state.calls.length, 1, "premise: the thread was fetched");
    assert.match(input, /Earlier in this thread, before this message \(3 message\(s\)\)/);
    assert.match(input, /double charged for one text/);
    assert.match(input, /Route errors on POST \/v1\/payments\/events/, "another bot's post above the tag is context too");
    assert.match(input, /You \(BugBoss\): an earlier BugBoss post/, "its own posts are marked as its own");
    assert.doesNotMatch(input, /said after the tag/);
    assert.match(input, /log an incident for this$/, "the ask comes last");
  });

  test("a resume fetches only what it missed, and replays no bot posts", async () => {
    const slack = fakeSlack();
    const boss = await bossOn({ script: () => say("ok"), slack });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));

    slack.state.replies = [
      { user: "U0OTHER", botId: null, text: "the deploy went out at 14:02", ts: "150.0" },
      { user: null, botId: "B0AGENT", text: "hypothesis: bad column", ts: "160.0" },
      { user: "U0HUMAN", botId: null, text: "already seen", ts: "90.0" },
    ];
    await captureLogs(() => boss.agent.handle(mention({ ts: "200.0", text: `<@${BOT}> and now?` })));

    assert.deepEqual(slack.state.calls[0], { channel: CHANNEL, threadTs: "100.0", oldest: "100.0" });
    const input = lastUser(boss.requests[1]);
    assert.match(input, /the deploy went out at 14:02/);
    assert.doesNotMatch(input, /hypothesis: bad column/, "bot posts are not replayed");
    assert.doesNotMatch(input, /already seen/, "nothing before the watermark");
    assert.match(input, /and now\?$/, "the question comes last");
  });

  test("a long message somebody typed is replayed whole", async () => {
    // Each missed reply used to be cut at 2,000 characters on its way into
    // the prompt. It is a person catching the agent up on what they know,
    // and the pasted log or the sentence at the end is the part they went
    // to the trouble for.
    const slack = fakeSlack();
    const boss = await bossOn({ script: () => say("ok"), slack });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));

    const tail = "and it only started after the Tuesday deploy";
    slack.state.replies = [{ user: "U0OTHER", botId: null, text: `${"l".repeat(20_000)}\n${tail}`, ts: "150.0" }];
    await captureLogs(() => boss.agent.handle(mention({ ts: "200.0", text: `<@${BOT}> and now?` })));

    const input = lastUser(boss.requests[1]);
    assert.ok(input.includes(tail), "the end of what they wrote is there");
    assert.ok(input.includes("l".repeat(20_000)), "and so is the rest");
    assert.doesNotMatch(input, /truncated/);
  });

  test("a thread idle for more than seven days starts on a reset context and reads the thread again, its own replies marked", async () => {
    const slack = fakeSlack();
    const boss = await bossOn({ script: () => say("Opened incident 95 for this."), slack });
    await captureLogs(() => boss.agent.handle(mention({ ts: "120.0", threadTs: "100.0" })));
    await db.withWrite((d) =>
      d.prepare("UPDATE boss_thread SET lastActivityAt = ? WHERE threadTs = '100.0'").run(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    slack.state.replies = [
      { user: "U0NATE", botId: null, text: "double charged for one text", ts: "100.0" },
      { user: BOT, botId: "B0BUGBOSS", text: "Opened incident 95 for this.", ts: "125.0" },
    ];
    const lines = await captureLogs(() =>
      boss.agent.handle(mention({ ts: "900.0", threadTs: "100.0", text: `<@${BOT}> any update?` })),
    );

    const second = boss.requests[1];
    assert.equal(userTexts(second).length, 1, "the week-old question is no longer in context");
    const input = lastUser(second);
    assert.match(input, /You \(BugBoss\): Opened incident 95 for this\./, "so it can see it already opened one");
    assert.match(input, /Earlier in this thread, before this message/, "a reset rereads the thread as history");
    assert.ok(lines.some((l) => l.includes("thread_reset_idle")));
    assert.equal(threadConversation("100.0"), threadConversation("100.0"), "the same conversation, reset");
  });

  test("a throttled thread fetch costs context, not the answer", async () => {
    const posts: string[] = [];
    const slack = fakeSlack();
    slack.client.replies = () => Promise.reject(new Error("ratelimited"));
    slack.client.post = (_threadTs, text) => {
      posts.push(text);
      return Promise.resolve({ ts: "x" });
    };
    const boss = await bossOn({ script: () => say("answered"), slack });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));
    await captureLogs(() => boss.agent.handle(mention({ ts: "200.0" })));
    assert.equal(boss.requests.length, 2);
    assert.equal(posts[1], "answered");
  });

  test("a watermark that fails to save does not retract the answer", async () => {
    const boss = await bossOn({
      script: () => say("answered"),
      wrap: (runtime) => ({ ...runtime, saveThread: () => Promise.reject(new Error("harness storage full")) }),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["answered"], "nothing contradicts the answer");
    assert.ok(lines.some((line) => line.includes("state_write_failed")));
  });

  test("a mention is framed as something said, not a question", async () => {
    const slack = fakeSlack();
    const boss = await bossOn({ script: () => say("ok"), slack });
    await captureLogs(() => boss.agent.handle(mention({ ts: "400.0", threadTs: "400.0", text: `<@${BOT}> hello` })));
    slack.state.replies = [{ user: "U0OTHER", botId: null, text: "the rule was a leftover test", ts: "401.0" }];
    const said = "Can you close incident 2? See my latest message in that incident thread for why.";
    await captureLogs(() => boss.agent.handle(mention({ ts: "402.0", threadTs: "400.0", text: `<@${BOT}> ${said}` })));

    const input = lastUser(boss.requests.at(-1)!);
    assert.ok(input.endsWith(`<@U0HUMAN> says: ${said}`), input);
    assert.ok(!input.includes(`<@U0HUMAN> asks: ${said}`));
    assert.ok(input.includes("<@U0OTHER>: the rule was a leftover test"), "the history came too");
  });
});

describe("an untagged follow-up in a thread the Boss is already in", () => {
  test("may choose silence, which posts nothing and is logged", async () => {
    const boss = await bossOn({
      script: (t) => (turnOf(t) === 0 ? call(STAY_SILENT_TOOL, { reason: "they are talking to each other" }) : say("never asked for")),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention({ ts: "100.2", text: "lunch?", tagged: false })));
    assert.equal(boss.requests.length, 1);
    assert.equal(boss.slack.posts.length, 0);
    assert.ok(lines.some((l) => l.includes('"event":"stay_silent"') && l.includes("talking to each other")));
  });

  test("an empty run without stay_silent is a failure the thread hears about", async () => {
    const boss = await bossOn({ script: () => say("") });
    const lines = await captureLogs(() =>
      boss.agent.handle(mention({ ts: "100.2", text: "can you close incident 2?", tagged: false })),
    );
    assert.ok(lines.some((l) => l.includes("followup_run_silent_unchosen") && l.includes('"level":"error"')));
    assert.equal(boss.slack.posts.length, 1);
    assert.match(boss.slack.posts[0].text, /could not finish/);
  });

  test("a tagged mention is never allowed silence: the refusal goes back and the answer is posted", async () => {
    const boss = await bossOn({
      script: (t) =>
        turnOf(t) === 0
          ? call(STAY_SILENT_TOOL, { reason: "nothing more to add" }, "Incident 94 is fixed; the PR merged an hour ago.")
          : say(""),
    });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.3" })));
    assert.equal(boss.requests.length, 2, "the refusal went back to the model instead of ending the run");
    assert.match(results(boss.requests[1])[0].text, /^Refused: this message tags you/);
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["Incident 94 is fixed; the PR merged an hour ago."]);
  });
});

describe("when the answer itself fails", () => {
  test("a failure the thread cannot carry goes where the thread is not", async () => {
    const posts: { channel?: string; text: string }[] = [];
    const slack = fakeSlack();
    slack.client.post = (_threadTs, text, channel) => {
      if (channel === CHANNEL) return Promise.reject(new Error("channel_not_found"));
      posts.push({ channel, text });
      return Promise.resolve({ ts: "ts-1" });
    };
    const boss = await bossOn({
      script: () => failure("bedrock said no"),
      slack,
      config: { alertChannel: ALERT, rotationGroupId: ROTATION },
    });

    const lines = await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));

    assert.equal(posts.length, 1, "someone was told");
    assert.equal(posts[0].channel, ALERT, "not through the channel that failed");
    assert.match(posts[0].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
    assert.ok(
      posts[0].text.includes(`<${permalinkFor("100.0")}|that thread>`),
      "whoever reads this was not there and cannot reconstruct a thread from a ts",
    );
    assert.ok(lines.some((line) => line.includes("failure_reply_failed")), "and the apology failing is logged on its own");
  });

  test("a permalink that fails costs the link, not the alert", async () => {
    const posts: { channel?: string; text: string }[] = [];
    const slack = fakeSlack();
    slack.client.permalink = () => Promise.reject(new Error("ratelimited"));
    slack.client.post = (_threadTs, text, channel) => {
      if (channel === CHANNEL) return Promise.reject(new Error("channel_not_found"));
      posts.push({ channel, text });
      return Promise.resolve({ ts: "ts-1" });
    };
    const boss = await bossOn({
      script: () => failure("bedrock said no"),
      slack,
      config: { alertChannel: ALERT, rotationGroupId: ROTATION },
    });

    const lines = await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));

    assert.equal(posts.length, 1, "an alert lost to a second failure is the worst case");
    assert.match(posts[0].text, /thread 100\.0/, "named the bare way instead");
    assert.ok(!posts[0].text.includes("goodparty.slack.com"));
    assert.ok(lines.some((line) => line.includes("failure_alert_permalink_failed")), "degrading is not swallowing");
  });
});

// ---------------------------------------------------------------------------
// The turn budget and the wrap-up
// ---------------------------------------------------------------------------

describe("a run that uses its whole budget", () => {
  test("answers with what it read instead of an apology, from a wrap-up that cannot call a tool", async () => {
    const boss = await bossOn({
      maxTurns: 3,
      script: (t) =>
        results(t).some((r) => r.text.includes(WRAP_UP_INSTRUCTION))
          ? say("Two of the three are open and I read inc-1; I did not reach inc-2.")
          : call("get_incident", { incidentId: "inc-1" }),
    });

    const lines = await captureLogs(() => boss.agent.handle(mention()));

    assert.equal(boss.requests.length, 4, "three turns, then one wrap-up");
    const last = results(boss.requests[3]);
    assert.ok(last.at(-1)?.text.includes(WRAP_UP_INSTRUCTION), "the round that spent the budget carries the instruction");
    assert.ok(last.at(-1)?.text.includes('"incident"'), "on top of the result itself, whole");
    assert.equal(userTexts(boss.requests[3]).length, 1, "the wrap-up rides on the results, not a user turn behind them");
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["Two of the three are open and I read inc-1; I did not reach inc-2."]);
    assert.ok(lines.some((l) => l.includes("slack_agent_turns_exhausted")), "running out of turns is still a visible event");
  });

  test("a model that ignores the wrap-up gets nothing run, and the run ends there", async () => {
    const boss = await bossOn({
      maxTurns: 2,
      script: (t) => (results(t).at(-1)?.isError ? say("never asked for") : call("get_incident", { incidentId: "inc-1" })),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention()));

    assert.equal(boss.requests.length, 3, "two turns and the wrap-up, and no request after a refused call");
    const answer = boss.slack.posts.map((p) => p.text).join("\n");
    // The minutes of silence are the only thing the reader experienced, so
    // the reply has to name what caused them and how much it bought.
    assert.match(answer, /ran out of steps/);
    assert.match(answer, /\b2 of them\b/, "and how many, so the wait has a size");
    assert.match(answer, /under a minute|about a minute|about \d+ minutes/, "and how long");
    assert.match(answer, /narrow it instead/);
    // Asking again spends the same budget the same way, so advice to do that
    // costs the reader another wait for the same non-answer.
    assert.doesNotMatch(answer, /[Aa]sk me again/);
    assert.doesNotMatch(answer, /logs/);
    assert.ok(lines.some((l) => l.includes("slack_agent_turns_exhausted")));
    assert.ok(lines.some((l) => l.includes("slack_agent_no_answer")));
    // The wrap-up answered, it just answered with nothing, so it never failed
    // and `wrap_up_failed` never fired. That is how a run holding everything
    // it read posted an apology with nobody told.
    assert.ok(lines.some((l) => l.includes("slack_agent_wrap_up_empty")));
    assert.ok(!lines.some((l) => l.includes("slack_agent_wrap_up_failed")));
  });

  test("keeps its own prose when the wrap-up request itself fails", async () => {
    const boss = await bossOn({
      maxTurns: 2,
      script: (t) =>
        results(t).some((r) => r.text.includes(WRAP_UP_INSTRUCTION))
          ? failure("bedrock throttled")
          : call("get_incident", { incidentId: "inc-1" }, "So far: inc-1 is being worked by an agent."),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention()));
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["So far: inc-1 is being worked by an agent."]);
    assert.ok(lines.some((l) => l.includes("slack_agent_wrap_up_failed")));
  });

  test("leaves a conversation the next mention can still resume", async () => {
    let resumed = false;
    const boss = await bossOn({
      maxTurns: 2,
      script: (t) => {
        if (userTexts(t).length > 1) {
          resumed = true;
          return say("inc-1 is still being worked.");
        }
        return results(t).some((r) => r.text.includes(WRAP_UP_INSTRUCTION))
          ? failure("bedrock throttled")
          : call("get_incident", { incidentId: "inc-1" });
      },
    });
    await captureLogs(() => boss.agent.handle(mention({ ts: "100.0" })));
    await captureLogs(() => boss.agent.handle(mention({ ts: "200.0" })));
    assert.ok(resumed);
    assert.equal(boss.slack.posts.at(-1)?.text, "inc-1 is still being worked.");
  });

  test("does not claim it ran out of steps when it did not", async () => {
    // One turn, no tool calls, no text. The budget was never touched, so
    // blaming it would be a fabrication and "ask me again" is the right
    // advice rather than the wrong one.
    const boss = await bossOn({ maxTurns: 4, script: () => say("") });
    const lines = await captureLogs(() => boss.agent.handle(mention()));
    const answer = boss.slack.posts.map((p) => p.text).join("\n");
    assert.doesNotMatch(answer, /ran out of steps/);
    assert.match(answer, /Ask me again/);
    assert.ok(!lines.some((l) => l.includes("slack_agent_turns_exhausted")), "nothing was exhausted");
    assert.ok(lines.some((l) => l.includes("slack_agent_no_answer")));
  });

  test("covers reading every open incident and still answering", async () => {
    /** What was open the day a question about all of them went unanswered. */
    const OPEN_INCIDENTS = 11;
    const boss = await bossOn({
      script: (t) => {
        const turn = turnOf(t);
        if (turn === 0) return call("query_incidents", { sql: "SELECT id FROM incident" });
        if (turn <= OPEN_INCIDENTS) return call("get_incident", { incidentId: `inc-${turn}` });
        return say(`All ${OPEN_INCIDENTS} are accounted for.`);
      },
    });
    const lines = await captureLogs(() => boss.agent.handle(mention()));
    assert.equal(boss.requests.length, OPEN_INCIDENTS + 2);
    assert.match(boss.slack.posts[0].text, new RegExp(`All ${OPEN_INCIDENTS} are accounted for`));
    assert.ok(!lines.some((l) => l.includes("slack_agent_turns_exhausted")), "the worst reasonable shape fits inside the budget");
    assert.ok(SLACK_AGENT_MAX_TURNS >= OPEN_INCIDENTS + 2);
  });
});

describe("a run that may stay silent", () => {
  const THREAD = "500.000100";
  const seed = () =>
    db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, slackThreadTs, summary) VALUES ('7','FIXING',5,?,'Checkout failing')",
      ).run(THREAD);
    });
  const human = (ts: string, text: string) => ({ kind: "human" as const, user: "U0HUMAN", text, ts });
  const narratingThen = (finalText: string): Script => (t) =>
    turnOf(t) === 0 ? call("get_incident", { incidentId: "7" }, "Let me look at the incident first.") : say(finalText);

  test("posts nothing, not narration, when the last turn says nothing -- and that is an unchosen silence", async () => {
    await seed();
    const boss = await bossOn({ script: narratingThen("") });
    const lines = await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "hm") }));
    assert.equal(boss.requests.length, 2, "the narrating turn really did call a tool first");
    assert.ok(!boss.slack.posts.some((p) => /Let me look/.test(p.text)), "narration is not an answer");
    assert.ok(lines.some((l) => l.includes("incident_run_silent_unchosen")));
    assert.ok(!lines.some((l) => l.includes("slack_agent_no_answer")));
  });

  test("posts only the final turn's text", async () => {
    await seed();
    const boss = await bossOn({ script: narratingThen("Incident 7 is being worked by an agent.") });
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "status?") }));
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["Incident 7 is being worked by an agent."]);
  });

  test("a mention without silence still answers from the narration rather than apologising", async () => {
    const boss = await bossOn({ script: narratingThen("") });
    await captureLogs(() => boss.agent.handle(mention()));
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["Let me look at the incident first."]);
  });
});

describe("stay_silent is terminal", () => {
  test("a tool called in the same turn still runs, and nothing more is requested", async () => {
    const asked: { incidentId: string; reason: string }[] = [];
    const boss = await bossOn({
      commands: {
        closeIncident: (args) => {
          asked.push(args);
          return Promise.resolve({ ok: true, from: "FIXING" });
        },
      },
      script: () =>
        calls([
          ["close_incident", { incidentId: "inc-1", reason: "Swain removed the alert rule and said so in this thread an hour ago." }],
          [STAY_SILENT_TOOL, { reason: "the closed notice already says it" }],
        ]),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention({ tagged: false })));
    assert.equal(boss.requests.length, 1, "stay_silent ends the run before a second request goes out");
    assert.equal(asked.length, 1, "close_incident, called in the same turn, still ran");
    assert.equal(boss.slack.posts.length, 0, "nothing is posted once silence is chosen");
    assert.ok(lines.some((l) => l.includes('"event":"stay_silent"') && l.includes("the closed notice already says it")));
  });

  test("discards text written in the same turn as stay_silent, and logs the discard", async () => {
    const boss = await bossOn({
      script: () => call(STAY_SILENT_TOOL, { reason: "two people talking to each other" }, "Here is an answer anyway."),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention({ tagged: false })));
    assert.equal(boss.slack.posts.length, 0, "the narration written alongside the tool call is never posted");
    assert.ok(lines.some((l) => l.includes("slack_agent_stay_silent_text_discarded")), "the discard is logged");
  });

  test("does not exhaust the budget or run a wrap-up when stay_silent is called on the final turn", async () => {
    const boss = await bossOn({ maxTurns: 1, script: () => call(STAY_SILENT_TOOL, { reason: "nothing here is for me" }) });
    const lines = await captureLogs(() => boss.agent.handle(mention({ tagged: false })));
    assert.equal(boss.requests.length, 1, "the single turn the budget allowed, and nothing after it");
    assert.ok(!lines.some((l) => l.includes("slack_agent_turns_exhausted")));
    assert.equal(boss.slack.posts.length, 0);
  });
});

describe("what a question cost", () => {
  test("the answered line carries every request the run made, the wrap-up included", async () => {
    const boss = await bossOn({
      maxTurns: 2,
      script: (t) =>
        results(t).some((r) => r.text.includes(WRAP_UP_INSTRUCTION))
          ? say("inc-1 is being worked, and that is as far as I got.")
          : call("get_incident", { incidentId: "inc-1" }),
    });
    const lines = await captureLogs(() => boss.agent.handle(mention()));
    const answered = lines.find((l) => l.includes('"event":"answered"'));
    assert.ok(answered, "the run was answered");
    const parsed = JSON.parse(answered) as Record<string, number | string>;
    assert.equal(parsed.modelCalls, 3, "two turns and the wrap-up");
    assert.ok(Number(parsed.tokensIn) > 0, "tokens are what the provider reported");
    assert.equal(parsed.modelId, "faux-1");
  });
});

// ---------------------------------------------------------------------------
// The Boss in an incident thread
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

  const human = (ts: string, text: string) => ({ kind: "human" as const, user: "U0HUMAN", text, ts });

  const opening: SlackMessage = {
    user: BOT,
    botId: "B0BUGBOSS",
    text: "*Checkout 5xx above 2%* -- opened by a Grafana alert",
    ts: THREAD,
  };

  test("a fresh conversation is told which incident this is and reads the whole thread, BugBoss posts included", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [
      opening,
      { user: BOT, botId: "B0BUGBOSS", text: "*Root cause found* -- the pool is too small", ts: "500.000200" },
      { user: "U0HUMAN", botId: null, text: "is this why checkout is slow?", ts: "500.000300" },
    ];
    const boss = await bossOn({ script: () => say("It is."), slack });

    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "is this why checkout is slow?") }));

    assert.equal(boss.requests.length, 1);
    assert.equal(slack.state.calls.length, 1, "a fresh conversation fetches the thread");
    assert.equal(slack.state.calls[0].threadTs, THREAD);
    assert.equal(slack.state.calls[0].channel, CHANNEL);
    assert.equal(slack.state.calls[0].oldest, undefined, "the whole thread, not a stretch of it");
    const input = lastUser(boss.requests[0]);
    assert.match(input, /incident 7\. Status: FIXING\. Title: Checkout failing\./);
    assert.match(input, /BugBoss: \*Checkout 5xx above 2%\*/, "the opening message is the record");
    assert.match(input, /BugBoss: \*Root cause found\*/, "and so is every transition notice");
    assert.match(input, /<@U0HUMAN>: is this why checkout is slow\?/);
    assert.ok(threadConversation(THREAD), "the incident thread has a boss_thread row too");
    assert.deepEqual(slack.posts.map((p) => [p.threadTs, p.channel, p.text]), [[THREAD, CHANNEL, "It is."]]);
  });

  test("a resume reads everything since the watermark, bot posts included, except its own replies", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening, { user: "U0HUMAN", botId: null, text: "first", ts: "500.000300" }];
    const boss = await bossOn({ script: () => say("It is, yes."), slack });
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "first") }));
    // The fake Slack's ts for the first post, so the reply comes back in the
    // fetch the way it would in production.
    const posted = "990.000001";
    assert.equal(slack.posts.length, 1);

    slack.state.replies = [
      opening,
      { user: "U0HUMAN", botId: null, text: "first", ts: "500.000300" },
      { user: BOT, botId: "B0BUGBOSS", text: "It is, yes.", ts: posted },
      { user: BOT, botId: "B0BUGBOSS", text: "*Incident 7 resolved*", ts: "995.000500" },
      { user: "U0OTHER", botId: null, text: "second", ts: "995.000600" },
    ];
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("995.000600", "second") }));

    assert.equal(boss.requests.length, 2);
    assert.equal(slack.state.calls[1].oldest, "500.000300");
    const input = lastUser(boss.requests[1]);
    assert.match(input, /BugBoss: \*Incident 7 resolved\*/, "a notice posted since is shown");
    assert.match(input, /<@U0OTHER>: second/);
    assert.doesNotMatch(input, /It is, yes\./, "its own reply is already in its conversation");
    assert.doesNotMatch(input, /<@U0HUMAN>: first/, "nothing from before the watermark");
  });

  test("an agent's unseen rows are in the input as the agent's, and are seen once submitted", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => say("Answered the agent."), slack });
    await db.withWrite((w) => {
      recordForBoss(w, { incidentId: "7", kind: "question", text: "Can someone confirm the deploy at 14:02 was a rollback?" });
      recordForBoss(w, { incidentId: "7", kind: "message", text: "PR opened." });
      recordForBoss(w, { incidentId: "7", kind: "escalation", text: "Still waiting after 2 hours." });
    });

    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } }));

    const input = lastUser(boss.requests[0]);
    assert.match(input, /From incident 7's agent, not seen by you before \(3\)/);
    assert.match(input, /\[question -- it is blocked until you answer it with message_agent\] Can someone confirm/);
    assert.match(input, /\[message\] PR opened\./);
    assert.match(input, /\[escalation -- it needs a person\] Still waiting/);
    assert.equal(db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length, 0, "every row it was shown is marked");
  });

  test("an inbox run that fails alarms, and nobody in the thread is told", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => failure("bedrock said no"), slack });
    await db.withWrite((w) => recordForBoss(w, { incidentId: "7", kind: "question", text: "q?" }));

    const lines = await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } }));

    assert.ok(lines.some((l) => l.includes("incident_run_failed") && l.includes('"level":"error"')));
    assert.equal(slack.posts.length, 0, "an inbox run has nobody waiting in the thread");
    // Seen at submit: the row is in the conversation's transcript as the
    // failed run's input, so the next run reads it there.
    assert.match(
      JSON.stringify(await (await boss.bh.conversation(threadConversation(THREAD))).context(boss.bh.context)),
      /\[question -- it is blocked until you answer it with message_agent\] q\?/,
    );
  });

  test("a failed run a person triggered tells them", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => failure("bedrock said no"), slack });
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "hello?") }));
    assert.equal(slack.posts.length, 1);
    assert.match(slack.posts[0].text, /could not finish/);
    assert.equal(slack.posts[0].threadTs, THREAD);
  });

  test("a chosen silence posts nothing, and logs why at info", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => call(STAY_SILENT_TOOL, { reason: "two people are talking to each other" }), slack });
    const lines = await captureLogs(() =>
      boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "@dana can you look at this?") }),
    );
    assert.equal(boss.requests.length, 1, "premise: the Boss did read it");
    assert.equal(slack.posts.length, 0);
    const chose = lines.find((l) => l.includes('"stay_silent"'));
    assert.ok(chose, "the silence is logged");
    assert.match(chose, /two people are talking to each other/);
    assert.match(chose, /"level":"info"/);
    assert.ok(lines.some((l) => l.includes("incident_answered") && l.includes('"spoke":false')));
  });

  test("a second message while the thread's run is in flight is queued with only what is new, never answered busy", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening, { user: "U0HUMAN", botId: null, text: "first", ts: "500.000300" }];
    const held = gate();
    let reached!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const boss = await bossOn({
      slack,
      script: async (t) => {
        if (userTexts(t).length === 1) {
          reached();
          await held.opened;
        }
        return say(`answer ${userTexts(t).length}`);
      },
    });

    await captureLogs(async () => {
      const first = boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "first") });
      await inFlight;
      // Slack has not caught up with the second message yet: it is only in
      // the trigger, which is why the trigger's own text is merged in.
      const second = boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000400", "second, while you were thinking") });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(boss.requests.length, 1, "no second run beside the first");
      assert.equal(slack.posts.length, 0, "and no busy reply");
      held.open();
      await Promise.all([first, second]);
    });

    assert.equal(boss.requests.length, 2);
    const input = lastUser(boss.requests[1]);
    assert.match(input, /<@U0HUMAN>: second, while you were thinking/);
    assert.doesNotMatch(input, /<@U0HUMAN>: first/, "the first message is not repeated");
    assert.deepEqual(slack.posts.map((p) => p.text), ["answer 1", "answer 2"]);
  });

  test("an agent row landing mid-run is read by the run its wake queues", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const held = gate();
    let reached!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const boss = await bossOn({
      slack,
      script: async (t) => {
        if (userTexts(t).length === 1) {
          reached();
          await held.opened;
        }
        return say("ok");
      },
    });

    await captureLogs(async () => {
      const first = boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "status?") });
      await inFlight;
      await db.withWrite((w) => recordForBoss(w, { incidentId: "7", kind: "question", text: "Is the 14:02 deploy a rollback?" }));
      const wake = boss.agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } });
      held.open();
      await Promise.all([first, wake]);
    });

    assert.equal(boss.requests.length, 2);
    assert.doesNotMatch(lastUser(boss.requests[0]), /14:02/, "premise: the row was not there for the first run");
    assert.match(lastUser(boss.requests[1]), /\[question -- it is blocked until you answer it with message_agent\] Is the 14:02 deploy a rollback\?/);
    assert.equal(db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length, 0);
  });

  test("a wake with nothing new says nothing and spends nothing", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => say("ok"), slack });
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "hi") }));
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: { kind: "inbox" } }));
    assert.equal(boss.requests.length, 1, "the wake had nothing behind it");
  });

  test("the agent's outstanding question is named in the input", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => say("ok"), slack });
    await db.withWrite((w) =>
      w
        .prepare("INSERT INTO pending_question (incidentId, messageTs, askedAt, message) VALUES ('7','',?,?)")
        .run(Date.now() - 5 * 60_000, "Was the 14:02 deploy a rollback?"),
    );
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "yes it was") }));
    assert.match(lastUser(boss.requests[0]), /blocked on a question it asked 5 minute\(s\) ago.*Was the 14:02 deploy a rollback\?/);
  });

  test("an incident with no thread alarms and leaves its rows for later", async () => {
    await db.withWrite((d) => {
      d.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES ('8','INVESTIGATING',5)").run();
      recordForBoss(d, { incidentId: "8", kind: "question", text: "q?" });
    });
    const boss = await bossOn({ script: () => say("ok") });
    const lines = await captureLogs(() => boss.agent.handleIncident({ incidentId: "8", trigger: { kind: "inbox" } }));
    assert.equal(boss.requests.length, 0);
    assert.ok(lines.some((l) => l.includes("incident_thread_missing")));
    assert.equal(db.query("SELECT id FROM boss_inbox WHERE seenAt IS NULL").length, 1);
  });

  test("a mention the model writes itself still posts as literal text", async () => {
    await seed();
    const slack = fakeSlack();
    slack.state.replies = [opening];
    const boss = await bossOn({ script: () => say(`<!subteam^${ROTATION}> wake up`), slack });
    await captureLogs(() => boss.agent.handleIncident({ incidentId: "7", trigger: human("500.000300", "x") }));
    assert.equal(slack.posts.length, 1);
    assert.ok(!slack.posts[0].text.startsWith("<!subteam^"), slack.posts[0].text);
  });
});

// ---------------------------------------------------------------------------
// The Boss and an incident agent on the same harness
// ---------------------------------------------------------------------------

/** The middle of every big result, which must never reach the Boss. */
const BURIED = "BURIED-MIDDLE-OF-A-FILE";

/**
 * The incident agent's side, cut to what the Boss reaches: a read whose
 * result is wide, a wait that ends when a steer is queued for its
 * conversation (the rule `agent/wait.ts` has), and an escalation.
 */
const incidentExtension = (probes: { waiting?: () => void } = {}): Extension =>
  durable.defineExtension({
    name: "test.incident",
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: typebox.Type.Object({ path: typebox.Type.String() }),
        execute: () =>
          Promise.resolve({
            content: [{ type: "text" as const, text: `${"const rule = alerting.rule(".repeat(600)}${BURIED}${"  threshold: 0.95,\n".repeat(600)}` }],
          }),
      },
      {
        name: "monitor",
        description: "Wait for a deploy",
        parameters: typebox.Type.Object({}),
        execute: async (_args, api, context) => {
          probes.waiting?.();
          const inbox = await api.watchDoc(durable.InboxDoc, api.conversationId, context);
          const interrupted = await new Promise<boolean>((resolve) => {
            const finish = (value: boolean) => {
              clearTimeout(timer);
              void inbox?.stop();
              resolve(value);
            };
            const steered = (value: { items: readonly { mode: string }[] } | null | undefined) =>
              (value?.items ?? []).some((item) => item.mode === "steer");
            const timer = setTimeout(() => finish(false), 3_600_000);
            if (steered(inbox?.value)) return finish(true);
            inbox?.start(async (value) => {
              if (steered(value)) finish(true);
            });
            context.abortSignal?.addEventListener("abort", () => finish(false));
          });
          return { content: [{ type: "text" as const, text: interrupted ? "stopped watching: the Boss sent a message" : "the deploy settled" }] };
        },
      },
      {
        name: "escalate",
        description: "Escalate",
        parameters: typebox.Type.Object({ brief: typebox.Type.String() }),
        execute: () => Promise.resolve({ content: [{ type: "text" as const, text: "Escalated. The Boss has it." }] }),
      },
    ],
  });

/** An incident agent conversation, recorded on the incident row the way the dispatcher records it. */
const agentConversation = async (bh: BugbossHarness, extension: Extension, incidentId: string) => {
  const conversation = await bh.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL, extensions: [extension] } },
    bh.context,
  );
  await db.withWrite((d) => d.prepare("UPDATE incident SET conversationId = ? WHERE id = ?").run(conversation.id, incidentId));
  return conversation;
};

describe("message_agent and stop_agent reach a real agent conversation", () => {
  test("a message to an agent blocked in a wait ends the wait and is the next thing it reads", async () => {
    let waiting!: () => void;
    const blocked = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const extension = incidentExtension({ waiting: () => waiting() });
    let agentContinued: TranscriptContext | undefined;
    const boss = await bossOn({
      extensions: [extension],
      script: (t) => {
        if (!isBoss(t)) {
          if (results(t).length === 0) return call("monitor", {});
          agentContinued = t;
          return say("Checked the pool: exhausted at 25 connections.");
        }
        return turnOf(t) === 0
          ? call("message_agent", { incidentId: "inc-1", text: "check the DB pool first" })
          : say("Told the agent to check the DB pool.");
      },
    });
    const agent = await agentConversation(boss.bh, extension, "inc-1");
    const work = await agent.submit({ type: "input", content: "incident inc-1: 502s" }, boss.bh.context);
    await blocked;

    const started = Date.now();
    await captureLogs(() => boss.agent.handle(mention()));
    const done = await work.wait(boss.bh.context);

    assert.equal(done.status, "done");
    assert.match(results(boss.requests.find((t) => isBoss(t) && turnOf(t) === 1)!)[0].text, /^Sent to incident inc-1's agent/);
    assert.ok(agentContinued, "the agent took another turn");
    assert.match(JSON.stringify(agentContinued.messages.find((m) => m.role === "toolResult")), /the Boss sent a message/);
    assert.match(JSON.stringify(agentContinued.messages.at(-1)), /The Boss says: check the DB pool first/);
    assert.ok(Date.now() - started < 5_000, "an hour-long wait did not hold the message");
  });

  test("a message to an idle agent lands in its transcript without starting a run", async () => {
    const extension = incidentExtension();
    const boss = await bossOn({
      extensions: [extension],
      script: (t) => {
        assert.ok(isBoss(t), "the agent was asked nothing");
        return turnOf(t) === 0 ? call("message_agent", { incidentId: "inc-1", text: "Swain merged the PR." }) : say("Passed it on.");
      },
    });
    const agent = await agentConversation(boss.bh, extension, "inc-1");
    await captureLogs(() => boss.agent.handle(mention()));

    assert.equal(await boss.bh.isBusy(agent.id), false, "no run outside the dispatcher");
    const view = await agent.context(boss.bh.context);
    assert.match(JSON.stringify(view.messages), /The Boss says: Swain merged the PR\./);
    assert.deepEqual(boss.slack.posts.map((p) => p.text), ["Passed it on."]);
  });

  test("stop_agent aborts the run in flight and starts the agent's next context from the reason", async () => {
    let waiting!: () => void;
    const blocked = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const extension = incidentExtension({ waiting: () => waiting() });
    const REASON = "It is investigating election-api, but the alert and every failing request are in gp-api.";
    const boss = await bossOn({
      extensions: [extension],
      script: (t) => {
        if (!isBoss(t)) return call("monitor", {});
        return turnOf(t) === 0 ? call("stop_agent", { incidentId: "inc-1", reason: REASON }) : say("Stopped it.");
      },
    });
    const agent = await agentConversation(boss.bh, extension, "inc-1");
    const work = await agent.submit({ type: "input", content: "incident inc-1" }, boss.bh.context);
    await blocked;

    await captureLogs(() => boss.agent.handle(mention()));

    assert.equal((await work.wait(boss.bh.context)).status, "unanswered", "the run was aborted");
    assert.equal(await boss.bh.isBusy(agent.id), false, "and nothing restarted it: that is the dispatcher's tick");
    const view = await agent.context(boss.bh.context);
    assert.equal(view.head?.kind, "pi.reset", "a new context");
    assert.match(JSON.stringify(view.messages), /The Boss stopped your run: It is investigating election-api/);
  });
});

describe("incident 2, replayed", () => {
  // The prod failures of 2026-09-30: a request to close incident 2 that
  // vanished because an empty turn was read as a chosen silence, after the
  // Boss read a session tail wide enough to choke on.
  const THREAD = "900.000100";
  const CLOSE_ASK = "Can we close this alert? I've since removed this alert completely.";
  const human = { kind: "human" as const, user: "U0SWAIN", text: CLOSE_ASK, ts: "900.000500" };
  const REASON = "Swain removed this alert rule completely, said so in the thread, and the agent's own last turn found it gone from the repo.";

  /** The prod model's failure, as a rule: fed a result this wide, it answers with nothing. */
  const CHOKES_AT = 100_000;

  const seed = () =>
    db.withWrite((d) => {
      d.prepare(
        `INSERT INTO incident (id, status, firstSignalAt, slackThreadTs, summary, prUrls)
         VALUES ('2', 'INVESTIGATING', 1, ?, 'Stale alert on the export queue', '[]')`,
      ).run(THREAD);
      // Parked on a spent budget: a message does not wake it.
      d.prepare(
        `INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES ('2', 'a person to decide what happens next; the turn budget is spent', NULL, 0, ?)`,
      ).run(Date.now() - 2 * 60 * 60_000);
    });

  /** What incident 2's agent did: seven wide reads, then an escalation. */
  const agentScript: Script = (t) => {
    const turn = turnOf(t);
    if (turn < 7) return call("read", { path: `packages/gp-api/src/alerts/rule-${turn}.ts` });
    if (turn === 7) {
      return call("escalate", { brief: "Budget spent; the alert may already be removed." }, "The alert rule is gone from the repo, so I am parking until a person decides.");
    }
    return say("Parked.");
  };

  /** What the Boss did in prod: get_incident, query_incidents, then the widest read of the session it could ask for. */
  const bossScript = (afterReads: Script): Script => (t) => {
    if (!isBoss(t)) return agentScript(t);
    const seen = results(t).length;
    if (seen === 0) return call("get_incident", { incidentId: "2" });
    if (seen === 1) return call("query_incidents", { sql: "SELECT * FROM incident_wait WHERE incidentId = '2'" });
    if (seen === 2) return call("read_agent_session", { incidentId: "2", turns: 60 });
    if ((results(t).at(-1)?.text.length ?? 0) >= CHOKES_AT) return say("");
    return afterReads(t);
  };

  const build = async (afterReads: Script, o: { summary?: ModelClient } = {}) => {
    await seed();
    const extension = incidentExtension();
    const slack = fakeSlack();
    slack.state.replies.push(
      { user: BOT, botId: "B0BUGBOSS", text: "*Incident 2 opened*", ts: THREAD },
      { user: "U0SWAIN", botId: null, text: CLOSE_ASK, ts: human.ts },
    );
    const boss = await bossOn({
      slack,
      extensions: [extension],
      summary: o.summary,
      script: bossScript(afterReads),
      config: { incidentChannel: CHANNEL },
      commands: {
        closeIncident: async ({ incidentId }) => {
          await db.withWrite((d) => d.prepare("UPDATE incident SET status = 'CLOSED', resolvedAt = 1, closedAt = 1, postmortem = 'closed by the Boss' WHERE id = ?").run(incidentId));
          await slack.client.post(THREAD, `*Incident ${incidentId} closed*`, CHANNEL);
          return { ok: true, from: "INVESTIGATING" };
        },
      },
    });
    const incidentAgent = await agentConversation(boss.bh, extension, "2");
    const work = await incidentAgent.submit({ type: "input", content: "incident 2: stale alert" }, boss.bh.context);
    await work.wait(boss.bh.context);
    return { ...boss, incidentAgent };
  };

  const closedAfter = (t: TranscriptContext) => results(t).some((r) => r.name === "close_incident");

  test("premise: the agent's transcript is wide enough to choke on", async () => {
    const { incidentAgent, bh } = await build(() => say(""));
    const width = JSON.stringify((await incidentAgent.context(bh.context)).messages).length;
    assert.ok(width >= 150_000, `the transcript is ${width} characters`);
  });

  test("a request to close, with the evidence given, is acted on and never met with silence", async () => {
    const boss = await build((t) =>
      closedAfter(t)
        ? say("Closed incident 2: you removed the alert, so nothing is left for its agent to fix.")
        : call("close_incident", { incidentId: "2", reason: REASON }),
    );

    await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: human }));

    const read = results(boss.requests.filter(isBoss)[3]).at(-1);
    assert.ok(read, "the Boss read the session");
    assert.ok(read.text.length < 20_000, `it came back as ${read.text.length} characters, bounded`);
    assert.ok(!read.text.includes(BURIED), "and nothing was cut out of the middle of a file into it");
    assert.match(read.text, /read \d{2},\d{3} characters from packages\/gp-api\/src\/alerts\/rule-6\.ts/);

    assert.equal(db.get<{ status: string }>("SELECT status FROM incident WHERE id = '2'")?.status, "CLOSED", "the Boss acted");
    const inThread = boss.slack.posts.filter((p) => p.threadTs === THREAD);
    assert.ok(inThread.some((p) => /^\*Incident 2 closed\*/.test(p.text)), "the closed notice posted");
    assert.ok(inThread.some((p) => /you removed the alert/.test(p.text)), "and the Boss said what it did");
  });

  test("a model that still answers with nothing is a failure the thread hears about", async () => {
    const boss = await build(() => say(""));

    const lines = await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: human }));

    const alarmed = lines.find((l) => l.includes("incident_run_silent_unchosen"));
    assert.ok(alarmed, "it alarms");
    const parsed = JSON.parse(alarmed) as Record<string, unknown>;
    assert.equal(parsed.level, "error");
    assert.equal(parsed.thread, `${CHANNEL}/${THREAD}`);
    assert.equal(parsed.trigger, "human");
    assert.equal(parsed.triggerTs, human.ts);
    assert.equal(parsed.triggerUser, human.user);

    const inThread = boss.slack.posts.filter((p) => p.threadTs === THREAD);
    assert.equal(inThread.length, 1, "and the person who asked is told");
    assert.match(inThread[0].text, /could not finish/);
    assert.equal(db.get<{ status: string }>("SELECT status FROM incident WHERE id = '2'")?.status, "INVESTIGATING", "nothing changed that nobody asked for");
  });

  // Incident 2's real second failure, the same day: the Boss closed the
  // incident correctly, then called stay_silent as the prompt instructs --
  // and the harness asked the model for one more turn anyway, which is
  // where the literal text "(silpersisted)" reached the thread after
  // silence had already been chosen.
  test("stay_silent is terminal: a turn requested after it is chosen never happens, whatever it would have written", async () => {
    const boss = await build((t) => {
      if (results(t).some((r) => r.text === SILENCE_RECORDED)) return say("(silpersisted)");
      return closedAfter(t)
        ? call(STAY_SILENT_TOOL, { reason: "the closed notice already says it" })
        : call("close_incident", { incidentId: "2", reason: REASON });
    });

    const lines = await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: human }));

    assert.ok(
      !boss.requests.some((t) => results(t).some((r) => r.text === SILENCE_RECORDED)),
      "no request was ever built from a transcript that already recorded silence",
    );
    assert.equal(db.get<{ status: string }>("SELECT status FROM incident WHERE id = '2'")?.status, "CLOSED", "close_incident, from the turn before, still ran");
    const inThread = boss.slack.posts.filter((p) => p.threadTs === THREAD);
    assert.ok(inThread.some((p) => /^\*Incident 2 closed\*/.test(p.text)), "the closed notice posted");
    assert.ok(!inThread.some((p) => p.text.includes("silpersisted")), "nothing from a turn after stay_silent reached the thread");
    assert.ok(!lines.some((l) => l.includes('"level":"error"')), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes('"event":"stay_silent"')));
  });

  describe("incident_status", () => {
    const summaries = (texts: (string | Error)[]) => {
      const asked: string[] = [];
      const model: ModelClient = {
        complete: (request) => {
          const first = request.messages[0];
          asked.push(first?.role === "user" ? first.text : "");
          const next = texts.shift();
          if (next instanceof Error) return Promise.reject(next);
          return Promise.resolve({ text: next ?? "", toolCalls: [], usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, modelId: null, calls: 1 } });
        },
      };
      return { model, asked };
    };

    /** A Boss that asks for the card and pastes it. */
    const pasting = (cards: string[]): Script => (t) => {
      if (!isBoss(t)) return say("One more rule file read.");
      const last = t.messages.at(-1);
      if (last?.role === "toolResult") {
        const card = contentText(last.content);
        cards.push(card);
        return say(card);
      }
      return call("incident_status", { incidentId: "2" });
    };

    test("the card is pasted, and the summary is paid for once per transcript position", async () => {
      const cards: string[] = [];
      const summary = summaries([
        "It has parked itself because its turn budget is spent and it thinks the alert is already gone.",
        "It read one more rule file.",
      ]);
      await seed();
      const extension = incidentExtension();
      const boss = await bossOn({ extensions: [extension], summary: summary.model, script: (t) => (isBoss(t) ? pasting(cards)(t) : agentScript(t)) });
      const agent = await agentConversation(boss.bh, extension, "2");
      await (await agent.submit({ type: "input", content: "incident 2" }, boss.bh.context)).wait(boss.bh.context);

      const ask = (ts: string) => ({ ...human, text: "what's the status of this incident?", ts });
      await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: ask("900.000600") }));
      await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: ask("900.000700") }));

      assert.equal(cards.length, 2);
      assert.equal(summary.asked.length, 1, "asking twice about an agent that has not moved is one call");
      assert.equal(cards[0], cards[1]);
      assert.match(cards[0], /^\*Incident 2\* · Stale alert on the export queue\n\*Investigating\* → Fixing → Resolved → Closed · \*PARKED\*/);
      assert.match(cards[0], /\*Now:\* It has parked itself because its turn budget is spent/);
      assert.doesNotMatch(cards[0], new RegExp(BURIED));
      assert.match(summary.asked[0], /Turn \d+/, "the summary reads rendered turns, not entries");

      // The agent moves: a new entry is a new position, and a new sentence.
      await (await agent.submit({ type: "input", content: "one more" }, boss.bh.context)).wait(boss.bh.context);
      await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: ask("900.000800") }));
      assert.equal(summary.asked.length, 2);
      assert.match(cards[2], /\*Now:\* It read one more rule file\./);
    });

    test("a failed summary renders as unavailable, never as raw lines, and alarms", async () => {
      const cards: string[] = [];
      const summary = summaries([new Error("bedrock throttled")]);
      await seed();
      const extension = incidentExtension();
      const boss = await bossOn({ extensions: [extension], summary: summary.model, script: (t) => (isBoss(t) ? pasting(cards)(t) : agentScript(t)) });
      const agent = await agentConversation(boss.bh, extension, "2");
      await (await agent.submit({ type: "input", content: "incident 2" }, boss.bh.context)).wait(boss.bh.context);

      const lines = await captureLogs(() =>
        boss.agent.handleIncident({ incidentId: "2", trigger: { ...human, text: "status?", ts: "900.000600" } }),
      );

      assert.match(cards[0], new RegExp(`\\*Now:\\* ${SUMMARY_UNAVAILABLE}\\n`));
      assert.doesNotMatch(cards[0], /Turn \d|"role"|const rule/);
      assert.ok(lines.some((l) => l.includes("status_summary_failed") && l.includes('"level":"error"')));
    });
  });

  test("incident 80: code work for an agent out of turns is granted turns and briefed, not handed back", async () => {
    // Asked to rebase, the Boss said it had no checkout and the agent was out
    // of turns. Both were true and neither was the answer.
    await seed();
    const extension = incidentExtension();
    const boss = await bossOn({
      extensions: [extension],
      script: (t) => {
        if (!isBoss(t)) return agentScript(t);
        const done = new Set(results(t).map((r) => r.name));
        if (!done.has("grant_turns")) {
          return call("grant_turns", { incidentId: "2", turns: 50, reason: "Swain asked for a rebase in the thread and the agent is parked with its turn budget spent." });
        }
        if (!done.has("message_agent")) return call("message_agent", { incidentId: "2", text: "Swain asked you to rebase your PR onto main now." });
        return say("Gave incident 2 50 more turns and asked its agent to rebase.");
      },
    });
    const agent = await agentConversation(boss.bh, extension, "2");

    await captureLogs(() => boss.agent.handleIncident({ incidentId: "2", trigger: { ...human, text: "rebase it now", ts: "900.000900" } }));

    assert.equal(db.get<{ grantedTurns: number }>("SELECT grantedTurns FROM incident WHERE id = '2'")?.grantedTurns, 50);
    assert.match(JSON.stringify((await agent.context(boss.bh.context)).messages), /The Boss says: Swain asked you to rebase/);
    assert.equal(db.query("SELECT 1 FROM incident_wait WHERE incidentId = '2'").length, 1, "the spent budget's park stays for the dispatcher to lift");
  });
});

describe("open_incident through the harness", () => {
  test("a report from a mention is filed for the person who sent it", async () => {
    const filed: Parameters<OpenIncident>[0][] = [];
    const boss = await bossOn({
      openIncident: (report) => {
        filed.push(report);
        return Promise.resolve([{ incidentId: "91", action: "new_incident", reason: "new" }]);
      },
      script: (t) => (turnOf(t) === 0 ? call("open_incident", { report: "exports are stuck at 0%" }) : say(results(t).at(-1)!.text)),
    });
    await captureLogs(() => boss.agent.handle(mention({ ts: "300.0", threadTs: "300.0", text: `<@${BOT}> exports are stuck at 0%` })));

    assert.deepEqual(filed, [
      { text: "exports are stuck at 0%", reportedBy: "U0HUMAN", channel: CHANNEL, threadTs: null, messageTs: "300.0" },
    ]);
    assert.match(boss.slack.posts[0].text, /incident 91\b/i);
  });
});

describe("incident 94, replayed", () => {
  // Asked "who made 2265?", the Boss said it had no GitHub access and asked
  // Swain to paste the link.
  const PR_2265 = JSON.stringify({
    number: 2265,
    title: "Group alert notifications by rule rather than by endpoint",
    author: { login: "jeffgp" },
    state: "MERGED",
  });

  test("asked who made omni#2265, the Boss reads it with gh and answers from it", async () => {
    const ghCalls: string[][] = [];
    const gh: GhExec = (args) => {
      ghCalls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: PR_2265, stderr: "", timedOut: false, overflowed: false });
    };
    const boss = await bossOn({
      gh,
      script: (t) => {
        const last = results(t).at(-1);
        if (!last) return call("gh", { args: ["pr", "view", "2265", "--json", "number,title,author,state"] });
        const pr = JSON.parse(last.text.slice(last.text.indexOf("{"))) as { number: number; title: string; author: { login: string }; state: string };
        return say(`omni#${pr.number} is "${pr.title}", opened by ${pr.author.login}. It is ${pr.state.toLowerCase()}.`);
      },
    });

    await captureLogs(() =>
      boss.agent.handle(mention({ channel: ALERT_CHANNEL, threadTs: "940.000100", ts: "940.000100", text: `<@${BOT}> look at 2265. Who made it?` })),
    );

    assert.deepEqual(ghCalls, [["pr", "view", "2265", "--json", "number,title,author,state"]], "it looked the PR up itself");
    const answer = boss.slack.posts.map((p) => p.text).join("\n");
    assert.match(answer, /jeffgp/, "and answered from what gh returned");
    assert.doesNotMatch(answer, /paste/i);
  });
});

describe("the extension", () => {
  test("is the Boss's alone: one prompt section, the sixteen tools, and nothing an incident agent selects", async () => {
    const boss = await bossOn({ script: () => say("ok") });
    assert.equal(boss.extension.name, BOSS_EXTENSION);
    assert.equal(boss.extension.tools?.length, 16);
    await captureLogs(() => boss.agent.handle(mention()));
    const agent = await (await boss.bh.conversation(threadConversation("100.0"))).agent(boss.bh.context);
    assert.deepEqual(agent.extensions.map((e) => e.name), [BOSS_EXTENSION]);
  });
});
