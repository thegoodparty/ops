import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_ALLOWLIST_PATH,
  OAUTH2_PROXY_REPOSITORY_NAME,
  OAUTH2_PROXY_TAG,
  OAUTH2_PROXY_UPSTREAM_DIGEST,
  OAUTH2_PROXY_UPSTREAM_IMAGE,
  OAUTH2_PROXY_UPSTREAM_REPOSITORY,
  OAUTH2_PROXY_UPSTREAM_TAG,
  oauth2ProxyImageUri,
} from "./oauth2-proxy-image";

const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);
const DOCKERFILE = path.resolve(__dirname, "bifrost/Dockerfile");
const ALLOWLIST = path.resolve(__dirname, "bifrost/allowed-emails.txt");

/**
 * Reads a value from the workflow's top-level `env:` block.
 *
 * The workflow is read as text rather than parsed: the repo has no YAML
 * dependency of its own, and every value checked here is a one-line scalar.
 * The two-space anchor is the top-level `env:` indentation, so this cannot
 * pick up a `with:` input of the same name.
 */
const workflowEnv = (key: string): string => {
  const source = fs.readFileSync(WORKFLOW, "utf8");
  const match = source.match(new RegExp(`^ {2}${key}: (.+)$`, "m"));
  assert.ok(
    match,
    `deploy-workbench.yml has no top-level env value for ${key}`,
  );
  return match[1].trim();
};

describe("derived oauth2-proxy image pin", () => {
  it("pins an upstream tag and a sha256 digest", () => {
    assert.equal(
      OAUTH2_PROXY_UPSTREAM_REPOSITORY,
      "quay.io/oauth2-proxy/oauth2-proxy",
    );
    assert.equal(OAUTH2_PROXY_UPSTREAM_TAG, "v7.15.5");
    assert.match(OAUTH2_PROXY_UPSTREAM_DIGEST, /^sha256:[0-9a-f]{64}$/);
  });

  it("builds into a repository that does not collide with the Bifrost mirror", () => {
    assert.equal(OAUTH2_PROXY_REPOSITORY_NAME, "bifrost-oauth2-proxy");
    assert.notEqual(OAUTH2_PROXY_REPOSITORY_NAME, "bifrost");
  });

  // The Dockerfile carries the `FROM` because a static pin is what makes the
  // build reproducible; the module carries the pin the Dockerfile and the
  // workflow must agree with. A partial bump that touched only one of them
  // would otherwise look applied while the image came from somewhere else.
  it("pins the same upstream reference the Dockerfile builds from", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    assert.ok(
      dockerfile.includes(`FROM ${OAUTH2_PROXY_UPSTREAM_IMAGE}`),
      "bifrost/Dockerfile's FROM drifted from OAUTH2_PROXY_UPSTREAM_IMAGE in oauth2-proxy-image.ts",
    );
  });

  it("bakes the allowlist to the path the sidecar reads", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    assert.equal(
      OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
      "/etc/oauth2-proxy/allowed-emails.txt",
    );
    assert.ok(
      dockerfile.includes(
        `COPY allowed-emails.txt ${OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH}`,
      ),
      `the derived image must COPY allowed-emails.txt to ${OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH}`,
    );
  });

  // GitHub Actions cannot import a TypeScript module, so the repository name
  // and the upstream tag are duplicated in the workflow's env. Each is checked
  // on its own.
  it("builds into the repository the stack creates", () => {
    assert.equal(
      workflowEnv("OAUTH2_PROXY_REPOSITORY"),
      OAUTH2_PROXY_REPOSITORY_NAME,
      "OAUTH2_PROXY_REPOSITORY drifted from OAUTH2_PROXY_REPOSITORY_NAME; the build would push to a different repository",
    );
  });

  it("uses the pinned upstream tag as the tag prefix", () => {
    assert.equal(
      workflowEnv("OAUTH2_PROXY_UPSTREAM_TAG"),
      OAUTH2_PROXY_UPSTREAM_TAG,
      "OAUTH2_PROXY_UPSTREAM_TAG drifted from OAUTH2_PROXY_UPSTREAM_TAG in oauth2-proxy-image.ts",
    );
  });

  // The tag is content-addressed, so the workflow has to derive it from the
  // committed allowlist exactly as the module does. This is the check that a
  // changed allowlist actually produces a new tag, and that the module's tag
  // matches what CI pushes.
  it("derives the content tag from the allowlist the module hashes", () => {
    const expectedDigest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(ALLOWLIST))
      .digest("hex")
      .slice(0, 12);
    assert.equal(
      OAUTH2_PROXY_TAG,
      `${OAUTH2_PROXY_UPSTREAM_TAG}-${expectedDigest}`,
      "OAUTH2_PROXY_TAG must be the upstream tag plus the first 12 hex of the allowlist sha256",
    );

    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        'allowlist_digest="$(sha256sum deploy-workbench/bifrost/allowed-emails.txt | cut -c1-12)"',
      ),
      "the workflow must derive the tag from the committed allowlist's sha256, the same input the module hashes",
    );
    assert.ok(
      workflow.includes(
        'image_tag="${OAUTH2_PROXY_UPSTREAM_TAG}-${allowlist_digest}"',
      ),
      "the workflow must build the image tag as the upstream tag plus the allowlist digest",
    );
  });

  // The ECR URI is not a hardcoded literal that can drift from the tag; the
  // workflow derives it from the login registry, the repository and the
  // content tag, which is the same shape the module exports.
  it("builds the ECR URI from the repository and the content tag", () => {
    assert.equal(
      oauth2ProxyImageUri("024901689212.dkr.ecr.us-west-2.amazonaws.com"),
      `024901689212.dkr.ecr.us-west-2.amazonaws.com/${OAUTH2_PROXY_REPOSITORY_NAME}:${OAUTH2_PROXY_TAG}`,
    );

    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        'image_uri="${ECR_REGISTRY}/${OAUTH2_PROXY_REPOSITORY}:${image_tag}"',
      ),
      "the build step must build its ECR URI from ECR_REGISTRY, OAUTH2_PROXY_REPOSITORY and the content tag",
    );
    assert.ok(
      workflow.includes(
        "docker build --platform linux/amd64 -t \"$image_uri\" deploy-workbench/bifrost",
      ),
      "the build step must build the bifrost context and tag it with the derived URI",
    );
  });

  it("keeps the allowlist one goodparty.org address per line", () => {
    const lines = fs
      .readFileSync(ALLOWLIST, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.ok(lines.length > 0, "the allowlist must not be empty");
    for (const line of lines) {
      assert.match(
        line,
        /^[^\s@]+@goodparty\.org$/,
        `allowlist line is not a goodparty.org address: ${line}`,
      );
    }
  });
});
