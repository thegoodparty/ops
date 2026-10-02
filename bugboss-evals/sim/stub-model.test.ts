import assert from "node:assert/strict";
import { test } from "node:test";

import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

import { postmortemProblem } from "../../bugboss/report/postmortem";
import type { PostmortemSections } from "../../bugboss/types";
import { createStubBrain, startStubModel } from "./stub-model";

const agentBody = (assistantTurns: number) => ({
  tools: [{ name: "report_root_cause" }, { name: "report_analysis" }],
  messages: [
    { role: "user", content: "https://github.com/thegoodparty/bugboss-eval-sandbox/pull/1" },
    ...Array.from({ length: assistantTurns }, () => ({ role: "assistant", content: "x" })),
  ],
});

test("the stub's report_analysis is a post-mortem the toolapi accepts, so the incident closes", () => {
  const brain = createStubBrain("/tmp/fix.patch");
  const answer = brain(agentBody(6));
  assert.ok("tool" in answer && answer.tool === "report_analysis");
  assert.equal(postmortemProblem(answer.input as unknown as PostmortemSections, []), null);
});

test("the stub answers the stage-goal evaluator with a met verdict, not a tool-less 'stub'", () => {
  const brain = createStubBrain("/tmp/fix.patch");
  const answer = brain({
    system: "You are the goal evaluator for BugBoss, which runs one AI agent per production incident.",
    tools: [],
    messages: [{ role: "user", content: "..." }],
  });
  assert.ok("text" in answer);
  assert.deepEqual(JSON.parse(answer.text), { verdict: "met", reason: "Stub evaluator." });
  const compaction = brain({ system: "Summarize the conversation.", tools: [], messages: [] });
  assert.deepEqual(compaction, { text: "stub" });
});

test("the stub speaks Bedrock's streaming and whole-response shapes to the real SDK", async () => {
  const { url, server } = await startStubModel("/tmp/fix.patch");
  const client = new BedrockRuntimeClient({
    region: "us-west-2",
    endpoint: url,
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
  });
  try {
    const decide = { tools: [{ name: "decide", input_schema: { type: "object" } }], messages: [{ role: "user", content: "x" }] };
    const stream = await client.send(
      new InvokeModelWithResponseStreamCommand({ modelId: "us.anthropic.claude-opus-5", body: JSON.stringify(decide) }),
    );
    const events: Array<{ type: string; delta?: { partial_json?: string } }> = [];
    for await (const item of stream.body!) {
      events.push(JSON.parse(Buffer.from(item.chunk!.bytes!).toString("utf8")));
    }
    assert.equal(events[0].type, "message_start");
    assert.equal(JSON.parse(events.find((e) => e.delta?.partial_json)!.delta!.partial_json!).action, "new_incident");

    const judged = await client.send(
      new InvokeModelCommand({
        modelId: "us.anthropic.claude-opus-5",
        body: JSON.stringify({ tools: [{ name: "record_verdict" }], messages: [] }),
      }),
    );
    const body = JSON.parse(Buffer.from(judged.body).toString("utf8"));
    assert.equal(body.content[0].input.winner, "tie");
  } finally {
    server.close();
  }
});
