import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { TranscriptContext } from "@earendil-works/pi-ai";

import { createPiModelClient } from "../bedrock/client";
import type {
  GoalContext,
  IncidentStatus,
  TimelineEvent,
  ToolApi,
  ToolResponse,
} from "../types";
import {
  createGoalEvaluator,
  createStageGoals,
  goalStopExtension,
  GOAL_MESSAGE_TYPE,
  GOALS,
  parseStageTurns,
  stageFor,
  type GoalStage,
} from "./goals";
import { createBossTools, exitCodeFor, startWithinBudget } from "./run";
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
 * them -- the tool calls, the gate, the stop hook, the steered reason landing
 * in the agent's next request -- is the production code.
 */
const runGoals = async (args: {
  status?: IncidentStatus;
  timeline?: TimelineEvent[];
  bounds?: Record<GoalStage, number>;
  /** What the stand-in `run_query` tool returns, in call order. */
  queries?: string[];
  /** How many report_root_cause calls the tool API refuses first. */
  rootCauseRefusals?: number;
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
    park: [] as { waitingFor: string; liftsOnReply?: boolean }[],
    told: [] as { kind: string; text: string }[],
    verdicts: [] as { gate: string; verdict: string; reason: string }[],
  };
  const ok = (data?: unknown): ToolResponse<never> =>
    ({ ok: true, directives: [], ...(data === undefined ? {} : { data }) }) as ToolResponse<never>;
  const api = {
    reportRootCause: async () => {
      calls.reportRootCause += 1;
      if (calls.reportRootCause <= (args.rootCauseRefusals ?? 0)) {
        return { ok: false, error: "the incident moved", directives: [] } as ToolResponse<never>;
      }
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
    park: async (park: { waitingFor: string; liftsOnReply?: boolean }) => {
      calls.park.push(park);
      return ok();
    },
    getIncident: async () => ok({ signals: [SIGNAL] }),
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

  let live: import("@earendil-works/pi-coding-agent").AgentSession | null = null;
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
    tellBoss: (text) => tellBoss("escalation", text),
    park: (park) => api.park(park),
    pendingQuestion: async () => null,
    session: () => manager,
    toMessages: (messages) => pi.convertToLlm(messages as Parameters<typeof pi.convertToLlm>[0]),
    abort: async () => {
      await live?.abort();
    },
    wrappingUp: () => false,
    ...(args.bounds ? { bounds: args.bounds } : {}),
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
      onTimelineEvent: (kind) => {
        if (kind === "fix_merged") goals.merged();
      },
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
    extensionFactories: [goals.extension, goalStopExtension(goals)],
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
  live = session;

  goals.start(context);
  await startWithinBudget({
    budget: { stopIfSpent: async () => false },
    goals,
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
    transcript: text.slice(at("# The agent's conversation in this stage")),
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
    assert.deepEqual(
      run.calls.verdicts.filter((v) => v.gate === "root_cause").map((v) => v.verdict),
      ["not_met", "met"],
      "every verdict reaches the timeline",
    );
    assert.equal(run.goals.stage(), "fixing");
    assert.match(run.evaluatorBodies[0], /POST \/v1\/payments\/events returned 5xx/, "the evaluator sees the signals");
    assert.match(run.evaluatorBodies[0], /that 502 is what paged/, "and the claim it is judging, whole");
  });

  test("resolved is rejected without a post-deploy replay, then without follow-ups done", async () => {
    const run = await runGoals({
      status: "FIXING",
      timeline: [MERGED],
      queries: [
        "Replay against deployed sha 4f2a: a draft with a bit.ly link is refused before checkout; no charge.",
        "Follow-up omni#2270 (pre-payment gate for MMS) merged at 21:02; release run 1188 succeeded on its merge commit.",
      ],
      judge: (body) =>
        !sections(body).transcript.includes("Replay against deployed")
          ? verdict("not_met", "No replay of the impacted users' path against the deployed commit.")
          : !sections(body).transcript.includes("release run 1188 succeeded")
            ? verdict("not_met", "Follow-up omni#2270 is not shown merged and deployed.")
            : verdict("met", "Replay and follow-up shown."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(
          fauxToolCall("report_resolved", { prUrls: ["https://github.com/thegoodparty/omni/pull/2265"], evidence: "the alert has been quiet for an hour" }),
        ),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "replay" })),
        fauxAssistantMessage(
          fauxToolCall("report_resolved", { prUrls: ["https://github.com/thegoodparty/omni/pull/2265"], evidence: "replayed" }),
        ),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "follow-up" })),
        fauxAssistantMessage(
          fauxToolCall("report_resolved", { prUrls: ["https://github.com/thegoodparty/omni/pull/2265"], evidence: "replayed, follow-up shipped" }),
        ),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.calls.reportResolved, 1);
    assert.match(run.agentRequests[1], /No replay of the impacted users' path/);
    assert.match(run.agentRequests[3], /Follow-up omni#2270 is not shown merged and deployed/);
    assert.equal(run.goals.stage(), "closing");
  });

  test("closing is rejected while the post-mortem leaves follow-up work on this incident", async () => {
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
    assert.equal(run.goals.stage(), null, "a closed incident has no stage, so its last message is not judged");
    assert.equal(run.evaluatorBodies.length, 2, "and no stop was evaluated after it");
  });

  test("the merge check-in holds the ask while delegate's last verdict is not approve", async () => {
    const run = await runGoals({
      status: "FIXING",
      queries: ["delegate-reviewer on 9c1e: request changes", "delegate-reviewer on 3b7d: APPROVED; checks green"],
      judge: (body) =>
        !sections(body).gate.includes("Before asking a person to merge")
          ? verdict("not_met", "Wait for the merge.")
          : sections(body).transcript.includes("APPROVED")
          ? verdict("met", "Approved on the head commit, CI green.")
          : verdict("not_met", "delegate-reviewer's last verdict on the head commit is request changes."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("run_query", { query: "reviews" })),
        fauxAssistantMessage(fauxToolCall("message_boss", { message: "Please get omni#2265 merged." })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "reviews again" })),
        fauxAssistantMessage(fauxToolCall("message_boss", { message: "Please get omni#2265 merged." })),
        fauxAssistantMessage(fauxToolCall("park", { waitingFor: "a merge of omni#2265" })),
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

  test("a stop attempt with the goal not met continues the run with the reason", async () => {
    const run = await runGoals({
      queries: ["2 candidates charged with no send"],
      judge: (body) =>
        !sections(body).gate.includes("report_root_cause")
          ? verdict("not_met", "Now fix it.")
          : sections(body).transcript.includes("candidates charged")
          ? verdict("met", "User harm shown.")
          : verdict("not_met", "You have not shown who was harmed; query for charges with no send."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage("I think the 502 is the bug and I am done."),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "charged with no send" })),
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "charged before the send was checked", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("root cause reported"),
      ],
    });

    assert.match(run.agentRequests[1], /Do not stop yet: the goal for this stage is not met\. You have not shown who was harmed/);
    assert.ok(run.raw.includes(GOAL_MESSAGE_TYPE), "the reason is in the session, so a restart keeps it");
    assert.equal(run.calls.reportRootCause, 1);
    assert.equal(run.goals.stage(), "fixing");
  });

  test("park is a stop attempt too, and is refused while the goal is not met", async () => {
    const run = await runGoals({
      judge: () => verdict("not_met", "Nothing is waiting on a person; keep investigating."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("park", { waitingFor: "someone to look" })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "q" })),
        fauxAssistantMessage(fauxToolCall("escalate", { reason: "stuck", brief: "b" })),
      ],
      bounds: { investigating: 3, fixing: 60, verifying: 40, closing: 20 },
    });
    assert.match(run.agentRequests[1], /Not parked\. Do not stop yet/);
  });

  test("impossible escalates to the Boss and parks", async () => {
    const run = await runGoals({
      judge: () => verdict("impossible", "Only Stripe support can say which charges were refunded; a person has to ask them."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("should not run"),
      ],
    });

    assert.equal(run.calls.reportRootCause, 0);
    assert.equal(run.calls.told.length, 1);
    assert.equal(run.calls.told[0].kind, "escalation");
    assert.match(run.calls.told[0].text, /Only Stripe support can say/);
    assert.deepEqual(run.calls.park.map((p) => p.liftsOnReply), [true], "a reply is exactly what should restart it");
    assert.equal(run.agentRequests.length, 1, "the gate ended the run");
    assert.ok(run.goals.handedOff());
  });

  test("the stage's turn bound escalates with the last reason and stops the run", async () => {
    const run = await runGoals({
      bounds: { investigating: 3, fixing: 60, verifying: 40, closing: 20 },
      judge: () => verdict("not_met", "No user harm shown yet."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "the 502", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "a" })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "b" })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "c" })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "d" })),
      ],
    });

    assert.equal(run.agentRequests.length, 3, "nothing after the third turn");
    assert.equal(run.calls.told.length, 1);
    assert.match(run.calls.told[0].text, /investigating stage has used its 3 turns/);
    assert.match(run.calls.told[0].text, /No user harm shown yet/, "with the last not-met reason");
    assert.equal(run.calls.park.length, 1);
    assert.equal(
      exitCodeFor({ sessionFile: undefined, restored: false, timedOut: false, turnsExhausted: false, goalParked: true, error: run.error }),
      0,
      "a bound doing its job is not an agent failure",
    );
  });

  test("repeated stops with no work between them hand off instead of looping", async () => {
    const run = await runGoals({
      judge: () => verdict("not_met", "Show user harm."),
      turns: ({ fauxAssistantMessage }) => [
        fauxAssistantMessage("done"),
        fauxAssistantMessage("still done"),
        fauxAssistantMessage("really done"),
        fauxAssistantMessage("never reached"),
      ],
    });

    assert.equal(run.agentRequests.length, 3);
    assert.equal(run.calls.told.length, 1);
    assert.match(run.calls.told[0].text, /3 times in a row/);
    assert.equal(run.calls.park.length, 1);
  });

  test("a met stop is told to record it, and never counts toward the hand-off", async () => {
    let n = 0;
    const run = await runGoals({
      judge: () => {
        n += 1;
        return n <= 2 ? verdict("not_met", "Show user harm.") : verdict("met", "Harm shown.");
      },
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "q" })),
      ],
    });

    assert.match(run.agentRequests[3], /judged met: record it with report_root_cause/);
    assert.equal(run.calls.reportRootCause, 1);
    assert.equal(run.calls.told.length, 0, "nobody was told it fell short");
  });

  test("a met gate the tool API refuses still counts as progress", async () => {
    let n = 0;
    const run = await runGoals({
      rootCauseRefusals: 1,
      judge: () => {
        n += 1;
        // Not a verdict after the fourth, so the fifth stop is let through
        // unjudged and the run ends there.
        return n === 3
          ? verdict("met", "Harm shown.")
          : n <= 4
            ? verdict("not_met", "Show user harm.")
            : verdict("unparseable", "x");
      },
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("report_root_cause", { cause: "x", explainedSignalIds: ["s1"] })),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.calls.reportRootCause, 1, "the evaluator passed it and the tool API refused it");
    assert.equal(run.calls.told.length, 0, "the not-met after it is the first of a new streak, not the third");
  });

  test("a passed merge check-in breaks a not-met streak, even inside one turn", async () => {
    let judged = 0;
    const run = await runGoals({
      status: "FIXING",
      // Not a verdict after the park's, so later stops are let through and
      // the only hand-off that could happen is the one under test.
      judge: (body) =>
        ++judged > 4
          ? verdict("unparseable", "x")
          : sections(body).gate.includes("Before asking a person to merge")
            ? verdict("met", "Approved and green.")
            : verdict("not_met", "Wait for the merge."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
        // The check-in passes, then the park in the same batch is refused:
        // one not-met after a pass, not the third of a streak.
        fauxAssistantMessage([
          fauxToolCall("message_boss", { message: "Please merge omni#2265." }),
          fauxToolCall("park", { waitingFor: "the merge" }),
        ]),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "q" })),
      ],
    });

    assert.deepEqual(
      run.calls.verdicts.slice(0, 4).map((v) => [v.gate, v.verdict]),
      [
        ["resolved", "not_met"],
        ["resolved", "not_met"],
        ["merge_check_in", "met"],
        ["resolved", "not_met"],
      ],
      "two refused stops, a passed check-in, then the refused park",
    );
    assert.ok(
      !run.calls.told.some((told) => /in a row/.test(told.text)),
      "no hand-off for a streak the passed check-in broke",
    );
    assert.equal(run.calls.park.length, 0);
  });

  test("an impossible merge check-in ends the run as well as parking it", async () => {
    const run = await runGoals({
      status: "FIXING",
      judge: () => verdict("impossible", "The fix needs a Stripe dashboard setting only a person can change."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("message_boss", { message: "Please merge omni#2265." })),
        fauxAssistantMessage(fauxToolCall("report_resolved", { prUrls: [], evidence: "x" })),
      ],
    });

    assert.equal(run.agentRequests.length, 1, "nothing ran after the hand-off");
    assert.equal(run.calls.reportResolved, 0);
    assert.equal(run.calls.park.length, 1);
    assert.equal(run.calls.told.filter((told) => told.kind === "message").length, 0);
  });

  test("refused parks are not progress, so three of them hand off", async () => {
    const run = await runGoals({
      judge: () => verdict("not_met", "Nothing is waiting on a person."),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("park", { waitingFor: "a" })),
        fauxAssistantMessage(fauxToolCall("park", { waitingFor: "b" })),
        fauxAssistantMessage(fauxToolCall("park", { waitingFor: "c" })),
        fauxAssistantMessage(fauxToolCall("run_query", { query: "never" })),
      ],
    });

    assert.equal(run.agentRequests.length, 3);
    assert.equal(run.calls.told.length, 1);
    assert.match(run.calls.told[0].text, /3 times in a row/);
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

test("a stage whose marker cannot be written is anchored at the branch's newest entry", async () => {
  const branch: { type: string; id: string; customType?: string; data?: unknown; message?: { role?: string } }[] = [];
  // Shaped like Pi's: every branch entry projects, custom ones with no messages.
  const said: Record<string, string> = { e1: "investigation evidence", e2: "the gate call", e3: "fixing work" };
  const projection = () => {
    const entries = branch.map((entry) => ({
      sourceEntry: entry,
      messages: said[entry.id] ? [{ role: "user", content: said[entry.id], timestamp: 0 }] : [],
    }));
    return { entries, messages: entries.flatMap((entry) => entry.messages) };
  };
  let failWrites = false;
  const session = {
    getBranch: () => branch,
    buildSessionProjection: projection,
    appendCustomEntry: (customType: string, data?: unknown) => {
      if (failWrites) throw new Error("disk full");
      const id = `c${branch.length}`;
      branch.push({ type: "custom", id, customType, data });
      return id;
    },
  };
  const seen: string[][] = [];
  const goals = createStageGoals({
    evaluate: async (input) => {
      seen.push(input.transcript.map((message) => String(message.content)));
      return { judgement: "met", reason: "ok", usage: null };
    },
    context: async () => ({
      incident: { id: "1", status: "INVESTIGATING", rootCause: null, usersImpacted: null, impactQuery: null, prUrls: [], resolvedEvidence: null },
      signals: [],
      timeline: [],
    }),
    recordVerdict: async () => {},
    tellBoss: async () => {},
    park: async () => ({ ok: true, directives: [] }),
    pendingQuestion: async () => null,
    session: () => session,
    toMessages: (messages) => messages as never,
    abort: async () => {},
    wrappingUp: () => false,
    log: () => {},
    alarm: () => {},
  });
  const handlers: Record<string, (event: unknown) => Promise<unknown>> = {};
  goals.extension({ on: (name: string, handler: (event: unknown) => Promise<unknown>) => (handlers[name] = handler) } as never);

  goals.start({ incident: { status: "INVESTIGATING" } as GoalContext["incident"], timeline: [] });
  branch.push({ type: "message", id: "e1" }, { type: "message", id: "e2" });
  await goals.gate("root_cause", "attempt", async () => ({ ok: true, directives: [] }));
  failWrites = true;
  await handlers.turn_end({ message: { content: [] } });
  branch.push({ type: "message", id: "e3" });
  await goals.gate("resolved", "attempt", async () => ({ ok: true, directives: [] }));

  assert.deepEqual(seen[1], ["fixing work"], "only the new stage, not the investigation and not the whole session");
});

test("the closing goal rejects undone work on this incident, not practice-level prevention", () => {
  assert.match(GOALS.analysis, /no follow-up work on this incident/);
  assert.match(GOALS.analysis, /development practice in general .* are wanted, not follow-up work/);
  assert.match(GOALS.resolved, /follow-up work on this incident is complete/);
});

test("the stage comes from the status, and FIXING splits at the merge", () => {
  assert.equal(stageFor("INVESTIGATING", []), "investigating");
  assert.equal(stageFor("FIXING", []), "fixing");
  assert.equal(stageFor("FIXING", [MERGED]), "verifying");
  assert.equal(stageFor("RESOLVED", []), "closing");
  assert.equal(stageFor("CLOSED", []), null);
});

test("stage turns are configurable, and a bad value keeps the defaults", () => {
  assert.deepEqual(parseStageTurns("10,20,30,40"), { investigating: 10, fixing: 20, verifying: 30, closing: 40 });
  const logs: string[] = [];
  assert.deepEqual(parseStageTurns("10,20", (event) => logs.push(event)), {
    investigating: 60,
    fixing: 60,
    verifying: 40,
    closing: 20,
  });
  assert.deepEqual(logs, ["stage_turns_unreadable"]);
});
