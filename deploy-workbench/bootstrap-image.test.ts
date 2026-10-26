import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_BOOTSTRAP_DIGEST,
  BIFROST_BOOTSTRAP_DOCKERFILE_PATH,
  BIFROST_BOOTSTRAP_REPOSITORY_NAME,
  BIFROST_BOOTSTRAP_SCRIPT_PATH,
  BIFROST_BOOTSTRAP_TAG,
  BIFROST_BOOTSTRAP_UPSTREAM_IMAGE,
  bifrostBootstrapImageUri,
} from "./bootstrap-image";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";

const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);
const DOCKERFILE = fs.readFileSync(BIFROST_BOOTSTRAP_DOCKERFILE_PATH, "utf8");
const SCRIPT = fs.readFileSync(BIFROST_BOOTSTRAP_SCRIPT_PATH, "utf8");

/**
 * Reads a value from the workflow's top-level `env:` block, the way
 * `oauth2-proxy-image.test.ts` does: the workflow is text, the repo has no
 * YAML dependency, and every value checked here is a one-line scalar.
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

describe("derived bootstrap image pin", () => {
  it("is derived from the gateway's own pinned release", () => {
    // Not a second upstream to track: the claim runs on the same image and
    // Alpine userland it is claiming.
    assert.ok(
      BIFROST_BOOTSTRAP_UPSTREAM_IMAGE.startsWith(`maximhq/bifrost:${BIFROST_UPSTREAM_TAG}@`),
      BIFROST_BOOTSTRAP_UPSTREAM_IMAGE,
    );
    assert.match(BIFROST_BOOTSTRAP_UPSTREAM_IMAGE, /@sha256:[0-9a-f]{64}$/);
    assert.ok(
      DOCKERFILE.includes(`FROM ${BIFROST_BOOTSTRAP_UPSTREAM_IMAGE}`),
      "bootstrap.Dockerfile's FROM drifted from BIFROST_BOOTSTRAP_UPSTREAM_IMAGE",
    );
  });

  it("adds the JSON parser the claim needs and runs the committed script", () => {
    // The Alpine runtime has no curl and no jq, and the claim has to round-trip
    // the live config; a body spliced without a parser is how a setting gets
    // dropped silently.
    assert.match(DOCKERFILE, /apk add --no-cache [^\n]*\bcurl\b/);
    assert.match(DOCKERFILE, /apk add --no-cache [^\n]*\bjq\b/);
    assert.ok(
      DOCKERFILE.includes("COPY bootstrap.sh /bifrost-bootstrap/bootstrap.sh"),
      "the image must carry the committed claim script",
    );
    assert.ok(
      DOCKERFILE.includes('CMD ["/bifrost-bootstrap/bootstrap.sh"]'),
      "the derived image must run the claim, not the inherited gateway command",
    );
  });

  it("drops to the base image's user only after the steps that need root", () => {
    // The base image runs as 1000:0, and `COPY` lays its files down as 0:0
    // whatever the active `USER` is: a `chmod` on a copied file issued after
    // the drop is a chmod by a non-owner, which fails with "Operation not
    // permitted" and fails the image build (deploy run 40329170411). So no
    // step that needs root may follow the final non-root `USER`, and the only
    // escape hatch is `--chown`, where the builder sets the owner itself.
    const instructions = DOCKERFILE.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const isRootUser = (instruction: string): boolean => {
      const match = instruction.match(/^USER\s+(\S+)$/);
      return match !== null && (match[1] === "root" || /^0(:0)?$/.test(match[1]));
    };
    const lastNonRootUser = instructions.reduce(
      (last, instruction, index) =>
        instruction.startsWith("USER ") && !isRootUser(instruction)
          ? index
          : last,
      -1,
    );
    assert.ok(
      lastNonRootUser > 0,
      "the derived image must drop to the base image's non-root user",
    );
    assert.deepEqual(
      instructions
        .slice(lastNonRootUser + 1)
        .filter(
          (instruction) =>
            /^(RUN|COPY|ADD)\b/.test(instruction) &&
            !instruction.includes("--chown="),
        ),
      [],
      "these steps run after the privilege drop, and COPY leaves files owned by 0:0",
    );
  });

  it("builds into a repository of its own, apart from both other images", () => {
    assert.equal(BIFROST_BOOTSTRAP_REPOSITORY_NAME, "bifrost-bootstrap");
    assert.notEqual(BIFROST_BOOTSTRAP_REPOSITORY_NAME, "bifrost");
    assert.notEqual(BIFROST_BOOTSTRAP_REPOSITORY_NAME, "bifrost-oauth2-proxy");
    assert.equal(
      workflowEnv("BIFROST_BOOTSTRAP_REPOSITORY"),
      BIFROST_BOOTSTRAP_REPOSITORY_NAME,
      "the workflow pushes a different repository than the stack creates",
    );
  });

  it("derives the content tag from the same two files the workflow hashes", () => {
    // Both inputs, in the same order, with nothing between them: the script is
    // the logic, the Dockerfile decides which parsers it has, and either edit
    // has to produce a new tag in an immutable repository.
    const expected = crypto
      .createHash("sha256")
      .update(fs.readFileSync(BIFROST_BOOTSTRAP_SCRIPT_PATH))
      .update(fs.readFileSync(BIFROST_BOOTSTRAP_DOCKERFILE_PATH))
      .digest("hex")
      .slice(0, 12);
    assert.equal(BIFROST_BOOTSTRAP_DIGEST, expected);
    assert.equal(BIFROST_BOOTSTRAP_TAG, `${BIFROST_UPSTREAM_TAG}-${expected}`);

    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        "cat deploy-workbench/bifrost/bootstrap.sh deploy-workbench/bifrost/bootstrap.Dockerfile | sha256sum | cut -c1-12",
      ),
      "the workflow must derive the digest the same way bootstrap-image.ts does",
    );
    assert.ok(
      workflow.includes('image_tag="${BIFROST_TAG}-${bootstrap_digest}"'),
      "the workflow must build the tag as the upstream tag plus the content digest",
    );
    assert.ok(
      workflow.includes(
        "-f deploy-workbench/bifrost/bootstrap.Dockerfile",
      ),
      "the workflow must build the claim Dockerfile, not the sidecar one",
    );
  });

  it("names the image the task definition resolves", () => {
    assert.equal(
      bifrostBootstrapImageUri("example.ecr"),
      `example.ecr/bifrost-bootstrap:${BIFROST_BOOTSTRAP_TAG}`,
    );
  });

  it("documents the one call it makes, and the header it authenticates with", () => {
    // Source-level because the behaviour is covered by bootstrap.test.ts
    // against a stub server; this pins the contract text a future edit would
    // have to think about before changing.
    assert.ok(SCRIPT.includes('SETUP_TOKEN_HEADER="X-Bifrost-Setup-Token"'));
    assert.ok(SCRIPT.includes("PUT"));
    assert.ok(
      SCRIPT.includes("/api/session/is-auth-enabled"),
      "the claim must check the whitelisted state endpoint before writing",
    );
    assert.ok(
      SCRIPT.includes('"$API/api/config"'),
      "the claim must build its payload from the server's own GET /api/config",
    );
    assert.ok(
      !/cat\s+\S*config\.json/.test(SCRIPT),
      "the claim must not read config.json; PUT replaces the client config",
    );
  });
});
