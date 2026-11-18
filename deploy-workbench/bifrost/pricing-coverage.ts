/**
 * Does every name the gateway serves have a price?
 *
 * The gateway prices a request from one remote datasheet, matched exactly on
 * `model|provider|mode`, and a miss is written to the log as a cost of zero
 * rather than as an error or a null. So a served model the datasheet has no row
 * for is silent: it bills at zero, it is invisible to a per-provider budget
 * (which is charged only when cost is above zero), and the only way anyone finds
 * out is by reading the logs. This module answers the question the gateway
 * cannot: for each served name, is there a row it would find?
 *
 * ## Why this is a reimplementation, and what makes that safe
 *
 * The alternative — ask the gateway — needs its admin token, and the check is
 * meant to run somewhere with no credential at all. So the lookup is
 * reimplemented, which is only safe if it is *the same* lookup: a checker more
 * permissive than the gateway would report a name as fine that bills at zero,
 * which is worse than no check. Every rule below names the v2.4.0 source it
 * copies, and `pricing-coverage.test.ts` pins each one against a case the source
 * decides. If upstream changes the lookup, this module is wrong in the
 * conservative direction only if the test is updated with it, so the pinned tag
 * is a literal here (`BIFROST_PRICING_TAG`) and the test asserts it matches
 * `bifrost-image.ts`.
 *
 * The three steps it copies:
 *
 * 1. **Folding the datasheet** (`framework/modelcatalog/datasheet/sync.go`,
 *    `resolvePricingRows` at `:133`, `pricingCandidate.beats` at `:107`). Several
 *    feed keys can fold onto one stored key, because the row's provider is
 *    normalised (`:147`) and the feed key loses its `provider/` prefix
 *    (`types.go:582`, `extractModelName`). The survivor is the row whose own
 *    provider already equals the stored provider, and otherwise the
 *    lexicographically smaller feed key. The survivor is what the gateway holds,
 *    so it is what decides zero or not — a priced row that lost the fold does not
 *    price anything.
 * 2. **Resolving the served name** (`datasheet/cost.go`, `resolvePricing` at
 *    `:2479`). Candidates in order: the alias's `model_name`, the alias's
 *    `model_id`, then the name the caller sent. First hit wins. This is why the
 *    Fireworks role aliases price off the catalog-named row while the wire id
 *    stays the router.
 * 3. **The mode fallback** (`getBasePricing` at `:2578` and
 *    `chatResponsesFallbackMode`). Chat and responses requests retry each other's
 *    mode, so a model with a row in only one of them is still priced. Both are
 *    probed, and a lowercase retry (`:2582`) is included for the same reason.
 *
 * What it deliberately does *not* copy: the override-only path (`cost.go:2518`),
 * because we set no overrides and a check that trusted them would report a name
 * as priced by a rate no file in this repo holds. Enterprise/flex/priority tier
 * rates are not consulted either: the gateway takes the standard tier for a
 * normal request, and a row whose only non-zero rate is a batch or priority rate
 * still bills a standard request at zero.
 *
 * ## "Priced" means a non-zero rate, not a row
 *
 * A row whose standard rates are all zero computes a cost of zero exactly as a
 * missing row does, so the question is not whether a row exists but whether it
 * would compute anything. Only the standard-tier input, output, cache-read and
 * cache-write token rates are inspected, which are the four `computeTextCost`
 * multiplies tokens by (`cost.go:997`). The check never reports a rate, and this
 * module has no way to: it returns verdicts, not numbers.
 */

/**
 * The Bifrost tag these rules were read from. Pinned here as a literal because
 * this module must not import the Pulumi program (`bifrost-image.ts` pulls in
 * `@pulumi/aws` through its imports), and the test asserts the two agree so a
 * version bump is a visible edit rather than a silent drift.
 */
export const BIFROST_PRICING_TAG = "v2.4.0";

/** The modes a chat-completions request can be priced from, in lookup order. */
const PRICING_MODES = ["chat", "responses"] as const;

/**
 * The standard-tier rate fields a normal request is actually billed at
 * (`computeTextCost`, `cost.go:997`, through `tieredInputRate` and friends).
 *
 * A tier rate (`..._above_272k_tokens`, `..._priority`, `..._batches`) is absent
 * from this list on purpose: it only applies above a token threshold or on a
 * tier we do not request, so a row carrying one is still zero for the request
 * shape this check is about.
 */
const STANDARD_RATE_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
] as const;

/** One datasheet row, as far as pricing a chat request is concerned. */
export type DatasheetEntry = {
  provider?: unknown;
  mode?: unknown;
  [rate: string]: unknown;
};

/** The datasheet as Bifrost fetches it: feed key to row. */
export type Datasheet = Record<string, DatasheetEntry>;

/** One served name from `config.json`, with the alias it may carry. */
export type ServedName = {
  provider: string;
  name: string;
  /** The alias's `model_name`, when the key declares one. */
  modelName?: string;
  /** The alias's `model_id`, when the key declares one. */
  modelId?: string;
};

/** How a served name was priced, for a report that says something when green. */
export type PricedBy =
  /** The row is keyed on the name the caller sent. */
  | "own-id"
  /** The alias's `model_name` found the row. */
  | "alias-model-name"
  /** The alias's `model_id` found the row. */
  | "alias-model-id";

export type CoverageResult =
  | {
      priced: true;
      served: ServedName;
      /** Which candidate resolved, and what it resolved to. */
      pricedBy: PricedBy;
      resolvedName: string;
      mode: string;
    }
  | {
      priced: false;
      served: ServedName;
      /**
       * Why not, as a code rather than prose: `no-row` is a name the feed has
       * never carried, and `zero-rate` is a row the feed does carry whose
       * standard rates compute nothing.
       */
      reason: "no-row" | "zero-rate";
      /** Every candidate that was tried, in order, for the report. */
      tried: string[];
    };

/**
 * `normalizeProvider` (`types.go:477`). Only the arms that can apply to a
 * provider this repo serves are copied — Bedrock, Fireworks — and the rest map a
 * name to itself, which is what the source does for anything it does not fold.
 *
 * Copied rather than simplified to "it is already the provider name": the
 * datasheet's rows carry the *feed's* provider (`bedrock`, `fireworks_ai`,
 * `bedrock_mantle`), which is not always the config's, and the fold only works
 * if both sides are normalised the same way.
 */
export const normalizeProvider = (provider: string): string => {
  if (provider.includes("together")) return "together_ai";
  if (provider.includes("vertex_ai") || provider === "google-vertex") {
    return "vertex";
  }
  if (provider.includes("bedrock")) return "bedrock";
  if (provider.includes("cohere")) return "cohere";
  if (provider.includes("runwayml")) return "runway";
  if (provider.includes("fireworks_ai")) return "fireworks";
  if (provider.includes("github_copilot")) return "github_copilot";
  return provider;
};

/** `extractModelName` (`types.go:582`): drop everything up to the first `/`. */
export const extractModelName = (feedKey: string): string => {
  const index = feedKey.indexOf("/");
  return index >= 0 ? feedKey.slice(index + 1) : feedKey;
};

/** The one row out of several that fold onto a stored key. See the header. */
type FoldCandidate = {
  feedKey: string;
  entry: DatasheetEntry;
  /** The row's own provider already equals the stored provider. */
  exact: boolean;
};

/**
 * `pricingCandidate.beats` (`sync.go:107`): the row whose own provider matches
 * wins, otherwise the smaller feed key.
 */
const beats = (candidate: FoldCandidate, current: FoldCandidate): boolean => {
  if (candidate.exact !== current.exact) return candidate.exact;
  return candidate.feedKey < current.feedKey;
};

/**
 * The datasheet, folded onto the keys the gateway actually stores.
 *
 * Keyed `model|provider|mode`, the same string `makeKey` builds
 * (`types.go:471`), so the lookup below is one map hit and not a search.
 */
export const foldDatasheet = (datasheet: Datasheet): Map<string, FoldCandidate> => {
  const winners = new Map<string, FoldCandidate>();
  for (const [feedKey, entry] of Object.entries(datasheet)) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider =
      typeof entry.provider === "string" ? normalizeProvider(entry.provider) : "";
    const mode = typeof entry.mode === "string" ? entry.mode : "";
    const storedKey = `${extractModelName(feedKey)}|${provider}|${mode}`;
    const candidate: FoldCandidate = {
      feedKey,
      entry,
      exact: entry.provider === provider,
    };
    const current = winners.get(storedKey);
    if (current === undefined || beats(candidate, current)) {
      winners.set(storedKey, candidate);
    }
  }
  return winners;
};

/**
 * Whether the row would compute a non-zero cost for a normal chat request.
 *
 * A row with no standard rate at all is not priced, and neither is one whose
 * rates are present and zero. Anything that is not a number is ignored rather
 * than coerced: a string rate would be a feed defect worth failing on, not
 * something to guess at.
 */
export const hasNonZeroRate = (entry: DatasheetEntry): boolean =>
  STANDARD_RATE_FIELDS.some((field) => {
    const value = entry[field];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });

/** One candidate lookup: the exact map hit, then the lowercase retry. */
const lookup = (
  folded: Map<string, FoldCandidate>,
  name: string,
  provider: string,
  mode: string,
): FoldCandidate | undefined => {
  const hit = folded.get(`${name}|${provider}|${mode}`);
  if (hit !== undefined) return hit;
  const lower = name.toLowerCase();
  if (lower === name) return undefined;
  return folded.get(`${lower}|${provider}|${mode}`);
};

/**
 * `resolvePricing` (`cost.go:2479`) for one served name.
 *
 * Two levels of nesting, and the order is the whole of it:
 *
 * - **Outer, candidates**, in the gateway's order: the alias's `model_name`, the
 *   alias's `model_id`, then the name the caller sent.
 * - **Inner, modes**: chat, then responses (`chatResponsesFallbackMode`), each
 *   with the lowercase retry (`getBasePricing`, `:2582`).
 *
 * The first row **found** decides, exactly as `getBasePricing` returns on the
 * first map hit and never falls through to a later candidate once it has one.
 * That is the half that has to match: a check more permissive than the gateway
 * would report a model that bills at zero as fine. So the row found is judged by
 * `hasNonZeroRate` and an all-zero row is reported as `zero-rate` against the
 * name that found it, rather than the search continuing to a later candidate the
 * gateway would never have reached.
 */
export const resolveServedName = (
  folded: Map<string, FoldCandidate>,
  served: ServedName,
): CoverageResult => {
  const provider = normalizeProvider(served.provider);
  const candidates: Array<{ name: string; pricedBy: PricedBy }> = [];
  if (served.modelName) {
    candidates.push({ name: served.modelName, pricedBy: "alias-model-name" });
  }
  if (served.modelId) {
    candidates.push({ name: served.modelId, pricedBy: "alias-model-id" });
  }
  candidates.push({ name: served.name, pricedBy: "own-id" });

  const tried: string[] = [];
  for (const candidate of candidates) {
    for (const mode of PRICING_MODES) {
      const found = lookup(folded, candidate.name, provider, mode);
      if (found === undefined) continue;
      tried.push(`${candidate.name} [${mode}]`);
      if (hasNonZeroRate(found.entry)) {
        return {
          priced: true,
          served,
          pricedBy: candidate.pricedBy,
          resolvedName: candidate.name,
          mode,
        };
      }
      // Found, and every standard rate on it is zero. The gateway stopped here
      // and computed a cost of zero, so no later candidate can change the answer.
      return { priced: false, served, reason: "zero-rate", tried };
    }
  }

  return {
    priced: false,
    served,
    reason: "no-row",
    tried: candidates.map((candidate) => candidate.name),
  };
};

/**
 * The served names in a parsed `config.json`, in the order the file declares
 * them.
 *
 * A provider key's `models` array is the serve list (`docs/bifrost-model-aliases.md`);
 * the alias map on the same key is where a served name's `model_name` and
 * `model_id` come from. A name with no aliases entry is served raw and priced
 * from its own id only, which is the case this check exists to catch.
 *
 * Only `string` entries are read, and a `models` array that is not an array of
 * strings is skipped rather than guessed at: `config.test.ts` owns shape, and a
 * malformed file should fail there rather than produce a misleading report here.
 */
export const servedNames = (config: unknown): ServedName[] => {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const served: ServedName[] = [];
  for (const [provider, rawProvider] of Object.entries(
    record(record(config).providers),
  )) {
    const keys = record(rawProvider).keys;
    if (!Array.isArray(keys)) continue;
    for (const rawKey of keys) {
      const key = record(rawKey);
      const models = key.models;
      if (!Array.isArray(models)) continue;
      const aliases = record(key.aliases);
      for (const model of models) {
        if (typeof model !== "string") continue;
        const alias = record(aliases[model]);
        served.push({
          provider,
          name: model,
          ...(typeof alias.model_name === "string" && alias.model_name.trim()
            ? { modelName: alias.model_name }
            : {}),
          ...(typeof alias.model_id === "string" && alias.model_id.trim()
            ? { modelId: alias.model_id }
            : {}),
        });
      }
    }
  }
  return served;
};

/** The whole check, from a config document and a datasheet. */
export const checkCoverage = (config: unknown, datasheet: Datasheet): CoverageResult[] => {
  const folded = foldDatasheet(datasheet);
  return servedNames(config).map((served) => resolveServedName(folded, served));
};

/** The results that need somebody, which is the only thing an exit code reads. */
export const unpriced = (results: CoverageResult[]): CoverageResult[] =>
  results.filter((result): result is Extract<CoverageResult, { priced: false }> => !result.priced);
