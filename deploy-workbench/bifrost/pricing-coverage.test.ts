import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { BIFROST_UPSTREAM_TAG } from "../bifrost-image";
import {
  BIFROST_PRICING_TAG,
  checkCoverage,
  extractModelName,
  foldDatasheet,
  hasNonZeroRate,
  normalizeProvider,
  resolveServedName,
  servedNames,
  unpriced,
  type Datasheet,
} from "./pricing-coverage";

/**
 * The coverage check, driven with rows a person can read.
 *
 * Every case below is one rule copied out of the pinned Bifrost tag, so the
 * assertions are the evidence that the copy is faithful rather than a
 * restatement of what this module happens to do. The source each case comes from
 * is named on the case.
 *
 * No rate appears in this file as a "real" rate: the numbers are 1 and 2, chosen
 * so `> 0` is unambiguous and so nothing here reads like a price for a model.
 */

/** A row, with the four standard rates defaulted to zero. */
const row = (overrides: Record<string, unknown> = {}) => ({
  provider: "bedrock",
  mode: "chat",
  input_cost_per_token: 0,
  output_cost_per_token: 0,
  ...overrides,
});

/** A row that would compute a non-zero cost. */
const pricedRow = (overrides: Record<string, unknown> = {}) =>
  row({ input_cost_per_token: 1, output_cost_per_token: 2, ...overrides });

describe("the datasheet fold", () => {
  it("keeps the row whose own provider matches, not the one that folded into it", () => {
    // `pricingCandidate.beats` (sync.go:107): `exact` wins over not-exact,
    // whatever the key order. `bedrock_mantle`s rows are folded onto `bedrock`
    // by `normalizeProvider`, and a `bedrock_mantle/x` key sorts before a
    // `bedrock/x` one, so key order alone would pick the wrong row.
    const folded = foldDatasheet({
      "bedrock_mantle/some-model": pricedRow({ provider: "bedrock_mantle" }),
      "bedrock/some-model": row({ provider: "bedrock" }),
    });
    const winner = folded.get("some-model|bedrock|chat");
    assert.ok(winner, "the two rows must fold onto one stored key");
    assert.equal(winner.feedKey, "bedrock/some-model");
    assert.equal(
      hasNonZeroRate(winner.entry),
      false,
      "the surviving row is the all-zero one, so the model bills at zero even though a priced row exists in the feed",
    );
  });

  it("breaks a tie between two equally exact rows on the smaller feed key", () => {
    // The second half of `beats`: exact vs exact falls to `modelKey < other.modelKey`.
    const folded = foldDatasheet({
      "z/some-model": row({ provider: "bedrock" }),
      "a/some-model": pricedRow({ provider: "bedrock" }),
    });
    assert.equal(folded.get("some-model|bedrock|chat")?.feedKey, "a/some-model");
  });

  it("folds the feed's own provider names onto the config's", () => {
    // `normalizeProvider` (types.go:477), for the two providers we configure.
    assert.equal(normalizeProvider("fireworks_ai"), "fireworks");
    assert.equal(normalizeProvider("bedrock"), "bedrock");
    assert.equal(normalizeProvider("bedrock_mantle"), "bedrock");
    assert.equal(normalizeProvider("fireworks"), "fireworks", "a config-side name maps to itself");
    assert.equal(normalizeProvider("some_new_provider"), "some_new_provider");
    // The one that would bite if the arms were narrowed further: `bedrock_mantle`
    // rows fold onto `bedrock` only because of the `includes` test.
    assert.equal(normalizeProvider("oss_bedrock_v2"), "bedrock");
  });

  it("drops everything up to the first slash of a feed key", () => {
    // `extractModelName` (types.go:582). Everything, not the last segment: a
    // Fireworks id keeps its own slashes.
    assert.equal(
      extractModelName("fireworks_ai/accounts/fireworks/models/x-us"),
      "accounts/fireworks/models/x-us",
    );
    assert.equal(extractModelName("bedrock/global.openai.gpt-6.2-sol"), "global.openai.gpt-6.2-sol");
    assert.equal(extractModelName("bare-key"), "bare-key");
  });

  it("ignores a feed key whose row is not an object", () => {
    const folded = foldDatasheet({ "bedrock/x": null as never, "bedrock/y": pricedRow() });
    assert.equal(folded.get("x|bedrock|chat"), undefined);
    assert.ok(folded.get("y|bedrock|chat"));
  });
});

describe("what counts as priced", () => {
  it("needs a non-zero rate, not merely a row", () => {
    // A row whose standard rates are all zero computes a cost of zero, which is
    // the same outcome as no row at all, so presence is not the question.
    assert.equal(hasNonZeroRate(row()), false);
    assert.equal(hasNonZeroRate(pricedRow()), true);
    assert.equal(hasNonZeroRate(row({ cache_read_input_token_cost: 1 })), true);
    assert.equal(hasNonZeroRate(row({ cache_creation_input_token_cost: 1 })), true);
  });

  it("does not count a batch, tier or priority rate as pricing a standard request", () => {
    // `computeTextCost` reads the standard tier's rates for a normal request; a
    // row carrying only a batch rate is zero for the shape we serve.
    assert.equal(
      hasNonZeroRate(
        row({ input_cost_per_token_batches: 1, output_cost_per_token_batches: 2 }),
      ),
      false,
    );
    assert.equal(hasNonZeroRate(row({ input_cost_per_token_above_272k_tokens: 1 })), false);
    assert.equal(hasNonZeroRate(row({ input_cost_per_token_priority: 1 })), false);
  });

  it("ignores a rate that is not a number", () => {
    assert.equal(hasNonZeroRate(row({ input_cost_per_token: "1" })), false);
    assert.equal(hasNonZeroRate(row({ input_cost_per_token: Number.NaN })), false);
  });
});

describe("resolving a served name", () => {
  const folded = foldDatasheet({
    "bedrock/global.anthropic.claude-sonnet-5-5": pricedRow({ provider: "bedrock" }),
    "fireworks_ai/accounts/fireworks/models/x-us": pricedRow({ provider: "fireworks_ai" }),
    "bedrock/only-responses": pricedRow({ provider: "bedrock", mode: "responses" }),
    "bedrock/mixed-case": pricedRow({ provider: "bedrock" }),
    "bedrock/zero-model": row({ provider: "bedrock" }),
  });

  it("prices a name served under its own id", () => {
    const result = resolveServedName(folded, {
      provider: "bedrock",
      name: "global.anthropic.claude-sonnet-5-5",
    });
    assert.equal(result.priced, true);
    assert.equal(result.priced && result.pricedBy, "own-id");
  });

  it("prices an alias off its model_name, which is the router case", () => {
    // `resolvePricing` tries the alias's `model_name` before the wire id, which
    // is what prices the Fireworks router: the router id has no row, the
    // catalog-named sibling does.
    const result = resolveServedName(folded, {
      provider: "fireworks",
      name: "worker-default",
      modelName: "accounts/fireworks/models/x-us",
      modelId: "accounts/fireworks/routers/x-us",
    });
    assert.equal(result.priced, true);
    assert.equal(result.priced && result.pricedBy, "alias-model-name");
    assert.equal(result.priced && result.resolvedName, "accounts/fireworks/models/x-us");
  });

  it("falls to the alias's model_id when model_name has no row", () => {
    const result = resolveServedName(folded, {
      provider: "bedrock",
      name: "some-alias",
      modelName: "no-such-model",
      modelId: "global.anthropic.claude-sonnet-5-5",
    });
    assert.equal(result.priced, true);
    assert.equal(result.priced && result.pricedBy, "alias-model-id");
  });

  it("prices a name whose row is only in the responses mode", () => {
    // `chatResponsesFallbackMode`: a chat request retries in responses mode.
    const result = resolveServedName(folded, { provider: "bedrock", name: "only-responses" });
    assert.equal(result.priced, true);
    assert.equal(result.priced && result.mode, "responses");
  });

  it("prices a name whose row is stored under a different case", () => {
    const result = resolveServedName(folded, { provider: "bedrock", name: "Mixed-Case" });
    assert.equal(result.priced, true);
  });

  it("reports a name the feed has never carried as no-row", () => {
    const result = resolveServedName(folded, {
      provider: "bedrock",
      name: "global.openai.brand-new-model",
    });
    assert.equal(result.priced, false);
    assert.equal(!result.priced && result.reason, "no-row");
  });

  it("stops at the first row the gateway would find, even when a later candidate is priced", () => {
    // The half that has to match: `getBasePricing` returns on the first map hit
    // and never falls through to the next candidate. Here the alias `model_name`
    // resolves to an all-zero row and the name's own id is priced. The gateway
    // reads the alias, computes zero, and never looks at the own id, so this
    // must report zero-rate and name only the candidate it actually used.
    const result = resolveServedName(folded, {
      provider: "bedrock",
      name: "global.anthropic.claude-sonnet-5-5",
      modelName: "zero-model",
    });
    assert.equal(result.priced, false);
    assert.equal(!result.priced && result.reason, "zero-rate");
    assert.deepEqual(!result.priced && result.tried, ["zero-model [chat]"]);
  });
  it("fails a name whose chat row is priced but whose responses request finds a zero row", () => {
    // The two APIs run the lookup from different starting modes and each finds
    // its own mode's row first, so a priced chat row says nothing about a
    // responses request. Checking one starting mode would report this name as
    // fine while responses billed at zero, which is the permissive error that
    // makes a checker worse than none.
    const split = foldDatasheet({
      "bedrock/split-model": pricedRow({ provider: "bedrock", mode: "chat" }),
      "bedrock/split-model-responses": row({ provider: "bedrock", mode: "responses" }),
    });
    // A name whose alias points at the zero responses row, while its own id is
    // priced in chat.
    const result = resolveServedName(split, {
      provider: "bedrock",
      name: "split-model",
      modelName: "split-model-responses",
    });
    assert.equal(
      result.priced,
      false,
      "the responses starting mode resolves the alias to a zero-rate row, so the name is not priced for responses requests",
    );
    assert.equal(!result.priced && result.reason, "zero-rate");
  });

  it("is priced when both starting modes resolve to a priced row", () => {
    const both = foldDatasheet({
      "bedrock/dual-model": pricedRow({ provider: "bedrock", mode: "chat" }),
    });
    // One chat row, and the responses request falls back to chat, which is the
    // `chatResponsesFallbackMode` rule; so both modes are priced off one row.
    const result = resolveServedName(both, { provider: "bedrock", name: "dual-model" });
    assert.equal(result.priced, true);
  });

  it("reports a name whose only row computes nothing as zero-rate", () => {
    const result = resolveServedName(folded, { provider: "bedrock", name: "zero-model" });
    assert.equal(result.priced, false);
    assert.equal(!result.priced && result.reason, "zero-rate");
  });
});

describe("the served set, from a config document", () => {
  const config = {
    providers: {
      bedrock: {
        keys: [
          {
            name: "k",
            models: ["global.a", "global.b"],
          },
        ],
      },
      fireworks: {
        keys: [
          {
            name: "k",
            models: ["named-us", "role"],
            aliases: {
              "named-us": { model_id: "routers/x-us", model_name: "named-us" },
              role: { model_id: "routers/x-us", model_name: "named-us" },
            },
          },
        ],
      },
    },
  };

  it("reads every served name, with the alias fields a name may carry", () => {
    assert.deepEqual(servedNames(config), [
      { provider: "bedrock", name: "global.a" },
      { provider: "bedrock", name: "global.b" },
      { provider: "fireworks", name: "named-us", modelName: "named-us", modelId: "routers/x-us" },
      { provider: "fireworks", name: "role", modelName: "named-us", modelId: "routers/x-us" },
    ]);
  });

  it("skips a blank alias field rather than treating it as a name", () => {
    const blank = {
      providers: { bedrock: { keys: [{ models: ["m"], aliases: { m: { model_name: "  " } } }] } },
    };
    assert.deepEqual(servedNames(blank), [{ provider: "bedrock", name: "m" }]);
  });

  it("survives a malformed document without inventing names", () => {
    assert.deepEqual(servedNames({}), []);
    assert.deepEqual(servedNames(null), []);
    assert.deepEqual(servedNames({ providers: { bedrock: { keys: "nope" } } }), []);
    assert.deepEqual(servedNames({ providers: { bedrock: { keys: [{ models: [1, "ok"] }] } } }), [
      { provider: "bedrock", name: "ok" },
    ]);
  });
});

describe("the check over the committed config.json", () => {
  const CONFIG = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "config.json"), "utf8"),
  ) as unknown;

  it("finds the served set the file actually declares", () => {
    // A count rather than a list: the list is `config.test.ts`'s job, and this
    // asserts only that the reader walks the same population the gateway serves.
    const served = servedNames(CONFIG);
    const fromFile = Object.values(
      (CONFIG as { providers: Record<string, { keys: Array<{ models?: string[] }> }> }).providers,
    ).flatMap((provider) => provider.keys.flatMap((key) => key.models ?? []));
    assert.deepEqual(
      served.map((entry) => entry.name).sort(),
      [...fromFile].sort(),
      "every served name in the file must be checked, and nothing else",
    );
    assert.ok(served.length > 0, "the committed file serves no models, so this check proves nothing");
  });

  it("reports the role aliases as resolving through their alias, not their own id", () => {
    // The shape the reader must preserve for the Fireworks names to be priced at
    // all. Driven with a synthetic feed so this needs no network.
    const fireworks = servedNames(CONFIG).filter((entry) => entry.provider === "fireworks");
    assert.ok(fireworks.length >= 2, "the Fireworks key serves at least its catalog name and a role alias");
    for (const entry of fireworks) {
      assert.ok(
        entry.modelName,
        `${entry.name} carries no model_name; served raw it would price off a router id the feed has no row for`,
      );
    }
  });
});

describe("the whole check", () => {
  it("is green when every served name resolves, and names nothing", () => {
    const config = { providers: { bedrock: { keys: [{ models: ["m"] }] } } };
    const datasheet: Datasheet = { "bedrock/m": pricedRow() };
    const results = checkCoverage(config, datasheet);
    assert.equal(results.length, 1);
    assert.deepEqual(unpriced(results), []);
  });

  it("names exactly the served models that do not resolve", () => {
    const config = {
      providers: { bedrock: { keys: [{ models: ["priced", "unpriced-one"] }] } },
    };
    const datasheet: Datasheet = { "bedrock/priced": pricedRow() };
    const results = checkCoverage(config, datasheet);
    assert.deepEqual(
      unpriced(results).map((result) => result.served.name),
      ["unpriced-one"],
    );
  });
});

describe("the tag these rules were read from", () => {
  it("is the tag the gateway runs", () => {
    // This module copies the lookup out of one tag's source. A bump is where the
    // copy has to be re-read, so the two literals must agree or the copy is a
    // claim about code we no longer run.
    assert.equal(
      BIFROST_PRICING_TAG,
      BIFROST_UPSTREAM_TAG,
      "pricing-coverage.ts was written against a different tag than bifrost-image.ts pins; re-read the lookup and this test",
    );
  });
});
