import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampTimeRange,
  connectMcpToolset,
  DEFAULT_LOOKBACK_HOURS,
  GRAFANA_MCP_ARGS,
  GRAFANA_READ_TOOLS,
  MAX_LOOKBACK_HOURS,
  timeRangeShapeFor,
  type McpToolset,
} from "./mcp";

const HOUR = 3_600_000;

// A stdio MCP server in one expression, so the tests drive the real client:
// real spawn, real JSON-RPC framing, real tools/list. tools/call echoes the
// arguments it was handed, which is how a clamp is observed from the outside.
const FAKE_SERVER = `
let buffer = "";
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) return;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18" });
    if (message.method === "tools/list") reply(message.id, { tools: JSON.parse(process.env.FAKE_TOOLS) });
    if (message.method === "tools/call")
      reply(message.id, {
        content: [{ type: "text", text: JSON.stringify(message.params.arguments) }],
      });
  }
});
`;

interface FakeTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string }> };
}

const schema = (...names: string[]): FakeTool["inputSchema"] => ({
  type: "object",
  properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
});

/** The real mcp-grafana v1.6.1 shapes, copied from its own tools/list. */
const LOKI_TOOL: FakeTool = {
  name: "query_loki_logs",
  inputSchema: schema("datasourceUid", "logql", "startRfc3339", "endRfc3339"),
};
const PROM_TOOL: FakeTool = {
  name: "query_prometheus",
  inputSchema: schema("datasourceUid", "expr", "startTime", "endTime"),
};
const TEMPO_TOOL: FakeTool = {
  name: "search_tempo_traces",
  inputSchema: schema("datasourceUid", "query", "start", "end"),
};

interface ExecutableTool {
  name: string;
  description: string;
  execute: (
    id: string,
    params: Record<string, string>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

const connectFake = async (
  tools: FakeTool[],
  allowedTools: readonly string[],
): Promise<McpToolset> =>
  connectMcpToolset({
    name: "grafana",
    command: process.execPath,
    args: ["-e", FAKE_SERVER],
    env: { FAKE_TOOLS: JSON.stringify(tools) },
    allowedTools,
  });

const executable = (toolset: McpToolset): ExecutableTool[] =>
  toolset.tools as unknown as ExecutableTool[];

const captureLogs = async <T>(fn: () => Promise<T>): Promise<{ result: T; out: string[]; err: string[] }> => {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (line: string) => out.push(line);
  console.error = (line: string) => err.push(line);
  try {
    return { result: await fn(), out, err };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
};

const callArgs = async (
  tool: ExecutableTool,
  params: Record<string, string>,
): Promise<{ echoed: Record<string, string>; text: string }> => {
  const result = await tool.execute("call-1", params);
  const text = result.content[0].text;
  const body = text.slice(text.indexOf("{"));
  return { echoed: JSON.parse(body) as Record<string, string>, text };
};

test("a tool the server offers but the allowlist does not name is dropped, and said so", async () => {
  const writeTool: FakeTool = { name: "update_dashboard", inputSchema: schema("uid") };
  const { result: toolset, out } = await captureLogs(() =>
    connectFake([LOKI_TOOL, writeTool], ["query_loki_logs"]),
  );
  try {
    assert.deepEqual(
      toolset.tools.map((tool) => tool.name),
      ["grafana_query_loki_logs"],
    );
    const filtered = out.filter((line) => line.includes("mcp_tools_filtered"));
    assert.equal(filtered.length, 1);
    assert.match(filtered[0], /update_dashboard/);
  } finally {
    toolset.close();
  }
});

test("an allowlisted tool the server never returned is an alarm, not a shrug", async () => {
  const { result: toolset, err } = await captureLogs(() =>
    connectFake([LOKI_TOOL], ["query_loki_logs", "query_loki_stats"]),
  );
  try {
    const missing = err.filter((line) => line.includes("mcp_tools_missing"));
    assert.equal(missing.length, 1);
    assert.match(missing[0], /query_loki_stats/);
    assert.match(missing[0], /"level":"error"/);
  } finally {
    toolset.close();
  }
});

test("a call with no time range gets the six-hour default rather than the server's", async () => {
  const toolset = await connectFake([LOKI_TOOL], ["query_loki_logs"]);
  try {
    const before = Date.now();
    const { echoed, text } = await callArgs(executable(toolset)[0], {
      datasourceUid: "grafanacloud-logs",
      logql: '{service_name="gp-api"}',
    });
    const start = Date.parse(echoed.startRfc3339);
    const end = Date.parse(echoed.endRfc3339);
    assert.equal(end - start, 6 * HOUR);
    assert.ok(end >= before && end <= Date.now());
    assert.match(text, /\[bugboss\]/);
    assert.match(text, /6h/);
  } finally {
    toolset.close();
  }
});

test("a thirty-day range is clamped to twenty-four hours and the model is told", async () => {
  const toolset = await connectFake([LOKI_TOOL], ["query_loki_logs"]);
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.parse(end) - 30 * 24 * HOUR).toISOString();
    const { echoed, text } = await callArgs(executable(toolset)[0], {
      datasourceUid: "grafanacloud-logs",
      logql: 'count_over_time({service_name="gp-api"}[5m])',
      startRfc3339: start,
      endRfc3339: end,
    });
    assert.equal(echoed.endRfc3339, end);
    assert.equal(Date.parse(echoed.endRfc3339) - Date.parse(echoed.startRfc3339), 24 * HOUR);
    assert.match(text, /\[bugboss\]/);
    assert.match(text, /24h/);
    // The agent must not read a clamped answer as a 30-day answer.
    assert.match(text, /bytes it scans/);
  } finally {
    toolset.close();
  }
});

test("a two-hour range passes through untouched, notice and all", async () => {
  const toolset = await connectFake([LOKI_TOOL], ["query_loki_logs"]);
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.parse(end) - 2 * HOUR).toISOString();
    const params = {
      datasourceUid: "grafanacloud-logs",
      logql: '{service_name="gp-api"}',
      startRfc3339: start,
      endRfc3339: end,
    };
    const { echoed, text } = await callArgs(executable(toolset)[0], params);
    assert.deepEqual(echoed, params);
    assert.doesNotMatch(text, /\[bugboss\]/);
    assert.match(executable(toolset)[0].description, /24h/);
  } finally {
    toolset.close();
  }
});

test("the relative form Grafana accepts is clamped like an absolute one", async () => {
  const toolset = await connectFake([LOKI_TOOL], ["query_loki_logs"]);
  try {
    const { echoed } = await callArgs(executable(toolset)[0], {
      datasourceUid: "grafanacloud-logs",
      logql: '{service_name="gp-api"}',
      startRfc3339: "now-30d",
      endRfc3339: "now",
    });
    assert.equal(Date.parse(echoed.endRfc3339) - Date.parse(echoed.startRfc3339), 24 * HOUR);
  } finally {
    toolset.close();
  }
});

test("the prometheus and tempo argument shapes are bounded too", async () => {
  const toolset = await connectFake(
    [PROM_TOOL, TEMPO_TOOL],
    ["query_prometheus", "search_tempo_traces"],
  );
  try {
    const [prom, tempo] = executable(toolset);
    assert.equal(prom.name, "grafana_query_prometheus");
    assert.equal(tempo.name, "grafana_search_tempo_traces");

    const promCall = await callArgs(prom, {
      datasourceUid: "grafanacloud-prom",
      expr: "up",
      startTime: "now-7d",
      endTime: "now",
    });
    assert.equal(
      Date.parse(promCall.echoed.endTime) - Date.parse(promCall.echoed.startTime),
      24 * HOUR,
    );

    const tempoCall = await callArgs(tempo, {
      datasourceUid: "grafanacloud-traces",
      query: "{}",
    });
    assert.equal(
      Date.parse(tempoCall.echoed.end) - Date.parse(tempoCall.echoed.start),
      6 * HOUR,
    );
  } finally {
    toolset.close();
  }
});

test("an argument shape we did not establish is left alone, deliberately", async () => {
  // get_annotations takes from/to in epoch milliseconds. It is not on the
  // allowlist and its shape is not in the table, so nothing is clamped --
  // asserted here so the gap is a decision on record rather than a surprise.
  const annotations: FakeTool = { name: "get_annotations", inputSchema: schema("from", "to") };
  const toolset = await connectFake([annotations], ["get_annotations"]);
  try {
    const params = { from: "1750000000000", to: "1752600000000" };
    const { echoed, text } = await callArgs(executable(toolset)[0], params);
    assert.deepEqual(echoed, params);
    assert.doesNotMatch(text, /\[bugboss\]/);
    assert.equal(timeRangeShapeFor(annotations.inputSchema), null);
  } finally {
    toolset.close();
  }
});

test("a time argument we cannot parse falls back to the default window and says so", async () => {
  const toolset = await connectFake([LOKI_TOOL], ["query_loki_logs"]);
  try {
    const { echoed, text } = await callArgs(executable(toolset)[0], {
      datasourceUid: "grafanacloud-logs",
      logql: '{service_name="gp-api"}',
      startRfc3339: "last tuesday",
    });
    assert.equal(
      Date.parse(echoed.endRfc3339) - Date.parse(echoed.startRfc3339),
      6 * HOUR,
    );
    assert.match(text, /\[bugboss\]/);
    assert.match(text, /last tuesday/);
  } finally {
    toolset.close();
  }
});

test("clamping is arithmetic, and reports what it did", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  const shape = { start: "startRfc3339", end: "endRfc3339" };

  const wide = clampTimeRange(
    { startRfc3339: "now-30d", endRfc3339: "now" },
    shape,
    now,
  );
  assert.equal(wide.arguments.startRfc3339, "2026-09-27T12:00:00.000Z");
  assert.equal(wide.arguments.endRfc3339, "2026-09-28T12:00:00.000Z");
  assert.match(String(wide.notice), /30d/);

  const narrow = clampTimeRange(
    { startRfc3339: "2026-09-28T11:00:00.000Z", endRfc3339: "now" },
    shape,
    now,
  );
  assert.equal(narrow.notice, null);
  assert.equal(narrow.arguments.startRfc3339, "2026-09-28T11:00:00.000Z");

  // Composite relative durations are what Grafana's own examples use.
  const composite = clampTimeRange({ startRfc3339: "now-2h45m" }, shape, now);
  assert.equal(composite.notice, null);
  assert.equal(composite.arguments.startRfc3339, "now-2h45m");
});

test("the allowlist is reads only, and the server is told the same thing", () => {
  const writes = GRAFANA_READ_TOOLS.filter((name) =>
    /^(create|update|delete|install|add)_|_manage_|^grafana_api_request$/.test(name),
  );
  assert.deepEqual(writes, []);
  assert.ok(GRAFANA_READ_TOOLS.includes("query_loki_logs"));
  assert.equal(DEFAULT_LOOKBACK_HOURS, 6);
  assert.equal(MAX_LOOKBACK_HOURS, 24);
  assert.ok(GRAFANA_READ_TOOLS.length < 40);

  // --enabled-tools is category-granular, so the flag alone cannot express
  // this allowlist; --disable-write is what removes the write tools inside
  // the categories we do enable.
  assert.ok(GRAFANA_MCP_ARGS.includes("--disable-write"));
  assert.ok(GRAFANA_MCP_ARGS.some((arg) => arg.startsWith("--enabled-tools=")));
  assert.ok(GRAFANA_MCP_ARGS.some((arg) => arg.startsWith("--loki-guardrail-mode=")));
});

// A log dump is the whole reason this agent has an MCP, and the middle of one
// is where the line that explains the incident sits. It used to arrive with
// that middle cut out; Pi compacts the conversation instead now, so what a
// query returns reaches the model as the server sent it.
test("a huge MCP result arrives whole, with the clamp notice still leading", async () => {
  const echoed = 2_000_000;
  const set = await connectMcpToolset({
    name: "grafana",
    command: process.execPath,
    args: ["-e", FAKE_SERVER],
    env: { FAKE_TOOLS: JSON.stringify([LOKI_TOOL]) },
    allowedTools: [LOKI_TOOL.name],
  });
  try {
    const [tool] = executable(set);
    const needle = "NEEDLE_IN_THE_MIDDLE";
    const out = await tool.execute("c1", {
      // Echoed back, so this is what makes the result long.
      logql: `${"x".repeat(echoed / 2)}${needle}${"x".repeat(echoed / 2)}`,
      startRfc3339: "now-30d",
      endRfc3339: "now",
    });
    const text = out.content[0].text;
    assert.match(text, /^\[bugboss\]/, "the notice still leads");
    assert.ok(
      text.includes(needle),
      "the middle of the result is what a truncating cap used to drop",
    );
    assert.ok(
      text.length > echoed,
      `expected the whole ${echoed}-char echo back, got ${text.length}`,
    );
  } finally {
    set.close();
  }
});

// A window's position bounds what it can find just as its width bounds what
// it costs. A future window matches nothing, and nothing reads exactly like
// a problem that has stopped -- so this is an evidence bug, not a cost one.
test("a window entirely in the future is pulled back to now and the agent is told", () => {
  const now = Date.UTC(2026, 8, 28, 12, 0, 0);
  const shape = { start: "startRfc3339", end: "endRfc3339" } as const;

  const clamped = clampTimeRange(
    { startRfc3339: "now+6d", endRfc3339: "now+7d" },
    shape,
    now,
  );

  assert.ok(clamped.notice, "a silently empty answer is the whole hazard");
  assert.match(clamped.notice ?? "", /future/);
  const end = Date.parse(String(clamped.arguments.endRfc3339));
  const start = Date.parse(String(clamped.arguments.startRfc3339));
  assert.ok(end <= now, `end ${new Date(end).toISOString()} is still ahead of now`);
  assert.ok(start < end, "and the window is not inverted or empty");
});

test("a future end with a real start keeps the start and pulls the end back", () => {
  const now = Date.UTC(2026, 8, 28, 12, 0, 0);
  const clamped = clampTimeRange(
    { startRfc3339: "now-2h", endRfc3339: "now+5h" },
    { start: "startRfc3339", end: "endRfc3339" },
    now,
  );
  assert.match(clamped.notice ?? "", /future/);
  assert.equal(Date.parse(String(clamped.arguments.endRfc3339)), now);
  assert.equal(
    Date.parse(String(clamped.arguments.startRfc3339)),
    now - 2 * HOUR,
    "the half the agent got right is left alone",
  );
});
