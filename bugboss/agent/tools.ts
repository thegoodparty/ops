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
import { makeAlarm, makeLog } from "../logging";
import type { Directive, ToolApi } from "../types";

const log = makeLog("agent-tools");
const alarm = makeAlarm("agent-tools");

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

// ---------------------------------------------------------------------------
// Waiting on a person
// ---------------------------------------------------------------------------

/**
 * Why the harness holds a transition at all: a wait nobody ever ends is the
 * one outcome the agent can neither act on nor report. See `runMonitor`.
 */
export type HandOffPort = Pick<ToolApi, "handOff">;

/** What the harness did with a wait nobody ended. */
export type Escalation =
  | { handedOff: true; reason: string }
  | { handedOff: false; reason: string; error: string };

/**
 * When a nudge is allowed to land. One zone rather than each person's local
 * time, because the Boss knows a rotation group and not a roster: in Eastern
 * the default is 10:00-19:00 and in Pacific it is 07:00-16:00, so nobody on a
 * continental-US team is pinged before 07:00 or after 19:00 where they are.
 */
export interface WorkingHours {
  /** IANA zone name. */
  timeZone: string;
  /** Inclusive, in `timeZone`. */
  startHour: number;
  /** Exclusive, in `timeZone`. */
  endHour: number;
  /** Days that count, 0 = Sunday. */
  days: number[];
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timeZone: "America/New_York",
  startHour: 10,
  endHour: 19,
  days: [1, 2, 3, 4, 5],
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Fails open. Read the wrong way round, a runtime that cannot resolve the
 * zone would make the agent sit out a multi-day pull request in silence,
 * which is the thing this exists to stop; read this way it posts a nudge at a
 * defensible-but-possibly-wrong hour, which someone can see and correct.
 */
export const insideWorkingHours = (
  at: number,
  hours: WorkingHours = DEFAULT_WORKING_HOURS,
): boolean => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timeZone,
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
  } catch {
    return true;
  }
  const weekday =
    WEEKDAY_INDEX[parts.find((part) => part.type === "weekday")?.value ?? ""];
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (weekday === undefined || !Number.isFinite(hour)) return true;
  return (
    hours.days.includes(weekday) &&
    hour >= hours.startHour &&
    hour < hours.endHour
  );
};

/**
 * `America/New_York:10-19`, or `America/New_York:10-19:1,2,3,4,5` to name the
 * days. Malformed input throws rather than falling back on the default: this
 * is read once, at launch, where a throw is visible within seconds, and a
 * window nobody meant delivers its nudges at the wrong hour for as long as it
 * takes somebody to notice a value that looked configured.
 */
export const parseWorkingHours = (spec: string): WorkingHours => {
  const [timeZone, window, days] = spec.split(":");
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(window ?? "");
  if (!timeZone || !match) {
    throw new Error(
      `working hours must look like "America/New_York:10-19" or "America/New_York:10-19:1,2,3,4,5", got "${spec}"`,
    );
  }
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour >= endHour || endHour > 24) {
    throw new Error(
      `working hours must be start<end within 0-24, got "${window}"`,
    );
  }
  const parsed = (days ?? "1,2,3,4,5")
    .split(",")
    .map((day) => Number(day.trim()));
  if (parsed.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error(`working-hours days must be 0-6, got "${days}"`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`"${timeZone}" is not an IANA zone this runtime knows`);
  }
  return { timeZone, startHour, endHour, days: parsed };
};

/**
 * The first silence that means anything. Measured in wall clock and then
 * gated on the window, rather than by accumulating working minutes: a pull
 * request that sat overnight is already past any threshold by the time people
 * are back, and the useful moment to say so is when the window opens, not an
 * hour into the working day.
 */
export const HEARTBEAT_FIRST_SECONDS = 3600;

/**
 * Nudges before the thread stops being the right place to put this. The gap
 * doubles each time, so inside one working window they land an hour, three
 * hours and seven hours in: a fourth carries nothing the third did not, only
 * volume, and volume is what teaches people to skim the thread.
 */
export const HEARTBEAT_MAX_PINGS = 3;

/** How much of the check's own output a nudge carries. */
export const HEARTBEAT_STATUS_CHARS = 400;

/**
 * Quiet seconds owed before the next nudge, given how many have gone already.
 * Measured from the last nudge rather than from the start, which is what
 * keeps a wait that spanned a night from firing its whole ladder in three
 * consecutive minutes once the window opens: 1h, then 2h, then 4h, then the
 * hand-off 8h after that.
 */
export const heartbeatGapSeconds = (
  pings: number,
  first = HEARTBEAT_FIRST_SECONDS,
): number => first * 2 ** pings;

export interface PendingWait {
  /** The command this marker was written for. */
  command: string;
  startedAt: number;
  /** Nudges already posted for this wait. */
  pings: number;
  /** When the last one went out; null until one has. */
  lastPingAt: number | null;
}

/**
 * The durable half of a wait on a person, and the reason a resumed agent is
 * quiet. A restart replays the tool call with no result, so without this the
 * elapsed clock restarts and a wait that has already been nudged nudges
 * again -- and every merge to ops `main` restarts this container, so that is
 * the normal path rather than the exceptional one.
 */
export interface WaitMarkerPort {
  /**
   * Idempotent for the same command, and only for the same command.
   * `clearWait` does not run when the child is SIGKILLed mid-wait, so a
   * marker outlives the wait it was written for; matching on the command is
   * what stops that stale marker from silencing the next wait's first nudge.
   */
  recordWait(command: string): Promise<PendingWait>;
  recordPing(): Promise<PendingWait>;
  clearWait(): Promise<void>;
}

export interface HeartbeatDeps {
  marker: WaitMarkerPort;
  post(message: string): Promise<void>;
  escalate: HandOffPort;
  workingHours?: WorkingHours;
  firstSeconds?: number;
  maxPings?: number;
}

export const formatWaited = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

/**
 * The nudge. Short on purpose, and it repeats none of the original ask: what
 * is outstanding, how long it has been, what the check says *now*, and when
 * the next one comes. The status block is the only part that can have changed
 * since the last post, which is what makes this a report rather than a
 * second copy of the request.
 */
export const heartbeatMessage = (args: {
  description: string;
  awaitingHuman: string;
  waitedMs: number;
  status: string;
  /** Seconds until the next nudge, or null when the next step is the hand-off. */
  nextSeconds: number | null;
}): string =>
  [
    `*Still waiting on someone: ${args.description}*`,
    `${formatWaited(args.waitedMs)} so far, and it is the only thing outstanding. ${args.awaitingHuman}`,
    "",
    "*What the check says now*",
    "```",
    truncateOutput(args.status.trim(), HEARTBEAT_STATUS_CHARS) || "(no output)",
    "```",
    args.nextSeconds === null
      ? "If nobody picks this up, I hand the incident to a human next."
      : `Next nudge in ${formatWaited(args.nextSeconds * 1000)}.`,
  ].join("\n");

/**
 * The brief the harness writes when the nudges run out. Thinner than the one
 * `hand_off` asks for -- the harness knows the wait and nothing else -- which
 * is why the prompt tells the model to hand off itself if it can see this
 * coming.
 */
export const stalledWaitBrief = (args: {
  description: string;
  awaitingHuman: string;
  waitedMs: number;
  status: string;
}): string =>
  [
    `Nobody ended this wait in ${formatWaited(args.waitedMs)}, across ${HEARTBEAT_MAX_PINGS} nudges in the thread, so this is yours.`,
    "",
    "*What I am waiting for*",
    `${args.description} — ${args.awaitingHuman}`,
    "",
    "*Where it stands*",
    "```",
    truncateOutput(args.status.trim(), HEARTBEAT_STATUS_CHARS) || "(no output)",
    "```",
    "Everything I found is in this thread. The work is done; this one step is not.",
  ].join("\n");

/**
 * A failure here is never swallowed: the incident stays the agent's and the
 * tool result says so, so the next turn calls `hand_off` itself rather than
 * believing it was relieved.
 */
const escalateStalledWait = async (
  heartbeat: HeartbeatDeps,
  reason: string,
  brief: string,
): Promise<{ outcome: Escalation; directives: Directive[] }> => {
  try {
    const response = await heartbeat.escalate.handOff({ reason, brief });
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
  } catch (error: unknown) {
    return {
      outcome: { handedOff: false, reason, error: String(error) },
      directives: [],
    };
  }
};

export interface MonitorDeps {
  probe?: Probe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxOutputChars?: number;
  probeTimeoutSeconds?: number;
  signal?: AbortSignal;
  /** Absent means no wait can nudge, whatever the model asks for. */
  heartbeat?: HeartbeatDeps;
}

export interface MonitorArgs {
  command: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  description: string;
  /**
   * What a person has to do for this wait to end, in one line. Set only when
   * one does: it is what turns the heartbeat on.
   */
  awaitingHuman?: string;
}

export interface MonitorResult {
  output: string;
  timedOut: boolean;
  /** Set when the nudges ran out and the harness handed the incident over. */
  escalation: Escalation | null;
  /** Anything the hand-off drained. The caller renders these. */
  directives: Directive[];
}

/**
 * Block until a read-only check passes, and nudge the thread if the thing it
 * is waiting for is a person who has not turned up.
 *
 * The nudge is here rather than in the model's hands for the reason this tool
 * exists at all: it costs **one turn no matter how long it waits**, and a
 * model asked to nudge itself has to come back for a turn to do it, which is
 * the polling loop the tool replaced. It is also the half the model cannot be
 * trusted with -- an agent that has posted "please merge" and gone quiet
 * cannot notice its own silence. `runContactHuman` puts the same kind of
 * invariant in the same place for the same reason.
 */
export const runMonitor = async (
  args: MonitorArgs,
  deps: MonitorDeps = {},
): Promise<MonitorResult> => {
  const probe = deps.probe ?? shellProbe;
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;
  const probeTimeoutMs =
    (deps.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000;
  const intervalMs = Math.max(1, args.intervalSeconds) * 1000;

  // Only a wait on a person gets a heartbeat. `monitor` is the general
  // primitive, and most of what it waits for -- a deploy shipping, an alert
  // going quiet, npm ci finishing -- has nobody to nudge; a thread post about
  // one is noise, and noise is what teaches people to skim the thread the
  // real nudge arrives in. The argument decides it rather than the command
  // string, because a harness that pattern-matched `gh pr` would silently
  // stop nudging the day somebody wrote the same check a different way.
  const ask = args.awaitingHuman?.trim() ?? "";
  const heartbeat = ask ? deps.heartbeat : undefined;
  const firstSeconds = heartbeat?.firstSeconds ?? HEARTBEAT_FIRST_SECONDS;
  const maxPings = heartbeat?.maxPings ?? HEARTBEAT_MAX_PINGS;
  let marker = heartbeat ? await heartbeat.marker.recordWait(args.command) : null;

  // Measured from when the wait began, not from this process start, which is
  // the whole reason the marker is durable: a restart is not progress, and a
  // deadline of `now() + timeout` hands a crash-looping agent a fresh day
  // every time round. `now()` only wins if the marker is ahead of this clock,
  // which is skew rather than a wait that started in the future.
  const startedAt = marker ? Math.min(marker.startedAt, now()) : now();
  const deadline = startedAt + Math.max(0, args.timeoutSeconds) * 1000;

  let last = "";
  for (;;) {
    const result = await probe(args.command, probeTimeoutMs);
    last = result.output;
    if (result.code === 0) {
      if (heartbeat) await heartbeat.marker.clearWait();
      return {
        output: truncateOutput(last, maxChars),
        timedOut: false,
        escalation: null,
        directives: [],
      };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      if (heartbeat) await heartbeat.marker.clearWait();
      return {
        output: truncateOutput(last, maxChars),
        timedOut: true,
        escalation: null,
        directives: [],
      };
    }

    if (heartbeat && marker) {
      const waitedMs = now() - startedAt;
      const quietMs = now() - Math.min(marker.lastPingAt ?? startedAt, now());
      const gapMs = heartbeatGapSeconds(marker.pings, firstSeconds) * 1000;
      // The window gates the nudge, not the clock. A wait that spans a night
      // keeps accruing and stays silent, and the first poll after the window
      // opens is the one that speaks -- so "silence until morning, then a
      // ping" falls out of the rule rather than being a case in it.
      if (
        quietMs >= gapMs &&
        insideWorkingHours(now(), heartbeat.workingHours)
      ) {
        if (marker.pings >= maxPings) {
          // Handing off rather than nudging a fourth time, because the two
          // differ in who owns the incident and that is the part that has
          // gone wrong. An agent blocked with `owner: agent` is invisible:
          // the dispatcher will not relaunch an incident an agent still
          // holds, and nothing lists one as unclaimed work. `hand_off` is
          // also the only post here that reaches the rotation group.
          const reason = `nobody ended a ${formatWaited(waitedMs)} wait after ${maxPings} nudges`;
          const escalated = await escalateStalledWait(
            heartbeat,
            reason,
            stalledWaitBrief({
              description: args.description,
              awaitingHuman: ask,
              waitedMs,
              status: last,
            }),
          );
          // Cleared only when the hand-off landed. Left standing after a
          // failure the marker keeps its `startedAt`, so the next attempt
          // escalates at once instead of restarting the wait.
          if (escalated.outcome.handedOff) await heartbeat.marker.clearWait();
          log("wait_escalated", {
            command: args.command,
            waitedMs,
            handedOff: escalated.outcome.handedOff,
          });
          return {
            output: truncateOutput(last, maxChars),
            timedOut: true,
            escalation: escalated.outcome,
            directives: escalated.directives,
          };
        }
        // Counted before it is posted, which is the opposite order from the
        // question marker and deliberate. A crash in between costs one nudge
        // and the next threshold still comes; the other order re-nudges on
        // every resume, and every merge to ops `main` resumes every agent, so
        // a deploy would become a notification.
        marker = await heartbeat.marker.recordPing();
        const message = heartbeatMessage({
          description: args.description,
          awaitingHuman: ask,
          waitedMs,
          status: last,
          nextSeconds:
            marker.pings >= maxPings
              ? null
              : heartbeatGapSeconds(marker.pings, firstSeconds),
        });
        try {
          await heartbeat.post(message);
          log("wait_heartbeat", {
            command: args.command,
            pings: marker.pings,
            waitedMs,
          });
        } catch (error: unknown) {
          // A Slack hiccup costs this nudge, not the wait. The next threshold
          // is hours away and still arrives, whereas throwing here would end
          // a day-long wait over a transient 503.
          alarm("wait_heartbeat_post_failed", {
            command: args.command,
            pings: marker.pings,
            error: String(error),
          });
        }
      }
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
  post(message: string): Promise<void>;
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

export interface ContactHumanDeps {
  contact: HumanContactPort;
  api: DirectivePeek;
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

type HumanReply = Extract<Directive, { type: "human_message" }>;

export const firstReplyAfter = (
  pending: PendingDirective[],
  askedAt: number,
): { id: number; directive: HumanReply } | null => {
  const replies = pending
    .filter((entry): entry is { id: number; directive: HumanReply } =>
      entry.directive.type === "human_message",
    )
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
}

export const runContactHuman = async (
  args: { message: string; timeoutSeconds: number },
  deps: ContactHumanDeps,
): Promise<ContactHumanResult> => {
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = (deps.pollSeconds ?? CONTACT_HUMAN_POLL_SECONDS) * 1000;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;

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
    await deps.contact.post(args.message);
  }

  const deadline = now() + Math.max(0, args.timeoutSeconds) * 1000;
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
      };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      await deps.contact.clearPending();
      return { reply: null, timedOut: true, directives: rest, terminate: false };
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
  "",
  "SET `awaitingHuman` WHEN A PERSON IS THE THING YOU ARE WAITING FOR: merge",
  "this PR, flip this flag, restart that worker. Say what they have to do and",
  "include the link. It turns on the heartbeat -- the thread is nudged once the",
  "wait passes an hour inside working hours, the gap doubles, and if the nudges",
  "run out the incident is handed to a human and you stop. Hand off yourself",
  "first if you can see it coming: your brief is better than the harness's.",
  "",
  "Leave it unset for a deploy, a migration, npm ci or an alert going quiet.",
  "Nobody is being asked for anything, so nothing is posted.",
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
    awaitingHuman: Type.Optional(
      Type.String({
        description:
          "Only when a person has to act for this wait to end: what they must do, with the link. Unset for a deploy, a migration or an alert going quiet.",
      }),
    ),
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
      const header = result.escalation
        ? monitorEscalationText(result.escalation, args.description)
        : result.timedOut
          ? `TIMED OUT after ${args.timeoutSeconds}s waiting for: ${args.description}`
          : `Condition met: ${args.description}`;
      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${result.output}${renderDirectives(result.directives)}`,
          },
        ],
        details: { timedOut: result.timedOut, command: args.command },
        terminate:
          (result.escalation?.handedOff ?? false) ||
          result.directives.some(
            (directive) =>
              directive.type === "stop" || directive.type === "merged",
          ),
      };
    },
  } as ToolDefinition;
};

/** What the model is told about a wait that ended in the harness's hand-off. */
export const monitorEscalationText = (
  escalation: Escalation,
  description: string,
): string =>
  escalation.handedOff
    ? `HANDED OFF: ${escalation.reason} waiting for ${description}. Owner is now human and a brief has been posted for you. Stop work and exit.`
    : `error: ${escalation.reason} waiting for ${description}, and the automatic hand off failed (${escalation.error}). The incident is still yours and nobody has been told. Call hand_off yourself now.`;

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
        signal: eitherSignal(signal, deps.signal),
      });
      const text = result.timedOut
        ? `No reply within ${args.timeoutSeconds}s. Proceed on a stated assumption or hand off.`
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
