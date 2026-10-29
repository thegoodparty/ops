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
    { keys: Array<{ models: string[] }>; network_config?: { base_url?: string } }
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
 * US-only inference, from the key's side. `config.json` decides what the
 * gateway will route; this file decides what a person's key may ask for, and a
 * key that names a model the gateway does not allow is a 404 or an
 * `AccessDenied` at request time. So the two files carry the same US-only
 * rules and the same classes, and `config.test.ts` pins the class set that the
 * exact-match test below then inherits.
 */
const US_BEDROCK_PREFIX = "us.";

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

  it("allows nothing outside the United States", () => {
    const template = loadTemplate();

    // A JSON-parsed template has no comments to check, so every string in it is
    // a value: `global.` anywhere is the worldwide profile named as a model.
    const strings: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(collect);
      }
    };
    collect(template);
    for (const value of strings) {
      assert.ok(
        !value.includes("global."),
        `the template carries "${value}", which names the worldwide profile; the gateway serves US-only inference`,
      );
    }

    for (const entry of providerConfigs(template)) {
      for (const model of entry.allowed_models) {
        if (entry.provider === "bedrock") {
          assert.ok(
            model.startsWith(US_BEDROCK_PREFIX),
            `${model} is not a us. inference profile; a bare or global id is not a US commitment`,
          );
        } else if (entry.provider === "fireworks") {
          assert.match(
            model,
            US_FIREWORKS_ROUTER,
            `${model} is not a US-only Fireworks router id; use accounts/fireworks/routers/<model>-us`,
          );
        }
      }
    }

    // The endpoint is the other half of the decision and lives in config.json,
    // because a template cannot override a provider's endpoint; the guard here
    // is that the template may not add one and quietly point a key elsewhere.
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

    // Decision 5: per-person budgets and rate limits are skipped for pass one,
    // because AWS and Fireworks already impose provider-level limits and a
    // number chosen before there is usage data can starve a person mid-task.
    // Coming back is a field in this file.
    for (const forbidden of ["budgets", "rate_limit"] as const) {
      assert.ok(
        !(forbidden in template),
        `the template must carry no ${forbidden} (decision 5)`,
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
