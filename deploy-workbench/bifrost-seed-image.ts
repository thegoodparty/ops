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
 * The derived one-shot image that seeds the inactive colour's config store, and
 * the ECR repository CI builds it into. The image half of step 2 of
 * `docs/bifrost-zero-downtime-deploys.md`, decision 17.
 *
 * The seed itself is `deploy-workbench/bifrost/seed.sh`: a `pg_dump` of the
 * active colour's config-store tables into the inactive colour's database, in
 * one repeatable-read transaction, with the target created outside it
 * (decisions 3, 18 and 19). It cannot run on the gateway's image: the pinned
 * Bifrost release is Alpine plus a Go binary and ships neither `pg_dump` nor
 * `psql`, which is the whole reason this image exists.
 *
 * This follows the two precedents exactly -- `bootstrap-image.ts` with
 * `bifrost/bootstrap.Dockerfile`, and `oauth2-proxy-image.ts`: a module holding
 * the pin, a committed Dockerfile whose `FROM` is the same pinned Bifrost
 * digest the other derived images use, a content-addressed tag over the
 * committed inputs, an ECR repository with `imageTagMutability: IMMUTABLE`, and
 * a test that fails when the module and the Dockerfile disagree.
 *
 * The table list the script copies is `seed-tables.ts`, which carries the
 * ruling on how that set is expressed and what happens when Bifrost adds one.
 */

/** The ECR repository the derived image is built into, in this account. */
export const BIFROST_SEED_REPOSITORY_NAME = "bifrost-seed";

/** The base image: the gateway's own pinned release, from `bifrost-image.ts`. */
export const BIFROST_SEED_UPSTREAM_IMAGE = `${BIFROST_UPSTREAM_REPOSITORY}:${BIFROST_UPSTREAM_TAG}@${BIFROST_UPSTREAM_DIGEST}`;

/** The two committed inputs the image is built from. */
export const BIFROST_SEED_SCRIPT_PATH = path.join(__dirname, "bifrost/seed.sh");
export const BIFROST_SEED_DOCKERFILE_PATH = path.join(
  __dirname,
  "bifrost/seed.Dockerfile",
);

/** The repository root the content inputs are relative to. */
export const BIFROST_SEED_REPOSITORY_ROOT = path.join(__dirname, "..");

/**
 * The committed files the image is built from, in the order they are hashed:
 * the script and the Dockerfile.
 *
 * Relative to the repository root because the CI step derives the same digest
 * with `cat` over exactly this list (Actions cannot import a TypeScript
 * module), and `bifrost-seed-image.test.ts` fails if the two orders or the two
 * lists disagree.
 *
 * Both are hashed for the reason `bootstrap-image.ts` gives: the script is the
 * logic, but the Dockerfile decides which Postgres client it has, and a
 * Dockerfile-only edit has to be pushable too.
 */
export const BIFROST_SEED_CONTENT_INPUTS = [
  "deploy-workbench/bifrost/seed.sh",
  "deploy-workbench/bifrost/seed.Dockerfile",
] as const;

/**
 * The first 12 hex characters of the sha256 over the script followed by the
 * Dockerfile, in that order and with nothing between them.
 *
 * The tag is content-addressed rather than fixed at the upstream tag so the
 * immutable repository accepts a new push whenever the seed changes, and skips
 * a re-push when it has not. The workflow derives the same digest with
 * `cat seed.sh seed.Dockerfile | sha256sum`.
 */
export const BIFROST_SEED_CONTENT_DIGEST = crypto
  .createHash("sha256")
  .update(fs.readFileSync(BIFROST_SEED_SCRIPT_PATH))
  .update(fs.readFileSync(BIFROST_SEED_DOCKERFILE_PATH))
  .digest("hex")
  .slice(0, 12);

/** The tag CI builds and pushes, and the one the task definition resolves. */
export const BIFROST_SEED_TAG = `${BIFROST_UPSTREAM_TAG}-${BIFROST_SEED_CONTENT_DIGEST}`;

/** The ECR image URI CI pushes, given the registry the ECR login returns. */
export const bifrostSeedImageUri = (registry: string): string =>
  `${registry}/${BIFROST_SEED_REPOSITORY_NAME}:${BIFROST_SEED_TAG}`;

/**
 * The repository the derived image is built into, with tag immutability on for
 * the same reason as the other three: a tag cannot be repointed at different
 * content. The content-addressed tag above is what makes immutability
 * workable, and the workflow skips a push when the tag already exists, which is
 * the same content already built.
 */
export const createBifrostSeedRepository = (args: { provider: aws.Provider }) =>
  new aws.ecr.Repository(
    "bifrostSeedRepository",
    {
      name: BIFROST_SEED_REPOSITORY_NAME,
      imageTagMutability: "IMMUTABLE",
      forceDelete: false,
    },
    { provider: args.provider },
  );
