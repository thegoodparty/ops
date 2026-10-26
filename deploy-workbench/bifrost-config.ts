import * as aws from "@pulumi/aws";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The SSM parameter that carries the committed `bifrost/config.json` into the
 * gateway task, and the constants that connect it to the container. The
 * deployed half of phase 2 item 10 of `docs/bifrost-gateway.md`.
 *
 * **Why `String` and not `SecureString`.** The document is committed in git,
 * so every value in it is already visible to everyone in the organisation.
 * Encrypting the deployed copy does not protect anything; it only hides the
 * running configuration from the reviewers who would otherwise diff what
 * production is actually configured with, which makes drift invisible and a
 * config change unreviewable. Secret material does not live here at all: the
 * provider key, the encryption key, the admin credential and the setup token
 * are `env.` references into `bifrost/gateway` in Secrets Manager, and the
 * database password is an `env.` reference into the RDS-managed secret the
 * task definition already injects. `deploy-workbench/bifrost/config.test.ts`
 * fails if a credential literal appears in the file, and
 * `deploy-workbench/ecs.test.ts` fails if a credential reaches the container
 * through `environment` instead of `secrets`.
 *
 * **Why the value is the file's bytes.** The source of truth for the deployed
 * configuration is the reviewed file, not a copy of it assembled in
 * TypeScript. The read is at program evaluation time, the same way
 * `oauth2-proxy-image.ts` reads the admin allowlist, so `pulumi preview` sees
 * a config edit as a parameter update without reading anything from AWS.
 *
 * **The container does not read the parameter itself.** Bifrost reads
 * configuration from `APP_DIR/config.json`; the ECS task definition injects
 * this parameter as the `BIFROST_CONFIG` environment variable and its
 * entrypoint writes that value to the file before starting the binary. That is
 * the shape upstream's ECS deployment guide documents
 * (`docs/deployment-guides/ecs.mdx` at the pinned tag); see `ecs.ts`.
 */

/**
 * The committed file whose bytes are deployed. `path.join(__dirname, ...)`
 * matches the two image modules and resolves the same way in the Pulumi
 * program and in the tests.
 */
export const BIFROST_CONFIG_PATH = path.resolve(__dirname, "bifrost/config.json");

/** The exact bytes the parameter is given and the task's marker hashes. */
export const BIFROST_CONFIG_JSON = fs.readFileSync(BIFROST_CONFIG_PATH, "utf8");

/**
 * The sha256 of those bytes, as a task-definition environment marker.
 *
 * ECS resolves a parameter by ARN, and that ARN does not change when the
 * value does. Without a container-definition value that changes with the
 * config, a config-only PR would update the parameter and leave the running
 * task on the old file until an unrelated deploy replaced it. This value makes
 * every config change a new task-definition revision, which is what makes
 * "the repo is the source of truth" true of a running gateway.
 */
export const BIFROST_CONFIG_SHA256 = crypto
  .createHash("sha256")
  .update(BIFROST_CONFIG_JSON)
  .digest("hex");

/**
 * The parameter's name. Hierarchical like `/identity-group-sync/pairs`
 * (`deploy-infrastructure/group-sync-lambda.ts`), and account-unique, so a
 * human can read the deployed config with one `aws ssm get-parameter`.
 */
export const BIFROST_CONFIG_PARAMETER_NAME = "/bifrost/config";

/**
 * `String`, not `SecureString`; see the module header. Exported so the test
 * can pin the type rather than read it out of the constructor call.
 */
export const BIFROST_CONFIG_PARAMETER_TYPE = "String";

/** The environment variable ECS fills from the parameter. */
export const BIFROST_CONFIG_ENV_NAME = "BIFROST_CONFIG";

/** The task-definition marker that rolls the task when the config changes. */
export const BIFROST_CONFIG_SHA256_ENV_NAME = "BIFROST_CONFIG_SHA256";

/**
 * Where the container entrypoint writes the value. Bifrost's `APP_DIR` is
 * `/app/data` in the pinned image (`transports/Dockerfile`),
 * `LoadConfig(ctx, configDirPath)` reads `config.json` from it
 * (`transports/bifrost-http/lib/config.go`), and the image's own entrypoint
 * starts the binary with `-app-dir "$APP_DIR"`. Upstream's ECS guide writes
 * to this path; a change here without a change to the image's `APP_DIR` is a
 * gateway that boots without its configuration.
 */
export const BIFROST_CONFIG_CONTAINER_PATH = "/app/data/config.json";

/**
 * The resource arguments, exported separately from the constructor so the
 * test can parse the exact value and type that are deployed without standing
 * up Pulumi.
 */
export const bifrostConfigParameterArgs = () => ({
  name: BIFROST_CONFIG_PARAMETER_NAME,
  type: BIFROST_CONFIG_PARAMETER_TYPE,
  value: BIFROST_CONFIG_JSON,
  description:
    "Bifrost gateway configuration. Written by Pulumi from deploy-workbench/bifrost/config.json; edit that file, not this parameter. Plain String on purpose: the file is committed in git, and an encrypted copy would only hide the deployed config from review. Secrets stay in Secrets Manager and are referenced by env.* name.",
  tags: { Name: BIFROST_CONFIG_PARAMETER_NAME },
});

/**
 * The parameter. It is a Pulumi resource, unlike the two secrets in
 * `bifrost/gateway` and `bifrost/oauth2-proxy`: those hold values a human
 * writes out of band, while this one's value is reviewed in git and must
 * converge on every apply.
 */
export const createBifrostConfigParameter = (args: {
  provider: aws.Provider;
}) =>
  new aws.ssm.Parameter(
    "bifrostConfig",
    bifrostConfigParameterArgs(),
    { provider: args.provider },
  );
