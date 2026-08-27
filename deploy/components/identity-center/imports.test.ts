import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// Transcribed by hand from identity-center.ts's own SETS/GROUPS tables and
// spelled out fully expanded (no shared constants with the component) so
// this test fails if the component's ids drift, not just if its shape does.
const EXPECTED_IMPORTS = [
  "PermissionSet arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-209e00e1c6a78a7b,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSet arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-ab3b34dd2d6db1b8,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSet arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSet arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-f75e5d9826239194,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSet arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-7907e6ad83ceef38,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "ManagedPolicyAttachment arn:aws:iam::aws:policy/AmazonS3FullAccess,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-209e00e1c6a78a7b,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "ManagedPolicyAttachment arn:aws:iam::aws:policy/ReadOnlyAccess,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-209e00e1c6a78a7b,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "ManagedPolicyAttachment arn:aws:iam::aws:policy/AdministratorAccess,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-ab3b34dd2d6db1b8,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "ManagedPolicyAttachment arn:aws:iam::aws:policy/AWSSecretsManagerClientReadOnlyAccess,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "ManagedPolicyAttachment arn:aws:iam::aws:policy/ReadOnlyAccess,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "ManagedPolicyAttachment arn:aws:iam::aws:policy/job-function/Billing,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-7907e6ad83ceef38,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSetInlinePolicy arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-209e00e1c6a78a7b,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSetInlinePolicy arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "PermissionSetInlinePolicy arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-f75e5d9826239194,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment 383193a0-7001-70d9-a321-ffe6d8af7378,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-209e00e1c6a78a7b,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment 383193a0-7001-70d9-a321-ffe6d8af7378,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment 88c1b330-a001-707a-06ca-94e289013bf5,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-ab3b34dd2d6db1b8,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment 88c1b330-a001-707a-06ca-94e289013bf5,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment a8011350-50b1-701c-5b41-c0e4c9b30976,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment 2841e390-5011-7007-ad5d-c906acf4807d,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-f75e5d9826239194,arn:aws:sso:::instance/ssoins-790711c2cafff252",
  "AccountAssignment 88313300-9031-70ed-ec00-bb80ba0e94e1,GROUP,333022194791,AWS_ACCOUNT,arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-7907e6ad83ceef38,arn:aws:sso:::instance/ssoins-790711c2cafff252",
];

describe("identity center imports", () => {
  it("emits exactly the 21 expected import ids", () => {
    const captured: string[] = [];
    const stub = (kind: string) =>
      class {
        constructor(_n: string, _a: unknown, o: { import: string }) {
          captured.push(`${kind} ${o.import}`);
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
    const orig = (Module as never as { _load: Function })._load;
    (Module as never as { _load: Function })._load = function (r: string) {
      return r === "@pulumi/aws" ? fake : orig.apply(this, arguments);
    };
    try {
      require("../identity-center").createIdentityCenter();
    } finally {
      (Module as never as { _load: Function })._load = orig;
    }
    assert.deepEqual(captured.sort(), [...EXPECTED_IMPORTS].sort());
  });
});
