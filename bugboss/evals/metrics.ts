import {
  priceTokens,
  recordedTokens,
  ttlMs,
  ttlOf,
  type PricedTokens,
  type Rates,
  type Ttl,
} from "./price";
import { contextOf, isBilled, type Transcript, type Turn } from "./transcript";

export type Phase = "investigate" | "fix" | "post_pr";

export const PHASES: Phase[] = ["investigate", "fix", "post_pr"];

export const WAIT_TOOLS = new Set(["monitor", "contact_human"]);

/** Tools whose whole job is to be called again with the same arguments. */
export const POLLING_TOOLS = new Set(["monitor", "get_incident"]);

export const BLOCK_BINDING = "thinking.adaptive.block_binding";

/** A turn is cold when more than this share of its context was written, not read. */
export const COLD_SHARE = 0.5;

export interface Milestones {
  rootCauseTurn: number | null;
  prOpenTurn: number | null;
}

const accepted = (turn: Turn, name: string) =>
  turn.toolCalls.some(
    (call) =>
      call.name === name &&
      !turn.results.some(
        (result) => result.toolCallId === call.id && result.refused,
      ),
  );

const opensPr = (turn: Turn) =>
  turn.toolCalls.some(
    (call) =>
      call.name === "bash" &&
      /\bgh\s+pr\s+create\b/.test(String(call.args.command ?? "")) &&
      !turn.results.some(
        (result) => result.toolCallId === call.id && result.refused,
      ),
  );

export const milestones = (transcript: Transcript): Milestones => ({
  rootCauseTurn:
    transcript.turns.find((turn) => accepted(turn, "report_root_cause"))
      ?.index ?? null,
  prOpenTurn: transcript.turns.find(opensPr)?.index ?? null,
});

export const phaseOf = (index: number, marks: Milestones): Phase => {
  if (marks.prOpenTurn !== null && index > marks.prOpenTurn) return "post_pr";
  if (marks.rootCauseTurn !== null && index > marks.rootCauseTurn) return "fix";
  return "investigate";
};

export type ColdCause =
  | "session_start"
  | "relaunch"
  | "relaunch_after_crash_loop"
  | "wait_over_ttl"
  | "slow_tool_over_ttl"
  | "unexplained";

export interface ColdStart {
  turn: number;
  cause: ColdCause;
  gapMs: number;
  ttl: Ttl;
  writeTokens: number;
  writeUsd: number;
  afterTools: string[];
}

export interface TurnContext {
  turn: Turn;
  previous: Turn | null;
  gapMs: number;
  relaunched: boolean;
  crashLoopBefore: boolean;
}

/**
 * Pairs every billed turn with the billed turn before it, and says what
 * happened in between: how long, whether the process was relaunched, and
 * whether a block_binding crash loop sat in that gap.
 */
export const billedTurns = (transcript: Transcript): TurnContext[] => {
  const out: TurnContext[] = [];
  let previous: Turn | null = null;
  for (const turn of transcript.turns) {
    if (!isBilled(turn)) continue;
    const since = previous?.startedAt ?? transcript.startedAt;
    const relaunched = previous !== null && turn.launch !== previous.launch;
    const crashLoopBefore =
      relaunched &&
      (transcript.exits.some(
        (exit) =>
          exit.at >= since &&
          exit.at <= turn.startedAt &&
          (exit.error ?? "").includes(BLOCK_BINDING),
      ) ||
        transcript.turns.some(
          (other) =>
            other.startedAt >= since &&
            other.startedAt <= turn.startedAt &&
            (other.errorMessage ?? "").includes(BLOCK_BINDING),
        ));
    out.push({
      turn,
      previous,
      gapMs: previous ? turn.startedAt - previous.startedAt : 0,
      relaunched,
      crashLoopBefore,
    });
    previous = turn;
  }
  return out;
};

export const isCold = (turn: Turn): boolean => {
  const context = contextOf(turn.usage);
  return context > 0 && turn.usage.cacheWrite > COLD_SHARE * context;
};

export const coldCause = (entry: TurnContext): ColdCause => {
  if (entry.previous === null) return "session_start";
  if (entry.crashLoopBefore) return "relaunch_after_crash_loop";
  if (entry.relaunched) return "relaunch";
  if (entry.gapMs > ttlMs(ttlOf(entry.turn))) {
    return entry.previous.toolCalls.some((call) => WAIT_TOOLS.has(call.name))
      ? "wait_over_ttl"
      : "slow_tool_over_ttl";
  }
  return "unexplained";
};

export const coldStarts = (
  transcript: Transcript,
  rates: Rates,
): ColdStart[] =>
  billedTurns(transcript)
    .filter((entry) => isCold(entry.turn))
    .map((entry) => ({
      turn: entry.turn.index,
      cause: coldCause(entry),
      gapMs: entry.gapMs,
      ttl: ttlOf(entry.turn),
      writeTokens: entry.turn.usage.cacheWrite,
      writeUsd: priceTokens(recordedTokens(entry.turn), rates).cacheWrite,
      afterTools: entry.previous?.toolCalls.map((call) => call.name) ?? [],
    }));

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export interface DuplicateGroup {
  tool: string;
  turns: number[];
}

/**
 * The same tool with the same canonical arguments, called more than once in a
 * run. Polling tools are left out: calling them again is their purpose.
 */
export const duplicateCalls = (transcript: Transcript): DuplicateGroup[] => {
  const seen = new Map<string, DuplicateGroup>();
  for (const turn of transcript.turns) {
    for (const call of turn.toolCalls) {
      if (POLLING_TOOLS.has(call.name)) continue;
      const key = `${call.name} ${canonical(call.args)}`;
      const group = seen.get(key) ?? { tool: call.name, turns: [] };
      group.turns.push(turn.index);
      seen.set(key, group);
    }
  }
  return [...seen.values()].filter((group) => group.turns.length > 1);
};

export interface RefusalLoop {
  tool: string;
  turns: number[];
  usd: number;
}

export interface Refusals {
  total: number;
  byTool: Record<string, number>;
  /** Two or more refused calls in a row to the same tool, other tools aside. */
  loops: RefusalLoop[];
  /** Cost of the turns that issued a refused call. */
  usd: number;
}

export const refusals = (transcript: Transcript, rates: Rates): Refusals => {
  const byTool: Record<string, number> = {};
  const streaks = new Map<string, number[]>();
  const loops: RefusalLoop[] = [];
  const turnUsd = (index: number) =>
    priceTokens(recordedTokens(transcript.turns[index - 1]), rates).total;
  const close = (tool: string) => {
    const streak = streaks.get(tool) ?? [];
    if (streak.length >= 2) {
      loops.push({
        tool,
        turns: streak,
        usd: [...new Set(streak)].reduce((sum, index) => sum + turnUsd(index), 0),
      });
    }
    streaks.delete(tool);
  };
  const refusingTurns = new Set<number>();
  let total = 0;
  for (const turn of transcript.turns) {
    for (const call of turn.toolCalls) {
      const result = turn.results.find((r) => r.toolCallId === call.id);
      if (!result) continue;
      if (result.refused) {
        total += 1;
        byTool[call.name] = (byTool[call.name] ?? 0) + 1;
        refusingTurns.add(turn.index);
        streaks.set(call.name, [...(streaks.get(call.name) ?? []), turn.index]);
      } else {
        close(call.name);
      }
    }
  }
  for (const tool of [...streaks.keys()]) close(tool);
  return {
    total,
    byTool,
    loops,
    usd: [...refusingTurns].reduce((sum, index) => sum + turnUsd(index), 0),
  };
};

export interface Harness {
  errorTurns: number;
  blockBindingTurns: number;
  crashLoopRelaunchUsd: number;
  crashLoopRelaunchTurns: number[];
}

export const harness = (transcript: Transcript, rates: Rates): Harness => {
  const loopTurns = billedTurns(transcript).filter(
    (entry) => entry.crashLoopBefore && isCold(entry.turn),
  );
  return {
    errorTurns: transcript.turns.filter((turn) => turn.stopReason === "error")
      .length,
    blockBindingTurns: transcript.turns.filter((turn) =>
      (turn.errorMessage ?? "").includes(BLOCK_BINDING),
    ).length,
    crashLoopRelaunchUsd: loopTurns.reduce(
      (sum, entry) =>
        sum + priceTokens(recordedTokens(entry.turn), rates).total,
      0,
    ),
    crashLoopRelaunchTurns: loopTurns.map((entry) => entry.turn.index),
  };
};

export interface ContextProfile {
  firstTurn: number;
  peak: number;
  atRootCause: number | null;
  atPrOpen: number | null;
  last: number;
  /** Context at 0%, 10%, ... 100% of the billed turns. */
  deciles: number[];
}

export const contextProfile = (
  transcript: Transcript,
  marks: Milestones,
): ContextProfile => {
  const billed = transcript.turns.filter(isBilled);
  const sizes = billed.map((turn) => contextOf(turn.usage));
  const at = (index: number | null) =>
    index === null
      ? null
      : contextOf(
          (
            billed.find((turn) => turn.index >= index) ??
            billed[billed.length - 1]
          ).usage,
        );
  return {
    firstTurn: sizes[0] ?? 0,
    peak: Math.max(0, ...sizes),
    atRootCause: at(marks.rootCauseTurn),
    atPrOpen: at(marks.prOpenTurn),
    last: sizes[sizes.length - 1] ?? 0,
    deciles: sizes.length
      ? Array.from(
          { length: 11 },
          (_, i) => sizes[Math.round((i / 10) * (sizes.length - 1))],
        )
      : [],
  };
};

const addPriced = (a: PricedTokens, b: PricedTokens): PricedTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  total: a.total + b.total,
});

export const ZERO: PricedTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

export interface Scorecard {
  id: string;
  turns: number;
  billedTurns: number;
  recordedUsd: number;
  repricedUsd: number;
  cost: PricedTokens;
  byPhase: Record<Phase, { usd: number; turns: number }>;
  marks: Milestones;
  cold: ColdStart[];
  duplicates: DuplicateGroup[];
  refusals: Refusals;
  harness: Harness;
  context: ContextProfile;
  exits: Record<string, number>;
  ttls: Record<Ttl, number>;
}

export const measure = (transcript: Transcript, rates: Rates): Scorecard => {
  const marks = milestones(transcript);
  const byPhase: Scorecard["byPhase"] = {
    investigate: { usd: 0, turns: 0 },
    fix: { usd: 0, turns: 0 },
    post_pr: { usd: 0, turns: 0 },
  };
  let cost = ZERO;
  const ttls: Record<Ttl, number> = { "5m": 0, "1h": 0 };
  for (const turn of transcript.turns) {
    const priced = priceTokens(recordedTokens(turn), rates);
    cost = addPriced(cost, priced);
    const phase = byPhase[phaseOf(turn.index, marks)];
    phase.usd += priced.total;
    phase.turns += 1;
    if (isBilled(turn)) ttls[ttlOf(turn)] += 1;
  }
  const exits: Record<string, number> = {};
  for (const exit of transcript.exits) {
    const key = exit.error?.includes(BLOCK_BINDING)
      ? `${exit.reason} (block_binding)`
      : exit.reason;
    exits[key] = (exits[key] ?? 0) + 1;
  }
  return {
    id: transcript.id,
    turns: transcript.turns.length,
    billedTurns: transcript.turns.filter(isBilled).length,
    recordedUsd: transcript.turns.reduce(
      (sum, turn) => sum + turn.usage.cost.total,
      0,
    ),
    repricedUsd: cost.total,
    cost,
    byPhase,
    marks,
    cold: coldStarts(transcript, rates),
    duplicates: duplicateCalls(transcript),
    refusals: refusals(transcript, rates),
    harness: harness(transcript, rates),
    context: contextProfile(transcript, marks),
    exits,
    ttls,
  };
};
