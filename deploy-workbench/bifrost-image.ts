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
 * tag can be repointed. The mirror is reproducible (pinned by digest) and is
 * what the derived gateway image is built `FROM` (`pg-password-image.ts`); the
 * task itself runs that derivative, not the mirror directly, because it needs
 * `aws-cli` to resolve its database password.
 *
 * These constants are the single source of truth for the pin. The workflow
 * duplicates the upstream reference because GitHub Actions cannot import a
 * TypeScript module, and `bifrost-image.test.ts` fails if the two drift.
 */

/** The ECR repository the mirror pushes into, in this account. */
export const BIFROST_REPOSITORY_NAME = "bifrost";

/** The upstream repository and release tag the digest below was resolved from. */
export const BIFROST_UPSTREAM_REPOSITORY = "maximhq/bifrost";
export const BIFROST_UPSTREAM_TAG = "v2.4.0";

/**
 * The OCI image index digest that `maximhq/bifrost:v2.4.0` resolved to on
 * 2026-11-04. This is the multi-arch index, so it pins both the arm64 and the
 * amd64 manifests; the mirror pulls `--platform linux/amd64` for Fargate. The
 * amd64 manifest digest at that time was
 * `sha256:153e3fb5ce82b76825275a0f6d02332bb4847aaf1d9a432980a042ee410fbf24`
 * (the arm64 manifest is `sha256:5197ad08ddd34b3a60ac2c548cb84945f106e9ec49d549b644e4491debf75f53`).
 *
 * Resolved from the Docker Hub registry API (there is no docker, crane or
 * skopeo here): a pull token from `auth.docker.io`, then a manifest GET on
 * `registry-1.docker.io/v2/maximhq/bifrost/manifests/v2.4.0` with both the OCI
 * index and manifest-list `Accept` headers, reading `Docker-Content-Digest` and
 * re-hashing the body to confirm it. Re-resolving a tag later is the only way to
 * prove the digest a re-push would produce, so a future bump repeats that rather
 * than guessing. The per-platform `v2.4.0-amd64` and `v2.4.0-arm64` tags were
 * cross-checked against the index entries and agree.
 *
 * v2.3.1 rather than v2.3.0 is the floor for Bedrock prompt caching: at v2.3.0
 * the Bedrock converter dropped a top-level `cache_control` and instead nested
 * a `cachePoint` inside `toolResult.content`, which Bedrock accepts while
 * caching nothing (maximhq/bifrost#8541, fixed by #8595). v2.4.0 keeps that fix
 * and adds one more of the same kind (a single-text-block tool result now
 * renders like the equivalent string, so a cached prefix holds across turns).
 * The injector (`core/providers/utils/promptcache.go`) and the converter's
 * cache-point functions (`applyBedrockAutomaticCachePoint`,
 * `isBedrockCacheableBlock`, `newBedrockCachePoint`,
 * `withoutTopLevelCacheControl`, `checkAutomaticCachePointTTL`) are byte-identical
 * to v2.3.2, so the two injection points in `config.json` mean what they meant.
 *
 * v2.4.0 does carry store migrations, and this is the part a bump has to be
 * careful about. Read from `framework/configstore/migrations.go` and
 * `framework/logstore/migrations.go` at both tags: no new migration drops a
 * table or a column that v2.3.2 created, and none deletes or rewrites stored
 * rows. The one that is not purely additive is
 * `widen_oauth2_client_id_columns`, which widens
 * `oauth2_authorize_requests.client_id` and `oauth2_refresh_tokens.client_id`
 * from `varchar(255)` to `text` with a hash index — a widening cast that
 * preserves every value, not a rewrite. An older binary reading those columns
 * still works, and this deployment configures no OAuth2 server, so both tables
 * are empty here. So the pin can be rolled back on the previous digest alone.
 *
 * The mechanism that makes "rollback is the previous digest" true rather than
 * merely likely: `framework/migrator` does not refuse a database whose
 * migration ledger is *ahead* of the binary's list
 * (`ValidateUnknownMigrations` defaults to false in both versions, so the
 * unknown-ledger check is skipped), and the forward loop only runs migrations
 * that are not yet recorded. Two of the new migrations are declared
 * non-reversible by their own `Rollback` (`add_relays_tables`, and the log
 * store's `add_relay_logs_table`), which matters only if someone rolls the
 * *schema* back: those tables would be dropped with the relay endpoints and
 * recorded relay calls in them. Rolling back the image does not drop them, and
 * nothing in this deployment creates a relay. The RDS snapshot is still the
 * rollback of last resort for a schema move, per the plan's upgrade procedure.
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
  "sha256:a1c90607dcfd13c1fb2f9476ceb3bb24407a50ade7fdf3e61a59fb42b09e5c57";

/**
 * The repository, with tag immutability on.
 *
 * Immutable tags are the point of mirroring: once `bifrost:v2.4.0` is here it
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
