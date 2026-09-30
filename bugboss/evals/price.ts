import type { Transcript, Turn } from "./transcript";

export type Ttl = "5m" | "1h";

/** Dollars per token, derived from the transcripts' own cost fields. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface RateDerivation {
  rates: Rates;
  /** Tokens behind each rate, so a rate derived from nothing is visible. */
  tokens: Record<keyof Rates, number>;
  /** Largest relative distance of any single turn from its category's rate. */
  maxDeviation: number;
}

/** Token counts for one request, in whatever world is being priced. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  writeTtl: Ttl;
}

/**
 * Runs before about 02:35 UTC 2026-09-29 went through the Converse path, whose
 * effective cache TTL was five minutes. The `api` field names the path, and
 * the timestamp is the fallback for a turn that does not carry it.
 */
export const INVOKE_MODEL_CUTOVER = Date.parse("2026-09-29T02:35:00Z");

export const ttlOf = (turn: Turn): Ttl => {
  if (turn.api.includes("converse")) return "5m";
  if (turn.api.includes("invoke")) return "1h";
  return turn.startedAt < INVOKE_MODEL_CUTOVER ? "5m" : "1h";
};

export const ttlMs = (ttl: Ttl): number =>
  ttl === "5m" ? 5 * 60_000 : 60 * 60_000;

export const deriveRates = (transcripts: Transcript[]): RateDerivation => {
  const sums: Record<keyof Rates, { tokens: number; usd: number }> = {
    input: { tokens: 0, usd: 0 },
    output: { tokens: 0, usd: 0 },
    cacheRead: { tokens: 0, usd: 0 },
    cacheWrite5m: { tokens: 0, usd: 0 },
    cacheWrite1h: { tokens: 0, usd: 0 },
  };
  const samples: Array<[keyof Rates, number, number]> = [];
  for (const transcript of transcripts) {
    for (const { usage } of transcript.turns) {
      const add = (key: keyof Rates, tokens: number, usd: number) => {
        if (tokens <= 0) return;
        sums[key].tokens += tokens;
        sums[key].usd += usd;
        samples.push([key, tokens, usd]);
      };
      add("input", usage.input, usage.cost.input);
      add("output", usage.output, usage.cost.output);
      add("cacheRead", usage.cacheRead, usage.cost.cacheRead);
      if (usage.cacheWrite > 0 && usage.cacheWrite1h === usage.cacheWrite) {
        add("cacheWrite1h", usage.cacheWrite, usage.cost.cacheWrite);
      } else if (usage.cacheWrite > 0 && usage.cacheWrite1h === 0) {
        add("cacheWrite5m", usage.cacheWrite, usage.cost.cacheWrite);
      }
    }
  }
  const rate = (key: keyof Rates) =>
    sums[key].tokens > 0 ? sums[key].usd / sums[key].tokens : 0;
  const rates: Rates = {
    input: rate("input"),
    output: rate("output"),
    cacheRead: rate("cacheRead"),
    cacheWrite5m: rate("cacheWrite5m"),
    cacheWrite1h: rate("cacheWrite1h"),
  };
  let maxDeviation = 0;
  for (const [key, tokens, usd] of samples) {
    if (rates[key] === 0 || tokens < 100) continue;
    maxDeviation = Math.max(
      maxDeviation,
      Math.abs(usd / tokens - rates[key]) / rates[key],
    );
  }
  return {
    rates,
    tokens: {
      input: sums.input.tokens,
      output: sums.output.tokens,
      cacheRead: sums.cacheRead.tokens,
      cacheWrite5m: sums.cacheWrite5m.tokens,
      cacheWrite1h: sums.cacheWrite1h.tokens,
    },
    maxDeviation,
  };
};

export interface PricedTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export const priceTokens = (tokens: Tokens, rates: Rates): PricedTokens => {
  const input = tokens.input * rates.input;
  const output = tokens.output * rates.output;
  const cacheRead = tokens.cacheRead * rates.cacheRead;
  const cacheWrite =
    tokens.cacheWrite *
    (tokens.writeTtl === "5m" ? rates.cacheWrite5m : rates.cacheWrite1h);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
};

export const recordedTokens = (turn: Turn): Tokens => ({
  input: turn.usage.input,
  output: turn.usage.output,
  cacheRead: turn.usage.cacheRead,
  cacheWrite: turn.usage.cacheWrite,
  writeTtl: turn.usage.cacheWrite1h > 0 ? "1h" : ttlOf(turn),
});

export const contextTokens = (tokens: Tokens): number =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite;

