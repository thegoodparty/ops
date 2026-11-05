import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isManagedKeyDescription,
  VK_DESCRIPTION,
  VK_DESCRIPTION_MARKER,
} from "./vk-marker";

/**
 * The default virtual key shape, as data: step 1 of
 * `docs/bifrost-virtual-keys.md`, decision 5 ("The default key shape").
 *
 * The mint Lambda (step 3) reads this file, adds the per-call fields — the
 * caller's email as `name`, and the engineering team once item 14 creates it —
 * and `POST`s the result to `/api/governance/virtual-keys`. Nothing reads it
 * yet, which is why it can land on its own: the template is reviewable, and
 * the test below is what keeps it true.
 *
 * Why a file and not a code path: widening a model list is then a reviewed
 * change here plus a Pulumi apply, the same shape the group-sync job uses for
 * its allowlist, with no Lambda code change. A model allowed here but not in
 * `config.json` is a `404` or an `AccessDenied` at request time, so the two
 * lists are pinned to each other rather than maintained by hand.
 *
 * Decision 5's other two choices are asserted below rather than assumed:
 * `key_ids: ["*"]` on every provider entry, because a provider config with no
 * keys allows none and the gateway's keys are the deployment's; and no
 * `budgets` and no `rate_limit`, which were skipped until there is usage data
 * to choose a number from. Adding either later is a field in this file.
 */

const CONFIG_PATH = path.resolve(__dirname, "config.json");
const TEMPLATE_PATH = path.resolve(__dirname, "vk-mint-template.json");
const TEMPLATE_SOURCE = fs.readFileSync(TEMPLATE_PATH, "utf8");

/**
 * The marker is imported from `./vk-marker`, not redeclared here: it is the
 * janitor's only input (step 5) and the mint's (step 3), and three copies of
 * one string is how a key the mint created stops looking managed to the job
 * that deactivates it. This test's job is to pin the file to that constant.
 */

type ProviderConfigEntry = {
  provider: string;
  allowed_models: string[];
  key_ids: string[];
};

type Template = {
  description?: string;
  is_active?: boolean;
  provider_configs?: ProviderConfigEntry[];
};

type Config = {
  providers?: Record<
    string,
    {
      keys: Array<{
        models: string[];
        aliases?: Record<string, { model_id: string }>;
      }>;
      network_config?: { base_url?: string };
    }
  >;
};

/**
 * Parsed on demand so a malformed file fails a named test instead of crashing
 * the module while the test runner is collecting it.
 */
const loadTemplate = (): Template => JSON.parse(TEMPLATE_SOURCE) as Template;

const loadConfig = (): Config =>
  JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;

/**
 * Two residency rules, from the key's side. `config.json` decides what the
 * gateway will route; this file decides what a person's key may ask for, and a
 * key that names a model the gateway does not allow is a 404 or an
 * `AccessDenied` at request time. So the two files carry the same rules and the
 * same classes, and `config.test.ts` pins the class set that the exact-match
 * test below then inherits.
 *
 * Bedrock entries are `global.` cross-region inference profiles, the account's
 * convention since 2026-11-04 (about 10% cheaper than the `us.` geo profiles;
 * `docs/bifrost-gateway.md`, "Inference residency"). Fireworks entries are
 * US-only router ids on the US-only endpoint, unchanged and still enforced.
 */
const SERVED_BEDROCK_PREFIX = "global.";

/** A US-only Fireworks router id, and nothing else: not a global model id. */
const US_FIREWORKS_ROUTER = /^accounts\/fireworks\/routers\/[a-z0-9.-]+-us$/;

const providerConfigs = (template: Template): ProviderConfigEntry[] => {
  const entries = template.provider_configs;
  assert.ok(
    Array.isArray(entries) && entries.length > 0,
    "the template has no provider_configs; an empty list is deny-by-default and a key that can reach nothing",
  );
  return entries;
};

/** The models `config.json` allows for one provider, over all of its keys. */
const configModels = (config: Config, provider: string): string[] => {
  const configured = config.providers?.[provider];
  assert.ok(configured, `config.json has no ${provider} provider`);
  return [...new Set(configured.keys.flatMap((key) => key.models))];
};

describe("bifrost virtual-key template", () => {
  it("is valid JSON and carries the marker that identifies a Lambda-managed key", () => {
    assert.doesNotThrow(() => JSON.parse(TEMPLATE_SOURCE));
    const template = loadTemplate();
    const description = template.description;
    assert.ok(
      typeof description === "string" && description.length > 0,
      "the template has no description, which is where the janitor looks for the marker",
    );
    assert.ok(
      isManagedKeyDescription(description),
      `the description must start with "${VK_DESCRIPTION_MARKER}"; it is the only thing that marks a key as safe for the janitor to deactivate`,
    );
    // The whole description, not only the prefix: the template file and the
    // constant the mint also writes (`VK_DESCRIPTION`) are the same string, so
    // a mint that creates from this file produces exactly what a human reading
    // the dashboard expects.
    assert.equal(
      description,
      VK_DESCRIPTION,
      "the template's description drifted from vk-marker.ts's VK_DESCRIPTION",
    );
    // The key is created active. A template that created a deactivated key
    // would mint a key that authenticates nowhere.
    assert.equal(template.is_active, true);
  });

  it("allows a global Bedrock profile or a US-only Fireworks router, and nothing else", () => {
    const template = loadTemplate();

    for (const entry of providerConfigs(template)) {
      for (const model of entry.allowed_models) {
        if (entry.provider === "bedrock") {
          // The account's Bedrock convention is a `global.` cross-region
          // inference profile, not a `us.` geo profile and not a bare id. A
          // bare id would not be a profile at all, and several of these models
          // have no in-region invocation.
          assert.ok(
            model.startsWith(SERVED_BEDROCK_PREFIX),
            `${model} is not a global. inference profile; the gateway serves global profiles, and a us. or bare id is not one`,
          );
          assert.ok(
            !model.startsWith("us."),
            `${model} is a us. geo profile; those survive only in transitionalInvokeIds while the fleet rolls over`,
          );
        } else if (entry.provider === "fireworks") {
          // A key alias is a name that resolves to a router; what the provider
          // is sent, and so what residency depends on, is the target.
          const aliases = Object.assign(
            {},
            ...(loadConfig().providers?.fireworks?.keys ?? []).map((key) => key.aliases ?? {}),
          ) as Record<string, { model_id: string }>;
          assert.match(
            aliases[model]?.model_id ?? model,
            US_FIREWORKS_ROUTER,
            `${model} is not a US-only Fireworks router id, or an alias of one; use accounts/fireworks/routers/<model>-us`,
          );
        }
      }
    }

    // The Fireworks endpoint is still the other half of that provider's
    // decision and lives in config.json, because a template cannot override a
    // provider's endpoint; the guard here is that the template may not add one
    // and quietly point a key elsewhere.
    const config = loadConfig();
    for (const [provider, configured] of Object.entries(config.providers ?? {})) {
      if (provider === "fireworks") continue;
      assert.ok(
        configured.network_config?.base_url === undefined,
        `${provider} carries a base_url in config.json; only the Fireworks endpoint is a reviewed decision`,
      );
    }
  });

  it("allows exactly the models config.json allows, provider for provider", () => {
    const template = loadTemplate();
    const config = loadConfig();
    const entries = providerConfigs(template);

    const byProvider = new Map(entries.map((entry) => [entry.provider, entry]));
    assert.equal(
      byProvider.size,
      entries.length,
      "the template names one provider more than once",
    );

    // Both directions: a provider missing here narrows a person's access, and
    // one that config.json does not have is a key Bifrost cannot route.
    assert.deepEqual(
      [...byProvider.keys()].sort(),
      Object.keys(config.providers ?? {}).sort(),
      "the template's providers drifted from config.json's",
    );

    for (const [provider, entry] of byProvider) {
      assert.ok(
        Array.isArray(entry.allowed_models) && entry.allowed_models.length > 0,
        `${provider} allows no models; empty is deny-by-default`,
      );
      assert.deepEqual(
        [...entry.allowed_models].sort(),
        configModels(config, provider).sort(),
        `${provider}'s model list drifted from config.json; a model in one and not the other is a 404 or an AccessDenied at runtime`,
      );
      // "All Bedrock" is exactly the widening decision 5 exists to avoid, and
      // config.json already refuses `*` for the same reason.
      assert.ok(
        !entry.allowed_models.includes("*"),
        `${provider} must name models, not "*"`,
      );
    }
  });

  it("allows every alias name on the provider whose key declares it, and on no other", () => {
    // The exact-match test above already compares the template to config.json's
    // whole `models` list, aliases included. This names the provider, so moving
    // an alias to another provider is one reviewed change in both files, and
    // pins the two role names gp-pi relies on.
    const config = loadConfig();
    const declared = new Map<string, string[]>();
    for (const [provider, configured] of Object.entries(config.providers ?? {})) {
      declared.set(provider, configured.keys.flatMap((key) => Object.keys(key.aliases ?? {})));
    }
    const entries = providerConfigs(loadTemplate());
    for (const name of ["coordinator-default", "worker-default"]) {
      assert.deepEqual(
        [...declared].filter(([, names]) => names.includes(name)).map(([provider]) => provider),
        ["fireworks"],
        `${name} must be declared by exactly one provider key, fireworks`,
      );
    }
    for (const entry of entries) {
      for (const [provider, names] of declared) {
        for (const name of names) {
          assert.equal(
            entry.allowed_models.includes(name),
            entry.provider === provider,
            `alias ${name} is declared on ${provider}; the template must allow it there and nowhere else (checked on ${entry.provider})`,
          );
        }
      }
    }
  });

  it("uses the deployment's provider keys, with no budgets, rate limit or per-person fields", () => {
    const template = loadTemplate();
    for (const entry of providerConfigs(template)) {
      // Decision 5: a provider config with no keys allows none, so the entry
      // names the keys explicitly. `"*"` means "use the provider's keys" —
      // the deployment's, not the person's.
      assert.deepEqual(
        entry.key_ids,
        ["*"],
        `${entry.provider} must use the deployment's provider keys; no keys allows none`,
      );
    }

    // Per-person budgets and rate limits are deliberately not here, and the
    // reason changed with `docs/bifrost-reconciler.md` (decisions 12 and 13)
    // without changing this assertion. They come back as per-person overrides
    // in `governance-overrides.json`, not as a template field: because the
    // reconciler converges every existing key to template plus override, a
    // value in the template is not "applies to new keys", it is "applies to
    // the whole fleet on the next tick". A fleet-wide limit introduced by one
    // line here is exactly the silent default decision 12 refuses, and a
    // budget chosen before there is usage data is the guess #404 was right to
    // defer. Per-key budgets are back now that the log store has a quarter of
    // per-request cost data; they go in an override, naming the people they
    // apply to.
    for (const forbidden of ["budgets", "rate_limit"] as const) {
      assert.ok(
        !(forbidden in template),
        `the template must carry no ${forbidden}: it would apply to the whole fleet on the next reconcile, and a limit belongs in a per-person override (docs/bifrost-reconciler.md decisions 12 and 13)`,
      );
    }

    // The per-call fields belong to the Lambda, not the file: one name in a
    // shared template is one name for everyone, and Bifrost's unique index on
    // the key name would hand the first caller's key to the second.
    assert.ok(
      !("name" in template),
      "the template must not carry a name; it is the caller's email, set per mint",
    );
  });
});
