import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AWS_CREDENTIAL_PATH_VARS,
  buildAgentShellEnv,
  pickBaseEnv,
  withGitHubToken,
} from "./shell-env";

test("the container credential path is carried, so the shell runs on the task role", () => {
  const env = buildAgentShellEnv({
    base: { PATH: "/usr/bin", AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-role" },
    credentials: {},
  });

  assert.equal(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, "/v2/credentials/task-role");
  assert.equal(env.PATH, "/usr/bin");
});

test("the base env is picked by name, and nothing else of the parent's comes with it", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/node",
    BUGBOSS_SECRETS: "{\"slackBotToken\":\"xoxb-1\"}",
    SLACK_BOT_TOKEN: "xoxb-1",
    ...Object.fromEntries(AWS_CREDENTIAL_PATH_VARS.map((name) => [name, `v-${name}`])),
  };
  const env = buildAgentShellEnv({ base: pickBaseEnv(parent), credentials: {} });

  assert.equal(env.BUGBOSS_SECRETS, undefined);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.HOME, "/home/node");
  for (const name of AWS_CREDENTIAL_PATH_VARS) assert.equal(env[name], `v-${name}`);
});

test("the eval harness's overrides are passed, and production never sets them", () => {
  const picked = pickBaseEnv({
    PATH: "/usr/bin",
    BUGBOSS_OMNI_REPO: "https://github.com/o/sandbox.git",
    BUGBOSS_WORK_ROOT: "/tmp/run/work",
    BUGBOSS_GITHUB_TOKEN_FILE: "/tmp/run/token",
    BUGBOSS_REVIEW_SETTLE_SECONDS: "5",
    NODE_EXTRA_CA_CERTS: "/tmp/run/ca.pem",
    AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9000",
    AWS_ENDPOINT_URLS: "not an endpoint",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN",
  });

  assert.deepEqual(picked, {
    PATH: "/usr/bin",
    BUGBOSS_OMNI_REPO: "https://github.com/o/sandbox.git",
    BUGBOSS_WORK_ROOT: "/tmp/run/work",
    BUGBOSS_GITHUB_TOKEN_FILE: "/tmp/run/token",
    BUGBOSS_REVIEW_SETTLE_SECONDS: "5",
    NODE_EXTRA_CA_CERTS: "/tmp/run/ca.pem",
    AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9000",
  });
});

test("credentials are what the composition root names, and an unset one is absent, not empty", () => {
  const env = buildAgentShellEnv({
    credentials: { GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_1", GITHUB_APP_PRIVATE_KEY: undefined },
  });

  assert.equal(env.GRAFANA_SERVICE_ACCOUNT_TOKEN, "glsa_1");
  assert.equal("GITHUB_APP_PRIVATE_KEY" in env, false);
});

test("the GitHub token is added under both names gh and git read, or not at all", () => {
  assert.deepEqual(withGitHubToken({ PATH: "/bin" }, "ghs_1"), { PATH: "/bin", GITHUB_TOKEN: "ghs_1", GH_TOKEN: "ghs_1" });
  assert.deepEqual(withGitHubToken({ PATH: "/bin" }, undefined), { PATH: "/bin" });
});
