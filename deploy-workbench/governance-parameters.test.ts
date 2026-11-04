import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES,
  BIFROST_CONFIG_PARAMETER_NAME,
} from "./ecs";
import {
  GOVERNANCE_OVERRIDES_PARAMETER_NAME,
  GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES,
  GOVERNANCE_OVERRIDES_PATH,
  RECONCILER_PARAMETER_NAMES,
  VK_MINT_TEMPLATE_PARAMETER_NAME,
  parameterValue,
  readGovernanceOverrides,
  readVkMintTemplate,
} from "./governance-parameters";
import {
  composeGovernanceDesiredState,
  desiredStateFor,
  parseBifrostDuration,
  validateGovernanceOverrides,
  checkGovernanceOverrides,
  formatGovernanceProblems,
  type GovernanceBudget,
  type GovernanceOverrides,
  type GovernanceProviderConfig,
} from "./bifrost/governance-desired-state";

/**
 * Step 2 of `docs/bifrost-reconciler.md`: the governance desired state, its
 * parameter, and the validation that fails an apply rather than a tick.
 *
 * The plan names what this test has to prove, and each is a `describe` below:
 *
 * - a changed budget converges on a fake key, and an unchanged one produces no
 *   write — the merge half, `composeGovernanceDesiredState`;
 * - the shape half of the validation refuses every case decision 10 lists: an
 *   unknown field, a malformed budget, a duplicate `reset_duration`, an
 *   `inherit` anywhere it cannot be honoured, and (the one the plan adds here)
 *   an email that is not lowercase or is not a member;
 * - the documents are reviewable and fit: the two committed files parse, their
 *   published values stay under the standard tier, and the parameter names are
 *   the two the plan names.
 *
 * The membership half needs a directory, so `npm test` drives its logic with a
 * literal member set and the real read lives in
 * `scripts/preflight-governance.ts`; that script's own test covers the wiring,
 * the failure text and the fail-closed direction.
 *
 * One rule this file deliberately does not invent: no assertion on the
 * *content* of the overrides document beyond validity. It is empty of people
 * today on purpose — a budget chosen before there is usage data is the guess
 * #404 was right to refuse — and a test that pinned `jeff@goodparty.org` would
 * make adding the first real override a two-file change for no reason.
 */

const TEMPLATE = JSON.parse(readVkMintTemplate()) as {
  provider_configs: GovernanceProviderConfig[];
  [key: string]: unknown;
};

/** The template's provider list, which is the inherited field in most cases. */
const TEMPLATE_PROVIDERS = TEMPLATE.provider_configs;

const override = (value: unknown): GovernanceOverrides =>
  value as GovernanceOverrides;

/** The validation problems for one override, keyed to that person. */
const problemsFor = (value: unknown, isMember?: (email: string) => boolean) =>
  validateGovernanceOverrides(
    { "someone@goodparty.org": value },
    isMember ? { isMember } : {},
  );

const messages = (value: unknown, isMember?: (email: string) => boolean) =>
  problemsFor(value, isMember).map((problem) => problem.message);

describe("the merge, field by field (decision 9)", () => {
  it("keeps every template field an override does not name", () => {
    const composed = composeGovernanceDesiredState(TEMPLATE, {
      budgets: [{ max_limit: 250, reset_duration: "1M" }],
    });

    assert.deepEqual(
      composed.provider_configs,
      TEMPLATE_PROVIDERS,
      "a budget-only override must not drop the model policy",
    );
    assert.equal(composed.description, TEMPLATE.description);
    assert.equal(composed.is_active, TEMPLATE.is_active);
    assert.deepEqual(composed.budgets, [
      { max_limit: 250, reset_duration: "1M" },
    ]);
  });

  it("replaces the whole provider list when an override names it, and merges nothing", () => {
    // A replacement set on the wire: an override that narrows one provider is
    // the whole list it means, not the template's list with one entry edited.
    // Anything else would make "narrow bedchrock's models" silently keep every
    // other template entry the author never mentioned.
    const narrowed: GovernanceProviderConfig[] = [
      {
        provider: "bedrock",
        allowed_models: ["us.anthropic.claude-sonnet-5-5"],
        key_ids: ["*"],
      },
    ];
    const composed = composeGovernanceDesiredState(TEMPLATE, {
      provider_configs: narrowed,
    });
    assert.deepEqual(composed.provider_configs, narrowed);
    assert.notDeepEqual(composed.provider_configs, TEMPLATE_PROVIDERS);
  });

  it('treats "inherit" as the template value, and as the same thing as absent', () => {
    const inherited = composeGovernanceDesiredState(TEMPLATE, {
      provider_configs: "inherit",
    });
    const absent = composeGovernanceDesiredState(TEMPLATE, {});
    assert.deepEqual(inherited, absent);
    assert.deepEqual(inherited.provider_configs, TEMPLATE_PROVIDERS);
  });

  it("never carries a metadata key or a sentinel onto the wire", () => {
    const composed = composeGovernanceDesiredState(TEMPLATE, {
      $comment: "a note that is not a field",
      provider_configs: "inherit",
    } as never);
    assert.ok(!("$comment" in composed));
    assert.ok(!Object.values(composed).includes("inherit" as never));
    for (const value of Object.values(composed)) {
      assert.notEqual(value, "inherit");
    }
  });

  it("composes the template alone for somebody with no override", () => {
    assert.deepEqual(
      composeGovernanceDesiredState(TEMPLATE),
      composeGovernanceDesiredState(TEMPLATE, undefined),
    );
  });

  it("looks an override up by lowercase email, whichever case the caller holds", () => {
    const overrides = override({
      "someone@goodparty.org": {
        budgets: [{ max_limit: 100, reset_duration: "1M" }],
      },
    });
    const fromLower = desiredStateFor(TEMPLATE, overrides, "someone@goodparty.org");
    const fromMixed = desiredStateFor(TEMPLATE, overrides, "SomeOne@GoodParty.org");
    assert.deepEqual(fromMixed, fromLower);
    assert.deepEqual(fromLower.budgets, [{ max_limit: 100, reset_duration: "1M" }]);
  });

  it("converges a changed budget and leaves an unchanged one alone", () => {
    // The plan's step 2 wording, as far as a pure function can carry it: the
    // same desired state compares equal, a retuned limit does not. Step 3's
    // diff is what turns this into "no PUT"; what this pins is that the desired
    // state is stable enough for a diff to be meaningful.
    const overrides = override({
      "someone@goodparty.org": {
        budgets: [{ max_limit: 250, reset_duration: "1M" }],
      },
    });
    const first = desiredStateFor(TEMPLATE, overrides, "someone@goodparty.org");
    const again = desiredStateFor(TEMPLATE, overrides, "someone@goodparty.org");
    assert.deepEqual(first, again);

    const retuned = desiredStateFor(
      TEMPLATE,
      override({
        "someone@goodparty.org": {
          budgets: [{ max_limit: 300, reset_duration: "1M" }],
        },
      }),
      "someone@goodparty.org",
    );
    const [before] = first.budgets as GovernanceBudget[];
    const [after] = retuned.budgets as GovernanceBudget[];
    assert.equal(before.max_limit, 250);
    assert.equal(after.max_limit, 300);
    assert.equal(after.reset_duration, before.reset_duration, "the budget's identity is its reset duration");
  });
});

describe("durations are Bifrost's, not an approximation of them", () => {
  /** The table is the gateway's own `ParseDuration`, at `transports/v2.4.0`. */
  const ACCEPTED: Array<[string, number]> = [
    // Bifrost's suffixed forms, multiplied out of a bare number.
    ["1d", 24 * 60 * 60 * 1000],
    ["2d", 2 * 24 * 60 * 60 * 1000],
    ["1w", 7 * 24 * 60 * 60 * 1000],
    ["1M", 30 * 24 * 60 * 60 * 1000],
    // The suffixed branch parses its prefix with `time.ParseDuration` too, so a
    // fractional month is accepted — 1.5 * 30 days. Not a shape this deployment
    // uses, and worth pinning because it is the sort of thing a hand-written
    // validator refuses and the gateway does not.
    ["1.5M", 45 * 24 * 60 * 60 * 1000],
    ["1Q", 90 * 24 * 60 * 60 * 1000],
    ["1Y", 365 * 24 * 60 * 60 * 1000],
    // Go's forms, which are what a suffix-less duration falls through to.
    ["30s", 30 * 1000],
    ["5m", 5 * 60 * 1000],
    ["1h", 60 * 60 * 1000],
    ["1h30m", 90 * 60 * 1000],
    ["500ms", 500],
  ];

  for (const [duration, milliseconds] of ACCEPTED) {
    it(`accepts "${duration}"`, () => {
      assert.equal(parseBifrostDuration(duration), milliseconds);
    });
  }

  const REFUSED = [
    "", // empty is Bifrost's own first check
    "1q", // a lowercase q is not a quarter; the pinned tests say so explicitly
    "q",
    "M", // a bare suffix with no multiplier
    "1x",
    "1M1d", // one suffix, not a Go-style compound
    "five minutes",
    "5", // no unit at all
  ];

  for (const duration of REFUSED) {
    it(`refuses "${duration}"`, () => {
      assert.equal(parseBifrostDuration(duration), undefined);
    });
  }

  it("refuses a non-positive duration as a budget window, not only as unparseable", () => {
    // `ParseDuration` accepts "0"; the budget's `BeforeSave` refuses `d <= 0`.
    // Both refusals are the same answer here.
    assert.equal(parseBifrostDuration("0"), 0);
    assert.ok(
      messages({ budgets: [{ max_limit: 10, reset_duration: "0" }] }).some((m) =>
        m.includes("positive duration"),
      ),
    );
    assert.ok(
      messages({ budgets: [{ max_limit: 10, reset_duration: "-1h" }] }).some((m) =>
        m.includes("positive duration"),
      ),
    );
  });
});

describe("the validation refuses what the gateway would refuse later (decision 10)", () => {
  it("accepts the three shapes the document's comment shows", () => {
    assert.deepEqual(
      problemsFor({ budgets: [{ max_limit: 250, reset_duration: "1M" }] }),
      [],
    );
    assert.deepEqual(
      problemsFor({
        rate_limit: { request_max_limit: 600, request_reset_duration: "5m" },
      }),
      [],
    );
    assert.deepEqual(
      problemsFor({
        provider_configs: [
          {
            provider: "bedrock",
            allowed_models: ["us.anthropic.claude-sonnet-5-5"],
            key_ids: ["*"],
          },
        ],
        calendar_aligned: true,
      }),
      [],
    );
    assert.deepEqual(problemsFor({ provider_configs: "inherit" }), []);
    assert.deepEqual(problemsFor({}), []);
  });

  it("refuses an override that names a key the merge does not understand", () => {
    // A misspelled field is the one that does not announce itself: a merge that
    // only copies fields it knows would silently drop it, and the person would
    // find out when their limit never applied.
    const found = problemsFor({ budget: [{ max_limit: 250, reset_duration: "1M" }] });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "someone@goodparty.org.budget");
    assert.match(found[0].message, /is not a field of the desired state/);
  });

  it("refuses a malformed budget, in each of the three ways it can be malformed", () => {
    const nonNumeric = problemsFor({
      budgets: [{ max_limit: "250", reset_duration: "1M" }],
    });
    assert.ok(nonNumeric.some((p) => p.path.endsWith("max_limit")));

    const negative = problemsFor({
      budgets: [{ max_limit: -5, reset_duration: "1M" }],
    });
    assert.ok(negative.some((p) => p.path.endsWith("max_limit")));

    const badDuration = problemsFor({
      budgets: [{ max_limit: 250, reset_duration: "1 month" }],
    });
    assert.ok(badDuration.some((p) => p.path.endsWith("reset_duration")));

    const notAnArray = problemsFor({ budgets: { max_limit: 250 } });
    assert.ok(notAnArray.some((p) => p.message.includes("array of budgets")));
  });

  it("refuses a duplicate reset_duration, because the reconciler matches by it", () => {
    const found = problemsFor({
      budgets: [
        { max_limit: 100, reset_duration: "1M" },
        { max_limit: 50, reset_duration: "1M" },
      ],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "someone@goodparty.org.budgets[1].reset_duration");
    assert.match(found[0].message, /duplicates/);
  });

  it('refuses "inherit" anywhere it cannot be honoured', () => {
    // Top level, on a field that already inherits by being absent.
    const topLevel = problemsFor({ budgets: "inherit" });
    assert.ok(topLevel.some((p) => p.path.endsWith(".budgets")));

    // Inside a provider config, a budget and a rate limit: there is nothing
    // inside any of them to inherit from.
    const provider = problemsFor({
      provider_configs: [{ provider: "bedrock", allowed_models: "inherit" }],
    });
    assert.ok(provider.some((p) => /inherit/.test(p.message)));

    const budget = problemsFor({
      budgets: [{ max_limit: "inherit", reset_duration: "1M" }],
    });
    assert.ok(budget.some((p) => /inherit/.test(p.message)));

    const rateLimit = problemsFor({
      rate_limit: { request_max_limit: "inherit" },
    });
    assert.ok(rateLimit.some((p) => /inherit/.test(p.message)));
  });

  it("refuses a budget id, which would be written and never read", () => {
    const found = problemsFor({
      budgets: [{ id: "budget-1", max_limit: 250, reset_duration: "1M" }],
    });
    assert.equal(found.length, 1);
    assert.match(found[0].message, /matched by reset_duration/);
  });

  it("refuses a rate limit that cannot mean anything", () => {
    // On the wire an empty rate_limit removes the key's limit, so an override
    // that names nothing must not be read as "remove it".
    assert.ok(
      messages({ rate_limit: {} }).some((m) => m.includes("removes the key's limit")),
    );
    // A maximum with no window, and a window with no maximum, are both refused
    // by `TableRateLimit.BeforeSave`; the same rule here is one step earlier.
    assert.ok(
      messages({ rate_limit: { request_max_limit: 600 } }).some((m) =>
        m.includes("required when request_max_limit"),
      ),
    );
    assert.ok(
      messages({ rate_limit: { request_reset_duration: "5m" } }).some((m) =>
        m.includes("no request_max_limit"),
      ),
    );
    assert.ok(
      messages({ rate_limit: { request_max_limit: 0, request_reset_duration: "5m" } }).some(
        (m) => m.includes("greater than zero"),
      ),
    );
  });

  it("refuses a provider list that names one provider twice", () => {
    const found = problemsFor({
      provider_configs: [
        { provider: "bedrock", key_ids: ["*"] },
        { provider: "bedrock", key_ids: ["*"] },
      ],
    });
    assert.equal(found.length, 1);
    assert.equal(
      found[0].path,
      "someone@goodparty.org.provider_configs[1].provider",
    );
  });

  it("refuses a provider config with no provider, an empty model list, or a nested limit", () => {
    assert.ok(
      messages({ provider_configs: [{ key_ids: ["*"] }] }).some((m) =>
        m.includes("must name the provider"),
      ),
    );
    assert.ok(
      messages({
        provider_configs: [{ provider: "bedrock", allowed_models: [] }],
      }).some((m) => m.includes("non-empty array")),
    );
    // Per-provider limits are not in this plan; a config that names one is a
    // mechanism nobody wrote, not a value silently ignored.
    assert.ok(
      messages({
        provider_configs: [
          { provider: "bedrock", budgets: [{ max_limit: 1, reset_duration: "1M" }] },
        ],
      }).some((m) => m.includes("is not a field of a provider config")),
    );
  });

  it("refuses an email that is not an email, and one that is not lowercase", () => {
    const notAnEmail = validateGovernanceOverrides({ "jeff": {} });
    assert.equal(notAnEmail.length, 1);
    assert.match(notAnEmail[0].message, /not an email address/);

    const notLowercase = validateGovernanceOverrides({ "Jeff@goodparty.org": {} });
    assert.equal(notLowercase.length, 1);
    assert.match(notLowercase[0].message, /not lowercase/);
  });

  it("refuses an email that is not in the Engineers group, when a member set is given", () => {
    const members = new Set(["someone@goodparty.org"]);
    assert.deepEqual(
      validateGovernanceOverrides(
        { "someone@goodparty.org": { calendar_aligned: true } },
        { isMember: (email) => members.has(email) },
      ),
      [],
    );

    const found = validateGovernanceOverrides(
      { "departed@goodparty.org": {} },
      { isMember: (email) => members.has(email) },
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "departed@goodparty.org");
    assert.match(found[0].message, /not in the Engineers group/);
  });

  it("allows only one metadata field, and only at the top level", () => {
    assert.deepEqual(
      validateGovernanceOverrides({ $comment: ["a note", "another"] }),
      [],
    );
    const unknownMetadata = validateGovernanceOverrides({ $schema: "x" });
    assert.equal(unknownMetadata.length, 1);
    assert.match(unknownMetadata[0].message, /not a metadata field/);

    // Inside an override it is not a field of the merge, so it would reach the
    // gateway or be dropped silently; both are refused.
    const nested = validateGovernanceOverrides({
      "someone@goodparty.org": { $comment: "note" },
    });
    assert.equal(nested.length, 1);
    assert.match(nested[0].message, /belongs at the top level/);
  });

  it("refuses a document that is not an object keyed by email", () => {
    assert.equal(validateGovernanceOverrides([]).length, 1);
    assert.equal(validateGovernanceOverrides("nope").length, 1);
    assert.equal(validateGovernanceOverrides(null).length, 1);
    assert.equal(checkGovernanceOverrides("{ not json").length, 1);
  });

  it("reports every problem at once, at a path a reviewer can find", () => {
    const found = validateGovernanceOverrides({
      "Bad@goodparty.org": { budget: [] },
      "someone@goodparty.org": { budgets: [{ max_limit: -1, reset_duration: "1q" }] },
    });
    const paths = found.map((p) => p.path);
    assert.ok(paths.includes("Bad@goodparty.org"));
    assert.ok(paths.includes("Bad@goodparty.org.budget"));
    assert.ok(paths.includes("someone@goodparty.org.budgets[0].max_limit"));
    assert.ok(paths.includes("someone@goodparty.org.budgets[0].reset_duration"));

    // The formatter is what a failed apply prints, so it names every path.
    const text = formatGovernanceProblems(found);
    for (const problemPath of paths) {
      assert.ok(text.includes(problemPath), `${problemPath} is missing from the message`);
    }
  });
});

describe("the committed documents and their parameters", () => {
  it("uses the two parameter names the plan names, beside /bifrost/config", () => {
    assert.equal(VK_MINT_TEMPLATE_PARAMETER_NAME, "/bifrost/vk-mint-template");
    assert.equal(GOVERNANCE_OVERRIDES_PARAMETER_NAME, "/bifrost/governance-overrides");
    assert.equal(BIFROST_CONFIG_PARAMETER_NAME, "/bifrost/config");
    assert.deepEqual([...RECONCILER_PARAMETER_NAMES], [
      VK_MINT_TEMPLATE_PARAMETER_NAME,
      GOVERNANCE_OVERRIDES_PARAMETER_NAME,
    ]);
    // The override name must not be the template's, and neither may collide with
    // the config store's own parameter.
    assert.notEqual(VK_MINT_TEMPLATE_PARAMETER_NAME, GOVERNANCE_OVERRIDES_PARAMETER_NAME);
    for (const name of RECONCILER_PARAMETER_NAMES) {
      assert.notEqual(name, BIFROST_CONFIG_PARAMETER_NAME);
    }
  });

  it("publishes both documents as valid JSON with no secret in them, and no metadata", () => {
    for (const text of [readVkMintTemplate(), readGovernanceOverrides()]) {
      assert.doesNotThrow(() => JSON.parse(text));
      assert.doesNotThrow(() => parameterValue(text));
      // A credential in a `String` parameter is readable by anything that can
      // call `GetParameter`; the template's values are refs (`env.NAME`) and the
      // overrides document is budgets and model lists.
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/);
      assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/);
    }

    // `$comment` is the document's own documentation, not desired state: it is
    // stripped before publication, so the published value carries no metadata
    // key at all and the byte check measures what is actually written.
    const published = JSON.parse(
      parameterValue(readGovernanceOverrides()),
    ) as Record<string, unknown>;
    for (const field of ["$comment", "$schema"]) {
      assert.ok(!(field in published), `${field} reached the published parameter`);
    }
    assert.ok(
      !parameterValue(readGovernanceOverrides()).includes("$comment"),
      "the published overrides value still carries the $comment block",
    );
  });

  it("keeps each document under the standard tier's 4 KiB, measured as published", () => {
    assert.equal(GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES, 4096);
    // The same ceiling `ecs.ts` records for `config.json`, and the reason the
    // two governance documents are two parameters and not one.
    assert.equal(
      GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES,
      BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES,
    );

    for (const [name, text] of [
      [VK_MINT_TEMPLATE_PARAMETER_NAME, readVkMintTemplate()],
      [GOVERNANCE_OVERRIDES_PARAMETER_NAME, readGovernanceOverrides()],
    ] as const) {
      const bytes = Buffer.byteLength(parameterValue(text), "utf8");
      assert.ok(
        bytes < GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES,
        `${name} is ${bytes} bytes and the standard tier holds ${GOVERNANCE_PARAMETER_STANDARD_TIER_BYTES}; past that the parameter needs tier: "Advanced"`,
      );
    }

    // And the room the plan budgets for: the committed document is a few bytes
    // of `{}` published, so an empty document is not eating the room a
    // per-person override needs. 3 KiB is the plan's working figure.
    const empty = Buffer.byteLength(parameterValue(readGovernanceOverrides()), "utf8");
    assert.ok(
      empty < 512,
      `the empty overrides document is ${empty} bytes published; the $comment block is not being stripped`,
    );
  });

  it("keeps the template's own shape tests true after the repository move", () => {
    // The template file did not change in this step; what changed is who reads
    // it. `vk-mint-template.test.ts` still owns its content, and this asserts
    // the two tests read the same bytes so a move cannot silently desynchronise
    // them.
    const direct = fs.readFileSync(
      path.resolve(__dirname, "bifrost/vk-mint-template.json"),
      "utf8",
    );
    assert.equal(readVkMintTemplate(), direct);
    assert.equal(
      path.resolve(__dirname, "bifrost/governance-overrides.json"),
      GOVERNANCE_OVERRIDES_PATH,
    );
  });

  it("validates the committed overrides document, shape and all", () => {
    // No member set here: `npm test` holds no credentials by design
    // (`deploy.yml` runs the suite in the credential-free job). The membership
    // half runs in the deploy workflow.
    assert.deepEqual(checkGovernanceOverrides(readGovernanceOverrides()), []);
  });

  it("keeps the overrides document's leading comment, so it explains its own rules", () => {
    // JSON has no comments, and a document that cannot state its merge rules
    // gets them restated in three files and drifts. `$comment` is where they
    // live; it is stripped before the parameter is written, which is what makes
    // the paragraph free.
    const parsed = JSON.parse(readGovernanceOverrides()) as { $comment?: unknown };
    assert.ok(parsed.$comment, "the document keeps its $comment block");
    const lines = Array.isArray(parsed.$comment)
      ? parsed.$comment
      : [parsed.$comment];
    const text = lines.join("\n");
    for (const phrase of [
      "field by field",
      "inherit",
      "lowercase",
      "Durations",
      "calendar_aligned",
      "rate limit",
    ]) {
      assert.ok(
        text.toLowerCase().includes(phrase.toLowerCase()),
        `the document's own explanation no longer mentions "${phrase}"`,
      );
    }
  });
});
