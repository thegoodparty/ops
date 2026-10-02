// Questions 3 and 4: the commander on the same harness as the agents.
//
// Today the commander has its own turn loop, its own compactor, a TTL lock per
// thread and a waiting map for messages that land mid-run; it reaches an
// agent through a pending_directive row the child polls every 10s, and a
// createWaitInterrupt that aborts a blocking tool so the steer can land. Here
// every Slack thread is a conversation, the agent is a conversation, and
// message_agent is one submit.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { answerText, context, openSpikeHarness } from "./harness.mts";

const model = { provider: "faux", modelId: "faux-1" };
// pi-ai 1.0 carries the system prompt as system messages in the transcript.
const isBoss = (transcript: TranscriptContext) =>
  JSON.stringify(transcript.messages.filter((message) => message.role === "system")).includes(
    "BugBoss commander",
  );
const lastUserText = (transcript: TranscriptContext) => {
  const users = transcript.messages.filter((message) => message.role === "user");
  const content = users.at(-1)?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};

test("two incident threads get answers at the same time", async () => {
  let inFlight = 0;
  let peak = 0;
  let releaseBoth!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const answer = async (transcript: TranscriptContext) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    if (inFlight === 2) releaseBoth();
    // Neither answer may finish until both requests are open at once. If the
    // harness ran threads one at a time this would time out instead.
    let guard: NodeJS.Timeout | undefined;
    await Promise.race([
      bothStarted,
      new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error("threads ran serially")), 5_000);
      }),
    ]).finally(() => clearTimeout(guard));
    inFlight -= 1;
    return fauxAssistantMessage([fauxText(`answering: ${lastUserText(transcript)}`)]);
  };
  const faux = fauxProvider();
  faux.setResponses([answer, answer]);
  const models = createModels();
  models.setProvider(faux.provider);
  const { harness, boss } = await openSpikeHarness(new MemoryStorage(), models);

  const thread = () =>
    harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model, extensions: [boss] } },
      context,
    );
  const [incident4, incident9] = await Promise.all([thread(), thread()]);
  const [a, b] = await Promise.all([
    incident4.submit({ type: "input", content: "is incident 4 still firing?" }, context),
    incident9.submit({ type: "input", content: "who owns incident 9?" }, context),
  ]);
  const [settledA, settledB] = await Promise.all([a.wait(context), b.wait(context)]);

  assert.equal(peak, 2);
  if (settledA.status !== "done" || settledA.type !== "input") throw new Error("thread 4 unanswered");
  if (settledB.status !== "done" || settledB.type !== "input") throw new Error("thread 9 unanswered");
  assert.equal(await answerText(harness, incident4.id, settledA.answer), "answering: is incident 4 still firing?");
  assert.equal(await answerText(harness, incident9.id, settledB.answer), "answering: who owns incident 9?");
  await harness.close(context);
});

test("the Boss steers an agent that is blocked in a wait, and the steer lands at once", async () => {
  let agentContinued: TranscriptContext | undefined;
  let bossContinued: TranscriptContext | undefined;
  let incidentId = "";
  const script = (transcript: TranscriptContext) => {
    const turns = transcript.messages.filter((message) => message.role === "assistant").length;
    if (isBoss(transcript)) {
      return turns === 0
        ? fauxAssistantMessage(
            [fauxToolCall("message_agent", { conversation: incidentId, message: "check the DB pool first" }, { id: "b1" })],
            { stopReason: "toolUse" },
          )
        : ((bossContinued = transcript), fauxAssistantMessage([fauxText("Told the agent to check the DB pool.")]));
    }
    if (turns === 0) {
      return fauxAssistantMessage([fauxToolCall("monitor", { what: "the deploy" }, { id: "m1" })], {
        stopReason: "toolUse",
      });
    }
    agentContinued = transcript;
    return fauxAssistantMessage([fauxText("Checked the pool: exhausted at 25 connections.")]);
  };
  const faux = fauxProvider();
  faux.setResponses([script, script, script, script]);
  const models = createModels();
  models.setProvider(faux.provider);

  let monitorStarted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    monitorStarted = resolve;
  });
  const { harness, incident, boss } = await openSpikeHarness(new MemoryStorage(), models, {
    // An hour: the steer has to end this wait, or the test times out.
    monitorMs: 3_600_000,
    monitorStarted: () => monitorStarted(),
  });

  const agent = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model, extensions: [incident] } },
    context,
  );
  incidentId = String(agent.id);
  const work = await agent.submit({ type: "input", content: "incident 4: 502s on election-api" }, context);
  await waiting;

  const started = Date.now();
  const thread = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model, extensions: [boss] } },
    context,
  );
  const said = await (
    await thread.submit({ type: "input", content: "tell the agent to look at the DB pool before anything else" }, context)
  ).wait(context);
  const done = await work.wait(context);
  const elapsed = Date.now() - started;

  if (said.status !== "done" || said.type !== "input") throw new Error("the Boss did not answer");
  assert.equal(await answerText(harness, thread.id, said.answer), "Told the agent to check the DB pool.");
  if (done.status !== "done" || done.type !== "input") throw new Error("the agent did not finish");
  assert.equal(await answerText(harness, agent.id, done.answer), "Checked the pool: exhausted at 25 connections.");

  assert.match(
    JSON.stringify(bossContinued!.messages.find((message) => message.role === "toolResult")),
    /delivered/,
  );
  const messages = agentContinued!.messages;
  const monitorResult = JSON.stringify(messages.find((message) => message.role === "toolResult"));
  assert.match(monitorResult, /the Boss sent a message/);
  assert.match(JSON.stringify(messages.at(-1)), /The Boss says: check the DB pool first/);
  assert.ok(elapsed < 5_000, `steer took ${elapsed}ms to land`);
  await harness.close(context);
});
