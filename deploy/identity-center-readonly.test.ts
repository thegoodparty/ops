import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readOnlyManagedPolicies,
  withAdminReserved,
} from "./components/identity-center";
import { readOnlyAccess } from "./components/identity-center/policies";

// `ReadOnlyAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `readOnlyAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(readOnlyAccess);

const actionsOf = (s: (typeof composed.Statement)[number]) =>
  Array.isArray(s.Action) ? s.Action : [s.Action];

describe("ReadOnlyAccess", () => {
  // The set is attached to humans (Engineers, Admins, Research) in the
  // management account, so the composed inline policy is the one place a write
  // could hide behind the managed read-only policy. Keep it to the single
  // cross-account preview hop.
  it("adds no allow beyond the workbench preview assume", () => {
    const allows = composed.Statement.filter((s) => s.Effect === "Allow");
    assert.equal(allows.length, 1);
    assert.deepEqual(actionsOf(allows[0]), ["sts:AssumeRole"]);
    assert.equal(
      allows[0].Resource,
      "arn:aws:iam::024901689212:role/pulumi-preview"
    );
  });

  // `AWSSecretsManagerClientReadOnlyAccess` used to be attached here and its
  // policy grants `GetSecretValue`, so the set read secret values. It is gone;
  // `ReadOnlyAccess` carries the metadata reads.
  it("attaches only the metadata read policy", () => {
    assert.deepEqual(readOnlyManagedPolicies, [
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });

  it("still denies prod-tagged SSM parameters", () => {
    const deny = composed.Statement.find(
      (s) =>
        s.Effect === "Deny" &&
        (s.Condition?.StringEquals as Record<string, unknown> | undefined)?.[
          "aws:ResourceTag/Environment"
        ] === "prod"
    );
    assert.ok(deny);
    assert.ok(
      ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"].every(
        (a) => actionsOf(deny).includes(a)
      )
    );
  });
});
