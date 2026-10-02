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
// createBugBoss with the same shape and substitutes the model, Slack and S3.

import { dirname, join } from "node:path";

import { S3Client } from "@aws-sdk/client-s3";
import type Database from "better-sqlite3";
import type { Hono } from "hono";

import { Db } from "./db";
import { reconcileSearchIndex } from "./db/search";
import { createHarnessMirror, type HarnessMirror } from "./db/mirror";
import {
  createDispatcher,
  type AgentRuntime,
  type Dispatcher,
  type TickResult,
} from "./dispatcher";
import {
  createIngress,
  createLokiQuery,
  humanSignal,
  signalOrigin,
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
  startServers,
  DEFAULT_PUBLIC_PORT,
  IngestRejected,
  type BugBossServers,
  type HttpConfig,
} from "./http";
import { directiveText, parseWorkingHours } from "./agent/tools";
import {
  configureGitCredentials,
  createIncidentExtensions,
  cutoverHandoff,
  incidentAgentChange,
  incidentInit,
  kickoffMessage,
  resumeMessage,
  type IncidentExtensions,
} from "./agent/extension";
import { DEFAULT_OMNI_REPO, DEFAULT_WORK_ROOT } from "./agent/workspace";
import {
  allEntries,
  loadPi,
  openBugbossHarness,
  type Api,
  type BugbossHarness,
  type BugbossModels,
  type ConversationId,
  type Model,
  type Storage,
} from "./agent/harness";
import {
  backfillSpentBudgets,
  INCIDENT_AGENT_MAX_TURNS,
  reconcileTurns,
  spendOf,
} from "./agent/budget";
import { createAgentPort, type AgentPort } from "./agent/port";
import { composeSystemPrompt, loadPromptContext } from "./agent/prompt";
import { buildAgentShellEnv, pickBaseEnv, withGitHubToken } from "./agent/shell-env";
import { createSidecarSqlPort } from "./agent/sql";
import {
  createAgentLine,
  createBossExtension,
  createBossRuntime,
  createStatusSummariser,
  incidentConversation,
  SlackAgent,
  type SlackClient,
} from "./slack/agent";
import { createSlackAck } from "./slack/ack";
import { mrkdwn, raw } from "./slack/format";
import {
  createRotationReader,
  createS3ObjectStore,
  createSlackClient,
  createSlackFileUploader,
  type SlackLinker,
  type SlackUpdater,
} from "./slack/client";
import {
  createIncidentReferences,
  withIncidentReferences,
} from "./slack/incidents";
import { boardOnRequest, sweepBoard } from "./board";
import {
  SlackRelay,
  mentionPrefix,
  type InboundRoute,
  type SlackEvent,
} from "./slack/relay";
import {
  applyAssign,
  assign,
  AssignError,
  closeIncidentByBoss,
  createToolApi,
  type AgentNotifier,
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
  createTriage,
  usageForLog,
  type ModelClient,
  type SizedModelClient,
  type ModelUsage,
} from "./triage";
import { createPiModelClient } from "./bedrock/client";
import type { BedrockInvokeModelApi } from "./bedrock";
import { attachedSignalIds } from "./triage/sql";
import { createBugbossModels } from "./agent/harness";
import { parseInferenceProfiles } from "./bedrock/model";
import { DEFAULT_GOAL_MODEL_ID, DEFAULT_MODEL_ID } from "./bedrock/defaults";
import { createInstallationToken, createPrStateReader, tokenFromFile } from "./github";
import { createGhExec, type GhExec } from "./slack/gh";
import { makeAlarm, makeLog } from "./logging";
import type {
  BugBossConfig,
  Evidence,
  IncidentDigest,
  IncidentStatus,
  IncomingRequest,
  RawSignal,
  Signal,
  SignalAdapter,
  TestDatabase,
  ToolApi,
  TriageDecision,
  WakeBoss,
} from "./types";

const log = makeLog("boss");

const alarm = makeAlarm("boss");

/** Statuses an incident can still take a signal on, or be merged into. */
const OPEN_STATUSES: IncidentStatus[] = ["INVESTIGATING", "FIXING", "RESOLVED"];

export const DEFAULT_TRIAGE_MODEL_ID = "us.anthropic.claude-sonnet-5";

/**
 * The tail compaction keeps verbatim, and half of the reserve: the reserve is
 * the most one response can emit plus this, so a compaction can always free
 * enough room for the next answer.
 */
const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/** The GitHub App's installation token lasts an hour; refreshed well inside it. */
const GITHUB_TOKEN_REFRESH_MS = 20 * 60 * 1000;

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
  goalModelId?: string;
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
  /** The Boss's own bounded calls: triage and correlation. */
  model: SizedModelClient;
  /**
   * The Boss's small bounded calls outside its own loop, today the status
   * card's summary line. Defaults to `model`; a smaller model belongs here the
   * moment one is subscribed, which is what BUGBOSS_INTENT_MODEL_ID is for.
   */
  intentModel?: ModelClient;
  /**
   * The one `Models` every conversation on the harness streams through, and
   * the models the incident agent and the commander are pinned to. Built by
   * `createBugbossModels` in prod; a test hands in a faux provider.
   */
  models: Pick<BugbossModels, "models" | "agent" | "boss">;
  /** The stage-goal evaluator. Absent, every gate runs unjudged. */
  goalModel?: SizedModelClient;
  /**
   * Where the harness keeps its conversations. Absent, a SQLite file beside
   * `config.dbPath`, restored from and mirrored to S3. A test hands in
   * `MemoryStorage`, which is mirrored nowhere.
   */
  harnessStorage?: Storage;
  /** A fresh GitHub App installation token. Absent, agents can read and cannot push. */
  githubToken?: () => Promise<string>;
  /**
   * The repository a launch clones into the incident's workspace. Absent, as
   * in tests, no checkout is touched.
   */
  repoUrl?: string;
  /** Where every incident's workspace lives. Defaults to the EFS mount. */
  workRoot?: string;
  /** How long an agent's review wait settles. Absent means `REVIEW_SETTLE_SECONDS`. */
  reviewSettleSeconds?: number;
  slack: BossSlackClient;
  /** Omitted means no S3: state stays in memory and dies with the process. */
  s3?: S3Client;
  /** Attaches the closing report to the close notice in an incident thread. */
  fileUploader: FileUploader;
  /**
   * Looks up what became of the PRs an agent opened, for the closing report.
   * Absent leaves every PR rendered as "state not known".
   */
  prStates?: PrStateReader;
  /**
   * The Boss's `gh`, on the App's installation token. Null when the App is
   * not configured: the tool still exists, so the prompt prefix does not
   * change with configuration, and says it cannot run.
   */
  gh: GhExec | null;
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

export interface BugBoss {
  readonly db: Db;
  readonly dispatcher: Dispatcher;
  readonly relay: SlackRelay;
  readonly ingress: IngressRegistry;
  /** Webhooks and health. start() binds it; it is servable on its own. */
  readonly publicApp: Hono;
  /** Every agent's conversation. */
  readonly agents: BugbossHarness;
  /** Every write it makes is scoped to that incident. */
  toolApiFor(incidentId: string): ToolApi;
  /** The agent's side of the Boss for one incident: inbox, wait markers, SQL. */
  portFor(incidentId: string): AgentPort;
  ingest(source: string, req: IncomingRequest): Promise<PlacedSignal[]>;
  /** Record now, place after. What the webhook route calls. */
  ingestAccepted(source: string, req: IncomingRequest): Promise<AcceptedIngest>;
  /** An already-verified Slack Events payload: relay it, then answer it. */
  slackEvent(event: SlackEvent): Promise<void>;
  /** Relay now, answer after. What the webhook route calls. */
  slackEventAccepted(event: SlackEvent): Promise<AcceptedSlackEvent>;
  /** One dispatcher tick, waited out. Agents normally outlive a tick. */
  dispatchOnce(): Promise<TickResult>;
  /** Ask every adapter whether its signal stopped. Never moves an incident. */
  /** Re-place signals that reached no incident. Returns how many moved. */
  sweepOrphans(): Promise<number>;
  /** Open a Slack thread for any incident still without one. */
  ensureIncidentThreads(): Promise<number>;
  /** Attach the closing report for any closed incident still without it. */
  sweepReports(): Promise<number>;
  /** One pass of the status board: headers, the morning post, the all-clear. */
  sweepBoard(): Promise<unknown>;
  /** Roll the busy agents' spend onto their rows. Returns rows changed. */
  sweepUsage(): Promise<number>;
  /** Recompute every row's spend from its conversation. Returns rows changed. */
  reconcileUsage(): Promise<number>;
  start(): void;
  /** Closes the harness, then mirrors it once more, then closes the database. */
  stop(): Promise<void>;
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
      default:
        return {};
    }
  };
  return { send } as unknown as S3Client;
};

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
 * Everything the Boss needs from Slack: posts, thread reads, and the
 * permalink a merged or split incident links the other thread by.
 */
export type BossSlackClient = SlackClient & SlackLinker & SlackUpdater;

export const withSlackDeadline = (slack: BossSlackClient): BossSlackClient => ({
  post: (threadTs, text, channel) =>
    withDeadline(slack.post(threadTs, text, channel), "chat.postMessage"),
  react: (channel, ts, name) =>
    withDeadline(slack.react(channel, ts, name), "reactions.add"),
  update: (channel, ts, text) =>
    withDeadline(slack.update(channel, ts, text), "chat.update"),
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
  const deadlined = withSlackDeadline(options.slack);

  const s3 = options.s3 ?? createMemoryS3();
  const db = await Db.open({
    path: config.dbPath,
    bucket: config.s3Bucket,
    key: "state/db",
    s3,
  });
  const store = createS3ObjectStore(config.s3Bucket, s3);

  // The harness file sits beside the incident database rather than in it:
  // Pi Durable's adapter is node:sqlite with async transactions and Db is
  // better-sqlite3 with synchronous ones, so they could never share one.
  // Mirrored once per tick rather than per commit, because it commits a
  // partial response every 100 ms; see db/mirror.ts.
  let mirror: HarnessMirror | null = null;
  let harnessStorage = options.harnessStorage;
  if (!harnessStorage) {
    const harnessPath = join(dirname(config.dbPath), "harness.sqlite");
    mirror = createHarnessMirror({
      path: harnessPath,
      bucket: config.s3Bucket,
      key: "state/harness.sqlite",
      s3,
    });
    if (await mirror.restore()) log("harness_restored", { path: harnessPath });
    const { sqlite } = await loadPi();
    harnessStorage = await sqlite.openNodeSqliteStorage(harnessPath);
  }

  /**
   * The harness, once it is open. Everything that reaches a conversation goes
   * through this rather than holding the harness, because the extensions it
   * runs have to exist before it can be opened.
   */
  let agents: BugbossHarness | null = null;
  const harnessOf = (): BugbossHarness => {
    if (!agents) throw new Error("the harness is not open yet");
    return agents;
  };

  // Both a Boss stop and a merge abort a run the dispatcher launched; told
  // first, it reads the unanswered ending as a stop rather than a crash.
  const agentLine = createAgentLine({
    db,
    harness: harnessOf,
    now,
    onStop: (incidentId) => dispatcher.noteStopped(incidentId),
  });

  /**
   * How a committed change reaches the agent it concerns, through the same
   * line the Boss's `message_agent` and `stop_agent` use. A `stop` aborts and
   * resets, and the next tick relaunches into the reset's hand-off; a
   * `merged` only aborts, since the absorbed incident is no longer eligible.
   */
  const notifier: AgentNotifier = {
    notify: (incidentId, directive) => {
      void (async () => {
        let delivered: boolean;
        if (directive.type === "merged") {
          const h = harnessOf();
          const conversation = await incidentConversation(db, h, incidentId);
          if (conversation) {
            dispatcher.noteStopped(incidentId);
            await conversation.abort(h.context);
          }
          delivered = conversation !== null;
        } else if (directive.type === "stop") {
          delivered = await agentLine.stop(incidentId, directive.reason);
        } else {
          delivered = await agentLine.tell(incidentId, directiveText(directive), undefined);
        }
        if (!delivered) {
          log("agent_notice_no_conversation", { incidentId, directive: directive.type });
        }
      })().catch((err: unknown) =>
        alarm("agent_notice_failed", {
          incidentId,
          directive: directive.type,
          error: String(err),
        }),
      );
    },
  };

  // The App's installation token as it is right now. Read synchronously by
  // every bash call, so it is cached here and refreshed well inside its hour
  // rather than minted per command.
  let githubToken: string | undefined;
  const refreshGitHubToken = async (): Promise<void> => {
    if (!options.githubToken) return;
    try {
      githubToken = await options.githubToken();
    } catch (err: unknown) {
      // The previous token is good for the rest of its hour, and an
      // investigation that cannot push is still worth more than one that
      // stopped.
      alarm("github_token_refresh_failed", { error: String(err) });
    }
  };
  await refreshGitHubToken();
  const githubTokenTimer = options.githubToken
    ? setInterval(() => void refreshGitHubToken(), GITHUB_TOKEN_REFRESH_MS)
    : null;
  githubTokenTimer?.unref();

  // Built from nothing: the Boss's own environment holds every secret it has,
  // and an agent's shell needs none of them. See agent/shell-env.ts.
  const agentShellEnv = buildAgentShellEnv({
    base: {
      ...pickBaseEnv(process.env),
      AWS_REGION: secrets.awsRegion ?? process.env.AWS_REGION,
      AWS_DEFAULT_REGION: secrets.awsRegion ?? process.env.AWS_DEFAULT_REGION,
    },
    credentials: {
      // Only when it resolved. A refused URL is withheld deliberately: with
      // this unset omni's harness goes back to starting its own container
      // and says so, which is a better answer for fifteen agents than
      // whatever a bad URL named.
      ...(config.testDatabase.state === "configured"
        ? { [TEST_DB_ENV_VAR]: config.testDatabase.url }
        : {}),
      ...(secrets.grafanaUrl ? { GRAFANA_URL: secrets.grafanaUrl } : {}),
    },
  });

  /**
   * Every outbound message, with its incident references capitalised and
   * linked, on the way to Slack.
   *
   * Wrapped here rather than at each composer because there is no single
   * place above this where BugBoss composes text: the relay, the Slack
   * agent, the tool API, the merge announcements, the closing report and
   * three call sites in this file each build their own. A pass on some of
   * them would be the same inconsistency with a new cause.
   *
   * It goes outside the deadline wrapper, so a permalink lookup it makes is
   * itself bounded and never eats the budget of the post it is preparing.
   */
  const incidentRefs = createIncidentReferences({
    threads: {
      incidentForThread: (threadTs) =>
        db.get<{ id: string }>(
          "SELECT id FROM incident WHERE slackThreadTs = ?",
          [threadTs],
        )?.id ?? null,
      threadOf: (incidentId) =>
        db.get<{ slackThreadTs: string | null }>(
          "SELECT slackThreadTs FROM incident WHERE id = ?",
          [incidentId],
        )?.slackThreadTs ?? null,
    },
    permalink: (messageTs) => deadlined.permalink(messageTs),
  });
  const slack = withIncidentReferences(deadlined, incidentRefs);

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

  /**
   * Threads outside any incident where the Boss already has a conversation,
   * which is where an untagged follow-up is still a message for the Boss. A
   * `boss_thread` row, read from what the Boss did in the thread, never from
   * what the message says.
   */
  const isBossThread = async (channel: string, threadTs: string): Promise<boolean> =>
    db.get("SELECT 1 FROM boss_thread WHERE channel = ? AND threadTs = ?", [
      channel,
      threadTs,
    ]) !== undefined;

  /**
   * Before the run, so a follow-up typed while this one is still being
   * answered already reaches the Boss. The commander records the thread's
   * conversation on the same row when it creates one.
   */
  const recordBossThread = async (channel: string, threadTs: string): Promise<void> => {
    try {
      await db.withWrite((w) => {
        w.prepare(
          "INSERT OR IGNORE INTO boss_thread (channel, threadTs, since) VALUES (?, ?, ?)",
        ).run(channel, threadTs, now());
      });
    } catch (err) {
      // A follow-up in this thread is dropped at ingress until the row lands.
      alarm("boss_thread_unrecorded", { channel, threadTs, error: String(err) });
    }
  };

  const slackIngress: SlackConfig = {
    signingSecret: secrets.slackSigningSecret,
    botUserId: secrets.slackBotUserId,
    isIncidentThread: (_channel, threadTs) =>
      db.get("SELECT id FROM incident WHERE slackThreadTs = ?", [threadTs]) !==
      undefined,
    isBossThread,
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
    isBossThread,
  });

  const bossExtension = await createBossExtension({
    db,
    onAgentStop: (incidentId) => dispatcher.noteStopped(incidentId),
    status: {
      // The status card's one model-written sentence, on the knob that moves
      // a small bounded call to a cheaper model (BUGBOSS_INTENT_MODEL_ID)
      // without a deploy.
      summarise: createStatusSummariser(options.intentModel ?? options.model),
      cache: new Map(),
      now,
    },
    // The same executor a report always went through; only who decides a
    // message is a report has moved, from a classifier to the Boss.
    openIncident: async (report) =>
      (await reportAccepted({ ...report, reportedAt: now() })).settled,
    gh: options.gh,
    slack,
    commands: {
      db,
      threads: {
        post: (threadTs, text) => slack.post(threadTs, text, config.slackChannelId),
        permalink: (messageTs) => slack.permalink(messageTs, config.slackChannelId),
      },
      closeIncident: (args) =>
        closeIncidentByBoss({ db, slack: threads, agents: notifier, announceClose }, args),
      rotationGroupId: secrets.slackRotationGroupId ?? null,
      // A merge the Boss runs tells the absorbed agent to stop and the
      // surviving one what arrived, the same way an agent's own does.
      notifier,
    },
    harness: harnessOf,
    now,
  });

  const slackAgent = new SlackAgent({
    db,
    slack,
    runtime: createBossRuntime({
      db,
      harness: harnessOf,
      extension: bossExtension,
      model: { provider: options.models.boss.provider, modelId: options.models.boss.id },
      now,
    }),
    config: {
      botUserId: secrets.slackBotUserId ?? "",
      // The Slack agent's fallback for a failure the thread cannot carry.
      // Both values are already computed for the relay above; leaving them
      // unset made that whole path unreachable in production.
      alertChannel: config.slackChannelId,
      rotationGroupId: secrets.slackRotationGroupId ?? null,
      incidentChannel: config.slackChannelId,
    },
  });

  // The relay's, so the two pings are spelled one way and carry the same
  // trailing space.
  const mention = mentionPrefix(secrets.slackRotationGroupId ?? null);

  /**
   * A thread belongs to an incident, not to the ingest that happened to open
   * one. reportRootCause splits unexplained signals into incidents of their
   * own without passing anywhere near ingest, and a post that fails leaves an
   * incident threadless for good; in both cases its notices post top level
   * and nobody can talk to the Boss about it, because a reply reaches the Boss
   * by matching slackThreadTs. So this keys off the incident and retries.
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
        // The labels as well as the title: the opening message links the
        // signal that opened the incident.
        const signals = db.query<{
          source: string;
          title: string;
          labels: string;
        }>(
          "SELECT source, title, labels FROM signal WHERE incidentId = ? ORDER BY openedAt, id LIMIT 1",
          [row.id],
        );
        const first = signals[0];
        try {
          await relay.emit({
            type: "opened",
            incidentId: row.id,
            title: first?.title ?? `Incident ${row.id}`,
            origin: first
              ? await signalOrigin(
                  { source: first.source, labels: JSON.parse(first.labels) as Record<string, string> },
                  deadlined,
                )
              : null,
          });
          opened++;
          // An agent can write to the Boss before its incident has a thread,
          // and the wake for that row found nowhere to answer. Now there is.
          const unseen = db.get(
            "SELECT 1 FROM boss_inbox WHERE incidentId = ? AND seenAt IS NULL LIMIT 1",
            [row.id],
          );
          if (unseen) {
            void slackAgent
              .handleIncident({ incidentId: row.id, trigger: { kind: "inbox" } })
              .catch((err: unknown) =>
                alarm("boss_wake_failed", { incidentId: row.id, error: String(err) }),
              );
          }
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
      `SELECT id, status, rootCause, firstSignalAt FROM incident
       WHERE status IN ('INVESTIGATING','FIXING','RESOLVED')
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
    judgeMerge: async ({ incidentId, withIncidentId, reason }) => {
      const { merge, compared } = await triage.judgeMerge({
        incidentId,
        withIncidentId,
        reason,
        openIncidents: openIncidents(),
      });
      return {
        merge: merge
          ? { absorb: merge.incidentId, into: merge.into, reason: merge.reason }
          : null,
        compared,
      };
    },
  };

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

  const toolApiFor = (incidentId: string): ToolApi => {
    const api = createToolApi({
      db,
      incidentId,
      agents: notifier,
      correlator,
      slack: threads,
      evidence,
      announceClose,
    });

    return {
      ...api,
      // The dispatcher's own escalations, which have no agent run behind
      // them to tell the Boss: a crash loop, a stall, a deadline. The tool
      // API posts the brief itself; this adds the ping, which is the one
      // thing it cannot know to do.
      escalate: async (args) => {
        const response = await api.escalate(args);
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
      return await applyAssign(db, req, { kind: "boss" }, opts, notifier);
    } catch (err) {
      if (target === "NEW" || !(err instanceof AssignError)) throw err;
      alarm("assign_target_vanished", {
        signalId,
        target,
        error: String(err),
      });
      return applyAssign(db, { ...req, target: "NEW" }, { kind: "boss" }, opts, notifier);
    }
  };

  /**
   * Accumulate rather than replace, which is the opposite of how the incident
   * row is written. `rollUpUsage` re-reads a whole conversation's usage, so
   * its total is already absolute and a SET is correct there. Here each triage decision
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
   * A mention the Boss read as a report, filed through its open_incident
   * tool. It has no ingress channel of its own: what makes it a report is the
   * Boss's reading rather than anything the webhook body says, so the signal
   * is built here and placed through the human adapter, which is also what
   * Signal.source already points the orphan sweep at.
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

  /**
   * Put each incident's spend on its row: tokens by class, summed from its
   * conversation's `UsageDoc`.
   *
   * Tokens rather than dollars. Bedrock returns tokens; a price is arithmetic
   * against a table that goes stale the day AWS moves a rate, and a stored
   * dollar figure has nothing in it that could ever say so. Tokens plus
   * `modelId` re-price whenever someone asks, so every dollar figure is an
   * estimate derived where it is shown (`priceTokens`).
   *
   * Every model bucket counts, the goal evaluator's included, and so does
   * every tool bucket. `modelId` is the bucket that produced the most output,
   * so a cheaper evaluator adds its tokens without taking the row's model.
   *
   * Idempotent. Totals are absolute over the whole document, so a re-read
   * counts every launch once, and a row is only written when a number
   * changed. A total below the one already stored is never written, because
   * usage only grows: a smaller one is a read that lost a race, or an
   * incident from before the harness whose fresh conversation started at
   * zero beside the totals its session file put on the row. The check is
   * repeated inside the write for the race. No conversation leaves the row
   * alone.
   *
   * One write for the whole batch, because every write is a snapshot PUT.
   * Returns how many rows changed.
   */
  const rollUpUsage = async (incidentIds: readonly string[]): Promise<number> => {
    type Spend = {
      tokensIn: number;
      tokensOut: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite1h: number;
      modelId: string | null;
    };
    const totalOf = (s: Spend): number => s.tokensIn + s.tokensOut + s.cacheRead + s.cacheWrite;
    const SPEND_SQL = `SELECT tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h,
                              modelId, conversationId, turnsUsed FROM incident WHERE id = ?`;

    const changed: { incidentId: string; spend: Spend }[] = [];
    for (const incidentId of incidentIds) {
      try {
        const row = db.get<Spend & { conversationId: number | null; turnsUsed: number }>(
          SPEND_SQL,
          [incidentId],
        );
        if (!row || row.conversationId === null) continue;
        const usage = await harnessOf().usage(row.conversationId as ConversationId);

        const spent = spendOf(usage);
        const summed: Spend = {
          tokensIn: spent.tokensIn,
          tokensOut: spent.tokensOut,
          cacheRead: spent.cacheRead,
          cacheWrite: spent.cacheWrite,
          cacheWrite1h: spent.cacheWrite1h,
          modelId: spent.modelId ?? row.modelId,
        };

        if (totalOf(summed) === 0 && row.turnsUsed > 0 && Object.keys(usage.models).length > 0) {
          // A response always spends tokens, so this is not a cheap run: it
          // is a reader that no longer matches what the harness records.
          alarm("usage_missing", {
            incidentId,
            conversationId: row.conversationId,
            turns: row.turnsUsed,
          });
        }
        if (totalOf(summed) < totalOf(row)) {
          log("usage_behind_row", {
            incidentId,
            conversationId: row.conversationId,
            conversationTotal: totalOf(summed),
            rowTotal: totalOf(row),
          });
          continue;
        }

        const same =
          summed.tokensIn === row.tokensIn &&
          summed.tokensOut === row.tokensOut &&
          summed.cacheRead === row.cacheRead &&
          summed.cacheWrite === row.cacheWrite &&
          summed.cacheWrite1h === row.cacheWrite1h &&
          summed.modelId === row.modelId;
        if (!same) changed.push({ incidentId, spend: summed });
      } catch (err: unknown) {
        // Never fatal. Losing a cost number is not worth failing a run over.
        alarm("usage_roll_up_failed", { incidentId, error: String(err) });
      }
    }
    if (changed.length === 0) return 0;

    try {
      const flushed = await db.withWrite((w: Database.Database) => {
        const read = w.prepare(SPEND_SQL);
        const update = w.prepare(
          `UPDATE incident
             SET tokensIn = ?, tokensOut = ?, cacheRead = ?, cacheWrite = ?,
                 cacheWrite1h = ?, modelId = COALESCE(?, modelId)
           WHERE id = ?`,
        );
        const done: typeof changed = [];
        for (const entry of changed) {
          const { incidentId, spend } = entry;
          const current = read.get(incidentId) as Spend | undefined;
          if (!current || totalOf(spend) < totalOf(current)) continue;
          update.run(
            spend.tokensIn,
            spend.tokensOut,
            spend.cacheRead,
            spend.cacheWrite,
            spend.cacheWrite1h,
            spend.modelId,
            incidentId,
          );
          done.push(entry);
        }
        return done;
      });
      for (const { incidentId, spend } of flushed) {
        log("usage_rolled_up", { incidentId, ...spend });
      }
      return flushed.length;
    } catch (err: unknown) {
      alarm("usage_roll_up_failed", {
        incidentIds: changed.map((c) => c.incidentId),
        error: String(err),
      });
      return 0;
    }
  };

  /** The busy agents' spend, on every tick. */
  const sweepUsage = (): Promise<number> =>
    rollUpUsage(dispatcher.list().map((agent) => agent.incidentId));

  /** Every row's tokens, recomputed from its conversation. Run at boot. */
  const reconcileUsage = (): Promise<number> =>
    rollUpUsage(
      db
        .query<{ id: string }>(
          "SELECT id FROM incident WHERE conversationId IS NOT NULL ORDER BY id",
        )
        .map((row) => row.id),
    );

  /** First and last model response, for the closing report's wall clock. */
  const conversationSpan = async (
    conversationId: number,
  ): Promise<{ firstAt: number; lastAt: number } | null> => {
    const h = harnessOf();
    const conversation = await h.conversation(conversationId as ConversationId);
    let firstAt: number | null = null;
    let lastAt: number | null = null;
    for (const entry of await allEntries(conversation, h.context)) {
      if (entry.kind !== "pi.assistant") continue;
      const at = (entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp;
      if (typeof at !== "number") continue;
      if (firstAt === null || at < firstAt) firstAt = at;
      if (lastAt === null || at > lastAt) lastAt = at;
    }
    return firstAt === null || lastAt === null ? null : { firstAt, lastAt };
  };

  // -------------------------------------------------------------------------
  // The closing report
  // -------------------------------------------------------------------------

  const reportDeps: ReportDeps = {
    db,
    conversationSpan,
    post: (threadTs, text) => slack.post(threadTs, text),
    channel: config.slackChannelId,
    // The close notice rides on the file as its comment, so it reaches Slack
    // without passing the client every other message goes through.
    uploader: {
      upload: async (file) =>
        options.fileUploader.upload({
          ...file,
          comment:
            file.comment === null
              ? null
              : await incidentRefs.render(file.comment, file.threadTs),
        }),
    },
    prStates: options.prStates,
    // The merged-in rows too, since the report prices their tokens and a row
    // whose agent was killed by a deploy may not have been rolled up since.
    rollUpUsage: async (incidentId) => {
      const merged = db
        .query<{ id: string }>("SELECT id FROM incident WHERE mergedInto = ?", [incidentId])
        .map((row) => row.id);
      await rollUpUsage([incidentId, ...merged]);
    },
    now,
  };

  /**
   * The close's one message, sent by the close itself rather than by
   * anything that runs after the agent: the notice with the report attached.
   *
   * Usage is rolled up first (`reportDeps.rollUpUsage`), from the
   * conversation's usage as it stands. The response after report_analysis is
   * not in it yet, so the report's token figures are as of the close; the row
   * catches up on the next tick's roll-up. Never throws: the close has
   * already committed.
   */
  const announceClose = async (incidentId: string): Promise<void> => {
    try {
      await publishIncidentReport(reportDeps, incidentId);
    } catch (err: unknown) {
      alarm("report_publish_failed", { incidentId, error: String(err) });
    }
  };

  const sweepReports = (): Promise<number> => publishPendingReports(reportDeps);

  /**
   * The status board: every thread's header, the morning post and the
   * all-clear.
   *
   * Runs off the tick that already runs rather than a schedule of its own.
   * Every merge to ops `main` restarts this container, so an in-memory
   * "next fire at 07:00" either fires twice or is skipped depending on when
   * a deploy lands. Everything this needs to remember is a row in SQLite --
   * see `board/index.ts`.
   *
   * Not run at startup, unlike its three neighbours. Those exist to catch
   * work a restart interrupted; this one only looks at the world, and at
   * boot the world is still being put back together -- the orphan and thread
   * sweeps are running, so a board read now is a board about to change. It
   * waits one tick.
   */
  const sweepTheBoard = (): Promise<unknown> =>
    sweepBoard({
      db,
      post: (text) => slack.post(null, text, config.slackChannelId),
      update: (channel, ts, text) => slack.update(channel, ts, text),
      origin: async (incidentId) => {
        const first = db.get<{ source: string; labels: string }>(
          "SELECT source, labels FROM signal WHERE incidentId = ? ORDER BY openedAt, id LIMIT 1",
          [incidentId],
        );
        return first
          ? signalOrigin(
              { source: first.source, labels: JSON.parse(first.labels) as Record<string, string> },
              deadlined,
              true,
            )
          : null;
      },
      channel: config.slackChannelId,
      now,
    });

  // -------------------------------------------------------------------------
  // The harness every agent runs on
  // -------------------------------------------------------------------------

  const portFor = (incidentId: string): AgentPort =>
    createAgentPort({
      db,
      incidentId,
      wakeBoss: (id) => wakeBoss(id),
      sql: createSidecarSqlPort({ db, incidentId, sqlRunnerUrl: config.sqlRunnerUrl }),
      noteEscalated: (id) => dispatcher.noteEscalated(id),
      now,
    });

  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  const agentModel = options.models.agent;

  const incidentExtensions: IncidentExtensions = await createIncidentExtensions({
    db,
    toolApiFor,
    port: portFor,
    harness: harnessOf,
    githubToken: () => githubToken,
    shellEnv: () => agentShellEnv,
    ...(secrets.grafanaUrl && secrets.grafanaServiceAccountToken
      ? { grafana: { url: secrets.grafanaUrl, token: secrets.grafanaServiceAccountToken } }
      : {}),
    ...(config.workingHours ? { workingHours: parseWorkingHours(config.workingHours) } : {}),
    maxTurns: (incidentId) =>
      config.dispatcher.agentMaxTurns +
      (db.get<{ grantedTurns: number }>("SELECT grantedTurns FROM incident WHERE id = ?", [
        incidentId,
      ])?.grantedTurns ?? 0),
    ...(options.goalModel
      ? { goals: { client: options.goalModel, contextWindow: options.goalModel.contextWindow } }
      : {}),
    workRoot,
    ...(options.reviewSettleSeconds === undefined ? {} : { reviewSettleSeconds: options.reviewSettleSeconds }),
    now,
  });
  const toolNames = incidentExtensions.flatMap((extension) =>
    (extension.tools ?? []).map((tool) => tool.name),
  );

  agents = await openBugbossHarness({
    storage: harnessStorage,
    models: options.models.models,
    extensions: [...incidentExtensions, bossExtension],
    // A conversation's own cwd is what selects its shell, and only an
    // incident agent has one; the GitHub token is added per call by bash.
    shellEnv: () => agentShellEnv,
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: agentModel.maxTokens + COMPACTION_KEEP_RECENT_TOKENS,
        keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
        backgroundTokens: 0,
      },
      // The prefix is written with a 1h ttl, because a blocking tool's turn
      // is the one request that can outlast the 5m cache.
      stream: { cacheRetention: "long" },
      toolExecution: "parallel",
    },
    onReport: (error) => alarm("harness_report", { error: String(error) }),
  });
  const offCommit = mirror ? agents.onCommit(() => mirror?.markDirty()) : () => {};

  const runtime: AgentRuntime = {
    createIncidentConversation: async (incidentId, a) => {
      const h = harnessOf();
      const conversation = await h.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: incidentAgentChange({
            model: { provider: agentModel.provider, modelId: agentModel.id },
            cwd: a.cwd,
            instructions: a.instructions,
          }),
          init: incidentInit(incidentId),
        },
        h.context,
      );
      return conversation.id;
    },
    submit: async (id, content, o) => {
      const h = harnessOf();
      const conversation = await h.conversation(id);
      const submission = await conversation.submit(
        { type: "input", content, whenBusy: o.whenBusy, requestId: o.requestId },
        h.context,
      );
      return {
        wait: async () => (await submission.wait(h.context)).status,
      };
    },
    isBusy: (id) => harnessOf().isBusy(id),
    abort: async (id) => {
      const h = harnessOf();
      await (await h.conversation(id)).abort(h.context);
    },
    reset: async (id, handoff) => {
      const h = harnessOf();
      await (await h.conversation(id)).reset(handoff, h.context);
    },
  };

  const dispatcher = createDispatcher({
    db,
    config: config.dispatcher,
    runtime,
    toolApiFor,
    composePrompt: async (incidentId, a) =>
      composeSystemPrompt({
        incidentId,
        checkoutPath: a.paths.checkout,
        toolNames,
        npmCiDoneMarker: a.paths.npmCiDone,
        npmCiFailedMarker: a.paths.npmCiFailed,
        ...(await loadPromptContext(a.paths.checkout, { alertSlugs: a.alertSlugs })),
      }),
    messages: {
      // An incident launched before with no conversation predates the
      // harness: the kickoff says so and carries the durable story instead.
      kickoff: (incidentId, o) =>
        kickoffMessage(incidentId, {
          resumedWithoutTranscript: o.resumedWithoutTranscript,
          ...(o.resumedWithoutTranscript ? { handoff: cutoverHandoff(db, incidentId) } : {}),
        }),
      resume: resumeMessage,
    },
    workRoot,
    ...(options.repoUrl
      ? {
          // The clone runs in this process now, so it gets the agent's shell
          // environment rather than the Boss's.
          workspace: {
            repoUrl: options.repoUrl,
            env: async () => withGitHubToken(agentShellEnv, githubToken),
          },
        }
      : {}),
    // The dispatcher has no Slack of its own and the tool API cannot say
    // anything that is not a transition, so the one thing it needs to tell a
    // human -- that nothing has touched their incident in a long time -- is
    // handed over the same way the tool API's thread poster is.
    postNotice: async (incidentId, text) => {
      const threadTs =
        db.get<{ slackThreadTs: string | null }>(
          "SELECT slackThreadTs FROM incident WHERE id = ?",
          [incidentId],
        )?.slackThreadTs ?? null;
      // A threadless incident is a real state -- opening one can fail, and
      // it can fail for good. `slack.post(null, ...)` is a top-level channel
      // message, so posting anyway would put a notice about "this incident"
      // in the channel with nothing saying which incident. Alarming
      // is the same answer the dispatcher gives when no poster is wired in
      // at all: the event still reaches somebody, out of context does not.
      if (!threadTs) {
        alarm("stale_notice_undeliverable", {
          incidentId,
          note: "the incident has no Slack thread, so the notice was not posted where anyone is watching",
        });
        return;
      }
      await slack.post(threadTs, text);
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
   * An @bugboss mention outside any incident thread. It goes to the Boss
   * whole, bare or not: whether it is a report, a question or a request to
   * act is the Boss's to read, and it opens an incident through open_incident
   * when it is a report. A classifier in front of it once answered "Can you
   * close incident 2?" with "is that a report or a question?".
   */
  const answerMention = async (
    route: Extract<InboundRoute, { kind: "slack_agent" }>,
  ): Promise<void> => {
    // Before the run, so a follow-up typed while this one is still being
    // answered already reaches the Boss. A top-level mention's thread is the
    // mention's own ts, which is where the answer goes.
    await recordBossThread(route.channel, route.threadTs);
    await slackAgent.handle({
      channel: route.channel,
      threadTs: route.threadTs,
      ts: route.ts,
      user: route.user,
      text: route.text,
      tagged: route.tagged,
    });
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
      // Every message in an incident thread, tagged or not, is the Boss's,
      // with the incident as context. It answers, stays silent, or talks to
      // the agent; nothing here reads what the message meant.
      return {
        routed: route.kind,
        settled: slackAgent.handleIncident({
          incidentId: route.incidentId,
          trigger: {
            kind: "human",
            user: route.user,
            text: route.text,
            ts: route.ts,
          },
        }),
      };
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
   * An agent wrote to the Boss's inbox. The Boss drains the inbox itself, so
   * a wake that lands while it is already running for this incident is picked
   * up by that run. Nothing waits on it, so its failure alarms here or nobody
   * hears of it: the agent's question would sit unread.
   */
  const wakeBoss: WakeBoss = (incidentId) => {
    void slackAgent
      .handleIncident({ incidentId, trigger: { kind: "inbox" } })
      .catch((err: unknown) =>
        alarm("boss_wake_failed", { incidentId, error: String(err) }),
      );
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
    slackConfig: slackIngress,
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
    servers = startServers({ publicApp, config: options.http });
    // Turns before anything runs, so the first budget read after a restart
    // is the transcript's count; then every run the last container left in
    // flight carries on, and only then does the dispatcher look for idle
    // incidents to launch.
    background("startup_agents", async () => {
      try {
        const backfilled = await backfillSpentBudgets(db);
        if (backfilled > 0) log("turns_backfilled_at_boot", { incidents: backfilled });
        const reconciled = await reconcileTurns({ db, harness: harnessOf() });
        if (reconciled > 0) log("turns_reconciled_at_boot", { incidents: reconciled });
      } catch (err: unknown) {
        alarm("turns_reconcile_failed", { error: String(err) });
      }
      harnessOf().harness.resume();
      dispatcher.start();
    });
    // A restart is the one moment nothing is in flight, so every unplaced
    // signal and every threadless incident on disk is real rather than young.
    background("startup_sweep", sweepOrphans);
    background("startup_threads", ensureIncidentThreads);
    // Usage first: a report the last container never published is about to
    // price these rows' tokens, and this pass is what makes them whole.
    background("startup_usage_and_reports", async () => {
      await reconcileUsage();
      await sweepReports();
    });
    resolutionTimer = setInterval(() => {
      background("usage_sweep", sweepUsage);
      background("orphan_sweep", sweepOrphans);
      background("thread_sweep", ensureIncidentThreads);
      // After the thread sweep, so an incident whose thread was opened on
      // this tick can carry a header on it rather than waiting for the next.
      background("board_sweep", sweepTheBoard);
      // Nothing relaunches an agent on a CLOSED incident, so a container
      // replaced between the close and its report is the one case where the
      // report has no other way out.
      background("report_sweep", sweepReports);
      // Never throws, and never halts anything: a transcript a tick behind
      // the incident tables costs the model one "already FIXING" result.
      if (mirror) background("harness_snapshot", () => mirror!.snapshotIfDirty());
    }, config.dispatcher.tickSeconds * 1000);
    resolutionTimer.unref();
    log("started", { env: config.env, bucket: config.s3Bucket });
  };

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      dispatcher.stop();
      if (resolutionTimer) clearInterval(resolutionTimer);
      resolutionTimer = null;
      if (githubTokenTimer) clearInterval(githubTokenTimer);
      servers?.close();
      servers = null;
      offCommit();
      // Closed before the last snapshot, so the snapshot holds every commit
      // the harness will ever make in this process.
      try {
        await harnessOf().close();
      } catch (err: unknown) {
        alarm("harness_close_failed", { error: String(err) });
      }
      incidentExtensions.close();
      if (mirror) {
        await mirror.snapshotIfDirty();
        mirror.close();
      }
      db.close();
      log("stopped");
    })();
    return stopping;
  };

  return {
    db,
    dispatcher,
    relay,
    ingress,
    publicApp,
    agents,
    toolApiFor,
    portFor,
    ingest,
    ingestAccepted,
    slackEvent,
    slackEventAccepted,
    dispatchOnce,
    sweepOrphans,
    ensureIncidentThreads,
    sweepReports,
    sweepBoard: sweepTheBoard,
    sweepUsage,
    reconcileUsage,
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
  goalModelId: env.BUGBOSS_GOAL_MODEL_ID,
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
      agentMaxTurns: Number(env.BUGBOSS_MAX_TURNS ?? INCIDENT_AGENT_MAX_TURNS),
      maxAttempts: Number(env.BUGBOSS_MAX_ATTEMPTS ?? 3),
      staleAfterSeconds: Number(env.BUGBOSS_STALE_HOURS ?? 24) * 3600,
    },
    prodCriticalSlugs: (env.BUGBOSS_PROD_CRITICAL_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
    // Parsed and discarded: createBugBoss parses it again for the agents'
    // tools, and this is here so a typo stops the container while the
    // config is read rather than after the database is restored.
    ...(env.BUGBOSS_WORKING_HOURS
      ? {
          workingHours: (() => {
            parseWorkingHours(env.BUGBOSS_WORKING_HOURS);
            return env.BUGBOSS_WORKING_HOURS;
          })(),
        }
      : {}),
    // Same trick, same reason. A typo in the profile map is loud here, at
    // boot, where somebody is looking, rather than as a silently missing line
    // on next month's bill.
    ...(env.BUGBOSS_INFERENCE_PROFILES
      ? {
          inferenceProfiles: (() => {
            parseInferenceProfiles(env.BUGBOSS_INFERENCE_PROFILES);
            return env.BUGBOSS_INFERENCE_PROFILES;
          })(),
        }
      : {}),
    testDatabase: resolveTestDatabase(env),
    ...(env.BUGBOSS_SQL_RUNNER_URL ? { sqlRunnerUrl: env.BUGBOSS_SQL_RUNNER_URL } : {}),
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

  const githubToken = env.BUGBOSS_GITHUB_TOKEN_FILE
    ? tokenFromFile(env.BUGBOSS_GITHUB_TOKEN_FILE)
    : secrets.githubAppId &&
    secrets.githubAppPrivateKey &&
    secrets.githubAppInstallationId
      ? createInstallationToken({
          appId: secrets.githubAppId,
          privateKey: secrets.githubAppPrivateKey,
          installationId: secrets.githubAppInstallationId,
        })
      : null;
  if (!githubToken) {
    log("github_app_absent", {
      note: "no GitHub credentials; agents can read but cannot open a PR",
    });
  }
  const reviewSettleSeconds = env.BUGBOSS_REVIEW_SETTLE_SECONDS
    ? Number(env.BUGBOSS_REVIEW_SETTLE_SECONDS)
    : Number.NaN;
  // One Models for every request this process makes, with the InvokeModel
  // routing asserted for each model it resolved before anything runs.
  const models = await createBugbossModels({
    agentModelId: secrets.agentModelId ?? DEFAULT_MODEL_ID,
    bossModelId: secrets.triageModelId ?? DEFAULT_TRIAGE_MODEL_ID,
    ...(secrets.intentModelId ? { intentModelId: secrets.intentModelId } : {}),
    goalModelId: secrets.goalModelId ?? DEFAULT_GOAL_MODEL_ID,
    inferenceProfiles: parseInferenceProfiles(config.inferenceProfiles),
  });
  const clientFor = (model: Model<Api>): SizedModelClient =>
    createPiModelClient({
      models: models.models,
      model: model as Model<BedrockInvokeModelApi>,
    });

  // Once, before the first launch: every agent's git reads the token from
  // its environment through this helper, so no clone URL ever holds one.
  await configureGitCredentials();

  return createBugBoss({
    config,
    model: clientFor(models.boss),
    // Only when a different model is named for it. Every inbound Slack
    // message costs one of these calls, so this is the knob that takes them
    // off the triage model without a deploy.
    intentModel: models.intent ? clientFor(models.intent) : undefined,
    models,
    goalModel: models.goal ? clientFor(models.goal) : undefined,
    ...(githubToken ? { githubToken } : {}),
    repoUrl: env.BUGBOSS_OMNI_REPO ?? DEFAULT_OMNI_REPO,
    workRoot: env.BUGBOSS_WORK_ROOT ?? DEFAULT_WORK_ROOT,
    ...(Number.isFinite(reviewSettleSeconds) && reviewSettleSeconds >= 0 ? { reviewSettleSeconds } : {}),
    slack: createSlackClient(secrets.slackBotToken, config.slackChannelId),
    // The closing report uploads as a file. Same token as every other post,
    // but the `files:write` scope it needs is granted only when somebody
    // reinstalls the app -- until then the close notice goes out alone and
    // the retries end in an alarm.
    fileUploader: createSlackFileUploader(secrets.slackBotToken),
    // Only when the App is configured; a report without PR states is still a
    // report. One token source for both, cached and re-minted before expiry
    // by @octokit/auth-app, the same way an incident agent's is.
    prStates: githubToken ? createPrStateReader(githubToken) : undefined,
    gh: githubToken ? createGhExec({ token: githubToken }) : null,
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
        // The stop is what puts the last commits of every conversation in S3,
        // so the exit waits for it.
        process.once(signal, () => {
          void boss.stop().finally(() => process.exit(0));
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
