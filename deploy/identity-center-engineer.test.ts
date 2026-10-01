import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAdminReserved } from "./components/identity-center";
import { engineerAccess } from "./components/identity-center/policies";

// `EngineerAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `engineerAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(engineerAccess);

const asList = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? (value as string[])
      : [value as string];

describe("EngineerAccess", () => {
  // The grant that stops a laptop `pi` running under this profile invoking a
  // model and causing Bedrock to subscribe it in the management account.
  it("allows Bedrock reads and nothing else", () => {
    const allow = composed.Statement.find(
      (s) => s.Sid === "ReadBedrockCatalog"
    );
    assert.ok(allow, "no ReadBedrockCatalog statement");
    assert.equal(allow.Effect, "Allow");
    assert.deepEqual(asList(allow.Action), ["bedrock:Get*", "bedrock:List*"]);
  });

  // The two tag-conditioned blanket grants would otherwise reach Bedrock,
  // because `bedrock:InvokeModel` lists `aws:RequestTag` among its condition
  // keys. Excluding Bedrock from them is what makes the read grant above the
  // only Bedrock path. A Deny with `NotAction` is the obvious alternative and
  // is wrong: `NotAction` is evaluated across every service, so it would deny
  // S3, SQS, Transcribe and the rest of the set too.
  it("excludes Bedrock from both tag-conditioned blanket grants", () => {
    for (const sid of ["DevResourceOperations", "DevResourceCreation"]) {
      const statement = composed.Statement.find((s) => s.Sid === sid);
      assert.ok(statement, `no ${sid} statement`);
      assert.equal(statement.Effect, "Allow");
      assert.deepEqual(asList(statement.NotAction), ["bedrock:*"]);
      assert.equal(statement.Action, undefined, `${sid} still names Action`);
    }
  });

  // A regression can also take the shape of a new explicit invoke Allow, which
  // the exclusions above would not catch.
  it("names no Bedrock invocation in an Allow", () => {
    const forbidden = /^bedrock:(Invoke|Converse|StartAsync)/;
    for (const statement of composed.Statement) {
      if (statement.Effect !== "Allow") continue;
      for (const action of asList(statement.Action)) {
        assert.equal(
          forbidden.test(action),
          false,
          `${statement.Sid ?? "(no Sid)"} allows ${action}`
        );
      }
    }
  });
});
