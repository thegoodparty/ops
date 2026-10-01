// Stage goals: the incident agent never decides it is done. A separate small
// model reads the goal for the gate in front of it and the transcript, and
// returns one of three verdicts with a short reason -- the pattern Claude
// Code's /goal uses.
//
//   met         the gate passes and the transition happens
//   not met     the agent keeps working, with the reason as its next instruction
//   impossible  the Boss is told why, and the incident waits on a person
//
// It runs at each gate tool, before a person is asked to merge, and whenever
// the agent tries to stop: ends its run with no tool call, or parks. The
// evaluator has no tools, so every goal is phrased as evidence the
// transcript must show, and the agent is told to surface it.
//
// Why: incident 94 reported an alert-shaped root cause (the alert explained,
// the people it hurt not), and incident 80 closed with its prevention listed
// as follow-up work nobody owned. Both passed gates that checked arguments,
// not outcomes.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

import { ModelRequestFailed, type ModelClient, type ModelUsage } from "../model";
import { GOAL_VERDICT_KIND } from "../types";
import type { GoalContext, IncidentStatus, TimelineEvent, ToolResponse } from "../types";
import { renderTimeline } from "./compaction";
import { GOAL_VERDICT_ENTRY_TYPE } from "./session";

export type GoalStage = "investigating" | "fixing" | "verifying" | "closing";
export type StageGate = "root_cause" | "resolved" | "analysis";
export type Gate = StageGate | "merge_check_in";
export type Verdict = "met" | "not_met" | "impossible";
/** `not_applicable`: a check-in on a message that asks nobody to merge. `unjudged`: the evaluation failed. */
export type Judgement = Verdict | "not_applicable" | "unjudged";

export const STAGE_GATE: Record<GoalStage, StageGate> = {
  investigating: "root_cause",
  fixing: "resolved",
  verifying: "resolved",
  closing: "analysis",
};

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
    "- All follow-up work on this incident is complete: merged and deployed to prod.",
  ].join("\n"),
  analysis: [
    "- The post-mortem's timeline matches the recorded timeline events, with times, and its impact matches the reported impact.",
    "- The root cause explains every signal, the same bar as the root-cause gate.",
    "- The post-mortem leaves no follow-up work on this incident: anything still to do to stop this incident's harm recurring, or to repair who it hit, is done inside the incident or escalated to a person as a decision, and work on this incident listed as follow-up items fails this gate. Ideas for changing development practice in general (test patterns, review gates, alert design, architecture) are wanted, not follow-up work.",
  ].join("\n"),
};

/** Turns each stage gets before the Boss is told it has not met its goal. */
export const DEFAULT_STAGE_TURNS: Record<GoalStage, number> = {
  investigating: 60,
  fixing: 60,
  verifying: 40,
  closing: 20,
};

/** Consecutive not-met verdicts, with no work in between, before the Boss is told. */
export const NO_PROGRESS_LIMIT = 3;

/** The evaluator answers in a sentence or two; this is room for that and no more. */
export const EVALUATOR_MAX_TOKENS = 1024;

export const EVALUATOR_TIMEOUT_MS = 120_000;

/** Which stage an incident is in. FIXING splits at the merge, the way stage compaction does. */
export const stageFor = (
  status: IncidentStatus,
  timeline: Pick<TimelineEvent, "kind">[],
): GoalStage | null =>
  status === "INVESTIGATING"
    ? "investigating"
    : status === "FIXING"
      ? timeline.some((event) => event.kind === "fix_merged")
        ? "verifying"
        : "fixing"
      : status === "RESOLVED"
        ? "closing"
        : null;

/**
 * `BUGBOSS_STAGE_TURNS`: four numbers for investigating, fixing, verifying and
 * closing, e.g. `60,60,40,20`. A malformed value keeps the defaults and says
 * so; killing an agent on a production incident over a tuning knob is the
 * wrong trade.
 */
export const parseStageTurns = (
  raw: string | undefined,
  log: (event: string, fields: Record<string, unknown>) => void = () => {},
): Record<GoalStage, number> => {
  if (!raw) return DEFAULT_STAGE_TURNS;
  const numbers = raw.split(",").map((part) => Number(part.trim()));
  if (numbers.length !== 4 || numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
    log("stage_turns_unreadable", { raw, using: DEFAULT_STAGE_TURNS });
    return DEFAULT_STAGE_TURNS;
  }
  const [investigating, fixing, verifying, closing] = numbers;
  return { investigating, fixing, verifying, closing };
};

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

const STOP_SYSTEM_EXTRA = [
  "",
  "The agent is trying to stop, not calling the gate. met: the goal is met, and the agent should record it at the gate. not_met: it should keep working, and your reason says what to do next. impossible: it cannot go on without a person, and your reason says what they must do.",
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
 * transcript is one stage, which stage compaction keeps small, and when a
 * stage still outgrows the evaluator's window the oldest messages are left
 * out whole and the evaluator is told how many. The gate's own arguments and
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
    stopping: boolean;
    context: GoalContext;
    transcript: Message[];
  }): Promise<Evaluation> => {
    const maxTokens = deps.maxTokens ?? EVALUATOR_MAX_TOKENS;
    const system = `${EVALUATOR_SYSTEM}${input.gate === "merge_check_in" ? CHECK_IN_SYSTEM_EXTRA : ""}${input.stopping ? STOP_SYSTEM_EXTRA : ""}`;
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
      "# The agent's conversation in this stage",
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
        ? [`(${left} earlier messages of this stage are not shown, for size. Judge what is shown; the agent can restate evidence in its gate call.)`]
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
// Stage state, the gates and the stop hook
// ---------------------------------------------------------------------------

/** Marks where a stage began, or where a person restarted its turn count. */
export const GOAL_STAGE_ENTRY_TYPE = "bugboss_goal_stage";

/** What the steered not-met message is filed under in the session. */
export const GOAL_MESSAGE_TYPE = "bugboss_goal";

interface Entry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
}

interface ProjectedEntry {
  sourceEntry: { id: string };
  messages: unknown[];
}

/** The parts of Pi's session manager this reads and writes. */
export interface GoalSession {
  getBranch(): Entry[];
  buildSessionProjection(): { entries: ProjectedEntry[]; messages: unknown[] };
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface StageGoalsDeps {
  evaluate: GoalEvaluator;
  /** The non-draining read. */
  context: () => Promise<GoalContext>;
  recordVerdict: (verdict: { gate: Gate; verdict: Judgement; reason: string }) => Promise<unknown>;
  tellBoss: (text: string) => Promise<void>;
  park: (args: { waitingFor: string; liftsOnReply: boolean }) => Promise<ToolResponse>;
  /** A question to the Boss still outstanding: the agent is waiting on a person. */
  pendingQuestion: () => Promise<{ message: string } | null>;
  session: () => GoalSession | null;
  /** Pi's message conversion, so the evaluator reads what the agent's model reads. */
  toMessages: (messages: unknown[]) => Message[];
  /** Stops the run after a hand-off that happened between turns. */
  abort: () => Promise<void>;
  /** The deadline or the overall turn budget has asked for the brief already. */
  wrappingUp: () => boolean;
  bounds?: Record<GoalStage, number>;
  noProgressLimit?: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  alarm: (event: string, fields: Record<string, unknown>) => void;
}

export interface GateResult {
  response: ToolResponse;
  /** The incident was handed to the Boss and parked: end the run on this result. */
  stop: boolean;
}

export type StopDecision =
  | { kind: "allow" }
  | { kind: "continue"; text: string }
  | { kind: "stopped"; text: string };

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

const GATE_TOOLS = new Set(Object.values(GATE_TOOL));

export const createStageGoals = (deps: StageGoalsDeps) => {
  const bounds = deps.bounds ?? DEFAULT_STAGE_TURNS;
  const noProgressLimit = deps.noProgressLimit ?? NO_PROGRESS_LIMIT;
  let stage: GoalStage | null = null;
  let stageEntryId: string | null = null;
  let stageTurns = 0;
  let noProgress = 0;
  let lastReason: string | null = null;
  let checkedIn = false;
  let handedOff = false;
  let parked = false;
  // Tool calls this turn that the goals refused. A refused park or merge ask
  // is not work, so it must not reset the no-progress count.
  let refusedThisTurn = 0;
  let next: { stage: GoalStage | null } | null = null;

  /** The stage's span of the agent's context: the latest summary, then everything since the stage began. */
  const transcript = (): Message[] => {
    const session = deps.session();
    if (!session) return [];
    const projection = session.buildSessionProjection();
    const at = stageEntryId
      ? projection.entries.findIndex((entry) => entry.sourceEntry.id === stageEntryId)
      : -1;
    const isSummary = (message: unknown) =>
      (message as { role?: string }).role === "compactionSummary";
    const summary = projection.messages.filter(isSummary).at(-1);
    const since = (at >= 0 ? projection.entries.slice(at + 1) : projection.entries)
      .flatMap((entry) => entry.messages)
      .filter((message) => !isSummary(message));
    return deps.toMessages(summary ? [summary, ...since] : since);
  };

  const judge = async (gate: Gate, goal: string, attempt: string, stopping: boolean): Promise<Evaluation> => {
    let context: GoalContext;
    try {
      context = await deps.context();
    } catch (err: unknown) {
      const evaluation: Evaluation = {
        judgement: "unjudged",
        reason: `the incident record could not be read: ${String(err)}`,
        usage: null,
      };
      deps.alarm("goal_unjudged", { gate, stage, reason: evaluation.reason });
      return evaluation;
    }
    const evaluation = await deps.evaluate({ gate, goal, attempt, stopping, context, transcript: transcript() });
    try {
      deps.session()?.appendCustomEntry(GOAL_VERDICT_ENTRY_TYPE, {
        gate,
        stage,
        verdict: evaluation.judgement,
        reason: evaluation.reason,
        stopping,
        usage: usageEntry(evaluation.usage),
      });
    } catch (err: unknown) {
      deps.alarm("goal_verdict_unrecorded", { gate, error: String(err) });
    }
    deps.log("goal_verdict", { gate, stage, stopping, verdict: evaluation.judgement, reason: evaluation.reason });
    if (evaluation.judgement === "unjudged") {
      // Open, not closed: an evaluator that is down must not hold every
      // incident at its gate. Loud, because a gate that passes unjudged is
      // the old behaviour wearing the new one's name.
      deps.alarm("goal_unjudged", { gate, stage, reason: evaluation.reason });
    }
    if (evaluation.judgement !== "not_applicable") {
      if (evaluation.judgement === "not_met") lastReason = evaluation.reason;
      try {
        await deps.recordVerdict({ gate, verdict: evaluation.judgement, reason: evaluation.reason });
      } catch (err: unknown) {
        deps.alarm("goal_verdict_timeline_failed", { gate, error: String(err) });
      }
    }
    return evaluation;
  };

  /** Tell the Boss, park until a person answers, and restart the stage's count for when they do. */
  const handOff = async (text: string): Promise<void> => {
    handedOff = true;
    try {
      await deps.tellBoss(text);
    } catch (err: unknown) {
      deps.alarm("goal_escalation_failed", { stage, error: String(err) });
    }
    try {
      const response = await deps.park({
        waitingFor: `a person to read the escalation about the ${stage ?? "current"} stage`,
        liftsOnReply: true,
      });
      if (!response.ok) deps.alarm("goal_park_refused", { stage, error: response.error });
      else parked = true;
    } catch (err: unknown) {
      deps.alarm("goal_park_failed", { stage, error: String(err) });
    }
    try {
      deps.session()?.appendCustomEntry(GOAL_STAGE_ENTRY_TYPE, { stage, restart: true });
    } catch (err: unknown) {
      deps.alarm("goal_stage_unrecorded", { stage, error: String(err) });
    }
  };

  const goalFooter = (gate: Gate): string => `The goal (${GATE_TITLE[gate]}):\n${GOALS[gate]}`;

  const handOffText = (why: string, gate: Gate): string =>
    [
      why,
      "",
      goalFooter(gate),
      "",
      "I have parked. A message from you restarts me, with a fresh turn allowance for this stage.",
    ].join("\n");

  const noProgressText = (gate: Gate): string =>
    handOffText(
      `I have been judged short of my goal ${noProgress} times in a row at the ${stage} stage without doing any new work in between. The last reason: ${lastReason ?? "none recorded"}`,
      gate,
    );

  const notMet = (gate: Gate, reason: string, again: string): string =>
    [`NOT MET, nothing changed: ${reason}`, "", goalFooter(gate), "", again].join("\n");

  return {
    stage: () => stage,
    parked: () => parked,
    handedOff: () => handedOff,

    /** At launch: the stage from the incident's status, and its turns from the session. */
    start: (context: Pick<GoalContext, "incident" | "timeline">): void => {
      stage = stageFor(context.incident.status, context.timeline);
      const session = deps.session();
      if (!session || !stage) return;
      const branch = session.getBranch();
      let at = -1;
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const entry = branch[i];
        if (entry.type === "custom" && entry.customType === GOAL_STAGE_ENTRY_TYPE) {
          at = i;
          break;
        }
      }
      const recorded = at >= 0 ? (branch[at].data as { stage?: GoalStage | null }).stage : undefined;
      if (at < 0 || recorded !== stage) {
        // A running incident from before stage goals, or a stage the Boss
        // moved. Its turns count from now, which is generous and is the
        // only reading of an unrecorded start that does not punish it.
        stageEntryId = session.appendCustomEntry(GOAL_STAGE_ENTRY_TYPE, { stage });
        stageTurns = 0;
        return;
      }
      stageEntryId = branch[at].id;
      stageTurns = branch
        .slice(at + 1)
        .filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length;
      checkedIn = branch
        .slice(at + 1)
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === GOAL_VERDICT_ENTRY_TYPE &&
            (entry.data as { gate?: string; verdict?: string }).gate === "merge_check_in" &&
            (entry.data as { verdict?: string }).verdict === "met",
        );
    },

    /**
     * Runs a gate tool's transition only on a met verdict. The transition
     * itself is the same call as before, so the tool API's own guards still
     * hold; this sits in front of them.
     */
    gate: async (
      gate: StageGate,
      attempt: string,
      run: () => Promise<ToolResponse>,
    ): Promise<GateResult> => {
      const evaluation = await judge(gate, GOALS[gate], attempt, false);
      if (evaluation.judgement === "not_met") {
        noProgress += 1;
        if (noProgress >= noProgressLimit) {
          const text = noProgressText(gate);
          await handOff(text);
          return { response: { ok: false, error: `not met, and handed to the Boss: ${text}`, directives: [] }, stop: true };
        }
        return {
          response: {
            ok: false,
            error: notMet(gate, evaluation.reason, `Keep working, surface the evidence, then call ${GATE_TOOL[gate]} again.`),
            directives: [],
          },
          stop: false,
        };
      }
      if (evaluation.judgement === "impossible") {
        const text = handOffText(`The ${gate} goal was judged impossible for me to meet: ${evaluation.reason}`, gate);
        await handOff(text);
        return { response: { ok: false, error: `impossible, and handed to the Boss: ${evaluation.reason}`, directives: [] }, stop: true };
      }
      // The evaluator passed it, so this attempt was progress even if the
      // tool API then refused it for its own reasons.
      noProgress = 0;
      const response = await run();
      if (response.ok) {
        next = { stage: gate === "root_cause" ? "fixing" : gate === "resolved" ? "closing" : null };
      }
      return { response, stop: false };
    },

    /** A fix merging moves fixing on to verifying. */
    merged: (): void => {
      if (stage === "fixing") next = { stage: "verifying" };
    },

    /**
     * The check before a person is asked to merge. Null when the ask may go
     * out; otherwise what the tool returns instead of sending it.
     */
    checkIn: async (
      ask: string,
      options: { known?: boolean } = {},
    ): Promise<{ text: string; stop: boolean } | null> => {
      if (options.known && checkedIn) return null;
      const evaluation = await judge("merge_check_in", GOALS.merge_check_in, ask, false);
      if (evaluation.judgement === "met") {
        checkedIn = true;
        noProgress = 0;
        return null;
      }
      if (evaluation.judgement === "not_met") {
        refusedThisTurn += 1;
        noProgress += 1;
        if (noProgress >= noProgressLimit) {
          const text = noProgressText("merge_check_in");
          await handOff(text);
          return { text: `Handed to the Boss and parked: ${text}`, stop: true };
        }
        return {
          text: notMet(
            "merge_check_in",
            evaluation.reason,
            "The ask was not sent. Keep working, surface the evidence, then ask again.",
          ),
          stop: false,
        };
      }
      if (evaluation.judgement === "impossible") {
        await handOff(handOffText(`I cannot get this ready to merge: ${evaluation.reason}`, "merge_check_in"));
        return { text: `Handed to the Boss and parked: ${evaluation.reason}`, stop: true };
      }
      // Unjudged or not a merge ask: the message goes out, which is work, and
      // a tool later in the same turn must not count against a stale streak.
      noProgress = 0;
      return null;
    },

    /**
     * An attempt to stop: a park, or a run ending with no tool call. Judged
     * against the stage's goal. A pending question to the Boss defers it: the
     * agent is waiting on a person, as an active wait defers /goal.
     */
    stopAttempt: async (attempt: string, options: { fromTool?: boolean } = {}): Promise<StopDecision> => {
      if (!stage || handedOff || parked || deps.wrappingUp()) return { kind: "allow" };
      try {
        if (await deps.pendingQuestion()) return { kind: "allow" };
      } catch (err: unknown) {
        deps.log("goal_pending_question_unreadable", { error: String(err) });
      }
      const gate = STAGE_GATE[stage];
      const evaluation = await judge(gate, GOALS[gate], attempt, true);
      if (evaluation.judgement === "unjudged") return { kind: "allow" };
      if (evaluation.judgement === "impossible") {
        const text = handOffText(`I cannot go on at the ${stage} stage without a person: ${evaluation.reason}`, gate);
        await handOff(text);
        return { kind: "stopped", text: `Handed to the Boss and parked: ${evaluation.reason}` };
      }
      if (options.fromTool) refusedThisTurn += 1;
      // Only a not-met counts. A met stop is told to record it at the gate,
      // and handing it off would tell the Boss it fell short when it did not.
      if (evaluation.judgement === "not_met") {
        noProgress += 1;
        if (noProgress >= noProgressLimit) {
          const text = noProgressText(gate);
          await handOff(text);
          return { kind: "stopped", text: `Handed to the Boss and parked: ${text}` };
        }
      }
      return {
        kind: "continue",
        text:
          evaluation.judgement === "met"
            ? `Do not stop yet. Your goal for this stage is judged met: record it with ${GATE_TOOL[gate]}. ${evaluation.reason}`
            : `Do not stop yet: the goal for this stage is not met. ${evaluation.reason}\n\n${goalFooter(gate)}`,
      };
    },

    /** The park tool succeeded: the agent is waiting on a person. */
    markParked: (): void => {
      parked = true;
    },

    /**
     * At launch, before any model call: a stage whose allowance was spent by
     * a launch that died before it could hand off. Same reason as
     * `promptWithinBudget`: the first turn of a relaunch rewrites the whole
     * cache, and there is nothing it could do with it.
     */
    stopIfSpent: async (): Promise<boolean> => {
      if (!stage || stageTurns < bounds[stage]) return false;
      await handOff(
        handOffText(
          `The ${stage} stage has used ${stageTurns} of its ${bounds[stage]} turns without meeting its goal. The last reason: ${lastReason ?? "no verdict yet"}`,
          STAGE_GATE[stage],
        ),
      );
      return true;
    },

    extension: (pi: ExtensionAPI): void => {
      pi.on("turn_end", async (event) => {
        const calls = ((event.message as { content?: { type: string; name?: string }[] }).content ?? []).filter(
          (block) => block.type === "toolCall",
        );
        const work = calls.filter((call) => !GATE_TOOLS.has(call.name ?? "")).length;
        if (work > refusedThisTurn) noProgress = 0;
        refusedThisTurn = 0;

        if (next) {
          const moved = next.stage;
          next = null;
          stage = moved;
          stageTurns = 0;
          noProgress = 0;
          lastReason = null;
          checkedIn = false;
          try {
            stageEntryId = deps.session()?.appendCustomEntry(GOAL_STAGE_ENTRY_TYPE, { stage: moved }) ?? stageEntryId;
          } catch (err: unknown) {
            // The newest entry already on the branch marks the same boundary:
            // everything after it is this stage. Keeping the previous stage's
            // marker would hand the evaluator both stages, and none would hand
            // it the whole session.
            stageEntryId = deps.session()?.getBranch().at(-1)?.id ?? null;
            deps.alarm("goal_stage_unrecorded", { stage: moved, error: String(err) });
          }
          deps.log("goal_stage", { stage: moved });
          return;
        }
        if (!stage || handedOff) return;
        stageTurns += 1;
        if (stageTurns < bounds[stage] || deps.wrappingUp()) return;
        const gate = STAGE_GATE[stage];
        deps.log("goal_stage_bound", { stage, turns: stageTurns, bound: bounds[stage] });
        await handOff(
          handOffText(
            `The ${stage} stage has used its ${bounds[stage]} turns without meeting its goal. The last reason: ${lastReason ?? "no verdict yet"}`,
            gate,
          ),
        );
        // Not awaited: abort settles the run, and the run is waiting on this
        // handler.
        void deps.abort();
      });
    },
  };
};

export type StageGoals = ReturnType<typeof createStageGoals>;

/**
 * The stop hook. Pi fires `agent_before_settle` when a run is about to end
 * with nothing queued; returning `continue` with a message is how the reason
 * reaches the agent and the run goes on. Only a run that ended on a turn with
 * no tool call is a stop attempt: one a tool ended (a stop, a merge, a park)
 * has already been decided.
 */
export const goalStopExtension =
  (goals: Pick<StageGoals, "stopAttempt">) =>
  (pi: ExtensionAPI): void => {
    pi.on("agent_before_settle", async (event) => {
      if (event.outcome !== "completed") return undefined;
      const last = [...event.context.contextMessages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "assistant") as
        | { content?: { type: string; text?: string }[] }
        | undefined;
      if (!last || (last.content ?? []).some((block) => block.type === "toolCall")) return undefined;
      const said = (last.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
        .trim();
      const decision = await goals.stopAttempt(
        `The agent ended its run without calling a tool. Its last message: ${said || "(nothing)"}`,
      );
      if (decision.kind !== "continue") return undefined;
      return {
        entries: [{ type: "custom_message", customType: GOAL_MESSAGE_TYPE, content: decision.text, display: true }],
        continue: true,
      };
    });
  };
