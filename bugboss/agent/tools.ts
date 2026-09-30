// The two blocking tools that live in the agent's harness rather than the Boss
// API. Each costs one turn no matter how long it waits, which is what keeps a
// multi-day incident from saturating context on polling.
//
// The loop is ours, the probe is theirs: every command invocation is a short
// exec with a normal timeout and the waiting happens here. That is what
// sidesteps Pi's per-call bash timeout, and it is why `monitor` cannot just be
// `bash`.
//
// Neither of them reaches Slack. An agent talks to the Boss and nobody else:
// what it has to say lands in the Boss's inbox, and the Boss decides whether a
// person needs to hear it and how.

import { execFile } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeAlarm, makeLog } from "../logging";
import type { BossInboxKind, Directive } from "../types";

const log = makeLog("agent-tools");
const alarm = makeAlarm("agent-tools");

export const MONITOR_TOOL_NAME = "monitor";
export const MESSAGE_BOSS_TOOL_NAME = "message_boss";

export const DEFAULT_PROBE_TIMEOUT_SECONDS = 60;
export const MESSAGE_BOSS_POLL_SECONDS = 30;

/**
 * The shortest silence that means anything. Below it nobody has had a chance
 * to look, so a shorter request is raised to this rather than answered early —
 * which also stops the escalation below from being opted out of by asking for
 * a two-minute wait.
 */
export const MESSAGE_BOSS_MIN_WAIT_SECONDS = 1800;

/**
 * A probe's last output, whole. The top of a failing check is the command
 * echo and the answer is at the bottom, so any cut loses the part that
 * matters.
 */
export const probeOutput = (output: string): string => {
  const text = output.trim();
  return text ? text : "(no output)";
};

/**
 * The words of a directive that is the Boss speaking, or null.
 *
 * `human_message` is the shape that came before `boss_message`, and a row
 * written before that deploy can still be sitting in `pending_directive`. It
 * reads as the Boss, text and all, rather than falling through the switch
 * below or being dropped: somebody meant it for this agent either way.
 */
export const bossMessageText = (directive: Directive): string | null => {
  if (directive.type === "boss_message") return directive.text;
  const legacy = directive as { type: string; text?: unknown };
  return legacy.type === "human_message" && typeof legacy.text === "string"
    ? legacy.text
    : null;
};

const bossLine = (text: string): string => `FROM THE BOSS: ${text}`;

/**
 * How a directive reaches the model. The Boss tools and `message_boss` both
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
      case "new_signals": {
        const head = `NEW SIGNALS (${directive.count})`;
        const absorbed = directive.absorbed ?? [];
        if (absorbed.length === 0) return `${head}: ${directive.summary}`;
        // Agreement matters here beyond tidiness: this is the sentence that
        // tells an agent how many other investigations it has inherited, and
        // "incident 82 and 83 has been merged" reads as one of them.
        const one = absorbed.length === 1;
        const which = one
          ? `incident ${absorbed[0]}`
          : `incidents ${absorbed.slice(0, -1).join(", ")} and ${absorbed.at(-1)}`;
        return (
          `${head}: ${which} ${one ? "has" : "have"} been merged into yours ` +
          `and ${one ? "its" : "their"} signals are now yours. Why: ` +
          `${directive.summary}. Call get_incident: what ${one ? "that incident" : "those incidents"} ` +
          `had already found comes back as \`absorbed\`, and your summary now ` +
          "has to describe every part of it."
        );
      }
      case "boss_message":
        return bossLine(directive.text);
      case "resumed_after":
        return `RESUMED after ${directive.seconds}s. Re-check anything time-sensitive before continuing.`;
      default: {
        const text = bossMessageText(directive as Directive);
        return text === null
          ? `UNRECOGNISED DIRECTIVE: ${JSON.stringify(directive)}`
          : bossLine(text);
      }
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
// Telling the Boss
// ---------------------------------------------------------------------------

/**
 * Everything an agent has to say to a person goes through here, and nothing
 * here posts anywhere. The row lands in the Boss's inbox and the Boss is
 * woken; whether anybody is told, who, and in what words is its decision.
 */
export interface BossInboxPort {
  /**
   * `ownBrief` marks the agent's own escalation, as opposed to one the
   * harness sends while it waits, so the dispatcher's deadline does not post
   * a placeholder brief over it.
   */
  tellBoss(kind: BossInboxKind, text: string, options?: { ownBrief?: boolean }): Promise<void>;
  /**
   * The escalations already sent up for this incident since `since`. Read
   * back from the inbox itself, so the ladder on an unanswered question
   * survives the restart every merge to ops `main` causes without a marker
   * of its own.
   */
  escalationsSince(since: number): Promise<{ count: number; lastAt: number | null }>;
}

/**
 * When a reminder is allowed to go up. One zone rather than each person's
 * local time, because the Boss knows a rotation group and not a roster: in
 * Eastern the default is 10:00-19:00 and in Pacific it is 07:00-16:00, so
 * nobody on a continental-US team is reached before 07:00 or after 19:00
 * where they are.
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
 * which is the thing this exists to stop; read this way it sends a reminder at a
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
 * window nobody meant sends its reminders at the wrong hour for as long as it
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
 * The gap stops doubling here. A wait can legitimately run for days -- a
 * merge over a weekend, a vendor -- and left doubling, the eighth reminder
 * would be a fortnight after the seventh, which is indistinguishable from
 * having given up. A day is the floor the whole system is held to: nothing
 * open goes quiet for longer than this.
 */
export const HEARTBEAT_MAX_GAP_SECONDS = 86_400;

/**
 * Quiet seconds owed before the next reminder, given how many have gone
 * already. Measured from the last one rather than from the start, which is
 * what keeps a wait that spanned a night from firing its whole ladder in
 * three consecutive minutes once the window opens: 1h, 2h, 4h, 8h, 16h, then
 * once a day for as long as the wait lasts.
 */
export const heartbeatGapSeconds = (
  pings: number,
  first = HEARTBEAT_FIRST_SECONDS,
  maxGap = HEARTBEAT_MAX_GAP_SECONDS,
): number => Math.min(first * 2 ** pings, maxGap);

export interface PendingWait {
  /** The command this marker was written for. */
  command: string;
  startedAt: number;
  /** Reminders already sent up for this wait. */
  pings: number;
  /** When the last one went; null until one has. */
  lastPingAt: number | null;
}

/**
 * The durable half of a wait on a person, and the reason a resumed agent is
 * quiet. A restart replays the tool call with no result, so without this the
 * elapsed clock restarts and a wait that has already been reported is
 * reported again -- and every merge to ops `main` restarts this container, so
 * that is the normal path rather than the exceptional one.
 */
export interface WaitMarkerPort {
  /**
   * Idempotent for the same command, and only for the same command.
   * `clearWait` does not run when the child is SIGKILLed mid-wait, so a
   * marker outlives the wait it was written for; matching on the command is
   * what stops that stale marker from silencing the next wait's first
   * reminder.
   */
  recordWait(command: string): Promise<PendingWait>;
  recordPing(): Promise<PendingWait>;
  clearWait(): Promise<void>;
}

export interface HeartbeatDeps {
  marker: WaitMarkerPort;
  boss: BossInboxPort;
  workingHours?: WorkingHours;
  firstSeconds?: number;
  /** The ceiling the doubling gap stops at. */
  maxGapSeconds?: number;
}

export const formatWaited = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

/**
 * One rung of the ladder, as the Boss reads it. What is outstanding, who has
 * to do what, how long it has been, what the check says now and when the next
 * rung comes: enough for the Boss to decide who to reach and to reach them
 * without asking the agent anything.
 */
export const waitEscalation = (args: {
  description: string;
  awaitingHuman: string;
  waitedMs: number;
  rung: number;
  status: string;
  /** Seconds until the next one. There is always a next one. */
  nextSeconds: number;
}): string =>
  [
    `I am blocked on a person and nothing has changed in ${formatWaited(args.waitedMs)}. This is reminder ${args.rung}; the next comes in ${formatWaited(args.nextSeconds * 1000)} if it is still outstanding.`,
    "",
    `Waiting for: ${args.description}`,
    `What a person has to do: ${args.awaitingHuman}`,
    "",
    "What the check says now:",
    "```",
    probeOutput(args.status),
    "```",
    "",
    "I am still on this incident and still checking. It ends the moment the check passes.",
  ].join("\n");

/**
 * Dropping the marker at the end of a wait. The failure costs nothing the
 * next call cannot repair -- a different command replaces a stale marker, and
 * the same one resumes a wait that is over and will exit on its first probe --
 * whereas throwing here would lose the result of a wait that had just
 * succeeded.
 */
const release = async (
  heartbeat: HeartbeatDeps,
  command: string,
): Promise<void> => {
  try {
    await heartbeat.marker.clearWait();
  } catch (error: unknown) {
    alarm("wait_marker_clear_failed", { command, error: String(error) });
  }
};

export interface MonitorDeps {
  probe?: Probe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  probeTimeoutSeconds?: number;
  signal?: AbortSignal;
  /** Absent means no wait is ever reported, whatever the model asks for. */
  heartbeat?: HeartbeatDeps;
}

export interface MonitorArgs {
  command: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  description: string;
  /**
   * What a person has to do for this wait to end. Set only when one does: it
   * is what turns the heartbeat on.
   */
  awaitingHuman?: string;
}

export interface MonitorResult {
  output: string;
  timedOut: boolean;
}

/**
 * Block until a read-only check passes, and tell the Boss if the thing it is
 * waiting for is a person who has not turned up.
 *
 * The reminder is here rather than in the model's hands for the reason this
 * tool exists at all: it costs **one turn no matter how long it waits**, and
 * a model asked to remind itself has to come back for a turn to do it, which
 * is the polling loop the tool replaced. It is also the half the model cannot
 * be trusted with -- an agent that has asked for a merge and gone quiet
 * cannot notice its own silence.
 */
export const runMonitor = async (
  args: MonitorArgs,
  deps: MonitorDeps = {},
): Promise<MonitorResult> => {
  const probe = deps.probe ?? shellProbe;
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const probeTimeoutMs =
    (deps.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000;
  const intervalMs = Math.max(1, args.intervalSeconds) * 1000;

  // Only a wait on a person gets a heartbeat. `monitor` is the general
  // primitive, and most of what it waits for -- a deploy shipping, an alert
  // going quiet, npm ci finishing -- has nobody to remind; reporting one is
  // noise, and noise is what teaches people to skim past the real one. The
  // argument decides it rather than the command string, because a harness
  // that pattern-matched `gh pr` would silently stop reminding the day
  // somebody wrote the same check a different way.
  const ask = args.awaitingHuman?.trim() ?? "";
  const heartbeat = ask ? deps.heartbeat : undefined;
  const firstSeconds = heartbeat?.firstSeconds ?? HEARTBEAT_FIRST_SECONDS;
  const maxGapSeconds = heartbeat?.maxGapSeconds ?? HEARTBEAT_MAX_GAP_SECONDS;
  // Not caught, unlike the two calls inside the loop, and the difference is
  // what each failure costs. Nothing has been waited on yet, so a throw here
  // costs one turn and the model reissues the call; swallowing it would start
  // a day-long wait with no marker, which is the silent no-heartbeat
  // behaviour this exists to end, with nothing in the agent's view saying so.
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
      if (heartbeat) await release(heartbeat, args.command);
      return { output: last, timedOut: false };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      if (heartbeat) await release(heartbeat, args.command);
      return { output: last, timedOut: true };
    }

    if (heartbeat && marker) {
      const waitedMs = now() - startedAt;
      const quietMs = now() - Math.min(marker.lastPingAt ?? startedAt, now());
      const gapMs =
        heartbeatGapSeconds(marker.pings, firstSeconds, maxGapSeconds) * 1000;
      // The window gates the reminder, not the clock. A wait that spans a
      // night keeps accruing and stays silent, and the first poll after the
      // window opens is the one that speaks -- so "silence until morning,
      // then a reminder" falls out of the rule rather than being a case in
      // it.
      if (
        quietMs >= gapMs &&
        insideWorkingHours(now(), heartbeat.workingHours)
      ) {
        // Counted before it is sent, deliberately. A crash in between costs
        // one reminder and the next threshold still comes; the other order
        // repeats it on every resume, and every merge to ops `main` resumes
        // every agent, so a deploy would become a page.
        //
        // A Boss error here costs the reminder and not the wait, for the same
        // reason the send below does. Skipping the send when the count did
        // not move is the part that matters: retried every interval with no
        // backoff to advance, it would be the reminder that became the spam.
        try {
          marker = await heartbeat.marker.recordPing();
        } catch (error: unknown) {
          alarm("wait_heartbeat_record_failed", {
            command: args.command,
            error: String(error),
          });
          await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
          continue;
        }

        // Every rung is an escalation, and the ladder never ends a wait.
        // Whether this one reaches a person, and how loudly, is the Boss's
        // call; the agent's job is to say, on a schedule it cannot forget,
        // that it is still blocked on one.
        try {
          await heartbeat.boss.tellBoss(
            "escalation",
            waitEscalation({
              description: args.description,
              awaitingHuman: ask,
              waitedMs,
              rung: marker.pings,
              status: last,
              nextSeconds: heartbeatGapSeconds(
                marker.pings,
                firstSeconds,
                maxGapSeconds,
              ),
            }),
          );
          log("wait_escalated", {
            command: args.command,
            pings: marker.pings,
            waitedMs,
          });
        } catch (error: unknown) {
          // The wait carries on either way, so the model is never handed a
          // turn on which it could notice this. That makes the alarm the
          // only reporter: a reminder nobody received looks, from outside,
          // exactly like a wait that has not reached its next rung.
          alarm("wait_escalation_undelivered", {
            command: args.command,
            pings: marker.pings,
            waitedMs,
            error: String(error),
          });
        }
      }
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
};

// ---------------------------------------------------------------------------
// Asking the Boss
// ---------------------------------------------------------------------------

export interface PendingQuestion {
  message: string;
  askedAt: number;
}

/**
 * The re-entrancy marker for a question the agent is blocked on. `ToolApi`
 * carries the answer (a `boss_message` directive) but has nowhere to record
 * that a question is outstanding, so that lives here.
 */
export interface QuestionMarkerPort {
  getPending(): Promise<PendingQuestion | null>;
  recordPending(message: string): Promise<PendingQuestion>;
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
 * `consumeDirective` is the one exception: the answer that ends a wait is
 * removed by the wait, because it has already been delivered as that call's
 * result.
 */
export interface DirectivePeek {
  peekDirectives(): Promise<PendingDirective[]>;
  consumeDirective(id: number): Promise<void>;
}

export interface MessageBossDeps {
  marker: QuestionMarkerPort;
  boss: BossInboxPort;
  api: DirectivePeek;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollSeconds?: number;
  minWaitSeconds?: number;
  maxGapSeconds?: number;
  signal?: AbortSignal;
}

export interface MessageBossArgs {
  message: string;
  /** Block until the Boss answers. */
  wait?: boolean;
  /** How long before an unanswered question escalates. */
  seconds?: number;
}

export interface MessageBossResult {
  /** What the Boss said back. Null when nothing was waited for, or nothing came. */
  answer: string | null;
  /** Set when the harness deadline ended the wait. */
  timedOut: boolean;
  /** Everything the poll saw that was not the answer. The caller renders these. */
  directives: Directive[];
  /** A `stop` or a `merged` arrived: the incident is no longer the agent's. */
  terminate: boolean;
}

/**
 * What the Boss is told when a question has gone unanswered. The question
 * goes in whole: it is the one thing the Boss needs to reach the right person,
 * and the Boss, not Slack, is the reader, so there is no budget to fit.
 */
export const unansweredEscalation = (question: string, waitedMs: number): string =>
  [
    `Nobody has answered my question in ${formatWaited(waitedMs)} and I am still blocked on it.`,
    "",
    "What I asked:",
    question,
    "",
    "I am still on this incident and still waiting. The answer reaches me the moment you send it with message_agent.",
  ].join("\n");

/**
 * Tell the Boss something, or ask it and wait.
 *
 * Asking is re-entrant and loud when nobody answers, and both halves are in
 * code rather than the prompt. A restart replays a tool call with no result,
 * so the marker is what stops the same question going up twice. And a
 * question nobody answers looks, from inside the wait, exactly like one
 * nobody has answered *yet*, so the escalation is the harness's to make on a
 * clock.
 *
 * What it does not do is end anything. The incident is still the agent's --
 * it always is -- so an unanswered question buys an escalation, then another
 * on a doubling gap up to a day, and the wait carries on. Only an answer, a
 * `stop`, a `merged` or the harness deadline ends it.
 */
export const runMessageBoss = async (
  args: MessageBossArgs,
  deps: MessageBossDeps,
): Promise<MessageBossResult> => {
  if (!args.wait) {
    await deps.boss.tellBoss("message", args.message);
    return { answer: null, timedOut: false, directives: [], terminate: false };
  }

  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = (deps.pollSeconds ?? MESSAGE_BOSS_POLL_SECONDS) * 1000;
  const minWaitSeconds = deps.minWaitSeconds ?? MESSAGE_BOSS_MIN_WAIT_SECONDS;
  const maxGapSeconds = deps.maxGapSeconds ?? HEARTBEAT_MAX_GAP_SECONDS;

  // The question goes up before the marker is written, not after. A crash
  // between the two replays as a question with no marker, which asks the
  // Boss twice; the other order replays as a marker for a question the Boss
  // never received, and the agent waits on an answer to nothing. Asking
  // twice is recoverable and the silence is not.
  //
  // A marker for a *different* question is a stale one: clearPending does
  // not run when the child is SIGKILLed mid-wait, so the marker outlives the
  // question it was written for. Matching on the message is what stops it
  // swallowing every later question.
  let pending = await deps.marker.getPending();
  if (!pending || pending.message !== args.message) {
    await deps.boss.tellBoss("question", args.message);
    pending = await deps.marker.recordPending(args.message);
  }

  const waitSeconds = Math.max(minWaitSeconds, args.seconds ?? minWaitSeconds);
  // Measured from when the question was asked, not from this process start.
  // A restart is not an answer, and a deadline of `now() + wait` would give a
  // crash-looping agent a fresh wait each time and defer the escalation for
  // as long as the crashes last. `now()` only wins if the marker is somehow
  // ahead of this clock, which is skew rather than a question from the future.
  const askedAt = Math.min(pending.askedAt, now());
  const deadline = askedAt + waitSeconds * 1000;

  for (;;) {
    const entries = await deps.api.peekDirectives();
    // Any word from the Boss ends the wait. It does not chat, so every one
    // is deliberate, and several at once are one answer, not an answer and a
    // leftover that get_incident would deliver a second time.
    const answers = entries.filter((entry) => bossMessageText(entry.directive) !== null);
    const terminate = entries.some(
      (entry) =>
        entry.directive.type === "stop" || entry.directive.type === "merged",
    );
    const rest = entries
      .filter((entry) => !answers.includes(entry))
      .map((entry) => entry.directive);

    if (answers.length || terminate) {
      // Clearing the marker first: a failure after it re-asks, a failure
      // before it is a question that looks outstanding after it was answered.
      await deps.marker.clearPending();
      for (const answer of answers) await deps.api.consumeDirective(answer.id);
      return {
        answer: answers.length
          ? answers.map((entry) => bossMessageText(entry.directive)).join("\n\n")
          : null,
        timedOut: false,
        directives: rest,
        terminate,
      };
    }
    // The harness deadline is an escalation path of its own: the run steers
    // the model to write a real brief inside the grace window, and escalating
    // here would spend the turn that brief needs.
    if (deps.signal?.aborted) {
      await deps.marker.clearPending();
      return { answer: null, timedOut: true, directives: rest, terminate: false };
    }

    if (now() >= deadline) {
      // A failure costs this escalation and not the wait: the next poll
      // tries again, and nothing about an unsent row changes who can finish
      // the work.
      try {
        const told = await deps.boss.escalationsSince(askedAt);
        const dueAt =
          told.count === 0 || told.lastAt === null
            ? deadline
            : told.lastAt + heartbeatGapSeconds(told.count, waitSeconds, maxGapSeconds) * 1000;
        if (now() >= dueAt) {
          await deps.boss.tellBoss(
            "escalation",
            unansweredEscalation(args.message, now() - askedAt),
          );
          log("question_escalated", {
            waitedMs: now() - askedAt,
            escalations: told.count + 1,
          });
        }
      } catch (error: unknown) {
        alarm("question_escalation_failed", { error: String(error) });
      }
    }
    await sleep(pollMs);
  }
};

const MONITOR_DESCRIPTION = [
  "Block until a shell command exits 0, then return its output. Use this for",
  "every wait: a PR merging, a deploy finishing, a migration running, an alert",
  "going quiet. It takes one turn no matter how long it waits, so never poll by",
  "calling bash in a loop. The turn is not the whole cost: a block that outlives",
  "the prompt cache pays for your context to be written again at the far end, so",
  "leave your notes somewhere useful before you enter a long one.",
  "",
  "THE COMMAND MUST BE A READ-ONLY CHECK. On a container restart the session",
  "holds this tool call with no result and the command runs again, so anything",
  "with a side effect happens twice. `monitor` with `gh pr merge` is a bug.",
  "",
  "Each invocation of the command is a short exec with its own timeout; the",
  "waiting happens inside the tool. Output comes back whole, so the command can",
  "print a whole log -- do not pre-summarise it. The answer is usually in the",
  "middle, and the context is compacted to make room rather than the log cut.",
  "",
  "SET `awaitingHuman` WHEN A PERSON IS THE THING YOU ARE WAITING FOR: merge",
  "this PR, flip this flag, restart that worker. Say what they have to do and",
  "include the link. It turns on the heartbeat -- once the wait passes an hour",
  "inside working hours the Boss is told you are blocked on a person, again at",
  "a doubling gap up to a day and then daily, and the Boss decides who to",
  "reach. It never stops you: this incident is yours until it closes.",
  "",
  "THE COMMAND MUST STILL DETECT THE THING THE PERSON WAS ASKED TO DO. This is",
  "the part that gets skipped. `awaitingHuman` controls whether the Boss hears",
  "about the wait; the command is what ends it, and if it does not actually",
  "observe the outcome then the wait can only end by somebody telling you,",
  "which is the slowest path there is and often never happens at all. A merge",
  "is `gh pr view <url> --json state,mergedAt` and a grep for merged. A flag",
  "flip is a read of the flag. A restart is the health check.",
  "",
  "Leave it unset for a deploy, a migration, npm ci or an alert going quiet.",
  "Nobody is being asked for anything, so nobody is told.",
].join("\n");

const MESSAGE_BOSS_DESCRIPTION = [
  "Send a message to the Boss, the incident commander that sits between you and",
  "every person. You never talk to people directly: the Boss reads the thread,",
  "decides who needs to hear what, and relays answers back to you. It can reach",
  "the rotation, read other incidents, and merge, close or stop incidents.",
  "",
  "Without `wait`, this records the message and returns at once. Use it to say",
  "something the Boss should know: a finding, a PR that needs a merge, that you",
  "are standing down.",
  "",
  "With `wait: true`, it asks a question and blocks until the Boss answers. Use",
  "it for one fact or one action you cannot take yourself: merge a PR, restart a",
  "worker, check a dashboard you cannot see. The Boss answers from what it can",
  "read if it can, and asks a person if it cannot. Say exactly what you need and",
  "why; the Boss is the reader, so plain prose is fine.",
  "",
  "If nobody answers within `seconds`, the Boss is told the question is still",
  "unanswered, again on a doubling gap up to a day, and you keep waiting. This",
  "is not an escalation and it does not end anything: the incident stays yours.",
  "",
  "Safe to call again after a restart: an outstanding question is recorded, so a",
  "repeated call resumes waiting rather than asking twice.",
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
          "Only when a person has to act for this wait to end: what they must do, with the link. The command must still be a check that detects them having done it -- `gh pr view --json state,mergedAt` for a merge, a flag read for a flag flip -- not a placeholder that waits to be told. Unset for a deploy, a migration or an alert going quiet.",
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

export const createMessageBossTool = async (
  deps: MessageBossDeps,
): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  const minWait = deps.minWaitSeconds ?? MESSAGE_BOSS_MIN_WAIT_SECONDS;
  const parameters = Type.Object({
    message: Type.String({
      description: "What you want the Boss to know or answer. Plain prose.",
    }),
    wait: Type.Optional(
      Type.Boolean({
        description: "Block until the Boss answers. Default false: send and carry on.",
      }),
    ),
    seconds: Type.Optional(
      Type.Number({
        description: `With wait, how long before the Boss is told the question is unanswered. Raised to ${minWait} if you ask for less. The wait continues past it.`,
      }),
    ),
  });

  return {
    name: MESSAGE_BOSS_TOOL_NAME,
    label: "Message the Boss",
    description: MESSAGE_BOSS_DESCRIPTION,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const args = params as unknown as MessageBossArgs;
      const result = await runMessageBoss(args, {
        ...deps,
        signal: eitherSignal(signal, deps.signal),
      });
      const text = !args.wait
        ? "Sent to the Boss."
        : result.answer !== null
          ? `The Boss answered: ${result.answer}`
          : result.timedOut
            ? "Your deadline ended this wait. Escalate now, with a brief."
            : "The wait ended on a directive rather than an answer.";
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
