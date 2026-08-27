import * as aws from "@pulumi/aws";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-790711c2cafff252";
const ACCOUNT_ID = "333022194791";
const PS_PREFIX = "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252";

const psArn = (id: string) => `${PS_PREFIX}/${id}`;

// Identity store groups. The store is native (no external IdP issuer on any
// user), so these ids are stable and safe to pin.
const GROUPS = {
  engineers: "383193a0-7001-70d9-a321-ffe6d8af7378",
  admins: "88c1b330-a001-707a-06ca-94e289013bf5",
  research: "a8011350-50b1-701c-5b41-c0e4c9b30976",
  product: "2841e390-5011-7007-ad5d-c906acf4807d",
  billingAdmins: "88313300-9031-70ed-ec00-bb80ba0e94e1",
};

const SETS = {
  engineer: { id: "ps-209e00e1c6a78a7b", name: "EngineerAccess", duration: "PT12H" },
  administrator: { id: "ps-ab3b34dd2d6db1b8", name: "AdministratorAccess", duration: "PT8H" },
  readOnly: { id: "ps-790741c400f38152", name: "ReadOnlyAccess", duration: "PT8H" },
  productManager: { id: "ps-f75e5d9826239194", name: "ProductManager", duration: "PT8H" },
  billing: { id: "ps-7907e6ad83ceef38", name: "Billing", duration: "PT8H" },
};

// Captures of the live inline policies. The provider parses this field as
// JSON rather than comparing it as a string, so formatting is free to differ
// from what AWS stores; only the policy's meaning has to match on import.
const policy = (file: string) =>
  readFileSync(join(__dirname, "identity-center", "policies", file), "utf8");

export const createIdentityCenter = () => {
  for (const [key, set] of Object.entries(SETS)) {
    new aws.ssoadmin.PermissionSet(
      `permissionSet-${key}`,
      {
        name: set.name,
        instanceArn: INSTANCE_ARN,
        sessionDuration: set.duration,
      },
      {
        import: `${psArn(set.id)},${INSTANCE_ARN}`,
        protect: true,
      },
    );
  }

  const managed: [string, keyof typeof SETS, string][] = [
    ["engineer-s3", "engineer", "arn:aws:iam::aws:policy/AmazonS3FullAccess"],
    ["engineer-readonly", "engineer", "arn:aws:iam::aws:policy/ReadOnlyAccess"],
    ["administrator", "administrator", "arn:aws:iam::aws:policy/AdministratorAccess"],
    ["readonly-secrets", "readOnly", "arn:aws:iam::aws:policy/AWSSecretsManagerClientReadOnlyAccess"],
    ["readonly-readonly", "readOnly", "arn:aws:iam::aws:policy/ReadOnlyAccess"],
    // Billing is a job-function policy, not a top-level one.
    ["billing", "billing", "arn:aws:iam::aws:policy/job-function/Billing"],
  ];

  for (const [label, setKey, managedPolicyArn] of managed) {
    const arn = psArn(SETS[setKey].id);
    new aws.ssoadmin.ManagedPolicyAttachment(
      `managedPolicy-${label}`,
      { instanceArn: INSTANCE_ARN, managedPolicyArn, permissionSetArn: arn },
      { import: `${managedPolicyArn},${arn},${INSTANCE_ARN}`, protect: true },
    );
  }

  const inline: [keyof typeof SETS, string][] = [
    ["engineer", "engineer-access.json"],
    ["readOnly", "read-only-access.json"],
    ["productManager", "product-manager.json"],
  ];

  // No protect here, unlike the loops above: these are the resources we
  // legitimately edit in-repo (e.g. Task 6's edit to engineer-access.json),
  // so protecting them would block intended changes.
  for (const [setKey, file] of inline) {
    const arn = psArn(SETS[setKey].id);
    new aws.ssoadmin.PermissionSetInlinePolicy(
      `inlinePolicy-${setKey}`,
      { instanceArn: INSTANCE_ARN, permissionSetArn: arn, inlinePolicy: policy(file) },
      { import: `${arn},${INSTANCE_ARN}` },
    );
  }

  // Which permission sets each group may assume. A group can hold more than
  // one: they are separate roles a member picks between at sign-in, not an
  // additive union, so holding both EngineerAccess and ReadOnlyAccess just
  // offers a lower-privilege session to choose.
  const assignments: Record<keyof typeof GROUPS, (keyof typeof SETS)[]> = {
    engineers: ["engineer", "readOnly"],
    admins: ["administrator", "readOnly"],
    research: ["readOnly"],
    product: ["productManager"],
    billingAdmins: ["billing"],
  };

  const assignmentPairs = Object.entries(assignments).flatMap(
    ([groupKey, setKeys]) =>
      setKeys.map(
        (setKey) => [groupKey as keyof typeof GROUPS, setKey] as const,
      ),
  );

  for (const [groupKey, setKey] of assignmentPairs) {
    const principalId = GROUPS[groupKey];
    const arn = psArn(SETS[setKey].id);
    new aws.ssoadmin.AccountAssignment(
      `assignment-${groupKey}-${setKey}`,
      {
        instanceArn: INSTANCE_ARN,
        permissionSetArn: arn,
        principalId,
        principalType: "GROUP",
        targetId: ACCOUNT_ID,
        targetType: "AWS_ACCOUNT",
      },
      {
        import: `${principalId},GROUP,${ACCOUNT_ID},AWS_ACCOUNT,${arn},${INSTANCE_ARN}`,
        protect: true,
      },
    );
  }
};
