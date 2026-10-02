// The incident agent's extensions, driven through a real Pi Durable harness
// with a scripted model: containment by IncidentDoc, the replay policy, the
// turn budget, the bash guard, the inbox-watch wait, and a run killed in the
// middle of a tool round and resumed by a fresh process.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { ToolApi, ToolResponse } from "../types";
import {
  createIncidentExtensions,
  cutoverHandoff,
  incidentAgentChange,
  incidentInit,
  kickoffMessage,
  resumeMessage,
} from "./extension";
import {
  loadPi,
  openBugbossHarness,
  type BugbossHarness,
  type ConversationId,
  type Extension,
  type Storage,
} from "./harness";
import { createAgentPort } from "./port";
import type { SqlRequestPort } from "./sql";
import { directiveText } from "./tools";

const emptyS3 = (): S3Client =>
  ({
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      }
      return {};
    },
  }) as unknown as S3Client;

const noSql: SqlRequestPort = {
  createSqlRequest: async () => ({ status: 503, text: "unused" }),
  getSqlRequest: async () => ({ status: 503, text: "unused" }),
};

interface Call {
  incidentId: string;
  method: string;
  args: unknown;
}

/**
 * The tool API, recording which incident each call was built for. `hold`
 * names methods that block until the process dies, for the kill test.
 */
const fakeToolApi = (calls: Call[], onCall?: (call: Call) => Promise<void>) => (incidentId: string): ToolApi =>
  new Proxy({} as ToolApi, {
    get: (_target, method: string) => async (args: unknown): Promise<ToolResponse> => {
      const call = { incidentId, method, args };
      calls.push(call);
      await onCall?.(call);
      return { ok: true };
    },
  });

const openDb = async (dir: string, incidents: string[]): Promise<Db> => {
  const db = await Db.open({ path: join(dir, "bugboss.sqlite"), bucket: "test", key: "db", s3: emptyS3() });
  await db.withWrite((w) => {
    const insert = w.prepare("INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', 0)");
    for (const id of incidents) insert.run(id);
  });
  return db;
};

const shellEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

const setup = async (options: {
  dir: string;
  incidents?: string[];
  maxTurns?: number;
  storage?: Storage;
  onCall?: (call: Call) => Promise<void>;
  githubToken?: () => string | undefined;
}) => {
  mkdirSync(options.dir, { recursive: true });
  const pi = await loadPi();
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const faux = pi.ai.fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const db = await openDb(options.dir, options.incidents ?? ["7"]);
  const calls: Call[] = [];
  let bugboss: BugbossHarness | null = null;
  const extensions = await createIncidentExtensions({
    db,
    toolApiFor: fakeToolApi(calls, options.onCall),
    port: (incidentId) => createAgentPort({ db, incidentId, wakeBoss: () => {}, sql: noSql }),
    harness: () => {
      if (!bugboss) throw new Error("the harness is not open yet");
      return bugboss;
    },
    githubToken: options.githubToken ?? (() => undefined),
    shellEnv,
    maxTurns: () => options.maxTurns ?? 300,
    workRoot: options.dir,
  });
  const reports: unknown[] = [];
  bugboss = await openBugbossHarness({
    storage: options.storage ?? new pi.durable.MemoryStorage(),
    models,
    extensions,
    shellEnv: () => shellEnv(),
    onReport: (error) => reports.push(error),
  });
  bugboss.harness.resume();
  const opened = bugboss;
  const model = faux.getModel();

  const start = async (incidentId: string | null): Promise<ConversationId> => {
    const conversation = await opened.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: incidentAgentChange({
          model: { provider: model.provider, modelId: model.id },
          cwd: options.dir,
          instructions: "You are the incident agent.",
        }),
        ...(incidentId ? { init: incidentInit(incidentId) } : {}),
      },
      opened.context,
    );
    return conversation.id;
  };

  const run = async (id: ConversationId, content: string) => {
    const conversation = await opened.conversation(id);
    const submission = await conversation.submit({ type: "input", content }, opened.context);
    return submission.wait(opened.context);
  };

  const toolResults = async (id: ConversationId): Promise<{ name: string; text: string; isError: boolean }[]> => {
    const conversation = await opened.conversation(id);
    const view = await conversation.context(opened.context);
    return view.messages.flatMap((message) =>
      message.role === "toolResult"
        ? [
            {
              name: message.toolName,
              text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
              isError: message.isError,
            },
          ]
        : [],
    );
  };

  const userTexts = async (id: ConversationId): Promise<string[]> => {
    const conversation = await opened.conversation(id);
    const view = await conversation.context(opened.context);
    return view.messages.flatMap((message) =>
      message.role === "user"
        ? [typeof message.content === "string" ? message.content : message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")]
        : [],
    );
  };

  return {
    pi,
    ai: pi.ai,
    faux,
    db,
    calls,
    bugboss: opened,
    extensions,
    reports,
    start,
    run,
    toolResults,
    userTexts,
    close: async () => {
      await opened.close();
      extensions.close();
      db.close();
    },
  };
};

const tmp = () => mkdtempSync(join(tmpdir(), "bugboss-extension-"));

/** A scripted response that calls tools. The faux model says `stop` unless told. */
const calling = async (...calls: [string, Parameters<Awaited<ReturnType<typeof loadPi>>["ai"]["fauxToolCall"]>[1]][]) => {
  const { ai } = await loadPi();
  return ai.fauxAssistantMessage(
    calls.map(([name, args]) => ai.fauxToolCall(name, args)),
    { stopReason: "toolUse" },
  );
};

// ---------------------------------------------------------------------------
// The kill test's child: a process that runs one tool round and is killed in
// the middle of it. Run as this same file with the variable set, so the
// harness it opens is exactly the one under test.
// ---------------------------------------------------------------------------

const CHILD_DIR = process.env.BUGBOSS_EXTENSION_CHILD;

const runChild = async (dir: string): Promise<void> => {
  const pi = await loadPi();
  const log = join(dir, "executions.log");
  const env = await setup({
    dir: join(dir, "child"),
    storage: await pi.sqlite.openNodeSqliteStorage(join(dir, "harness.sqlite")),
    onCall: async (call) => {
      appendFileSync(log, `${call.method}\n`);
      // Both calls of the round block until the parent kills this process.
      await new Promise(() => {});
    },
  });
  env.faux.setResponses([
    await calling(["get_incident", {}], ["propose_merge", { incidentId: "8", reason: "the same pool exhaustion" }]),
  ]);
  const id = await env.start("7");
  writeFileSync(join(dir, "conversation"), String(id));
  const conversation = await env.bugboss.conversation(id);
  await conversation.submit({ type: "input", content: "go", requestId: "incident:7:launch:1" }, env.bugboss.context);
  await new Promise(() => {});
};

if (CHILD_DIR) {
  void runChild(CHILD_DIR);
} else {
  test("every incident tool reaches its own incident, and a conversation without one reaches none", async () => {
    const dir = tmp();
    const env = await setup({ dir, incidents: ["7", "8"] });
    try {
      const summary = (text: string) => calling(["set_summary", { summary: text }]);
      env.faux.setResponses([
        await summary("checkout 500s"),
        env.ai.fauxAssistantMessage("done"),
        await summary("login loop"),
        env.ai.fauxAssistantMessage("done"),
        await summary("nobody's"),
        env.ai.fauxAssistantMessage("done"),
      ]);
      const seven = await env.start("7");
      const eight = await env.start("8");
      const stray = await env.start(null);

      await env.run(seven, "go");
      await env.run(eight, "go");
      await env.run(stray, "go");

      assert.deepEqual(
        env.calls.map(({ incidentId, method }) => `${incidentId}:${method}`),
        ["7:setSummary", "8:setSummary"],
        "each call went to the conversation's own incident, and the stray one made none",
      );
      const strayResult = (await env.toolResults(stray))[0];
      assert.equal(strayResult.isError, true);
      assert.match(strayResult.text, /not bound to an incident; nothing was done/);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the replay policy is the design's, tool by tool", async () => {
    const dir = tmp();
    const env = await setup({ dir });
    try {
      const tools = new Map(
        (env.extensions as readonly Extension[]).flatMap((extension) =>
          (extension.tools ?? []).map((tool) => [tool.name, tool.replay ?? "unsafe"] as const),
        ),
      );
      const safe = [
        "get_incident",
        "search_incidents",
        "set_summary",
        "report_impact",
        "track_incident_timeline_event",
        "park",
        "read",
        "monitor",
        "message_boss",
        "escalate",
        "rerun_ci",
        "request_sql_query",
      ];
      const unsafe = ["bash", "edit", "write", "propose_merge", "report_root_cause", "report_resolved", "report_analysis"];
      for (const name of safe) assert.equal(tools.get(name), "safe", name);
      for (const name of unsafe) assert.equal(tools.get(name), "unsafe", name);
      assert.deepEqual([...tools.keys()].filter((name) => ["find", "grep", "ls"].includes(name)), []);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused argument is a tool result the model can correct, and nothing is called", async () => {
    const dir = tmp();
    const env = await setup({ dir });
    try {
      env.faux.setResponses([
        await calling(["report_resolved", { prUrls: ["<!channel>"], evidence: "quiet" }]),
        env.ai.fauxAssistantMessage("ok"),
      ]);
      const id = await env.start("7");
      await env.run(id, "go");

      const result = (await env.toolResults(id))[0];
      assert.match(result.text, /^error: invalid arguments: prUrls\.0/);
      assert.deepEqual(env.calls, []);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the turn budget counts into the row, steers once at the grace edge, and parks and stops at the cap", async () => {
    const dir = tmp();
    const env = await setup({ dir, maxTurns: 4 });
    try {
      const summary = () => calling(["set_summary", { summary: "still looking" }]);
      env.faux.setResponses([await summary(), await summary(), await summary(), await summary(), await summary(), await summary()]);
      const id = await env.start("7");
      await env.run(id, "go");
      await (await env.bugboss.conversation(id)).waitForIdle(env.bugboss.context);

      assert.equal(env.db.get<{ turnsUsed: number }>("SELECT turnsUsed FROM incident WHERE id = '7'")?.turnsUsed, 4);
      assert.equal(env.faux.state.callCount, 4, "no request after the cap");
      const steers = (await env.userTexts(id)).filter((text) => text.startsWith("You have used"));
      assert.equal(steers.length, 1, "one steer, however many grace turns follow it");
      assert.match(steers[0], /You have used 2 of the 4 turns/);
      const parks = env.calls.filter((call) => call.method === "park");
      assert.deepEqual(parks.map((call) => call.args), [
        { waitingFor: "a person to decide what happens next; the 4-turn budget is spent", liftsOnReply: false },
      ]);
      const escalations = env.db.query<{ text: string }>(
        "SELECT text FROM boss_inbox WHERE incidentId = '7' AND kind = 'escalation'",
      );
      assert.equal(escalations.length, 1);
      assert.match(escalations[0].text, /^turn budget of 4 turns exhausted/);
      assert.match(escalations[0].text, /I used all 4 turns this incident gets/);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent that escalated inside its grace is not announced over, and is still parked", async () => {
    const dir = tmp();
    const env = await setup({ dir, maxTurns: 4 });
    try {
      const summary = () => calling(["set_summary", { summary: "x" }]);
      env.faux.setResponses([
        await summary(),
        await summary(),
        await summary(),
        // The cap lands on the very response that escalates; its tool still
        // runs before the budget looks, so the brief is seen and not cut off.
        await calling(["escalate", { reason: "out of road", brief: "my brief" }]),
        await summary(),
      ]);
      const id = await env.start("7");
      await env.run(id, "go");
      await (await env.bugboss.conversation(id)).waitForIdle(env.bugboss.context);

      const escalations = env.db.query<{ text: string }>(
        "SELECT text FROM boss_inbox WHERE incidentId = '7' AND kind = 'escalation'",
      );
      assert.deepEqual(escalations.map((row) => row.text), ["out of road\n\nmy brief"]);
      assert.equal(env.calls.filter((call) => call.method === "park").length, 1, "announcing is not stopping");
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bash refuses a sleep and gh's watchers, and runs nothing", async () => {
    const dir = tmp();
    const env = await setup({ dir });
    try {
      env.faux.setResponses([
        await calling(["bash", { command: "sleep 600; touch ran" }]),
        env.ai.fauxAssistantMessage("ok"),
      ]);
      const id = await env.start("7");
      await env.run(id, "go");

      const result = (await env.toolResults(id))[0];
      assert.match(result.text, /Refused, nothing ran: this bash call waits \(sleep 600s\)/);
      assert.match(result.text, /monitor/);
      assert.equal(existsSync(join(dir, "ran")), false);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bash never sees the Boss's secrets, and does see a fresh GitHub token", async () => {
    const dir = tmp();
    process.env.BUGBOSS_SECRETS = "do-not-leak";
    let minted = 0;
    const env = await setup({ dir, githubToken: () => `ghs_token_${(minted += 1)}` });
    try {
      env.faux.setResponses([
        await calling(["bash", { command: "env > seen.txt" }]),
        env.ai.fauxAssistantMessage("ok"),
      ]);
      const id = await env.start("7");
      await env.run(id, "go");

      const seen = readFileSync(join(dir, "seen.txt"), "utf8");
      assert.doesNotMatch(seen, /do-not-leak/);
      assert.match(seen, /^PATH=/m);
      assert.match(seen, /^GITHUB_TOKEN=ghs_token_\d+$/m, "read at the call, not captured at launch");
      assert.match(seen, /^GH_TOKEN=ghs_token_\d+$/m);
    } finally {
      delete process.env.BUGBOSS_SECRETS;
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wait spends no model request between the call and the condition", async () => {
    const dir = tmp();
    const env = await setup({ dir });
    try {
      env.faux.setResponses([
        await calling([
          "monitor",
          { command: "test -f ready", intervalSeconds: 1, timeoutSeconds: 30, description: "the flag", waitingFor: "the flag" },
        ]),
        env.ai.fauxAssistantMessage("it is ready"),
      ]);
      // The monitor runs in the incident's checkout, which this test's work
      // root makes `<dir>/7/omni`.
      const checkout = join(dir, "7", "omni");
      mkdirSync(checkout, { recursive: true });
      const id = await env.start("7");
      setTimeout(() => writeFileSync(join(checkout, "ready"), ""), 1500);
      await env.run(id, "go");

      assert.equal(env.faux.state.callCount, 2, "one request to start the wait, one after it fired");
      assert.match((await env.toolResults(id))[0].text, /^Condition met: the flag/);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Boss steer ends an hour-long wait within moments and is the next thing the model reads", async () => {
    const dir = tmp();
    const env = await setup({ dir });
    try {
      let seenByNext = "";
      env.faux.setResponses([
        await calling([
          "monitor",
          { command: "false", intervalSeconds: 600, timeoutSeconds: 3000, description: "the merge", waitingFor: "the merge" },
        ]),
        (context) => {
          seenByNext = JSON.stringify(context.messages);
          return env.ai.fauxAssistantMessage("standing down");
        },
      ]);
      mkdirSync(join(dir, "7", "omni"), { recursive: true });
      const id = await env.start("7");
      const conversation = await env.bugboss.conversation(id);
      const submission = await conversation.submit({ type: "input", content: "go" }, env.bugboss.context);
      while (env.faux.state.callCount < 1) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const started = Date.now();
      await conversation.submit(
        {
          type: "input",
          content: directiveText({ type: "boss_message", text: "stand down, a person has it", at: 0 }),
          whenBusy: "steer",
          requestId: "boss:1",
        },
        env.bugboss.context,
      );
      await submission.wait(env.bugboss.context);

      assert.ok(Date.now() - started < 5000, "the wait returned on the steer, not on its 600s interval");
      assert.match((await env.toolResults(id))[0].text, /\(interrupted\)/);
      assert.match(seenByNext, /The Boss says: stand down, a person has it/);
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run killed in the middle of a tool round resumes in a fresh process", async () => {
    const dir = tmp();
    const log = join(dir, "executions.log");
    const child = spawn(process.execPath, [...process.execArgv, __filename], {
      env: { ...process.env, BUGBOSS_EXTENSION_CHILD: dir },
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const deadline = Date.now() + 15_000;
      while (!(existsSync(log) && readFileSync(log, "utf8").trim().split("\n").length >= 2)) {
        if (Date.now() > deadline) throw new Error("the child never started its tool round");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      child.kill("SIGKILL");
    }
    await exited;
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").sort(), ["getIncident", "proposeMerge"]);

    const pi = await loadPi();
    const env = await setup({
      dir: join(dir, "parent"),
      storage: await pi.sqlite.openNodeSqliteStorage(join(dir, "harness.sqlite")),
    });
    try {
      env.faux.setResponses([env.ai.fauxAssistantMessage("carrying on")]);
      const id = Number(readFileSync(join(dir, "conversation"), "utf8")) as ConversationId;
      const conversation = await env.bugboss.conversation(id);
      await conversation.waitForIdle(env.bugboss.context);

      assert.deepEqual(
        env.calls.map((call) => call.method),
        ["getIncident"],
        "the replay-safe read ran again; the unsafe merge proposal did not",
      );
      const results = new Map((await env.toolResults(id)).map((result) => [result.name, result]));
      assert.match(results.get("get_incident")?.text ?? "", /^ok/);
      assert.equal(results.get("propose_merge")?.isError, true);
      assert.match(results.get("propose_merge")?.text ?? "", /interrupted/);

      // The dispatcher's launch submit is idempotent on its request id, so a
      // relaunch that resends it finds the original submission.
      const again = await conversation.submit(
        { type: "input", content: "go", requestId: "incident:7:launch:1" },
        env.bugboss.context,
      );
      const settled = await again.wait(env.bugboss.context);
      assert.equal(settled.status, "done");
      assert.equal(env.faux.state.callCount, 1, "the resent launch made no second request");
    } finally {
      await env.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the launch messages say what kind of launch it is", async () => {
    assert.match(kickoffMessage("12"), /^Incident 12 is yours\. Call get_incident/);
    const cutover = kickoffMessage("12", { resumedWithoutTranscript: true, handoff: "## The incident record\n{}" });
    assert.match(cutover, /you start without your own history/);
    assert.match(cutover, /Do not start the investigation again from nothing/);
    assert.ok(cutover.endsWith("## The incident record\n{}"));

    assert.match(resumeMessage("cloned", false), /fresh clone of main/);
    assert.match(resumeMessage("reused_unfetched", true), /Fetching origin failed/);
    assert.match(resumeMessage("reused_unfetched", true), /npm ci failed in this workspace/);
    assert.doesNotMatch(resumeMessage("reused", false), /resumed_after|directive/);
  });

  test("the cutover handoff carries the durable story whole", async () => {
    const dir = tmp();
    const db = await openDb(dir, ["7"]);
    try {
      await db.withWrite((w) => {
        w.prepare(
          "INSERT INTO incident_timeline_event (incidentId, kind, occurredAt, recordedAt, summary) VALUES ('7', 'first_error', 1000, 1000, 'first 502')",
        ).run();
        w.prepare(
          "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES ('7', 'question', 'can someone merge omni#1?', 2000)",
        ).run();
        w.prepare(
          "INSERT INTO pending_question (incidentId, messageTs, askedAt, message) VALUES ('7', '', 2000, 'can someone merge omni#1?')",
        ).run();
      });
      const story = cutoverHandoff(db, "7");
      assert.match(story, /first_error: first 502/);
      assert.match(story, /question:\ncan someone merge omni#1\?/);
      assert.match(story, /A question to the Boss since .*unanswered: can someone merge omni#1\?/);
      assert.match(story, /No monitor wait was open/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
