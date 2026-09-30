import { createServer, type Http2Server } from "node:http2";

import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

/**
 * A scripted Bedrock, for proving the harness end to end at zero model spend.
 * BugBoss reaches it through AWS_ENDPOINT_URL_BEDROCK_RUNTIME; the judge
 * through the same variable. It answers InvokeModel and
 * InvokeModelWithResponseStream in the Anthropic message shape, over
 * cleartext HTTP/2, which is what the Bedrock runtime client speaks.
 *
 * It tells callers apart by the tools they offer. The incident agent gets a
 * fixed script that does the real work through its real tools: report a
 * cause, apply the scenario's proving fix, open a PR in the sandbox, ask for
 * review, wait for the merge, resolve and close. Everything else gets the
 * smallest answer its schema accepts.
 *
 * Never used in a real comparison: it would measure nothing.
 */

type Block = { type: string; [key: string]: unknown };
type Body = {
  system?: unknown;
  tools?: Array<{ name: string; input_schema?: Schema }>;
  messages?: Array<{ role: string; content: string | Block[] }>;
};
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: string[] };

const fill = (schema: Schema | undefined): unknown => {
  if (!schema) return "stub";
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).map((key) => [key, fill(schema.properties?.[key])]),
      );
    case "array":
      return [];
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return "stub";
  }
};

type Answer = { text: string } | { tool: string; input: Record<string, unknown> };

const allText = (body: Body): string => JSON.stringify(body.messages ?? []);

const agentStep = (body: Body, patchPath: string): Answer => {
  const turn = (body.messages ?? []).filter((m) => m.role === "assistant").length;
  const seen = allText(body);
  const signalIds = [...new Set([...seen.matchAll(/\\"id\\":\s*\\"(sig-[\w-]+)\\"/g)].map((m) => m[1]))];
  const prUrl = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(seen)?.[0] ?? "";
  const script: Answer[] = [
    { tool: "get_incident", input: {} },
    {
      tool: "report_root_cause",
      input: { cause: "Stub: the scenario's known fault.", explainedSignalIds: signalIds },
    },
    {
      tool: "bash",
      input: {
        command: [
          "set -e",
          "git checkout -q -b bugboss/eval-stub-$(date +%s)-$$",
          `git apply ${patchPath}`,
          "git commit -qam 'Stub fix from the eval harness'",
          "git push -q -u origin HEAD",
          "gh pr create --base main --title 'Stub fix' --body 'Opened by the zero-spend stub model.'",
        ].join(" && "),
      },
    },
    { tool: "bash", input: { command: `gh pr comment ${prUrl} --body 'delegate review'` } },
    {
      tool: "monitor",
      input: {
        command: `gh pr view ${prUrl} --json state -q .state | grep -q MERGED`,
        intervalSeconds: 20,
        timeoutSeconds: 7200,
        description: "the PR to be merged",
        awaitingHuman: `Merge ${prUrl}`,
      },
    },
    { tool: "report_resolved", input: { prUrls: [prUrl], evidence: "Stub: the harness flipped telemetry to healthy." } },
    {
      tool: "report_analysis",
      input: {
        postmortem: "# Post-mortem\n\nStub run. The proving fix was applied and merged.",
        usersImpacted: 0,
        impactQuery: "stub",
      },
    },
  ];
  return script[turn] ?? { text: "Done." };
};

export const createStubBrain = (patchPath: string) => {
  let commanderRuns = 0;
  return (body: Body): Answer => {
    const tools = new Set((body.tools ?? []).map((t) => t.name));
    if (tools.has("record_verdict")) {
      return { tool: "record_verdict", input: { winner: "tie", margin: "tie", deciding_criterion: "none", rationale: "Stub judge." } };
    }
    if (tools.has("report_root_cause")) return agentStep(body, patchPath);
    if (tools.has("decide")) return { tool: "decide", input: { action: "new_incident", reason: "Stub triage." } };
    if (tools.has("stay_silent")) {
      commanderRuns += 1;
      return {
        text:
          commanderRuns === 1
            ? "Quick question for on-call: who uses this route, and how many people are affected?"
            : "Noted.",
      };
    }
    const first = body.tools?.[0];
    if (first) return { tool: first.name, input: fill(first.input_schema) as Record<string, unknown> };
    return { text: "stub" };
  };
};

const USAGE = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const events = (answer: Answer): Record<string, unknown>[] => {
  const start = { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, usage: USAGE } };
  const block =
    "text" in answer
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer.text } },
        ]
      : [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: answer.tool, input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(answer.input) } },
        ];
  return [
    start,
    ...block,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "text" in answer ? "end_turn" : "tool_use" }, usage: { output_tokens: 50 } },
    { type: "message_stop" },
  ];
};

const whole = (answer: Answer) => ({
  id: "msg_stub",
  type: "message",
  role: "assistant",
  model: "stub",
  content:
    "text" in answer
      ? [{ type: "text", text: answer.text }]
      : [{ type: "tool_use", id: `toolu_${Date.now()}`, name: answer.tool, input: answer.input }],
  stop_reason: "text" in answer ? "end_turn" : "tool_use",
  usage: USAGE,
});

export const startStubModel = async (patchPath: string): Promise<{ url: string; server: Http2Server; calls: string[] }> => {
  const brain = createStubBrain(patchPath);
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Body;
      const answer = brain(body);
      calls.push("text" in answer ? "text" : answer.tool);
      if (!(req.url ?? "").includes("invoke-with-response-stream")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(whole(answer)));
        return;
      }
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      for (const event of events(answer)) {
        res.write(
          codec.encode({
            headers: {
              ":event-type": { type: "string", value: "chunk" },
              ":content-type": { type: "string", value: "application/json" },
              ":message-type": { type: "string", value: "event" },
            },
            body: fromUtf8(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })),
          }),
        );
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  return { url: `http://127.0.0.1:${address.port}`, server, calls };
};
