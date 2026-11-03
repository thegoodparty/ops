import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_GATEWAY_CONTENT_DIGEST,
  BIFROST_GATEWAY_CONTENT_INPUTS,
  BIFROST_GATEWAY_REPOSITORY_NAME,
  BIFROST_GATEWAY_REPOSITORY_ROOT,
  BIFROST_GATEWAY_TAG,
  BIFROST_GATEWAY_UPSTREAM_IMAGE,
  BIFROST_PG_PASSWORD_CONTAINER_PATH,
  BIFROST_PG_PASSWORD_SCRIPT_PATH,
  bifrostGatewayImageUri,
} from "./pg-password-image";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";
import {
  BIFROST_BOOTSTRAP_DOCKERFILE_PATH,
  BIFROST_BOOTSTRAP_REPOSITORY_NAME,
} from "./bootstrap-image";
import { BIFROST_CONFIG_SOURCE_PATH, RDS_PASSWORD_JSON_KEY } from "./ecs";

const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);
const DOCKERFILE_PATH = path.join(
  __dirname,
  "bifrost/gateway.Dockerfile",
);
const DOCKERFILE = fs.readFileSync(DOCKERFILE_PATH, "utf8");
const SCRIPT = fs.readFileSync(BIFROST_PG_PASSWORD_SCRIPT_PATH, "utf8");

/**
 * Reads a value from the workflow's top-level `env:` block, the way the other
 * two image tests do: the workflow is text, the repo has no YAML dependency,
 * and every value checked here is a one-line scalar.
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

describe("derived gateway image pin", () => {
  it("is derived from the gateway's own pinned release, by the same digest", () => {
    // Not a second upstream to track: this image runs the same Bifrost release
    // every other one does, and the drift test is what keeps a partial bump from
    // building one version on top of another.
    assert.ok(
      BIFROST_GATEWAY_UPSTREAM_IMAGE.startsWith(
        `maximhq/bifrost:${BIFROST_UPSTREAM_TAG}@`,
      ),
      BIFROST_GATEWAY_UPSTREAM_IMAGE,
    );
    assert.match(BIFROST_GATEWAY_UPSTREAM_IMAGE, /@sha256:[0-9a-f]{64}$/);
    assert.ok(
      DOCKERFILE.includes(`FROM ${BIFROST_GATEWAY_UPSTREAM_IMAGE}`),
      "gateway.Dockerfile's FROM drifted from BIFROST_GATEWAY_UPSTREAM_IMAGE",
    );
    // The bootstrap image derives from the same reference; two derived images on
    // two different Bifrost digests would be two userlands in one task, and a
    // bump that touched one Dockerfile would look applied.
    const bootstrapDockerfile = fs.readFileSync(
      BIFROST_BOOTSTRAP_DOCKERFILE_PATH,
      "utf8",
    );
    const fromLine = (source: string): string =>
      source
        .split("\n")
        .find((line) => line.startsWith("FROM ")) ?? "";
    assert.equal(
      fromLine(DOCKERFILE),
      fromLine(bootstrapDockerfile),
      "the two derived images must build FROM the same pinned Bifrost release",
    );
  });

  it("installs the CLI and parser the password command needs", () => {
    // Alpine ships neither. `aws-cli` is what signs the GetSecretValue call with
    // the container's own credentials; `jq` pulls `password` out of the secret's
    // JSON. Doing the signature by hand over `curl` would be a reimplementation,
    // not a saving.
    assert.match(DOCKERFILE, /apk add --no-cache [^\n]*\baws-cli\b/);
    assert.match(DOCKERFILE, /apk add --no-cache [^\n]*\bjq\b/);
    // And no shell-out: Bifrost refuses a shell as `password_command.command`,
    // so the Dockerfile must not be installing the command as a shell script it
    // expects Bifrost to invoke through `sh`.
    assert.ok(
      !/COPY\s+\S+\s+\S+\.sh\s*$/m.test(DOCKERFILE),
      "a `.sh` command would not be exec'able: the command must be an executable file",
    );
    assert.ok(
      DOCKERFILE.includes(
        `COPY pg-password.sh ${BIFROST_PG_PASSWORD_CONTAINER_PATH}`,
      ),
      "the image must install the committed command at the path the constant names",
    );
    assert.ok(
      DOCKERFILE.includes(`chmod 0555 ${BIFROST_PG_PASSWORD_CONTAINER_PATH}`),
      "the command must be executable by the non-root user that runs it",
    );
  });

  it("keeps the upstream contract the task definition relies on", () => {
    // `ecs.ts` overrides the entry point and then execs
    // `/app/docker-entrypoint.sh /app/main`. That only works if the derivation
    // keeps the file, the argument and the user.
    assert.ok(
      DOCKERFILE.includes('ENTRYPOINT ["/app/docker-entrypoint.sh"]'),
      "the derived image must keep upstream's entry point",
    );
    assert.ok(
      DOCKERFILE.includes('CMD ["/app/main"]'),
      "the derived image must keep upstream's command",
    );
    assert.ok(
      DOCKERFILE.includes("USER 1000:0"),
      "the derived image must run as the base image's own user",
    );
    assert.ok(
      !/ENV\s+APP_DIR=(?!\/app\/data)/.test(DOCKERFILE),
      "APP_DIR must stay the base image's /app/data, which config.json's file path and the task's command assume",
    );
  });

  it("drops to the base image's user only after the steps that need root", () => {
    // Same regression the bootstrap Dockerfile hit (deploy run 40329170411):
    // `COPY` lays files down as 0:0 whatever the active `USER` is, so a chmod
    // after the drop is a chmod by a non-owner and fails the build.
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

  it("builds into a repository of its own, apart from the other three", () => {
    assert.equal(BIFROST_GATEWAY_REPOSITORY_NAME, "bifrost-gateway");
    assert.notEqual(BIFROST_GATEWAY_REPOSITORY_NAME, "bifrost");
    assert.notEqual(BIFROST_GATEWAY_REPOSITORY_NAME, BIFROST_BOOTSTRAP_REPOSITORY_NAME);
    assert.notEqual(BIFROST_GATEWAY_REPOSITORY_NAME, "bifrost-oauth2-proxy");
    assert.equal(
      workflowEnv("BIFROST_GATEWAY_REPOSITORY"),
      BIFROST_GATEWAY_REPOSITORY_NAME,
      "the workflow pushes a different repository than the stack creates",
    );
  });

  it("derives the content tag from the same two files the workflow hashes", () => {
    // Both inputs, in the same order, with nothing between them: the script is
    // the command, the Dockerfile decides what it can run on. Either edit has to
    // produce a new tag in an immutable repository.
    const expected = BIFROST_GATEWAY_CONTENT_INPUTS.reduce(
      (hash, relativePath) =>
        hash.update(
          fs.readFileSync(
            path.join(BIFROST_GATEWAY_REPOSITORY_ROOT, relativePath),
          ),
        ),
      crypto.createHash("sha256"),
    )
      .digest("hex")
      .slice(0, 12);
    assert.equal(BIFROST_GATEWAY_CONTENT_DIGEST, expected);
    assert.equal(BIFROST_GATEWAY_TAG, `${BIFROST_UPSTREAM_TAG}-${expected}`);
    assert.deepEqual([...BIFROST_GATEWAY_CONTENT_INPUTS], [
      "deploy-workbench/bifrost/pg-password.sh",
      "deploy-workbench/bifrost/gateway.Dockerfile",
    ]);

    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        "cat deploy-workbench/bifrost/pg-password.sh deploy-workbench/bifrost/gateway.Dockerfile | sha256sum | cut -c1-12",
      ),
      "the workflow must derive the digest the same way pg-password-image.ts does",
    );
    assert.ok(
      workflow.includes('image_tag="${BIFROST_TAG}-${gateway_digest}"'),
      "the workflow must build the tag as the upstream tag plus the content digest",
    );
    assert.ok(
      workflow.includes("-f deploy-workbench/bifrost/gateway.Dockerfile"),
      "the workflow must build the gateway Dockerfile, not one of the other two",
    );
  });

  it("names the image the task definition resolves", () => {
    assert.equal(
      bifrostGatewayImageUri("example.ecr"),
      `example.ecr/bifrost-gateway:${BIFROST_GATEWAY_TAG}`,
    );
  });

  it("is the image the task definition and config.json meet at one path", () => {
    // The seam this pins is otherwise silent: `config.json` names a path, the
    // Dockerfile installs to it, and a mismatch is a dial that fails with
    // "no such file or directory" on the first connection rather than a
    // validation error.
    const config = JSON.parse(
      fs.readFileSync(BIFROST_CONFIG_SOURCE_PATH, "utf8"),
    ) as {
      config_store: { config: { password_command: { command: string } } };
      logs_store: { config: { password_command: { command: string } } };
    };
    assert.equal(
      config.config_store.config.password_command.command,
      BIFROST_PG_PASSWORD_CONTAINER_PATH,
    );
    assert.equal(
      config.logs_store.config.password_command.command,
      BIFROST_PG_PASSWORD_CONTAINER_PATH,
    );
  });

  it("documents where the secret's ARN and credentials come from", () => {
    // Source-level, because the behaviour is covered by pg-password.test.ts
    // against stub binaries; this pins the two facts a future edit would have to
    // think about before changing.
    //
    // 1. The ARN is an environment variable, not an argument: the schema's
    //    `args` are literal strings and nothing expands an `env.` reference in
    //    them.
    assert.ok(
      SCRIPT.includes("PG_SECRET_ARN"),
      "the command must read the secret ARN from the environment",
    );
    assert.ok(
      !SCRIPT.includes("--region "),
      "the region comes from the environment the task definition sets, not a flag the command would have to be told",
    );
    // 2. It reads AWSCURRENT, which is the stage RDS writes a rotation to, and
    //    nothing else: no AWSPENDING, no version list.
    assert.ok(SCRIPT.includes("--version-stage AWSCURRENT"));
    assert.ok(!SCRIPT.includes("--version-stage AWSPENDING"));
    // The JSON key is RDS's own (`RDS_PASSWORD_JSON_KEY` in `ecs.ts`), not a
    // second spelling of it in the command.
    assert.equal(RDS_PASSWORD_JSON_KEY, "password");
    assert.ok(
      SCRIPT.includes(`jq -er '.${RDS_PASSWORD_JSON_KEY}`),
      "the command must extract the key RDS writes, not a guess",
    );
    // And it prints the password and nothing else.
    assert.ok(!/echo\s+\$?\w*p/i.test(SCRIPT), "the command must not echo the value");
  });
});
