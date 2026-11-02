import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_SEED_CONTENT_DIGEST,
  BIFROST_SEED_CONTENT_INPUTS,
  BIFROST_SEED_DOCKERFILE_PATH,
  BIFROST_SEED_REPOSITORY_NAME,
  BIFROST_SEED_REPOSITORY_ROOT,
  BIFROST_SEED_SCRIPT_PATH,
  BIFROST_SEED_TAG,
  BIFROST_SEED_UPSTREAM_IMAGE,
  bifrostSeedImageUri,
} from "./bifrost-seed-image";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";
import { SEED_TABLES } from "./seed-tables";

const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);
const DOCKERFILE = fs.readFileSync(BIFROST_SEED_DOCKERFILE_PATH, "utf8");
const SCRIPT = fs.readFileSync(BIFROST_SEED_SCRIPT_PATH, "utf8");

/**
 * Reads a value from the workflow's top-level `env:` block, the way
 * `bootstrap-image.test.ts` does: the workflow is text, the repo has no YAML
 * dependency, and every value checked here is a one-line scalar.
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

/** A Dockerfile with its comment lines removed, for the code-level pins. */
const dockerfileCode = (): string =>
  DOCKERFILE.split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("derived seed image pin", () => {
  it("is derived from the gateway's own pinned release", () => {
    // Not a second upstream to track: the dump runs on the same Alpine
    // userland as the gateway, and its `pg_dump` has to be able to read a
    // database the gateway's version created.
    assert.ok(
      BIFROST_SEED_UPSTREAM_IMAGE.startsWith(
        `maximhq/bifrost:${BIFROST_UPSTREAM_TAG}@`,
      ),
      BIFROST_SEED_UPSTREAM_IMAGE,
    );
    assert.match(BIFROST_SEED_UPSTREAM_IMAGE, /@sha256:[0-9a-f]{64}$/);
    assert.ok(
      DOCKERFILE.includes(`FROM ${BIFROST_SEED_UPSTREAM_IMAGE}`),
      "seed.Dockerfile's FROM drifted from BIFROST_SEED_UPSTREAM_IMAGE",
    );
  });

  it("adds the Postgres client the dump needs and runs the committed script", () => {
    // The pinned image is Alpine plus a Go binary: no `pg_dump`, no `psql`.
    // That absence is the whole reason this image exists (decision 17).
    const code = dockerfileCode();
    assert.match(
      code,
      /apk add --no-cache [^\n]*\bpostgresql\d+-client\b/,
      "the image must install a Postgres client package",
    );
    assert.ok(
      !/apk add --no-cache [^\n]*\bpostgresql\d*\b(?!-client)/.test(code),
      "the image must install the client package, not a server",
    );
    assert.ok(
      code.includes("COPY seed.sh /bifrost-seed/seed.sh"),
      "the image must carry the committed seed script",
    );
    assert.match(
      code,
      /chmod 0555 \/bifrost-seed\/seed\.sh/,
      "the seed script must be executable in the image",
    );
    // The base image's CMD is `main`, the Bifrost server. Inheriting it would
    // start a second gateway in the seed task.
    assert.match(
      code,
      /ENTRYPOINT \["\/bin\/sh"\]/,
      "the seed image must replace the inherited entrypoint",
    );
    assert.match(
      code,
      /CMD \["\/bifrost-seed\/seed\.sh"\]/,
      "the seed image must run the seed, not the inherited gateway command",
    );
  });

  it("pins a Postgres client no newer than the server's major version", () => {
    // `pg_dump` refuses a server newer than itself, and a client a major
    // version ahead emits `SET transaction_timeout`, which PostgreSQL 16 does
    // not recognise: the restore then fails on its first statement while a
    // 17 client against a 17 server would have worked. The RDS instance is 16
    // (`DATABASE_ENGINE_VERSION` in rds.ts) and the pinned Alpine release
    // ships `postgresql16-client`, so the two are the same major and the pin
    // is asserted rather than left to whatever `apk add` resolves.
    const code = dockerfileCode();
    const match = code.match(/postgresql(\d+)-client/);
    assert.ok(match, "the Dockerfile installs no versioned Postgres client");
    assert.equal(
      match[1],
      "16",
      "the client major must equal the RDS instance's major version (DATABASE_ENGINE_VERSION in rds.ts)",
    );
  });

  it("drops to the base image's user only after the steps that need root", () => {
    // Same trap as `bootstrap.Dockerfile`: `COPY` lays files down as 0:0
    // whatever the active `USER` is, so a `chmod` after the drop is a chmod by
    // a non-owner and fails the build.
    const instructions = DOCKERFILE.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const isRootUser = (instruction: string): boolean => {
      const match = instruction.match(/^USER\s+(\S+)$/);
      return (
        match !== null && (match[1] === "root" || /^0(:0)?$/.test(match[1]))
      );
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

  it("builds into a repository of its own, apart from the other three images", () => {
    assert.equal(BIFROST_SEED_REPOSITORY_NAME, "bifrost-seed");
    for (const other of [
      "bifrost",
      "bifrost-oauth2-proxy",
      "bifrost-bootstrap",
    ]) {
      assert.notEqual(BIFROST_SEED_REPOSITORY_NAME, other);
    }
    assert.equal(
      workflowEnv("BIFROST_SEED_REPOSITORY"),
      BIFROST_SEED_REPOSITORY_NAME,
      "the workflow pushes a different repository than the stack creates",
    );
  });

  it("derives the content tag from the same files the workflow hashes", () => {
    // Every committed input, in the same order, with nothing between them. The
    // script is the logic; the Dockerfile decides which client it has; the
    // table list is what it copies. Any of those changing is a new tag in an
    // immutable repository, and one that did not move would mean a deploy
    // naming an image built from the wrong table list.
    const expected = crypto
      .createHash("sha256")
      .update(fs.readFileSync(BIFROST_SEED_SCRIPT_PATH))
      .update(fs.readFileSync(BIFROST_SEED_DOCKERFILE_PATH))
      .digest("hex")
      .slice(0, 12);
    assert.equal(
      BIFROST_SEED_CONTENT_DIGEST,
      expected,
      "BIFROST_SEED_CONTENT_DIGEST must be the sha256 over every input, in order",
    );
    assert.equal(
      BIFROST_SEED_TAG,
      `${BIFROST_UPSTREAM_TAG}-${expected}`,
      "BIFROST_SEED_TAG must be the upstream tag plus the content digest",
    );

    assert.deepEqual([...BIFROST_SEED_CONTENT_INPUTS], [
      "deploy-workbench/bifrost/seed.sh",
      "deploy-workbench/bifrost/seed.Dockerfile",
    ]);
    for (const relativePath of BIFROST_SEED_CONTENT_INPUTS) {
      assert.ok(
        fs.existsSync(path.join(BIFROST_SEED_REPOSITORY_ROOT, relativePath)),
        `${relativePath} is hashed but does not exist`,
      );
    }

    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        "cat deploy-workbench/bifrost/seed.sh deploy-workbench/bifrost/seed.Dockerfile | sha256sum | cut -c1-12",
      ),
      "the workflow must derive the digest the same way bifrost-seed-image.ts does",
    );
    assert.ok(
      workflow.includes('image_tag="${BIFROST_TAG}-${seed_digest}"'),
      "the workflow must build the tag as the upstream tag plus the content digest",
    );
    assert.ok(
      workflow.includes("-f deploy-workbench/bifrost/seed.Dockerfile"),
      "the workflow must build the seed Dockerfile",
    );
  });

  it("names the image the task definition resolves", () => {
    assert.equal(
      bifrostSeedImageUri("example.ecr"),
      `example.ecr/bifrost-seed:${BIFROST_SEED_TAG}`,
    );
  });

  it("agrees with the table list seed.sh actually ships", () => {
    // The module is the record of the list; the script is what runs. They are
    // two copies because the image is built from the script and Actions cannot
    // read TypeScript, so the one thing that can drift is an edit to one and
    // not the other. This is the assertion that makes that a failed test
    // rather than a colour with a missing table.
    const match = SCRIPT.match(/^SEED_TABLES_DEFAULT='([^']+)'$/m);
    assert.ok(match, "seed.sh has no SEED_TABLES_DEFAULT");
    assert.deepEqual(
      match[1].split(/\s+/).filter((name) => name.length > 0),
      [...SEED_TABLES],
      "SEED_TABLES in seed-tables.ts and SEED_TABLES_DEFAULT in seed.sh have drifted",
    );
  });
});
