// The incident agent runner: one process per incident, launched by the
// dispatcher and resumable after it dies.
//
// Pi is ESM-only and declares no "require" condition, so every runtime value
// from it is reached through a dynamic import. Types are imported normally and
// cost nothing at runtime.

import { createInstallationToken, gitHubAppFromEnv, tokenFromFile } from "../github";
import { execFile, spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentSession,
  ExtensionAPI,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  Directive,
  IncidentMatch,
  IncidentView,
  MergeOutcomeView,
  TimelineEvent,
  TimelineEventKind,
  ToolApi,
  ToolResponse,
} from "../types";
import { TIMELINE_EVENT_KINDS } from "../types";
import {
  DEFAULT_MODEL_ID,
  invokeModelIdFor,
  parseInferenceProfiles,
  resolveBedrockModel,
  type InferenceProfiles,
} from "../bedrock";
import { assertBedrockInvokeModelRouting, registerBedrockRouting } from "../bedrock/runtime";
import {
  connectMcpToolset,
  GRAFANA_MCP_ARGS,
  GRAFANA_READ_TOOLS,
  type McpToolset,
} from "./mcp";
import { composeSystemPrompt, loadPromptContext } from "./prompt";
import {
  lockfileHash,
  npmCiNeeded,
  npmCiPidRecord,
  prepareCheckout,
  type CheckoutOutcome,
} from "./workspace";
import { createGitHubRunsPort, createRerunCiTool } from "./rerun";
import { createGitHubReadPort } from "./conditions";
import {
  bossMessageText,
  createMessageBossTool,
  createMonitorTool,
  createWaitInterrupt,
  pollingGuardExtension,
  renderDirectives,
  type BossInboxPort,
  type DirectivePeek,
  parseWorkingHours,
  type QuestionMarkerPort,
  type PendingWait,
  type WaitMarkerPort,
  type WorkingHours,
  type PendingDirective,
  type PendingQuestion,
} from "./tools";
import {
  createPiSummarizer,
  createStageCompaction,
  STAGE_FOR_TIMELINE_KIND,
} from "./compaction";
import {
  EXIT_ENTRY_TYPE,
  createSessionSync,
  createS3SessionStore,
  emptySessionUsage,
  readSessionUsageFromFile,
  readStoredPrefixFromFile,
  restoreSessionFile,
  sessionFileFor,
  sessionSyncExtension,
  PROMPT_ENTRY_TYPE,
  SESSION_SYNC_FAILURE_LIMIT,
  type SessionStore,
  type SessionUsage,
  type StoredExit,
  type StoredPrefix,
} from "./session";

export const DEFAULT_WORK_ROOT = "/work";
export const DEFAULT_OMNI_REPO = "https://github.com/thegoodparty/omni.git";
// Declared in bedrock/defaults.ts, which has no imports so the Pulumi
// program can read it, and re-exported here because this is where
// everything else looks for it.
export { DEFAULT_MODEL_ID };
export const DEFAULT_TIMEOUT_SECONDS = 86_400;
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
 * 200 rather than 92: high enough that no incident like the ones we have seen
 * touches it, low enough that a runaway stops. It is a bound before a dollar
 * cap, not instead of one -- the escalation carries what the run spent so the
 * next number is measured rather than guessed.
 *
 * Overridden by `BUGBOSS_MAX_TURNS`, which keeps the plain name because it is
 * the only turn budget that is settable from the environment.
 */
export const INCIDENT_AGENT_MAX_TURNS = 200;

/**
 * Turns held back from `maxTurns` for the hand-off, the way
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

/**
 * How long a signalled exit waits for its last session flush to reach S3.
 *
 * Well inside ECS's 30-second default stop timeout, because the flush is one
 * PUT and the alternative to bounding it is a child that ignores a SIGTERM
 * until the kernel escalates -- which is the very kill this is here to make
 * visible.
 */
export const SIGNAL_FLUSH_GRACE_MS = 5000;

/**
 * Zero for SIGTERM. That is ECS draining the task -- routine, and the most
 * orderly shutdown available here, since the exit record is written and the
 * session flushed before we go. Reporting it as a failure alarms on every
 * deploy, and inside the dispatcher's fast-failure window it walked a
 * rolling deploy to a crash-loop escalation in three bounces. SIGINT is not
 * routine outside a terminal, so it keeps its 1.
 */
export const signalExitCode = (signal: NodeJS.Signals): number =>
  signal === "SIGTERM" ? 0 : 1;

/**
 * Wraps a shutdown so only the first signal runs it.
 *
 * A second signal before the exit lands -- SIGTERM from a draining task,
 * then an impatient Ctrl-C -- re-enters the handler concurrently, and two
 * whole-file PUTs on the same key at once is how the exit record this exists
 * to write gets corrupted by the act of writing it.
 */
export const onceOnly = <T extends unknown[]>(
  fn: (...args: T) => void,
): ((...args: T) => void) => {
  let ran = false;
  return (...args: T) => {
    if (ran) return;
    ran = true;
    fn(...args);
  };
};

/**
 * Everything that has to reach S3 before the process goes. Neither `turn_end`
 * nor `session_shutdown` fires on the way out of a signal handler, so this is
 * the flush that does.
 *
 * `allSettled`, because one failing store must not stop another from trying,
 * and because a rejection here would leave the process alive with nothing
 * scheduled to end it.
 */
export const flushDurable = async (
  ...syncs: readonly { flush: () => Promise<void> }[]
): Promise<void> => {
  await Promise.allSettled(syncs.map((sync) => sync.flush()));
};
/**
 * The tail compaction will not summarise, and ours rather than Pi's default
 * because `reserveTokensFor` is derived from it. Left implicit, a Pi release
 * that retuned its own default would move our reserve without touching a
 * line of this repo.
 */
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

export const BUILTIN_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export interface AgentPaths {
  workDir: string;
  checkout: string;
  sessionDir: string;
  sessionFile: string;
  npmCiLog: string;
  npmCiDone: string;
  npmCiFailed: string;
  npmCiPid: string;
}

export const computePaths = (workRoot: string, incidentId: string): AgentPaths => {
  const workDir = join(workRoot, incidentId);
  const checkout = join(workDir, "omni");
  const sessionDir = join(workDir, "session");
  return {
    workDir,
    checkout,
    sessionDir,
    sessionFile: sessionFileFor(sessionDir, incidentId),
    npmCiLog: join(workDir, "npm-ci.log"),
    npmCiDone: join(workDir, "npm-ci.done"),
    npmCiFailed: join(workDir, "npm-ci.failed"),
    npmCiPid: join(workDir, "npm-ci.pid"),
  };
};

/**
 * The band between where compaction fires and the end of the window.
 *
 * Pi compacts just in time already: `prepareNextTurnWithContext` re-projects
 * the session *after* a tool result has been appended and *before* the next
 * provider request, and compacts there if the projection is over
 * `contextWindow - reserveTokens`. So a tool result never has to be cut to
 * fit -- it lands whole, gets measured, and what gives way is summarised
 * history, which the session transcript still holds. That is why there is no
 * longer a cap on tool output anywhere in this agent.
 *
 * What made that unsafe was this number. It was 5% of the window, and the
 * comment here said bounded tool results were what made 95% safe -- which
 * was true of the cut-down results and is the reason the two changes are one
 * change. But 5% was also wrong on its own terms, before any of that: at
 * 1,000,000 it left 50,000 tokens of headroom for a model whose single
 * response can be 128,000. Compaction fired at 950k and Pi then asked for up
 * to 128k of output into a 50k gap.
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
 * compaction before the next request rather than an overflow. A result
 * larger than that is out of scope on purpose.
 *
 * One coupling worth knowing, because it is not local: Pi sizes the
 * summarisation request's own output budget as
 * `min(0.8 * reserveTokens, maxTokens)`. Raising the reserve raises what a
 * summary is *allowed* to be, not what it is asked for -- the summarisation
 * prompt is what keeps it short.
 */
export const reserveTokensFor = (model: { maxTokens: number }): number =>
  model.maxTokens + COMPACTION_KEEP_RECENT_TOKENS;

const exec = (command: string, args: string[], cwd?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} failed: ${stderr || stdout || error.message}`));
        else resolve(stdout);
      },
    );
  });

/**
 * Teach git to authenticate as the GitHub App, for the whole run.
 *
 * An installation token is a password against `x-access-token`, so the
 * natural thing is to embed it in the clone URL — and that is wrong here for
 * two reasons: it is written into `.git/config` where every later `git`
 * command and any `git remote -v` in a log will show it, and it freezes a
 * credential that rotates every twenty minutes, so pushing twelve hours into
 * an incident would fail against a URL that still holds the launch token.
 *
 * A credential helper reads the environment at the moment git asks, so it
 * always presents the current token and never persists one.
 */
export const configureGitCredentials = async (): Promise<void> => {
  await exec("git", [
    "config",
    "--global",
    "credential.https://github.com.helper",
    `!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f`,
  ]);
  // Without an identity git refuses to commit, and the failure arrives after
  // the agent has already written the fix.
  await exec("git", ["config", "--global", "user.name", "bugboss[bot]"]);
  await exec("git", [
    "config",
    "--global",
    "user.email",
    "bugboss@goodparty.org",
  ]);
};

// The done marker holds the lockfile hash it installed, so a relaunch can
// tell node_modules it may keep from node_modules that no longer matches.
export const npmCiCommand = (paths: AgentPaths, lockHash: string): string =>
  `npm ci > ${paths.npmCiLog} 2>&1 && echo ${lockHash} > ${paths.npmCiDone} || cp ${paths.npmCiLog} ${paths.npmCiFailed}`;

export const startNpmCi = (paths: AgentPaths): void => {
  if (!npmCiNeeded(paths)) return;
  rmSync(paths.npmCiDone, { force: true });
  const child = spawn("/bin/sh", ["-c", npmCiCommand(paths, lockfileHash(paths.checkout))], {
    cwd: paths.checkout,
    detached: true,
    stdio: "ignore",
  });
  if (child.pid) writeFileSync(paths.npmCiPid, npmCiPidRecord(child.pid));
  child.unref();
};

// ---------------------------------------------------------------------------
// The Boss
// ---------------------------------------------------------------------------

/**
 * Everything the agent can reach, and none of it is Slack. `escalate` is not
 * the ToolApi one: that posts to the thread, and an agent's escalation goes to
 * the Boss's inbox like everything else it says.
 */
export type BossClient = Omit<ToolApi, "escalate"> &
  QuestionMarkerPort &
  DirectivePeek &
  WaitMarkerPort &
  BossInboxPort &
  TimelinePeek;

/**
 * The timeline without the drain. The stage compaction reads it between
 * turns, where a directive drained through `getIncident` would land in a
 * result the model never sees.
 */
export interface TimelinePeek {
  timelineEvents(): Promise<TimelineEvent[]>;
}

export const createBossClient = (args: {
  baseUrl: string;
  incidentId: string;
  fetchImpl?: typeof fetch;
  authToken?: string;
}): BossClient => {
  const http = args.fetchImpl ?? fetch;
  const base = `${args.baseUrl.replace(/\/$/, "")}/incidents/${args.incidentId}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.authToken) headers.authorization = `Bearer ${args.authToken}`;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await http(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Boss ${method} ${path} failed: ${response.status} ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  };

  return {
    reportRootCause: (payload) => call<ToolResponse>("POST", "/root-cause", payload),
    setSummary: (payload) => call<ToolResponse>("POST", "/summary", payload),
    reportImpact: (payload) => call<ToolResponse>("POST", "/impact", payload),
    reportResolved: (payload) => call<ToolResponse>("POST", "/resolved", payload),
    reportAnalysis: (payload) => call<ToolResponse>("POST", "/analysis", payload),
    park: (payload) => call<ToolResponse>("POST", "/park", payload),
    getIncident: (payload) =>
      call<ToolResponse<IncidentView>>(
        "GET",
        payload?.incidentId ? `?incident=${encodeURIComponent(payload.incidentId)}` : "",
      ),
    proposeMerge: (payload) =>
      call<ToolResponse<MergeOutcomeView>>("POST", "/propose-merge", payload),
    searchIncidents: (payload) =>
      call<ToolResponse<IncidentMatch[]>>("POST", "/search", payload),
    trackTimelineEvent: (payload) =>
      call<ToolResponse<TimelineEvent>>("POST", "/timeline", payload),
    timelineEvents: () => call<TimelineEvent[]>("GET", "/timeline"),
    peekDirectives: () => call<PendingDirective[]>("GET", "/directives"),
    consumeDirective: (id) =>
      call<void>("DELETE", `/directives/${id}`).then(() => undefined),
    getPending: () => call<PendingQuestion | null>("GET", "/pending-question"),
    recordPending: (message) =>
      call<PendingQuestion>("POST", "/pending-question", { message }),
    clearPending: () => call<void>("DELETE", "/pending-question").then(() => undefined),
    recordWait: (command, waitingFor) =>
      call<PendingWait>("POST", "/pending-wait", { command, waitingFor }),
    recordPing: () => call<PendingWait>("POST", "/pending-wait/ping"),
    clearWait: () => call<void>("DELETE", "/pending-wait").then(() => undefined),
    tellBoss: (kind, text, options) =>
      call<{ id: number }>("POST", "/boss-inbox", {
        kind,
        text,
        ownBrief: options?.ownBrief === true,
      }).then(() => undefined),
    escalationsSince: (since) =>
      call<{ count: number; lastAt: number | null }>(
        "GET",
        `/boss-inbox/escalations?since=${since}`,
      ),
  };
};

// Lives with the tools now: message_boss renders directives too, and tools.ts
// cannot import from here.
export { renderDirectives };

const bossToolResult = (response: ToolResponse<unknown>) => ({
  content: [
    {
      type: "text" as const,
      text: `${response.ok ? "ok" : `error: ${response.error ?? "unknown"}`}${
        response.data === undefined ? "" : `\n\n${JSON.stringify(response.data, null, 2)}`
      }${renderDirectives(response.directives ?? [])}`,
    },
  ],
  details: undefined,
  terminate: (response.directives ?? []).some(
    (directive) => directive.type === "stop" || directive.type === "merged",
  ),
});

export const createBossTools = async (args: {
  api: Omit<ToolApi, "escalate">;
  boss: Pick<BossInboxPort, "tellBoss">;
  onRootCause?: () => void;
  onTimelineEvent?: (kind: TimelineEventKind) => void;
}): Promise<ToolDefinition[]> => {
  const { Type } = await import("typebox");

  const tools: ToolDefinition[] = [
    {
      name: "get_incident",
      label: "Get incident",
      description:
        "Re-read an incident, its signals and prefetched evidence, and collect pending directives. Without an id it is yours: call it first on every start and after any long wait. With one, any other incident; read it before you say two are the same problem.",
      parameters: Type.Object({
        incidentId: Type.Optional(
          Type.String({
            description:
              "Another incident to read. Omit for your own.",
          }),
        ),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.getIncident(
            params as unknown as Parameters<ToolApi["getIncident"]>[0],
          ),
        ),
    },
    {
      name: "propose_merge",
      label: "Propose merge",
      description:
        "Ask for your incident and another to be combined when they are the same problem. Read the other first. They are compared before anything moves and the older keeps the thread; if that is theirs, your signals go there and you are done.",
      parameters: Type.Object({
        incidentId: Type.String({
          description: "The incident you believe is the same problem as yours.",
        }),
        reason: Type.String({
          description:
            "What the two share, specifically: the same mechanism, not the same symptom.",
        }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.proposeMerge(
            params as unknown as Parameters<ToolApi["proposeMerge"]>[0],
          ),
        ),
    },
    {
      name: "report_root_cause",
      label: "Report root cause",
      description:
        "INVESTIGATING -> FIXING. State the cause and list exactly the signals it accounts for; unexplained signals are split into their own incident. Starts npm ci in the background.",
      parameters: Type.Object({
        cause: Type.String({ description: "The mechanism, specifically enough to act on." }),
        explainedSignalIds: Type.Array(Type.String(), {
          description: "Only the signals this cause actually explains.",
        }),
        usersImpacted: Type.Optional(Type.Number()),
        impactQuery: Type.Optional(
          Type.String({ description: "The query that produced the number, so it is checkable." }),
        ),
        impactStartedAt: Type.Optional(
          Type.Number({
            description:
              "Epoch millis of the earliest bad event you found, not when we were told. Omit it if you cannot point at one; a guess is worse than nothing.",
          }),
        ),
      }),
      execute: async (_id: string, params: unknown) => {
        const response = await args.api.reportRootCause(
          params as unknown as Parameters<ToolApi["reportRootCause"]>[0],
        );
        if (response.ok) args.onRootCause?.();
        return bossToolResult(response);
      },
    },
    {
      name: "search_incidents",
      label: "Search incidents",
      description:
        "Search the post-mortems, root causes and resolution evidence of RESOLVED and CLOSED incidents, in plain words describing the failure, not a question or SQL. The only way to find the same cause returning under a different alert.",
      parameters: Type.Object({
        text: Type.String({
          description: "The failing operation, the component, the error text.",
        }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.searchIncidents(
            params as unknown as Parameters<ToolApi["searchIncidents"]>[0],
          )
        ),
    },
    {
      name: "set_summary",
      label: "Set summary",
      description:
        "This incident's title: a few words on what is broken and for whom. It heads the thread and the status board. Set it as soon as you know more than the first alert said, and again whenever it stops being true.",
      parameters: Type.Object({
        summary: Type.String({
          description:
            "What is broken and for whom, not why and not what you are doing about it.",
        }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.setSummary(params as unknown as Parameters<ToolApi["setSummary"]>[0])
        ),
    },
    {
      name: "report_impact",
      label: "Report impact",
      description:
        "How many users are affected. Call it again as impact grows; people need the current number.",
      parameters: Type.Object({
        usersImpacted: Type.Number(),
        query: Type.String({ description: "The query that produced the number." }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.reportImpact(params as unknown as Parameters<ToolApi["reportImpact"]>[0])
        ),
    },
    {
      name: "report_resolved",
      label: "Report resolved",
      description:
        "FIXING -> RESOLVED. Only after you have observed the harm stop: a user who repeats exactly what the affected user did is not harmed. Evidence is what you observed, not what you believe the fix does; a quiet alert is not evidence on its own.",
      parameters: Type.Object({
        prUrls: Type.Array(Type.String()),
        evidence: Type.String({ description: "What you observed stop happening, and how." }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.reportResolved(
            params as unknown as Parameters<ToolApi["reportResolved"]>[0],
          )
        ),
    },
    {
      name: "report_analysis",
      label: "Report analysis",
      description:
        "RESOLVED -> CLOSED, your last act. Markdown post-mortem: summary, timeline (built from get_incident's timeline), humans involved, impact, root cause with five whys, owned prevention items. On a recurrence, `recurrence` is required.",
      parameters: Type.Object({
        postmortem: Type.String(),
        usersImpacted: Type.Number(),
        impactQuery: Type.String(),
        recurrence: Type.Optional(
          Type.Object(
            {
              category: Type.Union(
                [
                  Type.Literal("previous_fix_wrong"),
                  Type.Literal("previous_fix_incomplete"),
                  Type.Literal("alert_is_wrong"),
                  Type.Literal("fix_never_reached_production"),
                  Type.Literal("resolution_evidence_too_weak"),
                  Type.Literal("bugboss_defect"),
                ],
                { description: "Which kind of failure let the earlier resolution stand." },
              ),
              why: Type.String({
                description:
                  "Why that resolution did not hold, specifically. Not why the bug happened.",
              }),
              remedy: Type.String({
                description:
                  "What you changed so it does not recur, or that you changed nothing and why. For a bugboss_defect, the change you would make in ops and who you raised it with.",
              }),
            },
            {
              description: "Required when this incident recurred.",
            },
          ),
        ),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.reportAnalysis(
            params as unknown as Parameters<ToolApi["reportAnalysis"]>[0],
          )
        ),
    },
    {
      name: ESCALATE_TOOL,
      label: "Escalate",
      description:
        "Tell the Boss this incident needs a person, urgently, with your brief; the Boss decides who and how. It changes nothing and does not end your run: you keep working it. Without a root cause, first propose an alert-rule change as a PR or a named piece of missing instrumentation.",
      parameters: Type.Object({
        reason: Type.String(),
        brief: Type.String({
          description:
            "What I believe now / What I ruled out / What I was about to do / Side effects.",
        }),
      }),
      execute: async (_id: string, params: unknown) => {
        const { reason, brief } = params as { reason: string; brief: string };
        await args.boss.tellBoss("escalation", `${reason}\n\n${brief}`, { ownBrief: true });
        // The inbox route drains nothing, and a stop or merge waiting behind
        // this call has to end the run on this turn like any other tool's.
        const { directives = [] } = await args.api.getIncident();
        return {
          content: [
            {
              type: "text" as const,
              text: `ok: the Boss has your escalation and brief.${renderDirectives(directives)}`,
            },
          ],
          details: undefined,
          terminate: directives.some(
            (directive) => directive.type === "stop" || directive.type === "merged",
          ),
        };
      },
    },
    {
      name: "track_incident_timeline_event",
      label: "Track timeline event",
      description:
        "Record a key moment in this incident when it happens: first error, impact confirmed, root cause found, mitigated, fix PR opened, merged, deployed, verified. The closer writes the post-mortem timeline from these, and they survive when your context is summarised.",
      parameters: Type.Object({
        kind: Type.Union(
          TIMELINE_EVENT_KINDS.map((kind) => Type.Literal(kind)),
          {
            description:
              "fix_pr_opened and fix_merged also summarise your context for the next stage.",
          },
        ),
        occurredAt: Type.Number({
          description:
            "Epoch millis of when it happened, from the evidence, not when you noticed it.",
        }),
        summary: Type.String({ description: "What happened, in one sentence." }),
        evidenceUrl: Type.Optional(
          Type.String({
            description: "A link that shows it: the PR, the Grafana query, the deploy run.",
          }),
        ),
      }),
      execute: async (_id: string, params: unknown) => {
        const response = await args.api.trackTimelineEvent(
          params as unknown as Parameters<ToolApi["trackTimelineEvent"]>[0],
        );
        if (response.ok && response.data) args.onTimelineEvent?.(response.data.kind);
        return bossToolResult(response);
      },
    },
    {
      name: "park",
      label: "Park",
      description:
        "Say there is nothing you can do until a person acts, so nothing relaunches you into the same dead end. Not a hand-off: the incident stays yours and a Boss message brings you back. Prefer monitor with awaitingHuman whenever a command can detect the thing; park is for when none can.",
      parameters: Type.Object({
        waitingFor: Type.String({
          description:
            "What has to happen first, in one line.",
        }),
        wakeAfterSeconds: Type.Optional(
          Type.Number({
            description:
              "Come back anyway after this long. Omit when only a person can end the wait.",
          }),
        ),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.park(params as unknown as Parameters<ToolApi["park"]>[0])
        ),
    },
  ] as unknown as ToolDefinition[];

  return tools;
};

/**
 * A thinking block bound to a prefix that moved is dropped rather than 400ing,
 * which is the behaviour we want and also completely silent. The provider
 * reports what it dropped as an assistant-message diagnostic, so log it: drift
 * shows up as degraded reasoning long before it shows up as anything else.
 */
export const toolListDrift = (signed: string[], current: string[]): string | null => {
  const added = current.filter((name) => !signed.includes(name));
  const removed = signed.filter((name) => !current.includes(name));
  if (!added.length && !removed.length) return null;
  return `tool list drift: added ${JSON.stringify(added)}, removed ${JSON.stringify(removed)}; keeping the signed loadout`;
};

/** The diagnostic reason a resume against a different model produces. */
export const MODEL_BINDING_MISMATCH = "model_binding_mismatch";

/**
 * Bedrock does not restore the model id on resume, so the session carries it
 * and the session wins. `BUGBOSS_MODEL_ID` comes from SSM, which retunes
 * without a deploy, and the next restart would otherwise replay every
 * recorded thinking block against a model that did not sign it: all of them
 * dropped, silently, with nothing but a `model_binding_mismatch` buried in a
 * diagnostic that reads like prompt drift. So the disagreement is its own
 * alarm rather than something to infer from degraded reasoning.
 */
export const pinnedSessionModel = async (args: {
  restored: boolean;
  sessionFile: string;
  configuredModelId: string;
}): Promise<{
  storedPrefix: StoredPrefix | null;
  modelId: string;
  mismatch: string | null;
}> => {
  const storedPrefix = args.restored
    ? await readStoredPrefixFromFile(args.sessionFile)
    : null;
  if (!storedPrefix) {
    return { storedPrefix: null, modelId: args.configuredModelId, mismatch: null };
  }
  return {
    storedPrefix,
    modelId: storedPrefix.modelId,
    mismatch:
      storedPrefix.modelId === args.configuredModelId
        ? null
        : `${MODEL_BINDING_MISMATCH}: session was signed against ${storedPrefix.modelId} but the configured model is ${args.configuredModelId}; resuming on ${storedPrefix.modelId}`,
  };
};

export const PREFIX_DRIFT_DIAGNOSTIC = "anthropic_input_transformations";

export const prefixDriftExtension =
  (log: (message: string) => void) =>
  (pi: ExtensionAPI): void => {
    pi.on("message_end", (event) => {
      const message = event.message as {
        role?: string;
        diagnostics?: Array<{ type?: string; details?: unknown }>;
      };
      if (message.role !== "assistant" || !message.diagnostics) return;
      for (const diagnostic of message.diagnostics) {
        if (diagnostic.type !== PREFIX_DRIFT_DIAGNOSTIC) continue;
        log(`prefix drift: ${JSON.stringify(diagnostic.details)}`);
      }
    });
  };

export const DIRECTIVE_POLL_MS = 10_000;

/**
 * A person's word reaches the agent as a user message, the way Pi means one
 * to: `steer`. The Boss writes it to a queue in another process, so the child
 * polls. The Boss tools used to be the only reader, and an agent writing a fix
 * or waiting on CI calls none of them for minutes: incident 94's agent ran ten
 * bash and monitor calls past a redirection, told the Boss its fix was ready,
 * and read it only when a deploy restarted it.
 *
 * Consumed after the steer, because the steered message is then in the
 * session and a restart keeps it. `stop` and `merged` only interrupt: they
 * stay queued so the next Boss tool drains them and ends the run, which only
 * a tool result can do.
 */
export const createDirectiveWatcher = (args: {
  api: DirectivePeek;
  steer: (text: string) => Promise<unknown>;
  interruptWait: () => void;
  onFailure: (error: unknown) => void;
}): (() => Promise<void>) => {
  const handled = new Set<number>();
  const steered = new Set<number>();
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const entries = await args.api.peekDirectives();
      for (const entry of entries) {
        if (handled.has(entry.id)) continue;
        const text = bossMessageText(entry.directive);
        if (text !== null) {
          if (!steered.has(entry.id)) {
            await args.steer(`The Boss says: ${text}`);
            steered.add(entry.id);
            args.interruptWait();
          }
          await args.api.consumeDirective(entry.id);
          handled.add(entry.id);
        } else if (entry.directive.type === "stop" || entry.directive.type === "merged") {
          handled.add(entry.id);
          args.interruptWait();
        }
      }
    } catch (error: unknown) {
      args.onFailure(error);
    } finally {
      running = false;
    }
  };
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunIncidentAgentOptions {
  incidentId: string;
  bossBaseUrl: string;
  s3Bucket: string;
  bossAuthToken?: string;
  workRoot?: string;
  omniRepoUrl?: string;
  modelId?: string;
  /**
   * Model id to application inference profile ARN. Empty is normal: it costs
   * the run its line in Cost Explorer and nothing else.
   */
  inferenceProfiles?: InferenceProfiles;
  timeoutSeconds?: number;
  /** Turns this incident gets in total. Defaults to `INCIDENT_AGENT_MAX_TURNS`. */
  maxTurns?: number;
  awsRegion?: string;
  /**
   * The S3 key for the session, from the dispatcher's sessionRef. Required
   * rather than derived: the incident row records the key the Boss chose, and
   * a child that derives its own can write where nothing looks for it.
   */
  sessionKey: string;
  /**
   * When monitor is allowed to tell the Boss about a wait on a person.
   * Passed down by name rather than read here, so the composition root stays
   * the only place a deployment's shape is decided.
   */
  workingHours?: WorkingHours;
  /**
   * Which launch this is, from the dispatcher. Carried only so the exit
   * record can name it: reading a session back, "attempt 3 was killed" is
   * the difference between one bad launch and a run that keeps dying.
   */
  attempt?: number;
  grafana?: { url: string; token: string; command?: string; args?: string[] };
  /** From `BUGBOSS_ALERT_SLUGS`: which rules fired, so the prompt carries them. */
  alertSlugs?: string[];
  store?: SessionStore;
  api?: BossClient;
  skipClone?: boolean;
}

/**
 * The profile map, or none, but never a throw.
 *
 * The composition root parses the same string at boot and refuses to start
 * on a bad one, so this is the second line rather than the first. It is
 * deliberately softer than `parseWorkingHours` next to it: a bad working
 * window sends its reminders at the wrong hour for as long as nobody doubts it,
 * where a bad profile map costs a line in Cost Explorer. Killing an agent
 * that is working a production incident over a billing tag is the wrong
 * trade, and it is the same call `stream.ts` makes about an unhonoured
 * cache retention.
 */
const readInferenceProfiles = (
  env: Record<string, string | undefined>,
): InferenceProfiles => {
  try {
    return parseInferenceProfiles(env.BUGBOSS_INFERENCE_PROFILES);
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        component: "agent",
        level: "error",
        event: "inference_profiles_unreadable",
        error: String(error),
        note: "this run is not attributable in Cost Explorer; it is otherwise unaffected",
      }),
    );
    return {};
  }
};

/**
 * A malformed list costs the prompt its fired-rule section, never the run:
 * the rule is also in the checkout and in the signal get_incident returns.
 */
const readAlertSlugs = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((slug): slug is string => typeof slug === "string");
  } catch {}
  console.error(
    JSON.stringify({ component: "agent", level: "error", event: "alert_slugs_unreadable", raw }),
  );
  return [];
};

/**
 * The dispatcher builds the child's environment from nothing and launches
 * `node <this file>` with no arguments, so this is the whole contract between
 * the two. Names come from dispatcher/env.ts; everything else is composition
 * root configuration the parent passes through by name.
 */
export const agentOptionsFromEnv = (
  env: Record<string, string | undefined>,
  now = Date.now(),
): RunIncidentAgentOptions => {
  const incidentId = env.BUGBOSS_INCIDENT_ID;
  if (!incidentId) throw new Error("BUGBOSS_INCIDENT_ID is required");
  const s3Bucket = env.BUGBOSS_S3_BUCKET;
  if (!s3Bucket) throw new Error("BUGBOSS_S3_BUCKET is required");
  const sessionKey = env.BUGBOSS_SESSION_REF;
  if (!sessionKey) throw new Error("BUGBOSS_SESSION_REF is required");

  // Number("") is 0, which is finite, so an unset-but-present deadline would
  // otherwise pass the check below and yield a 60-second agent.
  const deadlineAt = env.BUGBOSS_DEADLINE_AT
    ? Number(env.BUGBOSS_DEADLINE_AT)
    : Number.NaN;
  const timeoutSeconds = Number.isFinite(deadlineAt)
    ? Math.max(60, Math.round((deadlineAt - now) / 1000))
    : DEFAULT_TIMEOUT_SECONDS;

  const grafanaToken = env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  // Throws on a malformed value rather than falling back on the default. This
  // runs once, at launch, where the failure is immediate and visible; a window
  // nobody meant would instead send its reminders at the wrong hour for as
  // long as it took somebody to doubt a value that looked configured.
  const workingHours = env.BUGBOSS_WORKING_HOURS
    ? parseWorkingHours(env.BUGBOSS_WORKING_HOURS)
    : undefined;

  const attempt = Number(env.BUGBOSS_ATTEMPT);
  // Same shape as `attempt`: a missing or malformed value falls back to the
  // default rather than to zero, which `Number("")` would otherwise make
  // finite and hand every agent a budget of nothing.
  const maxTurns = Number(env.BUGBOSS_MAX_TURNS);
  const alertSlugs = readAlertSlugs(env.BUGBOSS_ALERT_SLUGS);

  return {
    incidentId,
    s3Bucket,
    bossBaseUrl: env.BUGBOSS_BOSS_URL ?? "http://127.0.0.1:8080",
    bossAuthToken: env.BUGBOSS_TOKEN,
    workRoot: env.BUGBOSS_WORK_ROOT ?? DEFAULT_WORK_ROOT,
    omniRepoUrl: env.BUGBOSS_OMNI_REPO ?? DEFAULT_OMNI_REPO,
    modelId: env.BUGBOSS_MODEL_ID ?? DEFAULT_MODEL_ID,
    inferenceProfiles: readInferenceProfiles(env),
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
    sessionKey,
    timeoutSeconds,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : INCIDENT_AGENT_MAX_TURNS,
    ...(Number.isFinite(attempt) && attempt > 0 ? { attempt } : {}),
    ...(workingHours ? { workingHours } : {}),
    ...(alertSlugs.length ? { alertSlugs } : {}),
    ...(grafanaToken
      ? {
          grafana: {
            url: env.GRAFANA_URL ?? "https://goodparty.grafana.net",
            token: grafanaToken,
          },
        }
      : {}),
  };
};

export interface RunIncidentAgentResult {
  sessionFile: string | undefined;
  restored: boolean;
  timedOut: boolean;
  /** The incident's turn budget ran out and the run was stopped on it. */
  turnsExhausted: boolean;
  /** Pi's message for the last failed or aborted turn. Null on a clean end. */
  error: string | null;
}

/**
 * A force-aborted 30-minute investigation used to exit 0, exactly like a
 * resolution, so the parent had nothing to act on. A timeout the agent handed
 * off inside its grace window is still a clean end; an aborted turn is not.
 *
 * A run stopped on its turn budget is a clean end too, and the exception is
 * load-bearing rather than cosmetic. The budget stops the run with
 * `session.abort()`, which leaves an error message behind exactly as a
 * failing turn does -- so without this, a bound working as designed would
 * reach the dispatcher as `agent_failed` and alarm every time. The incident
 * is already with a human by then; nothing is waiting on the exit code.
 */
export const exitCodeFor = (result: RunIncidentAgentResult): number =>
  result.turnsExhausted ? 0 : result.error ? 1 : 0;

export const sessionSyncFailedMessage = (streak: number): string =>
  `Your session has failed to save ${streak} times in a row. Nothing you have done since is durable: if this container restarts you will start over from nothing. Stop investigating and call escalate now, with a brief covering what you believe, what you ruled out and what you were about to do.`;

export const resumeMessage = (checkout: CheckoutOutcome, npmCiFailed: boolean): string =>
  [
    "You were restarted. Time passed while you were down, and pull requests merge, deploys ship, alerts stop and people fix things by hand in that time. Call get_incident first: its resumed_after directive says how long. Re-run only the checks that matter for what you were in the middle of, then continue.",
    checkout === "cloned"
      ? "Your workspace was not kept, so the checkout is a fresh clone of main: branches you had not pushed and uncommitted changes are gone, and there are no node_modules until you run npm ci."
      : "Your workspace was kept: the checkout is on the branch you left it on with your uncommitted changes, node_modules is kept unless package-lock.json changed, and an npm ci the restart interrupted has been started again. There is no need to re-clone or reinstall.",
    ...(checkout === "reused_unfetched"
      ? ["Fetching origin failed at relaunch, so origin is as stale as when you stopped. Run git fetch before you trust anything about the remote."]
      : []),
    ...(checkout !== "cloned" && npmCiFailed
      ? ["npm ci failed in this workspace before the restart and was not run again. Its log is in the failed marker; run npm ci yourself once you know why."]
      : []),
  ].join(" ");

export const kickoffMessage = (incidentId: string): string =>
  `Incident ${incidentId} is yours. Call get_incident to read the signals and the evidence that was prefetched for you, then work it to a conclusion.`;

/**
 * Which of the four endings this was.
 *
 * A timeout the agent handed off inside its grace still exits 0 -- see
 * `exitCodeFor` -- but it is a timeout, and calling it `completed` would hide
 * the one ending a reader most wants to distinguish from a clean close. A
 * timeout that also errored is a timeout first: `error` carries the rest.
 */
export const exitRecordFor = (args: {
  timedOut: boolean;
  turnsExhausted: boolean;
  error: string | null;
  attempt: number | null;
  at: number;
}): StoredExit => ({
  // A timeout stays first. The dispatcher is acting on the same wall clock
  // and escalating under that name, and two halves of one ending that
  // disagree about what it was is worse than either name alone. Turn
  // exhaustion comes before `turn_error` because the abort that stops it
  // leaves an error behind that describes the harness, not the turn.
  reason: args.timedOut
    ? "timed_out"
    : args.turnsExhausted
      ? "turns_exhausted"
      : args.error
        ? "turn_error"
        : "completed",
  at: args.at,
  attempt: args.attempt,
  ...(args.error ? { error: args.error } : {}),
});

// ---------------------------------------------------------------------------
// The turn budget
// ---------------------------------------------------------------------------

/** Running spend, prior launches plus this one. */
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
  /** The restored transcript had already spent the budget before this launch. */
  spentAtLaunch: boolean;
  usage: SessionUsage;
}

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
 * shipping a turn cap before a dollar cap: 200 turns has no known price yet,
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
    `The ${state.max}-turn budget for this incident is spent, so neither a reply in the thread nor a message to me will restart it. To continue the work, somebody has to raise BUGBOSS_MAX_TURNS or pick it up themselves.`,
  ].join("\n");
};

/**
 * Per-turn usage as Pi hangs it off the assistant message. The same shape
 * `sumSessionUsage` reads back off disk, spelt out again rather than shared
 * because the two read it from different places and one changing is not a
 * reason for the other to.
 */
interface TurnUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cost?: { total?: number };
}

/**
 * Whether the harness should announce this exhaustion, or only park.
 *
 * One reason to stay quiet: the agent escalated itself inside the grace.
 * The steer asks for exactly that, and it can land on the same `turn_end`
 * the cap fires on, so sending both puts "it never wrote a brief" directly
 * under the brief it just wrote.
 *
 * There was a second arm here, suppressing a launch that began already over
 * budget. That case was a symptom, not a rule: `incident_wait` conflated
 * "waiting on a person", which a reply rightly ends, with "out of budget",
 * which a reply has nothing to do with -- so any comment woke the incident
 * and paged the rotation again. `incident_wait.liftsOnReply` now separates
 * the two and `recordReply` only deletes a wait that says yes, so the wake
 * does not happen and there is nothing left to suppress. Suppressing it
 * here as well would be a second mechanism for one invariant, and the one
 * that reads like a live rule while guarding nothing.
 *
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
export const turnBudgetPark = (
  state: TurnBudgetState,
): { waitingFor: string; liftsOnReply: boolean } => ({
  waitingFor: `a person to decide what happens next; the ${state.max}-turn budget is spent`,
  liftsOnReply: false,
});

export interface TurnBudget {
  extension: (pi: ExtensionAPI) => void;
  state: () => TurnBudgetState;
  exhausted: () => boolean;
  /**
   * Runs the exhausted hand-off now, before any model call, when the restored
   * transcript has already spent the budget. True when it did.
   */
  stopIfSpent: () => Promise<boolean>;
}

/**
 * Counts turns over the incident and fires the two layers.
 *
 * Seeded from the restored session rather than from zero, because every
 * merge to ops `main` restarts this container and a budget that refilled on
 * a restart would bound nothing. `sumSessionUsage` counts assistant messages
 * over the whole file, which is the same unit `turn_end` fires on, so the
 * two halves of the count agree.
 *
 * `turn_end` cannot stop the loop: Pi reads a boundary result's `continue`
 * as "force another turn" and never as "stop", so a handler returning false
 * only declines to extend a run that was ending anyway. The stop is
 * `session.abort()`, which is what the wall-clock deadline already uses.
 *
 * Both handlers are awaited by Pi's boundary dispatch, so the hand-off
 * completes before the next turn could start. They fire once each: a steer
 * repeated every turn is a sentence the model cannot act on twice, and a
 * second hand-off would post a second brief over the first.
 */
export const createTurnBudget = (args: {
  prior: SessionUsage;
  maxTurns: number;
  graceTurns: number;
  onGrace: (state: TurnBudgetState) => void | Promise<void>;
  onExhausted: (state: TurnBudgetState) => void | Promise<void>;
}): TurnBudget => {
  const usage: SessionUsage = { ...args.prior };
  // Never more than half the budget, and never zero.
  //
  // `graceTurns` is a constant and `maxTurns` is settable, so the two can be
  // configured into nonsense: at `BUGBOSS_MAX_TURNS=10` the raw subtraction
  // puts the soft edge at turn 0, the first `turn_end` clears it, and the
  // agent is told to wrap up before it has done anything -- while the other
  // nine turns sit there unused. Anyone shrinking the budget to exercise
  // this path is exactly who would hit that, and the symptom looks like the
  // agent is broken rather than like the number is.
  //
  // Clamping the grace rather than raising the floor on `maxTurns`, because
  // a small budget is a legitimate thing to ask for and the honest reading
  // of it is "wrap up sooner", not "we will overrule you".
  const graceTurns = Math.max(1, Math.min(args.graceTurns, Math.floor(args.maxTurns / 2)));
  let steered = false;
  let stopped = false;
  let escalated = false;

  const state = (): TurnBudgetState => ({
    used: usage.turns,
    max: args.maxTurns,
    graceTurns,
    escalated,
    spentAtLaunch: args.prior.turns >= args.maxTurns,
    usage: { ...usage },
  });

  return {
    state,
    exhausted: () => stopped,
    stopIfSpent: async () => {
      if (usage.turns < args.maxTurns) return false;
      if (!stopped) {
        stopped = true;
        await args.onExhausted(state());
      }
      return true;
    },
    extension: (pi: ExtensionAPI): void => {
      pi.on("turn_end", async (event) => {
        usage.turns += 1;
        // Watched on every turn, not just the last: the agent can escalate at
        // any point in its grace and the budget only learns about it here.
        // `isError` matters -- a refused escalation told nobody anything.
        const results = (event as { toolResults?: { toolName?: string; isError?: boolean }[] })
          .toolResults;
        if (results?.some((r) => r.toolName === ESCALATE_TOOL && !r.isError)) {
          escalated = true;
        }

        // The model comes off the turn, not off the seed. A first launch
        // starts from `emptySessionUsage()`, so without this `modelId` is
        // null for all 200 turns and the one report whose whole job is to
        // say what 200 turns cost names no model to re-price it against.
        // Same field `sumSessionUsage` reads back off disk.
        const message = event.message as { model?: string; usage?: TurnUsage };
        if (message.model) usage.modelId = message.model;

        const turn = message.usage;
        if (turn) {
          usage.tokensIn += turn.input ?? 0;
          usage.tokensOut += turn.output ?? 0;
          usage.cacheRead += turn.cacheRead ?? 0;
          usage.cacheWrite += turn.cacheWrite ?? 0;
          usage.cacheWrite1h += turn.cacheWrite1h ?? 0;
          usage.costUsd += turn.cost?.total ?? 0;
        }

        if (usage.turns >= args.maxTurns) {
          if (stopped) return;
          stopped = true;
          await args.onExhausted(state());
          return;
        }
        if (usage.turns >= args.maxTurns - graceTurns && !steered) {
          steered = true;
          await args.onGrace(state());
        }
      });
    },
  };
};

/**
 * The first model call of a launch, unless the budget is already spent.
 *
 * `turn_end` only fires after a turn has been paid for, and the first turn of
 * a relaunch rewrites the whole restored context into the cache. Incident 80
 * came back at 266 of 200 turns and spent $4.04 on one `get_incident` before
 * the budget stopped it. Checking first takes the same announce-and-park path
 * with no request at all.
 */
export const promptWithinBudget = async (
  budget: Pick<TurnBudget, "stopIfSpent">,
  prompt: () => Promise<void>,
): Promise<void> => {
  if (await budget.stopIfSpent()) return;
  await prompt();
};

export const deadlineMessage = (graceSeconds: number): string =>
  `Your wall-clock deadline has expired. Stop investigating. Within the next ${graceSeconds} seconds, call escalate with a brief: what you believe now, what you ruled out, what you were about to do, and any side effects. If you have no root cause, your brief must still propose a change to the alert rule or name the instrumentation that is missing.`;

export const runIncidentAgent = async (
  options: RunIncidentAgentOptions,
): Promise<RunIncidentAgentResult> => {
  const paths = computePaths(options.workRoot ?? DEFAULT_WORK_ROOT, options.incidentId);
  const store = options.store ?? createS3SessionStore(options.s3Bucket, options.awsRegion);
  const key = options.sessionKey;
  const api =
    options.api ??
    createBossClient({
      baseUrl: options.bossBaseUrl,
      incidentId: options.incidentId,
      authToken: options.bossAuthToken,
    });

  await mkdir(paths.sessionDir, { recursive: true });
  const checkout: CheckoutOutcome = options.skipClone
    ? "reused"
    : await prepareCheckout(options.omniRepoUrl ?? DEFAULT_OMNI_REPO, paths.checkout);
  // A log means an install was started in this workspace before, and the task
  // it ran in may have died mid-way. Picking it up here is what stops a
  // FIXING agent waiting on a done marker that nothing is going to write.
  if (checkout !== "cloned" && existsSync(paths.npmCiLog)) startNpmCi(paths);
  const restored = await restoreSessionFile({ store, key, sessionFile: paths.sessionFile });
  // The turn budget is over the incident, not over this process, so a launch
  // starts from what the restored transcript already spent. Read here rather
  // than inside `launch` for the same reason the pinned model is: both are
  // properties of the file on disk before a session is opened over it.
  const priorUsage = restored
    ? await readSessionUsageFromFile(paths.sessionFile)
    : emptySessionUsage();

  const pinned = await pinnedSessionModel({
    restored,
    sessionFile: paths.sessionFile,
    configuredModelId: options.modelId ?? DEFAULT_MODEL_ID,
  });
  if (pinned.mismatch) {
    console.warn(`[bugboss ${options.incidentId}] ${pinned.mismatch}`);
  }

  const pi = await import("@earendil-works/pi-coding-agent");
  const model = await resolveBedrockModel({ id: pinned.modelId });

  // Built here rather than left to createAgentSession, because the router has
  // to be installed on the runtime the session will actually stream through.
  const modelRuntime = await pi.ModelRuntime.create({});
  const profiles = options.inferenceProfiles ?? {};
  await registerBedrockRouting({
    runtime: modelRuntime,
    invokeModelIdFor: invokeModelIdFor(profiles),
  });
  assertBedrockInvokeModelRouting(modelRuntime, model);
  // `invokedAs` is the only place the two ids are visible together. They
  // differ whenever cost attribution is on, and a reader who sees them the
  // same knows this run will not appear under the bugboss tags.
  console.log(
    JSON.stringify({
      component: "agent",
      event: "model_provider_selected",
      incidentId: options.incidentId,
      modelId: model.id,
      invokedAs: invokeModelIdFor(profiles)(model.id),
      api: model.api,
    }),
  );

  const mcp: McpToolset[] = [];
  if (options.grafana) {
    mcp.push(
      await connectMcpToolset({
        name: "grafana",
        command: options.grafana.command ?? "uvx",
        args: options.grafana.args ?? GRAFANA_MCP_ARGS,
        env: {
          GRAFANA_URL: options.grafana.url,
          GRAFANA_SERVICE_ACCOUNT_TOKEN: options.grafana.token,
        },
        allowedTools: GRAFANA_READ_TOOLS,
      }),
    );
  }

  try {
    return await launch({
      options,
      paths,
      store,
      key,
      api,
      pi,
      model,
      modelRuntime,
      mcp,
      restored,
      checkout,
      storedPrefix: pinned.storedPrefix,
      priorUsage,
    });
  } finally {
    for (const set of mcp) set.close();
  }
};

const launch = async (args: {
  options: RunIncidentAgentOptions;
  paths: AgentPaths;
  store: SessionStore;
  key: string;
  api: BossClient;
  pi: typeof import("@earendil-works/pi-coding-agent");
  model: Awaited<ReturnType<typeof resolveBedrockModel>>;
  modelRuntime: ModelRuntime;
  mcp: McpToolset[];
  restored: boolean;
  checkout: CheckoutOutcome;
  storedPrefix: StoredPrefix | null;
  priorUsage: SessionUsage;
}): Promise<RunIncidentAgentResult> => {
  const {
    options,
    paths,
    store,
    key,
    api,
    pi,
    model,
    modelRuntime,
    mcp,
    restored,
    checkout,
    storedPrefix,
  } = args;

  // Aborted when either soft bound fires -- the wall-clock deadline or the
  // turn budget -- so a tool parked in a 24h wait returns and the turn can
  // end. `steer` only delivers between turns, so without this the graceful
  // hand-off request never reaches an agent in the state it spends most of a
  // long incident in.
  const wrapUpAbort = new AbortController();
  const waits = createWaitInterrupt();

  const settings = pi.SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: reserveTokensFor(model),
      keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    },
  });

  // Assigned once the session exists; nothing that reads it runs before then.
  let live: Pick<AgentSession, "steer" | "abort" | "thinkingLevel" | "agent"> | null = null;

  const stages = createStageCompaction({
    settings,
    reserveTokens: reserveTokensFor(model),
    contextWindow: model.contextWindow,
    timeline: () => api.timelineEvents(),
    summarize: createPiSummarizer({
      compact: pi.compact,
      modelRuntime,
      model,
      settings,
      session: () => live,
    }),
    log: (event, fields) =>
      console.log(
        JSON.stringify({ component: "agent", event, incidentId: options.incidentId, ...fields }),
      ),
  });

  const bossTools = await createBossTools({
    api,
    boss: api,
    onRootCause: () => {
      startNpmCi(paths);
      stages.request("root_cause");
    },
    onTimelineEvent: (kind) => {
      const stage = STAGE_FOR_TIMELINE_KIND[kind];
      if (stage) stages.request(stage);
    },
  });
  const localTools = [
    await createMonitorTool({
      signal: wrapUpAbort.signal,
      waitSignal: waits.signal,
      cwd: paths.checkout,
      github: createGitHubReadPort({ token: () => process.env.GITHUB_TOKEN }),
      heartbeat: {
        marker: api,
        boss: api,
        ...(options.workingHours ? { workingHours: options.workingHours } : {}),
      },
    }),
    await createMessageBossTool({
      marker: api,
      boss: api,
      api,
      signal: wrapUpAbort.signal,
      waitSignal: waits.signal,
    }),
    // Reads the token at each call rather than closing over it: the App
    // credentials are refreshed in place every twenty minutes, and an incident
    // outlives the one held here at launch.
    await createRerunCiTool({
      github: createGitHubRunsPort({ token: () => process.env.GITHUB_TOKEN }),
      boss: api,
    }),
  ];
  const customTools = [...bossTools, ...localTools, ...mcp.flatMap((set) => set.tools)].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const toolNames = [...BUILTIN_TOOLS, ...customTools.map((tool) => tool.name)].sort();

  const prefix: StoredPrefix =
    storedPrefix ??
    (await (async () => {
      const context = await loadPromptContext(paths.checkout, {
        alertSlugs: options.alertSlugs ?? [],
      });
      return {
        systemPrompt: composeSystemPrompt({
          incidentId: options.incidentId,
          checkoutPath: paths.checkout,
          toolNames,
          npmCiDoneMarker: paths.npmCiDone,
          npmCiFailedMarker: paths.npmCiFailed,
          ...context,
        }),
        toolNames,
        modelId: model.id,
      };
    })());

  // The tools array is part of the signed prefix, so a resume keeps the loadout
  // it was signed against rather than picking up whatever the MCP server
  // enumerates today. A difference is survivable (drop_block) but never silent.
  const drift = toolListDrift(prefix.toolNames, toolNames);
  if (drift) console.warn(`[bugboss ${options.incidentId}] ${drift}`);

  const sessionManager = restored
    ? pi.SessionManager.open(paths.sessionFile, paths.sessionDir, paths.checkout)
    : pi.SessionManager.create(paths.checkout, paths.sessionDir, { id: options.incidentId });

  const sync = createSessionSync({
    store,
    key,
    sessionFile: () => sessionManager.getSessionFile(),
  });

  const attempt = options.attempt ?? null;

  // How this launch ended, written into the session itself. Without it a
  // killed run and a finished one are the same shape on disk, which is how a
  // 9.5-hour run died with its deliverable intact and nobody noticed.
  //
  // `appendCustomEntry` is synchronous, so the record is on local disk before
  // the whole-file PUT that carries it -- including from inside the signal
  // handler below, where there is no room for anything that is not.
  let exitRecorded = false;
  const recordExit = (exit: StoredExit): void => {
    if (exitRecorded) return;
    exitRecorded = true;
    try {
      sessionManager.appendCustomEntry(EXIT_ENTRY_TYPE, exit);
    } catch (err: unknown) {
      // Never fatal. An unwritable exit record costs a reader the reason;
      // throwing here would cost them the session flush that follows it.
      console.error(
        JSON.stringify({
          component: "agent",
          level: "error",
          event: "exit_record_failed",
          incidentId: options.incidentId,
          reason: exit.reason,
          error: String(err),
        }),
      );
    }
  };

  // SIGKILL cannot be caught and the dispatcher's backstop uses it, so this
  // upgrades only the kills that arrive politely: a container stopping, a
  // deploy draining, an operator scaling the service down. Those are the
  // common ones, and the record is the only thing that tells them apart from
  // a run that finished.
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  // One shot. A second signal before the exit lands -- SIGTERM from a
  // draining task, then an impatient Ctrl-C -- would otherwise re-enter this
  // concurrently and put two whole-file PUTs on the same key at once, which
  // is how the exit record this exists to write gets corrupted by the act of
  // writing it. Two quit timers racing to call process.exit is the milder
  // half of the same bug.
  const onSignal = onceOnly((signal: NodeJS.Signals): void => {
    console.error(
      JSON.stringify({
        component: "agent",
        level: "error",
        event: "agent_signalled",
        incidentId: options.incidentId,
        attempt,
        signal,
      }),
    );
    recordExit({ reason: "signal", at: Date.now(), attempt, signal });
    // Installing a handler suppresses the default terminate, so this has to
    // exit itself -- and on a timer as well as on the flush, because a hung
    // PUT must not be what keeps a draining container alive.
    const quit = (): void => process.exit(signalExitCode(signal));
    void flushDurable(sync).then(quit, quit);
    setTimeout(quit, SIGNAL_FLUSH_GRACE_MS).unref();
  });
  for (const signal of signals) process.on(signal, onSignal);
  const releaseSignals = (): void => {
    for (const signal of signals) process.off(signal, onSignal);
  };

  const onSyncFailure = (error: Error, streak: number): void => {
    console.error(
      JSON.stringify({
        component: "agent",
        level: "error",
        event: "session_sync_failed",
        incidentId: options.incidentId,
        key,
        streak,
        error: error.message,
      }),
    );
    if (streak === SESSION_SYNC_FAILURE_LIMIT) {
      void live?.steer(sessionSyncFailedMessage(streak)).catch(() => {});
    }
  };

  const maxTurns = options.maxTurns ?? INCIDENT_AGENT_MAX_TURNS;
  const turnBudget = createTurnBudget({
    prior: args.priorUsage,
    maxTurns,
    graceTurns: TURN_BUDGET_GRACE_TURNS,
    onGrace: (state) => {
      console.log(
        JSON.stringify({
          component: "agent",
          event: "turn_budget_grace",
          incidentId: options.incidentId,
          used: state.used,
          max: state.max,
          graceTurns: state.graceTurns,
        }),
      );
      // Same pair as the deadline: free a blocking tool so the steer lands,
      // then ask for the brief. An agent inside a 24h `monitor` would
      // otherwise spend its whole grace parked in one turn.
      wrapUpAbort.abort();
      void live?.steer(turnBudgetMessage(state)).catch(() => {});
    },
    onExhausted: async (state) => {
      const tokens =
        state.usage.tokensIn +
        state.usage.tokensOut +
        state.usage.cacheRead +
        state.usage.cacheWrite;
      // Error level. This is a bound working, not a fault, but it is the one
      // event that says what 200 turns actually costs -- and the reason the
      // cap shipped before a dollar cap was to find that out.
      console.error(
        JSON.stringify({
          component: "agent",
          level: "error",
          event: "turn_budget_exhausted",
          incidentId: options.incidentId,
          used: state.used,
          max: state.max,
          modelId: state.usage.modelId,
          tokensIn: state.usage.tokensIn,
          tokensOut: state.usage.tokensOut,
          cacheRead: state.usage.cacheRead,
          cacheWrite: state.usage.cacheWrite,
          cacheWrite1h: state.usage.cacheWrite1h,
          tokens,
          estimatedCostUsd: state.usage.costUsd,
        }),
      );
      // Two calls, and they are not interchangeable.
      //
      // The escalation is the announcement: it reaches the Boss, which
      // decides who hears it, and it carries the spend, which is the whole
      // reason a turn cap shipped before a price cap. It is skipped when the agent already
      // escalated inside its grace, because the steer asks for exactly that
      // and the model can answer on the same `turn_end` this fires on --
      // sending both puts "it never wrote a brief" under the brief it just
      // wrote.
      //
      // `park` is the one that cannot be skipped -- including when the agent
      // parked itself, which it can. Parking twice sets the same wait state
      // and costs nothing; not parking once is the hot loop `park` was added
      // for, because a relaunched agent is instantly over budget again and
      // would escalate, stop, relaunch and escalate every tick. The two
      // calls are asymmetric for that reason: a duplicate announcement is a
      // contradiction a person reads, a duplicate park is a no-op.
      // Announcing is what a person sees; parking is what makes it stop.
      if (!shouldAnnounceExhaustion(state)) {
        console.log(
          JSON.stringify({
            component: "agent",
            event: "turn_budget_escalation_skipped",
            incidentId: options.incidentId,
            used: state.used,
            max: state.max,
            reason: "the agent escalated on its own inside the grace window",
          }),
        );
      } else {
        try {
          await api.tellBoss(
            "escalation",
            `turn budget of ${state.max} turns exhausted\n\n${turnBudgetBrief(state)}`,
          );
        } catch (err: unknown) {
          console.error(
            JSON.stringify({
              component: "agent",
              level: "error",
              event: "turn_budget_escalation_failed",
              incidentId: options.incidentId,
              error: String(err),
              note: "nobody was told the budget ran out; the park below still stops the relaunch, so this goes quiet rather than looping",
            }),
          );
        }
      }

      try {
        const parked = await api.park(turnBudgetPark(state));
        if (!parked.ok) {
          // The loud one. A failed park is the hot loop: the dispatcher
          // relaunches, the new agent is over budget on its first turn, and
          // the rotation gets pinged again every tick until someone notices.
          console.error(
            JSON.stringify({
              component: "agent",
              level: "error",
              event: "turn_budget_park_refused",
              incidentId: options.incidentId,
              error: parked.error ?? "the park was refused without a reason",
              note: "the dispatcher will relaunch this into the same exhausted budget; expect a repeat every tick until a person replies",
            }),
          );
        }
      } catch (err: unknown) {
        console.error(
          JSON.stringify({
            component: "agent",
            level: "error",
            event: "turn_budget_park_failed",
            incidentId: options.incidentId,
            error: String(err),
            note: "the dispatcher will relaunch this into the same exhausted budget; expect a repeat every tick until a person replies",
          }),
        );
      }

      // Stopped whatever the two calls did. A budget that keeps running when
      // its announcement fails is not a budget, and both failures are loud.
      await live?.abort().catch(() => {});
    },
  });

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: paths.checkout,
    agentDir: pi.getAgentDir(),
    settingsManager: settings,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPromptOverride: () => prefix.systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      sessionSyncExtension(sync, onSyncFailure),
      turnBudget.extension,
      stages.extension,
      pollingGuardExtension,
      // The prompt is forced rather than rebuilt, so a doc that changed in the
      // checkout between containers cannot move a single byte of the prefix
      // every thinking block is signed against.
      (extension) => {
        extension.on("before_agent_start", () => ({ systemPrompt: prefix.systemPrompt }));
      },
      prefixDriftExtension((message) =>
        console.warn(`[bugboss ${options.incidentId}] ${message}`),
      ),
    ],
  });
  await resourceLoader.reload();

  if (!storedPrefix) {
    sessionManager.appendCustomEntry(PROMPT_ENTRY_TYPE, prefix);
  }

  const { session } = await pi.createAgentSession({
    cwd: paths.checkout,
    model,
    modelRuntime,
    thinkingLevel: "high",
    tools: prefix.toolNames,
    customTools,
    resourceLoader,
    settingsManager: settings,
    sessionManager,
  });
  live = session;

  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  let timedOut = false;
  // Two layers, because an in-process deadline cannot fire inside a wedged
  // agent: ask it to write its brief, then stop it. The dispatcher kills the
  // process as the real backstop.
  const deadline = setTimeout(() => {
    timedOut = true;
    wrapUpAbort.abort();
    session.steer(deadlineMessage(DEADLINE_GRACE_SECONDS)).catch(() => {});
  }, timeoutSeconds * 1000);
  const hardStop = setTimeout(
    () => void session.abort().catch(() => {}),
    (timeoutSeconds + DEADLINE_GRACE_SECONDS) * 1000,
  );
  const watchDirectives = createDirectiveWatcher({
    api,
    steer: (text) => session.steer(text),
    interruptWait: waits.interrupt,
    onFailure: (failure) =>
      console.error(
        JSON.stringify({
          component: "agent",
          level: "error",
          event: "directive_watch_failed",
          incidentId: options.incidentId,
          error: String(failure),
        }),
      ),
  });
  const directiveWatch = setInterval(() => void watchDirectives(), DIRECTIVE_POLL_MS);

  let error: string | null = null;
  try {
    await promptWithinBudget(turnBudget, () =>
      session.prompt(
        restored
          ? resumeMessage(checkout, existsSync(paths.npmCiFailed))
          : kickoffMessage(options.incidentId),
      ),
    );
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardStop);
    clearInterval(directiveWatch);
    releaseSignals();
    error = session.state.errorMessage ?? null;
    // Before the flush, not after: the sync is a whole-file PUT, so a record
    // written afterwards stays on a disk that is about to go away. A timeout
    // the agent handed off inside its grace is still a timeout -- that is the
    // more specific cause, and `error` carries the rest.
    recordExit(
      exitRecordFor({
        timedOut,
        turnsExhausted: turnBudget.exhausted(),
        error,
        attempt,
        at: Date.now(),
      }),
    );
    await sync.flush();
    const lost = sync.lastError();
    if (lost) onSyncFailure(lost, sync.failureStreak());
    session.dispose();
  }

  return {
    sessionFile: sessionManager.getSessionFile(),
    restored,
    timedOut,
    turnsExhausted: turnBudget.exhausted(),
    error,
  };
};

/**
 * Keep GITHUB_TOKEN current for the whole run.
 *
 * `gh` and `git` read the token out of the environment each time they are
 * invoked, and a child inherits whatever process.env holds at that moment, so
 * refreshing the variable in place is enough -- nothing has to be told. The
 * interval is well inside the one-hour expiry, and @octokit/auth-app serves
 * the cached token until it is nearly spent, so this is one API call an hour
 * rather than one every twenty minutes.
 *
 * Without this a day-long incident loses its credentials after an hour, and
 * the way that shows up is `gh` refusing to push a branch the agent has
 * already built and committed.
 */
const keepGitHubTokenFresh = async (): Promise<void> => {
  const tokenFile = process.env.BUGBOSS_GITHUB_TOKEN_FILE;
  const app = gitHubAppFromEnv(process.env);
  if (!app && !tokenFile) {
    console.log(
      JSON.stringify({
        component: "agent",
        event: "github_app_absent",
        note: "no GitHub credentials; the agent can read but cannot open a PR",
      }),
    );
    return;
  }
  const mint = tokenFile ? tokenFromFile(tokenFile) : createInstallationToken(app!);
  const refresh = async () => {
    try {
      const token = await mint();
      process.env.GITHUB_TOKEN = token;
      process.env.GH_TOKEN = token;
    } catch (error: unknown) {
      // Deliberately not fatal. The previous token is good for the rest of
      // its hour, and an investigation that cannot open a PR is still worth
      // more than one that stopped.
      console.error(
        JSON.stringify({
          component: "agent",
          level: "error",
          event: "github_token_refresh_failed",
          error: String(error),
        }),
      );
    }
  };
  await refresh();
  setInterval(() => void refresh(), 20 * 60 * 1000).unref();
  // After the first token exists, so the helper never presents an empty one.
  await configureGitCredentials();
};

if (require.main === module) {
  const bootOptions = agentOptionsFromEnv(process.env);
  keepGitHubTokenFresh()
    .then(() => runIncidentAgent(bootOptions))
    .then(
    (result) => {
      console.log(
        JSON.stringify({ component: "agent", event: "exit", ...result }),
      );
      process.exit(exitCodeFor(result));
    },
    (error: unknown) => {
      console.error(
        JSON.stringify({
          component: "agent",
          event: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    },
  );
}
