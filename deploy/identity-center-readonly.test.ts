import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readOnlyAccess } from "./components/identity-center/policies";

const actionsOf = (s: (typeof readOnlyAccess.Statement)[number]) =>
  Array.isArray(s.Action) ? s.Action : [s.Action];

describe("readOnlyAccess", () => {
  // The set is attached to humans (Engineers, Admins, Research) in the
  // management account, so the inline policy is the one place a write could
  // hide behind the two managed read-only policies. Keep it to the single
  // cross-account preview hop.
  it("adds no allow beyond the workbench preview assume", () => {
    const allows = readOnlyAccess.Statement.filter((s) => s.Effect === "Allow");
    assert.equal(allows.length, 1);
    assert.deepEqual(actionsOf(allows[0]), ["sts:AssumeRole"]);
    assert.equal(
      allows[0].Resource,
      "arn:aws:iam::024901689212:role/pulumi-preview"
    );
  });

  it("still denies prod-tagged SSM parameters", () => {
    const deny = readOnlyAccess.Statement.find((s) => s.Effect === "Deny");
    assert.ok(deny);
    assert.equal(
      (deny.Condition?.StringEquals as Record<string, unknown>)[
        "aws:ResourceTag/Environment"
      ],
      "prod"
    );
    assert.ok(
      ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"].every(
        (a) => actionsOf(deny).includes(a)
      )
    );
  });
});
