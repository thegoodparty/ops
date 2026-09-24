// The composition root. Design spec: docs/bugboss/design.md.
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

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import type Database from "better-sqlite3";
import type { Hono } from "hono";

import { Db } from "./db";
import {
  createChildProcessSpawn,
  createAssumeRoleCredentials,
  createDispatcher,
  pickBaseEnv,
  type AgentCredentialProvider,
  type Dispatcher,
  type SpawnAgent,
  type TickResult,
} from "./dispatcher";
import {
  createIngress,
  SLUG_LABEL,
  type GrafanaVerifier,
  type IngressRegistry,
  type SlackConfig,
  type SlackVerifier,
} from "./ingress";
import { humanSignal } from "./ingress/human";
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
import { createMcpServer } from "./mcp";
import type { BugBossMcp, HumanBugReport, McpConfig, ReportSignalResult } from "./mcp";
import { mcpConfigFromEnv } from "./mcp/config";
import { createS3SessionStore } from "./mcp/sessions";
import { SlackAgent, type ObjectStore, type SlackAgentModel, type SlackClient } from "./slack/agent";
import { createS3ObjectStore, createSlackClient } from "./slack/client";
import { SlackRelay, type SlackEvent } from "./slack/relay";
import {
  applyAssign,
  createToolApi,
  mintAgentToken,
  type Correlator,
  type EvidenceStore,
} from "./toolapi";
import { createTriage, type ModelClient, type ModelReply, type ModelToolCall, type ModelTurn } from "./triage";
import { attachedSignalIds } from "./triage/sql";
import type {
  BugBossConfig,
  Evidence,
  IncidentDigest,
  IncidentStatus,
  IncomingRequest,
  RawSignal,
  Signal,
  SignalAdapter,
  ToolApi,
} from "./types";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "boss", event, ...data }));

const alarm = (event: string, data?: Record<string, unknown>) =>
  console.error(
    JSON.stringify({ component: "boss", level: "error", event, ...data }),
  );

/** Statuses an incident can still take a signal on, or be merged into. */
const OPEN_STATUSES: IncidentStatus[] = ["INVESTIGATING", "FIXING", "RESOLVED"];

export const DEFAULT_TRIAGE_MODEL_ID = "us.anthropic.claude-sonnet-5";

/**
 * Where an incident agent's session lives. Chunk 5's own default writes to
 * `sessions/<id>.jsonl`, but the Slack agent's read_agent_session tool, the
 * MCP session reader and the S3 lifecycle rule all read
 * `sessions/incident/<id>/`, so the launch below passes this explicitly.
 */
export const incidentSessionKey = (incidentId: string): string =>
  `sessions/incident/${incidentId}/session.jsonl`;

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
  githubToken?: string;
  /** STS role the parent assumes for each child. Chunk 9 creates it. */
  agentRoleArn?: string;
  triageModelId?: string;
  agentModelId?: string;
  awsRegion?: string;
}

export interface CreateBugBossOptions {
  config: BugBossConfig;
  /** The Boss's own bounded calls: triage, correlation, the Slack agent. */
  model: ModelClient;
  slack: SlackClient;
  /** What a launch means. Defaults to a scrubbed child process. */
  spawnAgent?: SpawnAgent;
  /** Omitted means no S3: state stays in memory and dies with the process. */
  s3?: S3Client;
  credentials?: AgentCredentialProvider;
  /** Overrides the default harness the Slack agent runs on. */
  slackAgentModel?: SlackAgentModel;
  secrets?: BugBossSecrets;
  /** Absent means the MCP server is not mounted. */
  mcpConfig?: McpConfig;
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

export interface BugBoss {
  readonly db: Db;
  readonly dispatcher: Dispatcher;
  readonly relay: SlackRelay;
  readonly ingress: IngressRegistry;
  /** Webhooks, health and MCP. start() binds it; it is servable on its own. */
  readonly publicApp: Hono;
  /** The agent tool API. Bound to 127.0.0.1 by start(). */
  readonly loopbackApp: Hono;
  /** The bearer a child is handed. Also how a test drives the loopback API. */
  mintToken(incidentId: string): string;
  /** Scoped to one incident by the token, which the caller may supply. */
  toolApiFor(incidentId: string, token?: string): ToolApi;
  ingest(source: string, req: IncomingRequest): Promise<PlacedSignal[]>;
  /** An already-verified Slack Events payload: relay it, then answer it. */
  slackEvent(event: SlackEvent): Promise<void>;
  /** The MCP report_signal tool. Same path a Slack report takes. */
  reportSignal(report: HumanBugReport): Promise<ReportSignalResult>;
  /** One dispatcher tick, waited out. Agents normally outlive a tick. */
  dispatchOnce(): Promise<TickResult>;
  /** Ask every adapter whether its signal stopped. Never moves an incident. */
  tickResolution(): Promise<number>;
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

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: { type: "text"; text: string }[];
      is_error?: boolean;
    };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

/**
 * Anthropic requires every tool_result answering one assistant turn to arrive
 * in a single user message, and runStructuredCall emits one ModelTurn per
 * call, so consecutive results are coalesced here.
 */
const toAnthropicMessages = (turns: ModelTurn[]): AnthropicMessage[] => {
  const out: AnthropicMessage[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: turn.text }] });
      continue;
    }
    if (turn.role === "assistant") {
      const content: AnthropicBlock[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      if (content.length === 0) content.push({ type: "text", text: "(no reply)" });
      out.push({ role: "assistant", content });
      continue;
    }
    const block: AnthropicBlock = {
      type: "tool_result",
      tool_use_id: turn.toolCallId,
      content: [{ type: "text", text: turn.text }],
      ...(turn.isError ? { is_error: true } : {}),
    };
    const last = out[out.length - 1];
    if (last && last.role === "user" && last.content.every((b) => b.type === "tool_result")) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
};

export interface BedrockModelClientConfig {
  modelId: string;
  region?: string;
  client?: BedrockRuntimeClient;
}

/**
 * The Boss's own model seam, over InvokeModel with the native Anthropic body.
 * Separate from bugboss/bedrock, which is a Pi api provider for the incident
 * agent: these calls are one-shot, bounded and streamless, and carry no
 * thinking blocks to keep signed.
 */
export const createBedrockModelClient = (
  cfg: BedrockModelClientConfig,
): ModelClient => {
  const client =
    cfg.client ??
    new BedrockRuntimeClient(cfg.region ? { region: cfg.region } : {});
  const decoder = new TextDecoder();

  return {
    complete: async (request) => {
      const body = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: request.maxTokens,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      };

      const response = await client.send(
        new InvokeModelCommand({
          modelId: cfg.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        }),
        { abortSignal: request.signal },
      );

      const payload = JSON.parse(decoder.decode(response.body)) as {
        content?: {
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }[];
      };

      let text = "";
      const toolCalls: ModelToolCall[] = [];
      for (const block of payload.content ?? []) {
        if (block.type === "text" && block.text) text += block.text;
        if (block.type === "tool_use" && block.id && block.name) {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          });
        }
      }
      return { text, toolCalls } satisfies ModelReply;
    },
  };
};

const SLACK_AGENT_BUDGET_MS = 120_000;

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
    for (let turn = 0; turn < req.maxTurns; turn++) {
      const reply = await model.complete({
        system: req.system,
        messages: [...messages],
        tools,
        maxTokens: 4096,
        signal: AbortSignal.timeout(SLACK_AGENT_BUDGET_MS),
      });
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
    }

    await store.put(key, JSON.stringify(messages));
    return {
      text: answer || "I ran out of turns before I had an answer for that.",
    };
  },
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

  const s3 = options.s3 ?? createMemoryS3();
  const db = await Db.open({
    path: config.dbPath,
    bucket: config.s3Bucket,
    key: "state/db",
    s3,
  });
  const store = createS3ObjectStore(config.s3Bucket, s3);

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
    },
    slack: slackIngress,
    human: {},
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
    slack: options.slack,
    config: {
      channelId: config.slackChannelId,
      botUserId: secrets.slackBotUserId ?? "",
      rotationGroupId: secrets.slackRotationGroupId ?? null,
    },
  });

  const slackAgent = new SlackAgent({
    db,
    store,
    slack: options.slack,
    model: options.slackAgentModel ?? createSlackAgentModel(options.model, store),
    config: { botUserId: secrets.slackBotUserId ?? "" },
  });

  const mention = secrets.slackRotationGroupId
    ? `<!subteam^${secrets.slackRotationGroupId}>`
    : "<!here>";

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

    const titles = new Map<string, string[]>();
    for (const row of db.query<{ incidentId: string; title: string }>(
      "SELECT incidentId, title FROM signal WHERE incidentId IS NOT NULL ORDER BY openedAt, id",
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
  const mintToken = (incidentId: string) =>
    mintAgentToken(tokenSecret, { incidentId, attempt: 0 });

  const toolApiFor = (incidentId: string, token?: string): ToolApi => {
    const api = createToolApi({
      db,
      token: token ?? mintToken(incidentId),
      tokenSecret,
      correlator,
      slack: options.slack,
      evidence,
      tracksResolution: (source) => ingress.get(source).tracksResolution,
    });

    return {
      ...api,
      // The only transition that has to reach the rotation. The tool API
      // posts the brief itself; this adds the ping, which is the one thing it
      // cannot know to do.
      handOff: async (args) => {
        const response = await api.handOff(args);
        if (response.ok) {
          await options.slack
            .post(
              db.get<{ slackThreadTs: string | null }>(
                "SELECT slackThreadTs FROM incident WHERE id = ?",
                [incidentId],
              )?.slackThreadTs ?? null,
              `${mention} Incident ${incidentId} needs a human: ${args.reason}`,
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

  const place = async (
    signal: RawSignal,
    adapter: SignalAdapter,
  ): Promise<PlacedSignal> => {
    // One transaction, so the id and the uniqueness check cannot race two
    // concurrent deliveries of the same alert.
    const inserted = await db.withWrite((w: Database.Database) => {
      const exists = w
        .prepare(
          "SELECT id, incidentId FROM signal WHERE source = ? AND sourceId = ?",
        )
        .get(signal.source, signal.sourceId) as
        | { id: string; incidentId: string | null }
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
      return { id, incidentId: null, fresh: true };
    });

    if (!inserted.fresh) {
      log("duplicate_signal", {
        signalId: inserted.id,
        source: signal.source,
        sourceId: signal.sourceId,
      });
      return {
        signalId: inserted.id,
        incidentId: inserted.incidentId,
        action: "duplicate",
        reason: "already ingested",
      };
    }
    const signalId = inserted.id;

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

    if (decision.action === "suppress") {
      // No incident and no agent. The signal stays in the table unattached,
      // which is what makes "how often does this fire and get suppressed" a
      // question the Slack agent can answer.
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

    const result = await applyAssign(
      db,
      {
        signalIds: [signalId],
        target: decision.action === "attach" ? decision.incidentId : "NEW",
        reason: decision.reason,
      },
      { kind: "boss" },
      outcome.recurrenceOf ? { recurrenceOf: outcome.recurrenceOf } : {},
    );

    if (result.created) {
      await relay
        .emit({
          type: "opened",
          incidentId: result.target,
          title: signal.title,
          signalCount: 1,
        })
        .catch((err: unknown) =>
          alarm("open_post_failed", { incidentId: result.target, error: String(err) }),
        );
    }

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
      fellBack: outcome.fellBack,
    });

    return {
      signalId,
      incidentId: result.target,
      action: decision.action,
      reason: decision.reason,
    };
  };

  const ingest = async (
    source: string,
    req: IncomingRequest,
  ): Promise<PlacedSignal[]> => {
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

    // Per signal, because a Grafana burst arrives as one delivery and one
    // unplaceable alert must not lose the other fourteen.
    const placed: PlacedSignal[] = [];
    for (const signal of signals) {
      try {
        placed.push(await place(signal, adapter));
      } catch (err) {
        alarm("place_failed", {
          source: signal.source,
          sourceId: signal.sourceId,
          error: String(err),
        });
        placed.push({
          signalId: null,
          incidentId: null,
          action: "failed",
          reason: String(err),
        });
      }
    }
    return placed;
  };

  const reportSignal = async (
    report: HumanBugReport,
  ): Promise<ReportSignalResult> => {
    const result = await place(
      humanSignal({
        text: report.text,
        reportedBy: report.reportedBy,
        via: "mcp",
      }),
      ingress.get("human"),
    );
    if (!result.signalId) throw new Error(`report_signal failed: ${result.reason}`);
    return { signalId: result.signalId, incidentId: result.incidentId };
  };

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  const credentials: AgentCredentialProvider =
    options.credentials ??
    (secrets.agentRoleArn
      ? createAssumeRoleCredentials({
          roleArn: secrets.agentRoleArn,
          // The role's maxSessionDuration is twelve hours; ask for all of it,
          // since credentials cannot be refreshed inside a running child.
          durationSeconds: 43_200,
        })
      : async (incidentId) => {
          alarm("no_agent_role", {
            incidentId,
            note: "no agentRoleArn configured; the child gets no AWS access",
          });
          return { accessKeyId: "", secretAccessKey: "", sessionToken: "" };
        });

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
    });
  };

  const dispatcher = createDispatcher({
    db,
    config: config.dispatcher,
    spawn,
    toolApiFor,
    mintToken,
    credentials,
    childBaseEnv: {
      ...pickBaseEnv(process.env),
      AWS_REGION: secrets.awsRegion ?? process.env.AWS_REGION,
      AWS_DEFAULT_REGION: secrets.awsRegion ?? process.env.AWS_DEFAULT_REGION,
      BUGBOSS_BOSS_URL: `http://127.0.0.1:${
        options.http?.loopbackPort ?? DEFAULT_LOOPBACK_PORT
      }`,
      BUGBOSS_S3_BUCKET: config.s3Bucket,
      ...(secrets.agentModelId ? { BUGBOSS_MODEL_ID: secrets.agentModelId } : {}),
      ...(secrets.grafanaUrl ? { GRAFANA_URL: secrets.grafanaUrl } : {}),
    },
    childCredentials: {
      GITHUB_TOKEN: secrets.githubToken,
      GH_TOKEN: secrets.githubToken,
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

  const tickResolution = async (): Promise<number> => {
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
      incidentId: string | null;
      explained: number;
    }>(
      `SELECT s.* FROM signal s JOIN incident i ON i.id = s.incidentId
       WHERE s.closedAt IS NULL AND i.status IN (${OPEN_STATUSES.map(() => "?").join(",")})`,
      OPEN_STATUSES,
    );

    const closed: string[] = [];
    for (const row of rows) {
      if (!ingress.has(row.source)) continue;
      const signal: Signal = {
        ...row,
        labels: JSON.parse(row.labels) as Record<string, string>,
        explained: row.explained === 1,
        closedAt: null,
      };
      try {
        if (await ingress.get(row.source).isResolved(signal)) closed.push(row.id);
      } catch (err) {
        alarm("resolution_check_failed", { signalId: row.id, error: String(err) });
      }
    }
    if (closed.length === 0) return 0;

    // Signals only. A quiet signal is evidence an agent reads, never a
    // transition the Boss makes: nothing auto-closes.
    await db.withWrite((w: Database.Database) => {
      const stamp = w.prepare("UPDATE signal SET closedAt = ? WHERE id = ?");
      for (const id of closed) stamp.run(now(), id);
    });
    log("signals_closed", { count: closed.length, signalIds: closed });
    return closed.length;
  };

  // -------------------------------------------------------------------------
  // Inbound Slack
  // -------------------------------------------------------------------------

  const slackEvent = async (event: SlackEvent): Promise<void> => {
    const route = await relay.handle(event);
    if (route.kind !== "slack_agent") return;
    await slackAgent.handle({
      channel: route.channel,
      threadTs: route.threadTs,
      ts: route.ts,
      user: route.user,
      text: route.text,
    });
  };

  // -------------------------------------------------------------------------
  // Servers and timers
  // -------------------------------------------------------------------------

  let mcp: BugBossMcp | undefined;
  if (options.mcpConfig) {
    mcp = createMcpServer({
      config: options.mcpConfig,
      db,
      sessions: createS3SessionStore({ bucket: config.s3Bucket, s3 }),
      reportSignal,
    });
  } else {
    log("mcp_not_configured");
  }

  const publicApp = createPublicApp({
    ingest,
    slackEvent,
    slackConfig: slackIngress,
    mcp,
  });
  const loopbackApp = createToolApiRoutes({
    db,
    tokenSecret,
    toolApiFor,
    slack: options.slack,
    now,
  });

  let servers: BugBossServers | null = null;
  let resolutionTimer: NodeJS.Timeout | null = null;

  const start = (): void => {
    if (servers) return;
    servers = startServers({ publicApp, loopbackApp, config: options.http });
    dispatcher.start();
    resolutionTimer = setInterval(() => {
      void tickResolution().catch((err: unknown) =>
        alarm("resolution_tick_failed", { error: String(err) }),
      );
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
    void mcp?.close().catch(() => undefined);
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
    slackEvent,
    reportSignal,
    dispatchOnce,
    tickResolution,
    start,
    stop,
  };
};

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

const readSecrets = (): BugBossSecrets => {
  const blob = process.env.BUGBOSS_SECRETS;
  const parsed = blob
    ? (JSON.parse(blob) as Record<string, string | undefined>)
    : {};
  const pick = (key: string) => parsed[key] ?? process.env[key];

  return {
    slackBotToken: pick("SLACK_BOT_TOKEN"),
    slackSigningSecret: pick("SLACK_SIGNING_SECRET"),
    slackBotUserId: pick("SLACK_BOT_USER_ID"),
    slackRotationGroupId: pick("SLACK_ROTATION_GROUP_ID"),
    slackChannelId: pick("BUGBOSS_SLACK_CHANNEL_ID"),
    grafanaWebhookSecret: pick("GRAFANA_WEBHOOK_SECRET"),
    grafanaBasicAuthPassword: pick("GRAFANA_BASIC_AUTH_PASSWORD"),
    grafanaUrl: pick("GRAFANA_URL") ?? "https://goodparty.grafana.net",
    grafanaServiceAccountToken: pick("GRAFANA_SERVICE_ACCOUNT_TOKEN"),
    githubToken: pick("GITHUB_TOKEN"),
    agentRoleArn: pick("BUGBOSS_AGENT_ROLE_ARN"),
    triageModelId: pick("BUGBOSS_TRIAGE_MODEL_ID"),
    agentModelId: pick("BUGBOSS_MODEL_ID"),
    awsRegion: pick("AWS_REGION") ?? pick("AWS_DEFAULT_REGION"),
  };
};

/**
 * The container entrypoint. Nothing here is reachable from a test, which is
 * deliberate: this is the only place a real Slack workspace, a real bucket
 * and a real model are named, and the only place that must never be handed a
 * verifier override.
 */
export const bugBossFromEnv = async (): Promise<BugBoss> => {
  const secrets = readSecrets();
  const bucket = process.env.BUGBOSS_BUCKET;
  if (!bucket) throw new Error("BUGBOSS_BUCKET is required");
  const channelId = secrets.slackChannelId;
  if (!channelId) throw new Error("BUGBOSS_SLACK_CHANNEL_ID is required");
  if (!secrets.slackBotToken) throw new Error("SLACK_BOT_TOKEN is required");

  const config: BugBossConfig = {
    env: "prod",
    s3Bucket: bucket,
    dbPath: process.env.BUGBOSS_DB_PATH ?? "/data/bugboss.db",
    slackChannelId: channelId,
    dispatcher: {
      maxConcurrentAgents: Number(process.env.BUGBOSS_MAX_AGENTS ?? 15),
      tickSeconds: Number(process.env.BUGBOSS_TICK_SECONDS ?? 30),
      agentTimeoutSeconds: Number(process.env.BUGBOSS_AGENT_TIMEOUT ?? 1800),
      maxAttempts: Number(process.env.BUGBOSS_MAX_ATTEMPTS ?? 3),
    },
    prodCriticalSlugs: (process.env.BUGBOSS_PROD_CRITICAL_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
  };

  // Only mounted when the whole OAuth leg is configured. A half-configured
  // MCP server answers discovery and then cannot complete a login.
  const mcpConfig =
    process.env.BUGBOSS_PUBLIC_URL &&
    process.env.BUGBOSS_MCP_JWT_SECRET &&
    process.env.BUGBOSS_GOOGLE_CLIENT_ID &&
    process.env.BUGBOSS_GOOGLE_CLIENT_SECRET
      ? mcpConfigFromEnv()
      : undefined;

  return createBugBoss({
    config,
    model: createBedrockModelClient({
      modelId: secrets.triageModelId ?? DEFAULT_TRIAGE_MODEL_ID,
      region: secrets.awsRegion,
    }),
    slack: createSlackClient(secrets.slackBotToken, channelId),
    s3: new S3Client({}),
    secrets,
    mcpConfig,
    http: {
      publicPort: Number(process.env.PORT ?? DEFAULT_PUBLIC_PORT),
      loopbackPort: Number(
        process.env.BUGBOSS_LOOPBACK_PORT ?? DEFAULT_LOOPBACK_PORT,
      ),
    },
  });
};

if (require.main === module) {
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
