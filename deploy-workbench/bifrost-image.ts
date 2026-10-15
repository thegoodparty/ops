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
export const BIFROST_UPSTREAM_TAG = "v2.3.0";

/**
 * The OCI image index digest that `maximhq/bifrost:v2.3.0` resolved to on
 * 2026-10-15. This is the multi-arch index, so it pins both the arm64 and the
 * amd64 manifests; the mirror pulls `--platform linux/amd64` for Fargate. The
 * amd64 manifest digest at that time was
 * `sha256:d9caa7c5babe673c11ed30c59b716a5feb429f1f3d7f932a6d5aabe81993f9e7`.
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
  "sha256:8f37e33a8caa85faf59a875605c61d1d934738e517d8fe96e2d9fcf6f0ef9098";

/**
 * The repository, with tag immutability on.
 *
 * Immutable tags are the point of mirroring: once `bifrost:v2.3.0` is here it
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
