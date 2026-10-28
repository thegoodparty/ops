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
  OAUTH2_PROXY_INJECTED_HEADER_NAME,
  OAUTH2_PROXY_SETUP_TOKEN_ENV,
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
  //
  // There are two `FROM` lines on the upstream image -- the config check and the
  // runtime stage -- and both have to be the pinned reference: a floating one in
  // either place is an image built from something other than the reviewed pin.
  it("pins the same upstream reference on every stage the Dockerfile builds from", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    const upstreamFroms = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("FROM ") && line.includes("oauth2-proxy"));
    assert.ok(
      upstreamFroms.length >= 2,
      `expected the config-check and runtime stages to both name the upstream image, found ${upstreamFroms.length}`,
    );
    for (const line of upstreamFroms) {
      assert.ok(
        line === `FROM ${OAUTH2_PROXY_UPSTREAM_IMAGE}` ||
          line === `FROM ${OAUTH2_PROXY_UPSTREAM_IMAGE} AS alpha-config-check`,
        `bifrost/Dockerfile's \`${line}\` drifted from OAUTH2_PROXY_UPSTREAM_IMAGE in oauth2-proxy-image.ts`,
      );
    }
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
  // when the Dockerfile grew an alpha configuration, because a deploy would
  // then name an image without it and the setup-token header would never be
  // injected.
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
    // the image, at the path `ecs.ts` passes to `--alpha-config`. It is copied
    // from the stage that ran `--config-test` over it, so the file that ships is
    // the file the pinned release accepted.
    assert.equal(
      OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH,
      "/etc/oauth2-proxy/alpha-config.yaml",
    );
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    assert.ok(
      dockerfile.includes(
        `COPY --from=alpha-config-check ${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH} ${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
      ),
      `the derived image must COPY the validated alpha-config.yaml to ${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
    );
  });

  // The alpha structure may change between minor releases, and the failure mode
  // at this tag is at container start rather than at build time. This stage is
  // what turns a bump that renames a key into a failed image build: a task drain
  // followed by a sidecar that will not start is the outage it prevents.
  it("fails the image build when the pinned release rejects the alpha configuration", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");

    const start = dockerfile.indexOf("AS alpha-config-check");
    assert.ok(start >= 0, "the Dockerfile has no alpha-config-check stage");
    const rest = dockerfile.slice(start);
    const stage = rest.slice(0, rest.indexOf("\nFROM "));

    assert.ok(
      stage.includes(
        `COPY alpha-config.yaml ${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
      ),
      "the check stage must validate the committed alpha-config.yaml",
    );
    // `--config-test` is what loads the alpha file through the same loader the
    // server uses and exits non-zero on an unknown or removed key.
    assert.ok(
      stage.includes(
        `RUN ["/bin/oauth2-proxy", "--alpha-config=${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}", "--config-test"]`,
      ),
      "the check stage must run oauth2-proxy --config-test over the baked alpha config",
    );
    // It needs the values the alpha file and the core options resolve by name,
    // and they have to be dummies: nothing real is baked into the image.
    for (const name of [
      "OAUTH2_PROXY_CLIENT_ID",
      "OAUTH2_PROXY_CLIENT_SECRET",
      "OAUTH2_PROXY_COOKIE_SECRET",
      "OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE",
      "OAUTH2_PROXY_REDIRECT_URL",
      "OAUTH2_PROXY_WHITELIST_DOMAINS",
      "BIFROST_SETUP_TOKEN",
    ]) {
      assert.ok(stage.includes(name), `the check stage does not set ${name}`);
    }
    assert.ok(
      stage.includes("build-time-config-check-not-a-real-client-secret"),
      "the check stage's client secret must be an obvious dummy",
    );
  });

  // This is the mechanism behind "no human meets a second gate": the header
  // oauth2-proxy adds to the upstream request, sourced from the environment
  // variable rather than from the file, and stripped from the client's request
  // first. Each of those is a property of the YAML, so each is asserted here.
  //
  // The header is Bifrost's setup token, not a Basic admin credential: with
  // `governance.auth_config.is_enabled` false there is no login to answer, but
  // the OSS setup lock still gates `/api` and this is what satisfies it.
  it("injects the setup token as a request header from the environment", () => {
    const alpha = fs.readFileSync(ALPHA_CONFIG, "utf8");

    assert.match(alpha, /^injectRequestHeaders:$/m);
    assert.match(
      alpha,
      new RegExp(`^ {2}- name: ${OAUTH2_PROXY_INJECTED_HEADER_NAME}$`, "m"),
      `the injected header must be ${OAUTH2_PROXY_INJECTED_HEADER_NAME}`,
    );
    assert.match(
      alpha,
      new RegExp(`^ {10}fromEnv: ${OAUTH2_PROXY_SETUP_TOKEN_ENV}$`, "m"),
      `the injected header must read ${OAUTH2_PROXY_SETUP_TOKEN_ENV}`,
    );
    // The name has to be the one Bifrost's own middleware reads, and the one
    // the claim container sends; a rename here is a 401 on every /api call.
    assert.equal(OAUTH2_PROXY_INJECTED_HEADER_NAME, "X-Bifrost-Setup-Token");
    assert.equal(OAUTH2_PROXY_SETUP_TOKEN_ENV, "BIFROST_SETUP_TOKEN");

    // `value:` would put the credential in a committed file. The source has to
    // be the environment the task definition injects.
    assert.ok(
      !/secretSource:\s*\n\s*value:/.test(alpha),
      "the injected credential must not be a literal in the alpha config",
    );

    // Stripped-then-set: `preserveRequestValue` defaults to false upstream, so
    // a client's own header of this name is removed before this one is added.
    // Setting it true here would let a caller smuggle the setup token.
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

  // The wrapper used to compute `base64(admin_username:admin_password)` for
  // Bifrost's Basic login. With dashboard auth off there is no password to
  // encode and the token the header needs is already an environment variable,
  // so the wrapper, its Go stage and its tests were removed rather than left
  // as a second thing to maintain. This is the assertion that they stay gone:
  // a re-added ENTRYPOINT override would silently bypass upstream's own and
  // the image would start nothing.
  it("has no entrypoint wrapper, and starts the upstream binary directly", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    assert.ok(
      !dockerfile.includes("AS entrypoint"),
      "the base64 wrapper stage was removed with the Basic credential; it must not come back",
    );
    assert.ok(
      !dockerfile.includes("bifrost-oauth2-entrypoint"),
      "the wrapper binary was removed with the Basic credential; it must not come back",
    );
    assert.ok(
      !/^ENTRYPOINT /m.test(dockerfile),
      "the image must keep upstream's own ENTRYPOINT so `--alpha-config` reaches oauth2-proxy",
    );
    for (const removed of [
      path.resolve(__dirname, "bifrost/entrypoint.go"),
      path.resolve(__dirname, "bifrost/entrypoint_test.go"),
      path.resolve(__dirname, "bifrost/go.mod"),
    ]) {
      assert.ok(
        !fs.existsSync(removed),
        `${removed} is dead weight with dashboard auth off and must stay deleted`,
      );
    }
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
