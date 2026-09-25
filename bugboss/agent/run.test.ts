import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ToolApi, ToolResponse } from "../types";
import {
  agentOptionsFromEnv,
  BUILTIN_TOOLS,
  computePaths,
  createBossClient,
  createBossTools,
  DEFAULT_TIMEOUT_SECONDS,
  MODEL_BINDING_MISMATCH,
  exitCodeFor,
  npmCiCommand,
  pinnedSessionModel,
  PREFIX_DRIFT_DIAGNOSTIC,
  prefixDriftExtension,
  renderDirectives,
  reserveTokensFor,
  toolListDrift,
} from "./run";
import { PROMPT_ENTRY_TYPE } from "./session";

test("paths are derived from the incident, not the process", () => {
  const paths = computePaths("/work", "inc-7");

  assert.equal(paths.checkout, "/work/inc-7/omni");
  assert.equal(paths.sessionFile, "/work/inc-7/session/inc-7.jsonl");
  assert.equal(paths.npmCiDone, "/work/inc-7/npm-ci.done");
  assert.deepEqual(computePaths("/work", "inc-7"), paths);
});

test("compaction is configured at 95% of the window", () => {
  assert.equal(reserveTokensFor(200000), 10000);
  assert.equal(reserveTokensFor(1000000), 50000);
});

test("npm ci records both outcomes so monitor can see either", () => {
  const command = npmCiCommand(computePaths("/work", "inc-7"));

  assert.match(command, /^npm ci/);
  assert.match(command, /touch \/work\/inc-7\/npm-ci\.done/);
  assert.match(command, /\/work\/inc-7\/npm-ci\.failed/);
});

test("directives are rendered for the model", () => {
  assert.equal(renderDirectives([]), "");
  const rendered = renderDirectives([
    { type: "merged", into: "inc-9" },
    { type: "resumed_after", seconds: 420 },
  ]);

  assert.match(rendered, /MERGED: this incident is now part of inc-9/);
  assert.match(rendered, /RESUMED after 420s/);
});

test("the boss client talks to the incident's endpoints", async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, directives: [] }),
    };
  }) as unknown as typeof fetch;

  const api = createBossClient({
    baseUrl: "http://boss:8080/",
    incidentId: "inc-7",
    fetchImpl,
    authToken: "t",
  });

  await api.getIncident();
  await api.reportRootCause({ cause: "bad query", explainedSignalIds: ["s1"] });
  await api.recordPending("can someone merge this");
  await api.peekDirectives();

  assert.deepEqual(
    seen.map((call) => `${call.method} ${call.url}`),
    [
      "GET http://boss:8080/incidents/inc-7",
      "POST http://boss:8080/incidents/inc-7/root-cause",
      "POST http://boss:8080/incidents/inc-7/pending-question",
      "GET http://boss:8080/incidents/inc-7/directives",
    ],
  );
  assert.deepEqual(seen[1].body, { cause: "bad query", explainedSignalIds: ["s1"] });
});

test("a boss error is an error, not an empty result", async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 500,
    text: async () => "boom",
  })) as unknown as typeof fetch;

  const api = createBossClient({ baseUrl: "http://boss", incidentId: "inc-7", fetchImpl });
  await assert.rejects(() => api.getIncident(), /500 boom/);
});

const stubApi = (response: ToolResponse<unknown>): ToolApi =>
  ({
    reportRootCause: async () => response,
    reportImpact: async () => response,
    reportResolved: async () => response,
    reportAnalysis: async () => response,
    handOff: async () => response,
    getIncident: async () => response,
  }) as unknown as ToolApi;

test("the boss tools are the five transitions plus get_incident", async () => {
  const tools = await createBossTools({ api: stubApi({ ok: true, directives: [] }) });

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "get_incident",
      "hand_off",
      "report_analysis",
      "report_impact",
      "report_resolved",
      "report_root_cause",
    ],
  );
  assert.ok(!tools.some((tool) => BUILTIN_TOOLS.includes(tool.name)));
});

test("reporting a root cause starts the install, and directives reach the model", async () => {
  let started = 0;
  const tools = await createBossTools({
    api: stubApi({ ok: true, directives: [{ type: "merged", into: "inc-9" }] }),
    onRootCause: () => {
      started += 1;
    },
  });

  const rootCause = tools.find((tool) => tool.name === "report_root_cause");
  assert.ok(rootCause);
  const result = await rootCause.execute(
    "call-1",
    { cause: "x", explainedSignalIds: [] } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(started, 1);
  assert.match(String(result.content[0].type === "text" && result.content[0].text), /MERGED/);
  assert.equal(result.terminate, true);
});

test("a failed boss call is reported rather than swallowed", async () => {
  const tools = await createBossTools({
    api: stubApi({ ok: false, error: "incident is human-owned", directives: [] }),
  });
  const impact = tools.find((tool) => tool.name === "report_impact");
  assert.ok(impact);

  const result = await impact.execute(
    "call-2",
    { usersImpacted: 10, query: "count" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.match(
    String(result.content[0].type === "text" && result.content[0].text),
    /error: incident is human-owned/,
  );
});

test("prefix drift is logged rather than passing silently", () => {
  const logged: string[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
      return () => {};
    },
  } as never;

  prefixDriftExtension((message) => logged.push(message))(pi);
  handlers.message_end(
    {
      type: "message_end",
      message: {
        role: "assistant",
        diagnostics: [
          { type: PREFIX_DRIFT_DIAGNOSTIC, details: { transformations: [{ type: "drop_block" }] } },
        ],
      },
    },
    {},
  );
  handlers.message_end({ type: "message_end", message: { role: "user" } }, {});

  assert.equal(logged.length, 1);
  assert.match(logged[0], /drop_block/);
});

test("the dispatcher's environment is the whole launch contract", () => {
  const now = 1_000_000;
  const options = agentOptionsFromEnv(
    {
      BUGBOSS_INCIDENT_ID: "inc-7",
      BUGBOSS_TOKEN: "scoped-token",
      BUGBOSS_S3_BUCKET: "bugboss-prod",
      BUGBOSS_DEADLINE_AT: String(now + 1800_000),
      BUGBOSS_SESSION_REF: "sessions/inc-7.jsonl",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "graf",
      AWS_REGION: "us-west-2",
    },
    now,
  );

  assert.equal(options.incidentId, "inc-7");
  assert.equal(options.bossAuthToken, "scoped-token");
  assert.equal(options.timeoutSeconds, 1800);
  assert.equal(options.sessionKey, "sessions/inc-7.jsonl");
  assert.deepEqual(options.grafana, {
    url: "https://goodparty.grafana.net",
    token: "graf",
  });
});

test("an expired deadline still leaves room to hand off", () => {
  const options = agentOptionsFromEnv(
    {
      BUGBOSS_INCIDENT_ID: "inc-7",
      BUGBOSS_S3_BUCKET: "b",
      BUGBOSS_SESSION_REF: "sessions/incident/inc-7/session.jsonl",
      BUGBOSS_DEADLINE_AT: "1",
    },
    1_000_000,
  );

  assert.equal(options.timeoutSeconds, 60);
  assert.equal(options.grafana, undefined);
});

test("a launch without an incident is a failure, not a default", () => {
  assert.throws(() => agentOptionsFromEnv({ BUGBOSS_S3_BUCKET: "b" }), /BUGBOSS_INCIDENT_ID/);
  assert.throws(() => agentOptionsFromEnv({ BUGBOSS_INCIDENT_ID: "i" }), /BUGBOSS_S3_BUCKET/);
  // A derived key would write where no reader looks, so this is a failure too.
  assert.throws(
    () => agentOptionsFromEnv({ BUGBOSS_INCIDENT_ID: "i", BUGBOSS_S3_BUCKET: "b" }),
    /BUGBOSS_SESSION_REF/,
  );
  assert.throws(
    () =>
      agentOptionsFromEnv({
        BUGBOSS_INCIDENT_ID: "i",
        BUGBOSS_S3_BUCKET: "b",
        BUGBOSS_SESSION_REF: "",
      }),
    /BUGBOSS_SESSION_REF/,
  );
});

test("a changed tool loadout is reported rather than silently signed over", () => {
  assert.equal(toolListDrift(["bash", "monitor"], ["monitor", "bash"]), null);
  assert.match(
    String(toolListDrift(["bash", "monitor"], ["bash", "grafana_query_loki_logs"])),
    /added \["grafana_query_loki_logs"\], removed \["monitor"\]/,
  );
});

test("an empty deadline is no deadline, not a one-minute agent", () => {
  const env = {
    BUGBOSS_INCIDENT_ID: "inc-7",
    BUGBOSS_S3_BUCKET: "b",
    BUGBOSS_SESSION_REF: "sessions/incident/inc-7/session.jsonl",
  };

  assert.equal(
    agentOptionsFromEnv({ ...env, BUGBOSS_DEADLINE_AT: "" }, 1_000_000).timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  assert.equal(
    agentOptionsFromEnv(env, 1_000_000).timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
});

const sessionFileWith = async (modelId: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "bugboss-pin-"));
  const file = join(dir, "inc-7.jsonl");
  await writeFile(
    file,
    `${[
      JSON.stringify({ type: "session", version: 3, id: "inc-7", cwd: "/work/inc-7/omni" }),
      JSON.stringify({
        type: "custom",
        id: "aa",
        parentId: null,
        timestamp: "2026-09-24T00:00:00.000Z",
        customType: PROMPT_ENTRY_TYPE,
        data: { systemPrompt: "prompt", toolNames: ["bash"], modelId },
      }),
    ].join("\n")}\n`,
  );
  return file;
};

test("a resumed session runs on the model it was signed against", async () => {
  const sessionFile = await sessionFileWith("us.anthropic.claude-opus-5");

  const pinned = await pinnedSessionModel({
    restored: true,
    sessionFile,
    configuredModelId: "us.anthropic.claude-sonnet-5",
  });

  assert.equal(pinned.modelId, "us.anthropic.claude-opus-5");
  assert.equal(pinned.storedPrefix?.modelId, "us.anthropic.claude-opus-5");
  assert.match(String(pinned.mismatch), new RegExp(MODEL_BINDING_MISMATCH));
  assert.match(String(pinned.mismatch), /claude-sonnet-5/);
});

test("an agreeing model id is not an alarm, and a fresh run uses the configured one", async () => {
  const sessionFile = await sessionFileWith("us.anthropic.claude-opus-5");

  const agreed = await pinnedSessionModel({
    restored: true,
    sessionFile,
    configuredModelId: "us.anthropic.claude-opus-5",
  });
  assert.equal(agreed.mismatch, null);
  assert.equal(agreed.modelId, "us.anthropic.claude-opus-5");

  const fresh = await pinnedSessionModel({
    restored: false,
    sessionFile,
    configuredModelId: "us.anthropic.claude-sonnet-5",
  });
  assert.equal(fresh.storedPrefix, null);
  assert.equal(fresh.modelId, "us.anthropic.claude-sonnet-5");
  assert.equal(fresh.mismatch, null);
});

test("a force-aborted run does not exit like a finished one", () => {
  assert.equal(exitCodeFor({ sessionFile: "f", restored: true, timedOut: false, error: null }), 0);
  // The deadline nudge worked and the agent handed off inside the grace window.
  assert.equal(exitCodeFor({ sessionFile: "f", restored: true, timedOut: true, error: null }), 0);
  assert.equal(
    exitCodeFor({
      sessionFile: "f",
      restored: true,
      timedOut: true,
      error: "aborted by user",
    }),
    1,
  );
});
