import assert from "node:assert/strict";
import { test } from "node:test";

import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

import { startStubModel } from "./stub-model";

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
