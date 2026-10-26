import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_CONFIG_CONTAINER_PATH,
  BIFROST_CONFIG_ENV_NAME,
  BIFROST_CONFIG_JSON,
  BIFROST_CONFIG_PARAMETER_NAME,
  BIFROST_CONFIG_PARAMETER_TYPE,
  BIFROST_CONFIG_PATH,
  BIFROST_CONFIG_SHA256,
  BIFROST_CONFIG_SHA256_ENV_NAME,
  bifrostConfigParameterArgs,
} from "./bifrost-config";
import {
  PG_HOST_ENV_NAME,
  PG_PASSWORD_ENV_NAME,
  PG_PORT_ENV_NAME,
  PG_USER_ENV_NAME,
} from "./ecs";
import { DATABASE_NAME } from "./rds";

/**
 * The deployed half of phase 2 item 10 of `docs/bifrost-gateway.md`: the SSM
 * parameter that carries `bifrost/config.json` into the task, and the values
 * it actually holds.
 *
 * The point of this file, and the reason it is separate from
 * `bifrost/config.test.ts`, is the difference between "the file mentions the
 * key" and "the value that reaches the gateway is valid". The gateway came up
 * unclaimed because `PUT /api/config` round-trips the stored config and the
 * stored `log_retention_days` was upstream's `0` while the API requires at
 * least `1` (`transports/bifrost-http/handlers/config.go` at `v2.3.0`). A test
 * that only asserts `config.json` contains a `log_retention_days` key would
 * have passed straight through that outage, so these tests parse the value the
 * parameter is given and assert the retention is a number the API accepts.
 *
 * The parameter's value is the file itself, read at program evaluation time
 * the way `oauth2-proxy-image.ts` reads the allowlist. That is deliberate: the
 * source of truth for what is deployed is the committed file, not a copy of it
 * assembled in TypeScript.
 */

const BIFROST_CONFIG_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost-config.ts"),
  "utf8",
);

type DeployedConfig = {
  client?: { log_retention_days?: unknown };
  config_store?: StoreConfig;
  logs_store?: StoreConfig;
};

type StoreConfig = {
  enabled?: boolean;
  type?: string;
  retention_days?: unknown;
  config?: Record<string, unknown>;
};

const deployedConfig = (): DeployedConfig =>
  JSON.parse(bifrostConfigParameterArgs().value) as DeployedConfig;

describe("bifrost config parameter", () => {
  it("stores the committed config.json, unchanged, as a reviewable String parameter", () => {
    // One source of truth: the parameter's value is the file's bytes. If this
    // ever becomes a TypeScript-built document, this assertion is where that
    // decision has to be argued for.
    assert.equal(
      BIFROST_CONFIG_JSON,
      fs.readFileSync(
        path.resolve(__dirname, "bifrost/config.json"),
        "utf8",
      ),
      "the module must read the committed config.json",
    );
    assert.equal(BIFROST_CONFIG_PATH, path.resolve(__dirname, "bifrost/config.json"));

    const args = bifrostConfigParameterArgs();
    assert.equal(args.name, BIFROST_CONFIG_PARAMETER_NAME);
    assert.equal(args.name, "/bifrost/config");
    assert.equal(args.type, BIFROST_CONFIG_PARAMETER_TYPE);
    // `String`, deliberately, not `SecureString`. The document is committed
    // in git, so its contents are already visible to everyone in the org;
    // encrypting the deployed copy would only hide it from the reviewers who
    // diff what production is actually running, and would conceal drift. The
    // credentials it names are references (`env.*`) whose values stay in
    // Secrets Manager; secret material belongs in `bifrost/gateway`, and
    // `deploy-workbench/bifrost/config.test.ts` fails if one appears here.
    assert.equal(args.type, "String");
    assert.equal(args.value, BIFROST_CONFIG_JSON);
    // Named, so a human can find it without reading the task definition.
    assert.equal(args.tags?.Name, BIFROST_CONFIG_PARAMETER_NAME);

    // And the resource uses those args rather than an inline copy.
    assert.ok(
      BIFROST_CONFIG_SOURCE.includes("new aws.ssm.Parameter("),
      "the module must create the parameter",
    );
    assert.ok(
      BIFROST_CONFIG_SOURCE.includes("bifrostConfigParameterArgs()"),
      "the resource must be built from the exported args",
    );
  });

  it("reads the value from the repo, never from AWS at preview time", () => {
    // The project's preview role deliberately holds no permissions (see
    // `preview-role.ts` and `docs/pr-previews.md` step 8), so a data source
    // here would fail the PR preview rather than show a diff.
    for (const forbidden of [
      "aws.ssm.getParameter",
      "aws.ssm.getParameters",
      "getParameter(",
      "getSecretValue",
      "aws.secretsmanager",
    ]) {
      assert.ok(
        !BIFROST_CONFIG_SOURCE.includes(forbidden),
        `bifrost-config.ts must not use ${forbidden}`,
      );
    }
  });

  it("carries a retention value the config API accepts", () => {
    // The unclaimed-gateway bug: `PUT /api/config` rejects the stored config
    // with "log_retention_days must be at least 1", so a `0` here is a
    // gateway nobody can claim. Parsed from the deployed value, not the file's
    // key list, so a wrong number fails this test rather than the deploy.
    const client = deployedConfig().client;
    assert.ok(client, "the deployed config has no client block");
    assert.equal(
      typeof client.log_retention_days,
      "number",
      "log_retention_days must be a number, not a reference or a string",
    );
    assert.ok(
      Number.isInteger(client.log_retention_days),
      "log_retention_days must be an integer",
    );
    assert.ok(
      (client.log_retention_days as number) >= 1,
      "the gateway rejects log_retention_days below 1 with a 400 and cannot be claimed",
    );
    assert.equal(client.log_retention_days, 90);

    // `logs_store.retention_days` is the store's own purge setting and has a
    // different default/valid range (`0` disables it), so it is set to the
    // same window on purpose: one retention story rather than two.
    const logsStore = deployedConfig().logs_store;
    assert.ok(logsStore, "the deployed config has no logs_store block");
    assert.equal(typeof logsStore.retention_days, "number");
    assert.ok(
      Number.isInteger(logsStore.retention_days),
      "logs_store.retention_days must be an integer",
    );
    assert.equal(
      logsStore.retention_days,
      client.log_retention_days,
      "the log store's retention and the cleanup job's retention must not drift",
    );
  });

  it("points both stores at the RDS instance, with the password by reference", () => {
    const config = deployedConfig();
    for (const name of ["config_store", "logs_store"] as const) {
      const store = config[name];
      assert.ok(store, `the deployed config has no ${name}`);
      assert.equal(store.enabled, true, `${name} must be enabled`);
      // SQLite is a local-development fallback; the deployed store is
      // Postgres, per "State: RDS Postgres" in the plan.
      assert.equal(store.type, "postgres", `${name} must use Postgres`);
      const storeConfig = store.config;
      assert.ok(storeConfig, `${name} has no config`);
      // Non-secret connection values are env references resolved from the
      // task's environment, which is how the host reaches the container
      // without this file carrying a deploy-time output.
      assert.equal(storeConfig.host, `env.${PG_HOST_ENV_NAME}`);
      assert.equal(storeConfig.port, `env.${PG_PORT_ENV_NAME}`);
      assert.equal(storeConfig.user, `env.${PG_USER_ENV_NAME}`);
      assert.equal(storeConfig.password, `env.${PG_PASSWORD_ENV_NAME}`);
      assert.equal(storeConfig.db_name, DATABASE_NAME);
      assert.equal(storeConfig.ssl_mode, "require");
      // The password is a reference to the variable the task definition
      // already fills from the RDS-managed secret. A literal here would put a
      // credential in SSM, in Pulumi state and in the preview, which is the
      // thing this assertion exists to prevent.
      assert.equal(
        typeof storeConfig.password,
        "string",
        "the password must be an env reference",
      );
      assert.ok(
        (storeConfig.password as string).startsWith("env."),
        "the password must never be a literal in the deployed config",
      );
    }
  });

  it("hashes the deployed bytes, so a config change rolls the task", () => {
    // ECS resolves the parameter by ARN, which does not change when the value
    // does. Without a value in the container definition that changes with the
    // config, a config-only PR would update SSM and leave the running task on
    // the old file until something unrelated replaced it.
    assert.equal(BIFROST_CONFIG_SHA256_ENV_NAME, "BIFROST_CONFIG_SHA256");
    assert.equal(BIFROST_CONFIG_ENV_NAME, "BIFROST_CONFIG");
    assert.equal(BIFROST_CONFIG_CONTAINER_PATH, "/app/data/config.json");
    const fromDisk = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.resolve(__dirname, "bifrost/config.json")))
      .digest("hex");
    assert.equal(
      BIFROST_CONFIG_SHA256,
      fromDisk,
      "the task-definition marker must hash the file's bytes, not a re-serialisation",
    );
  });
});
