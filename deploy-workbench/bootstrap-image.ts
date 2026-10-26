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
 * The derived one-shot image that claims a fresh Bifrost deployment, and the
 * ECR repository CI builds it into. The automation half of phase 2 item 11 of
 * `docs/bifrost-gateway.md`.
 *
 * The claim itself is `deploy-workbench/bifrost/bootstrap.sh`: a `PUT
 * /api/config` that creates the first admin account, the one call upstream's
 * setup lock accepts while no admin account exists. It has to run from inside
 * the task, because once item 9's oauth2-proxy is in front of the gateway the
 * ALB sends every admin path to Google sign-in first; `127.0.0.1:8080` inside
 * the task's network namespace is the only unmediated path.
 *
 * The image is derived from the same pinned Bifrost release the gateway runs
 * (`bifrost-image.ts`) plus `curl` and `jq`, which its Alpine runtime does not
 * ship. `deploy-workbench/bifrost/bootstrap.Dockerfile` carries the `FROM`;
 * this module is the single source of truth for the pin the Dockerfile and the
 * workflow must agree with, and `bootstrap-image.test.ts` fails if any of them
 * drift.
 */

/** The ECR repository the derived image is built into, in this account. */
export const BIFROST_BOOTSTRAP_REPOSITORY_NAME = "bifrost-bootstrap";

/** The base image: the gateway's own pinned release, from `bifrost-image.ts`. */
export const BIFROST_BOOTSTRAP_UPSTREAM_IMAGE = `${BIFROST_UPSTREAM_REPOSITORY}:${BIFROST_UPSTREAM_TAG}@${BIFROST_UPSTREAM_DIGEST}`;

/** The two committed inputs the image is built from. */
export const BIFROST_BOOTSTRAP_SCRIPT_PATH = path.join(
  __dirname,
  "bifrost/bootstrap.sh",
);
export const BIFROST_BOOTSTRAP_DOCKERFILE_PATH = path.join(
  __dirname,
  "bifrost/bootstrap.Dockerfile",
);

/**
 * The first 12 hex characters of the sha256 over the script followed by the
 * Dockerfile, in that order and with nothing between them.
 *
 * The tag is content-addressed rather than fixed at the upstream tag so the
 * immutable repository accepts a new push whenever the claim changes, and
 * skips a re-push when it has not. Both files are hashed: the script is the
 * logic, but the Dockerfile is what decides which parsers it has, and a
 * Dockerfile-only edit has to be pushable too. The workflow derives the same
 * digest with `cat bootstrap.sh bootstrap.Dockerfile | sha256sum`.
 */
export const BIFROST_BOOTSTRAP_DIGEST = crypto
  .createHash("sha256")
  .update(fs.readFileSync(BIFROST_BOOTSTRAP_SCRIPT_PATH))
  .update(fs.readFileSync(BIFROST_BOOTSTRAP_DOCKERFILE_PATH))
  .digest("hex")
  .slice(0, 12);

/** The tag CI builds and pushes, and the one the task definition resolves. */
export const BIFROST_BOOTSTRAP_TAG = `${BIFROST_UPSTREAM_TAG}-${BIFROST_BOOTSTRAP_DIGEST}`;

/** The ECR image URI CI pushes, given the registry the ECR login returns. */
export const bifrostBootstrapImageUri = (registry: string): string =>
  `${registry}/${BIFROST_BOOTSTRAP_REPOSITORY_NAME}:${BIFROST_BOOTSTRAP_TAG}`;

/**
 * The repository the derived image is built into, with tag immutability on for
 * the same reason as the Bifrost mirror: a tag cannot be repointed at
 * different content. The content-addressed tag above is what makes
 * immutability workable, and the workflow skips a push when the tag already
 * exists, which is the same content already built.
 */
export const createBifrostBootstrapRepository = (args: {
  provider: aws.Provider;
}) =>
  new aws.ecr.Repository(
    "bifrostBootstrapRepository",
    {
      name: BIFROST_BOOTSTRAP_REPOSITORY_NAME,
      imageTagMutability: "IMMUTABLE",
      forceDelete: false,
    },
    { provider: args.provider },
  );
