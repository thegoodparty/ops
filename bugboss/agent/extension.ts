// The incident agent, as Pi Durable extensions: one conversation per
// incident, run by the Boss's own harness in the Boss's own process.
//
//   bugboss.incident  the tool API, the Boss, the waits, the budget hooks
//   bugboss.coding    bash, edit, read and write over the incident's checkout
//   bugboss.grafana   one mcp-grafana process, shared by every agent
//
// Containment is the conversation's IncidentDoc. Every incident tool reads
// its incident id from there and calls the tool API for that incident
// in-process, so the id is never an argument and a conversation cannot aim a
// write at another incident's record. That is the property the per-launch
// bearer token used to provide, held without a token.
//
// The incident extension has no prompt sections, on purpose. The whole system
// prompt is the conversation's `instructions`, pinned when the conversation is
// created, so nothing that changes in this process -- a section, a doc in the
// checkout -- can move a byte of the prefix every cached turn is read through.

import { execFile } from "node:child_process";
import { z } from "zod";

import type { Db } from "../db";
import { makeAlarm, makeLog } from "../logging";
import type { ModelClient } from "../model";
import type { BossInboxItem, TimelineEvent, ToolApi, ToolResponse } from "../types";
import { GOAL_VERDICT_KIND, TIMELINE_EVENT_KINDS } from "../types";
import { createTurnBudget, ESCALATE_TOOL } from "./budget";
import { createGitHubReadPort } from "./conditions";
import { createGoalEvaluator, createStageGoals, type StageGate } from "./goals";
import type {
  AgentChange,
  BugbossHarness,
  Context,
  ConversationDocToken,
  ConversationId,
  Extension,
  ModelRef,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
  Tx,
  Usage,
} from "./harness";
import { loadPi } from "./harness";
import { connectMcpToolset, GRAFANA_MCP_ARGS, GRAFANA_READ_TOOLS } from "./mcp";
import type { AgentPort } from "./port";
import { createGitHubRunsPort, createRerunCiTool } from "./rerun";
import { withGitHubToken } from "./shell-env";
import { createSqlQueryTool } from "./sql";
import { createStageCompaction, STAGE_FOR_TIMELINE_KIND } from "./stages";
import {
  createMessageBossTool,
  createMonitorTool,
  pollingRefusal,
  WHOLE_OUTPUT,
  type WorkingHours,
} from "./tools";
import { computePaths, DEFAULT_WORK_ROOT, startNpmCi, type CheckoutOutcome } from "./workspace";

const log = makeLog("agent");
const alarm = makeAlarm("agent");

export const INCIDENT_EXTENSION = "bugboss.incident";
export const CODING_EXTENSION = "bugboss.coding";
export const GRAFANA_EXTENSION = "bugboss.grafana";

/** Which incident a conversation is working. Written once, when it is created. */
export const IncidentDoc: ConversationDocToken<{ incidentId: string }> = {
  definition: {
    kind: "bugboss.incident",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ incidentId: "" }),
  },
};

/** The `init` that binds a new conversation to its incident, in the creating commit. */
export const incidentInit =
  (incidentId: string) =>
  async (tx: Tx, conversationId: ConversationId): Promise<void> => {
    (await tx.doc(IncidentDoc, conversationId)).incidentId = incidentId;
  };

/**
 * The agent a new incident conversation runs with. Extensions are stored by
 * name, so a name is all this needs; the registry resolves them at each use.
 * The model and the prompt are pinned here, per conversation, so a model id
 * retuned in SSM or a doc that changed in the checkout reaches new incidents
 * and never moves one already running.
 */
export const incidentAgentChange = (a: {
  model: ModelRef;
  cwd: string;
  instructions: string;
}): AgentChange => ({
  model: a.model,
  thinkingLevel: "high",
  extensions: [INCIDENT_EXTENSION, CODING_EXTENSION, GRAFANA_EXTENSION].map((name) => ({ name })),
  cwd: a.cwd,
  instructions: a.instructions,
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const git = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git failed: ${stderr || stdout || error.message}`));
      else resolve();
    });
  });

/**
 * Teach git to authenticate as the GitHub App, for every agent. Run once at
 * boot.
 *
 * An installation token is a password against `x-access-token`, so the
 * natural thing is to embed it in the clone URL — and that is wrong here for
 * two reasons: it is written into `.git/config` where every later `git`
 * command and any `git remote -v` in a log will show it, and it freezes a
 * credential that rotates every twenty minutes, so pushing twelve hours into
 * an incident would fail against a URL that still holds the launch token.
 *
 * A credential helper reads the environment at the moment git asks, and
 * bash puts the current token there on every call, so it always presents the
 * current token and never persists one.
 */
export const configureGitCredentials = async (): Promise<void> => {
  await git([
    "config",
    "--global",
    "credential.https://github.com.helper",
    `!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f`,
  ]);
  // Without an identity git refuses to commit, and the failure arrives after
  // the agent has already written the fix.
  await git(["config", "--global", "user.name", "bugboss[bot]"]);
  await git(["config", "--global", "user.email", "bugboss@goodparty.org"]);
};

// ---------------------------------------------------------------------------
// What a launch says
// ---------------------------------------------------------------------------

export const kickoffMessage = (
  incidentId: string,
  o: { resumedWithoutTranscript?: boolean; handoff?: string } = {},
): string =>
  [
    o.resumedWithoutTranscript
      ? `Incident ${incidentId} is yours, and you have worked it before: an earlier agent on this incident ran under a harness whose transcript did not carry over, so you start without your own history. Everything durable about the incident is below and in get_incident. Call get_incident first, then re-check the state of anything that was in flight -- pull requests, deploys, waits -- before you continue it. Do not start the investigation again from nothing.`
      : `Incident ${incidentId} is yours. Call get_incident to read the signals and the evidence that was prefetched for you, then work it to a conclusion.`,
    ...(o.handoff ? ["", o.handoff] : []),
  ].join("\n");

export const resumeMessage = (checkout: CheckoutOutcome, npmCiFailed: boolean): string =>
  [
    "You are being relaunched on this incident. Time passed since your last turn, and pull requests merge, deploys ship, alerts stop and people fix things by hand in that time. Call get_incident first, re-run only the checks that matter for what you were in the middle of, then continue.",
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

const NEWEST_INBOX_ROWS = 10;

/**
 * The durable story of an incident whose transcript did not survive: what the
 * architecture already keeps outside the context. Rendered whole, for the
 * kickoff's `handoff`.
 */
export const cutoverHandoff = (db: Pick<Db, "get" | "query">, incidentId: string): string => {
  const incident = db.get<Record<string, unknown>>("SELECT * FROM incident WHERE id = ?", [incidentId]);
  const timeline = db.query<TimelineEvent>(
    `SELECT id, kind, occurredAt, recordedAt, summary, evidenceUrl
       FROM incident_timeline_event WHERE incidentId = ? AND kind <> ?
       ORDER BY occurredAt, id`,
    [incidentId, GOAL_VERDICT_KIND],
  );
  const inbox = db
    .query<BossInboxItem>(
      `SELECT id, incidentId, kind, text, createdAt, seenAt FROM boss_inbox
        WHERE incidentId = ? ORDER BY createdAt DESC, id DESC LIMIT ?`,
      [incidentId, NEWEST_INBOX_ROWS],
    )
    .reverse();
  const wait = db.get<{ command: string; waitingFor: string | null; startedAt: number; pings: number }>(
    "SELECT command, waitingFor, startedAt, pings FROM pending_wait WHERE incidentId = ?",
    [incidentId],
  );
  const question = db.get<{ message: string; askedAt: number }>(
    "SELECT message, askedAt FROM pending_question WHERE incidentId = ?",
    [incidentId],
  );
  const at = (ms: number) => new Date(ms).toISOString();
  return [
    "## The incident record",
    "```json",
    JSON.stringify(incident ?? null, null, 2),
    "```",
    "",
    "## The recorded timeline",
    timeline.length
      ? timeline.map((event) => `- ${at(event.occurredAt)} ${event.kind}: ${event.summary}${event.evidenceUrl ? ` (${event.evidenceUrl})` : ""}`).join("\n")
      : "(nothing recorded)",
    "",
    `## The last ${NEWEST_INBOX_ROWS} things the agent told the Boss`,
    inbox.length
      ? inbox.map((row) => `- ${at(row.createdAt)} ${row.kind}:\n${row.text}`).join("\n")
      : "(nothing)",
    "",
    "## Waiting on",
    wait
      ? `A monitor wait since ${at(wait.startedAt)}, ${wait.pings} reminders sent: ${wait.waitingFor ?? wait.command}. Call monitor again with the same condition to resume it.`
      : "No monitor wait was open.",
    question
      ? `A question to the Boss since ${at(question.askedAt)}, unanswered: ${question.message}. Call message_boss again with the same message and wait: true to resume waiting; it will not be asked twice.`
      : "No question to the Boss was open.",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// The extensions
// ---------------------------------------------------------------------------

export interface IncidentAgentDeps {
  db: Db;
  toolApiFor(incidentId: string): ToolApi;
  port(incidentId: string): AgentPort;
  harness: () => BugbossHarness;
  /** The App's installation token as it is right now, refreshed by the composition root. */
  githubToken: () => string | undefined;
  /** The agent's shell allowlist (`agent/shell-env.ts`), without the GitHub token. */
  shellEnv: () => Record<string, string>;
  grafana?: { url: string; token: string; command?: string; args?: string[] };
  workingHours?: WorkingHours;
  /** The incident's whole turn budget: the configured turns plus any granted. */
  maxTurns(incidentId: string): number;
  /** The stage-goal evaluator's model. Absent, every gate runs unjudged. */
  goals?: { client: ModelClient; contextWindow: number };
  workRoot?: string;
  /** How long a review wait settles. Absent means `REVIEW_SETTLE_SECONDS`. */
  reviewSettleSeconds?: number;
  now?: () => number;
}

/** The three extensions, and the shared Grafana process to close on shutdown. */
export type IncidentExtensions = readonly Extension[] & { close(): void };

const textResult = (text: string, usage?: Usage): ToolExecutionResult => ({
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});

/** A refused transition is a tool result the model can correct, never a broken harness. */
const toolResult = (response: ToolResponse<unknown>, usage?: Usage): ToolExecutionResult =>
  textResult(
    `${response.ok ? "ok" : `error: ${response.error ?? "unknown"}`}${
      response.data === undefined ? "" : `\n\n${JSON.stringify(response.data, null, 2)}`
    }`,
    usage,
  );

/**
 * The trust boundary. Pi validates arguments against each tool's TypeBox
 * schema before `execute`, and these add what TypeBox here does not check: a
 * URL is a URL, an epoch is a positive integer, a string is not empty.
 * Without them `reportRootCause({})` reached `args.explainedSignalIds.filter`
 * and came back as "Cannot read properties of undefined" for the model to
 * interpret.
 */
const BODIES = {
  rootCause: z.object({
    cause: z.string().min(1),
    explainedSignalIds: z.array(z.string()),
    usersImpacted: z.number().optional(),
    impactQuery: z.string().optional(),
    impactStartedAt: z.number().int().positive().optional(),
  }),
  proposeMerge: z.object({
    incidentId: z.string().min(1),
    reason: z.string().min(1),
  }),
  // Length is not checked here. The tool API refuses an over-long summary
  // with a sentence the model can act on; a zod max would come back as
  // "String must contain at most 80 character(s)", which names no field and
  // says nothing about what to do instead.
  summary: z.object({
    summary: z.string().min(1),
  }),
  impact: z.object({
    usersImpacted: z.number(),
    query: z.string().min(1),
  }),
  resolved: z.object({
    // A url, because it is rendered as a Slack link and anything else inside
    // `<…>` is a directive: `<!channel>` pages everyone.
    prUrls: z.array(z.url()),
    evidence: z.string().min(1),
  }),
  // Shape only. Empty sections, the five whys' count and practiceChanges'
  // length are refused by the tool API, with a sentence naming the section
  // and what to write instead.
  analysis: z.object({
    atAGlance: z.string(),
    timeline: z.array(
      z.object({
        at: z.string().optional(),
        event: z.string(),
        evidenceUrl: z.url().optional(),
        recordedEventId: z.number().int().optional(),
      }),
    ),
    userImpact: z.string(),
    rootCause: z.string(),
    fiveWhys: z.array(z.object({ why: z.string(), because: z.string() })),
    resolutionActions: z.array(z.string()),
    practiceChanges: z.string(),
    usersImpacted: z.number(),
    impactQuery: z.string().min(1),
    recurrence: z
      .object({
        category: z.enum([
          "previous_fix_wrong",
          "previous_fix_incomplete",
          "alert_is_wrong",
          "fix_never_reached_production",
          "resolution_evidence_too_weak",
          "bugboss_defect",
        ]),
        why: z.string().min(1),
        remedy: z.string().min(1),
      })
      .optional(),
  }),
  search: z.object({
    text: z.string().min(1),
  }),
  timeline: z.object({
    kind: z.enum(TIMELINE_EVENT_KINDS),
    occurredAt: z.number().int().positive(),
    summary: z.string().trim().min(1),
    evidenceUrl: z.url().optional(),
  }),
  park: z.object({
    waitingFor: z.string().min(1),
    wakeAfterSeconds: z.number().int().nonnegative().optional(),
  }),
  getIncident: z.object({
    incidentId: z.string().min(1).optional(),
  }),
  escalate: z.object({
    reason: z.string().min(1),
    brief: z.string().min(1),
  }),
};

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");

type Parsed<S extends z.ZodType> = { ok: true; data: z.infer<S> } | { ok: false; result: ToolExecutionResult };

const parse = <S extends z.ZodType>(schema: S, args: unknown, tool: string): Parsed<S> => {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, data: parsed.data };
  log("invalid_arguments", { tool });
  return { ok: false, result: textResult(`error: invalid arguments: ${describeIssues(parsed.error)}`) };
};

export const createIncidentExtensions = async (
  deps: IncidentAgentDeps,
): Promise<IncidentExtensions> => {
  const { durable, tools: piTools } = await loadPi();
  const { Type } = await import("typebox");
  const workRoot = deps.workRoot ?? DEFAULT_WORK_ROOT;

  /**
   * The incident this conversation works, from its IncidentDoc. A
   * conversation without one is not an incident agent's, and nothing it asks
   * for is done.
   */
  const incidentOf = async (
    api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
    ctx: Context,
  ): Promise<string> => {
    const doc = await api.snapshot(IncidentDoc, api.conversationId, ctx);
    if (!doc?.incidentId) {
      alarm("incident_doc_missing", { conversationId: api.conversationId });
      throw new Error("this conversation is not bound to an incident; nothing was done");
    }
    return doc.incidentId;
  };

  const stages = createStageCompaction({
    harness: deps.harness,
    timeline: async (conversationId) => {
      const incidentId = (await deps.harness().harness.snapshot(IncidentDoc, conversationId, deps.harness().context))
        ?.incidentId;
      if (!incidentId) throw new Error(`conversation ${conversationId} has no incident`);
      return deps.port(incidentId).timelineEvents();
    },
    log: (event, fields) => log(event, fields),
  });

  const budget = createTurnBudget({
    db: deps.db,
    harness: deps.harness,
    maxTurns: deps.maxTurns,
    toolApiFor: deps.toolApiFor,
    port: deps.port,
  });

  const evaluate = deps.goals
    ? createGoalEvaluator({ client: deps.goals.client, contextWindow: deps.goals.contextWindow })
    : null;

  /**
   * The gates' judge, for one incident. Reads the incident the way the agent
   * does and the timeline without side effects; a verdict is a `goal_verdict`
   * row through the tool API, which only this code writes -- the agent's tool
   * refuses the kind.
   */
  const goalsFor = (incidentId: string, conversationId: ConversationId) =>
    evaluate
      ? createStageGoals({
          evaluate,
          context: async () => {
            const view = await deps.toolApiFor(incidentId).getIncident();
            if (!view.ok || !view.data) return { context: null, error: view.error ?? "no data" };
            let timeline: TimelineEvent[];
            try {
              timeline = await deps.port(incidentId).timelineEvents();
            } catch (err: unknown) {
              return { context: null, error: `the timeline could not be read: ${String(err)}` };
            }
            const { incident, signals } = view.data;
            return {
              context: {
                incident,
                signals: signals.map(({ id, kind, source, title, body }) => ({ id, kind, source, title, body })),
                timeline,
              },
            };
          },
          recordVerdict: async (verdict) => {
            const response = await deps.toolApiFor(incidentId).trackTimelineEvent({
              kind: GOAL_VERDICT_KIND,
              occurredAt: (deps.now ?? Date.now)(),
              summary: `${verdict.gate} ${verdict.verdict}: ${verdict.reason}`,
            });
            if (!response.ok) {
              alarm("goal_verdict_timeline_failed", { incidentId, gate: verdict.gate, error: response.error });
            }
          },
          escalate: (reason, brief) => deps.port(incidentId).tellBoss("escalation", `${reason}\n\n${brief}`),
          transcript: async () => {
            const bugboss = deps.harness();
            const conversation = await bugboss.conversation(conversationId);
            return [...(await conversation.context(bugboss.context)).messages];
          },
          log: (event, fields) => log(event, { incidentId, ...fields }),
          alarm: (event, fields) => alarm(event, { incidentId, ...fields }),
        })
      : null;

  // The gate's own arguments go to the evaluator whole: they are the claim it
  // is judging.
  const judged = async (
    incidentId: string,
    conversationId: ConversationId,
    gate: StageGate,
    tool: string,
    params: unknown,
    run: () => Promise<ToolResponse>,
  ): Promise<ToolExecutionResult> => {
    const goals = goalsFor(incidentId, conversationId);
    if (!goals) return toolResult(await run());
    const { response, usage } = await goals.gate(
      gate,
      `The agent called ${tool} with:\n${JSON.stringify(params, null, 2)}`,
      run,
    );
    return toolResult(response, usage);
  };

  const githubRead = createGitHubReadPort({ token: deps.githubToken });
  const githubRuns = createGitHubRunsPort({ token: deps.githubToken });

  const incidentTools: ToolRegistration[] = [
    {
      name: "get_incident",
      description:
        "Re-read an incident, its signals and prefetched evidence. Without an id it is yours: call it first on every start and after any long wait. With one, any other incident; read it before you say two are the same problem.",
      parameters: Type.Object({
        incidentId: Type.Optional(Type.String({ description: "Another incident to read. Omit for your own." })),
      }),
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.getIncident, args, "get_incident");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return toolResult(
          await deps
            .toolApiFor(incidentId)
            .getIncident(body.data.incidentId ? { incidentId: body.data.incidentId } : undefined),
        );
      },
    },
    {
      name: "propose_merge",
      description:
        "Ask for your incident and another to be combined when they are the same problem. Read the other first. They are compared before anything moves and the older keeps the thread; if that is theirs, your signals go there and you are done.",
      parameters: Type.Object({
        incidentId: Type.String({ description: "The incident you believe is the same problem as yours." }),
        reason: Type.String({
          description: "What the two share, specifically: the same mechanism, not the same symptom.",
        }),
      }),
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.proposeMerge, args, "propose_merge");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return toolResult(await deps.toolApiFor(incidentId).proposeMerge(body.data));
      },
    },
    {
      name: "report_root_cause",
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
      // Unsafe: the goal evaluation is a paid model call and the UPDATE guard
      // already refuses a second transition, so an interrupted call comes back
      // as interrupted and the model calls again.
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.rootCause, args, "report_root_cause");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return judged(incidentId, api.conversationId, "root_cause", "report_root_cause", args, async () => {
          const response = await deps.toolApiFor(incidentId).reportRootCause(body.data);
          if (response.ok) {
            try {
              startNpmCi(computePaths(workRoot, incidentId), deps.shellEnv());
            } catch (err: unknown) {
              alarm("npm_ci_start_failed", { incidentId, error: String(err) });
            }
            stages.request(api.conversationId, "root_cause");
          }
          return response;
        });
      },
    },
    {
      name: "search_incidents",
      description:
        "Search the post-mortems, root causes and resolution evidence of RESOLVED and CLOSED incidents, in plain words describing the failure, not a question or SQL. The only way to find the same cause returning under a different alert.",
      parameters: Type.Object({
        text: Type.String({ description: "The failing operation, the component, the error text." }),
      }),
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.search, args, "search_incidents");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return toolResult(await deps.toolApiFor(incidentId).searchIncidents(body.data));
      },
    },
    {
      name: "set_summary",
      description:
        "This incident's title: a few words on what is broken and for whom. It heads the thread and the status board. Set it as soon as you know more than the first alert said, and again whenever it stops being true.",
      parameters: Type.Object({
        summary: Type.String({
          description: "What is broken and for whom, not why and not what you are doing about it.",
        }),
      }),
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.summary, args, "set_summary");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return toolResult(await deps.toolApiFor(incidentId).setSummary(body.data));
      },
    },
    {
      name: "report_impact",
      description:
        "How many users are affected. Call it again as impact grows; people need the current number.",
      parameters: Type.Object({
        usersImpacted: Type.Number(),
        query: Type.String({ description: "The query that produced the number." }),
      }),
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.impact, args, "report_impact");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return toolResult(await deps.toolApiFor(incidentId).reportImpact(body.data));
      },
    },
    {
      name: "report_resolved",
      description:
        "FIXING -> RESOLVED. Only after you have observed the harm stop: a user who repeats exactly what the affected user did is not harmed. Evidence is what you observed, not what you believe the fix does; a quiet alert is not evidence on its own.",
      parameters: Type.Object({
        prUrls: Type.Array(Type.String()),
        evidence: Type.String({ description: "What you observed stop happening, and how." }),
      }),
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.resolved, args, "report_resolved");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return judged(incidentId, api.conversationId, "resolved", "report_resolved", args, () =>
          deps.toolApiFor(incidentId).reportResolved(body.data),
        );
      },
    },
    {
      name: "report_analysis",
      description:
        "RESOLVED -> CLOSED, your last act. The post-mortem as sections; code renders them in a fixed order and adds the agent run. No headings of your own. On a recurrence, `recurrence` is required.",
      parameters: Type.Object({
        atAGlance: Type.String({ description: "2-3 sentences: what broke, who it hurt, that it is fixed." }),
        timeline: Type.Array(
          Type.Object({
            at: Type.Optional(Type.String({ description: "ISO 8601 UTC, e.g. 2026-10-01T02:14:30Z." })),
            event: Type.String(),
            evidenceUrl: Type.Optional(Type.String()),
            recordedEventId: Type.Optional(
              Type.Number({ description: "get_incident timeline id this row describes; its time wins." }),
            ),
          }),
        ),
        userImpact: Type.String(),
        rootCause: Type.String(),
        fiveWhys: Type.Array(Type.Object({ why: Type.String(), because: Type.String() }), {
          description: "Exactly five.",
        }),
        resolutionActions: Type.Array(Type.String(), { description: "Done, not planned." }),
        practiceChanges: Type.String({
          description:
            "About 200 words: development-practice changes that would prevent similar issues. Not follow-up work on this one.",
        }),
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
                description: "Why that resolution did not hold, specifically. Not why the bug happened.",
              }),
              remedy: Type.String({
                description:
                  "What you changed so it does not recur, or that you changed nothing and why. For a bugboss_defect, the change you would make in ops and who you raised it with.",
              }),
            },
            { description: "Required when this incident recurred." },
          ),
        ),
      }),
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.analysis, args, "report_analysis");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return judged(incidentId, api.conversationId, "analysis", "report_analysis", args, () =>
          deps.toolApiFor(incidentId).reportAnalysis(body.data),
        );
      },
    },
    {
      name: ESCALATE_TOOL,
      description:
        "Tell the Boss this incident needs a person, urgently, with your brief; the Boss decides who and how. It changes nothing and does not end your run: you keep working it. Without a root cause, first propose an alert-rule change as a PR or a named piece of missing instrumentation.",
      parameters: Type.Object({
        reason: Type.String(),
        brief: Type.String({
          description: "What I believe now / What I ruled out / What I was about to do / Side effects.",
        }),
      }),
      // Safe because of the memo: a rerun after the brief went up does not
      // send it twice.
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.escalate, args, ESCALATE_TOOL);
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        if ((await api.memo<boolean>("sent", ctx)) === undefined) {
          await deps
            .port(incidentId)
            .tellBoss("escalation", `${body.data.reason}\n\n${body.data.brief}`, { ownBrief: true });
          await api.memo<boolean>("sent", true, ctx);
        }
        return textResult("ok: the Boss has your escalation and brief.");
      },
    },
    {
      name: "track_incident_timeline_event",
      description:
        "Record a key moment in this incident when it happens: first error, impact confirmed, root cause found, mitigated, fix PR opened, merged, deployed, verified. The closer writes the post-mortem timeline from these, and they survive when your context is summarised.",
      parameters: Type.Object({
        kind: Type.Union(
          TIMELINE_EVENT_KINDS.map((kind) => Type.Literal(kind)),
          { description: "fix_pr_opened and fix_merged also summarise your context for the next stage." },
        ),
        occurredAt: Type.Number({
          description: "Epoch millis of when it happened, from the evidence, not when you noticed it.",
        }),
        summary: Type.String({ description: "What happened, in one sentence." }),
        evidenceUrl: Type.Optional(
          Type.String({ description: "A link that shows it: the PR, the Grafana query, the deploy run." }),
        ),
      }),
      // Idempotent on the whole event in the tool API, so a rerun records
      // nothing twice.
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        // The tool API also takes the harness's goal_verdict; the agent may not.
        const kind = String((args as { kind?: unknown }).kind);
        if (!(TIMELINE_EVENT_KINDS as readonly string[]).includes(kind)) {
          return toolResult({
            ok: false,
            error: `unknown timeline event kind ${kind}; use one of ${TIMELINE_EVENT_KINDS.join(", ")}`,
          });
        }
        const body = parse(BODIES.timeline, args, "track_incident_timeline_event");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        const response = await deps.toolApiFor(incidentId).trackTimelineEvent(body.data);
        if (response.ok && response.data) {
          const stage = STAGE_FOR_TIMELINE_KIND[response.data.kind];
          if (stage) stages.request(api.conversationId, stage);
        }
        return toolResult(response);
      },
    },
    {
      name: "park",
      description:
        "Say there is nothing you can do until a person acts, so nothing relaunches you into the same dead end. Not a hand-off: the incident stays yours and a Boss message brings you back. Prefer monitor with awaitingHuman whenever a command can detect the thing; park is for when none can.",
      parameters: Type.Object({
        waitingFor: Type.String({ description: "What has to happen first, in one line." }),
        wakeAfterSeconds: Type.Optional(
          Type.Number({
            description: "Come back anyway after this long. Omit when only a person can end the wait.",
          }),
        ),
      }),
      replay: "safe",
      outputLimits: WHOLE_OUTPUT,
      execute: async (args, api, ctx) => {
        const body = parse(BODIES.park, args, "park");
        if (!body.ok) return body.result;
        const incidentId = await incidentOf(api, ctx);
        return toolResult(await deps.toolApiFor(incidentId).park(body.data));
      },
    },
    await createMonitorTool({
      resolve: async (api, ctx) => {
        const incidentId = await incidentOf(api, ctx);
        const port = deps.port(incidentId);
        return {
          cwd: computePaths(workRoot, incidentId).checkout,
          env: withGitHubToken(deps.shellEnv(), deps.githubToken()),
          github: githubRead,
          ...(deps.reviewSettleSeconds === undefined ? {} : { settleSeconds: deps.reviewSettleSeconds }),
          heartbeat: {
            marker: port,
            boss: port,
            ...(deps.workingHours ? { workingHours: deps.workingHours } : {}),
          },
          ...(deps.now ? { now: deps.now } : {}),
        };
      },
    }),
    await createMessageBossTool({
      resolve: async (api, ctx) => {
        const incidentId = await incidentOf(api, ctx);
        const port = deps.port(incidentId);
        const goals = goalsFor(incidentId, api.conversationId);
        return {
          marker: port,
          boss: port,
          ...(goals ? { checkIn: goals.checkIn } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        };
      },
    }),
    await createRerunCiTool({
      github: githubRuns,
      incidentFor: async (api, ctx) => {
        const incidentId = await incidentOf(api, ctx);
        return { incidentId, boss: deps.port(incidentId) };
      },
    }),
    await createSqlQueryTool({
      portFor: async (api, ctx) => deps.port(await incidentOf(api, ctx)),
      ...(deps.now ? { now: deps.now } : {}),
    }),
  ];
  // The tools array is part of the cached prefix, so its order is fixed by
  // name rather than by the order this file happens to list them in.
  incidentTools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const incident: Extension = {
    name: INCIDENT_EXTENSION,
    tools: incidentTools,
    hooks: [
      durable.hook(durable.GenerationTask, {
        afterResponse: async (message, api, ctx) => {
          if (message.stopReason === "error" || message.stopReason === "aborted") return;
          const doc = await api.snapshot(IncidentDoc, api.conversationId, ctx);
          if (!doc?.incidentId) return;
          await budget.afterResponse({
            conversationId: api.conversationId,
            incidentId: doc.incidentId,
            hasToolCalls: message.content.some((block) => block.type === "toolCall"),
          });
        },
        afterTools: async (_assistant, _results, api, ctx) => {
          const doc = await api.snapshot(IncidentDoc, api.conversationId, ctx);
          if (doc?.incidentId) {
            await budget.afterTools({ conversationId: api.conversationId, incidentId: doc.incidentId });
          }
          await stages.flush(api.conversationId);
        },
      }),
      // bash refuses to wait. Those shapes are nothing but waiting, so the
      // guard never blocks real work; everything subtler is left to the
      // prompt and monitor's description.
      durable.hook(durable.ToolTask, {
        beforeTool: (call) => {
          if (call.name !== "bash") return undefined;
          const reason = pollingRefusal(String((call.arguments as { command?: unknown }).command ?? ""));
          return reason ? { block: reason } : undefined;
        },
      }),
    ],
  };

  const coding: Extension = {
    name: CODING_EXTENSION,
    tools: [
      piTools.createBashTool({
        // Built from nothing on every call: the Boss's environment carries
        // its secrets, and the token is read now rather than at launch so a
        // day-long incident never pushes with an expired one.
        prepare: (execution) => {
          execution.inheritEnv = false;
          execution.env = withGitHubToken(deps.shellEnv(), deps.githubToken());
        },
      }),
      piTools.createEditTool(),
      // A read changes nothing, so a crash mid-read reruns it rather than
      // handing the model an interrupted result to re-ask for.
      { ...piTools.createReadTool(), replay: "safe" },
      piTools.createWriteTool(),
    ] as ToolRegistration[],
  };

  const mcp = deps.grafana
    ? await connectMcpToolset({
        name: "grafana",
        command: deps.grafana.command ?? "uvx",
        args: deps.grafana.args ?? GRAFANA_MCP_ARGS,
        env: {
          GRAFANA_URL: deps.grafana.url,
          GRAFANA_SERVICE_ACCOUNT_TOKEN: deps.grafana.token,
        },
        allowedTools: GRAFANA_READ_TOOLS,
      })
    : null;
  if (!mcp) log("grafana_absent", { note: "no Grafana token, so agents have no Grafana tools" });
  const grafana: Extension = { name: GRAFANA_EXTENSION, tools: mcp?.tools ?? [] };

  return Object.assign([incident, coding, grafana] as const, {
    close: () => mcp?.close(),
  });
};
