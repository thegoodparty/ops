import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_REPOSITORY_NAME,
  BIFROST_UPSTREAM_DIGEST,
  BIFROST_UPSTREAM_REPOSITORY,
  BIFROST_UPSTREAM_TAG,
} from "./bifrost-image";

const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);

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

describe("bifrost image pin", () => {
  it("pins an upstream tag and a sha256 digest", () => {
    assert.equal(BIFROST_UPSTREAM_REPOSITORY, "maximhq/bifrost");
    assert.equal(BIFROST_UPSTREAM_TAG, "v2.3.0");
    assert.match(BIFROST_UPSTREAM_DIGEST, /^sha256:[0-9a-f]{64}$/);
  });

  it("mirrors into the repository the stack creates", () => {
    assert.equal(BIFROST_REPOSITORY_NAME, "bifrost");
  });

  // The workflow hardcodes the upstream reference and the two literals the
  // mirror step builds the ECR URI from, because Actions cannot import a
  // TypeScript module. Each is checked on its own: a partial bump that touched
  // only one of them would otherwise look applied while the workflow pulled
  // one version and pushed another.
  it("pins the same upstream tag and digest the workflow mirrors", () => {
    assert.equal(
      workflowEnv("BIFROST_UPSTREAM"),
      `${BIFROST_UPSTREAM_REPOSITORY}:${BIFROST_UPSTREAM_TAG}@${BIFROST_UPSTREAM_DIGEST}`,
      "BIFROST_UPSTREAM drifted from BIFROST_UPSTREAM_REPOSITORY/TAG/DIGEST in bifrost-image.ts",
    );
  });

  it("uses the pinned tag for the ECR image, not a second one", () => {
    assert.equal(
      workflowEnv("BIFROST_TAG"),
      BIFROST_UPSTREAM_TAG,
      "BIFROST_TAG drifted from BIFROST_UPSTREAM_TAG; the mirror would pull one version and push another",
    );
  });

  it("pushes to the repository the stack creates", () => {
    assert.equal(
      workflowEnv("BIFROST_REPOSITORY"),
      BIFROST_REPOSITORY_NAME,
      "BIFROST_REPOSITORY drifted from BIFROST_REPOSITORY_NAME; the mirror would push to a different repository",
    );
  });

  // Regression guard for deploy run 38812637149: the mirror pulled
  // `maximhq/bifrost:v2.3.0@sha256:...`, which records the image under the
  // digest, not the tag, and then `docker tag maximhq/bifrost:$BIFROST_TAG`
  // failed with "No such image: maximhq/bifrost:v2.3.0". The tag step must use
  // the digest reference the pull created.
  it("tags the digest reference the pull records, not the tag", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        'docker tag "${upstream_repository}@${upstream_digest}" "$image_uri"',
      ),
      "the mirror must tag the digest reference from BIFROST_UPSTREAM; a digest pull does not create the repo:tag",
    );
    assert.ok(
      !workflow.includes('docker tag "maximhq/bifrost:$BIFROST_TAG"'),
      "tagging maximhq/bifrost:$BIFROST_TAG fails: a digest pull records the image under the digest, not the tag",
    );
  });

  // The ECR URI is not a fourth literal. Guard the derivation so a future edit
  // cannot reintroduce a hardcoded URI whose tag drifts from the pull.
  it("builds the ECR URI from the repository and tag", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        "${ECR_REGISTRY}/${BIFROST_REPOSITORY}:${BIFROST_TAG}",
      ),
      "the mirror step must build its ECR URI from ECR_REGISTRY, BIFROST_REPOSITORY and BIFROST_TAG",
    );
    assert.ok(
      !workflow.includes("BIFROST_IMAGE_URI"),
      "BIFROST_IMAGE_URI is a hardcoded ECR URI that can drift from BIFROST_TAG; build it from the login registry instead",
    );
  });
});
