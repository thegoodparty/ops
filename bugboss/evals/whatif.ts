import {
  billedTurns,
  isCold,
  milestones,
  ZERO,
  type TurnContext,
} from "./metrics";
import {
  contextTokens,
  priceTokens,
  recordedTokens,
  ttlMs,
  ttlOf,
  type PricedTokens,
  type Rates,
  type Tokens,
} from "./price";
import { contextOf, isBilled, type Transcript } from "./transcript";

/**
 * One priced world: a token count for every recorded turn (zero for turns
 * that billed nothing), plus requests the variant adds, such as keep-alive
 * pings or a handoff turn. `frozen` turns are priced the same in every world.
 */
export interface World {
  turns: Tokens[];
  extras: Tokens[];
  frozen: boolean[];
}

const EMPTY: Tokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  writeTtl: "1h",
};

const cached = (tokens: Tokens) => tokens.cacheRead + tokens.cacheWrite;

const byIndex = (transcript: Transcript) => {
  const map = new Map<number, TurnContext>();
  for (const entry of billedTurns(transcript)) map.set(entry.turn.index, entry);
  return map;
};

/**
 * The recorded run re-priced under today's cache: every write at the 1h
 * rate, and a turn that went cold only because the 5m Converse TTL lapsed
 * inside a gap the 1h TTL covers becomes warm. Relaunch cold writes stay
 * cold. The cold writes on relaunches out of the block_binding crash loop are
 * frozen: that loop is fixed, and its cost is reported on its own rather than
 * credited to any lever.
 */
export const todayWorld = (transcript: Transcript): World => {
  const entries = byIndex(transcript);
  const turns = transcript.turns.map((turn) =>
    isBilled(turn) ? { ...recordedTokens(turn), writeTtl: "1h" as const } : EMPTY,
  );
  const frozen = transcript.turns.map(() => false);
  for (const [index, entry] of entries) {
    const slot = index - 1;
    if (entry.crashLoopBefore && isCold(entry.turn)) frozen[slot] = true;
    if (
      ttlOf(entry.turn) === "5m" &&
      isCold(entry.turn) &&
      entry.previous !== null &&
      !entry.relaunched &&
      entry.gapMs <= ttlMs("1h")
    ) {
      const tokens = turns[slot];
      const context = contextTokens(tokens);
      const read = Math.min(
        cached(turns[entry.previous.index - 1]),
        context - tokens.input,
      );
      turns[slot] = {
        ...tokens,
        cacheRead: read,
        cacheWrite: context - tokens.input - read,
      };
    }
  }
  return { turns, extras: [], frozen };
};

export interface KeepAlive {
  everyMinutes: number;
  ttlMinutes: number;
}

/**
 * A zero-output request every `everyMinutes` while the process sits in a
 * gap, which reads the cached context and so refreshes it. Each ping reads
 * the whole cached prefix at the read rate and bills one output token. A
 * relaunch gap gets no pings: no process is alive to send them.
 */
export const keepAlive = (
  transcript: Transcript,
  base: World,
  policy: KeepAlive,
): World => {
  const everyMs = policy.everyMinutes * 60_000;
  const ttl = policy.ttlMinutes * 60_000;
  const turns = [...base.turns];
  const extras = [...base.extras];
  for (const [index, entry] of byIndex(transcript)) {
    if (entry.previous === null || entry.relaunched) continue;
    const slot = index - 1;
    if (base.frozen[slot]) continue;
    const previous = base.turns[entry.previous.index - 1];
    const pings = Math.max(0, Math.ceil(entry.gapMs / everyMs) - 1);
    for (let i = 0; i < pings; i++) {
      extras.push({ ...EMPTY, output: 1, cacheRead: cached(previous) });
    }
    const tokens = turns[slot];
    const context = contextTokens(tokens);
    const cold = tokens.cacheWrite > 0.5 * context;
    if (pings > 0 && cold && entry.gapMs > ttl) {
      const read = Math.min(cached(previous), context - tokens.input);
      turns[slot] = {
        ...tokens,
        cacheRead: read,
        cacheWrite: context - tokens.input - read,
      };
    }
  }
  return { turns, extras, frozen: base.frozen };
};

/**
 * Removes `tokens` from the front of every request. On a warm turn they come
 * out of the cache read; on a cold turn out of the cache write.
 */
export const prefixTrim = (base: World, tokens: number): World => ({
  ...base,
  turns: base.turns.map((turn, slot) => {
    const context = contextTokens(turn);
    if (context === 0 || base.frozen[slot]) return turn;
    const cut = Math.min(tokens, context - turn.input);
    if (turn.cacheRead > 0.5 * context) {
      const fromRead = Math.min(cut, turn.cacheRead);
      return {
        ...turn,
        cacheRead: turn.cacheRead - fromRead,
        cacheWrite: turn.cacheWrite - (cut - fromRead),
      };
    }
    const fromWrite = Math.min(cut, turn.cacheWrite);
    return {
      ...turn,
      cacheWrite: turn.cacheWrite - fromWrite,
      cacheRead: turn.cacheRead - (cut - fromWrite),
    };
  }),
});

export interface PhaseReset {
  handoffTokens: number;
  handoffOutputTokens: number;
  reorientTurns: number;
  reorientOutputTokens: number;
  reorientWriteTokens: number;
  /** Whether the fresh session's first request reads tools and system prompt from cache. */
  prefixCached: boolean;
  /** Reset only where the context at that milestone is at least this large. */
  minContextTokens: number;
}

/**
 * At report_root_cause and at `gh pr create`, the session ends and a fresh
 * one starts from the fixed prefix plus a handoff. From then on each turn
 * carries prefix + handoff + whatever the new session has grown by, instead
 * of the whole history. The reset costs one turn to write the handoff, one
 * cold write of the new session, and some re-orientation turns.
 */
export const phaseReset = (
  transcript: Transcript,
  base: World,
  policy: PhaseReset,
): World => {
  const marks = milestones(transcript);
  const candidates = [marks.rootCauseTurn, marks.prOpenTurn]
    .filter((index): index is number => index !== null)
    .sort((a, b) => a - b)
    .filter((index, i, all) => all.indexOf(index) === i);
  const firstBilled = transcript.turns.find(isBilled);
  if (!firstBilled) return base;
  const prefix = contextOf(firstBilled.usage);
  const fresh = prefix + policy.handoffTokens;
  const turns = [...base.turns];
  const extras = [...base.extras];
  const contextAt = (index: number) => contextTokens(base.turns[index - 1]);
  const resets = candidates.filter(
    (index) => contextAt(index) >= policy.minContextTokens,
  );
  if (resets.length === 0) return base;

  for (const reset of resets) {
    extras.push({
      ...EMPTY,
      cacheRead: contextAt(reset),
      output: policy.handoffOutputTokens,
    });
    for (let i = 0; i < policy.reorientTurns; i++) {
      extras.push({
        ...EMPTY,
        cacheRead: fresh + i * policy.reorientWriteTokens,
        cacheWrite: policy.reorientWriteTokens,
        output: policy.reorientOutputTokens,
      });
    }
  }

  const firstAfter = new Set<number>();
  for (const reset of resets) {
    const next = transcript.turns.find(
      (turn) => turn.index > reset && isBilled(turn),
    );
    if (next) firstAfter.add(next.index);
  }

  for (const turn of transcript.turns) {
    const slot = turn.index - 1;
    const tokens = base.turns[slot];
    const context = contextTokens(tokens);
    if (context === 0 || base.frozen[slot]) continue;
    const reset = [...resets].reverse().find((index) => index < turn.index);
    if (reset === undefined) continue;
    const shift = contextAt(reset) - fresh;
    if (shift <= 0) continue;
    const shrunk = Math.max(fresh, context - shift);
    if (firstAfter.has(turn.index)) {
      const read = policy.prefixCached ? prefix : 0;
      turns[slot] = {
        ...tokens,
        cacheRead: read,
        cacheWrite: shrunk - tokens.input - read,
      };
    } else if (tokens.cacheWrite > 0.5 * context) {
      turns[slot] = { ...tokens, cacheRead: 0, cacheWrite: shrunk - tokens.input };
    } else {
      turns[slot] = {
        ...tokens,
        cacheRead: Math.max(0, shrunk - tokens.input - tokens.cacheWrite),
      };
    }
  }
  return { turns, extras, frozen: base.frozen };
};

const sum = (items: PricedTokens[]): PricedTokens =>
  items.reduce(
    (a, b) => ({
      input: a.input + b.input,
      output: a.output + b.output,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheWrite: a.cacheWrite + b.cacheWrite,
      total: a.total + b.total,
    }),
    ZERO,
  );

export const priceWorld = (world: World, rates: Rates): PricedTokens =>
  sum([...world.turns, ...world.extras].map((t) => priceTokens(t, rates)));

export const frozenUsd = (world: World, rates: Rates): number =>
  world.turns.reduce(
    (total, turn, slot) =>
      world.frozen[slot] ? total + priceTokens(turn, rates).total : total,
    0,
  );

export interface Repriced {
  baseUsd: number;
  variantUsd: number;
  savingUsd: number;
  base: PricedTokens;
  variant: PricedTokens;
}

export const reprice = (base: World, variant: World, rates: Rates): Repriced => {
  const b = priceWorld(base, rates);
  const v = priceWorld(variant, rates);
  return {
    baseUsd: b.total,
    variantUsd: v.total,
    savingUsd: b.total - v.total,
    base: b,
    variant: v,
  };
};
