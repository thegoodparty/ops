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
// things that arm a compaction, and both are typed calls the harness sees.
//
// This uses Pi's own compaction rather than a second one. Pi runs it between
// turns, after the tool results are appended and before the next request, and
// appends a `compaction` entry to the session; nothing is deleted. What it
// lacks is a way to ask for that with instructions, so the two halves are:
//
//   1. Arming. The reserve is raised to the whole window, so Pi's own
//      between-turn check finds the session over its threshold and compacts.
//      The reserve goes back before the summary is written.
//   2. The prompt. `session_before_compact` hands us Pi's preparation, and we
//      call Pi's exported `compact()` on it with the stage's instructions and
//      the timeline. The session writes the result as it would its own.
//
// The backstop is untouched: when nothing is armed the hook returns nothing
// and Pi summarises with its default prompt at the usual threshold.

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CompactionResult,
  ExtensionAPI,
  ModelRuntime,
  SessionBeforeCompactEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { TimelineEvent, TimelineEventKind } from "../types";

export type CompactionStage = "root_cause" | "fix_opened" | "fix_merged";

/**
 * Below this the stage compaction is skipped. A summary costs a model call
 * over the history, and compacting a context this small buys back less than
 * the call and the cache rewrite after it.
 */
export const STAGE_COMPACTION_MIN_TOKENS = 50_000;

/** The timeline events that are stage transitions. The rest only record. */
export const STAGE_FOR_TIMELINE_KIND: Partial<Record<TimelineEventKind, CompactionStage>> = {
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

export interface StageCompactionSettings {
  applyOverrides(overrides: { compaction: { reserveTokens: number } }): void;
}

export interface StageCompaction {
  /** Called by the tool whose success is the transition. */
  request: (stage: CompactionStage) => void;
  extension: (pi: ExtensionAPI) => void;
}

type Preparation = SessionBeforeCompactEvent["preparation"];

/** Pi's own formula: what the last response says the context holds. */
const contextTokensOf = (message: unknown): number => {
  const usage = (message as {
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }).usage;
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
};

export const createStageCompaction = (args: {
  settings: StageCompactionSettings;
  /** The backstop's reserve, restored as soon as a stage compaction starts. */
  reserveTokens: number;
  contextWindow: number;
  minTokens?: number;
  timeline: () => Promise<TimelineEvent[]>;
  summarize: (
    preparation: Preparation,
    instructions: string,
    signal: AbortSignal,
  ) => Promise<CompactionResult>;
  log: (event: string, fields: Record<string, unknown>) => void;
}): StageCompaction => {
  const minTokens = args.minTokens ?? STAGE_COMPACTION_MIN_TOKENS;
  const requested: CompactionStage[] = [];
  let armed: CompactionStage | null = null;

  const disarm = (): void => {
    armed = null;
    args.settings.applyOverrides({ compaction: { reserveTokens: args.reserveTokens } });
  };

  return {
    request: (stage) => {
      requested.push(stage);
    },
    extension: (pi: ExtensionAPI): void => {
      // Armed at the end of the turn rather than inside the tool, because
      // this is where the size of the context is known, and because Pi's
      // between-turn check is the next thing to run.
      pi.on("turn_end", (event) => {
        if (requested.length === 0) return;
        // One boundary gets one compaction. Two transitions in one turn -- a
        // root cause and a PR in the same batch -- compact once, for the later
        // stage, since that is the one the next turn is in.
        const stage = requested[requested.length - 1];
        if (requested.length > 1) {
          args.log("stage_compaction_coalesced", { stages: [...requested], stage });
        }
        requested.length = 0;
        const tokens = contextTokensOf(event.message);
        if (tokens < minTokens) {
          args.log("stage_compaction_skipped", { stage, tokens, minTokens });
          return;
        }
        armed = stage;
        args.settings.applyOverrides({ compaction: { reserveTokens: args.contextWindow } });
        args.log("stage_compaction_armed", { stage, tokens });
      });

      // Pi found nothing to compact, or the run ended before it looked. The
      // reserve must not stay at the window, or every later turn compacts.
      pi.on("turn_start", () => {
        if (!armed) return;
        args.log("stage_compaction_not_run", { stage: armed });
        disarm();
      });

      pi.on("session_before_compact", async (event) => {
        if (!armed) return undefined;
        const stage = armed;
        disarm();

        let timeline: TimelineEvent[] = [];
        try {
          timeline = await args.timeline();
        } catch (err: unknown) {
          args.log("stage_compaction_timeline_unreadable", { stage, error: String(err) });
        }

        try {
          const result = await args.summarize(
            event.preparation,
            stageCompactionInstructions(stage, timeline),
            event.signal,
          );
          args.log("stage_compaction_summarized", {
            stage,
            tokensBefore: result.tokensBefore,
            timelineEvents: timeline.length,
          });
          return {
            compaction: {
              ...result,
              details: { ...(result.details as object | undefined), stage },
            },
          };
        } catch (err: unknown) {
          // Pi's default summary still runs, so the context still shrinks;
          // what is lost is the stage's focus, which is worth a log line and
          // not a failed turn.
          args.log("stage_compaction_failed", { stage, error: String(err) });
          return undefined;
        }
      });
    },
  };
};

/**
 * Pi's summary call, made the way Pi makes it for its own compactions: the
 * same exported `compact()`, the same auth lookup, and the session's own
 * stream function, so the request goes through the Bedrock routing on the
 * model runtime like every other request this agent makes.
 */
export const createPiSummarizer =
  (args: {
    compact: typeof import("@earendil-works/pi-coding-agent").compact;
    modelRuntime: Pick<ModelRuntime, "getAuth">;
    model: Model<Api>;
    settings: Pick<SettingsManager, "getRetrySettings">;
    session: () => Pick<AgentSession, "thinkingLevel" | "agent"> | null;
  }) =>
  async (preparation: Preparation, instructions: string, signal: AbortSignal): Promise<CompactionResult> => {
    const session = args.session();
    if (!session) throw new Error("no session to summarise with yet");
    const found = await args.modelRuntime.getAuth(args.model, { signal }).catch(() => undefined);
    const requestModel = found?.auth.baseUrl ? { ...args.model, baseUrl: found.auth.baseUrl } : args.model;
    const headers = found?.auth.headers
      ? (Object.fromEntries(
          Object.entries(found.auth.headers).filter((entry) => entry[1] !== null),
        ) as Record<string, string>)
      : undefined;
    // An incident is one long user-message span -- a kickoff and then two
    // hundred tool turns -- so Pi's cut nearly always lands inside it, and
    // Pi summarises that span's prefix with its own fixed prompt and no
    // instructions at all. Folded into the history instead, the whole of it
    // is summarised once, with the stage's focus.
    const whole = {
      ...preparation,
      messagesToSummarize: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
      turnPrefixMessages: [],
      isSplitTurn: false,
    };
    return args.compact(
      whole,
      requestModel,
      found?.auth.apiKey,
      headers,
      instructions,
      signal,
      session.thinkingLevel,
      session.agent.streamFunction,
      found?.env as Record<string, string> | undefined,
      args.settings.getRetrySettings(),
    );
  };
