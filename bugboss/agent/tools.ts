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
import { choiceProblem, MAX_CHOICE_OPTIONS } from "../slack/blocks";
import { overThreadBudget, THREAD_PROSE_CHARS } from "../slack/format";
import type { Directive, ToolApi } from "../types";

const log = makeLog("agent-tools");
const alarm = makeAlarm("agent-tools");

export const MONITOR_TOOL_NAME = "monitor";
export const CONTACT_HUMAN_TOOL_NAME = "contact_human";

export const DEFAULT_PROBE_TIMEOUT_SECONDS = 60;
export const CONTACT_HUMAN_POLL_SECONDS = 30;

/**
 * The ask, capped. The first real run posted a 2,300-character write-up with
 * the question at the bottom, to a reader holding a phone. Truncating would be
 * silent and would cut the question off; refusing costs one turn and says
 * exactly what to move where. `details` is the unbounded half.
 *
 * 550 rather than a rounder number because `unansweredBrief` quotes this
 * whole, and that brief goes through `escalate`, which refuses a post over
 * `THREAD_PROSE_CHARS` like any other. Worst case that brief is this, plus
 * `MAX_CHOICE_OPTIONS` button labels at 75 each, plus its own template, and
 * it lands at 1,149 against 1,200. At the old 700 it did not fit, which is
 * why the brief used to clamp the question instead -- and a clamped question
 * is the one thing the person picking up the incident most needs intact.
 * Making the ask's own limit close the arithmetic is what removes the clamp.
 *
 * That leaves about 50 characters of slack, so the wording of that brief and
 * this number are one decision. `tools.test.ts` composes the worst case,
 * which is what turns "and it still fits" from a claim into a failure.
 */
export const CONTACT_HUMAN_MESSAGE_LIMIT = 550;

/**
 * The shortest silence that means anything. Below it nobody has had a chance
 * to look, so a shorter request is raised to this rather than answered early —
 * which also stops the escalation below from being opted out of by asking for
 * a two-minute wait.
 */
export const CONTACT_HUMAN_MIN_WAIT_SECONDS = 1800;

/**
 * How much of a probe's own output a nudge or a brief carries.
 *
 * The status block is the one thing in either that nobody authored: it is
 * whatever the model's check printed last, and it exists so a reader can see
 * whether the thing they are being nudged about has moved. So it is the one
 * thing here that is still excerpted, and what changed is the shape.
 *
 * Head only, and the cut says nothing about its own size. What used to sit
 * in these messages was `[... 549 characters elided ...]` from the middle of
 * the text -- a count of what the reader is missing, which tells them
 * nothing they can act on, and a cut through the middle, which is where the
 * answer usually is. A reader who wants the whole output runs the check; a
 * reader being nudged wants the top of it.
 */
export const STATUS_EXCERPT_CHARS = 400;

/**
 * A probe's last output, ready for a fenced block.
 *
 * The ellipsis is the whole of what the reader is told about the cut, and it
 * is deliberate rather than terse: a cut nobody can see is the silent
 * failure this file is built against, and a cut measured in characters is
 * noise dressed as precision.
 */
export const statusExcerpt = (output: string): string => {
  const text = output.trim();
  if (!text) return "(no output)";
  return text.length <= STATUS_EXCERPT_CHARS
    ? text
    : `${text.slice(0, STATUS_EXCERPT_CHARS).trimEnd()}\u2026`;
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
 * Why the harness speaks up at all: a wait nobody ever ends is the one
 * outcome the agent can neither act on nor report. Both waits on a person
 * reach it -- `runMonitor` when the nudges get loud, `runContactHuman` when a
 * question goes unanswered -- so the port and its outcome are shared.
 *
 * This used to be `handOff`, and the difference is the whole of this change.
 * That call moved the incident to a person and stopped the agent, which took
 * it out of the dispatcher's query with nothing able to bring it back.
 * `escalate` says the same thing to the same people and moves nothing.
 */
export type EscalatePort = Pick<ToolApi, "escalate">;

/** Whether the harness got the escalation out. */
export type Escalation =
  | { told: true; reason: string }
  | { told: false; reason: string; error: string };

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
 * Nudges before the thread stops being the only place to put this. After
 * this many the same facts go out as an escalation, which mentions the
 * rotation; the gap doubles each time, so inside one working window the
 * quiet ones land an hour, three hours and seven hours in.
 *
 * The ladder does not end here, and that is the point. It used to hand the
 * incident to a person and stop the agent, which is what stranded eight
 * incidents: nothing else could finish the work and nothing was coming back
 * for it. Getting louder is the only thing left that can change, so that is
 * what happens.
 */
export const HEARTBEAT_LOUD_AFTER_PINGS = 3;

/**
 * The gap stops doubling here. A wait can legitimately run for days -- a
 * merge over a weekend, a vendor -- and left doubling, the eighth nudge would
 * be a fortnight after the seventh, which is indistinguishable from having
 * given up. A day is the floor the whole system is held to: nothing open goes
 * quiet for longer than this.
 */
export const HEARTBEAT_MAX_GAP_SECONDS = 86_400;

/**
 * The limit on `monitor`'s two prose fields, and a refusal rather than a
 * clamp.
 *
 * Both are echoed into every nudge and into the brief the harness writes
 * when the nudges run out, and neither of those has anybody to refuse it
 * to: the model is not in the loop by then, and a nudge that fails to post
 * is dropped by design, so an over-long one means an incident that waits
 * all day, nudges nobody, and then reports that it nudged three times. The
 * old fix was to cut the fields at compose time. That put
 * `[... N characters elided ...]` into a Slack message somebody was reading
 * on a phone, in place of the middle of the sentence explaining what was
 * being waited for.
 *
 * Refusing moves the same arithmetic to the only place it can be fixed. The
 * schema asks for one line; a call that sends four gets a tool result saying
 * so and costs one turn, which is what every other over-long field in this
 * file already costs (`CONTACT_HUMAN_MESSAGE_LIMIT`, `overThreadBudget`).
 *
 * 200 is the number the composition needs, unchanged from when it was a
 * clamp: two of these, plus a `STATUS_EXCERPT_CHARS` block, plus a
 * `formatWaited` bounded at fifteen characters, plus template. The nudge
 * lands at 962 and the stalled-wait brief at 1,124, against the 1,200 a
 * thread post gets -- so the brief is the tight one and its wording has
 * about 75 characters of room. `tools.test.ts` composes both worst cases, so
 * the arithmetic stays true rather than staying written down.
 */
export const MONITOR_FIELD_LIMIT = 200;

/**
 * Quiet seconds owed before the next nudge, given how many have gone already.
 * Measured from the last nudge rather than from the start, which is what
 * keeps a wait that spanned a night from firing its whole ladder in three
 * consecutive minutes once the window opens: 1h, 2h, 4h, 8h, 16h, then once
 * a day for as long as the wait lasts.
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
  /**
   * Not `HumanContactPort.post`. That one seals an outstanding question's
   * marker with the ts of whatever posts next, which is right for the ask and
   * wrong for a nudge the model did not write.
   */
  post(message: string): Promise<void>;
  escalate: EscalatePort;
  workingHours?: WorkingHours;
  firstSeconds?: number;
  /** Nudges before they start mentioning the rotation. */
  loudAfterPings?: number;
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
  /** Seconds until the next one. There is always a next one. */
  nextSeconds: number;
}): string =>
  [
    `*Still waiting on someone: ${args.description}*`,
    `${formatWaited(args.waitedMs)} so far, and it is the only thing outstanding. ${args.awaitingHuman}`,
    "",
    "*What the check says now*",
    "```",
    statusExcerpt(args.status),
    "```",
    `Next nudge in ${formatWaited(args.nextSeconds * 1000)}.`,
  ].join("\n");

/**
 * The brief the harness writes once the nudges get loud. Thinner than one the
 * model would write -- the harness knows the wait and nothing else -- which
 * is why the prompt tells the model to escalate itself if it can see this
 * coming and say something more useful.
 */
export const stalledWaitBrief = (args: {
  description: string;
  awaitingHuman: string;
  waitedMs: number;
  status: string;
  nudges: number;
}): string =>
  [
    `Nobody has ended this wait in ${formatWaited(args.waitedMs)}, across ${args.nudges} nudges in the thread.`,
    "",
    "*What I am waiting for*",
    `${args.description} — ${args.awaitingHuman}`,
    "",
    "*Where it stands*",
    "```",
    statusExcerpt(args.status),
    "```",
    "Everything I found is in this thread. The work is done; this one step is not, and it is not something I can do.",
    "",
    "I am still on this and still checking. Nothing here needs taking over.",
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

/**
 * A failure here costs the escalation and not the wait. The next rung is
 * hours away and still arrives, and the wait was always going to continue --
 * nothing about an unsent Slack message changes who can finish this.
 */
const escalateStalledWait = async (
  heartbeat: HeartbeatDeps,
  reason: string,
  brief: string,
): Promise<{ outcome: Escalation; directives: Directive[] }> => {
  try {
    const response = await heartbeat.escalate.escalate({ reason, brief });
    return {
      outcome: response.ok
        ? { told: true, reason }
        : {
            told: false,
            reason,
            error: response.error ?? "the escalation was refused without a reason",
          },
      directives: response.directives ?? [],
    };
  } catch (error: unknown) {
    return {
      outcome: { told: false, reason, error: String(error) },
      directives: [],
    };
  }
};

export interface MonitorDeps {
  probe?: Probe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  probeTimeoutSeconds?: number;
  /** Overridable so a test can compose the worst case without a 200-char literal. */
  fieldLimit?: number;
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
  /** Anything the escalation drained. The caller renders these. */
  directives: Directive[];
  /** Set when the call was refused before any wait was started. */
  rejected: string | null;
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
  const probeTimeoutMs =
    (deps.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000;
  const intervalMs = Math.max(1, args.intervalSeconds) * 1000;
  const fieldLimit = deps.fieldLimit ?? MONITOR_FIELD_LIMIT;

  // Before the marker, before the first probe, and before anything can be
  // posted. Both fields end up in Slack messages the harness composes with
  // the model no longer in the loop, so this is the last point at which
  // being too long is something anybody can fix. It costs one turn.
  const overLong = (
    [
      ["description", args.description],
      ["awaitingHuman", args.awaitingHuman ?? ""],
    ] as const
  ).find(([, text]) => text.length > fieldLimit);
  if (overLong) {
    const [field, text] = overLong;
    return {
      output: "",
      timedOut: false,
      escalation: null,
      directives: [],
      rejected:
        `${field} is ${text.length} characters and the limit is ${fieldLimit}. ` +
        "It is echoed verbatim into every nudge and into the brief posted if " +
        "nobody turns up, so it has to be the one line the schema asks for. " +
        "Say what you are waiting for and who has to do what; the reasoning " +
        "belongs in the thread.",
    };
  }

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
  const loudAfter = heartbeat?.loudAfterPings ?? HEARTBEAT_LOUD_AFTER_PINGS;
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
      return {
        output: last,
        timedOut: false,
        escalation: null,
        directives: [],
        rejected: null,
      };
    }
    if (deps.signal?.aborted || now() >= deadline) {
      if (heartbeat) await release(heartbeat, args.command);
      return {
        output: last,
        timedOut: true,
        escalation: null,
        directives: [],
        rejected: null,
      };
    }

    if (heartbeat && marker) {
      const waitedMs = now() - startedAt;
      const quietMs = now() - Math.min(marker.lastPingAt ?? startedAt, now());
      const gapMs =
        heartbeatGapSeconds(marker.pings, firstSeconds, maxGapSeconds) * 1000;
      // The window gates the nudge, not the clock. A wait that spans a night
      // keeps accruing and stays silent, and the first poll after the window
      // opens is the one that speaks -- so "silence until morning, then a
      // ping" falls out of the rule rather than being a case in it.
      if (
        quietMs >= gapMs &&
        insideWorkingHours(now(), heartbeat.workingHours)
      ) {
        // Counted before it is posted, which is the opposite order from the
        // question marker and deliberate. A crash in between costs one nudge
        // and the next threshold still comes; the other order re-nudges on
        // every resume, and every merge to ops `main` resumes every agent, so
        // a deploy would become a notification.
        //
        // A Boss error here costs the nudge and not the wait, for the same
        // reason the post below does. Skipping the post when the count did not
        // move is the part that matters: retried every interval with no
        // backoff to advance, it would be the nudge that became the spam.
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

        // Past `loudAfter` the nudge becomes an escalation: the same facts,
        // posted where the rotation sees them. It never becomes a hand-off.
        // That is the change -- a hand-off moved the incident to a person and
        // stopped the agent, and since nothing else could finish the work and
        // nothing was coming back for it, the incident simply stopped. So the
        // ladder gets louder and the wait carries on.
        if (marker.pings >= loudAfter) {
          const escalated = await escalateStalledWait(
            heartbeat,
            `nobody has ended a ${formatWaited(waitedMs)} wait after ${marker.pings} nudges`,
            stalledWaitBrief({
              description: args.description,
              awaitingHuman: ask,
              waitedMs,
              status: last,
              nudges: marker.pings,
            }),
          );
          // Deliberately not released, and the wait deliberately not ended.
          // The marker is what carries `startedAt` and the ping count across
          // the restarts that every merge to ops `main` causes, and this wait
          // is still the thing the agent is blocked on.
          log("wait_escalated", {
            command: args.command,
            waitedMs,
            pings: marker.pings,
            told: escalated.outcome.told,
          });
          // The wait carries on either way, so the model is never handed a
          // turn on which it could notice this. That makes the alarm the only
          // reporter: an escalation nobody received looks, from the thread,
          // exactly like a wait that has not got loud yet.
          if (!escalated.outcome.told) {
            alarm("wait_escalation_undelivered", {
              command: args.command,
              waitedMs,
              pings: marker.pings,
              error: escalated.outcome.error,
            });
          }
          await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
          continue;
        }

        const message = heartbeatMessage({
          description: args.description,
          awaitingHuman: ask,
          waitedMs,
          status: last,
          nextSeconds: heartbeatGapSeconds(
            marker.pings,
            firstSeconds,
            maxGapSeconds,
          ),
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

export interface ContactHumanDeps {
  contact: HumanContactPort;
  api: DirectivePeek;
  escalate: EscalatePort;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollSeconds?: number;
  minWaitSeconds?: number;
  messageLimit?: number;
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
   * the escalation below all run exactly as they do without them, because a
   * button nobody presses *is* an unanswered question.
   */
  options?: readonly string[];
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

/**
 * The reply that ends a wait. A message somebody addressed to other people in
 * the thread is not one: it is still delivered, as an ordinary directive the
 * agent reads as context, but ending the wait on it sends an investigation
 * down whatever an offhand remark happened to say. Who a message was for is
 * read by `slack/intent.ts` and recorded on the directive.
 *
 * An allow-list rather than "not `others`", because `Addressed` has a third
 * label and it is the one the read is coached to prefer. `slack/intent.ts`
 * tells the model to answer `unclear` over a wrong `agent` on the grounds
 * that being unsure "costs somebody re-sending one sentence" -- which is only
 * true if `unclear` does not end the wait. A deny-list makes that sentence a
 * lie for whichever producer forgets to collapse the label, and a directive
 * arrives here as `JSON.parse` of a row rather than as a checked type, so the
 * label this acts on is whatever was written.
 */
export const firstReplyAfter = (
  pending: PendingDirective[],
  askedAt: number,
): { id: number; directive: HumanReply } | null => {
  const replies = pending
    .filter((entry): entry is { id: number; directive: HumanReply } =>
      entry.directive.type === "human_message",
    )
    .filter(
      (entry) =>
        entry.directive.addressed === "agent" ||
        entry.directive.addressed === undefined,
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
  /** Set when the call was refused before anything was posted or recorded. */
  rejected: string | null;
  /** Set when the wait expired unanswered; null on a reply, a directive or the deadline. */
  escalation: Escalation | null;
}

/**
 * The brief the harness writes when the model did not. It is deliberately
 * thinner than one the model would write — the harness knows the question
 * and nothing else — which is the reason the prompt tells the model to
 * escalate itself before it gets here.
 *
 * The question goes in whole. It is the only thing in here the reader
 * genuinely needs and the only thing they cannot reconstruct, so
 * `CONTACT_HUMAN_MESSAGE_LIMIT` is sized to let it -- see there for the
 * arithmetic against the 1,200 `escalate` will accept.
 */
export const unansweredBrief = (
  question: string,
  waitedMinutes: number,
  options: readonly string[] = [],
): string =>
  [
    `Nobody answered in ${waitedMinutes} minutes.`,
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
    "Everything I found is in this thread. I stopped at the question rather than guessing past it, and I am still on this.",
  ].join("\n");

/**
 * The escalation the harness makes on its own behalf. A failure here is never
 * swallowed: the tool result says nobody was told, so the next turn can say
 * it itself rather than believing the thread has been warned.
 */
const escalateUnanswered = async (
  deps: ContactHumanDeps,
  question: string,
  waitedMinutes: number,
  options: readonly string[] = [],
): Promise<{ outcome: Escalation; directives: Directive[] }> => {
  const reason = `no reply in ${waitedMinutes} minutes`;
  try {
    const response = await deps.escalate.escalate({
      reason,
      brief: unansweredBrief(question, waitedMinutes, options),
    });
    return {
      outcome: response.ok
        ? { told: true, reason }
        : {
            told: false,
            reason,
            error: response.error ?? "the escalation was refused without a reason",
          },
      directives: response.directives ?? [],
    };
  } catch (err) {
    return {
      outcome: { told: false, reason, error: String(err) },
      directives: [],
    };
  }
};

/**
 * Ask a human, and say so loudly if nobody answers.
 *
 * The second half is the part that is in code rather than in the prompt,
 * because the failure is one the agent cannot see: a question nobody replies
 * to looks, from inside the wait, exactly like a question nobody has replied
 * to *yet*. So the escalation is the harness's to make on a clock, and the
 * model is advisory about when rather than trusted with it.
 *
 * What it does not do is end anything. The incident is still the agent's --
 * it always is -- so an unanswered question buys a louder thread and a turn
 * back, not a stop.
 */
export const runContactHuman = async (
  args: ContactHumanArgs,
  deps: ContactHumanDeps,
): Promise<ContactHumanResult> => {
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = (deps.pollSeconds ?? CONTACT_HUMAN_POLL_SECONDS) * 1000;
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

  // Checked here and not left to the route, even though the route checks it
  // too. `details` is posted after the ask and after the marker is written,
  // so a 400 there would throw with the question already in the thread and no
  // wait started -- an ask nobody is waiting on, which is the one outcome
  // this tool exists to prevent. Both refusals happen before anything is
  // posted.
  const longDetails = args.details ? overThreadBudget("details", args.details) : null;
  if (longDetails) {
    return {
      reply: null,
      timedOut: false,
      directives: [],
      terminate: false,
      rejected: longDetails,
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
        reply: reply ? reply.directive.text : null,
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
      // Cleared after the escalation, and only if it landed. Clearing first
      // and dying in between replays as a brand-new question: re-posted, with
      // a fresh askedAt that makes a reply already sitting in the thread look
      // too old to be one. Left standing after a failed escalation, the
      // marker keeps the original askedAt, so the next attempt escalates at
      // once instead of restarting the wait.
      if (escalation.outcome.told) await deps.contact.clearPending();
      return {
        reply: null,
        timedOut: true,
        directives: [...rest, ...escalation.directives],
        // The escalation moved nothing, so the question going unanswered is
        // not a reason to stop -- the agent is still the only thing that can
        // finish this. Only a `stop` or a `merged` ends the run, and those
        // say so whatever the escalation did.
        terminate: escalation.directives.some(
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
  "going quiet. It takes one turn no matter how long it waits, so never poll by",
  "calling bash in a loop. The turn is not the whole cost: a block that outlives",
  "the prompt cache pays for your context to be written again at the far end, so",
  "leave the thread and your notes somewhere useful before you enter a long one.",
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
  "include the link. It turns on the heartbeat -- the thread is nudged once the",
  "wait passes an hour inside working hours, the gap doubles to a day and then",
  "keeps going, and past the third nudge each one also mentions the rotation.",
  "It never hands the incident away and it never stops you: this incident is",
  "yours until it closes. Escalate yourself first if you can see the loud",
  "rungs coming, because your brief is better than the harness's.",
  "",
  "THE COMMAND MUST STILL DETECT THE THING THE PERSON WAS ASKED TO DO. This is",
  "the part that gets skipped. `awaitingHuman` controls who gets nudged; the",
  "command is what ends the wait, and if it does not actually observe the",
  "outcome then the wait can only end by somebody telling you, which is the",
  "slowest path there is and often never happens at all. A merge is",
  "`gh pr view <url> --json state,mergedAt` and a grep for merged. A flag flip",
  "is a read of the flag. A restart is the health check. Being told in the",
  "thread is the fallback, not the plan.",
  "",
  "Leave it unset for a deploy, a migration, npm ci or an alert going quiet.",
  "Nobody is being asked for anything, so nothing is posted.",
].join("\n");

const CONTACT_HUMAN_DESCRIPTION = [
  "Post to the incident's Slack thread and block until a human replies. Use it",
  "to ask for one fact or one action you cannot take yourself: merge a PR,",
  "restart a worker, check a third-party dashboard.",
  "",
  "THIS IS NOT AN ESCALATION. The incident stays yours and no human has been",
  "told it is theirs. If you have concluded you cannot take the incident",
  "further, that is escalate, not a question. A question you do not intend to",
  "act on yourself is an escalation wearing a question mark.",
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
  "If nobody answers, this escalates for you: the rotation is told and a brief",
  "you did not write is posted. The incident stays yours and you get the turn",
  "back. Escalate yourself first if you can see it coming — your brief is",
  "better than the one the harness writes. Buttons change nothing here: one",
  "nobody presses is silence, and silence escalates.",
  "",
  "Safe to call again after a restart: the outstanding question is recorded",
  "before it is posted, so a repeated call resumes waiting rather than asking",
  "twice.",
].join("\n");

export const createMonitorTool = async (
  deps: MonitorDeps = {},
): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  const fieldLimit = deps.fieldLimit ?? MONITOR_FIELD_LIMIT;
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
      description: `What you are waiting for, in one line. Posted verbatim in every nudge, so at most ${fieldLimit} characters.`,
    }),
    awaitingHuman: Type.Optional(
      Type.String({
        description:
          `Only when a person has to act for this wait to end: what they must do, with the link. One line, at most ${fieldLimit} characters, posted verbatim in every nudge. The command must still be a check that detects them having done it -- \`gh pr view --json state,mergedAt\` for a merge, a flag read for a flag flip -- not a placeholder that waits to be told. Unset for a deploy, a migration or an alert going quiet.`,
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
      // No escalation branch. A wait that gets loud keeps waiting, so the
      // model is not given a turn to be told about it; it learns from the
      // thread, like everyone else.
      if (result.rejected) {
        return {
          content: [
            { type: "text", text: `Nothing is being waited on: ${result.rejected}` },
          ],
          details: { refused: true, command: args.command },
        };
      }
      const header = result.timedOut
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
        terminate: result.directives.some(
          (directive) =>
            directive.type === "stop" || directive.type === "merged",
        ),
      };
    },
  } as ToolDefinition;
};

/** What the model is told about a `contact_human` question nobody answered. */
export const escalationText = (escalation: Escalation): string =>
  escalation.told
    ? `${escalation.reason}, so the rotation has been told and a brief posted. This incident is still yours; carry on, or ask again if you still need the answer.`
    : `error: ${escalation.reason}, and the automatic escalation failed (${escalation.error}). Nobody has been told, so say it in the thread yourself.`;

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
          `The evidence, posted as a separate follow-up message under the ask. Queries, counts, rule ids, control tests. Its own post, so its own ${THREAD_PROSE_CHARS} characters; the uncapped place is the post-mortem.`,
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
            ? "Your deadline ended this wait. Escalate now, with a brief."
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
