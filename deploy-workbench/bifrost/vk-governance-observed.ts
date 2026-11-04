/**
 * The governance a virtual key carries on the wire, as far as the reconciler
 * reads it.
 *
 * `GET /api/governance/virtual-keys` returns the stored key rows, and the
 * governance fields are on them: `calendar_aligned` on the key itself, and
 * `budgets`, `rate_limit` and `provider_configs` hydrated from the VK-scoped
 * model configs before the response is sent (`hydrateVKListGovernance` at the
 * pinned tag, and `applyVKGovernanceFromModelConfigs`, which copies the model
 * config's budgets and rate limit back onto the key and its provider entries).
 *
 * So the diff in `vk-janitor-core.ts` reads what the list already carries rather
 * than making a second request per key — which matters at a five-minute cadence,
 * and matters more because the list is paged and a per-key read would be a
 * request per managed key per tick.
 *
 * ## What is here on purpose, and what is ignored
 *
 * The gateway owns a lot of numbers on these rows — `current_usage`,
 * `last_reset`, the budget override columns, provider-config ids, rate-limit
 * counters — and none of them is git's to own. They are typed as optional and
 * never compared; `differingFields` reads only the fields a `PUT` can set. That
 * is not an oversight in the typing, it is the point: a diff that compared usage
 * would fight the accounting every tick and report a change forever.
 *
 * It lives in its own module rather than in `vk-mint-core.ts` beside
 * `VirtualKey`, which extends it, so the janitor's core can name it without
 * importing anything the mint needs. Nothing here is a decision; it is the shape
 * one route returns.
 */

/** One budget row as the gateway reports it. */
export type ObservedBudget = {
  /** The two fields git owns. */
  max_limit?: number;
  reset_duration?: string;
  /** Runtime-owned. Present on every response; never compared. */
  current_usage?: number;
  last_reset?: string;
  [field: string]: unknown;
};

/**
 * One provider entry as the gateway reports it.
 *
 * The association is reported the other way round from the request: the gateway
 * sends `allow_all_keys` and a `keys` array of key rows, where a `PUT` takes
 * `key_ids`. `providerConfigKey` in `vk-janitor-core.ts` converts the observed
 * form to the requested one, because without that conversion every key would
 * look different on every tick.
 */
export type ObservedProviderConfig = {
  /** Runtime-owned: the row's own id, which git does not hold. Never compared. */
  id?: number;
  provider?: string;
  allowed_models?: string[];
  blacklisted_models?: string[];
  weight?: number | null;
  allow_all_keys?: boolean;
  keys?: Array<{ key_id?: string; name?: string }>;
  [field: string]: unknown;
};

/** One rate limit as the gateway reports it, counters included. */
export type ObservedRateLimit = {
  token_max_limit?: number | null;
  token_reset_duration?: string | null;
  request_max_limit?: number | null;
  request_reset_duration?: string | null;
  /** Runtime-owned. Present on every response; never compared. */
  token_current_usage?: number;
  request_current_usage?: number;
  [field: string]: unknown;
};

/** The governance fields one key carries in a list response. */
export type ObservedGovernance = {
  calendar_aligned?: boolean | null;
  budgets?: ObservedBudget[];
  provider_configs?: ObservedProviderConfig[];
  rate_limit?: ObservedRateLimit | null;
};
