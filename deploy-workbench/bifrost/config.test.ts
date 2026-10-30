import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKBENCH_MODELS, bedrockInvokeResources } from "../../utils/bedrock-models";
import { PG_PASSWORD_ENV_NAME, GATEWAY_PLAIN_ENV_NAMES } from "../ecs";
import { BIFROST_HOSTNAME } from "../ingress";
import { REGION } from "../network";
import { BIFROST_UPSTREAM_TAG } from "../bifrost-image";

/**
 * The non-secret Bifrost configuration, checked against the properties a
 * review is actually about. Phase 2 item 10 of `docs/bifrost-gateway.md`.
 *
 * The file is the authoring half of item 10: the other half, Pulumi storing it
 * as an SSM SecureString and injecting it as `BIFROST_CONFIG`, edits the ECS
 * task definition and lands separately. Until it does, nothing reads this
 * file, which is why the test can be strict about shape without a deploy.
 *
 * The upstream schema is `transports/config.schema.json` at the pinned
 * `maximhq/bifrost` tag (`v2.3.0`, `deploy-workbench/bifrost-image.ts`), not
 * the docs at a later tag. Two things were checked against it rather than
 * assumed:
 *
 * - `governance.auth_config.disable_auth_on_inference` exists but is marked
 *   deprecated and ignored, so `client.enforce_auth_on_inference` is the only
 *   switch this file sets.
 * - A key's `models` array is deny-by-default in v2 semantics (`version`
 *   omitted), so an empty list is not "all models".
 * - `setup_token` is a *top-level* key (not `governance.setup_token`) and
 *   accepts a literal, `env.NAME` or `vault.path`; `resolveSetupToken` in
 *   `transports/bifrost-http/lib/config.go` falls back to the
 *   `BIFROST_SETUP_TOKEN` environment variable. It arms the first-run claim,
 *   is consumed by the request that creates the first admin account and is
 *   not an API token afterwards.
 * - there is no per-key `base_url`: the only one in the schema is
 *   `network_config.base_url`, per provider, and the Fireworks provider uses
 *   it for every request path (`core/providers/fireworks/fireworks.go`, which
 *   defaults it to the global `https://api.fireworks.ai/inference`). That is
 *   what makes US-only inference a config property rather than a convention:
 *   the gateway has no other endpoint to fall back to.
 */

const CONFIG_PATH = path.resolve(__dirname, "config.json");
const FILL_SECRETS_PATH = path.resolve(__dirname, "fill-secrets.sh");
const CONFIG_SOURCE = fs.readFileSync(CONFIG_PATH, "utf8");

type KeyAlias = { model_id: string; model_name?: string; description?: string };

type ProviderKey = {
  name: string;
  value?: string;
  models: string[];
  aliases?: Record<string, KeyAlias>;
  weight: number;
  bedrock_key_config?: Record<string, unknown>;
};

type ProviderConfig = {
  keys: ProviderKey[];
  network_config?: { base_url?: string };
};

type PostgresStore = {
  enabled?: boolean;
  type?: string;
  config?: Record<string, unknown>;
  retention_days?: number;
};

type Config = {
  $schema?: string;
  source_of_truth?: string;
  encryption_key?: string;
  setup_token?: string;
  client?: Record<string, unknown>;
  config_store?: PostgresStore;
  logs_store?: PostgresStore;
  providers?: Record<string, ProviderConfig>;
  governance?: {
    auth_config?: Record<string, unknown>;
    virtual_keys?: unknown;
    budgets?: unknown;
    teams?: unknown;
    rate_limits?: unknown;
  };
};

/**
 * Parsed on demand so a malformed file fails a named test instead of crashing
 * the module while the test runner is collecting it.
 */
const loadConfig = (): Config => JSON.parse(CONFIG_SOURCE) as Config;

const provider = (config: Config, name: string): ProviderConfig => {
  const found = config.providers?.[name];
  assert.ok(found, `config.json has no ${name} provider`);
  return found;
};

/** Every string anywhere in the document, for the two whole-file checks. */
const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, out);
    }
  }
  return out;
};

/**
 * The `env.NAME` references in the file. Only the name is ever looked at; the
 * test never resolves one and never sees a value.
 */
const ENV_REFERENCE = /^env\.([A-Z][A-Z0-9_]*)$/;

/**
 * The classes the gateway serves, pinned as literals.
 *
 * Everything else in this file is derived from the files or from
 * `utils/bedrock-models.ts`, and a derivation cannot notice a class that was
 * deleted from both the config and the template at once: it shrinks with them.
 * This list is the independent statement of what US-only inference actually
 * leaves, so an accidental deletion fails a test instead of quietly reducing
 * what the fleet can reach.
 *
 * Eight, not gp-pi's nine: DeepSeek V3.2 is gone because Bedrock has no
 * `us.deepseek.v3.2` inference profile (checked with
 * `bedrock:ListInferenceProfiles` in `us-west-2` on 2026-10-29: the only
 * DeepSeek profile is `us.deepseek.r1-v1:0`), and a bare `deepseek.v3.2` id is
 * not a US commitment. See `docs/bifrost-gateway.md`, "Provider
 * configuration".
 */
const US_MODEL_CLASSES: Record<string, string[]> = {
  bedrock: [
    "us.anthropic.claude-sonnet-5-5",
    "us.anthropic.claude-opus-5-5",
    "us.moonshotai.kimi-k3",
    "us.openai.gpt-6.1-sol",
    "us.anthropic.claude-haiku-5-5",
    "us.xai.grok-4.7",
    "us.zai.glm-5.3",
  ],
  fireworks: [
    // Fireworks' documented US-only ids are
    // `accounts/fireworks/routers/<model>-us`
    // (https://docs.fireworks.ai/serverless/us-only-serverless.md).
    //
    // The dated `1017` release, not the undated
    // `.../deepseek-v4p1-flash-us`: the undated id is a separate model entry
    // (model library `createTime` 2026-09-10), not a version-tracking alias —
    // Fireworks tracks versions with `*-latest` aliases, and there is no
    // US-only `-latest` router — so naming it would freeze the gateway on the
    // September release while the fleet's container default
    // (`.../models/deepseek-v4p1-flash-1017`) is the October one. Pinning the
    // dated id means the next release is a reviewed edit here, which is the
    // trade this list makes on purpose.
    "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
  ],
};

const US_BEDROCK_PREFIX = "us.";

/** A US-only Fireworks router id, and nothing else: not a global model id. */
const US_FIREWORKS_ROUTER = /^accounts\/fireworks\/routers\/[a-z0-9.-]+-us$/;

/**
 * The wire id a served model name is sent to the provider as: the alias's
 * `model_id` when the name is a key alias, the name itself otherwise. Residency
 * is a property of this id, not of the name a client sees (`routing` resolves
 * the alias after key selection, `core/bifrost.go` at v2.3.0).
 */
const wireId = (key: ProviderKey, name: string): string =>
  key.aliases?.[name]?.model_id ?? name;

const envReferences = (config: Config): string[] =>
  collectStrings(config).flatMap((value) => {
    const match = ENV_REFERENCE.exec(value);
    return match ? [match[1]] : [];
  });

/**
 * Reads one `NAME=(...)` array from `fill-secrets.sh`. The script is the source
 * of the key names, so this test fails on a rename in either direction rather
 * than carrying a second copy of the list.
 */
const fillSecretsArray = (name: string): string[] => {
  const source = fs.readFileSync(FILL_SECRETS_PATH, "utf8");
  const match = source.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)\\n\\)`, "m"));
  assert.ok(match, `fill-secrets.sh has no ${name} array`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
};

/**
 * Shapes that are a credential on sight. Kept narrow: a false positive is a
 * test that has to be argued with, and the generic rule below catches the
 * shapeless case.
 */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["an sk- API key", /^sk-[A-Za-z0-9_-]{8,}$/],
  ["a Bifrost virtual key", /^sk-bf-/],
  ["an AWS access key id", /^(AKIA|ASIA)[0-9A-Z]{16}$/],
  ["a Slack token", /^xox[baprs]-/],
  ["a GitHub token", /^gh[pousr]_[A-Za-z0-9]{20,}$/],
  ["a JWT", /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./],
];

/**
 * A long unbroken alphanumeric run is what a generated secret looks like once
 * it is not a known prefix. URLs (`:`, `/`) and model names (`/`, `.`) are
 * deliberately excluded by the character class.
 */
const looksGenerated = (value: string): boolean =>
  !value.includes("/") && /^[A-Za-z0-9+=_-]{32,}$/.test(value);

const noSecretLiteral = (config: Config) => {
  for (const value of collectStrings(config)) {
    for (const [shape, pattern] of SECRET_SHAPES) {
      assert.ok(
        !pattern.test(value),
        `config.json contains a value shaped like ${shape}`,
      );
    }
    assert.ok(
      !looksGenerated(value),
      "config.json contains a long unbroken value that looks like a generated secret",
    );
  }
};


const allKeys = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, out);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      allKeys(entry, out);
    }
  }
  return out;
};

describe("bifrost config.json", () => {
  it("is valid JSON and names the pinned upstream schema", () => {
    assert.doesNotThrow(() => JSON.parse(CONFIG_SOURCE));
    assert.equal(
      loadConfig().$schema,
      "https://www.getbifrost.ai/schema",
      "config.json must carry $schema so editors validate it",
    );
  });

  it("makes the file authoritative for the sections it declares", () => {
    // Present sections converge to the repo on redeploy; omitted sections
    // (item 14's teams/budgets/virtual keys) are left alone. That asymmetry is
    // why the governance test below asserts absence rather than emptiness.
    assert.equal(loadConfig().source_of_truth, "config.json");
  });

  it("declares both providers the plan requires, each with a key", () => {
    const config = loadConfig();
    for (const name of ["fireworks", "bedrock"]) {
      const configured = provider(config, name);
      assert.ok(configured.keys.length > 0, `${name} has no key`);
      for (const key of configured.keys) {
        assert.ok(key.name.length > 0, `${name} key has no name`);
        assert.ok(
          key.models.length > 0,
          `${name} key ${key.name} allows no models; v2 semantics read that as deny all`,
        );
        assert.ok(!key.models.includes("*"), `${name} must not allow "*"`);
        assert.ok(
          !key.models.some((model) => model.startsWith("regex:")),
          `${name} must name models, not regexes`,
        );
      }
    }
  });

  it("references every credential by a name the deployment actually provides", () => {
    const config = loadConfig();
    const filled = new Set([
      ...fillSecretsArray("HUMAN_KEYS"),
      ...fillSecretsArray("REQUIRED_KEYS"),
      // The task definition's own environment and its RDS-managed password
      // entry, which are provided by `ecs.ts` rather than by the filler.
      ...GATEWAY_PLAIN_ENV_NAMES,
      PG_PASSWORD_ENV_NAME,
    ]);
    const referenced = envReferences(config);
    assert.ok(referenced.length > 0, "config.json references no env vars");
    for (const name of referenced) {
      assert.ok(
        filled.has(name),
        `env.${name} is not a name the deployment provides (neither fill-secrets.sh nor the task definition); the reference would resolve to nothing`,
      );
    }

    // The five keys the gateway container receives from `bifrost/gateway`.
    for (const name of [
      "BIFROST_ENCRYPTION_KEY",
      "BIFROST_ADMIN_USERNAME",
      "BIFROST_ADMIN_PASSWORD",
      "BIFROST_SETUP_TOKEN",
      "FIREWORKS_API_KEY",
    ]) {
      assert.ok(
        referenced.includes(name),
        `config.json no longer references env.${name}`,
      );
    }

    // The encryption key must be a reference, never a passphrase in git.
    assert.equal(config.encryption_key, "env.BIFROST_ENCRYPTION_KEY");
  });

  it("contains no literal that looks like a key or a token", () => {
    noSecretLiteral(loadConfig());
  });

  it("arms the one-time first-run claim with a setup token reference", () => {
    // Phase 2 item 11. At the pinned tag the setup token is a *top-level*
    // `setup_token` (`transports/config.schema.json`: literal, `env.NAME` or
    // `vault.path`), and `resolveSetupToken` in
    // `transports/bifrost-http/lib/config.go` falls back to the
    // `BIFROST_SETUP_TOKEN` environment variable. Both point at the same
    // Secrets Manager key, so the claim works whether or not item 10's
    // `BIFROST_CONFIG` injection has landed yet.
    //
    // Without it, a fresh instance with no admin account answers every /api
    // call with 403 and its setup page cannot be completed by anyone: the
    // bootstrap path this deployment is claimed through is simply absent.
    // Afterwards it is not a bearer token — automation signs in as the admin
    // account — but it still has to exist for the claim and for a restore.
    const config = loadConfig();
    assert.equal(
      config.setup_token,
      "env.BIFROST_SETUP_TOKEN",
      "config.json must resolve the setup token from env.BIFROST_SETUP_TOKEN, never carry it",
    );
    // It is top-level at the pinned tag; nesting it under governance would be
    // ignored, which reads as configured while leaving the API locked.
    assert.ok(
      !("setup_token" in (config.governance ?? {})),
      "setup_token is a top-level key at the pinned tag, not governance.setup_token",
    );
    // And the reference has to be one the script actually writes, which is the
    // same guarantee the loop above enforces for every other reference.
    assert.ok(
      fillSecretsArray("REQUIRED_KEYS").includes("BIFROST_SETUP_TOKEN"),
      "fill-secrets.sh does not write BIFROST_SETUP_TOKEN, so the reference would resolve to nothing",
    );
  });

  it("authenticates Bedrock as the ECS task role, with no stored credentials", () => {
    const config = loadConfig();
    const bedrock = provider(config, "bedrock");
    for (const key of bedrock.keys) {
      assert.equal(
        key.value,
        "",
        `bedrock key ${key.name} carries a value; the task role is the credential`,
      );
      assert.ok(
        key.bedrock_key_config,
        `bedrock key ${key.name} has no bedrock_key_config, so it has no region`,
      );
      assert.equal(
        key.bedrock_key_config.region,
        REGION,
        "the Bedrock key must sign in the region the task runs in",
      );
      for (const forbidden of [
        "access_key",
        "secret_key",
        "session_token",
        "role_arn",
        "external_id",
      ]) {
        assert.ok(
          !(forbidden in key.bedrock_key_config),
          `bedrock key ${key.name} sets ${forbidden}; inherited IAM role is the only supported auth here`,
        );
      }
    }
  });

  it("serves no model from outside the United States", () => {
    const config = loadConfig();

    // `global.` is worldwide by definition, so it may not appear anywhere in
    // the file: not in a model list, not in a key, not in a value nobody
    // thought of as a model. A bare id is only meaningless as a model, so that
    // half is checked where models are named.
    for (const value of collectStrings(config)) {
      assert.ok(
        !value.includes("global."),
        `config.json carries "${value}", which names the worldwide profile; the gateway serves US-only inference`,
      );
    }

    for (const key of provider(config, "bedrock").keys) {
      for (const model of key.models) {
        assert.ok(
          model.startsWith(US_BEDROCK_PREFIX),
          `bedrock model ${model} is not a us. inference profile; a bare or global id is not a US commitment`,
        );
      }
    }

    for (const key of provider(config, "fireworks").keys) {
      for (const model of key.models) {
        assert.match(
          wireId(key, model),
          US_FIREWORKS_ROUTER,
          `fireworks model ${model} is sent as ${wireId(key, model)}, which is not a US-only router id; use accounts/fireworks/routers/<model>-us`,
        );
      }
      // An alias that is not served is dead config, and one whose target is not
      // a router would be a way to reach a global model by a harmless-looking name.
      for (const [name, alias] of Object.entries(key.aliases ?? {})) {
        assert.ok(key.models.includes(name), `alias ${name} is not in the key's models, so it is never served`);
        assert.match(alias.model_id, US_FIREWORKS_ROUTER, `alias ${name} points at a non-US id`);
      }
    }
  });

  it("points Fireworks at the US-only endpoint", () => {
    const config = loadConfig();
    // The provider defaults `network_config.base_url` to
    // https://api.fireworks.ai/inference (the global endpoint), so leaving it
    // unset is what a global request looks like in this file. Setting it is the
    // control; the path matches the default so every request path the provider
    // appends (`/v1/chat/completions`, `/v1/messages`) still resolves.
    const baseUrl = provider(config, "fireworks").network_config?.base_url;
    assert.equal(
      baseUrl,
      "https://us.api.fireworks.ai/inference",
      "the Fireworks provider must point at the US-only endpoint",
    );
    assert.equal(
      new URL(baseUrl as string).host,
      "us.api.fireworks.ai",
      "the Fireworks endpoint must be the US-only host, not the global api.fireworks.ai",
    );

    // No other provider may carry an endpoint override: one that did would be
    // a path to a model the US-only lists do not cover.
    for (const [name, configured] of Object.entries(config.providers ?? {})) {
      if (name === "fireworks") continue;
      assert.ok(
        configured.network_config?.base_url === undefined,
        `${name} carries a base_url override; only the Fireworks endpoint is a reviewed decision`,
      );
    }
  });

  it("lists exactly the US Bedrock profiles the task role's IAM allows", () => {
    const config = loadConfig();
    const configured = provider(config, "bedrock").keys.flatMap((key) => key.models);

    // `taskRolePolicyDocument(bedrockInvokeResources())` in the ECS module is
    // built from `utils/bedrock-models.ts`, so anything here without a matching
    // resource is an AccessDenied. The other direction is not equality: the
    // IAM list is the sandbox's grant and is allowed to be wider than what the
    // gateway serves, which is exactly the state the transitional `global.`
    // Sonnet profile and the bare foundation-model ids are in. What this list
    // must be is the `us.`-profile subset of that file, with nothing added.
    const usProfiles = [
      ...new Set(
        WORKBENCH_MODELS.filter((model) =>
          model.invokeId.startsWith(US_BEDROCK_PREFIX),
        ).map((model) => model.invokeId),
      ),
    ].sort();

    assert.deepEqual(
      [...configured].sort(),
      usProfiles,
      "config.json's Bedrock models drifted from the us. profiles in utils/bedrock-models.ts; a missing one is a class the fleet cannot reach",
    );

    const resources = bedrockInvokeResources();
    for (const model of configured) {
      assert.ok(
        resources.some(
          (resource) =>
            resource.includes(":inference-profile/") &&
            resource.endsWith(`/${model}`),
        ),
        `${model} has no inference-profile IAM resource in bedrockInvokeResources()`,
      );
    }
  });

  it("serves exactly the agreed model classes, per provider", () => {
    const config = loadConfig();
    for (const [name, expected] of Object.entries(US_MODEL_CLASSES)) {
      // Classes are what the names resolve to on the wire, so an alias is the
      // same class as its router and not a ninth one.
      const configured = [
        ...new Set(
          provider(config, name).keys.flatMap((key) =>
            key.models.map((model) => wireId(key, model)),
          ),
        ),
      ];
      assert.deepEqual(
        [...configured].sort(),
        [...expected].sort(),
        `${name}'s classes drifted from the agreed eight US-only classes; a class added is a data-residency decision and one removed is a class the fleet loses`,
      );
    }
    // And no provider outside that set: a third provider would be a model class
    // nothing here has decided on.
    assert.deepEqual(
      Object.keys(config.providers ?? {}).sort(),
      Object.keys(US_MODEL_CLASSES).sort(),
      "config.json declares a provider the US-only model decision does not cover",
    );
  });

  it("reaches Fireworks with the key fill-secrets.sh writes", () => {
    const config = loadConfig();
    const fireworks = provider(config, "fireworks");
    for (const key of fireworks.keys) {
      assert.equal(
        key.value,
        "env.FIREWORKS_API_KEY",
        `fireworks key ${key.name} must reference env.FIREWORKS_API_KEY`,
      );
    }
    assert.ok(
      fireworks.keys.some((key) =>
        key.models.some(
          (model) =>
            wireId(key, model) ===
            "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
        ),
      ),
      "the fleet's Fireworks model is no longer allowed; add the replacement in the same change",
    );
    // The undated `.../deepseek-v4p1-flash-us` is a different model entry, so a
    // list that names it serves a release behind the one the class means. The
    // class-set test above pins the dated id; this asserts the failure reads as
    // "wrong release" rather than only "no Fireworks model".
    assert.ok(
      !fireworks.keys.some((key) =>
        key.models.some(
          (model) =>
            wireId(key, model) ===
            "accounts/fireworks/routers/deepseek-v4p1-flash-us",
        ),
      ),
      "the Fireworks list names the undated V4.1 Flash router, which is the September release rather than the 1017 update the fleet runs",
    );
  });

  it("keeps both stores in the RDS instance, not in the container", () => {
    // The reason the admin account kept disappearing: with no `config_store`
    // the gateway creates a SQLite file inside the container, and a task
    // replacement - every deploy - takes it with it. Phase 2 item 10 puts both
    // stores in item 7's Postgres instance, which is the one durable piece of
    // state this deployment has.
    const config = loadConfig();
    for (const name of ["config_store", "logs_store"] as const) {
      const store = config[name];
      assert.ok(store, `config.json has no ${name}`);
      assert.equal(store.enabled, true, `${name} is disabled`);
      assert.equal(store.type, "postgres", `${name} is not Postgres`);
      const connection = store.config;
      assert.ok(connection, `${name} has no config`);
      // Every connection field is a reference: the values live in the task
      // definition, sourced from rds.ts, so a connection string cannot drift
      // in a JSON file nobody diffs against the database.
      assert.equal(connection.host, "env.PG_HOST");
      assert.equal(connection.port, "env.PG_PORT");
      assert.equal(connection.user, "env.PG_USER");
      assert.equal(connection.password, "env.PG_PASSWORD");
      assert.equal(connection.db_name, "env.PG_DATABASE");
      // The instance is private and in the same VPC, but RDS still requires
      // TLS for the master credential; `require` is the plan's value.
      assert.equal(connection.ssl_mode, "require");
      // A connection string must not be spelled as a literal.
      for (const field of ["host", "user", "password", "db_name"]) {
        assert.ok(
          String(connection[field]).startsWith("env."),
          `${name}.config.${field} is a literal; it belongs in the task definition`,
        );
      }
    }
    // Retention is explicit rather than defaulted, per "Persistence, backup and
    // upgrade": a log store that never prunes is the one value certainly wrong.
    assert.equal(config.logs_store?.retention_days, 90);
  });

  it("turns on the client controls the plan calls data-boundary controls", () => {
    const client = loadConfig().client;
    assert.ok(client, "config.json has no client block");
    // Inference auth is mandatory: a gateway that forwards anonymous traffic
    // to a provider key is worse than no gateway.
    assert.equal(client.enforce_auth_on_inference, true);
    // Content logging is off, and the per-request header cannot turn it back
    // on. Metadata logging and its retention stay explicit.
    assert.equal(client.disable_content_logging, true);
    assert.equal(client.allow_per_request_content_storage_override, false);
    assert.equal(client.enable_logging, true);
    assert.equal(client.log_retention_days, 90);
    // x-bf-direct-key would bypass the virtual-key credential model.
    assert.equal(client.allow_direct_keys, false);
    assert.ok(
      (client.allowed_origins as string[]).includes(`https://${BIFROST_HOSTNAME}`),
      "allowed_origins must name the gateway's own public origin",
    );
  });

  it("turns Bifrost's own dashboard auth off and leaves item 14's governance entities absent", () => {
    // The decided shape: oauth2-proxy plus the email allowlist is the only gate
    // a human meets, so the shared OSS admin login is off. The admin account
    // is still provisioned from this block at boot (`loadAuthConfig` hashes the
    // password and writes the account), which is the state a store with auth
    // disabled is in: it needs proof of operator control before anyone turns
    // auth back on, and the setup token above is that proof.
    //
    // The references stay even though nothing authenticates with them today:
    // dropping them would make re-enabling auth a config-shape change as well
    // as a decision, and the account would have no credential to be re-enabled
    // with.
    const governance = loadConfig().governance;
    assert.ok(governance, "config.json has no governance block");
    const auth = governance.auth_config;
    assert.ok(auth, "governance has no auth_config");
    assert.equal(auth.is_enabled, false);
    assert.equal(auth.admin_username, "env.BIFROST_ADMIN_USERNAME");
    assert.equal(auth.admin_password, "env.BIFROST_ADMIN_PASSWORD");
    // The v2.3.0 schema marks this deprecated and ignored; the client flag is
    // the control, and setting both would suggest the file can override it.
    assert.ok(
      !("disable_auth_on_inference" in auth),
      "governance.auth_config.disable_auth_on_inference is deprecated and ignored at the pinned tag",
    );

    // Item 14 adds the engineering team, its budget and the first virtual
    // keys. Under source_of_truth: "config.json" a *present* empty array is
    // authoritative and prunes stored rows, so the structure is ready but
    // absent, not empty.
    for (const section of [
      "virtual_keys",
      "budgets",
      "teams",
      "rate_limits",
    ] as const) {
      assert.ok(
        !(section in governance),
        `governance.${section} belongs to item 14; an empty section here would prune rows created later`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Fireworks model metadata. docs/bifrost-fireworks-model-metadata.md
  // ---------------------------------------------------------------------------

  it("does not invent per-model metadata keys that v2.3.0 would ignore", () => {
    // v2.3.0 has no config.json way to set context_length, max_input_tokens,
    // max_output_tokens or a model description for a provider model: the
    // schema's only context/metadata-looking keys are unrelated, the Fireworks
    // adapter builds /v1/models from the key's `models` and `aliases` alone,
    // and enrichment reads the base catalog (not overrides). A key like these
    // would parse, do nothing, and look like a fix. See the findings document.
    const forbidden = new Set([
      "context_length",
      "context_window",
      "max_input_tokens",
      "max_output_tokens",
      "model_metadata",
      "model_info",
      "pricing",
    ]);
    for (const key of allKeys(loadConfig())) {
      assert.ok(
        !forbidden.has(key),
        `config.json carries "${key}", which Bifrost ${BIFROST_UPSTREAM_TAG} does not read for model metadata`,
      );
    }
  });

  it("keeps the findings document honest about the Bifrost tag it was verified against", () => {
    // The statements in docs/bifrost-fireworks-model-metadata.md are facts about
    // one tag's source. A bump has to re-check them (the catalog may gain the
    // router ids, or the Fireworks adapter may start passing metadata
    // through), so the document names the tag and this fails when the pin moves.
    const doc = fs.readFileSync(
      path.resolve(__dirname, "../../docs/bifrost-fireworks-model-metadata.md"),
      "utf8",
    );
    assert.ok(
      doc.includes(`Verified against: transports/${BIFROST_UPSTREAM_TAG}`),
      `docs/bifrost-fireworks-model-metadata.md was verified against a different tag than ${BIFROST_UPSTREAM_TAG}; re-check it and the alias before bumping`,
    );
  });

  it("lists the Fireworks model under a catalog name, so /v1/models carries its context window and price", () => {
    // /v1/models enriches each entry from the datasheet by the *listed name*,
    // then by the alias's wire id (`enrichListModelsResponse`,
    // transports/bifrost-http/handlers/inference.go at v2.3.0). The datasheet has
    // no row for the router id, so the router's own entry is bare (128K, $0 in
    // pi). It does have `accounts/fireworks/models/<model>-us`, so listing the
    // model under that name with the router as the alias target gives pi a
    // full entry while requests still go to the router. Checked on 2026-10-30
    // against the v2.3.0 code and the public datasheet: context_length and
    // max_input_tokens 1048576, max_output_tokens 393216, prompt $0.45/M,
    // completion $1.80/M, cached input $0.009/M.
    const key = provider(loadConfig(), "fireworks").keys[0];
    const alias = key.aliases?.["accounts/fireworks/models/deepseek-v4p1-flash-1017-us"];
    assert.ok(alias, "the catalog-named alias is missing; /v1/models would list only the bare router entry");
    assert.equal(alias.model_id, "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us");
    assert.ok(
      key.models.includes("accounts/fireworks/models/deepseek-v4p1-flash-1017-us"),
      "the alias name must be in the key's models: key selection checks the requested name, and the listing is built from this list",
    );
    // model_name is what request cost resolves first, so the logged price is
    // the catalog's own US-only row ($0.45 / $1.80 per 1M), not $0. Measured on
    // the v2.3.0 code: 1M in + 1M out through the alias costs $2.25.
    assert.equal(alias.model_name, "accounts/fireworks/models/deepseek-v4p1-flash-1017-us");
  });

  it("detects a Fireworks entry that would list bare, and so price at \$0 and show 128K in pi", () => {
    // Both failures are silent: the entry is present and the request succeeds.
    // The catalog is not available to a unit test, so the property is stated on
    // the config. Every name the key serves must be a catalog-named alias whose
    // `model_name` is that same name: the listing is enriched by the listed
    // name, and request cost resolves `model_name` first, so a router id served
    // directly (the case this replaces) is bare in the listing and $0 in the log.
    const catalogNamed = /^accounts\/fireworks\/models\/[a-z0-9.-]+-us$/;
    const bare = (key: ProviderKey): string[] =>
      key.models.filter((model) => {
        const alias = key.aliases?.[model];
        return !(
          catalogNamed.test(model) &&
          alias !== undefined &&
          alias.model_name === model
        );
      });
    const key = provider(loadConfig(), "fireworks").keys[0];
    assert.deepEqual(bare(key), [], "a served Fireworks name would list bare and cost \$0");

    // The detector itself: a router served directly, or an alias with no
    // model_name, is reported.
    const router = "accounts/fireworks/routers/x-us";
    const named = "accounts/fireworks/models/x-us";
    assert.deepEqual(bare({ name: "k", models: [router], weight: 1 }), [router]);
    assert.deepEqual(
      bare({ name: "k", models: [named, router], aliases: { [named]: { model_id: router, model_name: named } }, weight: 1 }),
      [router],
      "a bare router listed beside a good alias must still be reported",
    );
    assert.deepEqual(
      bare({ name: "k", models: [named], aliases: { [named]: { model_id: router } }, weight: 1 }),
      [named],
      "an alias without model_name is priced from the router id, which has no row",
    );
  });

});
