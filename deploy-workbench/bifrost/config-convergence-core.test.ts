import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  convergeConfig,
  differingClientFields,
  differingKeyFields,
  differingProviderFields,
  liveConfigDesiredState,
  type ConfigGateway,
} from "./config-convergence-core";
import { JanitorFailure } from "./vk-janitor-core";
import {
  BIFROST_BOOT_ONLY_PATHS,
  BIFROST_LIVE_PATHS,
  bifrostConfigClaimedLeaves,
  readBifrostConfig,
} from "../ecs";

/**
 * Step 4's config half: the live subset of `config.json`, diffed against a fake
 * gateway and applied with the request shapes Bifrost's update routes actually
 * take.
 *
 * The acceptance criteria the plan names for this half, each a test below:
 *
 * 1. An edit to the file's live subset reaches the running gateway — one `PUT`
 *    carrying the whole section, because a fragment is how the client config's
 *    other fields get cleared.
 * 2. An unchanged file produces **no** `PUT` at all: diff before write, and
 *    `changed: 0`.
 * 3. The `PUT`, where there is one, is safe against the two replacement-set
 *    traps: `client_config` is sent complete from the server's own view, and a
 *    provider key's body carries only the fields that differed — so a key's
 *    `value` never appears in a request.
 * 4. A section this loop cannot converge (`governance`, which holds `env.`
 *    references only the task can resolve) is reported as skipped rather than
 *    silently dropped, and a provider the gateway does not have is skipped
 *    rather than created.
 * 5. A refused write fails the run, so the deploy's poll cannot read a
 *    half-converged gateway as a converged one.
 */

const CONFIG = {
  $schema: "https://www.getbifrost.ai/schema",
  source_of_truth: "config.json",
  client: {
    enable_logging: true,
    disable_content_logging: true,
    log_retention_days: 90,
  },
  governance: {
    auth_config: {
      admin_username: "env.BIFROST_ADMIN_USERNAME",
      admin_password: "env.BIFROST_ADMIN_PASSWORD",
    },
  },
  providers: {
    fireworks: {
      network_config: { base_url: "https://us.api.fireworks.ai/inference" },
      keys: [
        {
          name: "fireworks-primary",
          value: "env.FIREWORKS_API_KEY",
          models: ["m-1", "m-2"],
          aliases: { "worker-default": { model_id: "m-1", model_name: "m-1" } },
          weight: 1,
        },
      ],
    },
    bedrock: {
      keys: [
        {
          name: "bedrock-task-role",
          value: "",
          models: ["us.anthropic.claude-sonnet-5-5"],
          weight: 1,
          bedrock_key_config: { region: "us-west-2" },
        },
      ],
      prompt_cache: { auto_inject: true },
    },
  },
};

const configText = (): string => JSON.stringify(CONFIG);

/** The gateway's view of the file, which starts already matching. */
const matchingObserved = () => ({
  client_config: { enable_logging: true, disable_content_logging: true, log_retention_days: 90 },
  framework_config: { pricing_url: "https://example.test/pricing" },
});

const harness = (options: {
  observedClient?: Record<string, unknown>;
  providers?: Record<string, Record<string, unknown> | null>;
  keys?: Record<string, Array<Record<string, unknown>> | null>;
  failPutConfig?: boolean;
  failPutProvider?: boolean;
  failPutKey?: boolean;
}) => {
  const configPuts: Array<Record<string, unknown>> = [];
  const providerPuts: Array<{ provider: string; body: Record<string, unknown> }> = [];
  const keyPuts: Array<{ provider: string; id: string; body: Record<string, unknown> }> = [];

  const gateway: ConfigGateway = {
    getConfig: async () => ({
      ...matchingObserved(),
      ...(options.observedClient === undefined
        ? {}
        : { client_config: options.observedClient }),
    }),
    putConfig: async (body) => {
      if (options.failPutConfig) throw new Error("PUT /api/config refused");
      configPuts.push(body);
    },
    getProvider: async (provider) => options.providers?.[provider] ?? null,
    putProvider: async (provider, body) => {
      if (options.failPutProvider) throw new Error("PUT /api/providers refused");
      providerPuts.push({ provider, body });
    },
    // `null` in `options.keys` is the gateway's `404`: a provider the running
    // process does not have answers that way to its key list as well as to the
    // provider read. The fake keeps the two in one option so a test that says
    // "this provider is not there" cannot set one and not the other.
    listProviderKeys: async (provider) =>
      options.keys?.[provider] === null
        ? null
        : options.keys?.[provider] ?? [],
    putProviderKey: async (provider, id, body) => {
      if (options.failPutKey) throw new Error("PUT /api/providers/keys refused");
      keyPuts.push({ provider, id, body });
    },
  };

  return { gateway, configPuts, providerPuts, keyPuts };
};

/** A file whose only live content is the client config, so a test can isolate it. */
const clientOnly = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    client: { enable_logging: true, ...patch },
  });

describe("the desired state, from the committed file", () => {
  it("takes the live sections and names the two it refuses", () => {
    const desired = liveConfigDesiredState(configText());

    assert.deepEqual(Object.keys(desired.client ?? {}).sort(), [
      "disable_content_logging",
      "enable_logging",
      "log_retention_days",
    ]);
    assert.deepEqual(
      desired.providers.map((entry) => entry.provider),
      ["fireworks", "bedrock"],
      "both have a block the file declares: fireworks a network_config, bedrock a prompt_cache",
    );
    assert.deepEqual(
      desired.keys.map((entry) => `${entry.provider}/${entry.name}`),
      ["fireworks/fireworks-primary", "bedrock/bedrock-task-role"],
    );
    // The value is never part of the desired state. Decision 2 of the plan: a
    // provider key's value is boot-only, and a converger that held it would have
    // to hold every provider credential.
    assert.ok(!JSON.stringify(desired).includes("FIREWORKS_API_KEY"));
    assert.ok(!JSON.stringify(desired).includes("BIFROST_ADMIN_PASSWORD"));

    assert.deepEqual(
      desired.skipped.map((entry) => `${entry.path}:${entry.reason}`),
      ["$schema:no-runtime-effect", "governance:env-reference"],
    );
  });

  it("carries the key fields the plan's split table names, and no value", () => {
    const desired = liveConfigDesiredState(configText());
    const fireworks = desired.keys.find((entry) => entry.name === "fireworks-primary");
    assert.ok(fireworks);
    assert.deepEqual(Object.keys(fireworks.fields).sort(), [
      "aliases",
      "models",
      "name",
      "weight",
    ]);
    assert.equal("value" in fireworks.fields, false);
  });
});

/**
 * The live path list (step 1) and this loop's coverage, cross-checked against
 * each other and against the committed file.
 *
 * The point is to make one real gap loud rather than silent. \`BIFROST_LIVE_PATHS\`
 * classifies \`governance\` live, so editing it registers no new revision; this
 * loop refuses it, because its only content is \`env.\` references. Those two
 * facts together mean an edit to \`config.json\`'s \`governance\` block applies
 * nowhere: no restart, and no converge. It is a step 1 classification question
 * rather than a step 4 one -- moving the section to the boot-only list would roll
 * the task on such an edit, which is the cheap direction of the asymmetry -- so
 * this test pins the tension instead of quietly resolving it in one direction.
 */
describe("the live path list and this loop agree, except where they cannot", () => {
  const claimed = (rules: typeof BIFROST_LIVE_PATHS): Set<string> =>
    new Set(bifrostConfigClaimedLeaves(readBifrostConfig(), rules));

  it("names the one section whose classification and convergence disagree", () => {
    const desired = liveConfigDesiredState(readBifrostConfig());
    assert.deepEqual(
      desired.skipped.find((entry) => entry.path === "governance"),
      { path: "governance", reason: "env-reference" },
      "config.json's governance block holds env. references only the task resolves",
    );
    // Step 1's list says live; this loop refuses. Both statements are true, and
    // the consequence is that an edit to the block applies nowhere. Pinned here
    // so the gap is a failing test if either side changes, and reported in the
    // PR body as a decision rather than quietly fixed in this one.
    assert.ok(
      [...claimed(BIFROST_LIVE_PATHS)].some((path) => path.startsWith("governance.")),
      "step 1 classifies governance live: an edit registers no new revision",
    );
    const file = JSON.parse(readBifrostConfig()) as {
      governance?: { auth_config?: Record<string, unknown> };
    };
    for (const value of Object.values(file.governance?.auth_config ?? {})) {
      if (typeof value !== "string") continue;
      assert.match(
        value,
        /^env\./,
        "if a governance value stops being an env. reference this refusal is wrong and the section should be converged",
      );
    }
  });

  it("converges or names every provider key leaf, and never the value", () => {
    const live = claimed(BIFROST_LIVE_PATHS);
    const boot = bifrostConfigClaimedLeaves(readBifrostConfig(), BIFROST_BOOT_ONLY_PATHS);
    // The leaf that forces the list to be paths rather than top-level keys.
    assert.ok(boot.includes("providers.fireworks.keys[0].value"));
    assert.ok(!live.has("providers.fireworks.keys[0].value"));

    const desired = liveConfigDesiredState(readBifrostConfig());
    const key = desired.keys.find((entry) => entry.name === "fireworks-primary");
    assert.ok(key);
    // Every non-value leaf the live list claims for that key is a field the
    // desired state carries, so the diff actually compares it.
    for (const path of live) {
      if (!path.startsWith("providers.fireworks.keys[")) continue;
      // Only the key's own fields: a leaf below one of them (an alias's
      // `model_id`, a model list's entry) is part of the value the field
      // carries, not a field of its own.
      const segments = path.split(".");
      if (segments.length !== 4) continue;
      const field = (segments[3] ?? "").replace(/\[\d+\]$/, "");
      if (field === "name" || field === "value") continue;
      assert.ok(
        field in key.fields,
        path + " is live but the desired state for the key does not carry " + field,
      );
    }
  });
});

describe("the diff", () => {
  it("compares only the client fields the file names", () => {
    assert.deepEqual(
      differingClientFields({ enable_logging: true }, { enable_logging: true }),
      [],
    );
    assert.deepEqual(
      differingClientFields({ enable_logging: true }, { enable_logging: false }),
      ["enable_logging"],
    );
    // A field the gateway has and the file does not is not drift this loop
    // fights, the same rule `vk-janitor-core.ts` applies to `rate_limit`.
    assert.deepEqual(
      differingClientFields({ enable_logging: true }, {}),
      ["enable_logging"],
    );
  });

  it("ignores the one field the provider response adds to network_config", () => {
    assert.deepEqual(
      differingProviderFields(
        { provider: "fireworks", network_config: { base_url: "https://a" } },
        {
          network_config: {
            base_url: "https://a",
            extra_headers_secret_vars: { Authorization: { value: "<redacted>" } },
          },
        },
      ),
      [],
      "extra_headers_secret_vars is response-only; comparing it would rewrite every provider every deploy",
    );
  });

  it("treats a key's aliases as one value, in either wire shape", () => {
    const desired = {
      provider: "fireworks",
      name: "k",
      fields: { aliases: { "worker-default": { model_id: "m-1" } } },
    };
    // The legacy shape, a bare string, is the same alias.
    assert.deepEqual(
      differingKeyFields(desired, { name: "k", aliases: { "worker-default": "m-1" } }),
      [],
    );
    assert.deepEqual(
      differingKeyFields(desired, { name: "k", aliases: { "worker-default": "m-2" } }),
      ["aliases"],
    );
  });

  it("does not count a key's resolved alias extras as a difference", () => {
    // The gateway carries an alias's resolved region and provider sub-configs,
    // none of which git owns. Only the fields the file names are compared.
    const desired = {
      provider: "bedrock",
      name: "k",
      fields: {
        aliases: { "us.anthropic.claude-sonnet-5-5": { model_id: "m", model_name: "m" } },
      },
    };
    assert.deepEqual(
      differingKeyFields(desired, {
        name: "k",
        aliases: {
          "us.anthropic.claude-sonnet-5-5": {
            model_id: "m",
            model_name: "m",
            description: "resolved",
            region: "us-west-2",
          },
        },
      }),
      [],
    );
  });
});

describe("the loop", () => {
  it("writes nothing when the gateway already matches, and says so", async () => {
    const { gateway, configPuts } = harness({});
    const result = await convergeConfig({
      gateway,
      desired: liveConfigDesiredState(configText()),
    });

    assert.equal(result.outcome, "converged");
    assert.equal(result.changed, 0);
    // The client config matches; the one provider write is skipped because the
    // fake lists no providers, and both keys come back not-present.
    assert.deepEqual(configPuts, []);
    assert.equal(result.unchanged, 1);
    assert.deepEqual(
      result.skipped.filter((entry) => entry.reason === "not-present").length,
      4,
      "two providers and two keys the fake gateway does not have",
    );
  });

  it("applies a live client edit inside one run, as a complete body", async () => {
    const { gateway, configPuts } = harness({
      observedClient: { enable_logging: false, log_retention_days: 30 },
    });
    const result = await convergeConfig({
      gateway,
      desired: liveConfigDesiredState(clientOnly()),
    });

    assert.equal(result.changed, 1);
    assert.deepEqual(result.applied, [
      { section: "client", fields: ["enable_logging"] },
    ]);
    assert.equal(configPuts.length, 1);
    // The body is the server's own view with the file's field overlaid, never a
    // fragment: `PUT /api/config` assigns several client fields
    // unconditionally, so a body carrying only `enable_logging` would clear
    // `log_retention_days`.
    assert.deepEqual(configPuts[0].client_config, {
      enable_logging: true,
      log_retention_days: 30,
    });
    // And the framework config the server returned goes back untouched, because
    // `PUT /api/config` takes it as a value too.
    assert.deepEqual(configPuts[0].framework_config, {
      pricing_url: "https://example.test/pricing",
    });
  });

  it("never writes the admin account back, even when the server returns one", async () => {
    // The one key the echo must not carry. `GET /api/config` includes
    // `auth_config` whenever the admin row exists (bifrost/README.md, citing
    // `getConfig`), and `config.json` provisions that row with `is_enabled:
    // false`, so this gateway's read path returns it on every run. Echoing it
    // would make every deploy a write to the admin block -- the thing the
    // `governance` skip exists to refuse -- and what such a write does with a
    // masked password is pinned nowhere in this repo.
    //
    // The fake returns a redacted block deliberately: a real one would carry the
    // password, and the point is that neither shape reaches the PUT.
    const { gateway, configPuts } = harness({
      observedClient: { enable_logging: false },
    });
    const observedWithAuth = {
      ...matchingObserved(),
      client_config: { enable_logging: false },
      auth_config: {
        admin_username: "admin",
        // Masked, hashed, or real -- the loop writes none of them.
        admin_password: "********",
        is_enabled: false,
      },
    };
    const withAuth: ConfigGateway = {
      ...gateway,
      getConfig: async () => observedWithAuth,
    };

    await convergeConfig({
      gateway: withAuth,
      desired: liveConfigDesiredState(clientOnly()),
    });

    assert.equal(configPuts.length, 1, "the client edit still converges");
    assert.ok(
      !("auth_config" in configPuts[0]),
      `the PUT body must not carry auth_config: ${JSON.stringify(Object.keys(configPuts[0]))}`,
    );
    // And the rest of the echo is intact: dropping the admin block must not be a
    // licence to drop the settings the file does not name, which is why this is
    // an echo at all.
    assert.deepEqual(configPuts[0].framework_config, {
      pricing_url: "https://example.test/pricing",
    });
    assert.deepEqual(configPuts[0].client_config, {
      enable_logging: true,
    });
    // Nothing of the admin credential reaches the body in any other spelling.
    assert.doesNotMatch(JSON.stringify(configPuts[0]), /admin_password/);
  });

  it("applies a provider edit by merging onto the stored block", async () => {
    const { gateway, providerPuts } = harness({
      providers: {
        fireworks: {
          network_config: {
            base_url: "https://old.test",
            extra_headers_secret_vars: { Authorization: { value: "<redacted>" } },
          },
          concurrency_and_buffer_size: { concurrency: 4, buffer_size: 8 },
        },
      },
    });

    const result = await convergeConfig({
      gateway,
      desired: liveConfigDesiredState(
        JSON.stringify({
          providers: {
            fireworks: {
              network_config: { base_url: "https://new.test" },
            },
          },
        }),
      ),
    });

    assert.equal(result.changed, 1);
    assert.equal(providerPuts.length, 1);
    // Merged, so the file's one field does not wipe the stored block; the
    // response-only field is not echoed back; and the concurrency block is
    // passed through because the route refuses a zero one.
    assert.deepEqual(providerPuts[0], {
      provider: "fireworks",
      body: {
        network_config: { base_url: "https://new.test" },
        concurrency_and_buffer_size: { concurrency: 4, buffer_size: 8 },
      },
    });
  });

  it("patches a provider key with only the fields that differed, never its value", async () => {
    const { gateway, keyPuts } = harness({
      keys: {
        fireworks: [
          {
            id: "key-id-1",
            name: "fireworks-primary",
            value: "sk-the-live-credential",
            models: ["m-1"],
            weight: 1,
          },
        ],
      },
    });

    const result = await convergeConfig({
      gateway,
      desired: liveConfigDesiredState(
        JSON.stringify({
          providers: {
            fireworks: {
              keys: [
                {
                  name: "fireworks-primary",
                  value: "env.FIREWORKS_API_KEY",
                  models: ["m-1", "m-2"],
                  weight: 1,
                },
              ],
            },
          },
        }),
      ),
    });

    assert.equal(result.changed, 1);
    assert.deepEqual(keyPuts, [
      {
        provider: "fireworks",
        id: "key-id-1",
        body: { models: ["m-1", "m-2"] },
      },
    ]);
    // The credential is in the gateway's response and must not reach a request
    // built from it: `decodeKeyUpdate` keeps an omitted value.
    assert.ok(!JSON.stringify(keyPuts).includes("sk-the-live-credential"));
  });

  it("fails the run when a write is refused, rather than reporting a partial converge", async () => {
    const { gateway } = harness({
      observedClient: { enable_logging: false },
      failPutConfig: true,
    });

    await assert.rejects(
      convergeConfig({
        gateway,
        desired: liveConfigDesiredState(clientOnly()),
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "convergence-failed",
    );
  });

  it("fails the run when a read is refused", async () => {
    const failing: ConfigGateway = {
      ...harness({}).gateway,
      getProvider: async () => {
        throw new Error("503");
      },
    };

    await assert.rejects(
      convergeConfig({
        gateway: failing,
        desired: liveConfigDesiredState(configText()),
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "config-unavailable",
    );
  });

  it("never creates a provider or a key", async () => {
    const { gateway, providerPuts, keyPuts } = harness({});
    const result = await convergeConfig({
      gateway,
      desired: liveConfigDesiredState(configText()),
    });

    // Nothing was written at all, and every absence is a skip. Decision 7: the
    // reconciler converges what exists and grants nothing.
    assert.deepEqual(providerPuts, []);
    assert.deepEqual(keyPuts, []);
    assert.equal(
      result.skipped.filter((entry) => entry.reason === "not-present").length,
      4,
    );
  });
});

describe("a provider the running gateway does not have", () => {
  /**
   * The two reads have to answer a `404` the same way, and this is the test that
   * says so at the loop rather than at the adapter.
   *
   * `getProvider` has always mapped `404` to `null`, so the provider loop skips a
   * provider that is only in the file. `listProviderKeys` threw on the same
   * `404`, so the keys loop one step later surfaced `config-unavailable` and
   * failed the whole invocation: a boot-only change, which the plan's split
   * table says is what adding a provider is, turned into a failed deploy. The
   * adapter half of the fix is in `config-convergence-gateway.test.ts`; this is
   * the half that proves the loop does the right thing with `null`.
   */
  it("skips its keys as not-present instead of failing the invocation", async () => {
    const { gateway, keyPuts } = harness({
      // Nothing about either provider exists on the gateway: the provider read
      // and the key list both come back as the `404`'s `null`.
      providers: {},
      keys: { fireworks: null, bedrock: null },
    });

    const result = await convergeConfig({
      gateway,
      desired: liveConfigDesiredState(configText()),
    });

    assert.equal(result.outcome, "converged");
    assert.deepEqual(keyPuts, [], "convergence never creates a key");
    // Both providers, both their keys, plus the two sections the file names and
    // the loop refuses. Nothing is `unchanged`, because nothing was found.
    const notPresent = result.skipped.filter((entry) => entry.reason === "not-present");
    assert.deepEqual(
      notPresent.map((entry) => entry.path),
      [
        "providers.fireworks",
        "providers.bedrock",
        "providers.fireworks.keys[name=fireworks-primary]",
        "providers.bedrock.keys[name=bedrock-task-role]",
      ],
    );
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1, "the client config still matches");
  });

  it("still fails the run on a 5xx from the key list, which is an outage", async () => {
    // The other half of the rule: only a `404` is "not there". A `503` is the
    // gateway refusing to answer, and a deploy that read it as `not-present`
    // would go green over a loop that never ran.
    const failing: ConfigGateway = {
      ...harness({}).gateway,
      listProviderKeys: async () => {
        throw new Error("503");
      },
    };

    await assert.rejects(
      convergeConfig({
        gateway: failing,
        desired: liveConfigDesiredState(configText()),
      }),
      (error: unknown) =>
        error instanceof JanitorFailure && error.code === "config-unavailable",
    );
  });
});
