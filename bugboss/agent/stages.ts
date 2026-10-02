// Stage compaction: the incident agent's context is summarised at each stage
// transition, with a prompt that keeps only what the next stage needs.
//
// The threshold backstop alone never fired. It sits at ~85% of a 1M window
// and no incident got past 431k, so every turn re-read everything the agent
// had ever seen: half of what the fleet spent was cache reads of history, and
// the long incidents ran out of turns carrying an investigation they had
// finished hours before. A stage boundary is the natural cut. Once the root
// cause is reported, the forty queries that found it are dead weight; once the
// fix is up, so is the code-writing.
//
// The trigger is a tool call, never words. `report_root_cause` succeeding and
// `track_incident_timeline_event` recording a fix PR or a merge are the only
// things that ask for a compaction, and both are typed calls the harness sees.
//
// Pi Durable does the rest. `compact(instructions)` admits a checkpointed task
// that summarises in the background and places the summary at the next turn
// boundary, after the round's tool results and before the next request that
// would read them, and a deploy mid-summary resumes the task rather than
// losing it. The threshold backstop is untouched underneath.

import type { BugbossHarness, ConversationId } from "./harness";
import type { RecordedTimelineKind, TimelineEvent } from "../types";
import { GOAL_VERDICT_KIND } from "../types";

export type CompactionStage = "root_cause" | "fix_opened" | "fix_merged";

/**
 * Below this the stage compaction is skipped. A summary costs a model call
 * over the history, and compacting a context this small buys back less than
 * the call and the cache rewrite after it.
 */
export const STAGE_COMPACTION_MIN_TOKENS = 50_000;

/**
 * The tail compaction will not summarise, and ours rather than Pi's default
 * because `reserveTokensFor` is derived from it. Left implicit, a Pi release
 * that retuned its own default would move our reserve without touching a
 * line of this repo.
 */
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/**
 * The band between where compaction fires and the end of the window, for the
 * harness's `compaction.reserveTokens`.
 *
 * Pi compacts just in time: a tool result is appended, the next request's
 * context is measured, and if it is over `contextWindow - reserveTokens` the
 * request waits for a compaction. So a tool result never has to be cut to
 * fit -- it lands whole, gets measured, and what gives way is summarised
 * history, which the transcript still holds. That is why there is no cap on
 * tool output anywhere in this agent.
 *
 * Both terms are read rather than chosen:
 *
 * - `maxTokens` is the most this model can emit in one response. A reserve
 *   below it asks for output that cannot fit, whatever else is going on.
 * - `keepRecentTokens` is the tail compaction keeps. A reserve below it
 *   cannot be reached by compacting, because what compaction keeps already
 *   exceeds the room it is trying to free.
 *
 * On Opus 5 that is 148,000 of 1,000,000, so compaction fires around 85%,
 * and any single tool result up to ~148k tokens lands whole and triggers a
 * compaction before the next request rather than an overflow. It was once 5%
 * of the window, which at 1,000,000 left 50,000 tokens of headroom for a
 * model whose single response can be 128,000. A result larger than the
 * reserve is out of scope on purpose.
 */
export const reserveTokensFor = (model: { maxTokens: number }): number =>
  model.maxTokens + COMPACTION_KEEP_RECENT_TOKENS;

/** The timeline events that are stage transitions. The rest only record. */
export const STAGE_FOR_TIMELINE_KIND: Partial<Record<RecordedTimelineKind, CompactionStage>> = {
  fix_pr_opened: "fix_opened",
  fix_merged: "fix_merged",
};

export const renderTimeline = (events: TimelineEvent[]): string =>
  events
    .map(
      (event) =>
        `- ${new Date(event.occurredAt).toISOString()} ${event.kind}: ${event.summary}${
          event.evidenceUrl ? ` (${event.evidenceUrl})` : ""
        }`,
    )
    .join("\n");

const STAGE_FOCUS: Record<CompactionStage, string> = {
  root_cause: [
    "This incident has just moved from investigating to fixing: the agent reported its root cause. The next stage is building and shipping the fix, and this summary is all of the investigation that stage will see. Keep only what it needs:",
    "- The root cause, specifically enough to act on, and the evidence that established it: the exact queries, log lines, error text, file paths and line numbers, commit and PR references. Keep identifiers exactly as they appeared.",
    "- The active impact: which users or operations are affected, how many, since when, and whether it is still happening.",
    "- What was ruled out, one line each with the reason, so none of it is investigated again.",
    "- The plan for the fix: the repository, the files, the approach, and anything the Boss or a person asked for.",
    "Drop the exploration that led nowhere beyond that one-line ruled-out list, and all raw tool output.",
  ].join("\n"),
  fix_opened: [
    "A fix pull request for this incident has just been opened. The next stage is getting it through CI and review, merged and deployed, and then showing the problem stopped. Keep only what that needs:",
    "- Every pull request opened for this incident: its URL, what it changes in a sentence, and where it stands (CI, review, merge).",
    "- What verification looks like: the exact query or check that will show the problem has stopped, and what its result reads as when it has.",
    "- Rough start and end markers of the incident: when the bad behaviour began, and whether and when it ended.",
    "- Open risks, review comments still to address, and follow-ups promised to anyone.",
    "- The root cause in one paragraph.",
    "Drop the investigation detail and the steps of writing the code.",
  ].join("\n"),
  fix_merged: [
    "A fix pull request for this incident has just merged. The next stage is the deploy and then showing the problem stopped. Keep only what that needs:",
    "- Every pull request for this incident: its URL, what it changes in a sentence, and whether it is merged, deployed or still open.",
    "- What verification looks like: the exact query or check that will show the problem has stopped, and what its result reads as when it has.",
    "- Rough start and end markers of the incident: when the bad behaviour began, and whether and when it ended.",
    "- Open risks and follow-ups promised to anyone.",
    "- The root cause in one paragraph.",
    "Drop the review back-and-forth, the CI waits and the steps of writing the code.",
  ].join("\n"),
};

/**
 * The whole instruction for one stage. The timeline goes in verbatim because
 * the closer builds the post-mortem from it; a summary that paraphrased it
 * would lose the times and the links, which are the point.
 */
export const stageCompactionInstructions = (
  stage: CompactionStage,
  timeline: TimelineEvent[],
): string =>
  [
    STAGE_FOCUS[stage],
    "",
    timeline.length > 0
      ? [
          "The incident's recorded timeline follows. Reproduce it verbatim under a `## Timeline` heading, in this order, with every time and link as written:",
          "",
          renderTimeline(timeline),
        ].join("\n")
      : "No timeline events have been recorded yet. Under a `## Timeline` heading, list the key moments visible in the conversation with their times, and say they still need recording with track_incident_timeline_event.",
  ].join("\n");

/** Pi's own formula: what the last response says the context holds. */
export const contextTokensOf = (message: unknown): number => {
  const usage = (message as {
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }).usage;
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
};

export interface StageCompaction {
  /**
   * Called by the tool whose success is the transition. Only records it: the
   * round's `afterTools` hook compacts once, so two transitions in one batch
   * -- a root cause and a PR together -- cost one summary, for the later
   * stage, since that is the one the next turn is in.
   */
  request: (conversationId: ConversationId, stage: CompactionStage) => void;
  /**
   * Compacts for what this round requested, if anything. Never throws: a
   * stage compaction that fails costs the stage's focus, and the threshold
   * backstop underneath still shrinks the context when it has to.
   */
  flush: (conversationId: ConversationId) => Promise<void>;
}

export const createStageCompaction = (args: {
  harness: () => BugbossHarness;
  /** The incident's timeline, read without side effects. */
  timeline: (conversationId: ConversationId) => Promise<TimelineEvent[]>;
  minTokens?: number;
  log: (event: string, fields: Record<string, unknown>) => void;
}): StageCompaction => {
  const minTokens = args.minTokens ?? STAGE_COMPACTION_MIN_TOKENS;
  const requested = new Map<ConversationId, CompactionStage[]>();
  return {
    request: (conversationId, stage) => {
      requested.set(conversationId, [...(requested.get(conversationId) ?? []), stage]);
    },
    flush: async (conversationId) => {
      const stages = requested.get(conversationId);
      if (!stages?.length) return;
      requested.delete(conversationId);
      const stage = stages[stages.length - 1];
      if (stages.length > 1) {
        args.log("stage_compaction_coalesced", { conversationId, stages, stage });
      }
      try {
        const bugboss = args.harness();
        const conversation = await bugboss.conversation(conversationId);
        const view = await conversation.context(bugboss.context);
        const newest = [...view.messages].reverse().find((message) => message.role === "assistant");
        const tokens = contextTokensOf(newest);
        if (tokens < minTokens) {
          args.log("stage_compaction_skipped", { conversationId, stage, tokens, minTokens });
          return;
        }

        let timeline: TimelineEvent[] = [];
        try {
          // Verdicts are the harness's bookkeeping; a summary that reproduced
          // them verbatim would carry every one forward into every later stage.
          timeline = (await args.timeline(conversationId)).filter(
            (event) => event.kind !== GOAL_VERDICT_KIND,
          );
        } catch (err: unknown) {
          // The context still shrinks; it just loses the timeline.
          args.log("stage_compaction_timeline_unreadable", { conversationId, stage, error: String(err) });
        }

        const task = await conversation.compact(
          stageCompactionInstructions(stage, timeline),
          bugboss.context,
        );
        args.log("stage_compaction_requested", {
          conversationId,
          stage,
          tokens,
          timelineEvents: timeline.length,
          task,
        });
      } catch (err: unknown) {
        args.log("stage_compaction_failed", { conversationId, stage, error: String(err) });
      }
    },
  };
};
