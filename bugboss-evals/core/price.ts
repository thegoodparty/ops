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
 * The eval's own price table, in dollars per million tokens, so a run prices
 * the same way whatever BugBoss's catalog says. The Opus row was derived from
 * the per-turn `cost` fields of 20 production transcripts on 2026-09-29, every
 * turn matching to 0.00%. The Sonnet row is Pi's Bedrock catalog (pi-ai
 * 0.87.1), whose Opus row matches the derived one exactly.
 */
export const PRICE_TABLE: Record<string, Rates> = {
  "us.anthropic.claude-opus-5": perMillion({
    input: 5.5,
    output: 27.5,
    cacheRead: 0.55,
    cacheWrite5m: 6.875,
    cacheWrite1h: 11,
  }),
  "us.anthropic.claude-sonnet-5": perMillion({
    input: 2.2,
    output: 11,
    cacheRead: 0.22,
    cacheWrite5m: 2.75,
    cacheWrite1h: 4.4,
  }),
  // Anthropic API ids, for a runtime that bypasses Bedrock. List prices as
  // published 2026-09-25: cache writes are 1.25x (5m) and 2x (1h) of input.
  "claude-opus-5": perMillion({ input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }),
  "claude-opus-5-5": perMillion({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }),
  "claude-sonnet-5": perMillion({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }),
  "claude-sonnet-5-5": perMillion({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }),
};

/** Bedrock ARNs and inference-profile ids both end in the catalog id. */
export const ratesFor = (model: string): Rates => {
  const id = model.replace(/^.*inference-profile\//, "");
  const rates = PRICE_TABLE[id];
  if (!rates) throw new Error(`no price for model ${JSON.stringify(model)} in PRICE_TABLE`);
  return rates;
};

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  /** All cache writes; `cacheWrite1h` is the share written at the 1h TTL. */
  cacheWrite: number;
  cacheWrite1h: number;
}

export const priceTokens = (tokens: Tokens, rates: Rates): number =>
  tokens.input * rates.input +
  tokens.output * rates.output +
  tokens.cacheRead * rates.cacheRead +
  (tokens.cacheWrite - tokens.cacheWrite1h) * rates.cacheWrite5m +
  tokens.cacheWrite1h * rates.cacheWrite1h;
