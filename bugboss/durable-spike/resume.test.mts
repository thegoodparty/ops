// Question 2: does an incident run survive SIGKILL in the middle of a tool round?
//
// Today the answer is session.ts: the transcript is uploaded whole after every
// turn, a killed run is told apart from a finished one by the bugboss_exit
// record, and pending_wait / pending_question make a replayed tool resume
// instead of re-asking. Here a real child process is killed with SIGKILL
// while two tools run, and a fresh harness over the same SQLite file is
// expected to finish the run with no help from us.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { answerText, context, openSpikeHarness } from "./harness.mts";

const child = fileURLToPath(new URL("./resume-child.mts", import.meta.url));

const runUntilReady = (databasePath: string, executionLog: string) =>
  new Promise<{ conversationId: ConversationId; kill: () => Promise<void> }>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", child, databasePath, executionLog], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let conversationId: ConversationId | undefined;
    let buffered = "";
    proc.on("exit", (code, signal) => {
      if (signal !== "SIGKILL") reject(new Error(`child exited early: code ${code} signal ${signal}`));
    });
    proc.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const id = /CONVERSATION (\S+)/.exec(buffered)?.[1];
      if (id) conversationId = Number(id) as ConversationId;
      if (buffered.includes("READY") && conversationId) {
        resolve({
          conversationId,
          kill: () =>
            new Promise((done) => {
              proc.once("exit", () => done());
              proc.kill("SIGKILL");
            }),
        });
      }
    });
  });

test("a run killed mid tool round resumes: safe tools rerun, unsafe ones report interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bugboss-durable-"));
  const databasePath = join(directory, "boss.sqlite");
  const executionLog = join(directory, "executions.log");
  try {
    const { conversationId, kill } = await runUntilReady(databasePath, executionLog);
    await kill();

    let seen: TranscriptContext | undefined;
    const faux = fauxProvider();
    faux.setResponses([
      (transcript) => {
        seen = transcript;
        return fauxAssistantMessage([fauxText("Root cause found; opening a PR.")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const { harness } = await openSpikeHarness(await openNodeSqliteStorage(databasePath), models, {
      executionLog,
      monitorMs: 600_000,
    });
    harness.resume();

    // The dispatcher's retry of the same signal finds the submission the dead
    // process made, rather than starting a second investigation.
    const conversation = (await harness.conversation(conversationId, context))!;
    const retried = await conversation.submit(
      { type: "input", content: "incident 7: 500s on /v1/campaigns", requestId: "incident-7:signal-1" },
      context,
    );
    const settled = await retried.wait(context);
    assert.equal(settled.status, "done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("unreachable");
    assert.equal(await answerText(harness, conversationId, settled.answer), "Root cause found; opening a PR.");

    const executions = (await readFile(executionLog, "utf8")).trim().split("\n");
    assert.deepEqual(executions, ["slow_query first", "slow_query second", "slow_query second"]);

    const results = (seen?.messages ?? []).filter((message) => message.role === "toolResult") as {
      toolCallId: string;
      isError: boolean;
      content: { type: string; text?: string }[];
    }[];
    const byId = new Map(results.map((result) => [result.toolCallId, result]));
    assert.equal(byId.get("q2")?.isError, false, "the replay-safe query reran and succeeded");
    assert.equal(byId.get("m1")?.isError, true, "the unsafe wait came back as an error, not a silent gap");
    assert.match(JSON.stringify(byId.get("m1")?.content), /interrupt/i);
    assert.equal(faux.state.callCount, 1, "only the final turn ran after the restart");

    await harness.close(context);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
