import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BEDROCK_INVOKE_MODEL_API } from "../bedrock/index";
import { BEDROCK_PROVIDER_ID } from "../bedrock/runtime";
import {
  type ConversationId,
  createBugbossModels,
  type EntryId,
  type Extension,
  loadPi,
  openBugbossHarness,
  type Storage,
} from "./harness";

const fauxSetup = async () => {
  const { ai } = await loadPi();
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const faux = ai.fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { ai, faux, models };
};

const open = async (storage: Storage, extensions: readonly Extension[] = []) => {
  const { ai, faux, models } = await fauxSetup();
  const reports: unknown[] = [];
  const bugboss = await openBugbossHarness({
    storage,
    models,
    extensions,
    shellEnv: () => ({ PATH: process.env.PATH ?? "" }),
    onReport: (error) => reports.push(error),
  });
  return { ai, faux, bugboss, reports };
};

/** The text of an input's answer, as the Boss posts it. */
const answerOf = async (
  bugboss: Awaited<ReturnType<typeof openBugbossHarness>>,
  id: ConversationId,
  entryId: EntryId,
): Promise<string> => {
  const { durable } = await loadPi();
  const conversation = await bugboss.conversation(id);
  const entry = await conversation.commit((tx) => tx.entry(durable.AssistantEntry, entryId), bugboss.context);
  const message = entry?.model?.[0];
  if (!message || message.role !== "assistant") return "";
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

const createConversation = async (
  bugboss: Awaited<ReturnType<typeof openBugbossHarness>>,
  modelRef: { provider: string; modelId: string },
): Promise<ConversationId> => {
  const conversation = await bugboss.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: modelRef } },
    bugboss.context,
  );
  return conversation.id;
};

test("loadPi memoizes one runtime", async () => {
  assert.equal(await loadPi(), await loadPi());
});

test("a submitted input settles, and its answer, usage and entries are readable", async () => {
  const { pi } = { pi: await loadPi() };
  const storage = new pi.durable.MemoryStorage();
  const { ai, faux, bugboss, reports } = await open(storage);
  try {
    faux.setResponses([ai.fauxAssistantMessage("the 500s are the db pool")]);
    const model = faux.getModel();
    const id = await createConversation(bugboss, { provider: model.provider, modelId: model.id });

    assert.equal(await bugboss.isBusy(id), false);
    const conversation = await bugboss.conversation(id);
    const submission = await conversation.submit(
      { type: "input", content: "why are we 500ing", requestId: "t:1" },
      bugboss.context,
    );
    const settled = await submission.wait(bugboss.context);

    assert.equal(settled.status, "done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("unreachable");
    assert.equal(await answerOf(bugboss, id, settled.answer), "the 500s are the db pool");
    assert.equal(await bugboss.isBusy(id), false);
    assert.equal(await bugboss.countTurns(id), 1);

    const usage = await bugboss.usage(id);
    const bucket = usage.models[`${model.provider}/${model.id}`];
    assert.ok(bucket, "the generation's spend landed in pi.usage");
    assert.ok(bucket.output > 0);
    assert.deepEqual(reports, []);
  } finally {
    await bugboss.close();
  }
});

test("a conversation is busy while its run is in flight", async () => {
  const pi = await loadPi();
  const { ai, faux, bugboss } = await open(new pi.durable.MemoryStorage());
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    faux.setResponses([
      async () => {
        started();
        await gate;
        return ai.fauxAssistantMessage("done");
      },
    ]);
    const model = faux.getModel();
    const id = await createConversation(bugboss, { provider: model.provider, modelId: model.id });
    const conversation = await bugboss.conversation(id);
    const submission = await conversation.submit({ type: "input", content: "go" }, bugboss.context);

    await reached;
    assert.equal(await bugboss.isBusy(id), true);
    release();
    await submission.wait(bugboss.context);
    assert.equal(await bugboss.isBusy(id), false);
  } finally {
    await bugboss.close();
  }
});

test("an absent conversation throws rather than returning undefined", async () => {
  const pi = await loadPi();
  const { bugboss } = await open(new pi.durable.MemoryStorage());
  try {
    await assert.rejects(bugboss.conversation(9999 as ConversationId), /no harness conversation 9999/);
  } finally {
    await bugboss.close();
  }
});

test("onCommit fires for commits and stops after unsubscribe", async () => {
  const pi = await loadPi();
  const { faux, bugboss } = await open(new pi.durable.MemoryStorage());
  try {
    let commits = 0;
    const stop = bugboss.onCommit(() => {
      commits += 1;
    });
    const model = faux.getModel();
    await createConversation(bugboss, { provider: model.provider, modelId: model.id });
    assert.ok(commits > 0);
    stop();
    const before = commits;
    await createConversation(bugboss, { provider: model.provider, modelId: model.id });
    assert.equal(commits, before);
  } finally {
    await bugboss.close();
  }
});

test("a reopened harness over the same SQLite file resumes the conversation", async () => {
  const pi = await loadPi();
  const dir = mkdtempSync(join(tmpdir(), "bugboss-harness-"));
  const path = join(dir, "harness.sqlite");
  try {
    const first = await open(await pi.sqlite.openNodeSqliteStorage(path));
    const model = first.faux.getModel();
    first.faux.setResponses([first.ai.fauxAssistantMessage("first")]);
    const id = await createConversation(first.bugboss, { provider: model.provider, modelId: model.id });
    const conversation = await first.bugboss.conversation(id);
    await (await conversation.submit({ type: "input", content: "one" }, first.bugboss.context)).wait(
      first.bugboss.context,
    );
    await first.bugboss.close();

    const second = await open(await pi.sqlite.openNodeSqliteStorage(path));
    try {
      second.faux.setResponses([second.ai.fauxAssistantMessage("second")]);
      second.bugboss.harness.resume();
      const again = await second.bugboss.conversation(id);
      const settled = await (
        await again.submit({ type: "input", content: "two" }, second.bugboss.context)
      ).wait(second.bugboss.context);
      if (settled.status !== "done" || settled.type !== "input") throw new Error("unreachable");
      assert.equal(await answerOf(second.bugboss, id, settled.answer), "second");
      assert.equal(await second.bugboss.countTurns(id), 2);
    } finally {
      await second.bugboss.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a conversation with a cwd gets a shell on the shellEnv allowlist only; one without gets none", async () => {
  const pi = await loadPi();
  const seen: { id: ConversationId; hasEnv: boolean; home?: string }[] = [];
  const probe: Extension = {
    name: "test.probe",
    tools: [
      {
        name: "probe",
        description: "report the environment",
        parameters: (await import("typebox")).Type.Object({}),
        execute: async (_args, api, ctx) => {
          let output = "";
          if (api.env) {
            await api.env.exec(
              "printf '%s|%s' \"$PROBE\" \"${BUGBOSS_SECRETS:-none}\"",
              { onOutput: (text) => (output += text) },
              ctx,
            );
          }
          seen.push({
            id: api.conversationId,
            hasEnv: api.env !== undefined,
            ...(api.env ? { home: output } : {}),
          });
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    ],
  };
  const { ai, faux, models } = await fauxSetup();
  process.env.BUGBOSS_SECRETS = "leaked";
  const bugboss = await openBugbossHarness({
    storage: new pi.durable.MemoryStorage(),
    models,
    extensions: [probe],
    shellEnv: (id) => ({ PATH: process.env.PATH ?? "", PROBE: `conversation-${id}` }),
    onReport: () => {},
  });
  try {
    const model = faux.getModel();
    const run = async (cwd: string | undefined) => {
      const conversation = await bugboss.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: model.provider, modelId: model.id },
            extensions: [probe],
            ...(cwd ? { cwd } : {}),
          },
        },
        bugboss.context,
      );
      faux.setResponses([
        ai.fauxAssistantMessage(ai.fauxToolCall("probe", {}), { stopReason: "toolUse" }),
        ai.fauxAssistantMessage("done"),
      ]);
      await (await conversation.submit({ type: "input", content: "probe" }, bugboss.context)).wait(
        bugboss.context,
      );
      return conversation.id;
    };
    const withShell = await run(process.cwd());
    const without = await run(undefined);
    assert.deepEqual(seen, [
      { id: withShell, hasEnv: true, home: `conversation-${withShell}|none` },
      { id: without, hasEnv: false },
    ]);
  } finally {
    delete process.env.BUGBOSS_SECRETS;
    await bugboss.close();
  }
});

test("createBugbossModels serves every resolved model over InvokeModel", async () => {
  const bugboss = await createBugbossModels({
    agentModelId: "us.anthropic.claude-opus-5",
    bossModelId: "us.anthropic.claude-sonnet-5",
    goalModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    invoke: async () => {
      throw new Error("no request in this test");
    },
  });
  assert.equal(bugboss.intent, null);
  for (const model of [bugboss.agent, bugboss.boss, bugboss.goal]) {
    assert.ok(model);
    assert.equal(model.api, BEDROCK_INVOKE_MODEL_API);
    assert.equal(bugboss.models.getModel(BEDROCK_PROVIDER_ID, model.id)?.api, BEDROCK_INVOKE_MODEL_API);
  }
});

test("createBugbossModels throws on an id the catalog does not know", async () => {
  await assert.rejects(
    createBugbossModels({ agentModelId: "us.anthropic.claude-nonexistent", bossModelId: "us.anthropic.claude-sonnet-5" }),
    /No Bedrock catalog entry/,
  );
});

test("an unknown goal model leaves the gates unjudged instead of failing boot", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => lines.push(String(line));
  try {
    const bugboss = await createBugbossModels({
      agentModelId: "us.anthropic.claude-opus-5",
      bossModelId: "us.anthropic.claude-sonnet-5",
      goalModelId: "us.anthropic.claude-nonexistent",
    });
    assert.equal(bugboss.goal, null);
    assert.ok(bugboss.agent);
  } finally {
    console.error = original;
  }
  assert.ok(lines.some((line) => line.includes("goal_model_unavailable")));
});

test("a failed attempt is stored but does not count as a turn", async () => {
  const pi = await loadPi();
  const { ai, faux, bugboss } = await open(new pi.durable.MemoryStorage());
  try {
    faux.setResponses([
      ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "ThrottlingException" }),
      ai.fauxAssistantMessage("recovered"),
    ]);
    const model = faux.getModel();
    const id = await createConversation(bugboss, { provider: model.provider, modelId: model.id });
    const conversation = await bugboss.conversation(id);
    const failed = await (await conversation.submit({ type: "input", content: "go" }, bugboss.context)).wait(
      bugboss.context,
    );
    assert.equal(failed.status, "unanswered");
    const stored = (await conversation.entries({}, 50, undefined, bugboss.context)).items.filter(
      (entry) => entry.kind === "pi.assistant",
    );
    assert.equal(stored.length, 1, "the failed attempt is in the transcript");
    assert.equal(await bugboss.countTurns(id), 0);

    await (await conversation.submit({ type: "input", content: "again" }, bugboss.context)).wait(bugboss.context);
    assert.equal(await bugboss.countTurns(id), 1);
  } finally {
    await bugboss.close();
  }
});
