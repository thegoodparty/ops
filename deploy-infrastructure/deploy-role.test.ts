import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { infrastructureDeployRoleTrust } from "./deploy-role";

const MANAGEMENT_ACCOUNT_ID = "333022194791";

describe("infrastructureDeployRoleTrust", () => {
  // The trust is the whole control on an admin role. Widening it to the
  // management account root would recreate OrganizationAccountAccessRole,
  // which is what step 7's second PR exists to retire.
  it("admits only github-actions-infrastructure-deploy", () => {
    assert.equal(infrastructureDeployRoleTrust.Statement.length, 1);

    const [statement] = infrastructureDeployRoleTrust.Statement;
    assert.deepEqual(statement, {
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/github-actions-infrastructure-deploy`,
      },
      Action: "sts:AssumeRole",
    });
  });
});
