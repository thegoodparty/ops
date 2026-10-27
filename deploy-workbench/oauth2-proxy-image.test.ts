import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH,
  OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_ALLOWLIST_PATH,
  OAUTH2_PROXY_CONTENT_DIGEST,
  OAUTH2_PROXY_CONTENT_INPUTS,
  OAUTH2_PROXY_INJECTED_AUTHORIZATION_ENV,
  OAUTH2_PROXY_REPOSITORY_NAME,
  OAUTH2_PROXY_REPOSITORY_ROOT,
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
const ALPHA_CONFIG = path.resolve(__dirname, "bifrost/alpha-config.yaml");
const ENTRYPOINT = path.resolve(__dirname, "bifrost/entrypoint.go");
const ENTRYPOINT_TEST = path.resolve(__dirname, "bifrost/entrypoint_test.go");

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
  // The tag is content-addressed over every committed build input, so a change
  // to any of them is a new tag and a push. Hashing the allowlist alone was
  // right while the image was a one-line derivative; it stopped being right
  // when the Dockerfile grew an alpha configuration and an entrypoint wrapper,
  // because a deploy would then name an image without them and the injection
  // would never happen.
  it("derives the content tag from every build input the module hashes", () => {
    const expectedDigest = OAUTH2_PROXY_CONTENT_INPUTS.reduce(
      (hash, relativePath) =>
        hash.update(
          fs.readFileSync(
            path.join(OAUTH2_PROXY_REPOSITORY_ROOT, relativePath),
          ),
        ),
      crypto.createHash("sha256"),
    )
      .digest("hex")
      .slice(0, 12);

    assert.equal(
      OAUTH2_PROXY_CONTENT_DIGEST,
      expectedDigest,
      "OAUTH2_PROXY_CONTENT_DIGEST must be the sha256 over every input, in order",
    );
    assert.equal(
      OAUTH2_PROXY_TAG,
      `${OAUTH2_PROXY_UPSTREAM_TAG}-${expectedDigest}`,
      "OAUTH2_PROXY_TAG must be the upstream tag plus the content digest",
    );

    // Every input has to be a file the image is actually built from, and the
    // allowlist has to be the first one so the order is not an accident.
    assert.equal(
      OAUTH2_PROXY_CONTENT_INPUTS[0],
      "deploy-workbench/bifrost/allowed-emails.txt",
    );
    for (const relativePath of OAUTH2_PROXY_CONTENT_INPUTS) {
      assert.ok(
        fs.existsSync(path.join(OAUTH2_PROXY_REPOSITORY_ROOT, relativePath)),
        `${relativePath} is hashed but does not exist`,
      );
    }
    for (const required of [
      "deploy-workbench/bifrost/Dockerfile",
      "deploy-workbench/bifrost/alpha-config.yaml",
      "deploy-workbench/bifrost/entrypoint.go",
      "deploy-workbench/bifrost/entrypoint_test.go",
      "deploy-workbench/bifrost/go.mod",
    ]) {
      assert.ok(
        (OAUTH2_PROXY_CONTENT_INPUTS as readonly string[]).includes(required),
        `${required} builds the image but is not part of its content digest`,
      );
    }

    // The workflow cannot import the module, so it `cat`s the same list in the
    // same order. Pinning the whole command rather than the variable name is
    // what makes a file added to one side and not the other a test failure.
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes(
        `content_digest="$(cat ${OAUTH2_PROXY_CONTENT_INPUTS.join(" ")} | sha256sum | cut -c1-12)"`,
      ),
      "the workflow must derive the tag from the same inputs, in the same order, that OAUTH2_PROXY_CONTENT_INPUTS lists",
    );
    assert.ok(
      workflow.includes(
        'image_tag="${OAUTH2_PROXY_UPSTREAM_TAG}-${content_digest}"',
      ),
      "the workflow must build the image tag as the upstream tag plus the content digest",
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

  it("bakes the alpha configuration the sidecar's flag names", () => {
    // The alpha file is what carries `injectRequestHeaders`, so it has to be in
    // the image, at the path `ecs.ts` passes to `--alpha-config`. A COPY that
    // wrote it somewhere else would leave oauth2-proxy failing to start with a
    // missing file (fail closed, but a pointless outage).
    assert.equal(
      OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH,
      "/etc/oauth2-proxy/alpha-config.yaml",
    );
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    assert.ok(
      dockerfile.includes(
        `COPY alpha-config.yaml ${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
      ),
      `the derived image must COPY alpha-config.yaml to ${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
    );
  });

  // This is the mechanism behind "no human meets a second login": the header
  // oauth2-proxy adds to the upstream request, sourced from an environment
  // variable rather than from the file, and stripped from the client's request
  // first. Each of those is a property of the YAML, so each is asserted here.
  it("injects the admin credential as a request header from the environment", () => {
    const alpha = fs.readFileSync(ALPHA_CONFIG, "utf8");

    assert.match(alpha, /^injectRequestHeaders:$/m);
    assert.match(alpha, /^ {2}- name: Authorization$/m);
    assert.match(
      alpha,
      new RegExp(
        `^ {10}fromEnv: ${OAUTH2_PROXY_INJECTED_AUTHORIZATION_ENV}$`,
        "m",
      ),
      `the injected header must read ${OAUTH2_PROXY_INJECTED_AUTHORIZATION_ENV}`,
    );

    // `value:` would put the credential in a committed file. The source has to
    // be the environment, which the container derives at start.
    assert.ok(
      !/secretSource:\s*\n\s*value:/.test(alpha),
      "the injected credential must not be a literal in the alpha config",
    );

    // Stripped-then-set: `preserveRequestValue` defaults to false upstream, so
    // a client's own Authorization header is removed before this one is added.
    // Setting it true here would let a caller smuggle a credential upstream.
    assert.ok(
      !/^\s*preserveRequestValue:/m.test(alpha),
      "preserveRequestValue must stay at its default (false): the injected header replaces the client's",
    );
  });

  it("keeps the two Google credentials as injected secrets, not file literals", () => {
    // The provider moved into the alpha file, but the client pair is still a
    // secret: alpha config substitutes `${...}` at load time from the
    // environment the task definition injects.
    const alpha = fs.readFileSync(ALPHA_CONFIG, "utf8");
    assert.match(alpha, /^ {4}clientID: \$\{OAUTH2_PROXY_CLIENT_ID\}$/m);
    assert.match(
      alpha,
      /^ {4}clientSecret: \$\{OAUTH2_PROXY_CLIENT_SECRET\}$/m,
    );
  });

  // The wrapper is the half that makes the injection fail closed, and it is
  // built from committed Go rather than from anything pinned upstream, so the
  // YAML, the Go source and the task definition have to name the same three
  // variables.
  it("names the same credential variables in the wrapper as the alpha config", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    assert.ok(
      entrypoint.includes(
        `AuthorizationEnv = "${OAUTH2_PROXY_INJECTED_AUTHORIZATION_ENV}"`,
      ),
      `entrypoint.go must export ${OAUTH2_PROXY_INJECTED_AUTHORIZATION_ENV}, the variable the alpha config reads`,
    );
    assert.ok(
      entrypoint.includes('UsernameEnv = "BIFROST_ADMIN_USERNAME"'),
      "entrypoint.go must read BIFROST_ADMIN_USERNAME",
    );
    assert.ok(
      entrypoint.includes('PasswordEnv = "BIFROST_ADMIN_PASSWORD"'),
      "entrypoint.go must read BIFROST_ADMIN_PASSWORD",
    );
    // The same two names are the keys the task definition injects; that side is
    // pinned in `ecs.test.ts`, against the same literals.
    assert.ok(
      entrypoint.includes("alphaConfigFlag = \"--alpha-config\""),
      "entrypoint.go must refuse to start the proxy without --alpha-config",
    );
  });

  // The runtime image is `gcr.io/distroless/static:nonroot`: no shell, no
  // coreutils. The wrapper gets there as a static binary built in a stage of
  // its own, and its own tests run during the build -- which is what stops a
  // wrapper that does not fail closed from ever reaching ECR.
  it("builds the entrypoint wrapper statically and tests it during the build", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    assert.ok(
      dockerfile.includes("AS entrypoint"),
      "the wrapper must be built in its own stage",
    );
    assert.ok(
      dockerfile.includes("CGO_ENABLED=0"),
      "the wrapper must be static: the runtime image has no dynamic loader",
    );
    assert.ok(
      dockerfile.includes("go test ./..."),
      "the wrapper's fail-closed tests must run during the image build",
    );
    assert.ok(
      dockerfile.includes(
        "COPY --from=entrypoint /out/bifrost-oauth2-entrypoint /bin/bifrost-oauth2-entrypoint",
      ),
      dockerfile,
    );
    assert.ok(
      dockerfile.includes(
        'ENTRYPOINT ["/bin/bifrost-oauth2-entrypoint"]',
      ),
      "the wrapper must replace the image's own entrypoint",
    );
    // The Dockerfile says why the wrapper exists in Go; the tests themselves
    // live beside it and are hashed into the tag above.
    assert.ok(fs.existsSync(ENTRYPOINT_TEST));
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
