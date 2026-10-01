import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAdminReserved } from "./components/identity-center";
import { engineerAccess } from "./components/identity-center/policies";

// `EngineerAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `engineerAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(engineerAccess);

describe("EngineerAccess", () => {
  // The control that stops a laptop `pi` running under this profile invoking a
  // model and causing Bedrock to subscribe it in the management account. A read
  // allowlist expressed as `NotAction`, so a Bedrock action added later is
  // denied by default rather than admitted until someone remembers this file.
  it("denies every Bedrock action that is not a read", () => {
    const deny = composed.Statement.find(
      (s) => s.Sid === "DenyBedrockNonRead"
    );
    assert.ok(deny, "no DenyBedrockNonRead statement");
    assert.equal(deny.Effect, "Deny");
    assert.equal(deny.Resource, "*");
    assert.deepEqual(deny.NotAction, ["bedrock:Get*", "bedrock:List*"]);
  });

  // Belt and braces with the Deny above: an explicit Allow for an invocation
  // would be dead code today, but it reads as intent and is the shape a
  // regression takes.
  it("names no Bedrock invocation in an Allow", () => {
    const forbidden = /^bedrock:(Invoke|Converse|StartAsync)/;
    for (const statement of composed.Statement) {
      if (statement.Effect !== "Allow") continue;
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : statement.Action
          ? [statement.Action]
          : [];
      for (const action of actions) {
        assert.equal(
          forbidden.test(action),
          false,
          `${statement.Sid ?? "(no Sid)"} allows ${action}`
        );
      }
    }
  });
});
