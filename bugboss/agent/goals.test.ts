import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { TranscriptContext } from "@earendil-works/pi-ai";

import { createPiModelClient } from "../bedrock/client";
import type { Directive, GoalContext, IncidentStatus, TimelineEvent, ToolApi, ToolResponse } from "../types";
import { createGoalEvaluator, createStageGoals, GOALS } from "./goals";
import { createBossTools, startWithinBudget } from "./run";
import { sumSessionUsage } from "./session";
import { createMessageBossTool } from "./tools";

type Verdict = { verdict: string; reason: string };

const SIGNAL = {
  id: "s1",
  kind: "alert" as const,
  source: "grafana",
  title: "POST /v1/payments/events returned 5xx",
  body: "POST /v1/payments/events returned unexpected error responses. Read the exception each failing request logged before deciding what to fix.",
};

const MERGED: TimelineEvent = {
  id: 7,
  kind: "fix_merged",
  occurredAt: Date.parse("2026-09-30T20:30:00Z"),
  recordedAt: Date.parse("2026-09-30T20:31:00Z"),
  summary: "omni#2265 merged",
  evidenceUrl: "https://github.com/thegoodparty/omni/pull/2265",
};

/**
 * A real Pi session with two stand-in models: the agent, scripted turn by
 * turn, and the evaluator, a function of what it is shown. Everything between
 * them -- the tool calls, the gate, the reason landing in the agent's next
 * request -- is the production code.
 */
const runGoals = async (args: {
  status?: IncidentStatus;
  timeline?: TimelineEvent[];
  /** What the stand-in `run_query` tool returns, in call order. */
  queries?: string[];
  /** Directives the Boss has queued, drained by the first get_incident. */
  directives?: Directive[];
  judge: (body: string) => Verdict;
  turns: (kit: typeof import("@earendil-works/pi-ai")) => unknown[];
}) => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const kit = await import("@earendil-works/pi-ai");
  const { Type } = await import("typebox");
  const dir = await mkdtemp(join(tmpdir(), "bugboss-goals-"));

  const faux = kit.fauxProvider({
    models: [
      { id: "faux-opus", contextWindow: 1_000_000, maxTokens: 1_000 },
      { id: "faux-haiku", contextWindow: 200_000, maxTokens: 1_000 },
    ],
  });
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const agentModel = faux.getModel("faux-opus");
  const evaluatorModel = faux.getModel("faux-haiku");
  assert.ok(agentModel && evaluatorModel);

  const agentRequests: string[] = [];
  const evaluatorBodies: string[] = [];
  const scripted = args.turns(kit);
  faux.setResponses(
    Array.from({ length: 60 }, () => (context: TranscriptContext, _o: unknown, _s: unknown, model: { id: string }) => {
      if (model.id === "faux-haiku") {
        const body = JSON.stringify(context.messages);
        evaluatorBodies.push(body);
        return kit.fauxAssistantMessage(JSON.stringify(args.judge(body)));
      }
      agentRequests.push(JSON.stringify(context.messages));
      const next = scripted.shift();
      return (next ?? kit.fauxAssistantMessage("done")) as ReturnType<typeof kit.fauxAssistantMessage>;
    }),
  );

  const calls = {
    reportRootCause: 0,
    reportResolved: 0,
    reportAnalysis: 0,
    told: [] as { kind: string; text: string }[],
    verdicts: [] as { gate: string; verdict: string; reason: string }[],
  };
  const queued = [...(args.directives ?? [])];
  const ok = (data?: unknown): ToolResponse<never> =>
    ({ ok: true, directives: [], ...(data === undefined ? {} : { data }) }) as ToolResponse<never>;
  const api = {
    reportRootCause: async () => {
      calls.reportRootCause += 1;
      return ok();
    },
    reportResolved: async () => {
      calls.reportResolved += 1;
      return ok();
    },
    reportAnalysis: async () => {
      calls.reportAnalysis += 1;
      return ok();
    },
    getIncident: async () => {
      const directives = queued.splice(0);
      return { ...ok({ signals: [SIGNAL] }), directives };
    },
    trackTimelineEvent: async (event: { kind: TimelineEvent["kind"] }) => ok({ ...event, id: 9 }),
  } as unknown as ToolApi;
  const tellBoss = async (kind: string, text: string) => {
    calls.told.push({ kind, text });
  };

  const context: GoalContext = {
    incident: {
      id: "94",
      status: args.status ?? "INVESTIGATING",
      rootCause: null,
      usersImpacted: null,
      impactQuery: null,
      prUrls: [],
      resolvedEvidence: null,
    },
    signals: [SIGNAL],
    timeline: args.timeline ?? [],
  };

  let manager: import("@earendil-works/pi-coding-agent").SessionManager | null = null;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const goals = createStageGoals({
    evaluate: createGoalEvaluator({
      client: createPiModelClient({ runtime: modelRuntime, model: evaluatorModel as never }),
      contextWindow: evaluatorModel.contextWindow,
      estimateTokens: (message) => pi.estimateTokens(message),
    }),
    context: async () => context,
    recordVerdict: async (verdict) => {
      calls.verdicts.push(verdict);
    },
    escalate: (reason, brief) => tellBoss("escalation", `${reason}\n\n${brief}`),
    session: () => manager,
    toMessages: (messages) => pi.convertToLlm(messages as Parameters<typeof pi.convertToLlm>[0]),
    log: (event, fields) => logs.push({ event, fields }),
    alarm: (event, fields) => logs.push({ event, fields }),
  });

  const queries = [...(args.queries ?? [])];
  const queryTool = {
    name: "run_query",
    label: "Run query",
    description: "A stand-in for any tool that surfaces evidence.",
    parameters: Type.Object({ query: Type.String() }),
    execute: async () => ({
      content: [{ type: "text" as const, text: queries.shift() ?? "(no rows)" }],
      details: undefined,
    }),
  };
  const customTools = [
    ...(await createBossTools({
      api,
      boss: { tellBoss: (kind, text) => tellBoss(kind, text) },
      goals,
    })),
    await createMessageBossTool({
      marker: {
        getPending: async () => null,
        recordPending: async () => ({ message: "", askedAt: 0 }),
        clearPending: async () => {},
      },
      boss: { tellBoss: (kind, text) => tellBoss(kind, text), escalationsSince: async () => ({ count: 0, lastAt: null }) },
      api: { peekDirectives: async () => [], consumeDirective: async () => {} },
      checkIn: goals.checkIn,
    }),
    queryTool,
  ] as import("@earendil-works/pi-coding-agent").ToolDefinition[];

  const settings = pi.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 148_000, keepRecentTokens: 10 },
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: settings,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPromptOverride: () => "You are a test agent.",
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  manager = pi.SessionManager.create(dir, join(dir, "sessions"), { id: "inc-94" });
  const { session } = await pi.createAgentSession({
    cwd: dir,
    model: agentModel,
    modelRuntime,
    tools: customTools.map((tool) => tool.name),
    customTools,
    resourceLoader,
    settingsManager: settings,
    sessionManager: manager,
  });

  await startWithinBudget({
    budget: { stopIfSpent: async () => false },
    stages: { resume: async () => {} },
    session,
    message: "Incident 94 is yours.",
  });
  const error = session.state.errorMessage ?? null;
  session.dispose();

  const file = manager.getSessionFile();
  assert.ok(file);
  const raw = await readFile(file, "utf8");
  return { calls, agentRequests, evaluatorBodies, goals, logs, error, raw };
};

const verdict = (v: string, reason: string): Verdict => ({ verdict: v, reason });

/**
 * The parts of the evaluator's prompt a stand-in judges on. The goal text
 * itself quotes phrases like "Recommendation: approve", so a stand-in that
 * searched the whole prompt would be judging the goal, not the evidence.
 */
const sections = (body: string) => {
  const text = (JSON.parse(body) as { content: unknown }[])
    .map((message) => JSON.stringify(message.content))
    .join("\n")
    .replace(/\\n/g, "\n");
  const at = (heading: string) => text.indexOf(heading);
  return {
    gate: text.slice(at("# The goal: "), at("# What the agent is doing now")),
    attempt: text.slice(at("# What the agent is doing now"), at("# The incident record")),
    transcript: text.slice(at("# The agent's conversation since its last compaction")),
  };
};

describe("stage goals, through a real Pi session", () => {
  test("incident 94: a root cause that explains only the alert is rejected, then accepted once user harm is shown", async () => {
    const alertShaped =
      "Peerly refused the draft for a bit.ly link and the refusal reached Stripe as a retryable gateway error instead of a permanent one -- that 502 is what paged.";
    const run = await runGoals({
      queries: [
        "3 candidates were charged $634.10 for P2P text sends Peerly refused after payment; none were sent.",
      ],
      judge: (body) =>
        sections(body).transcript.includes("charged $634.10")
          ? verdict("met", "The transcript shows candidates charged for sends that never went out, and the 502 is explained.")
          : verdict("not_met", "Nothing shows what happened to a user: who paid, and what did they get instead of the send?"),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: alertShaped, explainedSignalIds: ["s1"] })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "charged with no send" })),
        fauxAssistantMessage(
          fauxToolCall("report_root_cause", {
            cause: "A candidate was charged for a P2P text send that could never be created, because we take the money before asking Peerly whether the message is sendable.",
            explainedSignalIds: ["s1"],
          }),
        ),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.calls.reportRootCause, 1, "the transition ran once, on the met verdict");
    assert.match(run.agentRequests[1], /NOT MET, nothing changed: Nothing shows what happened to a user/);
    assert.match(
      run.agentRequests[1],
      /comprehensive picture of what went wrong for an actual human user/,
      "the goal text comes back with the reason",
    );
    assert.deepEqual(
      run.calls.verdicts.filter((v) => v.gate === "root_cause").map((v) => v.verdict),
      ["not_met", "met"],
      "every verdict reaches the timeline",
    );
    assert.match(run.evaluatorBodies[0], /POST \/v1\/payments\/events returned 5xx/, "the evaluator sees the signals");
    assert.match(run.evaluatorBodies[0], /that 502 is what paged/, "and the claim it is judging, whole");
  });

  test("resolved is rejected until the deploy, the replay, the repairs and the follow-ups are all shown", async () => {
    const evidence = [
      ["release run 1187 succeeded on merge commit 4f2a", "No release run is shown succeeding for the merge commit of omni#2265."],
      ["Replay against deployed sha 4f2a", "No replay of the impacted users' path against the deployed commit."],
      ["Refunded 3 charges in Stripe", "The 3 charged candidates are not shown refunded."],
      ["release run 1188 succeeded on omni#2270", "Follow-up omni#2270 is not shown merged and deployed."],
    ];
    const run = await runGoals({
      status: "FIXING",
      timeline: [MERGED],
      queries: evidence.map(([shown]) => shown),
      judge: (body) => {
        const missing = evidence.find(([shown]) => !sections(body).transcript.includes(shown));
        return missing
          ? verdict("not_met", missing[1])
          : verdict("met", "Deploy, replay, repairs and follow-up all shown.");
      },
      turns: ({ fauxAssistantMessage, fauxToolCall }) => {
        const resolve = (text: string) =>
          fauxAssistantMessage(
            fauxToolCall("report_resolved", { prUrls: ["https://github.com/thegoodparty/omni/pull/2265"], evidence: text }),
          );
        return [
          resolve("the alert has been quiet for an hour"),
          ...evidence.flatMap(([shown]) => [
            fauxAssistantMessage(fauxToolCall("run_query", { query: shown })),
            resolve(`shown: ${shown}`),
          ]),
          fauxAssistantMessage("done"),
        ];
      },
    });

    assert.equal(run.calls.reportResolved, 1, "only the last attempt ran the transition");
    evidence.forEach(([, reason], i) => {
      assert.ok(run.agentRequests[1 + 2 * i].includes(reason), `refused for: ${reason}`);
    });
    assert.deepEqual(
      run.calls.verdicts.map((v) => v.verdict),
      ["not_met", "not_met", "not_met", "not_met", "met"],
    );
  });

  test("closing is rejected while the post-mortem lists follow-up work on this incident, and accepts practice-level prevention", async () => {
    const sections_ = (resolutionActions: string[]) => ({
      atAGlance: "Candidates were charged for sends that never went out. Fixed.",
      timeline: [{ at: "2026-09-30T19:02:11Z", event: "first refused send" }],
      userImpact: "3 candidates charged $634.10 with no send.",
      rootCause: "We took the money before asking Peerly whether the message was sendable.",
      fiveWhys: Array.from({ length: 5 }, (_, i) => ({ why: `why ${i}`, because: `because ${i}` })),
      resolutionActions,
      practiceChanges:
        "Check a send is deliverable before any payment step, as a test pattern for every paid flow.",
      usersImpacted: 3,
      impactQuery: "select ...",
    });
    const run = await runGoals({
      status: "RESOLVED",
      judge: (body) =>
        sections(body).attempt.includes("Follow-up:")
          ? verdict("not_met", "A resolution action is follow-up work on this incident; ship it or escalate it as a decision.")
          : verdict("met", "Timeline, impact and cause match; no follow-up work on this incident."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(
          fauxToolCall("report_analysis", sections_(["Refunded the 3 candidates", "Follow-up: add the pre-payment gate"])),
        ),
        fauxAssistantMessage(
          fauxToolCall("report_analysis", sections_(["Refunded the 3 candidates", "Shipped the pre-payment gate in omni#2270"])),
        ),
        fauxAssistantMessage("closed"),
      ],
    });

    assert.equal(run.calls.reportAnalysis, 1);
    assert.match(run.agentRequests[1], /follow-up work on this incident; ship it/);
    assert.match(run.evaluatorBodies[1], /test pattern for every paid flow/, "practice-level prevention reaches the evaluator and passes");
  });

  test("the merge check-in holds the ask while delegate's last verdict is not approve", async () => {
    const run = await runGoals({
      status: "FIXING",
      queries: ["delegate-reviewer on 9c1e: request changes", "delegate-reviewer on 3b7d: APPROVED; checks green"],
      judge: (body) =>
        sections(body).transcript.includes("APPROVED")
          ? verdict("met", "Approved on the head commit, CI green.")
          : verdict("not_met", "delegate-reviewer's last verdict on the head commit is request changes."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("run_query", { query: "reviews" })),
        fauxAssistantMessage(fauxToolCall("message_boss", { message: "Please get omni#2265 merged." })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "reviews again" })),
        fauxAssistantMessage(fauxToolCall("message_boss", { message: "Please get omni#2265 merged." })),
        fauxAssistantMessage("done"),
      ],
    });

    const asks = run.calls.told.filter((told) => told.kind === "message");
    assert.equal(asks.length, 1, "the first ask never left; the second did");
    assert.match(run.agentRequests[2], /Not sent to the Boss\. NOT MET.*request changes/s);
    assert.deepEqual(
      run.calls.verdicts.filter((v) => v.gate === "merge_check_in").map((v) => v.verdict),
      ["not_met", "met"],
    );
  });

  test("a message that asks nobody to merge goes out, and records no verdict", async () => {
    const run = await runGoals({
      status: "FIXING",
      judge: () => verdict("not_applicable", "A status update, not a merge ask."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("message_boss", { message: "Root cause found; writing the fix now." })),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.evaluatorBodies.length, 1, "premise: the evaluator was asked");
    assert.equal(run.calls.told.filter((told) => told.kind === "message").length, 1);
    assert.equal(run.calls.verdicts.length, 0);
  });

  test("impossible escalates through escalate, and the agent keeps working", async () => {
    const run = await runGoals({
      judge: () => verdict("impossible", "Only Stripe support can say which charges were refunded; a person has to ask them."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("still here"),
      ],
    });

    assert.equal(run.calls.reportRootCause, 0, "the transition did not run");
    assert.equal(run.calls.told.length, 1);
    assert.equal(run.calls.told[0].kind, "escalation");
    assert.match(run.calls.told[0].text, /Only Stripe support can say/);
    assert.match(run.agentRequests[1], /IMPOSSIBLE, nothing changed: Only Stripe support.*The Boss has it as an escalation/s);
    assert.deepEqual(run.calls.verdicts.map((v) => v.verdict), ["impossible"]);
  });

  test("a refused gate still delivers a stop the Boss queued", async () => {
    const run = await runGoals({
      directives: [{ type: "stop", reason: "a person took it" }],
      judge: () => verdict("not_met", "No user harm shown."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("should not run"),
      ],
    });

    assert.equal(run.calls.reportRootCause, 0, "premise: the gate was refused");
    assert.equal(run.agentRequests.length, 1, "the stop ended the run on the refused call");
  });

  test("an evaluator that fails passes the gate, with an alarm", async () => {
    const run = await runGoals({
      judge: () => ({ verdict: "maybe", reason: "" }),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.calls.reportRootCause, 1);
    assert.ok(run.logs.some((log) => log.event === "goal_unjudged"));
    assert.equal(run.calls.verdicts.length, 0, "an outage is not a verdict on the timeline");
  });

  test("the evaluator's tokens count in the incident's usage, and not as turns", async () => {
    const run = await runGoals({
      judge: () => verdict("met", "ok"),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("done"),
      ],
    });

    const lines = run.raw.trim().split("\n");
    const withoutVerdicts = lines.filter((line) => !line.includes("bugboss_goal_verdict")).join("\n");
    const all = sumSessionUsage(run.raw);
    const agentOnly = sumSessionUsage(withoutVerdicts);
    assert.equal(all.turns, agentOnly.turns);
    assert.ok(all.tokensIn > agentOnly.tokensIn, "the evaluator's input tokens are on the bill");
    assert.equal(all.modelId, agentOnly.modelId, "the row stays priced as the agent's model");
  });
});

test("a transcript over the evaluator's window drops its oldest messages whole and says how many", async () => {
  let body = "";
  const evaluate = createGoalEvaluator({
    client: {
      complete: async (request) => {
        body = JSON.stringify(request.messages);
        return { text: '{"verdict": "met", "reason": "ok"}', usage: null } as never;
      },
    },
    contextWindow: 9_000,
    maxTokens: 100,
    estimateTokens: () => 1_000,
  });
  const message = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
  await evaluate({
    gate: "root_cause",
    goal: GOALS.root_cause,
    attempt: "attempt",
    context: {
      incident: { id: "1", status: "INVESTIGATING", rootCause: null, usersImpacted: null, impactQuery: null, prUrls: [], resolvedEvidence: null },
      signals: [],
      timeline: [],
    },
    transcript: Array.from({ length: 10 }, (_, i) => message(`message-${i}`)),
  });

  const shown = Array.from({ length: 10 }, (_, i) => body.includes(`message-${i}`));
  const dropped = shown.indexOf(true);
  assert.ok(dropped > 0, "premise: something was dropped");
  assert.ok(shown.slice(dropped).every(Boolean), "only the oldest, whole");
  assert.ok(body.includes(`(${dropped} earlier messages are not shown, for size.`));
});

test("the closing goal rejects undone work on this incident, not practice-level prevention", () => {
  assert.match(GOALS.analysis, /no follow-up work on this incident/);
  assert.match(GOALS.analysis, /development practice in general .* are wanted, not follow-up work/);
  assert.match(GOALS.resolved, /follow-up or prevention work for this incident has been fully completed/);
  assert.match(GOALS.resolved, /changes to how we build" ideas are not work for this incident/);
});
