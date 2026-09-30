import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { WebClient } from "@slack/web-api";

import { startSlackStandin, type SlackStandin } from "../standins/slack/server";
import { createPersona, type PersonaConfig } from "./agent";
import { createPersonaGitHub } from "./github";
import type { AssistantBlock, Completion, PersonaMessage, PersonaModel } from "./model";
import { resolvePersonaModelId } from "./model";
import { createSlackControl } from "./tools";

const CHANNEL = "C0INCIDENT";
const HEAD = "a".repeat(40);

let slack: SlackStandin;
let bot: WebClient;
let github: Server;
let githubUrl: string;
let githubCalls: { method: string; url: string; auth: string; body: string }[] = [];
let mergeStatus = 200;

before(async () => {
  slack = await startSlackStandin({
    store: {
      channels: [CHANNEL],
      users: [
        { id: "U0BUGBOSS", name: "bugboss", realName: "BugBoss", isBot: true },
        { id: "U0ONCALL", name: "casey", realName: "Casey", isBot: false },
      ],
      usergroups: {},
      botUserId: "U0BUGBOSS",
      botId: "B0BUGBOSS",
      teamId: "T0SIM",
      workspaceDomain: "goodparty-sim.slack.com",
    },
    botToken: "xoxb-sim",
    events: null,
    port: 0,
    controlPort: 0,
    host: "127.0.0.1",
    controlToken: "ctl",
  });
  bot = new WebClient("xoxb-sim", { slackApiUrl: slack.apiUrl, retryConfig: { retries: 0 } });

  github = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      githubCalls.push({ method: req.method ?? "", url, auth: String(req.headers.authorization), body });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      };
      if (url === "/api/v3/repos/thegoodparty/omni/pulls/7" && req.method === "GET") {
        if (String(req.headers.accept).includes("diff")) {
          res.writeHead(200, { "content-type": "text/plain" }).end("diff --git a/x b/x\n+fix\n");
          return;
        }
        json(200, {
          number: 7,
          title: "Share one voter-density query",
          body: "Stops the pool running dry.",
          state: "open",
          user: { login: "bugboss[bot]" },
          head: { sha: HEAD, ref: "bugboss/incident-1" },
          base: { ref: "main" },
        });
        return;
      }
      if (url === `/api/v3/repos/thegoodparty/omni/commits/${HEAD}/check-runs`) {
        json(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
        return;
      }
      if (url === "/api/v3/repos/thegoodparty/omni/pulls/7/reviews" && req.method === "GET") {
        json(200, []);
        return;
      }
      if (url === "/api/v3/repos/thegoodparty/omni/pulls/7/reviews" && req.method === "POST") {
        json(200, { id: 1, state: "APPROVED" });
        return;
      }
      if (url === "/api/v3/repos/thegoodparty/omni/pulls/7/merge" && req.method === "PUT") {
        if (mergeStatus === 200) json(200, { merged: true, sha: "b".repeat(40) });
        else json(mergeStatus, { message: "Required status check is failing" });
        return;
      }
      json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", () => r()));
  githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}/api/v3`;
});

after(async () => {
  await slack.close();
  await new Promise<void>((r) => github.close(() => r()));
});

beforeEach(() => {
  slack.store.reset();
  githubCalls = [];
  mergeStatus = 200;
});

// A model that plays back one reply per call and records what it was shown.
const scripted = (replies: AssistantBlock[][]) => {
  const seen: { system: string; messages: PersonaMessage[] }[] = [];
  const model: PersonaModel = {
    id: "us.anthropic.claude-opus-5",
    complete: async ({ system, messages }): Promise<Completion> => {
      seen.push({ system, messages: structuredClone(messages) });
      const content = replies.shift() ?? [{ type: "text", text: "nothing to do" }];
      return { content, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  return { model, seen };
};

const fakeClock = () => {
  let t = Date.parse("2026-09-29T12:00:00Z");
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
};

const persona = (model: PersonaModel, clock: ReturnType<typeof fakeClock>, extra: Partial<PersonaConfig> = {}) =>
  createPersona({
    brief: "You are Casey, the on-call backend engineer. You know election-api well.",
    model,
    slack: createSlackControl({ controlUrl: slack.controlUrl, token: "ctl" }),
    github: createPersonaGitHub({ apiUrl: githubUrl, token: "human-casey", repo: "thegoodparty/omni" }),
    channel: CHANNEL,
    userId: "U0ONCALL",
    botUserId: "U0BUGBOSS",
    replyDelaySeconds: [20, 90],
    mergeDelaySeconds: 300,
    seed: 42,
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  });

const textOf = (m: PersonaMessage) =>
  m.content.map((b) => ("text" in b ? b.text : "")).join("");

test("the persona answers the Boss's question in the thread, in its own words, after the reply delay", async () => {
  const open = await bot.chat.postMessage({ channel: CHANNEL, text: "Incident 1: election-api 502s" });
  await bot.chat.postMessage({
    channel: CHANNEL,
    thread_ts: open.ts,
    text: "What is the Prisma connection limit on election-api in prod?",
  });
  const { model, seen } = scripted([
    [
      {
        type: "tool_use",
        id: "t1",
        name: "reply_in_thread",
        input: { thread_ts: open.ts, text: "It's 25 per task, and we run two tasks." },
      },
    ],
    [{ type: "text", text: "done" }],
  ]);
  const clock = fakeClock();
  const p = persona(model, clock);

  assert.equal(await p.tick(), true);

  assert.equal(clock.slept.length, 1);
  assert.ok(clock.slept[0] >= 20_000 && clock.slept[0] <= 90_000, `slept ${clock.slept[0]}`);
  const shown = textOf(seen[0].messages[0]);
  assert.match(shown, /\(new\) BugBoss: What is the Prisma connection limit/);
  assert.match(seen[0].system, /plain English/);
  assert.match(seen[0].system, /no commands and no keywords/);

  const thread = slack.store.snapshot().threads[0].messages;
  const reply = thread.at(-1)!;
  assert.equal(reply.user, "U0ONCALL");
  assert.equal(reply.botId, null);
  assert.equal(reply.text, "It's 25 per task, and we run two tasks.");

  // Nothing new from BugBoss, so the next look does nothing and costs nothing.
  assert.equal(await p.tick(), false);
  assert.equal(p.stats().calls, 2);
  assert.ok(p.stats().costUsd! > 0);
});

test("two sides with the same seed wait the same delays", async () => {
  const draw = async () => {
    slack.store.reset();
    await bot.chat.postMessage({ channel: CHANNEL, text: "Incident 1" });
    const clock = fakeClock();
    await persona(scripted([]).model, clock).tick();
    return clock.slept[0];
  };
  assert.equal(await draw(), await draw());
});

test("staying silent posts nothing", async () => {
  await bot.chat.postMessage({ channel: CHANNEL, text: "Incident 1 resolved; nothing needed from anyone." });
  const clock = fakeClock();
  await persona(scripted([[{ type: "text", text: "Nothing for me here." }]]).model, clock).tick();
  const messages = slack.store.snapshot().threads.flatMap((t) => t.messages);
  assert.ok(messages.every((m) => m.user === "U0BUGBOSS"));
});

test("a review goes in as the human, and the merge waits the scenario's merge delay", async () => {
  const open = await bot.chat.postMessage({ channel: CHANNEL, text: "Incident 1" });
  await bot.chat.postMessage({
    channel: CHANNEL,
    thread_ts: open.ts,
    text: "PR #7 is green and the reviewer approved. Could you review and merge it?",
  });
  const { model, seen } = scripted([
    [{ type: "tool_use", id: "a", name: "view_pull_request", input: { number: 7 } }],
    [{ type: "tool_use", id: "b", name: "view_pull_request_diff", input: { number: 7 } }],
    [
      {
        type: "tool_use",
        id: "c",
        name: "review_pull_request",
        input: { number: 7, verdict: "approve", body: "Looks right." },
      },
      { type: "tool_use", id: "d", name: "merge_pull_request", input: { number: 7 } },
    ],
    [{ type: "tool_use", id: "e", name: "reply_in_thread", input: { thread_ts: open.ts, text: "Approved, merging shortly." } }],
    [{ type: "text", text: "done" }],
    // The turn after the merge lands.
    [{ type: "tool_use", id: "f", name: "reply_in_thread", input: { thread_ts: open.ts, text: "Merged." } }],
    [{ type: "text", text: "done" }],
  ]);
  const clock = fakeClock();
  const p = persona(model, clock);

  await p.tick();
  const viewed = seen[1].messages.at(-1)!;
  assert.match(JSON.stringify(viewed), /ci: completed, success/);
  const review = githubCalls.find((c) => c.method === "POST" && c.url.endsWith("/pulls/7/reviews"))!;
  assert.equal(review.auth, "token human-casey");
  assert.deepEqual(JSON.parse(review.body), { event: "APPROVE", body: "Looks right." });
  assert.equal(githubCalls.some((c) => c.method === "PUT"), false, "no merge before the delay");

  clock.advance(299_000);
  assert.equal(await p.tick(), false);
  assert.equal(githubCalls.some((c) => c.method === "PUT"), false);

  clock.advance(1_000);
  assert.equal(await p.tick(), true);
  const merge = githubCalls.find((c) => c.method === "PUT")!;
  assert.equal(merge.auth, "token human-casey");
  assert.match(textOf(seen.at(-2)!.messages[0]), /Your merge of #7 went through/);
  assert.equal(slack.store.snapshot().threads[0].messages.at(-1)!.text, "Merged.");
});

test("a refused merge is told back to the persona with GitHub's reason", async () => {
  mergeStatus = 405;
  await bot.chat.postMessage({ channel: CHANNEL, text: "Incident 1" });
  const { model, seen } = scripted([
    [{ type: "tool_use", id: "d", name: "merge_pull_request", input: { number: 7 } }],
    [{ type: "text", text: "ok" }],
  ]);
  const clock = fakeClock();
  const p = persona(model, clock, { mergeDelaySeconds: 0 });
  await p.tick();
  await p.tick();
  assert.match(textOf(seen.at(-1)!.messages[0]), /refused by GitHub: HTTP 405[\s\S]*Required status check/);
});

test("the persona reads the closing report whole", async () => {
  const open = await bot.chat.postMessage({ channel: CHANNEL, text: "Incident 1" });
  const content = `# Incident 1\n\n${"The pool ran dry. ".repeat(3000)}`;
  const body = Buffer.from(content, "utf8");
  const ticket = await bot.files.getUploadURLExternal({ filename: "incident-1.md", length: body.byteLength });
  await fetch(ticket.upload_url!, { method: "POST", body });
  await bot.files.completeUploadExternal({
    files: [{ id: ticket.file_id!, title: "Incident 1 — closing report" }],
    channel_id: CHANNEL,
    thread_ts: open.ts,
    initial_comment: "Closing report",
  });
  const { model, seen } = scripted([[{ type: "text", text: "fine" }]]);
  await persona(model, fakeClock()).tick();
  assert.ok(textOf(seen[0].messages[0]).includes(content));
});

test("model aliases resolve to Bedrock ids, and an unknown name is refused", () => {
  assert.equal(resolvePersonaModelId("sonnet"), "us.anthropic.claude-sonnet-5");
  assert.equal(resolvePersonaModelId("us.anthropic.claude-opus-5"), "us.anthropic.claude-opus-5");
  assert.throws(() => resolvePersonaModelId("gpt"));
});
