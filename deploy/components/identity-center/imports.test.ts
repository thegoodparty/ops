import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const PS = {
  engineer: "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-209e00e1c6a78a7b",
  administrator: "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-ab3b34dd2d6db1b8",
  readOnly: "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-790741c400f38152",
  productManager: "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-f75e5d9826239194",
  billing: "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-7907e6ad83ceef38",
};

// name/sessionDuration transcribed by hand from identity-center.ts's SETS table,
// keyed by permission set arn so a mismatch is caught even if import ids match.
const EXPECTED_PERMISSION_SETS: Record<string, { name: string; sessionDuration: string }> = {
  [PS.engineer]: { name: "EngineerAccess", sessionDuration: "PT12H" },
  [PS.administrator]: { name: "AdministratorAccess", sessionDuration: "PT8H" },
  [PS.readOnly]: { name: "ReadOnlyAccess", sessionDuration: "PT8H" },
  [PS.productManager]: { name: "ProductManager", sessionDuration: "PT8H" },
  [PS.billing]: { name: "Billing", sessionDuration: "PT8H" },
};

// Which policy file each permission set must be paired with. Swapping two
// entries in the component's `inline` table leaves every import id
// byte-identical, so pairing is the only thing that catches it.
//
// The expected hash is derived from the file rather than hardcoded: the
// fixtures are edited deliberately (the engineer policy gains its deny
// statements), and a hardcoded hash would turn every intended policy change
// into a spurious failure here on top of the one in policies.test.ts, which
// is the test that actually guards byte-exactness.
const EXPECTED_POLICY_FILE: Record<string, string> = {
  [PS.engineer]: "engineer-access.json",
  [PS.readOnly]: "read-only-access.json",
  [PS.productManager]: "product-manager.json",
};

const shaOfPolicyFile = (file: string) =>
  createHash("sha256")
    .update(readFileSync(join(__dirname, "policies", file)))
    .digest("hex");

describe("identity center imports", () => {
  it("emits exactly the 21 expected import ids, with the right permission-set shape and policy pairing", () => {
    const captured: string[] = [];
    const permissionSets: Record<string, { name: string; sessionDuration: string }> = {};
    const inlinePolicies: Record<string, string> = {};

    const fake = {
      ssoadmin: {
        PermissionSet: class {
          constructor(
            _n: string,
            args: { name: string; sessionDuration: string },
            o: { import: string },
          ) {
            captured.push(`PermissionSet ${o.import}`);
            const arn = o.import.split(",")[0];
            permissionSets[arn] = { name: args.name, sessionDuration: args.sessionDuration };
          }
        },
        ManagedPolicyAttachment: class {
          constructor(_n: string, _a: unknown, o: { import: string }) {
            captured.push(`ManagedPolicyAttachment ${o.import}`);
          }
        },
        PermissionSetInlinePolicy: class {
          constructor(_n: string, args: { inlinePolicy: string }, o: { import: string }) {
            captured.push(`PermissionSetInlinePolicy ${o.import}`);
            const arn = o.import.split(",")[0];
            inlinePolicies[arn] = createHash("sha256").update(args.inlinePolicy).digest("hex");
          }
        },
        AccountAssignment: class {
          constructor(_n: string, _a: unknown, o: { import: string }) {
            captured.push(`AccountAssignment ${o.import}`);
          }
        },
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

    for (const [arn, expected] of Object.entries(EXPECTED_PERMISSION_SETS)) {
      assert.deepEqual(permissionSets[arn], expected, `permission set ${arn} name/sessionDuration mismatch`);
    }

    for (const [arn, file] of Object.entries(EXPECTED_POLICY_FILE)) {
      const expectedSha = shaOfPolicyFile(file);
      assert.equal(
        inlinePolicies[arn],
        expectedSha,
        `permission set ${arn} is paired with the wrong inline policy file`,
      );
    }
  });
});
