import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createAssumeRoleCredentials } from "./credentials";

/**
 * A task role is itself an assumed role, so the agent role is only ever
 * reached by role chaining, and AWS caps a chained session at one hour and
 * rejects a longer request outright. Asking for the role's twelve-hour
 * maxSessionDuration failed every launch with a ValidationError that no test
 * could see, because the tests inject a fake STS that honours any number.
 */
const ROLE_CHAINING_MAX_SECONDS = 3600;

const captureSts = () => {
  const sent: { DurationSeconds?: number; RoleArn?: string; RoleSessionName?: string }[] = [];
  return {
    sent,
    client: {
      send: async (command: { input: Record<string, unknown> }) => {
        sent.push(command.input);
        return {
          Credentials: {
            AccessKeyId: "AKIA",
            SecretAccessKey: "secret",
            SessionToken: "token",
            Expiration: new Date(0),
          },
        };
      },
    },
  };
};

describe("createAssumeRoleCredentials", () => {
  it("asks for no more than a chained session can be granted", async () => {
    const sts = captureSts();
    const provider = createAssumeRoleCredentials({
      roleArn: "arn:aws:iam::333022194791:role/bugboss-agent",
      sts: sts.client as never,
    });

    await provider("1");

    assert.equal(sts.sent.length, 1);
    assert.ok(
      (sts.sent[0].DurationSeconds ?? 0) <= ROLE_CHAINING_MAX_SECONDS,
      `requested ${sts.sent[0].DurationSeconds}s, which AWS rejects for a chained role`,
    );
  });

  it("names the session after the incident", async () => {
    const sts = captureSts();
    const provider = createAssumeRoleCredentials({
      roleArn: "arn:aws:iam::333022194791:role/bugboss-agent",
      sts: sts.client as never,
    });

    await provider("42");

    assert.equal(sts.sent[0].RoleSessionName, "bugboss-agent-42");
  });
});
