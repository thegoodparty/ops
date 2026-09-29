import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AWS_CREDENTIAL_PATH_VARS,
  buildChildEnv,
  hasAwsCredentialPath,
  pickBaseEnv,
} from "./env";

const input = (over: Partial<Parameters<typeof buildChildEnv>[0]> = {}) => ({
  credentials: {},
  incidentId: "inc-1",
  token: "tok-1",
  sessionRef: null,
  deadlineAt: 1_699_000_000_000,
  maxTurns: 200,
  attempt: 1,
  ...over,
});

describe("buildChildEnv", () => {
  it("carries the container credential path so the child runs on the task role", () => {
    const env = buildChildEnv(
      input({
        base: {
          PATH: "/usr/bin",
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-role",
        },
      }),
    );

    assert.equal(
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
      "/v2/credentials/task-role",
    );
    assert.equal(env.PATH, "/usr/bin");
    assert.ok(hasAwsCredentialPath(env));
  });

  it("builds from the two named sources and nothing else", () => {
    const env = buildChildEnv(input({ base: { PATH: "/usr/bin" } }));

    assert.deepEqual(Object.keys(env).sort(), [
      "BUGBOSS_ATTEMPT",
      "BUGBOSS_DEADLINE_AT",
      "BUGBOSS_INCIDENT_ID",
      "BUGBOSS_MAX_TURNS",
      "BUGBOSS_TOKEN",
      "PATH",
    ]);
    assert.equal(hasAwsCredentialPath(env), false);
  });

  // The child builds its environment from nothing, so a bound the parent
  // holds and does not hand down is a bound that does not exist: the agent
  // falls back to its own default and BUGBOSS_MAX_TURNS in the task
  // definition becomes a setting nobody can change and nothing reports.
  it("hands the turn budget down, or it is a setting that does nothing", () => {
    const env = buildChildEnv(input({ maxTurns: 40 }));

    assert.equal(env.BUGBOSS_MAX_TURNS, "40");
  });

  it("passes the injected outbound credentials through", () => {
    const env = buildChildEnv(
      input({ credentials: { GITHUB_TOKEN: "ghs_x", GRAFANA_TOKEN: "glsa_y" } }),
    );

    assert.equal(env.GITHUB_TOKEN, "ghs_x");
    assert.equal(env.GRAFANA_TOKEN, "glsa_y");
  });

  it("carries the per-incident identity the tool API needs", () => {
    const env = buildChildEnv(
      input({ incidentId: "inc-9", token: "tok-9", sessionRef: "s-9", attempt: 3 }),
    );

    assert.equal(env.BUGBOSS_INCIDENT_ID, "inc-9");
    assert.equal(env.BUGBOSS_TOKEN, "tok-9");
    assert.equal(env.BUGBOSS_SESSION_REF, "s-9");
    assert.equal(env.BUGBOSS_ATTEMPT, "3");
  });

  it("omits the session reference on a first launch", () => {
    const env = buildChildEnv(input({ sessionRef: null }));
    assert.equal(env.BUGBOSS_SESSION_REF, undefined);
  });
});

describe("pickBaseEnv", () => {
  it("takes the process essentials and the AWS credential path, nothing else", () => {
    const picked = pickBaseEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds",
      SLACK_BOT_TOKEN: "xoxb-secret",
      BUGBOSS_SECRETS: '{"GITHUB_APP_PRIVATE_KEY":"-----BEGIN"}',
    });

    assert.deepEqual(picked, {
      PATH: "/usr/bin",
      HOME: "/root",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds",
    });
  });

  it("skips names the parent does not have", () => {
    assert.deepEqual(pickBaseEnv({ PATH: "/usr/bin" }), { PATH: "/usr/bin" });
  });
});

describe("hasAwsCredentialPath", () => {
  it("accepts any of the container provider's variables", () => {
    for (const name of AWS_CREDENTIAL_PATH_VARS) {
      assert.ok(hasAwsCredentialPath({ [name]: "x" }), name);
    }
  });

  it("rejects an environment that carries none of them", () => {
    assert.equal(hasAwsCredentialPath({ PATH: "/usr/bin" }), false);
  });
});
