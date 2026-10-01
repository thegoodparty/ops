// Stage goals: the incident agent never decides a gate is passed. A separate small
// model reads the goal for the gate in front of it and the transcript, and
// returns one of three verdicts with a short reason -- the pattern Claude
// Code's /goal uses.
//
//   met         the gate passes and the transition happens
//   not met     the agent keeps working, with the reason as its next instruction
//   impossible  the Boss gets an escalation with the reason, and the agent keeps working
//
// It runs at each gate tool and before a person is asked to merge. The
// evaluator has no tools, so every goal is phrased as evidence the
// transcript must show, and the agent is told to surface it.
//
// Why: incident 94 reported an alert-shaped root cause (the alert explained,
// the people it hurt not), and incident 80 closed with its prevention listed
// as follow-up work nobody owned. Both passed gates that checked arguments,
// not outcomes.

import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

import { ModelRequestFailed, type ModelClient, type ModelUsage } from "../model";
import { GOAL_VERDICT_KIND } from "../types";
import type { GoalContext, ToolResponse } from "../types";
import { renderTimeline } from "./compaction";
import { GOAL_VERDICT_ENTRY_TYPE } from "./session";

export type StageGate = "root_cause" | "resolved" | "analysis";
export type Gate = StageGate | "merge_check_in";
export type Verdict = "met" | "not_met" | "impossible";
/** `not_applicable`: a check-in on a message that asks nobody to merge. `unjudged`: the evaluation failed. */
export type Judgement = Verdict | "not_applicable" | "unjudged";

export const GATE_TOOL: Record<StageGate, string> = {
  root_cause: "report_root_cause",
  resolved: "report_resolved",
  analysis: "report_analysis",
};

const GATE_TITLE: Record<Gate, string> = {
  root_cause: "Investigating -> fixing (report_root_cause)",
  merge_check_in: "Before asking a person to merge",
  resolved: "Fixing -> resolved (report_resolved)",
  analysis: "Resolved -> closed (report_analysis)",
};

export const GOALS: Record<Gate, string> = {
  root_cause: [
    "- The transcript shows a comprehensive picture of what went wrong for an actual human user, in human terms (\"their text send was refused after they were charged\"), and the impact is understood completely, even if it is still expanding. Or a query shows no user was affected, and what the gap is: a monitoring gap, a false page.",
    "- Every signal on the incident is explained by the root cause. A signal the cause does not explain is left out of explainedSignalIds, so it is split into its own incident; it is never claimed.",
  ].join("\n"),
  merge_check_in: [
    "- The diff changes the mechanism named in the root cause.",
    "- The transcript shows a test that fails without the change and passes with it: both runs' output.",
    "- gh output shows CI green and delegate-reviewer's last verdict \"Recommendation: approve\" on the head commit.",
    "- If the change quiets a signal, the transcript names what still detects the harm.",
  ].join("\n"),
  resolved: [
    "- Every proposed code change is merged and fully promoted to production: the transcript shows the release run for each merge commit succeeding, and any separate infra deploy.",
    "- With the deployed code, another user taking the same actions as the impacted users would not be harmed: shown by a test or a replay of the impacted users' path against the deployed commit, with its output.",
    "- Every user whose state needed repairing directly (a SQL migration, a manual Stripe refund) has been repaired, each shown in the transcript.",
    "- Any follow-up or prevention work for this incident has been fully completed (merged and deployed to prod). The post-mortem's \"Preventing similar issues: changes to how we build\" ideas are not work for this incident.",
  ].join("\n"),
  analysis: [
    "- The post-mortem's timeline matches the recorded timeline events, with times, and its impact matches the reported impact.",
    "- The root cause explains every signal, the same bar as the root-cause gate.",
    "- The post-mortem leaves no follow-up work on this incident: anything still to do to stop this incident's harm recurring, or to repair who it hit, is done inside the incident or escalated to a person as a decision, and work on this incident listed as follow-up items fails this gate. Ideas for changing development practice in general (test patterns, review gates, alert design, architecture) are wanted, not follow-up work.",
  ].join("\n"),
};

/** The evaluator answers in a sentence or two; this is room for that and no more. */
export const EVALUATOR_MAX_TOKENS = 1024;

export const EVALUATOR_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

const EVALUATOR_SYSTEM = [
  "You are the goal evaluator for BugBoss, which runs one AI agent per production incident. The agent works the incident through stages, and each stage ends at a gate. You decide whether the goal for the gate in front of it is met.",
  "",
  "You have no tools and cannot look anything up. Judge only what the incident record and the transcript below show. A claim with no tool output behind it is not evidence; evidence the agent did not surface does not exist for you.",
  "",
  "Answer with one JSON object and nothing else:",
  '{"verdict": "met" | "not_met" | "impossible", "reason": "..."}',
  "- met: every condition of the goal is shown.",
  "- not_met: at least one is not. The reason goes straight back to the agent as its next instruction, so name each condition that is not shown and the evidence that would show it. Short and specific.",
  "- impossible: the agent cannot meet the goal at all, for a reason the evidence shows, such as a decision or access only a person has. The reason goes to the person who must act.",
].join("\n");

const CHECK_IN_SYSTEM_EXTRA = [
  "",
  "This is the check before the agent asks a person to merge a pull request. If the message does not ask anybody to merge a pull request, answer {\"verdict\": \"not_applicable\", \"reason\": \"...\"}.",
].join("\n");

const VERDICT_SCHEMA = z.object({
  verdict: z.enum(["met", "not_met", "impossible", "not_applicable"]),
  reason: z.string().trim().min(1),
});

export interface Evaluation {
  judgement: Judgement;
  reason: string;
  usage: ModelUsage | null;
}

const textOf = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? `-> ${block.name} ${JSON.stringify(block.arguments)}`
              : "",
        )
        .filter((part) => part.length > 0)
        .join("\n");

/** One message as the evaluator reads it. Thinking is the agent's, not evidence, and is left out. */
export const renderMessage = (message: Message): string => {
  if (message.role === "toolResult") {
    return `[${message.toolName} result${message.isError ? ", error" : ""}]\n${textOf(message.content)}`;
  }
  return `[${message.role}]\n${textOf(message.content)}`;
};

const renderContext = (context: GoalContext): string => {
  const { incident } = context;
  const events = context.timeline.filter((event) => event.kind !== GOAL_VERDICT_KIND);
  const verdicts = context.timeline.filter((event) => event.kind === GOAL_VERDICT_KIND);
  return [
    `Incident ${incident.id}, status ${incident.status}.`,
    `Root cause: ${incident.rootCause ?? "(not reported)"}`,
    `Users impacted: ${incident.usersImpacted ?? "(not reported)"}${incident.impactQuery ? `, from: ${incident.impactQuery}` : ""}`,
    `Pull requests: ${incident.prUrls.length ? incident.prUrls.join(", ") : "(none)"}`,
    `Resolution evidence: ${incident.resolvedEvidence ?? "(not reported)"}`,
    "",
    "## Signals",
    ...context.signals.map((signal) => `- [${signal.id}] (${signal.kind}, ${signal.source}) ${signal.title}\n${signal.body}`),
    "",
    "## Recorded timeline",
    events.length ? renderTimeline(events) : "(nothing recorded)",
    ...(verdicts.length ? ["", "## Earlier verdicts", renderTimeline(verdicts)] : []),
  ].join("\n");
};

/**
 * The evaluator's call. Bounded by shaping, never by cutting text: the
 * transcript is the agent's context since its last compaction, which stage
 * compaction keeps small, and when it still outgrows the evaluator's window
 * the oldest messages are left out whole and the evaluator is told how many. The gate's own arguments and
 * the incident record always go in whole.
 */
export const createGoalEvaluator = (deps: {
  client: ModelClient;
  contextWindow: number;
  estimateTokens: (message: Message) => number;
  maxTokens?: number;
  timeoutMs?: number;
}) =>
  async (input: {
    gate: Gate;
    goal: string;
    attempt: string;
    context: GoalContext;
    transcript: Message[];
  }): Promise<Evaluation> => {
    const maxTokens = deps.maxTokens ?? EVALUATOR_MAX_TOKENS;
    const system = `${EVALUATOR_SYSTEM}${input.gate === "merge_check_in" ? CHECK_IN_SYSTEM_EXTRA : ""}`;
    const head = [
      `# The goal: ${GATE_TITLE[input.gate]}`,
      input.goal,
      "",
      "# What the agent is doing now",
      input.attempt,
      "",
      "# The incident record",
      renderContext(input.context),
      "",
      "# The agent's conversation since its last compaction",
    ].join("\n");

    // Pi's own estimate, chars over four, so the evaluator's window is
    // reckoned the way the agent's compaction reckons its own.
    const roughly = (text: string): number => Math.ceil(text.length / 4);
    let room = deps.contextWindow - maxTokens - roughly(system) - roughly(head) - 2_000;
    const kept: Message[] = [];
    for (let i = input.transcript.length - 1; i >= 0; i -= 1) {
      const cost = deps.estimateTokens(input.transcript[i]);
      if (cost > room) break;
      room -= cost;
      kept.unshift(input.transcript[i]);
    }
    const left = input.transcript.length - kept.length;
    const body = [
      head,
      ...(left > 0
        ? [`(${left} earlier messages are not shown, for size. Judge what is shown; the agent can restate evidence in its gate call.)`]
        : []),
      ...kept.map(renderMessage),
    ].join("\n\n");

    try {
      const reply = await deps.client.complete({
        system,
        messages: [{ role: "user", text: body }],
        tools: [],
        maxTokens,
        signal: AbortSignal.timeout(deps.timeoutMs ?? EVALUATOR_TIMEOUT_MS),
      });
      const start = reply.text.indexOf("{");
      const end = reply.text.lastIndexOf("}");
      const parsed =
        start >= 0 && end > start
          ? VERDICT_SCHEMA.safeParse(
              (() => {
                try {
                  return JSON.parse(reply.text.slice(start, end + 1)) as unknown;
                } catch {
                  return null;
                }
              })(),
            )
          : null;
      if (!parsed?.success) {
        return {
          judgement: "unjudged",
          reason: `the evaluator's answer was not a verdict: ${reply.text}`,
          usage: reply.usage,
        };
      }
      const judgement =
        parsed.data.verdict === "not_applicable" && input.gate !== "merge_check_in"
          ? "unjudged"
          : parsed.data.verdict;
      return { judgement, reason: parsed.data.reason, usage: reply.usage };
    } catch (err: unknown) {
      return {
        judgement: "unjudged",
        reason: `the evaluator failed: ${err instanceof Error ? err.message : String(err)}`,
        usage: err instanceof ModelRequestFailed ? err.usage : null,
      };
    }
  };

export type GoalEvaluator = ReturnType<typeof createGoalEvaluator>;

// ---------------------------------------------------------------------------
// The gates and the merge check-in
// ---------------------------------------------------------------------------

/** The parts of Pi's session manager this reads and writes. */
export interface GoalSession {
  buildSessionProjection(): { messages: unknown[] };
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface StageGoalsDeps {
  evaluate: GoalEvaluator;
  /** The non-draining read. */
  context: () => Promise<GoalContext>;
  recordVerdict: (verdict: { gate: Gate; verdict: Judgement; reason: string }) => Promise<unknown>;
  /** The escalate tool's own path to the Boss. */
  escalate: (reason: string, brief: string) => Promise<void>;
  session: () => GoalSession | null;
  /** Pi's message conversion, so the evaluator reads what the agent's model reads. */
  toMessages: (messages: unknown[]) => Message[];
  log: (event: string, fields: Record<string, unknown>) => void;
  alarm: (event: string, fields: Record<string, unknown>) => void;
}

const usageEntry = (usage: ModelUsage | null) =>
  usage
    ? {
        input: usage.tokensIn,
        output: usage.tokensOut,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: { total: usage.costUsd },
      }
    : undefined;

export const createStageGoals = (deps: StageGoalsDeps) => {
  /** The agent's context as its model sees it: the latest compaction summary and everything after. */
  const transcript = (): Message[] => {
    const session = deps.session();
    return session ? deps.toMessages(session.buildSessionProjection().messages) : [];
  };

  const judge = async (gate: Gate, attempt: string): Promise<Evaluation> => {
    let evaluation: Evaluation;
    try {
      evaluation = await deps.evaluate({
        gate,
        goal: GOALS[gate],
        attempt,
        context: await deps.context(),
        transcript: transcript(),
      });
    } catch (err: unknown) {
      evaluation = { judgement: "unjudged", reason: `the goal could not be judged: ${String(err)}`, usage: null };
    }
    try {
      deps.session()?.appendCustomEntry(GOAL_VERDICT_ENTRY_TYPE, {
        gate,
        verdict: evaluation.judgement,
        reason: evaluation.reason,
        usage: usageEntry(evaluation.usage),
      });
    } catch (err: unknown) {
      deps.alarm("goal_verdict_unrecorded", { gate, error: String(err) });
    }
    deps.log("goal_verdict", { gate, verdict: evaluation.judgement, reason: evaluation.reason });
    if (evaluation.judgement === "unjudged") {
      // Open, not closed: an evaluator that is down must not hold every
      // incident at its gate. Loud, because a gate that passes unjudged is
      // the old behaviour wearing the new one's name.
      deps.alarm("goal_unjudged", { gate, reason: evaluation.reason });
    }
    if (evaluation.judgement !== "not_applicable") {
      try {
        await deps.recordVerdict({ gate, verdict: evaluation.judgement, reason: evaluation.reason });
      } catch (err: unknown) {
        deps.alarm("goal_verdict_timeline_failed", { gate, error: String(err) });
      }
    }
    return evaluation;
  };

  const goalFooter = (gate: Gate): string => `The goal (${GATE_TITLE[gate]}):\n${GOALS[gate]}`;

  const escalate = async (gate: Gate, reason: string): Promise<string> => {
    try {
      await deps.escalate(`The ${gate} goal was judged impossible for me to meet: ${reason}`, goalFooter(gate));
      return "The Boss has it as an escalation.";
    } catch (err: unknown) {
      deps.alarm("goal_escalation_failed", { gate, error: String(err) });
      return "The escalation to the Boss failed; call escalate yourself.";
    }
  };

  return {
    /**
     * Runs a gate tool's transition only on a met verdict. The transition
     * itself is the same call as before, so the tool API's own guards still
     * hold; this sits in front of them.
     */
    gate: async (gate: StageGate, attempt: string, run: () => Promise<ToolResponse>): Promise<ToolResponse> => {
      const evaluation = await judge(gate, attempt);
      if (evaluation.judgement === "not_met") {
        return {
          ok: false,
          error: [
            `NOT MET, nothing changed: ${evaluation.reason}`,
            "",
            goalFooter(gate),
            "",
            `Keep working, surface the evidence, then call ${GATE_TOOL[gate]} again.`,
          ].join("\n"),
          directives: [],
        };
      }
      if (evaluation.judgement === "impossible") {
        const told = await escalate(gate, evaluation.reason);
        return {
          ok: false,
          error: `IMPOSSIBLE, nothing changed: ${evaluation.reason}\n\n${told} Keep working the incident while a person decides.`,
          directives: [],
        };
      }
      return run();
    },

    /**
     * The check before a person is asked to merge. Null when the message may
     * go out; otherwise what the tool returns instead of sending it.
     */
    checkIn: async (ask: string): Promise<string | null> => {
      const evaluation = await judge("merge_check_in", ask);
      if (evaluation.judgement === "not_met") {
        return [
          `NOT MET, nothing changed: ${evaluation.reason}`,
          "",
          goalFooter("merge_check_in"),
          "",
          "The ask was not sent. Keep working, surface the evidence, then ask again.",
        ].join("\n");
      }
      if (evaluation.judgement === "impossible") {
        const told = await escalate("merge_check_in", evaluation.reason);
        return `IMPOSSIBLE, the ask was not sent: ${evaluation.reason}\n\n${told}`;
      }
      return null;
    },
  };
};

export type StageGoals = ReturnType<typeof createStageGoals>;
