import assert from "node:assert/strict";
import { test } from "node:test";

import { coldStarts, measure } from "../metrics";
import { ratesFor } from "../price";
import { parseProxyLog, type ProxyLogRecord } from "./proxy-log";

const START = Date.parse("2026-09-29T10:00:00Z");
const MODEL = "us.anthropic.claude-opus-5";

const AGENT = {
  system: [{ type: "text", text: "You are the incident agent for incident 7.", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "bash" }, { name: "monitor" }],
};
const TRIAGE = { system: [{ type: "text", text: "You triage alerts." }], tools: [{ name: "decide" }] };

let seq = 0;
const record = (
  minutes: number,
  prompt: object,
  messages: object[],
  reply: { tools?: Array<{ id: string; name: string; input: object }>; read?: number; write?: number } = {},
  outcome: ProxyLogRecord["outcome"] = "ok",
): ProxyLogRecord => {
  seq += 1;
  const ok = outcome === "ok";
  const read = ok ? (reply.read ?? 0) : 0;
  const write = ok ? (reply.write ?? 0) : 0;
  const cacheCost = (read * 0.55 + write * 11) / 1e6;
  return {
    v: 1,
    seq,
    requestId: `req-${seq}`,
    startedAt: START + minutes * 60_000,
    endedAt: START + minutes * 60_000 + 1000,
    operation: "invoke-with-response-stream",
    modelId: MODEL,
    model: MODEL,
    outcome,
    status: ok ? 200 : 429,
    error: ok ? null : { type: "ThrottlingException", message: "budget" },
    request: { anthropic_version: "bedrock-2023-05-31", max_tokens: 10, ...prompt, messages },
    response: {
      message: ok
        ? {
            id: `msg-${seq}`,
            model: "claude-opus-5",
            content: (reply.tools ?? []).map((tool) => ({ type: "tool_use", ...tool })),
            stopReason: reply.tools?.length ? "tool_use" : "end_turn",
          }
        : null,
      invocationMetrics: null,
      errorBody: null,
    },
    usage: {
      input: ok ? 2 : 0,
      output: ok ? 100 : 0,
      cacheRead: read,
      cacheWrite: write,
      cacheWrite1h: write,
      cacheWrite5m: 0,
      split: true,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: cacheCost, total: cacheCost },
    spendUsdAfter: 0,
    budgetUsd: 35,
  };
};

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistantCall = (id: string, name: string, input: object) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, text: string, isError = false) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }],
});

const build = () => {
  seq = 0;
  const m1 = [user("investigate")];
  const call1 = { id: "t1", name: "bash", input: { command: "curl loki" } };
  const m2 = [...m1, assistantCall("t1", "bash", call1.input), result("t1", "error: refused, use the prefetch")];
  const call2 = { id: "t2", name: "bash", input: { command: "curl loki" } };
  const m3 = [...m2, assistantCall("t2", "bash", call2.input), result("t2", "12 errors")];
  const m4 = [...m3, { role: "assistant", content: [{ type: "text", text: "found it" }] }, user("resume")];
  return [
    record(0, AGENT, m1, { tools: [call1], write: 190_000 }),
    record(0.5, TRIAGE, [user("alert A")], { read: 0, write: 5_000 }),
    record(1, AGENT, m2, { tools: [call2], read: 190_000 }),
    record(2, AGENT, m3, { read: 191_000 }),
    record(80, AGENT, m4, {}, "budget_throttled"),
    record(81, AGENT, m4, { write: 195_000 }),
  ];
};

const jsonl = (records: ProxyLogRecord[]) => records.map((r) => JSON.stringify(r)).join("\n");

test("one trace per conversation, keyed on system prompt and tools", () => {
  const traces = parseProxyLog(jsonl(build()));
  assert.equal(traces.length, 2);
  const [agent, triage] = traces;
  assert.equal(agent.turns.length, 5);
  assert.equal(triage.turns.length, 1);
  assert.deepEqual(agent.toolNames, ["bash", "monitor"]);
  assert.match(agent.systemPrompt, /incident 7/);
  assert.equal(agent.model, MODEL);
  assert.equal(agent.startedAt, START);
});

test("tool results from the next request attach to the call that asked, refusals included", () => {
  const [agent] = parseProxyLog(jsonl(build()));
  assert.deepEqual(agent.turns[0].toolCalls, [{ id: "t1", name: "bash", args: { command: "curl loki" } }]);
  assert.equal(agent.turns[0].results.length, 1);
  assert.equal(agent.turns[0].results[0].toolName, "bash");
  assert.equal(agent.turns[0].results[0].refused, true);
  assert.equal(agent.turns[1].results[0].text, "12 errors");
  assert.equal(agent.turns[1].results[0].refused, false);
});

test("a new trailing user message is a launch and its retry is not", () => {
  const [agent] = parseProxyLog(jsonl(build()));
  assert.deepEqual(agent.turns.map((turn) => turn.launch), [0, 0, 0, 1, 1]);
  assert.equal(agent.launches, 2);
});

test("a throttled request is an error turn that billed nothing", () => {
  const [agent] = parseProxyLog(jsonl(build()));
  const throttled = agent.turns[3];
  assert.equal(throttled.stopReason, "error");
  assert.match(String(throttled.error), /ThrottlingException/);
  assert.equal(throttled.usage.cost.total, 0);
});

test("the cache ttl comes from the split, or from the request when nothing was written", () => {
  const [agent, triage] = parseProxyLog(jsonl(build()));
  assert.equal(agent.turns[0].cacheTtl, "1h");
  assert.equal(agent.turns[1].cacheTtl, "1h");
  assert.equal(triage.turns[0].cacheTtl, "1h");
  const noCache = record(0, TRIAGE, [user("x")]);
  assert.equal(parseProxyLog(JSON.stringify(noCache))[0].turns[0].cacheTtl, "5m");
});

test("the scorecard measures a proxy trace like any other", () => {
  const [agent] = parseProxyLog(jsonl(build()));
  const rates = ratesFor(MODEL);
  const scorecard = measure(agent, rates);
  assert.equal(scorecard.turns, 5);
  assert.equal(scorecard.billedTurns, 4);
  const colds = coldStarts(agent, rates);
  assert.equal(colds.at(-1)?.turn, 5);
  assert.equal(colds.at(-1)?.cause, "relaunch");
});
