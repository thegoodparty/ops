import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import {
  adminReservedActions,
  engineerAccess,
  productManager,
  readOnlyAccess,
  workbenchAccess,
  type PolicyDocument,
} from "./identity-center/policies";

const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-790711c2cafff252";
const PS_PREFIX = "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252";

type PermissionSet = {
  /**
   * Identity Center's id for this set, present only when the set already
   * exists in AWS. It is what builds the set's ARN ahead of the apply, and
   * what the `import:` option addresses.
   *
   * Absent on a set this program creates. Its ARN does not exist until the
   * apply, so it arrives as an Output instead of a string, which is why
   * `createIdentityCenter` carries a map of ARNs rather than recomputing the
   * string at each use.
   */
  id?: string;
  name: string;
  sessionDuration: string;
  managedPolicies: string[];
  inlinePolicy?: PolicyDocument;
  /**
   * Whether `adminReservedActions` is composed into this set's inline policy.
   * Defaults to true, so a permission set added later is protected without
   * anyone remembering to opt in. Opting out is a decision that should be
   * visible where the set is defined, not buried in the loop below, which is
   * why this is a field rather than a name check.
   */
  guardrails?: boolean;
};

/**
 * Prepends the admin-reserved denies to a permission set's own policy.
 *
 * Statement order does not affect evaluation, since an explicit Deny beats
 * every Allow regardless of position. Denies come first because they read as
 * the boundary the rest of the document sits inside.
 */
const withAdminReserved = (policy?: PolicyDocument): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [...adminReservedActions.Statement, ...(policy?.Statement ?? [])],
});

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
    // The one set that must never carry the guardrails. This is the
    // break-glass path ci-roles.ts names as the recovery route that does not
    // depend on CI, for precisely the case where a bad trust policy update
    // locks CI out of the account. Denying it the actions it exists to perform
    // would remove the recovery path at the exact moment it is needed.
    //
    // It also has no inline policy at all today, so applying the guardrails
    // here would not edit a document, it would create one consisting purely of
    // denies.
    guardrails: false,
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
    // Excluded pending a check of what job-function/Billing actually grants.
    // Billing administration plausibly touches organizations write actions
    // around consolidated billing, and a deny that collides with a real
    // billing workflow surfaces as an AccessDenied nobody traces back to
    // here. Nothing is lost by waiting: this set grants no writes that the
    // guardrails would catch today. Run
    // `aws iam get-policy-version --policy-arn arn:aws:iam::aws:policy/job-function/Billing`
    // against its default version, then drop this line if it is clean.
    guardrails: false,
  },
  // The only set this program creates rather than adopts, and the only one
  // assigned outside the management account. No `id`: it does not exist in
  // AWS until this applies. Record the id it gets in the Progress section of
  // docs/workbench-account.md, but do not add it here, since adding it would
  // turn the create into an import of a resource Pulumi already owns.
  //
  // No managed policies on purpose. `workbenchAccess` is the entire session;
  // see the reasoning where that document is defined.
  workbench: {
    name: "WorkbenchAccess",
    // Matches EngineerAccess. The inner loop is a working day, and a session
    // that expires mid-task takes an agent's credentials with it.
    sessionDuration: "PT12H",
    managedPolicies: [],
    inlinePolicy: workbenchAccess,
  },
} satisfies Record<string, PermissionSet>;

// Identity store group ids, keyed by display name.
//
// An id exists here only so the assignments below can name a principal, and so
// the `import:` option can address an assignment that already exists in AWS.
// It is deliberately not part of any Pulumi resource name, so it can be
// dropped for a `getGroup` lookup on the display name once the import has run,
// without renaming anything.
const groups = {
  Engineers: "383193a0-7001-70d9-a321-ffe6d8af7378",
  Admins: "88c1b330-a001-707a-06ca-94e289013bf5",
  Research: "a8011350-50b1-701c-5b41-c0e4c9b30976",
  Product: "2841e390-5011-7007-ad5d-c906acf4807d",
  "Billing Admins": "88313300-9031-70ed-ec00-bb80ba0e94e1",
} satisfies Record<string, string>;

type Account = {
  id: string;
  /**
   * Prefixed to every assignment's Pulumi resource name in this account.
   *
   * Empty for the management account, and it has to stay empty. Its
   * assignments were named before there was more than one account, a resource
   * name is part of the URN, and changing one reads as a delete plus a create
   * that `protect: true` then refuses. Carrying the asymmetry is cheaper than
   * an `aliases` entry on each of the eight, which would have to be right the
   * first time or produce exactly the failure it was added to avoid.
   */
  namePrefix: string;
  /**
   * Whether these assignments already exist in AWS and are being adopted
   * rather than created.
   *
   * A wart, and worth knowing about before trusting it: this is really a fact
   * about each assignment, not about the account. It happens to be uniform
   * today because every assignment in the management account predates Pulumi
   * and none in the workbench account exist at all. Add a sixth group to the
   * management account and this flag will claim its assignment is importable,
   * and the apply will fail somewhere that does not point back here. Split it
   * per assignment at that point rather than working around it.
   */
  adopted: boolean;
  /**
   * Which permission sets each group may assume in this account. A group can
   * hold more than one: they are separate roles a member picks between at
   * sign-in, not an additive union, so holding both EngineerAccess and
   * ReadOnlyAccess just offers a lower-privilege session to choose.
   */
  assignments: Partial<
    Record<keyof typeof groups, (keyof typeof permissionSets)[]>
  >;
};

const accounts = {
  main: {
    id: "333022194791",
    namePrefix: "",
    adopted: true,
    assignments: {
      Engineers: ["engineer", "readOnly"],
      Admins: ["administrator", "readOnly"],
      Research: ["readOnly"],
      Product: ["productManager"],
      "Billing Admins": ["billing"],
    },
  },
  // The workbench account, 024901689212. Step 8 of docs/workbench-account.md.
  //
  // Engineers get WorkbenchAccess and nothing else here. No ReadOnlyAccess:
  // the account is meant to hold Bedrock traffic and nothing worth reading,
  // and adding a broad read set the moment it is created gives that up before
  // it has been tested.
  //
  // Admins get AdministratorAccess, which is a real grant of full admin in
  // this account and not a formality. The alternative is that the only human
  // way in is assuming `OrganizationAccountAccessRole` from the management
  // account by hand: a shared role, attributable to a person only by
  // correlating CloudTrail, and the exact thing step 10 exists to retire.
  // Break-glass through Identity Center is the same privilege with a named
  // session attached to it.
  workbench: {
    id: "024901689212",
    namePrefix: "workbench-",
    adopted: false,
    assignments: {
      Engineers: ["workbench"],
      Admins: ["administrator"],
    },
  },
} satisfies Record<string, Account>;

export const createIdentityCenter = () => {
  const entries = Object.entries(permissionSets) as [string, PermissionSet][];

  // Each set's ARN, by key, for the assignments below to read.
  //
  // It is a map rather than a recomputed `${PS_PREFIX}/${id}` because one set
  // has no id until it is created. A created set's ARN is an Output, so the
  // type widens to Input and the assignment that references it picks up a
  // dependency on the set automatically, which is what orders the two.
  const permissionSetArns: Record<string, pulumi.Input<string>> = {};

  // The same ARNs, but only for sets that already exist, and as plain
  // strings. Import strings are built before the apply and cannot hold an
  // Output, so the adopt paths below read this map rather than the one above.
  const existingPermissionSetArns: Record<string, string | undefined> = {};

  for (const [key, set] of entries) {
    // Present only for a set that already exists in AWS. Everything that
    // adopts rather than creates is gated on this, since an import string
    // cannot contain an Output, and nothing importable lacks a literal id.
    const existingArn = set.id ? `${PS_PREFIX}/${set.id}` : undefined;

    // `protect` is not conditional on `import`, though it used to read that
    // way when every resource here was adopted. They answer different
    // questions: import is "does this already exist in AWS", protect is "is
    // destroying this something that should need its own pull request".
    // Deleting a permission set or an assignment revokes real access, and
    // renaming one is a replacement, so the answer is yes whether Pulumi
    // created it or inherited it. Inline policies stay unprotected; those are
    // the ones we deliberately edit.
    const adopt = existingArn
      ? { import: `${existingArn},${INSTANCE_ARN}` }
      : {};

    const permissionSet = new aws.ssoadmin.PermissionSet(
      `permissionSet-${key}`,
      {
        name: set.name,
        instanceArn: INSTANCE_ARN,
        sessionDuration: set.sessionDuration,
      },
      { ...adopt, protect: true },
    );

    const permissionSetArn: pulumi.Input<string> =
      existingArn ?? permissionSet.arn;
    permissionSetArns[key] = permissionSetArn;
    existingPermissionSetArns[key] = existingArn;

    for (const managedPolicyArn of set.managedPolicies) {
      new aws.ssoadmin.ManagedPolicyAttachment(
        `managedPolicy-${key}-${managedPolicyArn.split("/").pop()}`,
        { instanceArn: INSTANCE_ARN, managedPolicyArn, permissionSetArn },
        {
          ...(existingArn
            ? { import: `${managedPolicyArn},${existingArn},${INSTANCE_ARN}` }
            : {}),
          protect: true,
        },
      );
    }

    const inlinePolicy =
      (set.guardrails ?? true)
        ? withAdminReserved(set.inlinePolicy)
        : set.inlinePolicy;

    if (inlinePolicy) {
      // No protect: inline policies are the ones we deliberately edit in-repo.
      new aws.ssoadmin.PermissionSetInlinePolicy(
        `inlinePolicy-${key}`,
        {
          instanceArn: INSTANCE_ARN,
          permissionSetArn,
          inlinePolicy: JSON.stringify(inlinePolicy),
        },
        existingArn ? { import: `${existingArn},${INSTANCE_ARN}` } : undefined,
      );
    }
  }

  for (const account of Object.values(accounts) as Account[]) {
    for (const [groupName, keys] of Object.entries(account.assignments) as [
      keyof typeof groups,
      (keyof typeof permissionSets)[],
    ][]) {
      const principalId = groups[groupName];

      for (const key of keys) {
        const name = `assignment-${account.namePrefix}${groupName.replace(/\s+/g, "")}-${key}`;

        // Adopting an assignment needs the set's ARN as a literal, not as the
        // Input the create path uses, because an import string is built
        // before the apply. The two cannot disagree: an assignment can only
        // pre-exist in AWS if its permission set does too, so a set without
        // an id in an adopted account is a contradiction rather than a case
        // to handle. Fail here, where the cause is visible, instead of
        // letting Pulumi try to import `undefined`.
        const existingArn = existingPermissionSetArns[key];
        if (account.adopted && !existingArn) {
          throw new Error(
            `Assignment ${name} is marked adopted, but permission set "${key}" has no id, so it does not exist in AWS yet. Either the set's id is missing or the account's \`adopted\` flag is wrong; see the flag's comment.`,
          );
        }

        new aws.ssoadmin.AccountAssignment(
          name,
          {
            instanceArn: INSTANCE_ARN,
            permissionSetArn: permissionSetArns[key],
            principalId,
            principalType: "GROUP",
            targetId: account.id,
            targetType: "AWS_ACCOUNT",
          },
          {
            ...(existingArn && account.adopted
              ? {
                  import: `${principalId},GROUP,${account.id},AWS_ACCOUNT,${existingArn},${INSTANCE_ARN}`,
                }
              : {}),
            protect: true,
          },
        );
      }
    }
  }
};
