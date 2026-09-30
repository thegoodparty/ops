import { priceTokens, ratesFor, type Tokens } from "./price";
import type { Trace } from "./trace";

export interface Spend extends Tokens {
  turns: number;
  usd: number;
  /** Models seen that the price table does not know; their turns are unpriced. */
  unpriced: string[];
}

export const ZERO_SPEND: Spend = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  turns: 0,
  usd: 0,
  unpriced: [],
};

/** Tokens by class and their price, over every turn of every session. */
export const spendOf = (traces: Trace[]): Spend => {
  const out: Spend = { ...ZERO_SPEND, unpriced: [] };
  for (const trace of traces) {
    for (const turn of trace.turns) {
      const tokens: Tokens = {
        input: turn.usage.input,
        output: turn.usage.output,
        cacheRead: turn.usage.cacheRead,
        cacheWrite: turn.usage.cacheWrite,
        // Pi splits the 1h share out; when it does not, the turn's TTL says which.
        cacheWrite1h: turn.usage.cacheWrite1h || (turn.cacheTtl === "1h" ? turn.usage.cacheWrite : 0),
      };
      out.input += tokens.input;
      out.output += tokens.output;
      out.cacheRead += tokens.cacheRead;
      out.cacheWrite += tokens.cacheWrite;
      out.cacheWrite1h += tokens.cacheWrite1h;
      out.turns += 1;
      const model = turn.model || trace.model;
      try {
        out.usd += priceTokens(tokens, ratesFor(model));
      } catch {
        if (!out.unpriced.includes(model)) out.unpriced.push(model);
      }
    }
  }
  return out;
};

export const addSpend = (a: Spend, b: Spend): Spend => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  turns: a.turns + b.turns,
  usd: a.usd + b.usd,
  unpriced: [...new Set([...a.unpriced, ...b.unpriced])],
});
