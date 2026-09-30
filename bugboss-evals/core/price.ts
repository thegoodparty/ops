import type { Trace, Ttl, Turn } from "./trace";

export type { Ttl };

/** Dollars per token, by token class. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const perMillion = (rates: Rates): Rates => ({
  input: rates.input / 1e6,
  output: rates.output / 1e6,
  cacheRead: rates.cacheRead / 1e6,
  cacheWrite5m: rates.cacheWrite5m / 1e6,
  cacheWrite1h: rates.cacheWrite1h / 1e6,
});

/**
 * The eval's own price table, per model, in dollars per million tokens. It is
 * not read from Pi's catalog, so a trace from any source prices the same way.
 * The values were derived from the per-turn `cost` fields of the 20 incident
 * transcripts on 2026-09-29, every turn matching to 0.00%; `deriveRates`
 * re-derives them from whatever corpus is loaded, and the report shows any
 * drift from this table.
 */
export const PRICE_TABLE: Record<string, Rates> = {
  "us.anthropic.claude-opus-5": perMillion({
    input: 5.5,
    output: 27.5,
    cacheRead: 0.55,
    cacheWrite5m: 6.875,
    cacheWrite1h: 11,
  }),
  // No transcript runs on Sonnet, so this row is from Pi's Bedrock catalog
  // (pi-ai 0.87.1, `us.anthropic.claude-sonnet-5`), whose Opus row matches the
  // derived one above exactly. The 1h write is twice input, as Opus's is. The
  // Boss's triage and the persona run on it.
  "us.anthropic.claude-sonnet-5": perMillion({
    input: 2.2,
    output: 11,
    cacheRead: 0.22,
    cacheWrite5m: 2.75,
    cacheWrite1h: 4.4,
  }),
};

export const ratesFor = (model: string): Rates => {
  const rates = PRICE_TABLE[model];
  if (!rates) {
    throw new Error(`no price for model ${JSON.stringify(model)} in PRICE_TABLE`);
  }
  return rates;
};

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

export const ttlMs = (ttl: Ttl): number =>
  ttl === "5m" ? 5 * 60_000 : 60 * 60_000;

export const deriveRates = (transcripts: Trace[]): RateDerivation => {
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
  writeTtl: turn.cacheTtl,
});

export const contextTokens = (tokens: Tokens): number =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite;

