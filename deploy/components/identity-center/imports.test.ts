import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// Transcribed from the spec's tables, not from the component, so a drift
// between the two fails here. A wrong import id makes Pulumi replace a
// permission set on deploy, which revokes a whole group's AWS access.
const INSTANCE = "arn:aws:sso:::instance/ssoins-790711c2cafff252";
const PS = "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252";
const ENGINEER = `${PS}/ps-209e00e1c6a78a7b`;
const ADMIN = `${PS}/ps-ab3b34dd2d6db1b8`;
const READONLY = `${PS}/ps-790741c400f38152`;
const PRODUCT = `${PS}/ps-f75e5d9826239194`;
const BILLING = `${PS}/ps-7907e6ad83ceef38`;
const IAM = "arn:aws:iam::aws:policy";
const ACCOUNT = "333022194791";

const assignment = (group: string, ps: string) =>
  `${group},GROUP,${ACCOUNT},AWS_ACCOUNT,${ps},${INSTANCE}`;

const EXPECTED = [
  `PermissionSet ${ENGINEER},${INSTANCE}`,
  `PermissionSet ${ADMIN},${INSTANCE}`,
  `PermissionSet ${READONLY},${INSTANCE}`,
  `PermissionSet ${PRODUCT},${INSTANCE}`,
  `PermissionSet ${BILLING},${INSTANCE}`,
  `ManagedPolicyAttachment ${IAM}/AmazonS3FullAccess,${ENGINEER},${INSTANCE}`,
  `ManagedPolicyAttachment ${IAM}/ReadOnlyAccess,${ENGINEER},${INSTANCE}`,
  `ManagedPolicyAttachment ${IAM}/AdministratorAccess,${ADMIN},${INSTANCE}`,
  `ManagedPolicyAttachment ${IAM}/AWSSecretsManagerClientReadOnlyAccess,${READONLY},${INSTANCE}`,
  `ManagedPolicyAttachment ${IAM}/ReadOnlyAccess,${READONLY},${INSTANCE}`,
  `ManagedPolicyAttachment ${IAM}/job-function/Billing,${BILLING},${INSTANCE}`,
  `PermissionSetInlinePolicy ${ENGINEER},${INSTANCE}`,
  `PermissionSetInlinePolicy ${READONLY},${INSTANCE}`,
  `PermissionSetInlinePolicy ${PRODUCT},${INSTANCE}`,
  assignmentLine("383193a0-7001-70d9-a321-ffe6d8af7378", ENGINEER),
  assignmentLine("383193a0-7001-70d9-a321-ffe6d8af7378", READONLY),
  assignmentLine("88c1b330-a001-707a-06ca-94e289013bf5", ADMIN),
  assignmentLine("88c1b330-a001-707a-06ca-94e289013bf5", READONLY),
  assignmentLine("a8011350-50b1-701c-5b41-c0e4c9b30976", READONLY),
  assignmentLine("2841e390-5011-7007-ad5d-c906acf4807d", PRODUCT),
  assignmentLine("88313300-9031-70ed-ec00-bb80ba0e94e1", BILLING),
];

function assignmentLine(group: string, ps: string) {
  return `AccountAssignment ${assignment(group, ps)}`;
}

const capture = () => {
  const captured: string[] = [];
  const stub = (kind: string) =>
    class {
      constructor(_name: string, _args: unknown, opts: { import: string }) {
        captured.push(`${kind} ${opts.import}`);
      }
    };
  const fake = {
    ssoadmin: {
      PermissionSet: stub("PermissionSet"),
      ManagedPolicyAttachment: stub("ManagedPolicyAttachment"),
      PermissionSetInlinePolicy: stub("PermissionSetInlinePolicy"),
      AccountAssignment: stub("AccountAssignment"),
    },
  };
  const loader = Module as unknown as { _load: (...a: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (request: unknown, ...rest: unknown[]) {
    return request === "@pulumi/aws"
      ? fake
      : original.apply(this, [request, ...rest]);
  };
  try {
    // Required inside the stub window so the component picks up the fake.
    const { createIdentityCenter } = require("../identity-center");
    createIdentityCenter();
  } finally {
    loader._load = original;
  }
  return captured;
};

describe("identity center imports", () => {
  it("emits exactly the expected import ids", () => {
    assert.deepEqual(capture().sort(), [...EXPECTED].sort());
  });
});
