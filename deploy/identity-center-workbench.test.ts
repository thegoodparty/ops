import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAdminReserved } from "./components/identity-center";
import { workbenchAccess } from "./components/identity-center/policies";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";

// `WorkbenchAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `workbenchAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(workbenchAccess);

const actionsOf = (s: (typeof composed.Statement)[number]) =>
  Array.isArray(s.Action) ? s.Action : [s.Action];

describe("WorkbenchAccess", () => {
  // The set is the entire session for an engineer's sandbox, and the account is
  // meant to hold Bedrock traffic and nothing worth reading. The Brave key the
  // web search tool needs is the one exception, and it is deliberately the only
  // secretsmanager or ssm permission in the document.
  it("allows GetSecretValue on the gp-pi Brave secret and nothing else", () => {
    const reads = composed.Statement.filter(
      (s) =>
        s.Effect === "Allow" &&
        actionsOf(s).includes("secretsmanager:GetSecretValue")
    );

    assert.equal(reads.length, 1);
    assert.deepEqual(actionsOf(reads[0]), ["secretsmanager:GetSecretValue"]);
    assert.equal(
      reads[0].Resource,
      `arn:aws:secretsmanager:us-west-2:${WORKBENCH_ACCOUNT_ID}:secret:gp-pi/brave-search-??????`
    );
  });

  it("grants no other secretsmanager or ssm action", () => {
    const others = composed.Statement.filter((s) => s.Effect === "Allow")
      .flatMap(actionsOf)
      .filter(
        (a) =>
          /^(secretsmanager|ssm):/.test(a) &&
          a !== "secretsmanager:GetSecretValue"
      );

    assert.deepEqual(others, []);
  });

  // The admin guardrails are prepended to every set, and none of them names
  // secretsmanager or ssm today. Asserted so that adding one later is a visible
  // change here rather than a silent deny of the Brave read.
  it("does not deny the secret read through the admin guardrails", () => {
    const denies = composed.Statement.filter((s) => s.Effect === "Deny")
      .flatMap(actionsOf)
      .filter((a) => /^(secretsmanager|ssm):/.test(a));

    assert.deepEqual(denies, []);
  });
});
