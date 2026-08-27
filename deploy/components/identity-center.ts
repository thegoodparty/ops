import * as aws from "@pulumi/aws";
import {
  engineerAccess,
  productManager,
  readOnlyAccess,
  type PolicyDocument,
} from "./identity-center/policies";

const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-790711c2cafff252";
const ACCOUNT_ID = "333022194791";
const PS_PREFIX = "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252";

type PermissionSet = {
  id: string;
  name: string;
  sessionDuration: string;
  managedPolicies: string[];
  inlinePolicy?: PolicyDocument;
};

const permissionSets = {
  engineer: {
    id: "ps-209e00e1c6a78a7b",
    name: "EngineerAccess",
    sessionDuration: "PT12H",
    managedPolicies: [
      "arn:aws:iam::aws:policy/AmazonS3FullAccess",
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ],
    inlinePolicy: engineerAccess,
  },
  administrator: {
    id: "ps-ab3b34dd2d6db1b8",
    name: "AdministratorAccess",
    sessionDuration: "PT8H",
    managedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
  },
  readOnly: {
    id: "ps-790741c400f38152",
    name: "ReadOnlyAccess",
    sessionDuration: "PT8H",
    managedPolicies: [
      "arn:aws:iam::aws:policy/AWSSecretsManagerClientReadOnlyAccess",
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ],
    inlinePolicy: readOnlyAccess,
  },
  productManager: {
    id: "ps-f75e5d9826239194",
    name: "ProductManager",
    sessionDuration: "PT8H",
    managedPolicies: [],
    inlinePolicy: productManager,
  },
  billing: {
    id: "ps-7907e6ad83ceef38",
    name: "Billing",
    sessionDuration: "PT8H",
    // Billing is a job-function policy, not a top-level one.
    managedPolicies: ["arn:aws:iam::aws:policy/job-function/Billing"],
  },
} satisfies Record<string, PermissionSet>;

// Which permission sets each group may assume, keyed by the group's display
// name in the identity store. A group can hold more than one: they are
// separate roles a member picks between at sign-in, not an additive union, so
// holding both EngineerAccess and ReadOnlyAccess just offers a lower-privilege
// session to choose.
//
// `id` exists only so the import below can address the assignment that already
// exists in AWS. It is deliberately not part of any Pulumi resource name, so it
// can be dropped for a `getGroup` lookup on the display name once the import
// has run, without renaming anything.
const groups = {
  Engineers: {
    id: "383193a0-7001-70d9-a321-ffe6d8af7378",
    permissionSets: ["engineer", "readOnly"],
  },
  Admins: {
    id: "88c1b330-a001-707a-06ca-94e289013bf5",
    permissionSets: ["administrator", "readOnly"],
  },
  Research: {
    id: "a8011350-50b1-701c-5b41-c0e4c9b30976",
    permissionSets: ["readOnly"],
  },
  Product: {
    id: "2841e390-5011-7007-ad5d-c906acf4807d",
    permissionSets: ["productManager"],
  },
  "Billing Admins": {
    id: "88313300-9031-70ed-ec00-bb80ba0e94e1",
    permissionSets: ["billing"],
  },
} satisfies Record<
  string,
  { id: string; permissionSets: (keyof typeof permissionSets)[] }
>;

export const createIdentityCenter = () => {
  const entries = Object.entries(permissionSets) as [string, PermissionSet][];

  for (const [key, set] of entries) {
    const permissionSetArn = `${PS_PREFIX}/${set.id}`;

    new aws.ssoadmin.PermissionSet(
      `permissionSet-${key}`,
      {
        name: set.name,
        instanceArn: INSTANCE_ARN,
        sessionDuration: set.sessionDuration,
      },
      { import: `${permissionSetArn},${INSTANCE_ARN}`, protect: true },
    );

    for (const managedPolicyArn of set.managedPolicies) {
      new aws.ssoadmin.ManagedPolicyAttachment(
        `managedPolicy-${key}-${managedPolicyArn.split("/").pop()}`,
        { instanceArn: INSTANCE_ARN, managedPolicyArn, permissionSetArn },
        {
          import: `${managedPolicyArn},${permissionSetArn},${INSTANCE_ARN}`,
          protect: true,
        },
      );
    }

    if (set.inlinePolicy) {
      // No protect: inline policies are the ones we deliberately edit in-repo.
      new aws.ssoadmin.PermissionSetInlinePolicy(
        `inlinePolicy-${key}`,
        {
          instanceArn: INSTANCE_ARN,
          permissionSetArn,
          inlinePolicy: JSON.stringify(set.inlinePolicy),
        },
        { import: `${permissionSetArn},${INSTANCE_ARN}` },
      );
    }
  }

  for (const [groupName, group] of Object.entries(groups)) {
    const principalId = group.id;
    for (const key of group.permissionSets) {
      const permissionSetArn = `${PS_PREFIX}/${permissionSets[key].id}`;
      new aws.ssoadmin.AccountAssignment(
        `assignment-${groupName.replace(/\s+/g, "")}-${key}`,
        {
          instanceArn: INSTANCE_ARN,
          permissionSetArn,
          principalId,
          principalType: "GROUP",
          targetId: ACCOUNT_ID,
          targetType: "AWS_ACCOUNT",
        },
        {
          import: `${principalId},GROUP,${ACCOUNT_ID},AWS_ACCOUNT,${permissionSetArn},${INSTANCE_ARN}`,
          protect: true,
        },
      );
    }
  }
};
