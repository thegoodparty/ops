import * as aws from "@pulumi/aws";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_UPSTREAM_DIGEST,
  BIFROST_UPSTREAM_REPOSITORY,
  BIFROST_UPSTREAM_TAG,
} from "./bifrost-image";

/**
 * The derived gateway image the Bifrost task runs, and the ECR repository CI
 * builds it into. Step 6 of `docs/bifrost-zero-downtime-deploys.md`, decision
 * 20: the database password is resolved per physical connection instead of
 * being injected once at task start.
 *
 * The image is derived from the same pinned Bifrost release everything else
 * runs (`bifrost-image.ts`) plus `aws-cli` and `jq`, because Alpine ships
 * neither and `password_command` has to exec something that can sign a
 * `secretsmanager:GetSecretValue` call. The command itself is
 * `bifrost/pg-password.sh`; `bifrost/gateway.Dockerfile` carries the `FROM` and
 * the install.
 *
 * This is the third of the deployment's derived images and deliberately the
 * same shape as the other two (`bootstrap-image.ts`, `oauth2-proxy-image.ts`):
 * the pin lives in one module, the Dockerfile is committed, the tag is
 * content-addressed so the immutable repository accepts a new push when the
 * content changes and skips one when it has not, `deploy-workbench.yml` builds
 * before it applies, and a drift test fails if any of the three disagree.
 *
 * It replaces the mirror as the task's image, so `BIFROST_UPSTREAM_TAG` is no
 * longer the tag the task definition resolves; the mirror step and its
 * repository stay, because this image is built `FROM` the digest the mirror
 * pins and the two are bumped together.
 */

/** The ECR repository the derived image is built into, in this account. */
export const BIFROST_GATEWAY_REPOSITORY_NAME = "bifrost-gateway";

/** The base image: the gateway's own pinned release, from `bifrost-image.ts`. */
export const BIFROST_GATEWAY_UPSTREAM_IMAGE = `${BIFROST_UPSTREAM_REPOSITORY}:${BIFROST_UPSTREAM_TAG}@${BIFROST_UPSTREAM_DIGEST}`;

/** The password command the image installs, and its path inside the image. */
export const BIFROST_PG_PASSWORD_SCRIPT_PATH = path.join(
  __dirname,
  "bifrost/pg-password.sh",
);
export const BIFROST_PG_PASSWORD_CONTAINER_PATH =
  "/usr/local/bin/bifrost-pg-password";

/** The two committed inputs the image is built from, in hash order. */
export const BIFROST_GATEWAY_CONTENT_INPUTS = [
  "deploy-workbench/bifrost/pg-password.sh",
  "deploy-workbench/bifrost/gateway.Dockerfile",
] as const;

/** The repository root the inputs above are relative to. */
export const BIFROST_GATEWAY_REPOSITORY_ROOT = path.join(__dirname, "..");

/**
 * The first 12 hex characters of the sha256 over every build input, in the
 * order above and with nothing between them.
 *
 * Content-addressed rather than fixed at the upstream tag, for the reason the
 * other two derived images give: the repository is immutable, so a fixed tag
 * would make the second edit to either file unpushable, while a tag that does
 * not move would leave the task running the previous command.
 */
export const BIFROST_GATEWAY_CONTENT_DIGEST =
  BIFROST_GATEWAY_CONTENT_INPUTS.reduce(
    (hash, relativePath) =>
      hash.update(
        fs.readFileSync(path.join(BIFROST_GATEWAY_REPOSITORY_ROOT, relativePath)),
      ),
    crypto.createHash("sha256"),
  )
    .digest("hex")
    .slice(0, 12);

/** The tag CI builds and pushes, and the one the task definition resolves. */
export const BIFROST_GATEWAY_TAG = `${BIFROST_UPSTREAM_TAG}-${BIFROST_GATEWAY_CONTENT_DIGEST}`;

/** The ECR image URI CI pushes, given the registry the ECR login returns. */
export const bifrostGatewayImageUri = (registry: string): string =>
  `${registry}/${BIFROST_GATEWAY_REPOSITORY_NAME}:${BIFROST_GATEWAY_TAG}`;

/**
 * The repository the derived image is built into, with tag immutability on for
 * the same reason as the Bifrost mirror: a tag cannot be repointed at different
 * content, and the content-addressed tag is what makes that workable.
 */
export const createBifrostGatewayRepository = (args: {
  provider: aws.Provider;
}) =>
  new aws.ecr.Repository(
    "bifrostGatewayRepository",
    {
      name: BIFROST_GATEWAY_REPOSITORY_NAME,
      imageTagMutability: "IMMUTABLE",
      forceDelete: false,
    },
    { provider: args.provider },
  );
