import * as aws from "@pulumi/aws";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The derived oauth2-proxy image the workbench account runs as the Bifrost
 * admin-surface sidecar, and the ECR repository CI builds it into. The image
 * half of phase 1 item 9 of `docs/bifrost-gateway.md`.
 *
 * Unlike the Bifrost gateway image (`bifrost-image.ts`), this is not an
 * upstream release pulled verbatim. Bifrost OSS has no native OIDC, so the
 * admin surface is gated by oauth2-proxy, and the stock oauth2-proxy image has
 * no inline email-list flag: the allowlist has to reach the container as a
 * file. `deploy-workbench/bifrost/Dockerfile` is the derivative that bakes it
 * in, with the alpha configuration (`bifrost/alpha-config.yaml`) that carries
 * the provider, the upstream and the one injected header. Bifrost's own
 * dashboard auth is off, so the only human gate is this proxy plus the
 * allowlist; the injected header is the operator's setup token, which the OSS
 * setup lock requires on `/api` whenever dashboard auth is not active. This
 * module is the single source of truth for the pin and for the content digest
 * that tags the image, and `oauth2-proxy-image.test.ts` fails if the
 * Dockerfile, the workflow and this module drift.
 *
 * The upstream reference is the same digest `agent-swarm` runs
 * (`agent-swarm/host/docker-compose.yml`), so the admin surface here and the
 * swarm's Google login are on the same oauth2-proxy release.
 */

/** The ECR repository the derived image is pushed into, in this account. */
export const OAUTH2_PROXY_REPOSITORY_NAME = "bifrost-oauth2-proxy";

/** The upstream repository and release tag the digest below was resolved from. */
export const OAUTH2_PROXY_UPSTREAM_REPOSITORY =
  "quay.io/oauth2-proxy/oauth2-proxy";
export const OAUTH2_PROXY_UPSTREAM_TAG = "v7.15.5";

/**
 * The OCI image index digest that `oauth2-proxy:v7.15.5` resolved to, the same
 * one `agent-swarm/host/docker-compose.yml` pins. It is the multi-arch index,
 * so it covers both the arm64 and the amd64 manifests; CI builds
 * `--platform linux/amd64` for Fargate.
 *
 * Upgrade cadence: deliberately, in a reviewed PR that bumps this digest, the
 * `FROM` in `deploy-workbench/bifrost/Dockerfile` and the
 * `OAUTH2_PROXY_UPSTREAM_TAG` literal in `.github/workflows/deploy-workbench.yml`
 * together (the test fails if they disagree), the same way the Bifrost mirror
 * is bumped. Not automatically: oauth2-proxy ships often, and this is the only
 * door onto the admin surface.
 */
export const OAUTH2_PROXY_UPSTREAM_DIGEST =
  "sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916";

/** The pinned upstream reference the Dockerfile's `FROM` must equal. */
export const OAUTH2_PROXY_UPSTREAM_IMAGE = `${OAUTH2_PROXY_UPSTREAM_REPOSITORY}:${OAUTH2_PROXY_UPSTREAM_TAG}@${OAUTH2_PROXY_UPSTREAM_DIGEST}`;

/**
 * The committed admin allowlist baked into the image, one `goodparty.org`
 * address per line. It is deliberately separate from the Identity Center
 * `Admins` group, which `sheriff` mutates at runtime; the two are expected to
 * drift. The owner is jagoda for now.
 */
export const OAUTH2_PROXY_ALLOWLIST_PATH = path.join(
  __dirname,
  "bifrost/allowed-emails.txt",
);

/**
 * The path the Dockerfile bakes the allowlist to, and the one the sidecar's
 * `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` names. The task definition and the
 * Dockerfile have to agree on it or the proxy starts with a missing file and
 * exits; `oauth2-proxy-image.test.ts` pins the Dockerfile side and
 * `ecs.test.ts` pins the environment, both against this constant.
 */
export const OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH =
  "/etc/oauth2-proxy/allowed-emails.txt";

/**
 * The path the Dockerfile bakes the alpha configuration to, and the one the
 * sidecar's `--alpha-config` flag names (`OAUTH2_PROXY_COMMAND` in `ecs.ts`).
 * `oauth2-proxy-image.test.ts` pins the Dockerfile side, the task definition
 * side and the alpha config's own contents against this constant.
 */
export const OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH =
  "/etc/oauth2-proxy/alpha-config.yaml";

/**
 * The header the baked alpha configuration injects upstream, and the
 * environment variable it reads the value from.
 *
 * With Bifrost's dashboard auth off there is no login to answer. The OSS setup
 * lock still refuses non-public `/api` calls while dashboard auth is not
 * active, so the sidecar presents the operator's setup token — the header name
 * is the one Bifrost itself documents and `bootstrap.sh` sends
 * (`SetupTokenHeader` in `transports/bifrost-http/handlers/middlewares.go` at
 * the pinned tag).
 *
 * The value is the setup token the task definition already injects into this
 * container from `bifrost/gateway`, so there is nothing to compute and no
 * second copy to rotate. `oauth2-proxy-image.test.ts` fails if the YAML, the
 * task definition and this constant disagree.
 */
export const OAUTH2_PROXY_INJECTED_HEADER_NAME = "X-Bifrost-Setup-Token";
export const OAUTH2_PROXY_SETUP_TOKEN_ENV = "BIFROST_SETUP_TOKEN";

/**
 * The committed files the derived image is built from, in the order they are
 * hashed: the allowlist, the Dockerfile and the alpha configuration.
 *
 * Relative to the repository root, because the CI step derives the same digest
 * with `cat` over exactly this list (Actions cannot import this module), and a
 * test fails if the two orders or the two lists disagree.
 *
 * Every file the Dockerfile reads is in the list, in build order, because the
 * image's content changes when any of them does and the repository is
 * immutable: a file that is not hashed here is a change that cannot be pushed.
 */
export const OAUTH2_PROXY_CONTENT_INPUTS = [
  "deploy-workbench/bifrost/allowed-emails.txt",
  "deploy-workbench/bifrost/Dockerfile",
  "deploy-workbench/bifrost/alpha-config.yaml",
] as const;

/** The repository root the inputs above are relative to. */
export const OAUTH2_PROXY_REPOSITORY_ROOT = path.join(__dirname, "..");

/**
 * The first 12 hex characters of the sha256 over every build input, in the
 * order above and with nothing between them.
 *
 * The tag is content-addressed rather than fixed at the upstream tag so that
 * the immutable repository accepts a new push when the image's content
 * changes, and skips a re-push when it has not. Until the alpha configuration
 * landed this hashed the allowlist alone; that stopped being the whole content
 * when the Dockerfile grew the config-check stage and the alpha file, and a tag
 * that did not move would have meant a deploy naming an image without them.
 */
export const OAUTH2_PROXY_CONTENT_DIGEST = OAUTH2_PROXY_CONTENT_INPUTS.reduce(
  (hash, relativePath) =>
    hash.update(
      fs.readFileSync(path.join(OAUTH2_PROXY_REPOSITORY_ROOT, relativePath)),
    ),
  crypto.createHash("sha256"),
)
  .digest("hex")
  .slice(0, 12);

/**
 * The tag CI builds and pushes, and the tag the phase 1 task definition will
 * resolve to a digest. It changes when and only when the image's content does.
 */
export const OAUTH2_PROXY_TAG = `${OAUTH2_PROXY_UPSTREAM_TAG}-${OAUTH2_PROXY_CONTENT_DIGEST}`;

/** The ECR image URI CI pushes, given the registry the ECR login returns. */
export const oauth2ProxyImageUri = (registry: string): string =>
  `${registry}/${OAUTH2_PROXY_REPOSITORY_NAME}:${OAUTH2_PROXY_TAG}`;

/**
 * The repository the derived image is built into, with tag immutability on for
 * the same reason as the Bifrost mirror: a tag cannot be repointed at different
 * content. Content-addressed tags (above) are what make immutability workable
 * here; the workflow skips a push when the tag already exists, which is the
 * same content already built.
 */
export const createOauth2ProxyRepository = (args: { provider: aws.Provider }) =>
  new aws.ecr.Repository(
    "bifrostOauth2ProxyRepository",
    {
      name: OAUTH2_PROXY_REPOSITORY_NAME,
      imageTagMutability: "IMMUTABLE",
      forceDelete: false,
    },
    { provider: args.provider },
  );
