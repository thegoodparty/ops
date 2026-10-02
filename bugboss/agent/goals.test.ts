import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ModelReply, ModelRequest, ModelUsage } from "../model";
import type { IncidentStatus, TimelineEvent, ToolResponse } from "../types";
import type { ContextView } from "./harness";
import { createGoalEvaluator, createStageGoals, GOALS, type Gate, type Verdict as Judged } from "./goals";

type Message = ContextView["messages"][number];
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

const USAGE: ModelUsage = {
  tokensIn: 1_200,
  tokensOut: 40,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0.0013,
  modelId: "haiku",
  calls: 1,
};

const toolResult = (text: string): Message =>
  ({
    role: "toolResult",
    toolCallId: "c",
    toolName: "run_query",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  }) as unknown as Message;

/**
 * The gates over a stand-in evaluator model, a function of the prompt it is
 * shown. Everything between the transcript and the verdict -- the prompt, the
 * parse, the verdict row, the escalation -- is the production code.
 */
const harness = (args: {
  status?: IncidentStatus;
  timeline?: TimelineEvent[];
  timelineFails?: boolean;
  escalationFails?: boolean;
  judge: (body: string) => Verdict;
}) => {
  const transcript: Message[] = [];
  const bodies: string[] = [];
  const told: { reason: string; brief: string }[] = [];
  const verdicts: { gate: Gate; verdict: Judged; reason: string }[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const evaluate = createGoalEvaluator({
    client: {
      complete: async (request: ModelRequest): Promise<ModelReply> => {
        const body = request.messages.map((message) => ("text" in message ? message.text : "")).join("\n");
        bodies.push(body);
        return { text: JSON.stringify(args.judge(body)), usage: USAGE } as unknown as ModelReply;
      },
    },
    contextWindow: 200_000,
  });
  const goals = createStageGoals({
    evaluate,
    context: async () => {
      if (args.timelineFails) return { context: null, error: "the timeline could not be read: down" };
      return {
        context: {
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
        },
      };
    },
    recordVerdict: async (verdict) => {
      verdicts.push(verdict);
    },
    escalate: async (reason, brief) => {
      if (args.escalationFails) throw new Error("inbox down");
      told.push({ reason, brief });
    },
    transcript: async () => [...transcript],
    log: (event, fields) => logs.push({ event, fields }),
    alarm: (event, fields) => logs.push({ event, fields }),
  });
  let transitions = 0;
  const run = async (): Promise<ToolResponse> => {
    transitions += 1;
    return { ok: true };
  };
  return {
    goals,
    run,
    transitions: () => transitions,
    surface: (text: string) => transcript.push(toolResult(text)),
    bodies,
    told,
    verdicts,
    logs,
  };
};

const verdict = (v: string, reason: string): Verdict => ({ verdict: v, reason });

/**
 * The parts of the evaluator's prompt a stand-in judges on. The goal text
 * itself quotes phrases like "Recommendation: approve", so a stand-in that
 * searched the whole prompt would be judging the goal, not the evidence.
 */
const sections = (body: string) => {
  const at = (heading: string) => body.indexOf(heading);
  return {
    attempt: body.slice(at("# What the agent is doing now"), at("# The incident record")),
    transcript: body.slice(at("# The agent's conversation since its last compaction")),
  };
};

describe("stage goals", () => {
  test("incident 94: a root cause that explains only the alert is rejected, then accepted once user harm is shown", async () => {
    const alertShaped =
      "Peerly refused the draft for a bit.ly link and the refusal reached Stripe as a retryable gateway error instead of a permanent one -- that 502 is what paged.";
    const h = harness({
      judge: (body) =>
        sections(body).transcript.includes("charged $634.10")
          ? verdict("met", "The transcript shows candidates charged for sends that never went out, and the 502 is explained.")
          : verdict("not_met", "Nothing shows what happened to a user: who paid, and what did they get instead of the send?"),
    });

    const first = await h.goals.gate("root_cause", `The agent called report_root_cause with:\n${alertShaped}`, h.run);
    assert.equal(first.response.ok, false);
    assert.match(first.response.error ?? "", /NOT MET, nothing changed: Nothing shows what happened to a user/);
    assert.match(
      first.response.error ?? "",
      /comprehensive picture of what went wrong for an actual human user/,
      "the goal text comes back with the reason",
    );
    assert.equal(h.transitions(), 0);

    h.surface("3 candidates were charged $634.10 for P2P text sends Peerly refused after payment; none were sent.");
    const second = await h.goals.gate("root_cause", "The agent called report_root_cause with: a charge before sendability", h.run);
    assert.equal(second.response.ok, true);
    assert.equal(h.transitions(), 1, "the transition ran once, on the met verdict");
    assert.deepEqual(
      h.verdicts.map((v) => v.verdict),
      ["not_met", "met"],
      "every verdict is recorded",
    );
    assert.match(h.bodies[0], /POST \/v1\/payments\/events returned 5xx/, "the evaluator sees the signals");
    assert.match(h.bodies[0], /that 502 is what paged/, "and the claim it is judging, whole");
  });

  test("resolved is rejected until the deploy, the replay, the repairs and the follow-ups are all shown", async () => {
    const evidence = [
      ["release run 1187 succeeded on merge commit 4f2a", "No release run is shown succeeding for the merge commit of omni#2265."],
      ["Replay against deployed sha 4f2a", "No replay of the impacted users' path against the deployed commit."],
      ["Refunded 3 charges in Stripe", "The 3 charged candidates are not shown refunded."],
      ["release run 1188 succeeded on omni#2270", "Follow-up omni#2270 is not shown merged and deployed."],
    ];
    const h = harness({
      status: "FIXING",
      timeline: [MERGED],
      judge: (body) => {
        const missing = evidence.find(([shown]) => !sections(body).transcript.includes(shown));
        return missing
          ? verdict("not_met", missing[1])
          : verdict("met", "Deploy, replay, repairs and follow-up all shown.");
      },
    });

    const first = await h.goals.gate("resolved", "the alert has been quiet for an hour", h.run);
    assert.ok(first.response.error?.includes(evidence[0][1]));
    for (const [i, [shown]] of evidence.entries()) {
      h.surface(shown);
      const next = await h.goals.gate("resolved", `shown: ${shown}`, h.run);
      if (i < evidence.length - 1) assert.ok(next.response.error?.includes(evidence[i + 1][1]), `refused for: ${evidence[i + 1][1]}`);
    }
    assert.equal(h.transitions(), 1, "only the last attempt ran the transition");
    assert.deepEqual(h.verdicts.map((v) => v.verdict), ["not_met", "not_met", "not_met", "not_met", "met"]);
    assert.match(h.bodies[0], /omni#2265 merged/, "the recorded timeline reaches the evaluator");
  });

  test("closing is rejected while the post-mortem lists follow-up work on this incident, and accepts practice-level prevention", async () => {
    const h = harness({
      status: "RESOLVED",
      judge: (body) =>
        sections(body).attempt.includes("Follow-up:")
          ? verdict("not_met", "A resolution action is follow-up work on this incident; ship it or escalate it as a decision.")
          : verdict("met", "Timeline, impact and cause match; no follow-up work on this incident."),
    });
    const refused = await h.goals.gate("analysis", "resolutionActions: Refunded; Follow-up: add the pre-payment gate", h.run);
    assert.match(refused.response.error ?? "", /follow-up work on this incident; ship it/);
    const accepted = await h.goals.gate(
      "analysis",
      "resolutionActions: Shipped the pre-payment gate. practiceChanges: a test pattern for every paid flow",
      h.run,
    );
    assert.equal(accepted.response.ok, true);
    assert.equal(h.transitions(), 1);
    assert.match(h.bodies[1], /test pattern for every paid flow/, "practice-level prevention reaches the evaluator and passes");
  });

  test("the merge check-in holds the ask while delegate's last verdict is not approve", async () => {
    const h = harness({
      status: "FIXING",
      judge: (body) =>
        sections(body).transcript.includes("APPROVED")
          ? verdict("met", "Approved on the head commit, CI green.")
          : verdict("not_met", "delegate-reviewer's last verdict on the head commit is request changes."),
    });
    h.surface("delegate-reviewer on 9c1e: request changes");
    const held = await h.goals.checkIn("Please get omni#2265 merged.");
    assert.match(held.blocked ?? "", /NOT MET.*request changes/s);
    assert.match(held.blocked ?? "", /The ask was not sent/);
    h.surface("delegate-reviewer on 3b7d: APPROVED; checks green");
    const sent = await h.goals.checkIn("Please get omni#2265 merged.");
    assert.equal(sent.blocked, null);
    assert.deepEqual(
      h.verdicts.filter((v) => v.gate === "merge_check_in").map((v) => v.verdict),
      ["not_met", "met"],
    );
  });

  test("a message that asks nobody to merge goes out, and records no verdict", async () => {
    const h = harness({ status: "FIXING", judge: () => verdict("not_applicable", "A status update, not a merge ask.") });
    const result = await h.goals.checkIn("Root cause found; writing the fix now.");
    assert.equal(h.bodies.length, 1, "premise: the evaluator was asked");
    assert.equal(result.blocked, null);
    assert.equal(h.verdicts.length, 0);
  });

  test("not_applicable on a stage gate is an outage, not a pass with a verdict", async () => {
    const h = harness({ judge: () => verdict("not_applicable", "?") });
    const result = await h.goals.gate("root_cause", "x", h.run);
    assert.equal(result.response.ok, true, "fails open");
    assert.ok(h.logs.some((log) => log.event === "goal_unjudged"));
    assert.equal(h.verdicts.length, 0);
  });

  test("an evaluator that fails on a merge check-in lets the ask out, with an alarm", async () => {
    const h = harness({ status: "FIXING", judge: () => ({ verdict: "maybe", reason: "" }) });
    const result = await h.goals.checkIn("Please get omni#2265 merged.");
    assert.equal(result.blocked, null, "the ask goes out");
    assert.ok(h.logs.some((log) => log.event === "goal_unjudged"));
    assert.equal(h.verdicts.length, 0);
  });

  test("impossible escalates through escalate, and the agent keeps working", async () => {
    const h = harness({
      judge: () => verdict("impossible", "Only Stripe support can say which charges were refunded; a person has to ask them."),
    });
    const result = await h.goals.gate("root_cause", "x", h.run);
    assert.equal(h.transitions(), 0, "the transition did not run");
    assert.equal(h.told.length, 1);
    assert.match(h.told[0].reason, /Only Stripe support can say/);
    assert.match(result.response.error ?? "", /IMPOSSIBLE, nothing changed: Only Stripe support.*The Boss has it as an escalation/s);
    assert.deepEqual(h.verdicts.map((v) => v.verdict), ["impossible"]);
  });

  test("an impossible verdict whose escalation fails tells the agent to escalate itself, with an alarm", async () => {
    const h = harness({ escalationFails: true, judge: () => verdict("impossible", "Only a person can decide this.") });
    const result = await h.goals.gate("root_cause", "x", h.run);
    assert.equal(h.transitions(), 0);
    assert.match(result.response.error ?? "", /The escalation to the Boss failed; call escalate yourself/);
    assert.ok(h.logs.some((log) => log.event === "goal_escalation_failed"));
  });

  test("an impossible merge check-in escalates and holds the ask", async () => {
    const h = harness({
      status: "FIXING",
      judge: () => verdict("impossible", "The fix needs a Stripe dashboard setting only a person can change."),
    });
    const result = await h.goals.checkIn("Please get omni#2265 merged.");
    assert.match(result.blocked ?? "", /^IMPOSSIBLE, the ask was not sent/);
    assert.equal(h.told.length, 1);
    assert.match(h.told[0].reason, /Stripe dashboard setting/);
    assert.deepEqual(h.verdicts.map((v) => [v.gate, v.verdict]), [["merge_check_in", "impossible"]]);
  });

  test("an incident that cannot be read passes the gate unjudged, with an alarm", async () => {
    const h = harness({ timelineFails: true, judge: () => verdict("not_met", "never asked") });
    const result = await h.goals.gate("root_cause", "x", h.run);
    assert.equal(h.bodies.length, 0, "premise: the evaluator was never asked");
    assert.equal(result.response.ok, true);
    assert.ok(h.logs.some((log) => log.event === "goal_unjudged"));
  });

  test("an evaluator that fails passes the gate, with an alarm", async () => {
    const h = harness({ judge: () => ({ verdict: "maybe", reason: "" }) });
    const result = await h.goals.gate("root_cause", "x", h.run);
    assert.equal(result.response.ok, true);
    assert.equal(h.transitions(), 1);
    assert.ok(h.logs.some((log) => log.event === "goal_unjudged"));
    assert.equal(h.verdicts.length, 0, "an outage is not a verdict on the timeline");
  });

  // The judged tool returns this as its result's usage, which is what puts
  // the evaluator's tokens on the incident's bill without a turn of its own.
  test("every judgement hands back the evaluator's spend as tool usage", async () => {
    const h = harness({ judge: () => verdict("not_met", "no") });
    const gated = await h.goals.gate("root_cause", "x", h.run);
    const checked = await h.goals.checkIn("merge please");
    for (const usage of [gated.usage, checked.usage]) {
      assert.ok(usage);
      assert.equal(usage.input, USAGE.tokensIn);
      assert.equal(usage.output, USAGE.tokensOut);
      assert.equal(usage.totalTokens, USAGE.tokensIn + USAGE.tokensOut);
      assert.equal(usage.cost.total, USAGE.costUsd);
    }
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
