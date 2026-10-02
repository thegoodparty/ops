import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spendOf } from "../metrics";
import { parseProxyLog, tracesFromProxyLog, type ProxyLogRecord } from "./proxy-log";

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
    upstream: "bedrock",
    operation: "invoke-with-response-stream",
    modelId: MODEL,
    model: MODEL,
    priced: true,
    outcome,
    status: ok ? 200 : 402,
    error: ok ? null : { type: "PaymentRequiredException", message: "cap" },
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
    usage: { input: ok ? 2 : 0, output: ok ? 100 : 0, cacheRead: read, cacheWrite: write, cacheWrite1h: write, cacheWrite5m: 0, split: true },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: cacheCost, total: cacheCost },
    spendUsdAfter: 0,
    capUsd: 35,
  };
};

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

const build = () => {
  seq = 0;
  const call = { id: "t1", name: "bash", input: { command: "curl loki" } };
  const m1 = [user("investigate")];
  return [
    record(0, AGENT, m1, { tools: [call], write: 190_000 }),
    record(0.5, TRIAGE, [user("alert A")], { write: 5_000 }),
    record(1, AGENT, m1, { read: 190_000 }),
    record(80, AGENT, m1, {}, "cap_exceeded"),
  ];
};

// Out of order on purpose: the log is sorted by seq, not by line.
const jsonl = (records: ProxyLogRecord[]) => [...records].reverse().map((r) => JSON.stringify(r)).join("\n");

test("one trace for the whole system, every request a turn in seq order", () => {
  const trace = parseProxyLog(jsonl(build()));
  assert.equal(trace.id, "proxy");
  assert.equal(trace.turns.length, 4);
  assert.deepEqual(trace.turns.map((turn) => turn.index), [1, 2, 3, 4]);
  assert.deepEqual(trace.turns.map((turn) => turn.id), ["req-1", "req-2", "req-3", "req-4"]);
  assert.equal(trace.startedAt, START);
  assert.equal(trace.model, MODEL);
  assert.match(trace.systemPrompt, /incident 7/);
  assert.deepEqual(trace.toolNames, ["bash", "monitor"]);
  assert.equal(trace.launches, 1);
  assert.deepEqual(trace.exits, []);
  assert.ok(trace.turns.every((turn) => turn.launch === 0 && turn.results.length === 0));
});

test("tool calls come from the assembled response and cost from the record", () => {
  const trace = parseProxyLog(jsonl(build()));
  assert.deepEqual(trace.turns[0].toolCalls, [{ id: "t1", name: "bash", args: { command: "curl loki" } }]);
  assert.equal(trace.turns[0].stopReason, "tool_use");
  assert.ok(Math.abs(trace.turns[0].usage.cost.total - (190_000 * 11) / 1e6) < 1e-9);
  assert.equal(trace.turns[0].usage.cacheWrite1h, 190_000);
  assert.deepEqual(trace.turns[2].toolCalls, []);
});

test("a capped request is an error turn that billed nothing", () => {
  const trace = parseProxyLog(jsonl(build()));
  const capped = trace.turns[3];
  assert.equal(capped.stopReason, "error");
  assert.match(String(capped.error), /PaymentRequiredException/);
  assert.equal(capped.usage.cost.total, 0);
  assert.equal(capped.usage.input, 0);
});

test("the cache ttl comes from the split when something was written, else from the request", () => {
  const trace = parseProxyLog(jsonl(build()));
  assert.equal(trace.turns[0].cacheTtl, "1h");
  assert.equal(trace.turns[1].cacheTtl, "1h");
  assert.equal(trace.turns[2].cacheTtl, "1h");
  const plain = record(0, TRIAGE, [user("x")]);
  assert.equal(parseProxyLog(JSON.stringify(plain)).turns[0].cacheTtl, "5m");
});

test("spendOf measures a proxy trace like any other", () => {
  const trace = parseProxyLog(jsonl(build()));
  const spend = spendOf([trace]);
  assert.equal(spend.turns, 4);
  assert.equal(spend.cacheWrite, 195_000);
  assert.equal(spend.cacheRead, 190_000);
  assert.equal(spend.input, 6);
  assert.equal(spend.output, 300);
  assert.ok(Math.abs(spend.usd - (6 * 5.5 + 300 * 27.5 + 195_000 * 11 + 190_000 * 0.55) / 1e6) < 1e-9);
  assert.deepEqual(spend.unpriced, []);
});

test("reading the log from disk: a missing or empty file is no trace, a file is one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-log-"));
  assert.deepEqual(await tracesFromProxyLog(join(dir, "missing.jsonl")), []);
  const empty = join(dir, "empty.jsonl");
  writeFileSync(empty, "\n");
  assert.deepEqual(await tracesFromProxyLog(empty), []);
  const path = join(dir, "proxy.jsonl");
  writeFileSync(path, `${jsonl(build())}\n`);
  const traces = await tracesFromProxyLog(path);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].turns.length, 4);
});
