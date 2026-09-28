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
import { choiceProblem, MAX_CHOICE_OPTIONS } from "../slack/blocks";
import type { Directive, ToolApi } from "../types";

export const MONITOR_TOOL_NAME = "monitor";
export const CONTACT_HUMAN_TOOL_NAME = "contact_human";

export const DEFAULT_MAX_TOOL_CHARS = 20000;
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 60;
export const CONTACT_HUMAN_POLL_SECONDS = 30;

/**
 * The ask, capped. The first real run posted a 2,300-character write-up with
 * the question at the bottom, to a reader holding a phone. Truncating would be
 * silent and would cut the question off; refusing costs one turn and says
 * exactly what to move where. `details` is the unbounded half.
 */
export const CONTACT_HUMAN_MESSAGE_LIMIT = 700;

/**
 * The shortest silence that means anything. Below it nobody has had a chance
 * to look, so a shorter request is raised to this rather than answered early —
 * which also stops the escalation below from being opted out of by asking for
 * a two-minute wait.
 */
export const CONTACT_HUMAN_MIN_WAIT_SECONDS = 1800;

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

/**
 * How a directive reaches the model. The Boss tools and `contact_human` both
 * render them, so it sits with the tools rather than with either one.
 */
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

/**
 * Pi's per-call signal and the harness's deadline signal, both honoured.
 * Preferring one would make the soft deadline unreachable: `steer` only
 * delivers once the current turn's tool calls finish, and these tools are
 * where an agent spends most of a long incident.
 */
const eitherSignal = (
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined => {
  const live = signals.filter((signal): signal is AbortSignal => !!signal);
  if (live.length < 2) return live[0];
  return AbortSignal.any(live);
};

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
  /** Empty until the post that follows the marker succeeds. */
  messageTs: string;
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
  /**
   * Options render as buttons beside the question. Pressing one is recorded
   * and delivered as a `human_message` directive exactly as typing it would
   * be, so nothing below this port can tell a press from a reply.
   */
  post(message: string, options?: readonly string[]): Promise<void>;
  clearPending(): Promise<void>;
}

/** A directive still in the queue, carrying the id needed to remove just it. */
export interface PendingDirective {
  id: number;
  directive: Directive;
}

/**
 * The read the poll makes, and the reason it is not `getIncident`. Every
 * ToolApi response drains: it deletes the directives it carries. Polling one
 * every 30s while blocked therefore destroys the `stop`, `merged`,
 * `new_signals` and `resumed_after` an agent has not read yet, so this read
 * leaves them where they are and the drain stays on the calls whose result
 * the model actually sees.
 *
 * `consumeDirective` is the one exception: the reply that ends a wait is
 * removed by the wait, because it has already been delivered as that call's
 * answer.
 */
export interface DirectivePeek {
  peekDirectives(): Promise<PendingDirective[]>;
  consumeDirective(id: number): Promise<void>;
}

/**
 * Why the harness holds a transition at all: an unanswered question is the one
 * outcome the agent cannot act on and cannot report. See `runContactHuman`.
 */
export type HandOffPort = Pick<ToolApi, "handOff">;

export interface ContactHumanDeps {
  contact: HumanContactPort;
  api: DirectivePeek;
  escalate: HandOffPort;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollSeconds?: number;
  minWaitSeconds?: number;
  messageLimit?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export interface ContactHumanArgs {
  message: string;
  /** Posted as its own follow-up message, under the ask. */
  details?: string;
  timeoutSeconds: number;
  /**
   * Answers to render as buttons beside the ask. They change what the
   * question looks like and nothing else: the wait floor, the deadline and
   * the hand-off below all run exactly as they do without them, because a
   * button nobody presses *is* an unanswered question.
   */
  options?: readonly string[];
}

/** What the harness did with a question nobody answered. */
export type Escalation =
  | { handedOff: true; reason: string }
  | { handedOff: false; reason: string; error: string };

export const directiveTimestampMillis = (ts: string): number => {
  const numeric = Number(ts);
  if (Number.isFinite(numeric) && ts.trim() !== "") {
    return numeric > 1e11 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
};

type HumanReply = Extract<Directive, { type: "human_message" }>;

/**
 * The reply that ends a wait. A message somebody addressed to other people in
 * the thread is not one: it is still delivered, as an ordinary directive the
 * agent reads as context, but ending the wait on it sends an investigation
 * down whatever an offhand remark happened to say. Who a message was for is
 * read by `slack/intent.ts` and recorded on the directive.
 */
export const firstReplyAfter = (
  pending: PendingDirective[],
  askedAt: number,
): { id: number; directive: HumanReply } | null => {
  const replies = pending
    .filter((entry): entry is { id: number; directive: HumanReply } =>
      entry.directive.type === "human_message",
    )
    .filter((entry) => entry.directive.addressed !== "others")
    .filter((entry) => directiveTimestampMillis(entry.directive.ts) > askedAt)
    .sort(
      (a, b) =>
        directiveTimestampMillis(a.directive.ts) -
        directiveTimestampMillis(b.directive.ts),
    );
  return replies[0] ?? null;
};

export interface ContactHumanResult {
  reply: string | null;
  timedOut: boolean;
  /** Everything the poll saw that was not the reply. The caller renders these. */
  directives: Directive[];
  /** A `stop` or a `merged` arrived: the incident is no longer the agent's. */
  terminate: boolean;
  /** Set when the call was refused before anything was posted or recorded. */
  rejected: string | null;
  /** Set when the wait expired unanswered; null on a reply, a directive or the deadline. */
  escalation: Escalation | null;
}

/**
 * The brief the harness writes when the model did not. It is deliberately
 * thinner than the one `hand_off` asks for — the harness knows the question
 * and nothing else — which is the reason the prompt tells the model to hand
 * off itself before it gets here.
 */
export const unansweredBrief = (
  question: string,
  waitedMinutes: number,
  options: readonly string[] = [],
): string =>
  [
    `Nobody answered in ${waitedMinutes} minutes, so this is yours.`,
    "",
    "*What I asked*",
    question,
    // The buttons are part of the question a reader saw, and the person
    // picking this up did not see the thread before now.
    ...(options.length
      ? ["", "*What I offered*", ...options.map((option) => `• ${option}`)]
      : []),
    "",
    "*Where it stands*",
    "Everything I found is in this thread. I stopped at the question rather than guessing past it.",
  ].join("\n");

/**
 * The hand-off the harness makes on its own behalf. A failure here is never
 * swallowed: the incident stays the agent's and the tool result says so, so
 * the next turn can call `hand_off` itself rather than believing it was
 * relieved.
 */
const escalateUnanswered = async (
  deps: ContactHumanDeps,
  question: string,
  waitedMinutes: number,
  options: readonly string[] = [],
): Promise<{ outcome: Escalation; directives: Directive[] }> => {
  const reason = `no reply in ${waitedMinutes} minutes`;
  try {
    const response = await deps.escalate.handOff({
      reason,
      brief: unansweredBrief(question, waitedMinutes, options),
    });
    return {
      outcome: response.ok
        ? { handedOff: true, reason }
        : {
            handedOff: false,
            reason,
            error: response.error ?? "the hand off was refused without a reason",
          },
      directives: response.directives ?? [],
    };
  } catch (err) {
    return {
      outcome: { handedOff: false, reason, error: String(err) },
      directives: [],
    };
  }
};

/**
 * Ask a human, and hand the incident over if nobody answers.
 *
 * The second half is the part that is in code rather than in the prompt. The
 * two tools that reach a person differ only in who owns the incident
 * afterwards: `contact_human` leaves `owner: agent` and `hand_off` sets
 * `owner: human`. An agent blocked on a question nobody answers is therefore
 * invisible — the dispatcher will not relaunch an incident an agent still
 * holds, and no digest of unclaimed work lists one owned by an agent. The
 * prompt has always said to hand off when a question goes unanswered inside
 * the wait budget; the model is advisory about when that is, and is not
 * trusted with the invariant.
 */
export const runContactHuman = async (
  args: ContactHumanArgs,
  deps: ContactHumanDeps,
): Promise<ContactHumanResult> => {
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = (deps.pollSeconds ?? CONTACT_HUMAN_POLL_SECONDS) * 1000;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;
  const limit = deps.messageLimit ?? CONTACT_HUMAN_MESSAGE_LIMIT;
  const minWaitSeconds = deps.minWaitSeconds ?? CONTACT_HUMAN_MIN_WAIT_SECONDS;

  if (args.message.length > limit) {
    return {
      reply: null,
      timedOut: false,
      directives: [],
      terminate: false,
      rejected:
        `message is ${args.message.length} characters and the limit is ${limit}. ` +
        "Keep the conclusion, what it means for users and the one thing you need in " +
        '"message"; move the queries, counts and rule ids into "details", which is ' +
        "posted as its own follow-up message under the ask.",
      escalation: null,
    };
  }

  // Re-entrancy: a restart replays a tool call with no result, so this runs
  // again. The marker is recorded before the post, so the second run resumes
  // waiting on the original question instead of asking the human twice.
  //
  // A marker for a *different* question is the opposite case: clearPending
  // does not run when the child is SIGKILLed mid-wait, so the marker outlives
  // the question. Matching on the message is what stops that stale marker
  // from swallowing the post of every later question.
  //
  // An empty messageTs is the third case, and the one the marker used to make
  // permanent: recordPending and post are two calls, so a Slack failure
  // between them left a marker for a question nobody was ever asked. Every
  // later attempt then skipped the post by design and waited out its timeout,
  // which is textually identical to being ignored. Re-posting can at worst
  // ask twice; not posting cannot be recovered from at all.
  let pending = await deps.contact.getPending();
  if (!pending || pending.message !== args.message || !pending.messageTs) {
    pending = await deps.contact.recordPending(args.message);
    await deps.contact.post(args.message, args.options);
  }
  // A second message rather than a longer first one: the reader sees the
  // conclusion and the ask, and the evidence sits underneath for whoever wants
  // it.
  //
  // Posted outside the guard above, because `messageTs` only says the *ask*
  // landed. A crash between the two posts leaves a marker that looks complete,
  // and the resumed agent would skip both — dropping the evidence with no
  // error, no re-post and nobody aware. So a resume posts it again: the same
  // trade the ask itself already makes one comment up, for the same reason.
  // At worst the evidence appears twice; losing it cannot be recovered from.
  if (args.details?.trim()) await deps.contact.post(args.details);

  const waitSeconds = Math.max(minWaitSeconds, args.timeoutSeconds);
  // Measured from when the question was asked, not from this process start.
  // A restart is not an answer, and a deadline of `now() + wait` would give a
  // crash-looping agent a fresh wait each time and defer the escalation for
  // as long as the crashes last. `now()` only wins if the marker is somehow
  // ahead of this clock, which is skew rather than a question from the future.
  const deadline = Math.min(pending.askedAt, now()) + waitSeconds * 1000;
  for (;;) {
    const entries = await deps.api.peekDirectives();
    const reply = firstReplyAfter(entries, pending.askedAt);
    const terminate = entries.some(
      (entry) =>
        entry.directive.type === "stop" || entry.directive.type === "merged",
    );
    const rest = entries
      .filter((entry) => entry !== reply)
      .map((entry) => entry.directive);

    if (reply || terminate) {
      await deps.contact.clearPending();
      // The reply answered the question this call asked and is returned as
      // its result, so this call consumes it. Left pending, it would come
      // back a turn later as a bare MESSAGE directive with nothing marking
      // it as already answered, and "yes, go ahead and restart it" reads
      // just as well as a second authorisation as a first. Everything else
      // is addressed to the agent rather than to this question, so it stays
      // for get_incident. Clearing the marker first: a failure after it is
      // a duplicate post, a failure before it is a silent 24-hour wait.
      if (reply) await deps.api.consumeDirective(reply.id);
      return {
        reply: reply ? truncateOutput(reply.directive.text, maxChars) : null,
        timedOut: false,
        directives: rest,
        terminate,
        rejected: null,
        escalation: null,
      };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      // The harness deadline is already an escalation path of its own: the
      // run steers the model to write a real brief inside the grace window,
      // and handing off here would spend the turn that brief needs.
      if (deps.signal?.aborted) {
        await deps.contact.clearPending();
        return {
          reply: null,
          timedOut: true,
          directives: rest,
          terminate: false,
          rejected: null,
          escalation: null,
        };
      }
      const waitedMinutes = Math.round(
        Math.max(waitSeconds, (now() - pending.askedAt) / 1000) / 60,
      );
      const escalation = await escalateUnanswered(
        deps,
        args.message,
        waitedMinutes,
        args.options,
      );
      // Cleared after the hand-off, and only if it landed. Clearing first and
      // dying in between replays as a brand-new question: re-posted, with a
      // fresh askedAt that makes a reply already sitting in the thread look
      // too old to be one. Left standing after a failed hand-off, the marker
      // keeps the original askedAt, so the next attempt escalates at once
      // instead of restarting the wait.
      if (escalation.outcome.handedOff) await deps.contact.clearPending();
      return {
        reply: null,
        timedOut: true,
        directives: [...rest, ...escalation.directives],
        // Ownership moved, so there is nothing left for this agent to do —
        // and a stop or merged the hand-off drained says the same thing even
        // when the hand-off itself failed.
        terminate:
          escalation.outcome.handedOff ||
          escalation.directives.some(
            (directive) =>
              directive.type === "stop" || directive.type === "merged",
          ),
        rejected: null,
        escalation: escalation.outcome,
      };
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
  "Post to the incident's Slack thread and block until a human replies. Use it",
  "to ask for one fact or one action you cannot take yourself: merge a PR,",
  "restart a worker, check a third-party dashboard.",
  "",
  "THIS IS NOT AN ESCALATION. The incident stays yours and no human has been",
  "told it is theirs. If you have concluded you cannot take the incident",
  "further, that is hand_off, not a question. A question you do not intend to",
  "act on yourself is a hand-off wearing a question mark.",
  "",
  `The message is capped at ${CONTACT_HUMAN_MESSAGE_LIMIT} characters and a longer one is refused.`,
  "It carries the conclusion, what it means for users, and the one thing you",
  "need. Everything else goes in `details`, which is posted as its own",
  "follow-up message underneath the ask.",
  "",
  "When the answer is one of a few known choices, pass `options`: each becomes",
  `a button in the thread. Two to ${MAX_CHOICE_OPTIONS} short labels, and the`,
  "label is what comes back as the reply. Buttons are a shortcut, not a menu —",
  "anyone can ignore them and type something else, including an answer you did",
  "not list, so never ask a question that only works if a button is pressed.",
  "",
  "If nobody answers, this hands the incident to a human for you: owner becomes",
  "human, a brief you did not write is posted, and you stop. Hand off yourself",
  "first if you can see it coming — your brief is better than the one the",
  "harness writes. Buttons change nothing here: one nobody presses is silence,",
  "and silence escalates.",
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
      const result = await runMonitor(args, {
        ...deps,
        signal: eitherSignal(signal, deps.signal),
      });
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

/** What the model is told about a wait that ended in the harness's hand-off. */
export const escalationText = (escalation: Escalation): string =>
  escalation.handedOff
    ? `${escalation.reason}, so this incident has been handed to a human: owner is now human and a brief has been posted for you. Stop work and exit.`
    : `error: ${escalation.reason}, and the automatic hand off failed (${escalation.error}). The incident is still yours and nobody has been told. Call hand_off yourself now.`;

export const createContactHumanTool = async (
  deps: ContactHumanDeps,
): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  const minWait = deps.minWaitSeconds ?? CONTACT_HUMAN_MIN_WAIT_SECONDS;
  const limit = deps.messageLimit ?? CONTACT_HUMAN_MESSAGE_LIMIT;
  const parameters = Type.Object({
    message: Type.String({
      description: `The ask: conclusion, user impact, and the one thing you need. mrkdwn, at most ${limit} characters.`,
    }),
    details: Type.Optional(
      Type.String({
        description:
          "The evidence, posted as a separate follow-up message under the ask. Queries, counts, rule ids, control tests. Unbounded.",
      }),
    ),
    timeoutSeconds: Type.Number({
      description: `How long to wait for a reply. Raised to ${minWait} if you ask for less, then the incident is handed to a human.`,
    }),
    options: Type.Optional(
      Type.Array(Type.String(), {
        description: `Answers to offer as buttons. 2 to ${MAX_CHOICE_OPTIONS} labels, each at most 75 characters. Omit when the answer is open-ended.`,
      }),
    ),
  });

  return {
    name: CONTACT_HUMAN_TOOL_NAME,
    label: "Contact human",
    description: CONTACT_HUMAN_DESCRIPTION,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const args = params as unknown as ContactHumanArgs;
      // Checked before anything is posted, and returned as a tool result the
      // model can correct. The loopback route checks the same thing, because
      // that is the side of the socket that does not trust this one.
      if (args.options?.length) {
        const problem = choiceProblem(args.options);
        if (problem) {
          return {
            content: [
              {
                type: "text",
                text: `Nothing was posted: ${problem}. Ask again with usable options, or without any.`,
              },
            ],
            details: { refused: true },
          };
        }
      }
      const result = await runContactHuman(args, {
        ...deps,
        signal: eitherSignal(signal, deps.signal),
      });
      const text = result.rejected
        ? `error: ${result.rejected}`
        : result.escalation
          ? escalationText(result.escalation)
          : result.timedOut
            ? "Your deadline ended this wait. Hand off now, with a brief."
            : result.reply === null
              ? "The wait ended on a directive rather than a reply."
              : `Reply: ${result.reply}`;
      return {
        content: [
          { type: "text", text: `${text}${renderDirectives(result.directives)}` },
        ],
        details: { timedOut: result.timedOut },
        terminate: result.terminate,
      };
    },
  } as ToolDefinition;
};
