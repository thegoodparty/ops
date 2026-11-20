import models from "./models.json";
import type { TokenUsage } from "../framework/types";

// Delegate's own price table, because the AI SDK reports tokens and no money:
// `LanguageModelUsage` carries input, output and a cache breakdown, and no USD
// at all. A row lands here in the step whose code makes the call, before that
// code spends anything (the same rule the credentials follow), so the spend cap
// is never reading a table with no row for the call it is bounding.
//
// **A missing row is a bug, not a free run.** `costUsdFor` returns `undefined`
// rather than `0` for a model the table does not price, and the caller has to
// decide what that means; a cap that reads `$0` can never fire.

export type ModelRates = {
  /** USD per 1M uncached prompt tokens. */
  input: number;
  /** USD per 1M completion tokens, thinking included. */
  output: number;
  /** USD per 1M prompt tokens served from the cache. */
  cacheRead: number;
  /** USD per 1M prompt tokens written to the cache. */
  cacheWrite: number;
};

export type PriceTable = {
  unit: string;
  note?: string;
  models: Record<string, ModelRates>;
};

export const priceTable: PriceTable = models as PriceTable;

const PER = 1_000_000;

/**
 * What one run's tokens cost at one model's rate, or `undefined` when the table
 * has no row for that model.
 *
 * `undefined` is deliberate and load-bearing: it is the difference between "this
 * call was free" and "nobody has priced this call", and only the second is a
 * reason to fail a review rather than approve it. The spend cap cannot fire
 * against a price it does not have, so an unpriced run must not silently read as
 * zero spend.
 */
export const costUsdFor = (
  modelId: string,
  usage: TokenUsage | undefined,
  table: PriceTable = priceTable,
): number | undefined => {
  const rates = table.models[modelId];
  if (rates === undefined || usage === undefined) return undefined;
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheReadTokens * rates.cacheRead +
      usage.cacheWriteTokens * rates.cacheWrite) /
    PER
  );
};

/** The model ids the table prices, for a test or an error message. */
export const pricedModels = (table: PriceTable = priceTable): string[] =>
  Object.keys(table.models).sort();
