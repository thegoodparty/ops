// The composition root. Design spec: bugboss/docs/architecture.md.
//
// Every chunk below is built against an interface and knows nothing about the
// others: ingress does not know triage exists, triage does not know how a
// decision is applied, the tool API does not know what correlation is, and the
// dispatcher does not know what launching an agent means. This file is where
// those seams are joined, and it is the only place that names a real S3
// client, a real Slack workspace or a real model.
//
// That is also what makes bugboss/test/e2e.test.ts possible: it calls
// createBugBoss with the same shape and substitutes four fakes.

import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { S3Client } from "@aws-sdk/client-s3";
import type Database from "better-sqlite3";
import type { Hono } from "hono";

import { Db } from "./db";
import { reconcileSearchIndex } from "./db/search";
import {
  createChildProcessSpawn,
  createDispatcher,
  pickBaseEnv,
  type Dispatcher,
  type SpawnAgent,
  type TickResult,
} from "./dispatcher";
import {
  createIngress,
  createLokiQuery,
  humanSignal,
  HUMAN_SOURCE,
  SLUG_LABEL,
  type GrafanaVerifier,
  type LokiQuery,
  type HumanReport,
  type IngressRegistry,
  type SlackConfig,
  type SlackVerifier,
} from "./ingress";
import {
  createPublicApp,
  createToolApiRoutes,
  startServers,
  DEFAULT_LOOPBACK_PORT,
  DEFAULT_PUBLIC_PORT,
  IngestRejected,
  type BugBossServers,
  type HttpConfig,
} from "./http";
import { parseWorkingHours } from "./agent/tools";
import {
  SLACK_AGENT_BUDGET_MS,
  SlackAgent,
  type ObjectStore,
  type SlackAgentModel,
  type SlackClient,
} from "./slack/agent";
import { createSlackAck } from "./slack/ack";
import type { ChoicePoster, SlackChoiceClick } from "./slack/blocks";
import { mrkdwn, raw, userMention } from "./slack/format";
import {
  createRotationReader,
  createS3ObjectStore,
  createSlackClient,
  createSlackFileUploader,
  type SlackLinker,
} from "./slack/client";
import {
  SlackRelay,
  mentionPrefix,
  stripBotMention,
  type ChoiceRoute,
  type InboundRoute,
  type SlackEvent,
} from "./slack/relay";
import {
  readMentionIntent,
  readReplyIntent,
  type Addressed,
  type IntentDeps,
  type OwnershipClaim,
} from "./slack/intent";
import {
  applyAssign,
  AssignError,
  createToolApi,
  mintAgentToken,
  type AssignResult,
  type Correlator,
  type EvidenceStore,
  type ThreadPoster,
} from "./toolapi";
import {
  publishIncidentReport,
  publishPendingReports,
  type FileUploader,
  type PrStateReader,
  type ReportDeps,
} from "./report";
import {
  TEST_DB_ENV_VAR,
  TEST_DB_READY_DEADLINE_MS,
  awaitTestDatabase,
  resolveTestDatabase,
} from "./testdb";
import {
  addModelUsage,
  createTriage,
  emptyModelUsage,
  ModelRequestFailed,
  usageForLog,
  type ModelClient,
  type ModelReply,
  type ModelToolCall,
  type ModelTurn,
  type ModelUsage,
} from "./triage";
import { resolveBedrockModel } from "./bedrock";
import { createPiModelClient } from "./bedrock/client";
import {
  assertBedrockInvokeModelRouting,
  registerBedrockRouting,
} from "./bedrock/runtime";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { attachedSignalIds } from "./triage/sql";
import {
  readSessionOutcome,
  sessionKeyFor,
  sumSessionUsage,
} from "./agent/session";
import { createInstallationToken, createPrStateReader } from "./github";
import { makeAlarm, makeLog } from "./logging";
import type {
  BugBossConfig,
  Evidence,
  IncidentDigest,
  Directive,
  IncidentStatus,
  IncomingRequest,
  RawSignal,
  Signal,
  SignalAdapter,
  TestDatabase,
  ToolApi,
  TriageDecision,
} from "./types";

const log = makeLog("boss");

const alarm = makeAlarm("boss");

/** Statuses an incident can still take a signal on, or be merged into. */
const OPEN_STATUSES: IncidentStatus[] = ["INVESTIGATING", "FIXING", "RESOLVED"];

export const DEFAULT_TRIAGE_MODEL_ID = "us.anthropic.claude-sonnet-5";

/**
 * How long an agent token outlives the deadline that kills its agent. Wide
 * enough to cover the child's own handoff grace and the tick the parent waits
 * before the backstop, so a token never expires under an agent still working.
 */
const AGENT_TOKEN_GRACE_SECONDS = 600;

/** Per pass. Each one costs a triage call, so a backlog drains over ticks. */
const ORPHAN_SWEEP_LIMIT = 25;

/**
 * How many signals in one delivery triage at once. Sequential, a fifteen
 * alert burst is fifteen 55-second model calls before the last one has an
 * agent. Bounded rather than unbounded because signals in flight are
 * invisible to each other's openIncidents read, so a wide fan-out turns one
 * cause into several incidents: the recoverable direction, since correlation
 * merges them, but not a free one.
 */
const TRIAGE_CONCURRENCY = 5;

/**
 * Where an incident agent's session lives. Chunk 5's own default writes to
 * `sessions/<id>.jsonl`, but the Slack agent's read_agent_session tool and
 * the S3 lifecycle rule both read `sessions/incident/<id>/`, so the launch
 * below passes this explicitly.
 *
 * The agent's own copy, rather than a second literal: the Boss reads this
 * key back to sum the run's tokens, so a drift between the two would show up
 * as a free incident and nothing else.
 */
export const incidentSessionKey = sessionKeyFor;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Outbound credentials and workspace ids. Read from Secrets Manager in prod. */
export interface BugBossSecrets {
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackBotUserId?: string;
  /** Slack user-group id for the rotation. Null falls back to <!here>. */
  slackRotationGroupId?: string;
  /**
   * The channel incidents open threads in. Config rather than a credential,
   * but it lives here because it is something a person knows and Pulumi does
   * not, so the task definition has no way to supply it.
   */
  slackChannelId?: string;
  grafanaWebhookSecret?: string;
  grafanaBasicAuthPassword?: string;
  grafanaUrl?: string;
  grafanaServiceAccountToken?: string;
  /** The agent's GitHub App token. Opens PRs; cannot merge. */
  /** GitHub App, so the agent can re-mint its own token over a long run. */
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
  triageModelId?: string;
  intentModelId?: string;
  agentModelId?: string;
  awsRegion?: string;
}

export interface CreateBugBossOptions {
  config: BugBossConfig;
  /**
   * Who is on the rotation right now. Absent until a rotation group exists,
   * which is the honest state rather than a default worth inventing.
   */
  rotationMembers?: () => Promise<string[] | null>;
  /**
   * Runs an alert's known-cause LogQL. Injected rather than constructed here
   * because its credentials arrive in the secret blob, which only the
   * entrypoint has merged.
   */
  loki?: LokiQuery;
  /** The Boss's own bounded calls: triage, correlation, the Slack agent. */
  model: ModelClient;
  /**
   * Reads what an inbound Slack message means. Defaults to `model`, because
   * this is the same shape of bounded call triage makes and the prompt is a
   * few hundred tokens; a smaller model belongs here the moment one is
   * subscribed, which is what BUGBOSS_INTENT_MODEL_ID is for.
   */
  intentModel?: ModelClient;
  slack: BossSlackClient;
  /** What a launch means. Defaults to a child process. */
  spawnAgent?: SpawnAgent;
  /** Omitted means no S3: state stays in memory and dies with the process. */
  s3?: S3Client;
  /** Overrides the default harness the Slack agent runs on. */
  slackAgentModel?: SlackAgentModel;
  /**
   * Uploads the closing report into an incident thread. Absent means the
   * report is posted as text instead, which is the fallback and not a
   * failure: a workspace where `files:write` was never granted still gets
   * every word of it.
   */
  fileUploader?: FileUploader;
  /**
   * Looks up what became of the PRs an agent opened, for the closing report.
   * Absent leaves every PR rendered as "state not known".
   */
  prStates?: PrStateReader;
  secrets?: BugBossSecrets;
  http?: HttpConfig;
  /**
   * TEST ONLY. Replaces webhook signature verification outright, which is how
   * a public endpoint becomes an open one. bugBossFromEnv never sets it, and
   * setting it logs an alarm on every boot.
   */
  insecureTestVerifiers?: {
    grafana?: GrafanaVerifier;
    slack?: SlackVerifier;
  };
  now?: () => number;
}

export type PlacedAction =
  | "new_incident"
  | "attach"
  | "suppress"
  | "duplicate"
  | "failed";

export interface PlacedSignal {
  /** Null only when the signal could not be recorded at all. */
  signalId: string | null;
  /** Null when the signal was suppressed or could not be placed. */
  incidentId: string | null;
  action: PlacedAction;
  reason: string;
}

/**
 * A delivery whose rows are durable and whose placement is still running.
 * Recording is what makes a retry of the same delivery collapse, so it is the
 * only part a webhook has to wait for; triage is tens of seconds per signal
 * and would outlast every timeout between us and the source.
 */
export interface AcceptedIngest {
  /** Signal rows written or matched by dedup, before the response goes out. */
  recorded: number;
  /** Prefetch, triage and assign for each of them. Does not reject. */
  settled: Promise<PlacedSignal[]>;
}

/** The same split for Slack: the relay is synchronous, the agent is not. */
export interface AcceptedSlackEvent {
  routed: InboundRoute["kind"];
  /** The Slack agent's answer, when the event earned one. */
  settled: Promise<void>;
}

/** A button press: recorded inside the ack, acknowledged in the thread after. */
export interface AcceptedSlackInteraction {
  routed: ChoiceRoute["kind"];
  settled: Promise<void>;
}

export interface BugBoss {
  readonly db: Db;
  readonly dispatcher: Dispatcher;
  readonly relay: SlackRelay;
  readonly ingress: IngressRegistry;
  /** Webhooks and health. start() binds it; it is servable on its own. */
  readonly publicApp: Hono;
  /** The agent tool API. Bound to 127.0.0.1 by start(). */
  readonly loopbackApp: Hono;
  /** The bearer a child is handed. Also how a test drives the loopback API. */
  mintToken(incidentId: string): string;
  /** Scoped to one incident by the token, which the caller may supply. */
  toolApiFor(incidentId: string, token?: string): ToolApi;
  ingest(source: string, req: IncomingRequest): Promise<PlacedSignal[]>;
  /** Record now, place after. What the webhook route calls. */
  ingestAccepted(source: string, req: IncomingRequest): Promise<AcceptedIngest>;
  /** An already-verified Slack Events payload: relay it, then answer it. */
  slackEvent(event: SlackEvent): Promise<void>;
  /** Relay now, answer after. What the webhook route calls. */
  slackEventAccepted(event: SlackEvent): Promise<AcceptedSlackEvent>;
  /** Record a verified button press, then say so in the thread. */
  slackInteractionAccepted(
    click: SlackChoiceClick,
  ): Promise<AcceptedSlackInteraction>;
  /** One dispatcher tick, waited out. Agents normally outlive a tick. */
  dispatchOnce(): Promise<TickResult>;
  /** Ask every adapter whether its signal stopped. Never moves an incident. */
  /** Re-place signals that reached no incident. Returns how many moved. */
  sweepOrphans(): Promise<number>;
  /** Open a Slack thread for any incident still without one. */
  ensureIncidentThreads(): Promise<number>;
  /** Post the closing report for any incident that closed without one. */
  sweepReports(): Promise<number>;
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Stand-ins for the two external services that have no local mode
// ---------------------------------------------------------------------------

/**
 * A whole-object S3 in memory, so a caller that passes no client still gets
 * the real write path: VACUUM INTO, a PUT that must succeed before withWrite
 * resolves, and evidence that loads back out.
 */
export const createMemoryS3 = (): S3Client => {
  const objects = new Map<string, Buffer>();
  const send = async (command: {
    constructor: { name: string };
    input: {
      Key?: string;
      Body?: Buffer | string | Uint8Array;
      Prefix?: string;
    };
  }) => {
    const key = command.input.Key ?? "";
    switch (command.constructor.name) {
      case "GetObjectCommand": {
        const body = objects.get(key);
        if (!body) {
          const missing = new Error(`no such key: ${key}`);
          missing.name = "NoSuchKey";
          throw missing;
        }
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array(body),
            transformToString: async () => body.toString("utf8"),
          },
        };
      }
      case "PutObjectCommand": {
        const body = command.input.Body;
        objects.set(
          key,
          Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? "")),
        );
        return {};
      }
      case "ListObjectsV2Command": {
        const prefix = command.input.Prefix ?? "";
        return {
          Contents: [...objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .sort()
            .map((Key) => ({ Key })),
          IsTruncated: false,
        };
      }
      default:
        return {};
    }
  };
  return { send } as unknown as S3Client;
};

/**
 * The Boss's model seam, built on the runtime the incident agent streams
 * through.
 *
 * It used to build its own InvokeModel body here, which made two request
 * paths to the same model: a fix to one was a fix missing from the other, and
 * that is how an absent beta header killed every incident agent while triage
 * carried on working. One path now, so the Boss's own calls inherit the
 * InvokeModel routing, the 1h cache retention and its downgrade check, and
 * `calculateCost` -- which is what finally prices a triage decision.
 *
 * Async because pi-ai is ESM-only and this package is CommonJS, so the
 * runtime is reached through a dynamic import.
 */
/**
 * One runtime for every Boss client.
 *
 * Memoized because `ModelRuntime.create` reads auth and the model catalog off
 * disk and may refresh it over the network, and the Boss builds two clients
 * at boot -- the triage model and, when one is named, a separate intent
 * model. Two runtimes would do that work twice and wrap the same builtin
 * provider twice for no gain. `registerBedrockRouting` is idempotent per
 * runtime, so sharing one is also what keeps the router single-layered.
 */
let bossRuntime: Promise<ModelRuntime> | null = null;

const sharedBossRuntime = (): Promise<ModelRuntime> => {
  if (!bossRuntime) {
    bossRuntime = (async () => {
      const pi = await import("@earendil-works/pi-coding-agent");
      const runtime = await pi.ModelRuntime.create({});
      await registerBedrockRouting({ runtime });
      return runtime;
    })();
  }
  return bossRuntime;
};

export const createBossModelClient = async (
  cfg: { modelId: string },
): Promise<ModelClient> => {
  const runtime = await sharedBossRuntime();
  const model = await resolveBedrockModel({ id: cfg.modelId });

  // Before the first request rather than after a bad one. Converse silently
  // reshapes what it cannot carry, so a misroute here is not an error, it is
  // a quietly different request -- and the agent's own launch asserts this
  // for the same reason. Per model rather than per runtime, because the id
  // is what carries the api.
  assertBedrockInvokeModelRouting(runtime, model);

  return createPiModelClient({ runtime, model });
};

/**
 * Sent when the turn budget runs out with tool calls still outstanding.
 * Everything the run read is still in the transcript, and throwing it away to
 * post an apology is a silent failure wearing a message: the person waited,
 * the work was paid for, and they learn nothing. So one more call, with no
 * tools, turns what it already has into an answer that names its own gaps.
 *
 * It rides on the system prompt rather than as a final user turn, because the
 * transcript at that point ends in tool results -- which are a user message --
 * and a second one behind them is a shape nothing here needs to produce.
 */
const WRAP_UP_SYSTEM = [
  "You have used your whole turn budget. This is your last message and you cannot call another tool.",
  "Answer the question now from what you have already read. Say what you found, and say plainly which part of the question you did not reach.",
  "Do not apologise and do not offer to keep looking.",
].join(" ");

/** "about 4 minutes", "under a minute" -- scale, not a measurement. */
const roughly = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
};

/**
 * Reached only when the wrap-up produced nothing either, so the reader gets
 * this instead of an answer they waited minutes for.
 *
 * Running out of steps and failing to compose anything are two different
 * events and the reply has to say which, because the advice differs. Running
 * out is deterministic in the question: the same question spends the budget
 * the same way, so "ask me again" is advice that buys another four-minute
 * wait for the same non-answer. What helps is a smaller question, and the
 * reply says so and says how. The other case really can be a bad minute, and
 * there asking again is the right thing to try.
 *
 * Neither sends anybody to the logs. The person reading this is on call in the
 * middle of something else; a pointer to a log group is a second task, and
 * whoever owns the budget already has the alarm.
 */
const noAnswerReply = (
  exhausted: boolean,
  turns: number,
  elapsedMs: number,
): string =>
  exhausted
    ? `I ran out of steps before I could answer that: ${turns} of them, taking ${roughly(elapsedMs)}, and I still could not put anything together worth posting. Asking the same question again spends the same budget the same way, so narrow it instead: one incident, or one specific thing you want to know about all of them.`
    : "I could not put an answer together for that one, and I have nothing partial worth posting. Ask me again, or narrow it to one incident.";

/**
 * The Slack agent's harness, built on the same ModelClient everything else
 * here uses. The transcript is persisted per thread so a follow-up mention
 * resumes rather than restarts.
 *
 * It does not carry thinking blocks across a resume the way the incident
 * agent's Pi session does: ModelReply has nowhere to put a signature. That is
 * a deliberate floor for a read-only question box, not an oversight.
 */
export const createSlackAgentModel = (
  model: ModelClient,
  store: ObjectStore,
): SlackAgentModel => ({
  run: async (req) => {
    const key = `${req.sessionKey}transcript.json`;
    let messages: ModelTurn[] = [];
    if (!req.fresh) {
      const stored = await store.get(key);
      if (stored) {
        try {
          messages = JSON.parse(stored) as ModelTurn[];
        } catch {
          messages = [];
        }
      }
    }
    messages.push({ role: "user", text: req.input });

    const tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    let answer = "";
    let exhausted = false;
    // Every request this run makes, banked as it returns. In place and
    // outside the loop because a throw on turn nine has still spent the
    // first eight turns, and the caller reads this beside the answer.
    const usage = emptyModelUsage();
    // What the reader is owed when nothing else survives the run: how long
    // they waited, alongside how many steps bought it.
    const startedAt = Date.now();
    for (let turn = 0; turn < req.maxTurns; turn++) {
      let reply: ModelReply;
      try {
        reply = await model.complete({
          system: req.system,
          messages: [...messages],
          tools,
          maxTokens: 4096,
          signal: AbortSignal.timeout(SLACK_AGENT_BUDGET_MS),
        });
      } catch (err) {
        if (err instanceof ModelRequestFailed) addModelUsage(usage, err.usage);
        throw err;
      }
      addModelUsage(usage, reply.usage);
      messages.push({
        role: "assistant",
        text: reply.text,
        toolCalls: reply.toolCalls,
      });
      if (reply.text) answer = reply.text;
      if (reply.toolCalls.length === 0) break;

      for (const call of reply.toolCalls) {
        const tool = req.tools.find((t) => t.name === call.name);
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          isError: !tool,
          text: tool
            ? await tool.run(call.input)
            : `Unknown tool ${call.name}.`,
        });
      }
      exhausted = turn === req.maxTurns - 1;
    }

    // Loud, because a question that needed more turns than it was given is
    // how somebody gets a partial answer, and the budget is the thing to
    // change. The tool results from the last turn are already on the
    // transcript, so the wrap-up reads them before it writes.
    if (exhausted) {
      alarm("slack_agent_turns_exhausted", {
        sessionKey: req.sessionKey,
        turns: req.maxTurns,
      });
      try {
        const wrapUp = await model.complete({
          system: `${req.system}\n\n${WRAP_UP_SYSTEM}`,
          messages: [...messages],
          tools: [],
          maxTokens: 4096,
          signal: AbortSignal.timeout(SLACK_AGENT_BUDGET_MS),
        });
        addModelUsage(usage, wrapUp.usage);
        messages.push({
          role: "assistant",
          text: wrapUp.text,
          toolCalls: wrapUp.toolCalls,
        });
        if (wrapUp.text) {
          answer = wrapUp.text;
        } else {
          // An empty completion is not an exception, so `wrap_up_failed` does
          // not see it -- and the outcome is the worse of the two: a whole
          // run's reading sits on the transcript and the reader still gets
          // the apology. Production reached this holding 24 turns of incident
          // data. Nothing here can make the model speak, but a silent hole
          // between a run that read everything and a reply that says nothing
          // is the one shape this system does not allow.
          alarm("slack_agent_wrap_up_empty", { sessionKey: req.sessionKey });
        }
      } catch (err) {
        if (err instanceof ModelRequestFailed) addModelUsage(usage, err.usage);
        alarm("slack_agent_wrap_up_failed", {
          sessionKey: req.sessionKey,
          error: String(err),
        });
      }
    }

    const text =
      answer || noAnswerReply(exhausted, req.maxTurns, Date.now() - startedAt);
    if (!answer) alarm("slack_agent_no_answer", { sessionKey: req.sessionKey });

    // The transcript has to end on the assistant, because that is how the
    // conversation ended: whatever is returned here is posted in the thread.
    // A resume loads this and pushes the next question straight behind it, so
    // a transcript left ending in tool results -- which a failed or skipped
    // wrap-up does -- puts two user turns together and the next mention
    // cannot load at all. That break surfaces hours later in another process
    // with nothing pointing back at the run that caused it, so it is closed
    // by construction rather than on the one branch that was noticed.
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") {
      messages.push({ role: "assistant", text, toolCalls: [] });
    }

    await store.put(key, JSON.stringify(messages));
    return { text, usage };
  },
});

/**
 * @slack/web-api defaults to tenRetriesInAboutThirtyMinutes with
 * rejectRateLimitedCalls off, so a 429 pauses the SDK's queue and raises
 * nothing while it retries. Every lifecycle post goes to one channel and
 * chat.postMessage is throttled per channel, so that is reachable at fifteen
 * concurrent agents, and it would otherwise stall whatever awaited the post.
 * This bounds the wait, not the call: the SDK keeps retrying underneath.
 */
const SLACK_CALL_TIMEOUT_MS = 10_000;

const withDeadline = <T>(work: Promise<T>, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`slack ${what} exceeded ${SLACK_CALL_TIMEOUT_MS}ms`)),
      SLACK_CALL_TIMEOUT_MS,
    );
    timer.unref();
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
};

/**
 * Everything the Boss needs from Slack: posts, buttons, thread reads, and the
 * permalink a merged or split incident links the other thread by.
 */
export type BossSlackClient = SlackClient & ChoicePoster & SlackLinker;

export const withSlackDeadline = (slack: BossSlackClient): BossSlackClient => ({
  post: (threadTs, text, channel) =>
    withDeadline(slack.post(threadTs, text, channel), "chat.postMessage"),
  react: (channel, ts, name) =>
    withDeadline(slack.react(channel, ts, name), "reactions.add"),
  postChoice: (threadTs, text, blocks) =>
    withDeadline(slack.postChoice(threadTs, text, blocks), "chat.postMessage"),
  permalink: (messageTs, channel) =>
    withDeadline(slack.permalink(messageTs, channel), "chat.getPermalink"),
  replies: (args) => withDeadline(slack.replies(args), "conversations.replies"),
});

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

export const createBugBoss = async (
  options: CreateBugBossOptions,
): Promise<BugBoss> => {
  const { config } = options;
  const now = options.now ?? Date.now;
  const secrets = options.secrets ?? {};

  if (options.insecureTestVerifiers) {
    alarm("insecure_test_verifiers_enabled", {
      note: "webhook signature verification is replaced; this must never be set in production",
    });
  }
  if (!options.s3) {
    alarm("no_s3_client", {
      bucket: config.s3Bucket,
      note: "running against an in-memory object store; nothing survives this process",
    });
  }

  // Everything here talks to Slack through this, so no single stalled post
  // can hold the placement loop, the tool API or a resolution tick.
  const slack = withSlackDeadline(options.slack);

  const s3 = options.s3 ?? createMemoryS3();
  const db = await Db.open({
    path: config.dbPath,
    bucket: config.s3Bucket,
    key: "state/db",
    s3,
  });
  const store = createS3ObjectStore(config.s3Bucket, s3);

  // The search index is derived state, so it is rebuilt from the incidents
  // rather than migrated. That is what makes a corpus older than the table
  // searchable at all -- schema.sql runs over a restored snapshot, so the
  // first boot after this ships finds an empty index and a full history --
  // and it repairs anything a transition failed to write, which keeps the
  // per-transition index a fast path rather than a single point of loss.
  try {
    const { indexed } = await reconcileSearchIndex(db);
    if (indexed > 0) log("search_index_backfilled", { indexed });
  } catch (err) {
    // Not fatal: every other job still works, and the next boot tries again.
    // Loud, though, because the visible symptom is a search that quietly
    // finds nothing, which reads exactly like a problem that has never
    // happened before.
    alarm("search_index_backfill_failed", {
      error: String(err),
      note: "recurrence search may miss incidents closed before this boot",
    });
  }

  // -------------------------------------------------------------------------
  // Ingress
  // -------------------------------------------------------------------------

  const slackIngress: SlackConfig = {
    signingSecret: secrets.slackSigningSecret,
    botUserId: secrets.slackBotUserId,
    isIncidentThread: (_channel, threadTs) =>
      db.get("SELECT id FROM incident WHERE slackThreadTs = ?", [threadTs]) !==
      undefined,
    verifier: options.insecureTestVerifiers?.slack,
  };

  const ingress = createIngress({
    grafana: {
      secret: secrets.grafanaWebhookSecret,
      basicAuthPassword: secrets.grafanaBasicAuthPassword,
      verifier: options.insecureTestVerifiers?.grafana,
      loki: options.loki,
    },
  });

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  const evidenceKey = (signalId: string) => `evidence/${signalId}.json`;

  const evidence: EvidenceStore = {
    load: async (incidentId) => {
      const ids = db
        .query<{ id: string }>(
          "SELECT id FROM signal WHERE incidentId = ? ORDER BY openedAt, id",
          [incidentId],
        )
        .map((row) => row.id);
      const loaded: Evidence[] = [];
      for (const id of ids) {
        const body = await store.get(evidenceKey(id));
        if (body) loaded.push(...(JSON.parse(body) as Evidence[]));
      }
      return loaded;
    },
  };

  // -------------------------------------------------------------------------
  // Slack
  // -------------------------------------------------------------------------

  const relay = new SlackRelay({
    db,
    slack,
    config: {
      channelId: config.slackChannelId,
      botUserId: secrets.slackBotUserId ?? "",
      rotationGroupId: secrets.slackRotationGroupId ?? null,
    },
  });

  const slackAgent = new SlackAgent({
    db,
    store,
    slack,
    model: options.slackAgentModel ?? createSlackAgentModel(options.model, store),
    config: {
      botUserId: secrets.slackBotUserId ?? "",
      // The Slack agent's fallback for a failure the thread cannot carry.
      // Both values are already computed for the relay above; leaving them
      // unset made that whole path unreachable in production.
      alertChannel: config.slackChannelId,
      rotationGroupId: secrets.slackRotationGroupId ?? null,
    },
  });

  /**
   * Reads what an inbound message means, for every interface a person talks
   * to. One bounded call per message, off the Slack ack, on the same model
   * seam triage uses -- a few hundred tokens in and a label out, so the bill
   * is set by how much people type rather than by how many alerts fire.
   */
  const intent: IntentDeps = { model: options.intentModel ?? options.model };

  // The relay's, so the two pings are spelled one way and carry the same
  // trailing space.
  const mention = mentionPrefix(secrets.slackRotationGroupId ?? null);

  /**
   * A thread belongs to an incident, not to the ingest that happened to open
   * one. reportRootCause splits unexplained signals into incidents of their
   * own without passing anywhere near ingest, and a post that fails leaves an
   * incident threadless for good; in both cases the agent posts top level and
   * contact_human can never be answered, because answering it is matching a
   * reply against slackThreadTs. So this keys off the incident and retries.
   */
  let threading: Promise<unknown> = Promise.resolve();

  const ensureIncidentThreads = (): Promise<number> => {
    const run = threading.catch(() => undefined).then(async () => {
      const rows = db.query<{ id: string }>(
        `SELECT id FROM incident
         WHERE slackThreadTs IS NULL
           AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})
         ORDER BY firstSignalAt`,
        OPEN_STATUSES,
      );

      let opened = 0;
      for (const row of rows) {
        const signals = db.query<{ title: string }>(
          "SELECT title FROM signal WHERE incidentId = ? ORDER BY openedAt, id",
          [row.id],
        );
        try {
          await relay.emit({
            type: "opened",
            incidentId: row.id,
            title: signals[0]?.title ?? `Incident ${row.id}`,
            signalCount: signals.length,
          });
          opened++;
        } catch (err) {
          alarm("open_post_failed", { incidentId: row.id, error: String(err) });
        }
      }
      return opened;
    });
    threading = run.catch(() => undefined);
    return run;
  };

  // -------------------------------------------------------------------------
  // Triage, correlation and the tool API
  // -------------------------------------------------------------------------

  const triage = createTriage({ model: options.model, db });

  const openIncidents = (): IncidentDigest[] => {
    const rows = db.query<{
      id: string;
      status: IncidentStatus;
      rootCause: string | null;
      firstSignalAt: number;
    }>(
      // Status is where the work is, owner is who has it, and they are
      // orthogonal. assign refuses a boss-actor write into a human-owned
      // incident, so offering one as an attach or merge candidate can only
      // produce a refusal -- triage would propose it, the assign would throw,
      // and the retry below would open the new incident anyway.
      `SELECT id, status, rootCause, firstSignalAt FROM incident
       WHERE status IN ('INVESTIGATING','FIXING','RESOLVED') AND owner = 'agent'
       ORDER BY firstSignalAt`,
    );
    if (rows.length === 0) return [];

    // Scoped to the incidents just selected, not every attached signal ever.
    // Unbounded, this grows with every incident the system has ever closed,
    // and it runs once per inbound signal.
    const titles = new Map<string, string[]>();
    for (const row of db.query<{ incidentId: string; title: string }>(
      `SELECT incidentId, title FROM signal
       WHERE incidentId IN (${rows.map(() => "?").join(",")})
       ORDER BY openedAt, id`,
      rows.map((row) => row.id),
    )) {
      const list = titles.get(row.incidentId) ?? [];
      list.push(row.title);
      titles.set(row.incidentId, list);
    }

    const at = now();
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      rootCause: row.rootCause,
      signalTitles: titles.get(row.id) ?? [],
      ageSeconds: Math.max(0, Math.round((at - row.firstSignalAt) / 1000)),
    }));
  };

  const correlator: Correlator = {
    correlate: async ({ incidentId, rootCause }) => {
      const result = await triage.correlate({
        incidentId,
        rootCause,
        // Everything still attached is explained by definition: the tool API
        // split the rest out in the same transaction as the transition.
        explainedSignalIds: attachedSignalIds(db, incidentId),
        openIncidents: openIncidents(),
      });
      if (result.splits.length > 0) {
        alarm("correlation_splits_ignored", {
          incidentId,
          splits: result.splits.length,
          note: "the tool API already split on explainedSignalIds; this should be empty",
        });
      }
      return result.merges.map((merge) => ({
        absorb: merge.incidentId,
        into: merge.into,
        reason: merge.reason,
      }));
    },
  };

  // Process-scoped, so a token cannot outlive the agents it was minted for:
  // a restart kills every child and invalidates every token it handed out.
  const tokenSecret = randomBytes(32).toString("hex");
  // Sized to the run, not to the process. Restart-scoped revocation does not
  // cover the case the threat model names — a child leaking its token keeps a
  // working credential against the still-running Boss — so the token expires
  // shortly after the deadline that kills the agent holding it.
  const tokenTtlSeconds =
    config.dispatcher.agentTimeoutSeconds + AGENT_TOKEN_GRACE_SECONDS;
  const mintToken = (incidentId: string) =>
    mintAgentToken(tokenSecret, { incidentId, attempt: 0 }, tokenTtlSeconds);

  /**
   * Slack as the tool API needs it. Opening a thread is the relay's job and
   * the tool API cannot reach the relay, but a split creates incidents that
   * have to be pointed at and posted into before anyone can follow them, so
   * the capability is handed over rather than the relay.
   */
  const threads: ThreadPoster = {
    post: (threadTs, text) => slack.post(threadTs, text),
    permalink: (messageTs) => slack.permalink(messageTs),
    openThreads: ensureIncidentThreads,
  };

  const toolApiFor = (incidentId: string, token?: string): ToolApi => {
    const api = createToolApi({
      db,
      token: token ?? mintToken(incidentId),
      tokenSecret,
      correlator,
      slack: threads,
      evidence,
    });

    return {
      ...api,
      // The only transition that has to reach the rotation. The tool API
      // posts the brief itself; this adds the ping, which is the one thing it
      // cannot know to do.
      handOff: async (args) => {
        const response = await api.handOff(args);
        if (response.ok) {
          await slack
            .post(
              db.get<{ slackThreadTs: string | null }>(
                "SELECT slackThreadTs FROM incident WHERE id = ?",
                [incidentId],
              )?.slackThreadTs ?? null,
              mrkdwn`${raw(mention)}*Incident ${incidentId} needs a human* · ${args.reason}`,
            )
            .catch((err: unknown) =>
              alarm("escalation_ping_failed", {
                incidentId,
                error: String(err),
              }),
            );
        }
        return response;
      },
    };
  };

  // -------------------------------------------------------------------------
  // Placing a signal: dedup, prefetch, triage, assign
  // -------------------------------------------------------------------------

  /** Signals whose placement is running right now, so nothing double-places. */
  const placing = new Set<string>();

  interface RecordedSignal {
    id: string;
    incidentId: string | null;
    /** False when this delivery has nothing left to decide. */
    needsPlacement: boolean;
  }

  const recordSignal = async (signal: RawSignal): Promise<RecordedSignal> => {
    // One transaction, so the id and the uniqueness check cannot race two
    // concurrent deliveries of the same alert.
    const row = await db.withWrite((w: Database.Database) => {
      const exists = w
        .prepare(
          `SELECT id, incidentId, explained FROM signal
             WHERE source = ? AND sourceId = ? AND closedAt IS NULL`,
        )
        .get(signal.source, signal.sourceId) as
        | { id: string; incidentId: string | null; explained: number }
        | undefined;
      if (exists) return { ...exists, fresh: false };

      const max = w
        .prepare(
          "SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS n FROM signal WHERE id LIKE 'sig-%'",
        )
        .get() as { n: number | null };
      const id = `sig-${(max.n ?? 0) + 1}`;
      w.prepare(
        `INSERT INTO signal
           (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt, closedAt, incidentId, explained)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
      ).run(
        id,
        signal.source,
        signal.sourceId,
        signal.kind,
        signal.title,
        signal.body,
        JSON.stringify(signal.labels),
        signal.reportedBy,
        signal.openedAt,
      );
      return { id, incidentId: null, explained: 0, fresh: true };
    });

    // A re-delivery of a signal that never reached an incident is the last
    // chance anything has to place it, so it falls through rather than
    // answering "duplicate" to a signal nobody is working. explained on an
    // unattached row marks a suppression, which is a decision, not a gap.
    const needsPlacement =
      !placing.has(row.id) &&
      (row.fresh || (row.incidentId === null && row.explained === 0));
    if (needsPlacement) placing.add(row.id);
    return { id: row.id, incidentId: row.incidentId, needsPlacement };
  };

  /**
   * Triage decided against an openIncidents read taken before a model call
   * that runs for tens of seconds, so its target can have been merged away or
   * closed while it was thinking. NEW is where triage already falls back on a
   * timeout or bad output, so a vanished target takes the same conservative
   * direction instead of throwing and stranding the signal.
   */
  const assignPlacement = async (
    signalId: string,
    decision: TriageDecision,
    recurrenceOf: string | null,
  ): Promise<AssignResult> => {
    const target = decision.action === "attach" ? decision.incidentId : "NEW";
    const req = { signalIds: [signalId], target, reason: decision.reason };
    // Read before the assign rather than inside it: a Slack user group is
    // mutable and keeps no history, so the moment an incident opens is the
    // only moment this answer exists. Ignored when the target is an existing
    // incident, which already carries its own snapshot.
    const rotationAtOpen = (await options.rotationMembers?.()) ?? undefined;
    const opts = {
      ...(recurrenceOf ? { recurrenceOf } : {}),
      ...(rotationAtOpen ? { rotationAtOpen } : {}),
    };
    try {
      return await applyAssign(db, req, { kind: "boss" }, opts);
    } catch (err) {
      if (target === "NEW" || !(err instanceof AssignError)) throw err;
      alarm("assign_target_vanished", {
        signalId,
        target,
        error: String(err),
      });
      return applyAssign(db, { ...req, target: "NEW" }, { kind: "boss" }, opts);
    }
  };

  /**
   * Accumulate rather than replace, which is the opposite of how the incident
   * row is written. `rollUpUsage` re-reads a whole session file, so its total
   * is already absolute and a SET is correct there. Here each triage decision
   * knows only what it spent, and a signal can be triaged more than once: a
   * re-delivery of a signal nothing ever placed falls through to be placed
   * again, and both attempts were paid for.
   *
   * Every counter at zero with calls above zero is the drift signature the
   * columns exist to expose, so it alarms rather than writing a free
   * decision. Zero calls is not a fault at all -- triage and correlation both
   * short-circuit before the model on some paths.
   *
   * It is its own `withWrite`, so it is its own S3 snapshot PUT on top of the
   * one placement already costs. Worth naming rather than hiding: the write
   * queue serializes on those, and this adds one per triaged signal. It is
   * bought against a decision that just spent tens of seconds of model time,
   * so a few hundred milliseconds behind the queue is not the expensive part
   * of placing a signal -- and folding it into the two branches downstream
   * would put triage's accounting inside `applyAssign`, which has no business
   * knowing about it.
   */
  const recordTriageSpend = async (
    signalId: string,
    usage: ModelUsage,
  ): Promise<void> => {
    if (usage.calls === 0) return;

    // Summed over all four counters, matching `rollUpUsage` below, and not a
    // test on `tokensOut` alone. A request aborted after the provider
    // reported its input but before it reported any output really does have
    // output at zero, and those input tokens were really spent -- which is
    // the timeout path this accounting exists to capture. Alarming on it
    // would both cry wolf and refuse to write real spend. Every counter at
    // zero is the shape that cannot happen for a request that reached the
    // model, so that is the one worth alarming on.
    const total =
      usage.tokensIn + usage.tokensOut + usage.cacheRead + usage.cacheWrite;
    if (total === 0) {
      alarm("triage_usage_missing", {
        signalId,
        ...usageForLog(usage),
        note: "a request reached the model and reported no tokens at all, which means this reader has drifted from what the provider returns",
      });
      return;
    }
    try {
      await db.withWrite((w: Database.Database) => {
        w.prepare(
          `UPDATE signal
             SET tokensIn = tokensIn + ?, tokensOut = tokensOut + ?,
                 cacheRead = cacheRead + ?, cacheWrite = cacheWrite + ?,
                 modelCalls = modelCalls + ?,
                 modelId = COALESCE(?, modelId)
           WHERE id = ?`,
        ).run(
          usage.tokensIn,
          usage.tokensOut,
          usage.cacheRead,
          usage.cacheWrite,
          usage.calls,
          usage.modelId,
          signalId,
        );
      });
    } catch (err) {
      // Never fatal. Losing the record of what a decision cost is worth
      // strictly less than dropping the signal that decision was about.
      alarm("triage_usage_write_failed", { signalId, error: String(err) });
    }
  };

  const placeRecorded = async (
    signalId: string,
    signal: RawSignal,
    adapter: SignalAdapter,
  ): Promise<PlacedSignal> => {
    // Deterministic and free of agent turns, which is where triage quality
    // comes from. A failure here is not a reason to drop the signal.
    let prefetched: Evidence[] = [];
    try {
      prefetched = await adapter.prefetchEvidence(signal);
      if (prefetched.length > 0) {
        await store.put(evidenceKey(signalId), JSON.stringify(prefetched));
      }
    } catch (err) {
      alarm("prefetch_failed", { signalId, error: String(err) });
    }

    const outcome = await triage.decideDetailed({
      signal,
      evidence: prefetched,
      openIncidents: openIncidents(),
    });
    const decision = outcome.decision;

    // Before the branch, so a suppression is costed like a placement. A
    // suppressed signal took a model call to suppress, and it is the cheap
    // decision that arrives in bulk -- the one whose bill is only visible
    // once it is written down.
    await recordTriageSpend(signalId, outcome.usage);

    if (decision.action === "suppress") {
      // No incident and no agent. The signal stays in the table unattached,
      // which is what makes "how often does this fire and get suppressed" a
      // question the Slack agent can answer.
      //
      // closedAt is what separates a suppression from an orphan the sweep
      // still owes an incident, which is also the difference the "zero alerts
      // go unaddressed" metric is counted on. It is closedAt rather than
      // explained because explained means an agent's root cause accounted for
      // this signal, and a suppression has neither an agent nor a root cause.
      // A suppressed signal is simply finished, which is what closedAt says.
      await db.withWrite((w: Database.Database) => {
        w.prepare("UPDATE signal SET closedAt = ? WHERE id = ?").run(
          now(),
          signalId,
        );
      });
      log("suppressed", {
        signalId,
        knownCauseId: decision.knownCauseId,
        reason: decision.reason,
      });
      return {
        signalId,
        incidentId: null,
        action: "suppress",
        reason: decision.reason,
      };
    }

    const result = await assignPlacement(
      signalId,
      decision,
      outcome.recurrenceOf,
    );

    if (result.created) await ensureIncidentThreads();

    const slug = signal.labels[SLUG_LABEL];
    if (slug && config.prodCriticalSlugs.includes(slug)) {
      await relay
        .emit({
          type: "prod_critical_signal",
          incidentId: result.target,
          signalTitle: signal.title,
          slug,
        })
        .catch((err: unknown) =>
          alarm("prod_critical_post_failed", {
            incidentId: result.target,
            error: String(err),
          }),
        );
    }

    log("placed", {
      signalId,
      incidentId: result.target,
      action: decision.action,
      created: result.created,
      recurrenceOf: outcome.recurrenceOf,
      // A null recurrenceOf with recurrenceChecked false is "we could not
      // look", which is not the same fact as "nothing matched".
      recurrenceChecked: outcome.recurrenceChecked,
      fellBack: outcome.fellBack,
    });

    return {
      signalId,
      incidentId: result.target,
      action: decision.action,
      reason: decision.reason,
    };
  };

  const acceptSignals = async (
    signals: RawSignal[],
    adapter: SignalAdapter,
  ): Promise<AcceptedIngest> => {
    // Durable before the caller answers 200, so a redelivery of the same
    // burst collapses onto these rows instead of triaging it a second time.
    // A row that cannot be written has to reach the source as a failure, or
    // the one delivery that would have saved the alert is answered 200.
    const recorded: { signal: RawSignal; row: RecordedSignal }[] = [];
    try {
      for (const signal of signals) {
        recorded.push({ signal, row: await recordSignal(signal) });
      }
    } catch (err) {
      for (const { row } of recorded) placing.delete(row.id);
      throw err;
    }

    // Per signal, because a Grafana burst arrives as one delivery and one
    // unplaceable alert must not lose the other fourteen.
    const settled = (async () => {
      const placed: PlacedSignal[] = new Array(recorded.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let i = next++; i < recorded.length; i = next++) {
          const { signal, row } = recorded[i];
          if (!row.needsPlacement) {
            log("duplicate_signal", {
              signalId: row.id,
              source: signal.source,
              sourceId: signal.sourceId,
            });
            placed[i] = {
              signalId: row.id,
              incidentId: row.incidentId,
              action: "duplicate",
              reason: "already ingested",
            };
            continue;
          }
          try {
            placed[i] = await placeRecorded(row.id, signal, adapter);
          } catch (err) {
            alarm("place_failed", {
              signalId: row.id,
              source: signal.source,
              sourceId: signal.sourceId,
              error: String(err),
            });
            placed[i] = {
              signalId: row.id,
              incidentId: null,
              action: "failed",
              reason: String(err),
            };
          } finally {
            placing.delete(row.id);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(TRIAGE_CONCURRENCY, recorded.length) },
          worker,
        ),
      );
      return placed;
    })();

    return { recorded: recorded.length, settled };
  };

  const ingestAccepted = async (
    source: string,
    req: IncomingRequest,
  ): Promise<AcceptedIngest> => {
    const adapter = ingress.get(source);

    // Fails closed: nothing downstream ever sees an unverified body, and the
    // HTTP layer answers 401 rather than 500 so a misconfigured contact point
    // is distinguishable from a broken Boss.
    let signals: RawSignal[];
    try {
      signals = await adapter.parse(req);
    } catch (err) {
      throw new IngestRejected((err as Error).message);
    }

    return acceptSignals(signals, adapter);
  };

  /**
   * A mention somebody meant as a report. It has no ingress channel of its
   * own: what makes it a report is a model call rather than anything the
   * webhook body says, so the signal is built here and placed through the
   * human adapter, which is also what Signal.source already points the orphan
   * sweep at.
   */
  const reportAccepted = (report: HumanReport): Promise<AcceptedIngest> =>
    acceptSignals([humanSignal(report)], ingress.get(HUMAN_SOURCE));

  const ingest = async (
    source: string,
    req: IncomingRequest,
  ): Promise<PlacedSignal[]> => (await ingestAccepted(source, req)).settled;

  /**
   * A signal whose placement threw is left with no incident and nothing that
   * would ever look at it again: every reader joins through incident, so it
   * skips unattached rows, and an agent only ever sees what is attached to
   * its own. Since the number this project is judged on is alerts that reach
   * nobody, an orphan is the worst state a row can be in, and any throw
   * between the insert and the assign produces one.
   */
  const sweepOrphans = async (): Promise<number> => {
    const rows = db.query<{
      id: string;
      source: string;
      sourceId: string;
      kind: Signal["kind"];
      title: string;
      body: string;
      labels: string;
      reportedBy: string | null;
      openedAt: number;
    }>(
      `SELECT id, source, sourceId, kind, title, body, labels, reportedBy, openedAt
       FROM signal
       WHERE incidentId IS NULL AND closedAt IS NULL
       ORDER BY openedAt
       LIMIT ?`,
      [ORPHAN_SWEEP_LIMIT],
    );

    // The project is judged on alerts that reach nobody, and this predicate
    // is that number: recorded, still open, no incident, no suppression.
    // Emitted every pass so it is a series rather than a thing to go and ask.
    log("orphan_backlog", {
      signals: db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM signal
         WHERE incidentId IS NULL AND closedAt IS NULL`,
      )?.n ?? 0,
    });

    let replaced = 0;
    for (const row of rows) {
      if (placing.has(row.id) || !ingress.has(row.source)) continue;
      placing.add(row.id);
      try {
        const result = await placeRecorded(
          row.id,
          {
            source: row.source,
            sourceId: row.sourceId,
            kind: row.kind,
            title: row.title,
            body: row.body,
            labels: JSON.parse(row.labels) as Record<string, string>,
            reportedBy: row.reportedBy,
            openedAt: row.openedAt,
          },
          ingress.get(row.source),
        );
        log("orphan_replaced", {
          signalId: row.id,
          action: result.action,
          incidentId: result.incidentId,
        });
        replaced++;
      } catch (err) {
        alarm("orphan_replace_failed", { signalId: row.id, error: String(err) });
      } finally {
        placing.delete(row.id);
      }
    }
    return replaced;
  };

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  const childSpawn =
    options.spawnAgent ??
    createChildProcessSpawn({
      modulePath:
        process.env.BUGBOSS_AGENT_MODULE ?? join(__dirname, "agent", "run.js"),
    });

  const spawn: SpawnAgent = (ctx) => {
    const sessionRef = incidentSessionKey(ctx.incidentId);
    // Not awaited: the dispatcher calls spawn synchronously so a real child
    // registers its pid before launch returns, and a snapshot PUT would push
    // that past a microtask. The key is derived, so losing this write costs
    // the resumed_after directive rather than the session.
    void db
      .withWrite((w: Database.Database) => {
        w.prepare("UPDATE incident SET sessionRef = ? WHERE id = ?").run(
          sessionRef,
          ctx.incidentId,
        );
      })
      .catch((err: unknown) =>
        alarm("session_ref_write_failed", {
          incidentId: ctx.incidentId,
          error: String(err),
        }),
      );

    return childSpawn({
      ...ctx,
      env: { ...ctx.env, BUGBOSS_SESSION_REF: sessionRef },
    }).finally(() => {
      // After the child, not during it, and deliberately from the session
      // file rather than from anything the agent reports: a killed agent
      // never gets to report, and the file is on disk either way. So the
      // numbers survive exactly the runs you most want them for.
      //
      // The closing report follows the roll-up rather than running beside
      // it, because the tokens it quotes are the ones roll-up just wrote.
      // It is a no-op unless this launch was the one that closed the
      // incident.
      void noteRunOutcome(ctx.incidentId, sessionRef);
      void rollUpUsage(ctx.incidentId, sessionRef).then(() =>
        publishReport(ctx.incidentId),
      );
    });
  };

  /**
   * Say how the run that just exited ended.
   *
   * The session file is the only artifact a killed agent leaves, and until
   * the agent started writing an exit record it said nothing: a run killed
   * mid-turn and a run that closed its incident were the same shape, so three
   * of seven real runs died invisibly and the longest of them -- 9.5 hours and
   * $42.71, with an approved PR and green checks waiting -- read as patience
   * for as long as anyone cared to wait.
   *
   * This does not resume anything. The dispatcher already relaunches an
   * agent-owned incident on its next tick, and that is the recovery. What was
   * missing is that the relaunch, and the death before it, were both silent.
   */
  const noteRunOutcome = async (
    incidentId: string,
    sessionRef: string,
  ): Promise<void> => {
    try {
      const raw = await store.get(sessionRef);
      if (!raw) {
        log("run_outcome_unknown", { incidentId, sessionRef, reason: "no session file" });
        return;
      }
      const outcome = readSessionOutcome(raw);
      if (outcome.kind !== "killed") {
        log("agent_run_ended", {
          incidentId,
          sessionRef,
          outcome: outcome.kind,
          ...(outcome.kind === "ended" ? { reason: outcome.exit.reason } : {}),
        });
        return;
      }

      // Whether the kill cost anything is a different question from whether
      // it happened. An agent killed after handing off has already put the
      // incident somewhere a person can see; one killed while it still owns
      // an open incident has not, and that is the stranding case.
      const row = db.get<{ status: IncidentStatus; owner: string }>(
        "SELECT status, owner FROM incident WHERE id = ?",
        [incidentId],
      );
      const stranded =
        !!row && row.owner === "agent" && OPEN_STATUSES.includes(row.status);
      alarm("agent_run_killed", {
        incidentId,
        sessionRef,
        turns: outcome.turns,
        status: row?.status ?? null,
        owner: row?.owner ?? null,
        stranded,
        note: stranded
          ? "the incident is still the agent's and still open; the next dispatcher tick should relaunch it, and if none does it is stranded"
          : "the work had already left the agent, so nothing is waiting on this",
      });
    } catch (err: unknown) {
      alarm("run_outcome_read_failed", { incidentId, sessionRef, error: String(err) });
    }
  };

  /**
   * Sum the run's token usage onto the incident.
   *
   * Tokens rather than dollars. Pricing is per model and changes underneath
   * us, so a stored dollar figure would be a guess frozen at write time,
   * while tokens plus `modelId` stay true and multiply out whenever someone
   * asks. `costUsd` is left unwritten for that reason.
   */
  const rollUpUsage = async (
    incidentId: string,
    sessionRef: string,
  ): Promise<void> => {
    try {
      const raw = await store.get(sessionRef);
      if (!raw) {
        // The child is spawned before its first turn syncs, so a crash at
        // boot legitimately leaves no session. Say so rather than writing a
        // zero that reads as a free run.
        log("usage_roll_up_skipped", { incidentId, sessionRef, reason: "no session file" });
        return;
      }
      const usage = sumSessionUsage(raw);
      const total = usage.tokensIn + usage.tokensOut + usage.cacheRead + usage.cacheWrite;
      if (total === 0) {
        // A zero is never written, whatever produced it. The columns already
        // default to zero, and on a resume the row may hold real tokens an
        // earlier launch stored -- whose session object ages out under the
        // lifecycle rule, so overwriting it loses the only copy.
        if (usage.turns > 0) {
          // A turn that reached the model always spends tokens, so this is not
          // a cheap run: it is a reader that no longer matches what Pi writes.
          alarm("usage_missing", {
            incidentId,
            sessionRef,
            turns: usage.turns,
            modelId: usage.modelId,
          });
        } else {
          log("usage_roll_up_skipped", {
            incidentId,
            sessionRef,
            reason: "session holds no turns",
          });
        }
        return;
      }
      await db.withWrite((w: Database.Database) => {
        w.prepare(
          `UPDATE incident
             SET tokensIn = ?, tokensOut = ?, cacheRead = ?, cacheWrite = ?,
                 modelId = COALESCE(?, modelId)
           WHERE id = ?`,
        ).run(
          usage.tokensIn,
          usage.tokensOut,
          usage.cacheRead,
          usage.cacheWrite,
          usage.modelId,
          incidentId,
        );
      });
      log("usage_rolled_up", {
        incidentId,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        turns: usage.turns,
        modelId: usage.modelId,
      });
    } catch (err: unknown) {
      // Never fatal. Losing a cost number is not worth failing a run over.
      alarm("usage_roll_up_failed", { incidentId, error: String(err) });
    }
  };

  // -------------------------------------------------------------------------
  // The closing report
  // -------------------------------------------------------------------------

  const reportDeps: ReportDeps = {
    db,
    sessions: store,
    post: (threadTs, text) => slack.post(threadTs, text),
    channel: config.slackChannelId,
    uploader: options.fileUploader,
    prStates: options.prStates,
    now,
  };

  /**
   * After the agent exits and after its usage is on the row, because the
   * report quotes both. Never awaited by the dispatcher and never able to
   * fail a launch: the transition it reports on committed long ago.
   */
  const publishReport = (incidentId: string): Promise<unknown> =>
    publishIncidentReport(reportDeps, incidentId).catch((err: unknown) =>
      alarm("report_publish_failed", { incidentId, error: String(err) }),
    );

  const sweepReports = (): Promise<number> => publishPendingReports(reportDeps);

  const dispatcher = createDispatcher({
    db,
    config: config.dispatcher,
    spawn,
    toolApiFor,
    mintToken,
    // The dispatcher has no Slack of its own and the tool API cannot say
    // anything that is not a transition, so the one thing it needs to tell a
    // human -- that the agent they were waiting on had been dead for an hour
    // -- is handed over the same way the tool API's thread poster is.
    postNotice: async (incidentId, text) => {
      const threadTs =
        db.get<{ slackThreadTs: string | null }>(
          "SELECT slackThreadTs FROM incident WHERE id = ?",
          [incidentId],
        )?.slackThreadTs ?? null;
      // A threadless incident is a real state -- opening one can fail, and
      // it can fail for good. `slack.post(null, ...)` is a top-level channel
      // message, so posting anyway would put "the agent on this incident
      // stopped" in the channel with nothing saying which incident. Alarming
      // is the same answer the dispatcher gives when no poster is wired in
      // at all: the event still reaches somebody, out of context does not.
      if (!threadTs) {
        alarm("resume_notice_undeliverable", {
          incidentId,
          note: "the incident has no Slack thread, so the resume was not announced where anyone is watching",
        });
        return;
      }
      await slack.post(threadTs, text);
    },
    childBaseEnv: {
      ...pickBaseEnv(process.env),
      AWS_REGION: secrets.awsRegion ?? process.env.AWS_REGION,
      AWS_DEFAULT_REGION: secrets.awsRegion ?? process.env.AWS_DEFAULT_REGION,
      BUGBOSS_BOSS_URL: `http://127.0.0.1:${
        options.http?.loopbackPort ?? DEFAULT_LOOPBACK_PORT
      }`,
      BUGBOSS_S3_BUCKET: config.s3Bucket,
      // Only when it resolved. A refused URL is withheld deliberately: with
      // this unset omni's harness goes back to starting its own container and
      // says so, which is a better answer for fifteen agents than whatever a
      // bad URL named.
      ...(config.testDatabase.state === "configured"
        ? { [TEST_DB_ENV_VAR]: config.testDatabase.url }
        : {}),
      ...(secrets.agentModelId ? { BUGBOSS_MODEL_ID: secrets.agentModelId } : {}),
      ...(config.workingHours
        ? { BUGBOSS_WORKING_HOURS: config.workingHours }
        : {}),
      ...(secrets.grafanaUrl ? { GRAFANA_URL: secrets.grafanaUrl } : {}),
    },
    childCredentials: {
      // The App itself, not a token minted from it. An installation token
      // lasts an hour and an incident can run for a day, so a token handed
      // down at launch would expire mid-investigation -- surfacing as `gh`
      // refusing to push a branch the agent had already built.
      GITHUB_APP_ID: secrets.githubAppId,
      GITHUB_APP_PRIVATE_KEY: secrets.githubAppPrivateKey,
      GITHUB_APP_INSTALLATION_ID: secrets.githubAppInstallationId,
      GRAFANA_SERVICE_ACCOUNT_TOKEN: secrets.grafanaServiceAccountToken,
    },
  });

  const dispatchOnce = async (): Promise<TickResult> => {
    const result = await dispatcher.tick();
    // tick() returns as soon as the launches are started, deliberately: a
    // thirty-minute agent must not block the loop. Only a caller that wants
    // the run finished waits.
    await result.settled;
    return result;
  };

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Inbound Slack
  // -------------------------------------------------------------------------

  /**
   * A person claiming an incident, or handing it back.
   *
   * `owner` is the only axis that moves. Status says where the work is and
   * owner says who has it, and a claim changes the second without touching
   * the first: an incident a person takes over is still FIXING, it just is
   * not an agent doing the fixing.
   *
   * A takeover does not kill the agent. It pushes `handoff`, so the agent
   * finishes the turn it is in and writes its brief -- which is the artifact
   * the person taking over actually wants, and the reason they are usually
   * taking over at all. Killing it would throw that away to save a minute.
   *
   * Hand-back is what makes escalation a handoff rather than a hole. Without
   * it `owner` only ever moves one way and no agent can reach the incident
   * again, which is what the dispatcher's launch-ceiling reset already
   * assumed was possible.
   */
  const claimOwnership = async (
    incidentId: string,
    claim: OwnershipClaim,
    slackUserId: string,
  ): Promise<void> => {
    const readIncidentRow = () =>
      db.get<{ owner: string; status: string; slackThreadTs: string | null }>(
        "SELECT owner, status, slackThreadTs FROM incident WHERE id = ?",
        [incidentId],
      );

    const say = (text: string) =>
      slack
        .post(readIncidentRow()?.slackThreadTs ?? null, text)
        .then(() => undefined)
        .catch((err: unknown) =>
          alarm("ownership_post_failed", { incidentId, error: String(err) }),
        );

    const to = claim === "take_over" ? "human" : "agent";
    const from = claim === "take_over" ? "agent" : "human";

    const changed = await db.withWrite((w: Database.Database) => {
      // Guarded in the statement, like every other transition: the read that
      // decided this happened outside the transaction.
      const res = w
        .prepare(
          `UPDATE incident SET owner = ?
             WHERE id = ? AND owner = ?
               AND status IN ('INVESTIGATING', 'FIXING', 'RESOLVED')`,
        )
        .run(to, incidentId, from);
      if (res.changes === 0) return false;
      w.prepare(
        `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
         VALUES (?, 'human', ?, ?, ?, ?)`,
      ).run(
        incidentId,
        slackUserId,
        claim,
        `owner ${from} -> ${to}`,
        now(),
      );
      return true;
    });

    if (!changed) {
      const row = readIncidentRow();
      log("ownership_claim_ignored", {
        incidentId,
        claim,
        slackUserId,
        owner: row?.owner ?? null,
        status: row?.status ?? null,
      });
      // Saying so matters more than it looks: the claim word is a normal
      // message, so silence is indistinguishable from the bot not reading it.
      await say(
        claim === "take_over"
          ? mrkdwn`${raw(userMention(slackUserId))} this one is already owned by a human.`
          : mrkdwn`${raw(userMention(slackUserId))} nothing to hand back: an agent already has this.`,
      );
      return;
    }

    if (claim === "take_over") {
      await db.withWrite((w: Database.Database) => {
        w.prepare(
          `INSERT INTO pending_directive (incidentId, payload, createdAt)
           VALUES (?, ?, ?)`,
        ).run(
          incidentId,
          JSON.stringify({
            type: "handoff",
            reason:
              "a person took this over in Slack; write up what you have and stop",
          } satisfies Directive),
          now(),
        );
      });
    }

    log("ownership_claimed", { incidentId, claim, slackUserId });
    await say(
      claim === "take_over"
        ? mrkdwn`${raw(userMention(slackUserId))} has this one. The agent is writing up what it found and will stop.`
        : mrkdwn`Back to an agent, handed over by ${raw(userMention(slackUserId))}. It will pick this up within a tick.`,
    );
  };

  /**
   * The one thing that reaches a running agent from Slack. `contact_human`
   * waits on directives alone and nothing else reads `thread_reply` on an
   * agent's behalf, so a message that never becomes one is a message the
   * agent does not have -- which is why this happens whatever the read said,
   * and only `addressed` varies.
   *
   * The relay recorded the reply inside the request and this runs after it,
   * so a task replaced in that window leaves the message on the record with
   * no directive: the agent waits out its timeout and escalates to a person,
   * which is visible. The alternative is labelling a message before knowing
   * what it is.
   */
  const pushHumanMessage = async (
    route: Extract<InboundRoute, { kind: "incident_reply" }>,
    addressed: "agent" | "others",
  ): Promise<void> => {
    await db.withWrite((w: Database.Database) => {
      w.prepare(
        `INSERT INTO pending_directive (incidentId, payload, createdAt)
         VALUES (?, ?, ?)`,
      ).run(
        route.incidentId,
        JSON.stringify({
          type: "human_message",
          from: route.user,
          text: route.text,
          ts: route.ts,
          addressed,
        } satisfies Directive),
        now(),
      );
    });
  };

  const sayInThread = (
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> =>
    slack
      .post(threadTs, text, channel)
      .then(() => undefined)
      .catch((err: unknown) =>
        alarm("intent_reply_failed", { channel, threadTs, error: String(err) }),
      );

  /**
   * Something a person said in an incident's thread. The relay has recorded
   * it; this decides what it meant, off the Slack ack.
   *
   * Two questions, one model call. Does it hand the incident over, and was it
   * for the agent at all -- because `contact_human` ends its wait on the
   * first reply it sees, and two people talking to each other while an agent
   * is blocked used to end that wait on whichever of them spoke first. The
   * answer to that is not syntax: answering a direct question should not need
   * ceremony, so the message is read rather than required to carry a tag.
   *
   * Three rules sit in code, on top of what the model says, for the same
   * reason `applyRules` does in triage:
   *
   *   - An explicit @bugboss always means "this is for you". That is the
   *     escape hatch for somebody who wants certainty, and because it is
   *     decided here rather than by the model it keeps working while the
   *     model is down.
   *   - A handover is aimed at the system by definition, so it is delivered
   *     as well as acted on.
   *   - Nothing is ever dropped. A message that could not be read is still
   *     delivered as context; what it loses is the right to end a wait.
   *
   * And the incident comes from the thread the message arrived in, never from
   * the message, so no wording -- including wording pasted out of a log line
   * -- reaches a different incident.
   */
  const answerIncidentMessage = async (
    route: Extract<InboundRoute, { kind: "incident_reply" }>,
  ): Promise<void> => {
    const said = stripBotMention(route.text, secrets.slackBotUserId ?? "");
    const outstanding =
      db.get<{ message: string }>(
        "SELECT message FROM pending_question WHERE incidentId = ?",
        [route.incidentId],
      )?.message ?? null;

    const read = await readReplyIntent(intent, {
      text: said,
      owner: route.owner,
      outstandingQuestion: outstanding,
    });

    const handingOver: OwnershipClaim | null =
      read.handover === "take_over" || read.handover === "hand_back"
        ? read.handover
        : null;
    const addressed: Addressed =
      route.interrupt || handingOver ? "agent" : read.addressed;

    // Delivered before anything else, so the agent has what was said whatever
    // the rest of this decides. `others` and `unclear` ride through as
    // context; only `agent` can end a wait.
    await pushHumanMessage(route, addressed === "agent" ? "agent" : "others");

    log("reply_read", {
      incidentId: route.incidentId,
      handover: read.handover,
      addressed,
      modelAddressed: read.addressed,
      tagged: route.interrupt,
      blocked: outstanding !== null,
      fellBack: read.fellBack,
    });

    if (handingOver) {
      await claimOwnership(route.incidentId, handingOver, route.user);
      return;
    }

    // Everything the read could not settle, in one post. These used to be two
    // branches with a return each, so a message that was ambiguous both ways
    // -- which is the common shape of an unreadable message -- was told about
    // the handover and never told its answer had not been delivered as one.
    const unsureHandover = read.handover === "unclear";
    // Only worth saying while something is blocked on it. With no outstanding
    // question there is no wait to end, the directive is context either way,
    // and narrating that is noise about nothing.
    const unsureAddressee = addressed === "unclear" && outstanding !== null;

    if (unsureHandover || unsureAddressee) {
      await sayInThread(
        route.channel,
        route.threadTs,
        [
          read.fellBack
            ? mrkdwn`${raw(userMention(route.user))} I could not read that one -- the call that works out what a message means failed, and the error is in the BugBoss logs. The agent has it as context either way.`
            : mrkdwn`${raw(userMention(route.user))} I could not tell how to take that one. The agent has it as context either way.`,
          ...(unsureHandover
            ? [
                "If you meant you are taking this incident over, or handing it back to an agent, say so plainly and I will move it.",
              ]
            : []),
          ...(unsureAddressee
            ? [
                "And if it was the answer the agent is waiting for, tag me and say it again, so it counts as one.",
              ]
            : []),
        ].join("\n"),
      );
    }

    // Independent of the above, not an else. Somebody who tags @bugboss in a
    // thread with no agent on it has asked a question, and an ambiguous
    // handover is a footnote to that rather than a reason to leave them
    // without an answer. A real handover returned above, so the read-only
    // agent still never fields a claim -- its answer to one would be to tell
    // you to reply in the thread, which is what you just did.
    if (route.interrupt && !route.agentRunning) {
      await slackAgent.handle({
        channel: route.channel,
        threadTs: route.threadTs,
        ts: route.ts,
        user: route.user,
        text: route.text,
      });
    }
  };

  /**
   * An @bugboss mention outside any incident thread: somebody reporting
   * something broken, or somebody asking a question. This used to turn on
   * whether the first word was "report", "bug" or "broken", which is a magic
   * phrase nobody can discover -- "@bugboss Pro upgrades are failing" was
   * answered as a question and opened nothing.
   */
  const answerMention = async (
    route: Extract<InboundRoute, { kind: "slack_agent" }>,
  ): Promise<void> => {
    const ask = () =>
      slackAgent.handle({
        channel: route.channel,
        threadTs: route.threadTs,
        ts: route.ts,
        user: route.user,
        text: route.text,
      });

    const said = stripBotMention(route.text, secrets.slackBotUserId ?? "");
    // A bare @bugboss is somebody about to type. There is no sentence to
    // read, and a report built from it would open an incident with an empty
    // body, so it goes to the agent that can ask what they want.
    if (!said) return ask();

    const read = await readMentionIntent(intent, { text: said });

    if (read.intent === "bug_report") {
      const accepted = await reportAccepted({
        text: said,
        // The verified Slack identity, never a field the body carried.
        reportedBy: route.user,
        channel: route.channel,
        threadTs: route.threadTs === route.ts ? null : route.threadTs,
        messageTs: route.ts,
        reportedAt: now(),
      });
      await accepted.settled;
      return;
    }

    if (read.intent === "question") return ask();

    log("mention_unclear", { user: route.user, ts: route.ts, fellBack: read.fellBack });
    await sayInThread(
      route.channel,
      route.threadTs,
      read.fellBack
        ? mrkdwn`${raw(userMention(route.user))} I could not read that one -- the call that works out what a message means failed, and the error is in the BugBoss logs. Try me again.`
        : mrkdwn`${raw(userMention(route.user))} I could not tell whether that is something broken you want me to put an agent on, or a question. Which is it?`,
    );
  };

  const slackEventAccepted = async (
    event: SlackEvent,
  ): Promise<AcceptedSlackEvent> => {
    // The relay's writes are idempotent on (channel, ts) and bounded, so they
    // stay inside the request: recording the reply is what a Slack retry is
    // supposed to collapse onto. Reading what the message meant is a model
    // call and answering it is a two-minute agent, against a three-second
    // ack, so both run past the response.
    const route = await relay.handle(event);
    if (route.kind === "incident_reply") {
      return { routed: route.kind, settled: answerIncidentMessage(route) };
    }
    if (route.kind !== "slack_agent") {
      return { routed: route.kind, settled: Promise.resolve() };
    }
    return { routed: route.kind, settled: answerMention(route) };
  };

  const slackEvent = async (event: SlackEvent): Promise<void> => {
    await (await slackEventAccepted(event)).settled;
  };

  /**
   * A button press, once the relay has decided what it was.
   *
   * The thread is the incident's record, so every press leaves a line in it —
   * including the two that changed nothing. A button that silently does
   * nothing is indistinguishable from a broken one, and the person who
   * pressed it would reasonably go on waiting for an agent that never heard
   * them.
   *
   * What the line has to carry is what happens *next*. "Chose Merged" was
   * only the first half: a press on an incident the dispatcher will not run
   * writes a directive nothing is coming to consume, and it read exactly the
   * same as a press an agent was about to act on. So every line here says
   * whether an agent will read this, and when none will, the one move that
   * changes that. A confident acknowledgement over an inert press is worse
   * than silence, because silence at least does not claim.
   */
  const acknowledgeChoice = async (
    route: ChoiceRoute,
    click: SlackChoiceClick,
  ): Promise<void> => {
    const say = (text: string, incidentId: string | null) =>
      slack
        .post(click.threadTs, text, click.channel)
        .then(() => undefined)
        .catch((err: unknown) =>
          alarm("choice_post_failed", { incidentId, error: String(err) }),
        );

    if (route.kind === "ignore") {
      // A button only exists on a question BugBoss posted into an incident
      // thread, so a press whose thread matches no incident means the thread
      // link is gone and the press is lost. That is an alarm, not a log, and
      // the presser hears about it rather than watching a dead button.
      alarm("choice_unmatched", {
        reason: route.reason,
        user: click.user,
        threadTs: click.threadTs,
      });
      await say(
        [
          mrkdwn`${raw(userMention(click.user))} I cannot match this thread to an incident, so that press reached no agent.`,
          "_Tag me here and say what you meant, and I will pick it up._",
        ].join("\n"),
        null,
      );
      return;
    }

    const who = raw(userMention(route.slackUserId));
    // The half "recorded" left out, and the only one the presser cannot see
    // for themselves. `landed` separates the press that became the answer
    // from the two that did not, because "the agent has that" is true of one
    // of them and a claim about nothing for the others.
    const next = (landed: boolean): string => {
      switch (route.reader) {
        case "agent":
          return landed
            ? "_The agent has that as its answer and carries on from here._"
            : "_Reply in the thread and the agent will read you._";
        case "nobody":
          return landed
            ? "_It is recorded and waiting, but a person owns this incident, so no agent has read it. Say in the thread that you are handing it back and one picks it up, this answer included._"
            : "_A person owns this incident, so no agent is reading the thread. Say in the thread that you are handing it back and one will._";
        case "closed":
          return "_This incident is over and no agent will run on it again, so nothing here reaches one._";
      }
    };

    const text =
      route.kind === "answered"
        ? [mrkdwn`${who} chose *${route.choice}*.`, next(true)].join("\n")
        : route.kind === "duplicate"
          ? [
              route.recorded
                ? mrkdwn`${who} that question already has an answer: *${route.recorded.choice}*, from ${raw(userMention(route.recorded.slackUserId))}.`
                : mrkdwn`${who} that question already has an answer.`,
              next(false),
            ].join("\n")
          : [
              mrkdwn`${who} that question is closed — nothing is waiting on that answer any more.`,
              next(false),
            ].join("\n");

    await say(text, route.incidentId);
  };

  const slackInteractionAccepted = async (
    click: SlackChoiceClick,
  ): Promise<AcceptedSlackInteraction> => {
    // The write is bounded and idempotent on the question's ts, so it stays
    // inside the three seconds Slack gives an interaction. The post does not.
    const route = await relay.handleChoice(click);
    return { routed: route.kind, settled: acknowledgeChoice(route, click) };
  };

  // -------------------------------------------------------------------------
  // Servers and timers
  // -------------------------------------------------------------------------

  const publicApp = createPublicApp({
    ingestAccepted,
    slackEventAccepted,
    // Bound to the deadline-wrapped client, so a reactions.add that never
    // answers alarms on the same ten-second budget every other Slack call
    // has rather than sitting as a detached promise forever.
    acknowledgeSlack: createSlackAck(slack),
    slackInteractionAccepted,
    slackConfig: slackIngress,
  });
  const loopbackApp = createToolApiRoutes({
    db,
    tokenSecret,
    toolApiFor,
    slack,
    now,
  });

  let servers: BugBossServers | null = null;
  let resolutionTimer: NodeJS.Timeout | null = null;

  const background = (what: string, work: () => Promise<unknown>): void => {
    void work().catch((err: unknown) =>
      alarm(`${what}_failed`, { error: String(err) }),
    );
  };

  const start = (): void => {
    if (servers) return;
    servers = startServers({ publicApp, loopbackApp, config: options.http });
    dispatcher.start();
    // A restart is the one moment nothing is in flight, so every unplaced
    // signal and every threadless incident on disk is real rather than young.
    background("startup_sweep", sweepOrphans);
    background("startup_threads", ensureIncidentThreads);
    background("startup_reports", sweepReports);
    resolutionTimer = setInterval(() => {
      background("orphan_sweep", sweepOrphans);
      background("thread_sweep", ensureIncidentThreads);
      // Nothing relaunches an agent on a CLOSED incident, so a container
      // replaced between the close and its report is the one case where the
      // report has no other way out.
      background("report_sweep", sweepReports);
    }, config.dispatcher.tickSeconds * 1000);
    resolutionTimer.unref();
    log("started", { env: config.env, bucket: config.s3Bucket });
  };

  const stop = (): void => {
    dispatcher.stop();
    if (resolutionTimer) clearInterval(resolutionTimer);
    resolutionTimer = null;
    servers?.close();
    servers = null;
    db.close();
    log("stopped");
  };

  return {
    db,
    dispatcher,
    relay,
    ingress,
    publicApp,
    loopbackApp,
    mintToken,
    toolApiFor,
    ingest,
    ingestAccepted,
    slackEvent,
    slackEventAccepted,
    slackInteractionAccepted,
    dispatchOnce,
    sweepOrphans,
    ensureIncidentThreads,
    sweepReports,
    start,
    stop,
  };
};

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/**
 * Everything a person has to supply, in one place. A value can arrive in the
 * Secrets Manager blob or as a plain environment variable, and which one
 * carries a given key is an operational choice rather than a code one. The
 * only way to keep that true is for nothing downstream to read process.env
 * directly: a call site that does silently ignores the blob, which is how the
 * prod-critical allowlist ended up permanently off with no error to find.
 * Blob wins, so a secret can override a task definition.
 */
export const settingsEnv = (
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const parsed = base.BUGBOSS_SECRETS
    ? (JSON.parse(base.BUGBOSS_SECRETS) as Record<string, string | undefined>)
    : {};
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

const readSecrets = (env: NodeJS.ProcessEnv): BugBossSecrets => ({
  slackBotToken: env.SLACK_BOT_TOKEN,
  slackSigningSecret: env.SLACK_SIGNING_SECRET,
  slackBotUserId: env.SLACK_BOT_USER_ID,
  slackRotationGroupId: env.SLACK_ROTATION_GROUP_ID,
  slackChannelId: env.BUGBOSS_SLACK_CHANNEL_ID,
  grafanaWebhookSecret: env.GRAFANA_WEBHOOK_SECRET,
  grafanaBasicAuthPassword: env.GRAFANA_BASIC_AUTH_PASSWORD,
  grafanaUrl: env.GRAFANA_URL ?? "https://goodparty.grafana.net",
  grafanaServiceAccountToken: env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
  githubAppId: env.GITHUB_APP_ID,
  githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
  githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID,
  triageModelId: env.BUGBOSS_TRIAGE_MODEL_ID,
  intentModelId: env.BUGBOSS_INTENT_MODEL_ID,
  agentModelId: env.BUGBOSS_MODEL_ID,
  awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
});

/**
 * Pure, so the shape of a deployment is checkable without an AWS client in
 * the room. The wiring below still is not: it is the only place a real Slack
 * workspace, a real bucket and a real model are named.
 */
export const bossConfigFromEnv = (env: NodeJS.ProcessEnv): BugBossConfig => {
  const bucket = env.BUGBOSS_BUCKET;
  if (!bucket) throw new Error("BUGBOSS_BUCKET is required");
  const channelId = env.BUGBOSS_SLACK_CHANNEL_ID;
  if (!channelId) throw new Error("BUGBOSS_SLACK_CHANNEL_ID is required");

  return {
    env: "prod",
    s3Bucket: bucket,
    dbPath: env.BUGBOSS_DB_PATH ?? "/data/bugboss.db",
    slackChannelId: channelId,
    dispatcher: {
      maxConcurrentAgents: Number(env.BUGBOSS_MAX_AGENTS ?? 15),
      tickSeconds: Number(env.BUGBOSS_TICK_SECONDS ?? 30),
      agentTimeoutSeconds: Number(env.BUGBOSS_AGENT_TIMEOUT ?? 86_400),
      maxAttempts: Number(env.BUGBOSS_MAX_ATTEMPTS ?? 3),
    },
    prodCriticalSlugs: (env.BUGBOSS_PROD_CRITICAL_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
    // Parsed and discarded: the child re-parses the string it is handed, and
    // this is here so a typo stops the container at boot rather than killing
    // every agent one launch at a time.
    ...(env.BUGBOSS_WORKING_HOURS
      ? {
          workingHours: (() => {
            parseWorkingHours(env.BUGBOSS_WORKING_HOURS);
            return env.BUGBOSS_WORKING_HOURS;
          })(),
        }
      : {}),
    testDatabase: resolveTestDatabase(env),
  };
};

/**
 * Say, once at boot, whether agents can run omni's database-backed tests.
 *
 * The prompt cannot carry this. A thinking block is bound to the system
 * prompt, so a section that read "the database is up" on the first launch and
 * something else after a restart would invalidate every block that followed
 * it. The prompt therefore states the contract and this states the fact, and
 * the failure an agent actually meets is the one omni's harness reports by
 * name at the moment a suite runs.
 *
 * Never fatal, and there is no container dependency in the task definition
 * either. An incident system that refuses to start because a test database is
 * missing is worse than one that works alerts without a local test loop.
 */
export const reportTestDatabase = async (
  testDatabase: TestDatabase,
  deadlineMs = TEST_DB_READY_DEADLINE_MS,
): Promise<void> => {
  if (testDatabase.state === "absent") {
    log("test_database_absent", { variable: TEST_DB_ENV_VAR });
    return;
  }
  if (testDatabase.state === "refused") {
    alarm("test_database_refused", { reason: testDatabase.reason });
    return;
  }

  // Waits out initdb rather than reading a cold start as a failure. Both
  // containers start together and Postgres binds TCP last, so a single probe
  // here would alarm on every deploy.
  const { host, port } = testDatabase;
  const probe = await awaitTestDatabase({ host, port }, deadlineMs);
  if (probe.reachable) {
    log("test_database_ready", { host, port, waitedMs: probe.waitedMs });
    return;
  }
  alarm("test_database_unreachable", {
    host,
    port,
    waitedMs: probe.waitedMs,
    error: probe.error,
  });
};

/**
 * The container entrypoint. Nothing here is reachable from a test, which is
 * deliberate: this is the only place a real Slack workspace, a real bucket
 * and a real model are named, and the only place that must never be handed a
 * verifier override.
 */
export const bugBossFromEnv = async (): Promise<BugBoss> => {
  const env = settingsEnv();
  const secrets = readSecrets(env);
  const config = bossConfigFromEnv(env);
  if (!secrets.slackBotToken) throw new Error("SLACK_BOT_TOKEN is required");
  // Started, not awaited. The wait above is up to ninety seconds and alert
  // ingest is what this container exists for; a test database is never worth
  // delaying it. Nothing downstream reads the result -- it is a log line.
  void reportTestDatabase(config.testDatabase).catch((error: unknown) =>
    alarm("test_database_report_failed", { error: String(error) }),
  );

  return createBugBoss({
    config,
    // Region is no longer passed: `resolveBedrockModel` takes it from an
    // inference-profile ARN and otherwise the SDK's own chain reads the same
    // AWS_REGION this used to forward by hand.
    model: await createBossModelClient({
      modelId: secrets.triageModelId ?? DEFAULT_TRIAGE_MODEL_ID,
    }),
    // Only when a different model is named for it. Every inbound Slack
    // message costs one of these calls, so this is the knob that takes them
    // off the triage model without a deploy.
    intentModel: secrets.intentModelId
      ? await createBossModelClient({ modelId: secrets.intentModelId })
      : undefined,
    slack: createSlackClient(secrets.slackBotToken, config.slackChannelId),
    // The closing report uploads as a file. Same token as every other post,
    // but the `files:write` scope it needs is granted only when somebody
    // reinstalls the app -- until then the upload throws and the report goes
    // out inline, which is exactly what should happen.
    fileUploader: createSlackFileUploader(secrets.slackBotToken),
    // Only when the App is configured. The Boss otherwise never mints a
    // GitHub token of its own; this is the one thing it asks GitHub for, and
    // a report without PR states is still a report.
    prStates:
      secrets.githubAppId &&
      secrets.githubAppPrivateKey &&
      secrets.githubAppInstallationId
        ? createPrStateReader(
            createInstallationToken({
              appId: secrets.githubAppId,
              privateKey: secrets.githubAppPrivateKey,
              installationId: secrets.githubAppInstallationId,
            }),
          )
        : undefined,
    // The merged env, not process.env: Loki's credentials come from the
    // secret blob, and settingsEnv builds a new object rather than mutating
    // the process.
    loki: createLokiQuery(env),
    // Only when a rotation group exists. Until one does, every incident
    // records "not known", which is true.
    rotationMembers: secrets.slackRotationGroupId
      ? createRotationReader(
          secrets.slackBotToken,
          secrets.slackRotationGroupId,
        )
      : undefined,
    s3: new S3Client({}),
    secrets,
    http: {
      publicPort: Number(env.PORT ?? DEFAULT_PUBLIC_PORT),
      loopbackPort: Number(env.BUGBOSS_LOOPBACK_PORT ?? DEFAULT_LOOPBACK_PORT),
    },
  });
};

/**
 * Node 22 makes an unhandled rejection fatal. Left to the default handler the
 * process dies with no line of ours in the log, ECS replaces the task, and
 * /health answers 200 again within seconds: a Boss that has been losing
 * alerts looks identical to one that has not. Exiting non-zero is the point,
 * not a side effect -- a half-dead task that still passes its health check is
 * worse than a replaced one.
 */
export const installCrashHandlers = (
  onFatal: (code: number) => void = (code) => process.exit(code),
): void => {
  const die = (event: string) => (error: unknown) => {
    alarm(event, {
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    onFatal(1);
  };
  process.on("unhandledRejection", die("unhandled_rejection"));
  process.on("uncaughtException", die("uncaught_exception"));
};

if (require.main === module) {
  installCrashHandlers();
  bugBossFromEnv().then(
    (boss) => {
      boss.start();
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => {
          boss.stop();
          process.exit(0);
        });
      }
    },
    (error: unknown) => {
      alarm("boot_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    },
  );
}
