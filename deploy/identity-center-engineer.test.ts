import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { withAdminReserved } from "./components/identity-center";
import { engineerAccess } from "./components/identity-center/policies";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";

// `EngineerAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `engineerAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(engineerAccess);

// A deliberate second copy of `BEDROCK_SERVICE_PREFIXES` in the policy module.
// The duplication is the point: adding a prefix there without extending the
// exclusions and the read grant here fails this test. Nothing can detect a
// prefix AWS adds later, so that case is a comment in the policy, not a test.
const BEDROCK_FAMILY = [
  "bedrock",
  "bedrock-agentcore",
  "bedrock-mantle",
  "bedrock-websearch",
];

const asList = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? (value as string[])
      : [value as string];

describe("EngineerAccess", () => {
  // The grant that stops a laptop `pi` running under this profile invoking a
  // model and causing Bedrock to subscribe it in the management account.
  it("allows Bedrock-family reads and nothing else", () => {
    const allow = composed.Statement.find(
      (s) => s.Sid === "ReadBedrockCatalog"
    );
    assert.ok(allow, "no ReadBedrockCatalog statement");
    assert.equal(allow.Effect, "Allow");
    assert.deepEqual(
      asList(allow.Action),
      BEDROCK_FAMILY.flatMap((prefix) => [
        `${prefix}:Get*`,
        `${prefix}:List*`,
      ])
    );
  });

  // The two tag-conditioned blanket grants would otherwise reach the Bedrock
  // family, because its invoke and create actions list `aws:RequestTag` among
  // their condition keys. Excluding the whole family, not just `bedrock:*`, is
  // what makes the read grant above the only Bedrock path. A Deny with
  // `NotAction` is the obvious alternative and is wrong: `NotAction` is
  // evaluated across every service, so it would deny S3, SQS, Transcribe and
  // the rest of the set too.
  it("excludes the whole Bedrock family from both blanket grants", () => {
    const expected = BEDROCK_FAMILY.map((prefix) => `${prefix}:*`);
    for (const sid of ["DevResourceOperations", "DevResourceCreation"]) {
      const statement = composed.Statement.find((s) => s.Sid === sid);
      assert.ok(statement, `no ${sid} statement`);
      assert.equal(statement.Effect, "Allow");
      assert.deepEqual(asList(statement.NotAction), expected);
      assert.equal(statement.Action, undefined, `${sid} still names Action`);
    }
  });

  // A regression can also take the shape of a new explicit Allow for an invoke
  // or mutation, which the exclusions above would not catch.
  it("allows no Bedrock-family action other than a read", () => {
    const family = /^(bedrock|bedrock-agentcore|bedrock-mantle|bedrock-websearch):/;
    const read = /^(bedrock|bedrock-agentcore|bedrock-mantle|bedrock-websearch):(Get|List)/;
    for (const statement of composed.Statement) {
      if (statement.Effect !== "Allow") continue;
      for (const action of asList(statement.Action)) {
        if (!family.test(action)) continue;
        assert.ok(
          read.test(action),
          `${statement.Sid ?? "(no Sid)"} allows non-read ${action}`
        );
      }
    }
  });
});

describe("EngineerAccess swarm host recovery", () => {
  const statement = (sid: string) => {
    const found = composed.Statement.find((s) => s.Sid === sid);
    assert.ok(found, `no ${sid} statement`);
    return found;
  };

  it("allows reboot, start and stop on infrastructure instances only", () => {
    const recover = statement("RecoverInfrastructureInstances");
    assert.equal(recover.Effect, "Allow");
    assert.deepEqual(asList(recover.Action), [
      "ec2:RebootInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
    ]);
    assert.deepEqual(asList(recover.Resource), [
      `arn:aws:ec2:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:instance/*`,
    ]);
  });

  // The README's `aws ssm start-session --target <id>` names no document, so
  // the default shell document is the only one it needs.
  it("allows a shell session on infrastructure instances only", () => {
    const start = statement("StartInfrastructureShellSessions");
    assert.equal(start.Effect, "Allow");
    assert.deepEqual(asList(start.Action), ["ssm:StartSession"]);
    assert.deepEqual(asList(start.Resource), [
      `arn:aws:ec2:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:instance/*`,
      `arn:aws:ssm:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:document/SSM-SessionManagerRunShell`,
    ]);
  });

  // `${aws:username}` is absent for an Identity Center role session, so a
  // session ARN built from it would match nothing. The session-id tag is AWS's
  // documented method for federated callers.
  it("lets a caller resume and end only their own sessions", () => {
    const own = statement("ManageOwnInfrastructureSessions");
    assert.equal(own.Effect, "Allow");
    assert.deepEqual(asList(own.Action), [
      "ssm:ResumeSession",
      "ssm:TerminateSession",
    ]);
    assert.deepEqual(asList(own.Resource), [
      `arn:aws:ssm:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:session/*`,
    ]);
    assert.deepEqual(own.Condition, {
      StringLike: {
        "ssm:resourceTag/aws:ssmmessages:session-id": "${aws:userid}*",
      },
    });
  });

  // The set is also assigned in the main account, where production runs. No
  // statement may reach a session or an instance state change there.
  it("grants session and instance state actions in no other account", () => {
    const scoped =
      /^(ssm:(StartSession|ResumeSession|TerminateSession)|ec2:(RebootInstances|StartInstances|StopInstances))$/;
    for (const s of composed.Statement) {
      if (s.Effect !== "Allow") continue;
      if (!asList(s.Action).some((a) => scoped.test(a))) continue;
      for (const resource of asList(s.Resource)) {
        assert.ok(
          resource.split(":")[4] === INFRASTRUCTURE_ACCOUNT_ID,
          `${s.Sid ?? "(no Sid)"} reaches ${resource}`
        );
      }
    }
  });

  it("is not denied by the admin guardrails", () => {
    const denied = composed.Statement.filter((s) => s.Effect === "Deny")
      .flatMap((s) => asList(s.Action))
      .filter((a) => /^(ec2:|ssm:(\*|Start|Resume|Terminate))/.test(a));
    assert.deepEqual(denied, []);
  });

  // `accounts` is private to the component, so this reads the source, the
  // same way identity-center-administrator.test.ts does.
  it("assigns EngineerAccess to Engineers in the infrastructure account", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "components/identity-center.ts"),
      "utf8"
    );
    const infrastructure = source.match(
      /infrastructure: \{\s*id: INFRASTRUCTURE_ACCOUNT_ID,[\s\S]*?assignments: \{([\s\S]*?)\}/
    );
    assert.ok(infrastructure, "no infrastructure account entry");
    assert.match(infrastructure[1], /Engineers: \["engineer"\],/);
  });
});
