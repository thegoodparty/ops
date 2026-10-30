import * as aws from "@pulumi/aws";

/**
 * The Bifrost image the workbench account runs, and the ECR repository it is
 * mirrored into. Phase 0 item 3 of `docs/bifrost-gateway.md`.
 *
 * The image is upstream's OSS release, not one we build. The delegate worker
 * is built here and pushed with the commit sha as its tag
 * (`.github/workflows/deploy.yml`); Bifrost has no source in this repo, so the
 * equivalent pin is the upstream digest, and the mirror in
 * `.github/workflows/deploy-workbench.yml` copies it into the account's ECR.
 *
 * Why mirror at all, rather than pull from Docker Hub at task start: the
 * gateway is a component every harness depends on, so its image should not be
 * fetched from a public registry on every Fargate task start, and a public
 * tag can be repointed. The mirror is reproducible (pinned by digest) and the
 * task definition in phase 1 references the account's own copy.
 *
 * These constants are the single source of truth for the pin. The workflow
 * duplicates the upstream reference because GitHub Actions cannot import a
 * TypeScript module, and `bifrost-image.test.ts` fails if the two drift.
 */

/** The ECR repository the mirror pushes into, in this account. */
export const BIFROST_REPOSITORY_NAME = "bifrost";

/** The upstream repository and release tag the digest below was resolved from. */
export const BIFROST_UPSTREAM_REPOSITORY = "maximhq/bifrost";
export const BIFROST_UPSTREAM_TAG = "v2.3.2";

/**
 * The OCI image index digest that `maximhq/bifrost:v2.3.2` resolved to on
 * 2026-10-30. This is the multi-arch index, so it pins both the arm64 and the
 * amd64 manifests; the mirror pulls `--platform linux/amd64` for Fargate. The
 * amd64 manifest digest at that time was
 * `sha256:d53775fd4b1d444c350443d2487ceb8aa8c0bab722cd5dc7b0001a7fa88ecd7f`.
 *
 * Resolved from the Docker Hub registry API (there is no docker, crane or
 * skopeo here): a pull token from `auth.docker.io`, then a manifest GET on
 * `registry-1.docker.io/v2/maximhq/bifrost/manifests/v2.3.2` with the OCI index
 * `Accept` header, reading `Docker-Content-Digest` and re-hashing the body to
 * confirm it. Re-resolving a tag later is the only way to prove the digest a
 * re-push would produce, so a future bump repeats that rather than guessing.
 *
 * v2.3.1 rather than v2.3.0 is the floor for Bedrock prompt caching: at v2.3.0
 * the Bedrock converter dropped a top-level `cache_control` and instead nested
 * a `cachePoint` inside `toolResult.content`, which Bedrock accepts while
 * caching nothing (maximhq/bifrost#8541, fixed by #8595). v2.3.2 is the newest
 * v2.3.x, so it carries that fix plus the `crypto/x509` security release, and
 * no database migrations of its own.
 *
 * Upgrade cadence: deliberately, in a reviewed PR that bumps this digest and
 * the `BIFROST_UPSTREAM` reference in `.github/workflows/deploy-workbench.yml`
 * together (the test fails if they disagree). Not automatically, and not on
 * every upstream release: Bifrost ships weekly, and a gateway every harness
 * depends on should move on our schedule. The upgrade procedure in the plan
 * is an RDS snapshot, a new task definition and a watched `/health`; revisit
 * monthly, or sooner when a release carries a fix the fleet needs.
 */
export const BIFROST_UPSTREAM_DIGEST =
  "sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7";

/**
 * The repository, with tag immutability on.
 *
 * Immutable tags are the point of mirroring: once `bifrost:v2.3.2` is here it
 * cannot be repointed at different content. The mirror workflow skips a push
 * when the tag already exists, because an immutable repository rejects a
 * re-push and the workflow runs on every workbench change rather than only on
 * a digest bump.
 *
 * No lifecycle policy yet. This is one image per release and the account is
 * the developer inner loop; a "keep the last N" policy is a one-line addition
 * when the count is actually a problem.
 */
export const createBifrostRepository = (args: { provider: aws.Provider }) =>
  new aws.ecr.Repository(
    "bifrostRepository",
    {
      name: BIFROST_REPOSITORY_NAME,
      imageTagMutability: "IMMUTABLE",
      forceDelete: false,
    },
    { provider: args.provider },
  );
