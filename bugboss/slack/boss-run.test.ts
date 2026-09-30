// The Boss's incident-thread run end to end through the real harness: the
// real turn loop (`createSlackAgentModel`), the real tools, the real database
// and the real Boss close. Only the model and Slack are fakes.
//
// These are the prod failures of 2026-09-30, replayed: a status question
// answered off a card rather than composed prose, and a request to close
// incident 2 that vanished because an empty turn was read as a chosen
// silence.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import { createSlackAgentModel } from "../index";
import { emptyModelUsage, type ModelReply, type ModelRequest, type SizedModelClient } from "../model";
import { closeIncidentByBoss } from "../toolapi";
import {
  SlackAgent,
  SUMMARY_UNAVAILABLE,
  type ObjectStore,
  type SlackAgentModel,
  type SlackMessage,
} from "./agent";

/** The report ingest. Nothing here reads as a report. */
const refuseOpen = () => Promise.reject(new Error("no report expected in this test"));

const BOT = "U0BUGBOSS";
const CHANNEL = "C0INCIDENTS";
const ALERT = "C0ALERTS";
const THREAD = "900.000100";

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
    list: (prefix) => Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix))),
  };
  return { store, objects };
};

const fakeSlack = () => {
  const posts: { threadTs: string | null; text: string; channel?: string }[] = [];
  const replies: SlackMessage[] = [];
  return {
    posts,
    replies,
    client: {
      post: (threadTs: string | null, text: string, channel?: string) => {
        posts.push({ threadTs, text, channel });
        return Promise.resolve({ ts: `901.${String(posts.length).padStart(6, "0")}` });
      },
      replies: () => Promise.resolve(replies),
      permalink: (ts: string, channel = CHANNEL) =>
        Promise.resolve(`https://goodparty.slack.com/archives/${channel}/p${ts.replaceAll(".", "")}`),
    },
  };
};

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

// ---------------------------------------------------------------------------
// A session shaped like incident 2's: Pi entries, a few enormous tool results.
// ---------------------------------------------------------------------------

let entry = 0;
const at = () => new Date(Date.parse("2026-09-30T13:00:00Z") + entry++ * 60_000).toISOString();

const assistant = (text: string, calls: { id: string; name: string; arguments: Record<string, string> }[]) =>
  JSON.stringify({
    type: "message",
    timestamp: at(),
    message: {
      role: "assistant",
      model: "us.anthropic.claude-opus-5",
      usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, cost: { total: 0.05 } },
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((c) => ({ type: "toolCall", ...c })),
      ],
    },
  });

const result = (toolCallId: string, toolName: string, text: string) =>
  JSON.stringify({
    type: "message",
    timestamp: at(),
    message: { role: "toolResult", toolCallId, toolName, isError: false, content: [{ type: "text", text }] },
  });

/** The middle of every big result, which must never reach the Boss. */
const BURIED = "BURIED-MIDDLE-OF-A-FILE";

const incidentTwoSession = (): string => {
  const lines: string[] = [];
  for (let i = 0; i < 7; i++) {
    const big = `${"const rule = alerting.rule(".repeat(600)}${BURIED}${"  threshold: 0.95,\n".repeat(600)}`;
    lines.push(
      assistant("", [{ id: `r${i}`, name: "read", arguments: { path: `packages/gp-api/src/alerts/rule-${i}.ts` } }]),
      result(`r${i}`, "read", big),
    );
  }
  lines.push(
    assistant("The alert rule is gone from the repo, so I am parking until a person decides.", [
      { id: "p1", name: "escalate", arguments: { brief: "Budget spent; the alert may already be removed." } },
    ]),
    result("p1", "escalate", "Escalated. The Boss has it."),
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------

let dir: string;
let db: Db;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-bossrun-"));
  db = await Db.open({ path: join(dir, "boss.db"), bucket: "bugboss-test", key: "state/db", s3: noS3() });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.withWrite((d) => {
    for (const table of [
      "incident_action",
      "incident_wait",
      "pending_question",
      "pending_wait",
      "boss_inbox",
      "pending_directive",
      "thread_reply",
      "signal",
      "incident_thread",
      "incident",
    ]) {
      d.prepare(`DELETE FROM ${table}`).run();
    }
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
});

const CLOSE_ASK = "Can we close this alert? I've since removed this alert completely.";
const human = { kind: "human" as const, user: "U0SWAIN", text: CLOSE_ASK, ts: "900.000500" };

/** The prod model's failure, as a rule: fed a result this wide, it answers with nothing. */
const CHOKES_AT = 100_000;

const build = (model: SizedModelClient, summary?: SizedModelClient) => {
  const { store, objects } = memoryStore();
  objects.set("sessions/incident/2/session.jsonl", incidentTwoSession());
  const slack = fakeSlack();
  slack.replies.push(
    { user: BOT, botId: "B0BUGBOSS", text: "*Incident 2 opened*", ts: THREAD },
    { user: "U0SWAIN", botId: null, text: CLOSE_ASK, ts: human.ts },
  );
  const harness = createSlackAgentModel(model, store);
  const returned: string[] = [];
  const recording: SlackAgentModel = {
    run: async (req) => {
      const out = await harness.run(req);
      returned.push(out.text);
      return out;
    },
  };
  const agent = new SlackAgent({
    openIncident: refuseOpen,
    db,
    store,
    slack: slack.client,
    model: recording,
    summaryModel: summary ?? model,
    config: { botUserId: BOT, alertChannel: ALERT, rotationGroupId: null, incidentChannel: CHANNEL },
    closeIncident: (args) =>
      closeIncidentByBoss(
        { db, slack: { post: (ts, text) => slack.client.post(ts, text, CHANNEL), permalink: (ts) => slack.client.permalink(ts) } },
        args,
      ),
  });
  return { agent, slack, objects, returned };
};

/**
 * What the Boss did in prod: get_incident, query_incidents, then the session
 * tail with the widest read it could ask for. Then, if what came back is as
 * wide as the raw tail was, nothing at all.
 */
const incidentTwoModel = (after: (request: ModelRequest) => ModelReply) => {
  const requests: ModelRequest[] = [];
  const reply = (text: string, name?: string, input: Record<string, unknown> = {}): ModelReply => ({
    text,
    toolCalls: name ? [{ id: `call-${requests.length}`, name, input }] : [],
    usage: emptyModelUsage(),
  });
  const model: SizedModelClient = {
    contextWindow: 1_000_000,
    complete: (request) => {
      requests.push(request);
      const results = request.messages.filter((m) => m.role === "toolResult");
      if (results.length === 0) return Promise.resolve(reply("", "get_incident", { incidentId: "2" }));
      if (results.length === 1) {
        return Promise.resolve(reply("", "query_incidents", { sql: "SELECT * FROM incident_wait WHERE incidentId = '2'" }));
      }
      if (results.length === 2) {
        return Promise.resolve(reply("", "read_agent_session", { incidentId: "2", tailLines: 60, turns: 60 }));
      }
      const last = results.at(-1);
      if (last && last.text.length >= CHOKES_AT) return Promise.resolve(reply(""));
      return Promise.resolve(after(request));
    },
  };
  return { model, requests, reply };
};

describe("incident 2, replayed", () => {
  test("premise: the raw tail it used to read was wide enough to choke on", () => {
    const body = incidentTwoSession();
    assert.ok(body.length >= 199_000, `the session is ${body.length} characters`);
    const rawTail = body.split("\n").slice(-60).join("\n");
    assert.ok(rawTail.length >= CHOKES_AT, "the old tool handed back all of it");
    assert.ok(rawTail.includes(BURIED));
  });

  test("a request to close, with the evidence given, is acted on and never met with silence", async () => {
    const { model, requests, reply } = incidentTwoModel((request) => {
      const closed = request.messages.some(
        (m) => m.role === "assistant" && m.toolCalls.some((c) => c.name === "close_incident"),
      );
      return closed
        ? reply("Closed incident 2: you removed the alert, so nothing is left for its agent to fix.")
        : reply("", "close_incident", {
            incidentId: "2",
            reason: "Swain removed this alert rule completely, said so in the thread, and the agent's own last turn found it gone from the repo.",
          });
    });
    const { agent, slack } = build(model);

    await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: human }));

    const read = requests[3].messages.filter((m) => m.role === "toolResult").at(-1);
    assert.ok(read, "the Boss read the session");
    assert.ok(read.text.length < 20_000, `it came back as ${read.text.length} characters, bounded`);
    assert.ok(!read.text.includes(BURIED), "and nothing was cut out of the middle of a file into it");
    assert.match(read.text, /read \d{2},\d{3} characters from packages\/gp-api\/src\/alerts\/rule-6\.ts/);

    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = '2'")?.status,
      "CLOSED",
      "the Boss acted",
    );
    const inThread = slack.posts.filter((p) => p.threadTs === THREAD);
    assert.ok(inThread.some((p) => /^\*Incident 2 closed\*/.test(p.text)), "the closed notice posted");
    assert.ok(inThread.some((p) => /you removed the alert/.test(p.text)), "and the Boss said what it did");
  });

  test("a model that still answers with nothing is a failure the thread hears about", async () => {
    // Every turn after the reads is empty, whatever it read: the worst case,
    // where bounding the read did not save the run.
    const { model, reply } = incidentTwoModel(() => reply(""));
    const { agent, slack, returned } = build(model);

    const lines = await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: human }));

    // The premise: what the harness handed back is exactly what the old
    // runIncident treated as a chosen silence -- `if (text.trim())` posted
    // nothing and logged `spoke: false` at info.
    assert.deepEqual(returned, [""], "premise: the run ended with no text");

    const alarm = lines.find((l) => l.includes("incident_run_silent_unchosen"));
    assert.ok(alarm, "it alarms");
    const parsed = JSON.parse(alarm) as Record<string, unknown>;
    assert.equal(parsed.level, "error");
    assert.equal(parsed.thread, `${CHANNEL}/${THREAD}`);
    assert.equal(parsed.trigger, "human");
    assert.equal(parsed.triggerTs, human.ts);
    assert.equal(parsed.triggerUser, human.user);

    const inThread = slack.posts.filter((p) => p.threadTs === THREAD);
    assert.equal(inThread.length, 1, "and the person who asked is told");
    assert.match(inThread[0].text, /could not finish/);
    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = '2'")?.status,
      "INVESTIGATING",
      "nothing changed that nobody asked for",
    );
  });

  test("a chosen silence posts nothing and raises nothing", async () => {
    const { model, reply } = incidentTwoModel((request) =>
      request.messages.some((m) => m.role === "toolResult" && /Silence recorded/.test(m.text))
        ? reply("")
        : reply("", "stay_silent", { reason: "the message was for another person in the thread" }),
    );
    const { agent, slack } = build(model);

    const lines = await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: human }));

    assert.equal(slack.posts.length, 0);
    assert.ok(!lines.some((l) => l.includes('"level":"error"')), lines.join("\n"));
    const chose = lines.find((l) => l.includes('"event":"stay_silent"'));
    assert.ok(chose);
    assert.match(chose, /the message was for another person in the thread/);
  });

  // Incident 2's real second failure, the same day: the Boss closed the
  // incident correctly, then called stay_silent as the prompt instructs --
  // and the harness asked the model for one more turn anyway, which is
  // where the literal text "(silpersisted)" reached the thread after
  // silence had already been chosen.
  test("stay_silent is terminal: a turn requested after it is chosen never happens, whatever it would have written", async () => {
    const { model, requests, reply } = incidentTwoModel((request) => {
      // Never reached if the fix holds. Requesting this turn at all is the
      // bug: production got exactly this shape and posted its answer.
      const silenced = request.messages.some(
        (m) => m.role === "toolResult" && /Silence recorded/.test(m.text),
      );
      if (silenced) return reply("(silpersisted)");
      const closed = request.messages.some(
        (m) => m.role === "assistant" && m.toolCalls.some((c) => c.name === "close_incident"),
      );
      return closed
        ? reply("", "stay_silent", { reason: "the closed notice already says it" })
        : reply("", "close_incident", {
            incidentId: "2",
            reason: "Swain removed this alert rule completely, said so in the thread, and the agent's own last turn found it gone from the repo.",
          });
    });
    const { agent, slack, returned } = build(model);

    const lines = await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: human }));

    assert.deepEqual(returned, [""], "the run ended on the turn that chose silence, not the one after it");
    assert.ok(
      !requests.some((r) => r.messages.some((m) => m.role === "toolResult" && /Silence recorded/.test(m.text))),
      "no request was ever built from a transcript that already recorded silence -- that request never went out",
    );

    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = '2'")?.status,
      "CLOSED",
      "close_incident, from the turn before, still ran",
    );
    const inThread = slack.posts.filter((p) => p.threadTs === THREAD);
    assert.ok(inThread.some((p) => /^\*Incident 2 closed\*/.test(p.text)), "the closed notice posted");
    assert.ok(
      !inThread.some((p) => p.text.includes("silpersisted")),
      "nothing from a turn after stay_silent reached the thread",
    );
    assert.ok(!lines.some((l) => l.includes('"level":"error"')), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes('"event":"stay_silent"')));
  });
});

describe("incident_status through the real harness", () => {
  const statusModel = (summaries: (string | Error)[]) => {
    const asked: ModelRequest[] = [];
    const model: SizedModelClient = {
      contextWindow: 1_000_000,
      complete: (request) => {
        asked.push(request);
        const next = summaries.shift();
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({ text: next ?? "", toolCalls: [], usage: emptyModelUsage() });
      },
    };
    return { model, asked };
  };

  const boss = (onTool: (name: string, text: string) => void) => {
    let turn = 0;
    const model: SizedModelClient = {
      contextWindow: 1_000_000,
      complete: (request) => {
        const last = request.messages.at(-1);
        if (last?.role === "toolResult") {
          onTool("incident_status", last.text);
          return Promise.resolve({ text: last.text, toolCalls: [], usage: emptyModelUsage() });
        }
        turn += 1;
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: `s-${turn}`, name: "incident_status", input: { incidentId: "2" } }],
          usage: emptyModelUsage(),
        });
      },
    };
    return model;
  };

  test("the card is pasted, the summary is paid for once per session position", async () => {
    const cards: string[] = [];
    const summary = statusModel([
      "It has parked itself because its turn budget is spent and it thinks the alert is already gone.",
      "It escalated again after reading one more rule file.",
    ]);
    const { agent, slack, objects } = build(boss((_, text) => cards.push(text)), summary.model);

    const ask = (ts: string) => ({ ...human, text: "what's the status of this incident?", ts });
    await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: ask("900.000600") }));
    await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: ask("900.000700") }));

    assert.equal(cards.length, 2);
    assert.equal(summary.asked.length, 1, "asking twice about an agent that has not moved is one call");
    assert.equal(cards[0], cards[1]);
    assert.match(cards[0], /^\*Incident 2\* · Stale alert on the export queue\n\*Investigating\* → Fixing → Resolved → Closed · \*PARKED\*/);
    assert.match(cards[0], /\*Now:\* It has parked itself because its turn budget is spent/);
    assert.doesNotMatch(cards[0], new RegExp(BURIED));
    assert.match(
      summary.asked[0].messages[0].role === "user" ? summary.asked[0].messages[0].text : "",
      /Turn \d+/,
      "the summary reads rendered turns, not JSONL",
    );
    assert.equal(slack.posts.filter((p) => p.threadTs === THREAD).at(-1)?.text.split("\n")[0], "*Incident 2* · Stale alert on the export queue");

    // The agent moves: a new entry is a new position, and a new sentence.
    const key = "sessions/incident/2/session.jsonl";
    objects.set(key, `${objects.get(key)}\n${assistant("One more rule file read.", [])}`);
    await captureLogs(() => agent.handleIncident({ incidentId: "2", trigger: ask("900.000800") }));
    assert.equal(summary.asked.length, 2);
    assert.match(cards[2], /\*Now:\* It escalated again after reading one more rule file\./);
  });

  test("a failed summary renders as unavailable, never as raw lines, and alarms", async () => {
    const cards: string[] = [];
    const summary = statusModel([new Error("bedrock throttled")]);
    const { agent } = build(boss((_, text) => cards.push(text)), summary.model);

    const lines = await captureLogs(() =>
      agent.handleIncident({ incidentId: "2", trigger: { ...human, text: "status?", ts: "900.000600" } }),
    );

    assert.match(cards[0], new RegExp(`\\*Now:\\* ${SUMMARY_UNAVAILABLE}\\n`));
    assert.doesNotMatch(cards[0], /Turn \d|"role"|const rule/);
    assert.ok(lines.some((l) => l.includes("status_summary_failed") && l.includes('"level":"error"')));
  });
});
