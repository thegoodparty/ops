import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ToolApi, ToolResponse } from "../types";
import {
  agentOptionsFromEnv,
  BUILTIN_TOOLS,
  COMPACTION_KEEP_RECENT_TOKENS,
  computePaths,
  createBossClient,
  createBossTools,
  createTurnBudget,
  directiveDeliveryExtension,
  INCIDENT_AGENT_MAX_TURNS,
  DEFAULT_TIMEOUT_SECONDS,
  MODEL_BINDING_MISMATCH,
  exitCodeFor,
  exitRecordFor,
  flushDurable,
  onceOnly,
  npmCiCommand,
  pinnedSessionModel,
  PREFIX_DRIFT_DIAGNOSTIC,
  prefixDriftExtension,
  renderDirectives,
  reserveTokensFor,
  signalExitCode,
  shouldAnnounceExhaustion,
  toolListDrift,
  turnBudgetPark,
  TURN_BUDGET_GRACE_TURNS,
  turnBudgetBrief,
  turnBudgetMessage,
  type TurnBudgetState,
} from "./run";
import { resolveBedrockModel } from "../bedrock";
import { notesPrefixFor } from "./notes";
import { emptySessionUsage, PROMPT_ENTRY_TYPE } from "./session";

test("paths are derived from the incident, not the process", () => {
  const paths = computePaths("/work", "inc-7");

  assert.equal(paths.checkout, "/work/inc-7/omni");
  assert.equal(paths.sessionFile, "/work/inc-7/session/inc-7.jsonl");
  assert.equal(paths.npmCiDone, "/work/inc-7/npm-ci.done");
  assert.deepEqual(computePaths("/work", "inc-7"), paths);
});

test("the notes directory is a sibling of the checkout, never inside it", () => {
  const paths = computePaths("/work", "inc-7");

  assert.equal(paths.notesDir, "/work/inc-7/notes");
  // Inside the checkout a note is one `git add -A` away from being in the
  // pull request the agent asks a human to merge.
  assert.ok(!paths.notesDir.startsWith(`${paths.checkout}/`));
  assert.equal(
    notesPrefixFor("sessions/incident/inc-7/session.jsonl"),
    "sessions/incident/inc-7/notes/",
    "notes belong with that incident's material, not somewhere new",
  );
});

// The old assertions restated the formula -- `reserveTokensFor(1000000)` is
// `50000` said twice -- so they could not notice the formula being wrong, and
// it was: the reserve was smaller than one maximum response. These assert the
// two properties the number exists for instead, against the real catalog
// entry for the model this agent runs.
test("the compaction reserve leaves room for a maximum response", async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

  assert.ok(
    reserveTokensFor(model) >= model.maxTokens,
    `reserve ${reserveTokensFor(model)} is under maxTokens ${model.maxTokens}, so Pi ` +
      "would ask for output that cannot fit",
  );
  assert.ok(
    reserveTokensFor(model) > COMPACTION_KEEP_RECENT_TOKENS,
    "a reserve under the kept tail cannot be reached by compacting",
  );
  // And it is still headroom rather than the window: a reserve this side of
  // half would compact every session from its first turn.
  assert.ok(reserveTokensFor(model) < model.contextWindow / 2);
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

/**
 * The rendered text is what the agent actually reads; the payload it is
 * rendered from is not. Covering only the payload is how a sentence nobody
 * proofread reaches a model that is about to act on it.
 */
test("a merge tells the agent what it has inherited, in the singular", () => {
  const rendered = renderDirectives([
    { type: "new_signals", count: 2, summary: "one bug, two alerts", absorbed: ["82"] },
  ]);

  assert.match(rendered, /incident 82 has been merged into yours/);
  assert.match(rendered, /its signals are now yours/);
  assert.match(rendered, /one bug, two alerts/);
  assert.match(rendered, /what that incident had already found/);
  assert.match(rendered, /`absorbed`/);
});

test("and in the plural, which is a different sentence", () => {
  const rendered = renderDirectives([
    {
      type: "new_signals",
      count: 5,
      summary: "one saturated pool",
      absorbed: ["82", "83", "91"],
    },
  ]);

  // "incident 82, 83 and 91 has been merged" reads as one incident, which is
  // the opposite of what the agent needs to know.
  assert.match(rendered, /incidents 82, 83 and 91 have been merged into yours/);
  assert.match(rendered, /their signals are now yours/);
  assert.match(rendered, /what those incidents had already found/);
  assert.doesNotMatch(rendered, / has been merged/);
});

/**
 * Signals arriving because a new alert fired is a different event from
 * signals arriving because another incident was emptied into this one, and
 * the ordinary case must not start talking about merges.
 */
test("signals that arrived on their own say nothing about a merge", () => {
  const rendered = renderDirectives([
    { type: "new_signals", count: 1, summary: "same fingerprint" },
  ]);

  assert.equal(rendered.trim().split("\n").at(-1), "NEW SIGNALS (1): same fingerprint");
});

test("an empty absorbed list is the ordinary case, not a merge with no names", () => {
  const rendered = renderDirectives([
    { type: "new_signals", count: 1, summary: "same fingerprint", absorbed: [] },
  ]);

  assert.doesNotMatch(rendered, /merged/);
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
    escalate: async () => response,
    getIncident: async () => response,
    proposeMerge: async () => response,
    searchIncidents: async () => response,
  }) as unknown as ToolApi;

// Two reads, and both of them now reach incidents nobody pointed the agent
// at: search_incidents finds the post-mortems, get_incident reads an open
// one by id. That asymmetry used to run the other way -- fluent about the
// past, blind to the present -- and it is the reason an agent could discover
// that another incident existed and then do nothing with it.
//
// Four transitions, not five: `escalate` sits in this list but writes no
// state. It tells the Boss the incident needs a person and leaves the agent
// driving, which is why it is named for what it does rather than for what it
// moves.
//
// `propose_merge` is neither a transition nor a read. It writes nothing on
// the agent's word: it asks, the two incidents are compared, and the rules
// pick which record survives.
test("the boss tools are the four transitions, the title, the ask, escalate, park and the two reads", async () => {  const tools = await createBossTools({
    api: stubApi({ ok: true, directives: [] }),
    boss: { tellBoss: async () => {} },
  });

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "escalate",
      "get_incident",
      "park",
      "propose_merge",
      "report_analysis",
      "report_impact",
      "report_resolved",
      "report_root_cause",
      "search_incidents",
      "set_summary",
    ],
  );
  assert.ok(!tools.some((tool) => BUILTIN_TOOLS.includes(tool.name)));
});

test("get_incident takes an id, so an agent can read an incident that is not its own", async () => {
  // The read an agent could not make. Without it `propose_merge` is a guess:
  // an agent naming another incident would be doing it off a search hit it
  // was not allowed to open.
  const asked: unknown[] = [];
  const tools = await createBossTools({
    boss: { tellBoss: async () => {} },
    api: {
      ...stubApi({ ok: true, directives: [] }),
      getIncident: async (args: unknown) => {
        asked.push(args);
        return { ok: true as const, directives: [] };
      },
    } as unknown as ToolApi,
  });
  const read = tools.find((tool) => tool.name === "get_incident")!;

  await read.execute("call-1", { incidentId: "79" } as never, undefined, undefined, {} as never);
  await read.execute("call-2", {} as never, undefined, undefined, {} as never);

  assert.deepEqual(asked, [{ incidentId: "79" }, {}]);
});

test("escalate goes to the Boss's inbox and never through the ToolApi escalate that posts to Slack", async () => {
  const told: { kind: string; text: string; ownBrief?: boolean }[] = [];
  let posted = 0;
  const tools = await createBossTools({
    api: {
      ...stubApi({ ok: true, directives: [] }),
      escalate: async () => {
        posted += 1;
        return { ok: true as const, directives: [] };
      },
    } as unknown as ToolApi,
    boss: {
      tellBoss: async (kind, text, options) => {
        told.push({ kind, text, ownBrief: options?.ownBrief });
      },
    },
  });
  const escalate = tools.find((tool) => tool.name === "escalate");
  assert.ok(escalate, "the model can see it");
  assert.deepEqual(told, []);

  const result = await escalate.execute(
    "call-1",
    { reason: "blocked on a merge", brief: "What I believe now: the fix is ready." } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(posted, 0, "the Slack-posting escalate is never reached");
  assert.deepEqual(told, [
    {
      kind: "escalation",
      text: "blocked on a merge\n\nWhat I believe now: the fix is ready.",
      ownBrief: true,
    },
  ]);
  assert.match(String(result.content[0].type === "text" && result.content[0].text), /^ok/);
});

test("escalate hands back a stop waiting behind it and ends the run on that turn", async () => {
  let told = 0;
  const tools = await createBossTools({
    api: stubApi({ ok: true, directives: [{ type: "stop", reason: "the Boss closed it" }] }),
    boss: {
      tellBoss: async () => {
        told += 1;
      },
    },
  });
  const escalate = tools.find((tool) => tool.name === "escalate")!;

  const result = await escalate.execute(
    "call-1",
    { reason: "out of ideas", brief: "What I believe now: nothing new." } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(told, 1, "the premise: the escalation went up first");
  assert.match(String(result.content[0].type === "text" && result.content[0].text), /the Boss closed it/);
  assert.equal(result.terminate, true);
});

test("park reaches the boss, because a wait nothing can write is a hot loop", async () => {
  // The gap this closes: `park` existed on the tool API and the loopback
  // route and was reachable by nothing the model could call, so an agent that
  // was genuinely blocked had no way to stop being relaunched into the same
  // dead end.
  const calls: unknown[] = [];
  const api = {
    ...stubApi({ ok: true, directives: [] }),
    park: async (args: unknown) => {
      calls.push(args);
      return { ok: true as const, directives: [] };
    },
  };
  const tools = await createBossTools({ api, boss: { tellBoss: async () => {} } });
  const park = tools.find((tool) => tool.name === "park");
  assert.ok(park, "the model can see it");

  await park.execute(
    "call-1",
    { waitingFor: "the credential rotation" } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(calls, [{ waitingFor: "the credential rotation" }]);
});

test("reporting a root cause starts the install, and directives reach the model", async () => {
  let started = 0;
  const tools = await createBossTools({
    boss: { tellBoss: async () => {} },
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
    boss: { tellBoss: async () => {} },
    api: stubApi({ ok: false, error: "incident is already CLOSED", directives: [] }),
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
    /error: incident is already CLOSED/,
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

test("the alert slugs reach the options, and a bad list costs only the list", () => {
  const base = {
    BUGBOSS_INCIDENT_ID: "inc-7",
    BUGBOSS_S3_BUCKET: "b",
    BUGBOSS_SESSION_REF: "sessions/incident/inc-7/session.jsonl",
  };

  assert.deepEqual(
    agentOptionsFromEnv({ ...base, BUGBOSS_ALERT_SLUGS: '["high-cpu","route-errors-win"]' })
      .alertSlugs,
    ["high-cpu", "route-errors-win"],
  );
  assert.equal(agentOptionsFromEnv(base).alertSlugs, undefined);
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    assert.equal(agentOptionsFromEnv({ ...base, BUGBOSS_ALERT_SLUGS: "not json" }).alertSlugs, undefined);
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /alert_slugs_unreadable/);
});

test("an expired deadline still leaves room to escalate", () => {
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

const ended = (over: Partial<Parameters<typeof exitCodeFor>[0]> = {}) => ({
  sessionFile: "f",
  restored: true,
  timedOut: false,
  turnsExhausted: false,
  error: null,
  ...over,
});

test("a force-aborted run does not exit like a finished one", () => {
  assert.equal(exitCodeFor(ended()), 0);
  // The deadline nudge worked and the agent escalated inside the grace window.
  assert.equal(exitCodeFor(ended({ timedOut: true })), 0);
  assert.equal(exitCodeFor(ended({ timedOut: true, error: "aborted by user" })), 1);
  // The turn budget stops the run with the same abort a failing turn leaves
  // an error behind for, so without the exception a bound doing its job
  // reaches the dispatcher as agent_failed and alarms every time.
  assert.equal(
    exitCodeFor(ended({ turnsExhausted: true, error: "aborted by user" })),
    0,
  );
});

test("the exit record names a timeout even when the aborted turn also errored", () => {
  assert.deepEqual(
    exitRecordFor({ timedOut: true, turnsExhausted: false, error: "aborted", attempt: 3, at: 5 }),
    { reason: "timed_out", at: 5, attempt: 3, error: "aborted" },
  );
  assert.deepEqual(
    exitRecordFor({ timedOut: false, turnsExhausted: false, error: "boom", attempt: 1, at: 5 }),
    { reason: "turn_error", at: 5, attempt: 1, error: "boom" },
  );
  assert.deepEqual(
    exitRecordFor({ timedOut: false, turnsExhausted: false, error: null, attempt: 1, at: 5 }),
    { reason: "completed", at: 5, attempt: 1 },
  );
});

// A killed run and a finished one are the same shape on disk, which is why
// the exit record exists at all. A run stopped on its budget is a third
// ending, and it is the one a reader most needs to tell from a crash: the
// answer is "it ran out of room", not "something broke".
test("a run stopped on its budget is named, not filed under the abort it used", () => {
  assert.deepEqual(
    exitRecordFor({
      timedOut: false,
      turnsExhausted: true,
      error: "aborted by user",
      attempt: 2,
      at: 5,
    }),
    { reason: "turns_exhausted", at: 5, attempt: 2, error: "aborted by user" },
  );
  // The dispatcher is escalating the wall clock under its own name at the
  // same moment, so a timeout stays a timeout and the two halves agree.
  assert.deepEqual(
    exitRecordFor({ timedOut: true, turnsExhausted: true, error: null, attempt: 2, at: 5 }),
    { reason: "timed_out", at: 5, attempt: 2 },
  );
});

// Carried purely so the exit record can name the launch. Reading a session
// back, "attempt 3 was killed" is a different story from "attempt 1 was".
test("the attempt reaches the agent from the dispatcher's environment", () => {
  const base = {
    BUGBOSS_INCIDENT_ID: "i1",
    BUGBOSS_S3_BUCKET: "b",
    BUGBOSS_SESSION_REF: "sessions/incident/i1/session.jsonl",
  };
  assert.equal(agentOptionsFromEnv({ ...base, BUGBOSS_ATTEMPT: "3" }).attempt, 3);
  assert.equal(agentOptionsFromEnv(base).attempt, undefined);
  assert.equal(agentOptionsFromEnv({ ...base, BUGBOSS_ATTEMPT: "" }).attempt, undefined);
});

// ECS draining a task is routine, and the most orderly shutdown available
// here: the exit record is written and the session is flushed. Reporting it
// as a failure alarms on every deploy, and inside the fast-failure window it
// walked a rolling deploy to a crash-loop escalation in three bounces.
test("a drained agent exits clean and an interrupted one does not", () => {
  assert.equal(signalExitCode("SIGTERM"), 0);
  assert.equal(signalExitCode("SIGINT"), 1);
});

// The notes are the other half of what a killed run leaves behind, and they
// ride the same turn_end the session does. Neither event fires on the way
// out of a signal handler, so a shutdown that flushes one and not the other
// loses every note written since the last turn.
test("a signalled shutdown flushes the notes as well as the session", async () => {
  const flushed: string[] = [];
  await flushDurable(
    { flush: async () => void flushed.push("session") },
    { flush: async () => void flushed.push("notes") },
  );
  assert.deepEqual(flushed.sort(), ["notes", "session"]);
});

test("one failing store does not stop the other, or the exit", async () => {
  const flushed: string[] = [];
  await flushDurable(
    {
      flush: async () => {
        throw new Error("S3 is down");
      },
    },
    { flush: async () => void flushed.push("notes") },
  );
  assert.deepEqual(flushed, ["notes"]);
});

// SIGTERM from a draining task, then an impatient Ctrl-C. Re-entering the
// shutdown puts two whole-file PUTs on the same key at once, which corrupts
// the exit record by the act of writing it.
test("a second signal does not re-enter the shutdown", () => {
  const seen: string[] = [];
  const shutdown = onceOnly((signal: string) => void seen.push(signal));

  shutdown("SIGTERM");
  shutdown("SIGINT");
  shutdown("SIGTERM");

  assert.deepEqual(seen, ["SIGTERM"], "only the first signal runs it");
});

// ---------------------------------------------------------------------------
// The turn budget
// ---------------------------------------------------------------------------

const turnEndHandlerFor = (budget: { extension: (pi: ExtensionAPI) => void }) => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  budget.extension({
    on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[event] = handler;
      return () => {};
    },
  } as unknown as ExtensionAPI);
  assert.ok(handlers.turn_end, "the budget counts on turn_end or it counts nothing");
  return handlers.turn_end;
};

const turnWithEscalate = (isError = false) =>
  [
    {
      type: "turn_end",
      message: { usage: {} },
      toolResults: [{ toolName: "escalate", isError }],
    },
    {},
  ] as const;

const turnOn = (model: string) =>
  [{ type: "turn_end", message: { model, usage: {} } }, {}] as const;

const turn = (
  usage: Partial<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
    cost: { total: number };
  }> = {},
) => [{ type: "turn_end", message: { usage } }, {}] as const;

test("the turn budget counts the whole incident, not this container's share of it", async () => {
  // Every merge to ops main restarts this container, so a budget that
  // started from zero on each launch would bound nothing at all: a runaway
  // incident gets a fresh 200 turns every deploy.
  const prior = { ...emptySessionUsage(), turns: 8 };
  const grace: TurnBudgetState[] = [];
  const exhausted: TurnBudgetState[] = [];
  const budget = createTurnBudget({
    prior,
    maxTurns: 10,
    graceTurns: 1,
    onGrace: (state) => void grace.push(state),
    onExhausted: (state) => void exhausted.push(state),
  });
  const turnEnd = turnEndHandlerFor(budget);

  await turnEnd(...turn());
  assert.deepEqual(
    grace.map((s) => s.used),
    [9],
    "turn 9 of 10 is the grace edge, counting the 8 an earlier launch used",
  );
  assert.equal(exhausted.length, 0);
  assert.equal(budget.exhausted(), false);

  await turnEnd(...turn());
  assert.deepEqual(
    exhausted.map((s) => s.used),
    [10],
  );
  assert.equal(budget.exhausted(), true);
});

test("a budget already spent stops on its first turn back rather than starting over", async () => {
  const exhausted: TurnBudgetState[] = [];
  const budget = createTurnBudget({
    prior: { ...emptySessionUsage(), turns: 200 },
    maxTurns: 200,
    graceTurns: 10,
    onGrace: () => assert.fail("there is no grace left to give"),
    onExhausted: (state) => void exhausted.push(state),
  });

  await turnEndHandlerFor(budget)(...turn());

  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].used, 201);
});

test("each layer fires once, because a model cannot act on the same sentence twice", async () => {
  const grace: TurnBudgetState[] = [];
  const exhausted: TurnBudgetState[] = [];
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 4,
    graceTurns: 2,
    onGrace: (state) => void grace.push(state),
    onExhausted: (state) => void exhausted.push(state),
  });
  const turnEnd = turnEndHandlerFor(budget);

  for (let i = 0; i < 6; i++) await turnEnd(...turn());

  assert.equal(grace.length, 1, "a steer repeated every turn is noise the agent cannot use");
  assert.equal(exhausted.length, 1, "a second hand-off posts a second brief over the first");
});

test("a budget smaller than the grace window still gets turns to work in", async () => {
  // `graceTurns` is a constant and `maxTurns` is settable, so the two can be
  // configured into nonsense. Unclamped, BUGBOSS_MAX_TURNS=10 puts the soft
  // edge at turn 0: the first turn_end clears it and the agent is told to
  // wrap up before it has done anything, with nine turns left unused. The
  // person who shrinks the budget to exercise this path is exactly who hits
  // it, and it reads as a broken agent rather than a bad number.
  const order: string[] = [];
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 10,
    graceTurns: TURN_BUDGET_GRACE_TURNS,
    onGrace: (state) => void order.push(`grace@${state.used}`),
    onExhausted: (state) => void order.push(`exhausted@${state.used}`),
  });
  const turnEnd = turnEndHandlerFor(budget);

  for (let i = 0; i < 10; i++) await turnEnd(...turn());

  assert.deepEqual(order, ["grace@5", "exhausted@10"], "half the budget, not all of it");
});

test("a two-turn budget keeps one turn of work and one of grace", async () => {
  const order: string[] = [];
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 2,
    graceTurns: TURN_BUDGET_GRACE_TURNS,
    onGrace: (state) => void order.push(`grace@${state.used}`),
    onExhausted: (state) => void order.push(`exhausted@${state.used}`),
  });
  const turnEnd = turnEndHandlerFor(budget);

  await turnEnd(...turn());
  await turnEnd(...turn());

  assert.deepEqual(order, ["grace@1", "exhausted@2"]);
});

test("the brief quotes the grace that was given, not the constant", async () => {
  // Clamped to 5 by the budget above. A brief that said "did not hand off in
  // the 10 it was asked to" would be describing a window nobody had.
  let brief = "";
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 10,
    graceTurns: TURN_BUDGET_GRACE_TURNS,
    onGrace: () => {},
    onExhausted: (state) => void (brief = turnBudgetBrief(state)),
  });
  const turnEnd = turnEndHandlerFor(budget);

  for (let i = 0; i < 10; i++) await turnEnd(...turn());

  assert.match(brief, /did not escalate in the 5 I was asked to/);
});

test("an agent that escalates inside its grace is not escalated over", async () => {
  // The steer asks for an escalation and the model can answer on its very
  // last grace turn, which ends the same turn_end the cap fires on. Both
  // posting puts "it never wrote a brief" directly under the brief it just
  // wrote, in the thread a person is reading. The park still has to happen:
  // announcing is not stopping, and nothing else ends the relaunch loop.
  const states: TurnBudgetState[] = [];
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 3,
    graceTurns: 1,
    onGrace: () => {},
    onExhausted: (state) => void states.push(state),
  });
  const turnEnd = turnEndHandlerFor(budget);

  await turnEnd(...turn());
  await turnEnd(...turnWithEscalate());
  await turnEnd(...turn());

  assert.equal(states.length, 1, "the cap still stops the run");
  assert.equal(states[0].escalated, true, "and the caller is told not to post again");
});

test("a refused escalate leaves the harness to announce it", async () => {
  // `isError` is the whole difference: an escalation the tool API rejected
  // told nobody anything, so treating it as done means the budget runs out
  // in silence -- which is the failure this bound exists to prevent.
  const states: TurnBudgetState[] = [];
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 2,
    graceTurns: 1,
    onGrace: () => {},
    onExhausted: (state) => void states.push(state),
  });
  const turnEnd = turnEndHandlerFor(budget);

  await turnEnd(...turnWithEscalate(true));
  await turnEnd(...turn());

  assert.equal(states.length, 1);
  assert.equal(states[0].escalated, false);
});

test("the budget carries what the run spent, so the escalation can say it", async () => {
  // The point of shipping a turn cap before a dollar cap is to find out what
  // 200 turns costs. That only happens if the number reaches a person.
  const exhausted: TurnBudgetState[] = [];
  const budget = createTurnBudget({
    prior: { ...emptySessionUsage(), turns: 1, tokensIn: 100, costUsd: 0.5 },
    maxTurns: 3,
    graceTurns: 1,
    onGrace: () => {},
    onExhausted: (state) => void exhausted.push(state),
  });
  const turnEnd = turnEndHandlerFor(budget);

  await turnEnd(
    ...turn({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cacheWrite1h: 40, cost: { total: 1.25 } }),
  );
  await turnEnd(...turn({ input: 5, output: 7, cost: { total: 0.75 } }));

  assert.equal(exhausted.length, 1);
  const { usage } = exhausted[0];
  assert.equal(usage.tokensIn, 115, "prior launches plus this one");
  assert.equal(usage.tokensOut, 27);
  assert.equal(usage.cacheRead, 300);
  assert.equal(usage.cacheWrite1h, 40);
  assert.equal(usage.costUsd, 2.5);
});

test("the model comes off the turn, so a first launch can still be re-priced", async () => {
  // A first launch seeds from emptySessionUsage(), so nothing else ever
  // sets modelId. Without reading it off the turn the exhaustion brief
  // names "an unrecorded model" on the common path — 200 turns in one
  // process — and the one figure this cap exists to produce cannot be
  // re-priced against anything.
  let brief = "";
  const budget = createTurnBudget({
    prior: emptySessionUsage(),
    maxTurns: 2,
    graceTurns: 1,
    onGrace: () => {},
    onExhausted: (state) => void (brief = turnBudgetBrief(state)),
  });
  const turnEnd = turnEndHandlerFor(budget);

  await turnEnd(...turnOn("us.anthropic.claude-opus-5"));
  await turnEnd(...turnOn("us.anthropic.claude-opus-5"));

  assert.match(brief, /turns on us\.anthropic\.claude-opus-5/);
  assert.doesNotMatch(brief, /an unrecorded model/);
});

test("the announcement is suppressed only when the agent already made it", () => {
  const base = { graceTurns: 10, usage: emptySessionUsage() };

  assert.equal(
    shouldAnnounceExhaustion({ ...base, used: 200, max: 200, escalated: false }),
    true,
  );
  assert.equal(
    shouldAnnounceExhaustion({ ...base, used: 200, max: 200, escalated: true }),
    false,
    "the agent already said it, on the same turn_end this fires on",
  );
  // Deliberately still announced. A launch that begins over budget is a
  // wake that should not have happened, and that is fixed where the wait
  // is classified rather than muffled here -- one invariant, one mechanism.
  assert.equal(
    shouldAnnounceExhaustion({ ...base, used: 201, max: 200, escalated: false }),
    true,
  );
});

test("an exhausted run parks on a wait a reply cannot lift", () => {
  // `liftsOnReply` defaults to true, which is right for a wait on a person
  // and wrong for this one. Without the argument a reply wakes the incident,
  // the relaunched agent is over budget before it starts, and every comment
  // on the thread becomes a page — which is the whole failure this bound was
  // added to stop, reintroduced by an omitted default.
  const park = turnBudgetPark({
    used: 200,
    max: 200,
    graceTurns: 10,
    escalated: false,
    usage: emptySessionUsage(),
  });

  assert.equal(park.liftsOnReply, false);
  assert.equal(park.waitingFor, "a person to decide what happens next; the 200-turn budget is spent");
});

test("the brief does not promise that replying will continue the work", () => {
  // It used to, and the mechanism it was wrong about has since changed
  // twice, so the history matters more than the assertion. First wording:
  // "nothing will relaunch into the same exhausted budget" — false, because
  // a reply deleted the park and relaunched an over-budget agent. Second:
  // "replying here wakes it, but it will stop again immediately" — true
  // when written, false once the park stopped lifting on a reply. Now a
  // reply does not wake a budget wait at all, and the brief says so.
  //
  // Asserting the absence of both dead sentences on purpose: each was
  // written in good faith against the behaviour of its day, which is
  // exactly how a brief comes to lie to the person reading it.
  const brief = turnBudgetBrief({
    used: 200,
    max: 200,
    graceTurns: 10,
    escalated: false,
    usage: { ...emptySessionUsage(), turns: 200 },
  });

  assert.match(brief, /raise BUGBOSS_MAX_TURNS or pick it up themselves/);
  assert.match(brief, /neither a reply in the thread nor a message to me will restart it/);
  assert.doesNotMatch(
    brief,
    /nothing will relaunch into the same exhausted budget/,
    "first wording: a reply did relaunch it",
  );
  assert.doesNotMatch(
    brief,
    /wakes it/,
    "second wording: a budget wait is not lifted by a reply, so it does not wake",
  );
});

test("the escalation brief names the spend and never states the price as a fact", () => {
  const brief = turnBudgetBrief(
    {
      used: 200,
      max: 200,
      graceTurns: 10,
      escalated: false,
      usage: {
        ...emptySessionUsage(),
        turns: 200,
        tokensIn: 3_000,
        tokensOut: 1_200,
        cacheRead: 1_200_000,
        cacheWrite: 90_000,
        modelId: "us.anthropic.claude-opus-5",
        costUsd: 41.2345,
      },
    },
  );

  assert.match(brief, /ran out of turns, not because I finished/);
  assert.match(brief, /200 turns on us\.anthropic\.claude-opus-5/);
  assert.match(brief, /1\.3M tokens \(3000 in, 1200 out, 1200000 cache read, 90000 cache write\)/);
  assert.match(brief, /Estimated cost \$41\.23/);
  assert.match(brief, /An estimate, not an invoiced figure/);
});

test("a brief for an already-spent budget does not contradict its own numbers", async () => {
  // The relaunch case: the previous launch died before its hand-off landed,
  // so this one starts over budget and stops on turn 1. Quoting `max` in the
  // opening line put "used all 200 turns" directly above "201 turns on ...",
  // and a brief that disagrees with itself is one a reader stops trusting.
  let brief = "";
  const budget = createTurnBudget({
    prior: { ...emptySessionUsage(), turns: 200, modelId: "us.anthropic.claude-opus-5" },
    maxTurns: 200,
    graceTurns: TURN_BUDGET_GRACE_TURNS,
    onGrace: () => assert.fail("there is no grace left to give"),
    onExhausted: (state) => void (brief = turnBudgetBrief(state)),
  });

  await turnEndHandlerFor(budget)(...turn());

  assert.match(brief, /201 turns on us\.anthropic\.claude-opus-5/);
  assert.match(brief, /already spent when this launch started/);
  assert.doesNotMatch(brief, /used all 200 turns/);
  assert.doesNotMatch(
    brief,
    /still working when the budget ran out/,
    "it did no work on this launch, so saying it was interrupted mid-investigation is a lie",
  );
});

test("a run the provider priced at nothing says so rather than reporting it free", () => {
  const brief = turnBudgetBrief({
    used: 5,
    max: 5,
    graceTurns: 1,
    escalated: false,
    usage: { ...emptySessionUsage(), turns: 5 },
  });

  assert.match(brief, /No cost estimate: the provider reported no prices/);
  assert.doesNotMatch(brief, /\$0\.00/);
});

test("the steer says the budget does not come back, because a restart looks like one that would", () => {
  const message = turnBudgetMessage({
    used: 190,
    max: 200,
    graceTurns: 10,
    escalated: false,
    usage: emptySessionUsage(),
  });

  assert.match(message, /190 of the 200 turns/);
  assert.match(message, /across every launch/);
  assert.match(message, /calling escalate/);
  assert.match(message, /A restart does not give the turns back/);
});

test("the turn budget reaches the agent from the environment the dispatcher builds", () => {
  const options = agentOptionsFromEnv({
    BUGBOSS_INCIDENT_ID: "inc-1",
    BUGBOSS_S3_BUCKET: "b",
    BUGBOSS_SESSION_REF: "sessions/incident/inc-1/session.jsonl",
    BUGBOSS_MAX_TURNS: "40",
  });
  assert.equal(options.maxTurns, 40);

  // Number("") is 0 and 0 is finite, so an unset-but-present variable would
  // otherwise hand every agent a budget of nothing and stop it on its first
  // turn -- the same trap BUGBOSS_DEADLINE_AT already carries a guard for.
  for (const value of ["", "0", "-5", "nonsense"]) {
    assert.equal(
      agentOptionsFromEnv({
        BUGBOSS_INCIDENT_ID: "inc-1",
        BUGBOSS_S3_BUCKET: "b",
        BUGBOSS_SESSION_REF: "sessions/incident/inc-1/session.jsonl",
        BUGBOSS_MAX_TURNS: value,
      }).maxTurns,
      INCIDENT_AGENT_MAX_TURNS,
      `BUGBOSS_MAX_TURNS=${JSON.stringify(value)} must fall back, not bind`,
    );
  }
});

test("a Boss message rides on a bash result, and a stop waits for a Boss tool (incident 94)", async () => {
  const queue = [
    { id: 1, directive: { type: "boss_message" as const, text: "the fix hides the bug; re-scope before shipping", at: 1 } },
    { id: 2, directive: { type: "stop" as const, reason: "closed" } },
  ];
  const consumed: number[] = [];
  const failures: unknown[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
      return () => {};
    },
  } as never;

  directiveDeliveryExtension(
    {
      peekDirectives: async () => queue.filter((entry) => !consumed.includes(entry.id)),
      consumeDirective: async (id) => {
        consumed.push(id);
      },
    },
    (error) => failures.push(error),
  )(pi);

  const bash = { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "pass: 36" }] };
  const first = (await handlers.tool_result(bash, {})) as { content: { type: string; text: string }[] };
  assert.equal(first.content[0].text, "pass: 36", "the tool's own output is untouched");
  assert.match(first.content.at(-1)?.text ?? "", /FROM THE BOSS: the fix hides the bug; re-scope before shipping/);
  assert.doesNotMatch(first.content.at(-1)?.text ?? "", /STOP/);
  assert.deepEqual(consumed, [1]);

  assert.equal(await handlers.tool_result(bash, {}), undefined, "delivered once");
  assert.deepEqual(failures, []);
});

test("a failed directive read leaves the tool result as it was", async () => {
  const failures: unknown[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
      return () => {};
    },
  } as never;
  directiveDeliveryExtension(
    {
      peekDirectives: async () => {
        throw new Error("the Boss said 503");
      },
      consumeDirective: async () => {},
    },
    (error) => failures.push(error),
  )(pi);

  const result = await handlers.tool_result(
    { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "ok" }] },
    {},
  );
  assert.equal(result, undefined);
  assert.equal(failures.length, 1);
});
