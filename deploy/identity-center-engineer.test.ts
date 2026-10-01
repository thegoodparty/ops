import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAdminReserved } from "./components/identity-center";
import { engineerAccess } from "./components/identity-center/policies";

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
