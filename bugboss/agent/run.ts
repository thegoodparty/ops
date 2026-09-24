// The incident agent runner: one process per incident, launched by the
// dispatcher and resumable after it dies.
//
// Pi is ESM-only and declares no "require" condition, so every runtime value
// from it is reached through a dynamic import. Types are imported normally and
// cost nothing at runtime.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Directive, IncidentView, ToolApi, ToolResponse } from "../types";
import { resolveBedrockModel, registerBedrockInvokeModelProvider } from "../bedrock";
import { connectMcpToolset, type McpToolset } from "./mcp";
import { composeSystemPrompt, loadPromptContext } from "./prompt";
import {
  createContactHumanTool,
  createMonitorTool,
  truncateOutput,
  type HumanContactPort,
  type PendingQuestion,
} from "./tools";
import {
  createSessionSync,
  createS3SessionStore,
  readStoredPrefixFromFile,
  restoreSessionFile,
  sessionFileFor,
  sessionKeyFor,
  sessionSyncExtension,
  PROMPT_ENTRY_TYPE,
  type SessionStore,
  type StoredPrefix,
} from "./session";

export const DEFAULT_WORK_ROOT = "/work";
export const DEFAULT_OMNI_REPO = "https://github.com/thegoodparty/omni.git";
export const DEFAULT_MODEL_ID = "us.anthropic.claude-opus-5";
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const DEADLINE_GRACE_SECONDS = 180;
export const COMPACTION_HEADROOM = 0.05;

export const BUILTIN_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export interface AgentPaths {
  workDir: string;
  checkout: string;
  sessionDir: string;
  sessionFile: string;
  npmCiLog: string;
  npmCiDone: string;
  npmCiFailed: string;
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
  };
};

/** Compaction fires at 95% of the window; bounded tool results make that safe. */
export const reserveTokensFor = (contextWindow: number): number =>
  Math.max(1, Math.round(contextWindow * COMPACTION_HEADROOM));

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
 * A partial clone, not a shallow one: investigation is half git history, and
 * `--depth 1` is blind to it. Blobs are fetched on demand.
 */
export const cloneOmni = async (repoUrl: string, dest: string): Promise<void> => {
  if (existsSync(join(dest, ".git"))) return;
  await mkdir(dirname(dest), { recursive: true });
  await exec("git", ["clone", "--filter=blob:none", repoUrl, dest]);
};

export const npmCiCommand = (paths: AgentPaths): string =>
  `npm ci > ${paths.npmCiLog} 2>&1 && touch ${paths.npmCiDone} || cp ${paths.npmCiLog} ${paths.npmCiFailed}`;

export const startNpmCi = (paths: AgentPaths): void => {
  if (existsSync(paths.npmCiDone) || existsSync(paths.npmCiFailed)) return;
  const child = spawn("/bin/sh", ["-c", npmCiCommand(paths)], {
    cwd: paths.checkout,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

// ---------------------------------------------------------------------------
// The Boss
// ---------------------------------------------------------------------------

export type BossClient = ToolApi & HumanContactPort;

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
    reportImpact: (payload) => call<ToolResponse>("POST", "/impact", payload),
    reportResolved: (payload) => call<ToolResponse>("POST", "/resolved", payload),
    reportAnalysis: (payload) => call<ToolResponse>("POST", "/analysis", payload),
    handOff: (payload) => call<ToolResponse>("POST", "/handoff", payload),
    getIncident: () => call<ToolResponse<IncidentView>>("GET", ""),
    getPending: () => call<PendingQuestion | null>("GET", "/pending-question"),
    recordPending: (message) =>
      call<PendingQuestion>("POST", "/pending-question", { message }),
    clearPending: () => call<void>("DELETE", "/pending-question").then(() => undefined),
    post: (message) => call<void>("POST", "/thread", { message }).then(() => undefined),
  };
};

export const renderDirectives = (directives: Directive[]): string => {
  if (!directives.length) return "";
  const lines = directives.map((directive) => {
    switch (directive.type) {
      case "stop":
        return `STOP: ${directive.reason}`;
      case "merged":
        return `MERGED: this incident is now part of ${directive.into}. Stop work and exit.`;
      case "handoff":
        return `HANDOFF: ${directive.reason}`;
      case "new_signals":
        return `NEW SIGNALS (${directive.count}): ${directive.summary}`;
      case "human_message":
        return `MESSAGE from ${directive.from} at ${directive.ts}: ${directive.text}`;
      case "resumed_after":
        return `RESUMED after ${directive.seconds}s. Re-check anything time-sensitive before continuing.`;
    }
  });
  return `\n\nDIRECTIVES\n${lines.join("\n")}`;
};

const bossToolResult = (response: ToolResponse<unknown>, maxChars: number) => ({
  content: [
    {
      type: "text" as const,
      text: truncateOutput(
        `${response.ok ? "ok" : `error: ${response.error ?? "unknown"}`}${
          response.data === undefined ? "" : `\n\n${JSON.stringify(response.data, null, 2)}`
        }${renderDirectives(response.directives ?? [])}`,
        maxChars,
      ),
    },
  ],
  details: undefined,
  terminate: (response.directives ?? []).some(
    (directive) => directive.type === "stop" || directive.type === "merged",
  ),
});

export const createBossTools = async (args: {
  api: ToolApi;
  onRootCause?: () => void;
  maxOutputChars?: number;
}): Promise<ToolDefinition[]> => {
  const { Type } = await import("typebox");
  const maxChars = args.maxOutputChars ?? 20000;

  const tools: ToolDefinition[] = [
    {
      name: "get_incident",
      label: "Get incident",
      description:
        "Re-read the incident, its signals and its prefetched evidence, and collect any pending directives. Call it first on every start and after any long wait.",
      parameters: Type.Object({}),
      execute: async () => bossToolResult(await args.api.getIncident(), maxChars),
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
      }),
      execute: async (_id: string, params: unknown) => {
        const response = await args.api.reportRootCause(
          params as unknown as Parameters<ToolApi["reportRootCause"]>[0],
        );
        if (response.ok) args.onRootCause?.();
        return bossToolResult(response, maxChars);
      },
    },
    {
      name: "report_impact",
      label: "Report impact",
      description:
        "Update how many users are affected. Callable repeatedly; impact grows during an incident and humans need the current number.",
      parameters: Type.Object({
        usersImpacted: Type.Number(),
        query: Type.String({ description: "The query that produced the number." }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.reportImpact(params as unknown as Parameters<ToolApi["reportImpact"]>[0]),
          maxChars,
        ),
    },
    {
      name: "report_resolved",
      label: "Report resolved",
      description:
        "FIXING -> RESOLVED. Only after you have observed the problem stop: evidence is what you watched go quiet, not what you believe the fix does.",
      parameters: Type.Object({
        prUrls: Type.Array(Type.String()),
        evidence: Type.String({ description: "What you observed stop happening, and how." }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.reportResolved(
            params as unknown as Parameters<ToolApi["reportResolved"]>[0],
          ),
          maxChars,
        ),
    },
    {
      name: "report_analysis",
      label: "Report analysis",
      description:
        "RESOLVED -> CLOSED, and your last act. Markdown post-mortem: summary, timeline, humans involved, impact, root cause analysis with five whys, and owned prevention items.",
      parameters: Type.Object({
        postmortem: Type.String(),
        usersImpacted: Type.Number(),
        impactQuery: Type.String(),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.reportAnalysis(
            params as unknown as Parameters<ToolApi["reportAnalysis"]>[0],
          ),
          maxChars,
        ),
    },
    {
      name: "hand_off",
      label: "Hand off",
      description:
        "Terminal. Gives the incident to a human and posts your brief. Before calling it without a root cause, you must propose either a change to the alert rule as a PR or a named piece of missing instrumentation.",
      parameters: Type.Object({
        reason: Type.String(),
        brief: Type.String({
          description:
            "What I believe now / What I ruled out / What I was about to do / Side effects.",
        }),
      }),
      execute: async (_id: string, params: unknown) =>
        bossToolResult(
          await args.api.handOff(params as unknown as Parameters<ToolApi["handOff"]>[0]),
          maxChars,
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
  timeoutSeconds?: number;
  awsRegion?: string;
  /** Overrides the derived S3 key. The dispatcher passes it as sessionRef. */
  sessionKey?: string;
  grafana?: { url: string; token: string; command?: string; args?: string[] };
  store?: SessionStore;
  api?: BossClient;
  skipClone?: boolean;
}

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

  const deadlineAt = Number(env.BUGBOSS_DEADLINE_AT);
  const timeoutSeconds = Number.isFinite(deadlineAt)
    ? Math.max(60, Math.round((deadlineAt - now) / 1000))
    : DEFAULT_TIMEOUT_SECONDS;

  const grafanaToken = env.GRAFANA_SERVICE_ACCOUNT_TOKEN;

  return {
    incidentId,
    s3Bucket,
    bossBaseUrl: env.BUGBOSS_BOSS_URL ?? "http://127.0.0.1:8080",
    bossAuthToken: env.BUGBOSS_TOKEN,
    workRoot: env.BUGBOSS_WORK_ROOT ?? DEFAULT_WORK_ROOT,
    omniRepoUrl: env.BUGBOSS_OMNI_REPO ?? DEFAULT_OMNI_REPO,
    modelId: env.BUGBOSS_MODEL_ID ?? DEFAULT_MODEL_ID,
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
    sessionKey: env.BUGBOSS_SESSION_REF ?? undefined,
    timeoutSeconds,
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
}

export const resumeMessage = (): string =>
  "You were restarted. Time passed while you were down, and pull requests merge, deploys ship, alerts stop and people fix things by hand in that time. Call get_incident first: its resumed_after directive says how long. Re-run only the checks that matter for what you were in the middle of, then continue.";

export const kickoffMessage = (incidentId: string): string =>
  `Incident ${incidentId} is yours. Call get_incident to read the signals and the evidence that was prefetched for you, then work it to a conclusion.`;

export const deadlineMessage = (graceSeconds: number): string =>
  `Your wall-clock deadline has expired. Stop investigating. Within the next ${graceSeconds} seconds, call hand_off with a brief: what you believe now, what you ruled out, what you were about to do, and any side effects. If you have no root cause, your brief must still propose a change to the alert rule or name the instrumentation that is missing.`;

export const runIncidentAgent = async (
  options: RunIncidentAgentOptions,
): Promise<RunIncidentAgentResult> => {
  const paths = computePaths(options.workRoot ?? DEFAULT_WORK_ROOT, options.incidentId);
  const store = options.store ?? createS3SessionStore(options.s3Bucket, options.awsRegion);
  const key = options.sessionKey ?? sessionKeyFor(options.incidentId);
  const api =
    options.api ??
    createBossClient({
      baseUrl: options.bossBaseUrl,
      incidentId: options.incidentId,
      authToken: options.bossAuthToken,
    });

  await mkdir(paths.sessionDir, { recursive: true });
  if (!options.skipClone) {
    await cloneOmni(options.omniRepoUrl ?? DEFAULT_OMNI_REPO, paths.checkout);
  }
  const restored = await restoreSessionFile({ store, key, sessionFile: paths.sessionFile });

  const pi = await import("@earendil-works/pi-coding-agent");
  await registerBedrockInvokeModelProvider();
  const model = await resolveBedrockModel({ id: options.modelId ?? DEFAULT_MODEL_ID });

  const mcp: McpToolset[] = [];
  if (options.grafana) {
    mcp.push(
      await connectMcpToolset({
        name: "grafana",
        command: options.grafana.command ?? "uvx",
        args: options.grafana.args ?? ["mcp-grafana"],
        env: {
          GRAFANA_URL: options.grafana.url,
          GRAFANA_SERVICE_ACCOUNT_TOKEN: options.grafana.token,
        },
      }),
    );
  }

  try {
    return await launch({ options, paths, store, key, api, pi, model, mcp, restored });
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
  mcp: McpToolset[];
  restored: boolean;
}): Promise<RunIncidentAgentResult> => {
  const { options, paths, store, key, api, pi, model, mcp, restored } = args;

  const bossTools = await createBossTools({ api, onRootCause: () => startNpmCi(paths) });
  const localTools = [
    await createMonitorTool({}),
    await createContactHumanTool({ contact: api, api }),
  ];
  const customTools = [...bossTools, ...localTools, ...mcp.flatMap((set) => set.tools)].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const toolNames = [...BUILTIN_TOOLS, ...customTools.map((tool) => tool.name)].sort();

  const storedPrefix = restored ? await readStoredPrefixFromFile(paths.sessionFile) : null;
  const prefix: StoredPrefix =
    storedPrefix ??
    (await (async () => {
      const context = await loadPromptContext(paths.checkout);
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

  const settings = pi.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: reserveTokensFor(model.contextWindow) },
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
      sessionSyncExtension(sync),
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
    thinkingLevel: "high",
    tools: prefix.toolNames,
    customTools,
    resourceLoader,
    settingsManager: settings,
    sessionManager,
  });

  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  let timedOut = false;
  // Two layers, because an in-process deadline cannot fire inside a wedged
  // agent: ask it to hand off, then stop it. The dispatcher kills the process
  // as the real backstop.
  const deadline = setTimeout(() => {
    timedOut = true;
    session.steer(deadlineMessage(DEADLINE_GRACE_SECONDS)).catch(() => {});
  }, timeoutSeconds * 1000);
  const hardStop = setTimeout(
    () => void session.abort().catch(() => {}),
    (timeoutSeconds + DEADLINE_GRACE_SECONDS) * 1000,
  );

  try {
    await session.prompt(
      restored ? resumeMessage() : kickoffMessage(options.incidentId),
    );
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardStop);
    await sync.flush();
    session.dispose();
  }

  return { sessionFile: sessionManager.getSessionFile(), restored, timedOut };
};

if (require.main === module) {
  runIncidentAgent(agentOptionsFromEnv(process.env)).then(
    (result) => {
      console.log(
        JSON.stringify({ component: "agent", event: "exit", ...result }),
      );
      process.exit(0);
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
