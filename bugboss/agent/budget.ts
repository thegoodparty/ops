// The incident agent's two bounds: turns across the whole incident, and the
// wall clock of one launch. The turn budget is enforced here, by a hook on
// every model response; the deadline is the dispatcher's, which steers with
// `deadlineMessage` and then aborts.

import type { Db } from "../db";
import type { ToolApi } from "../types";
import type {
  BugbossHarness,
  ConversationId,
  EntryRecord,
  UsageState,
} from "./harness";
import type { BossInboxPort } from "./tools";
import { makeAlarm, makeLog } from "../logging";

const log = makeLog("agent-budget");
const alarm = makeAlarm("agent-budget");

export const DEADLINE_GRACE_SECONDS = 180;

/**
 * Turns the **incident agent** may take on one incident, across every launch.
 *
 * Named for its agent, not for turns, because this codebase now has two turn
 * budgets and they are not the same number or the same behaviour.
 * `SLACK_AGENT_MAX_TURNS` (24, `slack/agent.ts`) bounds the Slack agent, which
 * answers a person waiting in a thread and whose right move on exhaustion is
 * to say it ran out of steps. This bounds the investigator the dispatcher
 * launches, which nobody is watching and whose right move is to hand off with
 * a brief. Conflating them would give one of the two the wrong ending.
 *
 * The wall clock does not bound work. `monitor` and `message_boss` each cost
 * one turn however long they block, so the first nine-hour incident spent
 * about eight of those hours inside a single turn waiting on a person -- 92
 * turns and $18.51 in total, against a 24-hour clock that would have let
 * fifteen agents do that at once. A turn is a model call, so it is the unit
 * that does not inflate while nobody is working.
 *
 * 300 rather than 92: high enough that no incident like the ones we have seen
 * touches it, low enough that a runaway stops. It was 200 until several real
 * investigations spent it mid-fix and parked, which is the measurement the
 * escalation's spend line exists to produce. It is a bound before a dollar
 * cap, not instead of one -- the escalation carries what the run spent so the
 * next number is measured rather than guessed.
 *
 * Raising it resumes incidents parked on the old number: the dispatcher lifts
 * a budget wait when the incident's used turns are now under it. See
 * `liftRaisedBudgets` in `dispatcher/index.ts`.
 *
 * Overridden by `BUGBOSS_MAX_TURNS`, which keeps the plain name because it is
 * the only turn budget that is settable from the environment.
 */
export const INCIDENT_AGENT_MAX_TURNS = 300;

/**
 * Turns held back from the budget for the hand-off, the way
 * `DEADLINE_GRACE_SECONDS` is held back from the wall clock.
 *
 * A run that dies on its budget having written nothing is the silent failure
 * this whole system is built against: the thread's last message stays true,
 * so the silence reads as patience. So the budget has the same two layers
 * the deadline does -- steer, then stop -- and the brief is written inside
 * the gap between them.
 */
export const TURN_BUDGET_GRACE_TURNS = 10;

/**
 * Named once, because two things key off it: the tool the agent calls, and
 * the turn budget watching for whether it called it. A literal in both
 * places is a rename away from a budget that silently stops noticing -- and
 * this tool has already been renamed once, from `hand_off`.
 */
export const ESCALATE_TOOL = "escalate";

export const deadlineMessage = (graceSeconds: number): string =>
  `Your wall-clock deadline has expired. Stop investigating. Within the next ${graceSeconds} seconds, call escalate with a brief: what you believe now, what you ruled out, what you were about to do, and any side effects. If you have no root cause, your brief must still propose a change to the alert rule or name the instrumentation that is missing.`;

/** What a conversation has spent, flattened for a brief and a log line. */
export interface TurnSpend {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  costUsd: number;
  /** The model that produced the most output, so the goal evaluator's cheaper model never names the row. */
  modelId: string | null;
}

export const spendOf = (usage: Readonly<UsageState>): TurnSpend => {
  const spend: TurnSpend = {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    costUsd: 0,
    modelId: null,
  };
  let most = -1;
  for (const [key, bucket] of Object.entries(usage.models)) {
    if (bucket.output > most) {
      most = bucket.output;
      spend.modelId = key.slice(key.indexOf("/") + 1);
    }
  }
  for (const bucket of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
    spend.tokensIn += bucket.input;
    spend.tokensOut += bucket.output;
    spend.cacheRead += bucket.cacheRead;
    spend.cacheWrite += bucket.cacheWrite;
    spend.cacheWrite1h += bucket.cacheWrite1h ?? 0;
    spend.costUsd += bucket.cost.total;
  }
  return spend;
};

export interface TurnBudgetState {
  used: number;
  max: number;
  /** The grace actually in force, after clamping. Not the constant. */
  graceTurns: number;
  /**
   * The agent called `escalate` itself, so the Boss already has its brief.
   * The harness must not send a second one. It must still park: announcing
   * is not stopping.
   */
  escalated: boolean;
  /** The budget was already spent before this launch's first response. */
  spentAtLaunch: boolean;
  usage: TurnSpend;
}

/**
 * Never more than half the budget, and never zero.
 *
 * `TURN_BUDGET_GRACE_TURNS` is a constant and the budget is settable, so the
 * two can be configured into nonsense: at `BUGBOSS_MAX_TURNS=10` the raw
 * subtraction puts the soft edge at turn 0, and the agent is told to wrap up
 * before it has done anything -- while the other nine turns sit there unused.
 * Anyone shrinking the budget to exercise this path is exactly who would hit
 * that, and the symptom looks like the agent is broken rather than like the
 * number is.
 *
 * Clamping the grace rather than raising the floor on the budget, because a
 * small budget is a legitimate thing to ask for and the honest reading of it
 * is "wrap up sooner", not "we will overrule you".
 */
export const graceTurnsFor = (maxTurns: number, graceTurns = TURN_BUDGET_GRACE_TURNS): number =>
  Math.max(1, Math.min(graceTurns, Math.floor(maxTurns / 2)));

const compactTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : String(n);

/**
 * What the model is told when the budget is nearly gone. Deliberately the
 * same shape as `deadlineMessage`: one bound, two layers, one instruction.
 */
export const turnBudgetMessage = (state: TurnBudgetState): string =>
  `You have used ${state.used} of the ${state.max} turns this incident gets, counted across every launch. Stop investigating. Spend what is left calling escalate with a brief: what you believe now, what you ruled out, what you were about to do, and any side effects. If you have no root cause, your brief must still propose a change to the alert rule or name the instrumentation that is missing. A restart does not give the turns back, so there is no later.`;

/**
 * The brief the harness writes when the model did not write one.
 *
 * It carries the tokens and a cost estimate because that is the point of
 * shipping a turn cap before a dollar cap: 300 turns has no known price yet,
 * and the only way anyone learns one is for the number to reach a person who
 * is already reading about this incident. Called an estimate here for the
 * same reason it is called one everywhere else -- it is arithmetic over
 * tokens against a price table that goes stale silently, not an invoice.
 */
export const turnBudgetBrief = (state: TurnBudgetState): string => {
  const { usage } = state;
  const tokens = usage.tokensIn + usage.tokensOut + usage.cacheRead + usage.cacheWrite;
  return [
    "This needs a person because I ran out of turns, not because I finished.",
    "",
    // Two cases, because one sentence cannot honestly cover both. A launch
    // that spent the budget got its grace and ignored it. A launch that
    // started already over -- the previous one died before its hand-off
    // landed -- never had a grace window at all, and `used` is already at `max` or past it.
    // One sentence quoting `max` produced "used all 200 turns" directly
    // above "201 turns on ...", which is the sort of thing that makes a
    // reader distrust the rest of the brief.
    state.spentAtLaunch
      ? `The ${state.max}-turn budget for this incident was already spent when this launch started, so I stopped before taking a turn rather than investigating on borrowed time. ${state.used} turns have gone into it across every launch.`
      : `I used all ${state.max} turns this incident gets, across every launch, and did not escalate in the ${state.graceTurns} I was asked to.`,
    "",
    "What it spent:",
    `${state.used} turns on ${usage.modelId ?? "an unrecorded model"} · ${compactTokens(tokens)} tokens (${usage.tokensIn} in, ${usage.tokensOut} out, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write)`,
    usage.costUsd > 0
      ? `Estimated cost $${usage.costUsd.toFixed(2)}, derived from those tokens at the prices we held while it ran. An estimate, not an invoiced figure.`
      : "No cost estimate: the provider reported no prices for this run.",
    "",
    "Where it stands:",
    "What I believe now: whatever I last reported on this incident.",
    "What I ruled out: not recorded; this brief is the harness's, not mine.",
    state.spentAtLaunch
      ? "What I was about to do: nothing yet on this launch; the budget was gone before it started."
      : "What I was about to do: unknown. I was still working when the budget ran out.",
    "Side effects: check the incident for PRs I opened.",
    "",
    // Deliberately not "message me and I will carry on". A budget wait is not
    // lifted by a reply -- a reply says a person has answered, which is
    // nothing to do with having run out of turns. So the two things named
    // here are the two that actually move it, and both happen outside the
    // thread.
    `The ${state.max}-turn budget for this incident is spent, so neither a reply in the thread nor a message to me will restart it. To continue the work, somebody has to raise the turn budget, which resumes it on the next deploy, or pick it up themselves.`,
  ].join("\n");
};

/**
 * Whether the harness should announce this exhaustion, or only park.
 *
 * One reason to stay quiet: the agent escalated itself inside the grace.
 * The steer asks for exactly that, and it can land in the same round the cap
 * fires on, so sending both puts "it never wrote a brief" directly under the
 * brief it just wrote.
 *
 * Nothing else suppresses it. A launch that began already over budget is
 * stopped before its first request by the dispatcher, and no reply wakes a
 * budget wait (`turnBudgetPark`), so there is no wake left to suppress.
 * Parking is not conditional on any of this. Announcing is what a person
 * sees; parking is what makes the relaunch stop.
 */
export const shouldAnnounceExhaustion = (state: TurnBudgetState): boolean =>
  !state.escalated;

/**
 * How an exhausted run parks, as a value so the one argument that matters
 * cannot be dropped without a test noticing.
 *
 * `liftsOnReply: false` is the whole point and it is not the default. A
 * Boss message is not news about having run out of turns, so waking on one
 * relaunches an agent that is over budget before it starts: it stops again
 * immediately, announces again, and everything the Boss relays becomes a
 * page. It is also what makes the closing brief's "replying here will not
 * restart it" true rather than a wish.
 */
// The same words as the dispatcher's own park of a spent budget
// (`turnBudgetWaitingFor`), because `liftRaisedBudgets` finds both by them.
export const turnBudgetPark = (
  state: TurnBudgetState,
): { waitingFor: string; liftsOnReply: boolean } => ({
  waitingFor: `a person to decide what happens next; the ${state.max}-turn budget is spent`,
  liftsOnReply: false,
});

const isEscalateResult = (entry: EntryRecord): boolean => {
  const message = entry.model?.[0];
  return (
    entry.kind === "pi.tool-result" &&
    message?.role === "toolResult" &&
    message.toolName === ESCALATE_TOOL &&
    !message.isError
  );
};

/**
 * Whether the agent escalated inside its grace: a successful `escalate`
 * result among the entries since the last `graceTurns` responses. A
 * *failed* escalation does not count -- the Boss was never told, which is
 * the case the harness's own brief exists for.
 */
export const escalatedWithin = (entries: readonly EntryRecord[], graceTurns: number): boolean => {
  let responses = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (isEscalateResult(entry)) return true;
    if (entry.kind === "pi.assistant") {
      responses += 1;
      if (responses > graceTurns) return false;
    }
  }
  return false;
};

export interface TurnBudgetDeps {
  db: Db;
  harness: () => BugbossHarness;
  /** The incident's whole budget: the configured turns plus any granted. */
  maxTurns: (incidentId: string) => number;
  toolApiFor: (incidentId: string) => Pick<ToolApi, "park">;
  port: (incidentId: string) => Pick<BossInboxPort, "tellBoss">;
}

export interface TurnBudget {
  /**
   * After every model response. Counts it into `incident.turnsUsed`, awaited,
   * so the count is in the snapshot before the next request can be made; then
   * steers at the grace edge, or stops at the cap.
   */
  afterResponse: (args: {
    conversationId: ConversationId;
    incidentId: string;
    hasToolCalls: boolean;
  }) => Promise<void>;
  /**
   * After a round's tools. A cap reached on a response that called tools is
   * handled here, once those tools have run, so an `escalate` the model made
   * on its very last turn is seen and is not cut off by the stop.
   */
  afterTools: (args: { conversationId: ConversationId; incidentId: string }) => Promise<void>;
}

export const createTurnBudget = (deps: TurnBudgetDeps): TurnBudget => {
  // Process memory, on purpose: a restart that loses one is caught by the
  // dispatcher, which will not submit to an incident already over budget.
  const pending = new Set<ConversationId>();
  const stopped = new Set<ConversationId>();

  const exhaust = async (conversationId: ConversationId, incidentId: string, used: number, max: number) => {
    if (stopped.has(conversationId)) return;
    stopped.add(conversationId);
    const bugboss = deps.harness();
    const graceTurns = graceTurnsFor(max);
    let escalated = false;
    let usage = spendOf({ models: {}, tools: {} });
    try {
      const conversation = await bugboss.conversation(conversationId);
      escalated = escalatedWithin((await conversation.context(bugboss.context)).entries, graceTurns);
      usage = spendOf(await bugboss.usage(conversationId));
    } catch (err: unknown) {
      alarm("turn_budget_transcript_unreadable", { incidentId, error: String(err) });
    }
    const state: TurnBudgetState = {
      used,
      max,
      graceTurns,
      escalated,
      spentAtLaunch: used - 1 >= max,
      usage,
    };
    const tokens = usage.tokensIn + usage.tokensOut + usage.cacheRead + usage.cacheWrite;
    // Error level. This is a bound working, not a fault, but it is the one
    // event that says what 300 turns actually costs -- and the reason the
    // cap shipped before a dollar cap was to find that out.
    alarm("turn_budget_exhausted", {
      incidentId,
      used,
      max,
      modelId: usage.modelId,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cacheWrite1h: usage.cacheWrite1h,
      tokens,
      estimatedCostUsd: usage.costUsd,
    });

    // Two calls, and they are not interchangeable.
    //
    // The escalation is the announcement: it reaches the Boss, which
    // decides who hears it, and it carries the spend, which is the whole
    // reason a turn cap shipped before a price cap. It is skipped when the
    // agent already escalated inside its grace.
    //
    // `park` is the one that cannot be skipped -- including when the agent
    // parked itself, which it can. Parking twice sets the same wait state
    // and costs nothing; not parking once is the hot loop `park` was added
    // for, because a relaunched agent is instantly over budget again and
    // would escalate, stop, relaunch and escalate every tick.
    if (!shouldAnnounceExhaustion(state)) {
      log("turn_budget_escalation_skipped", {
        incidentId,
        used,
        max,
        reason: "the agent escalated on its own inside the grace window",
      });
    } else {
      try {
        await deps.port(incidentId).tellBoss(
          "escalation",
          `turn budget of ${max} turns exhausted\n\n${turnBudgetBrief(state)}`,
        );
      } catch (err: unknown) {
        alarm("turn_budget_escalation_failed", {
          incidentId,
          error: String(err),
          note: "nobody was told the budget ran out; the park below still stops the relaunch, so this goes quiet rather than looping",
        });
      }
    }

    try {
      const parked = await deps.toolApiFor(incidentId).park(turnBudgetPark(state));
      if (!parked.ok) {
        // The loud one. A failed park is the hot loop: the dispatcher
        // relaunches into the same exhausted budget, and the rotation gets
        // pinged again every tick until someone notices.
        alarm("turn_budget_park_refused", {
          incidentId,
          error: parked.error ?? "the park was refused without a reason",
          note: "the dispatcher holds a spent budget before it submits, so this should not loop; check that it did",
        });
      }
    } catch (err: unknown) {
      alarm("turn_budget_park_failed", { incidentId, error: String(err) });
    }

    // Stopped whatever the two calls did. A budget that keeps running when
    // its announcement fails is not a budget, and both failures are loud.
    // Not awaited: this runs inside the generation it stops, and abort
    // resolves only once that generation is idle.
    void bugboss
      .conversation(conversationId)
      .then((conversation) => conversation.abort(bugboss.context))
      .catch((err: unknown) => alarm("turn_budget_abort_failed", { incidentId, error: String(err) }));
  };

  const count = async (incidentId: string): Promise<{ used: number }> =>
    deps.db.withWrite((w) => {
      w.prepare("UPDATE incident SET turnsUsed = turnsUsed + 1 WHERE id = ?").run(incidentId);
      const row = w.prepare("SELECT turnsUsed FROM incident WHERE id = ?").get(incidentId) as
        | { turnsUsed: number }
        | undefined;
      return { used: row?.turnsUsed ?? 0 };
    });

  return {
    afterResponse: async ({ conversationId, incidentId, hasToolCalls }) => {
      let used: number;
      try {
        ({ used } = await count(incidentId));
      } catch (err: unknown) {
        // Not thrown into the generation: a lost increment costs one turn of
        // accuracy, which the boot reconcile restores, where a throw would
        // fail a response that was already paid for.
        alarm("turn_count_failed", { incidentId, error: String(err) });
        return;
      }
      const max = deps.maxTurns(incidentId);
      if (used >= max) {
        if (hasToolCalls) pending.add(conversationId);
        else await exhaust(conversationId, incidentId, used, max);
        return;
      }
      const graceTurns = graceTurnsFor(max);
      if (used < max - graceTurns) return;
      log("turn_budget_grace", { incidentId, used, max, graceTurns });
      // One steer per budget. The request id makes it once across restarts
      // too: a steer repeated every turn is a sentence the model cannot act
      // on twice. A blocking tool sees the steer queued and returns, so an
      // agent inside a day-long monitor does not spend its grace there.
      try {
        const bugboss = deps.harness();
        const conversation = await bugboss.conversation(conversationId);
        await conversation.submit(
          {
            type: "input",
            content: turnBudgetMessage({
              used,
              max,
              graceTurns,
              escalated: false,
              spentAtLaunch: false,
              usage: spendOf({ models: {}, tools: {} }),
            }),
            whenBusy: "steer",
            requestId: `incident:${incidentId}:turn-budget-grace:${max}`,
          },
          bugboss.context,
        );
      } catch (err: unknown) {
        alarm("turn_budget_grace_undelivered", { incidentId, error: String(err) });
      }
    },
    afterTools: async ({ conversationId, incidentId }) => {
      if (!pending.has(conversationId)) return;
      pending.delete(conversationId);
      const row = deps.db.get<{ turnsUsed: number }>(
        "SELECT turnsUsed FROM incident WHERE id = ?",
        [incidentId],
      );
      await exhaust(conversationId, incidentId, row?.turnsUsed ?? 0, deps.maxTurns(incidentId));
    },
  };
};

/**
 * Once, for incidents parked on a spent budget before turns were counted on
 * the row: their `turnsUsed` is the column's default, 0, and
 * `liftRaisedBudgets` would read that as a raised budget and relaunch every
 * one of them. The park's own text names the budget it spent, which is the
 * only count that survived the old transcripts. Every other pre-cutover
 * incident has no count anywhere but its old session file, and starts again
 * from 0.
 */
export const backfillSpentBudgets = async (db: Db): Promise<number> => {
  const rows = db.query<{ id: string; waitingFor: string }>(
    `SELECT i.id AS id, w.waitingFor AS waitingFor
       FROM incident i JOIN incident_wait w ON w.incidentId = i.id
      WHERE i.conversationId IS NULL AND i.turnsUsed = 0
        AND w.liftsOnReply = 0 AND w.waitingFor LIKE '%-turn budget is spent%'`,
  );
  let changed = 0;
  for (const row of rows) {
    const spent = Number(/the (\d+)-turn budget is spent/.exec(row.waitingFor)?.[1]);
    if (!Number.isInteger(spent) || spent <= 0) continue;
    const result = await db.withWrite((w) =>
      w
        .prepare("UPDATE incident SET turnsUsed = ? WHERE id = ? AND conversationId IS NULL AND turnsUsed = 0")
        .run(spent, row.id),
    );
    if (result.changes > 0) {
      changed += 1;
      log("turns_backfilled", { incidentId: row.id, turns: spent });
    }
  }
  return changed;
};

/**
 * Rewrites every open incident's `turnsUsed` from its transcript: the count
 * of model responses in its conversation. Absolute, so running it twice
 * changes nothing, and it repairs the one way the increment can drift -- a
 * crash between the count's commit and the response's, which counts the
 * re-request twice.
 */
export const reconcileTurns = async (deps: {
  db: Db;
  harness: BugbossHarness;
}): Promise<number> => {
  const rows = deps.db.query<{ id: string; conversationId: number }>(
    `SELECT id, conversationId FROM incident
      WHERE conversationId IS NOT NULL AND status NOT IN ('CLOSED', 'MERGED')`,
  );
  let changed = 0;
  for (const row of rows) {
    let turns: number;
    try {
      turns = await deps.harness.countTurns(row.conversationId as ConversationId);
    } catch (err: unknown) {
      alarm("turn_reconcile_failed", { incidentId: row.id, error: String(err) });
      continue;
    }
    const result = await deps.db.withWrite((w) =>
      w
        .prepare("UPDATE incident SET turnsUsed = ? WHERE id = ? AND turnsUsed <> ?")
        .run(turns, row.id, turns),
    );
    if (result.changes > 0) {
      changed += 1;
      log("turns_reconciled", { incidentId: row.id, turns });
    }
  }
  return changed;
};
