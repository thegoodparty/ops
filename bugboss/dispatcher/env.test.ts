import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AMBIENT_CREDENTIAL_VARS,
  buildChildEnv,
  isReservedChildEnvVar,
  pickBaseEnv,
} from "./env";

const aws = {
  accessKeyId: "ASIA-AGENT",
  secretAccessKey: "agent-secret",
  sessionToken: "agent-session",
  expiresAt: 1_700_000_000_000,
};

const input = (over: Partial<Parameters<typeof buildChildEnv>[0]> = {}) => ({
  credentials: {},
  aws,
  incidentId: "inc-1",
  token: "tok-1",
  sessionRef: null,
  deadlineAt: 1_699_000_000_000,
  attempt: 1,
  ...over,
});

describe("buildChildEnv", () => {
  it("drops every ambient AWS credential path", () => {
    const base: Record<string, string> = { PATH: "/usr/bin" };
    for (const name of AMBIENT_CREDENTIAL_VARS) base[name] = "leaked";

    const { env, stripped } = buildChildEnv(input({ base }));

    for (const name of AMBIENT_CREDENTIAL_VARS) {
      assert.equal(env[name], undefined, `${name} must not reach the child`);
      assert.ok(stripped.includes(name), `${name} must be reported as stripped`);
    }
    assert.equal(env.PATH, "/usr/bin");
  });

  it("injects the agent role credentials rather than the parent's", () => {
    const { env } = buildChildEnv(
      input({
        base: {
          AWS_ACCESS_KEY_ID: "PARENT-KEY",
          AWS_SECRET_ACCESS_KEY: "parent-secret",
          AWS_SESSION_TOKEN: "parent-session",
        },
      }),
    );

    assert.equal(env.AWS_ACCESS_KEY_ID, "ASIA-AGENT");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "agent-secret");
    assert.equal(env.AWS_SESSION_TOKEN, "agent-session");
    assert.equal(env.BUGBOSS_CREDENTIALS_EXPIRE_AT, String(aws.expiresAt));
  });

  it("passes the injected outbound credentials through", () => {
    const { env, stripped } = buildChildEnv(
      input({ credentials: { GITHUB_TOKEN: "ghs_x", GRAFANA_TOKEN: "glsa_y" } }),
    );

    assert.equal(env.GITHUB_TOKEN, "ghs_x");
    assert.equal(env.GRAFANA_TOKEN, "glsa_y");
    assert.deepEqual(stripped, []);
  });

  it("carries the per-incident identity the tool API needs", () => {
    const { env } = buildChildEnv(
      input({ incidentId: "inc-9", token: "tok-9", sessionRef: "s-9", attempt: 3 }),
    );

    assert.equal(env.BUGBOSS_INCIDENT_ID, "inc-9");
    assert.equal(env.BUGBOSS_TOKEN, "tok-9");
    assert.equal(env.BUGBOSS_SESSION_REF, "s-9");
    assert.equal(env.BUGBOSS_ATTEMPT, "3");
  });

  it("omits the session reference on a first launch", () => {
    const { env } = buildChildEnv(input({ sessionRef: null }));
    assert.equal(env.BUGBOSS_SESSION_REF, undefined);
  });

  it("matches reserved names case-insensitively", () => {
    assert.ok(isReservedChildEnvVar("aws_container_credentials_relative_uri"));
    assert.ok(isReservedChildEnvVar("AWS_SESSION_TOKEN"));
    assert.equal(isReservedChildEnvVar("GITHUB_TOKEN"), false);
  });
});

describe("pickBaseEnv", () => {
  it("takes only the named process essentials", () => {
    const picked = pickBaseEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      SLACK_BOT_TOKEN: "xoxb-secret",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds",
    });

    assert.deepEqual(picked, { PATH: "/usr/bin", HOME: "/root" });
  });

  it("skips names the parent does not have", () => {
    assert.deepEqual(pickBaseEnv({ PATH: "/usr/bin" }), { PATH: "/usr/bin" });
  });
});
