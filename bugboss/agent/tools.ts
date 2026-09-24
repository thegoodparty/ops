// The two blocking tools that live in the agent's harness rather than the Boss
// API. Each costs one turn no matter how long it waits, which is what keeps a
// multi-day incident from saturating context on polling.
//
// The loop is ours, the probe is theirs: every command invocation is a short
// exec with a normal timeout and the waiting happens here. That is what
// sidesteps Pi's per-call bash timeout, and it is why `monitor` cannot just be
// `bash`.

import { execFile } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Directive, ToolApi } from "../types";

export const MONITOR_TOOL_NAME = "monitor";
export const CONTACT_HUMAN_TOOL_NAME = "contact_human";

export const DEFAULT_MAX_TOOL_CHARS = 20000;
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 60;
export const CONTACT_HUMAN_POLL_SECONDS = 30;

export const truncateOutput = (
  text: string,
  maxChars = DEFAULT_MAX_TOOL_CHARS,
): string => {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n[... ${dropped} characters elided ...]\n\n${tail}`;
};

export interface ProbeResult {
  code: number;
  output: string;
}

export type Probe = (command: string, timeoutMs: number) => Promise<ProbeResult>;

export const shellProbe: Probe = (command, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`;
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, output });
      },
    );
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface MonitorDeps {
  probe?: Probe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxOutputChars?: number;
  probeTimeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface MonitorArgs {
  command: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  description: string;
}

export const runMonitor = async (
  args: MonitorArgs,
  deps: MonitorDeps = {},
): Promise<{ output: string; timedOut: boolean }> => {
  const probe = deps.probe ?? shellProbe;
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;
  const probeTimeoutMs =
    (deps.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000;
  const intervalMs = Math.max(1, args.intervalSeconds) * 1000;
  const deadline = now() + Math.max(0, args.timeoutSeconds) * 1000;

  let last = "";
  for (;;) {
    const result = await probe(args.command, probeTimeoutMs);
    last = result.output;
    if (result.code === 0) {
      return { output: truncateOutput(last, maxChars), timedOut: false };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      return { output: truncateOutput(last, maxChars), timedOut: true };
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
};

export interface PendingQuestion {
  message: string;
  askedAt: number;
}

/**
 * The ask side of `contact_human`. `ToolApi` carries the reply side (a
 * `human_message` directive on `get_incident`) but has no way to record that a
 * question is outstanding, so that lives here: the Boss records the marker,
 * the agent posts to Slack with its own token.
 */
export interface HumanContactPort {
  getPending(): Promise<PendingQuestion | null>;
  recordPending(message: string): Promise<PendingQuestion>;
  post(message: string): Promise<void>;
  clearPending(): Promise<void>;
}

export interface ContactHumanDeps {
  contact: HumanContactPort;
  api: Pick<ToolApi, "getIncident">;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollSeconds?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export const directiveTimestampMillis = (ts: string): number => {
  const numeric = Number(ts);
  if (Number.isFinite(numeric) && ts.trim() !== "") {
    return numeric > 1e11 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const firstReplyAfter = (
  directives: Directive[],
  askedAt: number,
): { from: string; text: string; ts: string } | null => {
  const replies = directives
    .filter(
      (directive): directive is Extract<Directive, { type: "human_message" }> =>
        directive.type === "human_message",
    )
    .filter((directive) => directiveTimestampMillis(directive.ts) > askedAt)
    .sort(
      (a, b) => directiveTimestampMillis(a.ts) - directiveTimestampMillis(b.ts),
    );
  return replies[0] ?? null;
};

export const runContactHuman = async (
  args: { message: string; timeoutSeconds: number },
  deps: ContactHumanDeps,
): Promise<{ reply: string | null; timedOut: boolean }> => {
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = (deps.pollSeconds ?? CONTACT_HUMAN_POLL_SECONDS) * 1000;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;

  // Re-entrancy: a restart replays a tool call with no result, so this runs
  // again. The marker is recorded before the post, so the second run resumes
  // waiting on the original question instead of asking the human twice.
  let pending = await deps.contact.getPending();
  if (!pending) {
    pending = await deps.contact.recordPending(args.message);
    await deps.contact.post(args.message);
  }

  const deadline = now() + Math.max(0, args.timeoutSeconds) * 1000;
  for (;;) {
    const response = await deps.api.getIncident();
    const reply = firstReplyAfter(response.directives ?? [], pending.askedAt);
    if (reply) {
      await deps.contact.clearPending();
      return { reply: truncateOutput(reply.text, maxChars), timedOut: false };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      await deps.contact.clearPending();
      return { reply: null, timedOut: true };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
};

const MONITOR_DESCRIPTION = [
  "Block until a shell command exits 0, then return its output. Use this for",
  "every wait: a PR merging, a deploy finishing, a migration running, an alert",
  "going quiet. It costs one turn no matter how long it waits, so never poll by",
  "calling bash in a loop.",
  "",
  "THE COMMAND MUST BE A READ-ONLY CHECK. On a container restart the session",
  "holds this tool call with no result and the command runs again, so anything",
  "with a side effect happens twice. `monitor` with `gh pr merge` is a bug.",
  "",
  "Each invocation of the command is a short exec with its own timeout; the",
  "waiting happens inside the tool. Output is capped, so have the command print",
  "a summary rather than a whole log.",
].join("\n");

const CONTACT_HUMAN_DESCRIPTION = [
  "Post a message to the incident's Slack thread and block until a human",
  "replies. Use it to ask a question or to ask someone to do something you",
  "cannot do yourself: merge a PR, restart a worker, check a third-party",
  "dashboard.",
  "",
  "Say exactly what you need and what you will do with the answer. If you only",
  "want to tell people something, post it without this tool; this one waits.",
  "",
  "Safe to call again after a restart: the outstanding question is recorded",
  "before it is posted, so a repeated call resumes waiting rather than asking",
  "twice.",
].join("\n");

export const createMonitorTool = async (
  deps: MonitorDeps = {},
): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  const parameters = Type.Object({
    command: Type.String({
      description: "Read-only shell command. Exit 0 means the wait is over.",
    }),
    intervalSeconds: Type.Number({
      description: "Seconds between attempts. 30 for a deploy, 300 for a quiet signal.",
    }),
    timeoutSeconds: Type.Number({
      description: "Give up after this long and return the last output.",
    }),
    description: Type.String({
      description: "What you are waiting for, in one line.",
    }),
  });

  return {
    name: MONITOR_TOOL_NAME,
    label: "Monitor",
    description: MONITOR_DESCRIPTION,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const args = params as unknown as MonitorArgs;
      const result = await runMonitor(args, { ...deps, signal: signal ?? deps.signal });
      const header = result.timedOut
        ? `TIMED OUT after ${args.timeoutSeconds}s waiting for: ${args.description}`
        : `Condition met: ${args.description}`;
      return {
        content: [{ type: "text", text: `${header}\n\n${result.output}` }],
        details: { timedOut: result.timedOut, command: args.command },
      };
    },
  } as ToolDefinition;
};

export const createContactHumanTool = async (
  deps: ContactHumanDeps,
): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  const parameters = Type.Object({
    message: Type.String({
      description: "What to post in the incident thread. Plain text, no Block Kit.",
    }),
    timeoutSeconds: Type.Number({
      description: "How long to wait for a reply before continuing without one.",
    }),
  });

  return {
    name: CONTACT_HUMAN_TOOL_NAME,
    label: "Contact human",
    description: CONTACT_HUMAN_DESCRIPTION,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const args = params as unknown as { message: string; timeoutSeconds: number };
      const result = await runContactHuman(args, {
        ...deps,
        signal: signal ?? deps.signal,
      });
      const text = result.timedOut
        ? `No reply within ${args.timeoutSeconds}s. Proceed on a stated assumption or hand off.`
        : `Reply: ${result.reply ?? ""}`;
      return {
        content: [{ type: "text", text }],
        details: { timedOut: result.timedOut },
      };
    },
  } as ToolDefinition;
};
