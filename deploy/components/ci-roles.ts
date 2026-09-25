import * as aws from "@pulumi/aws";
import {
  githubActionsOrgDeploy,
  githubActionsOrgDeployTrust,
  githubActionsPulumiDeploy,
  githubActionsPulumiDeployTrust,
  githubActionsPulumiPreview,
  githubActionsPulumiPreviewTrust,
  githubActionsWorkbenchDeploy,
  githubActionsWorkbenchDeployTrust,
} from "./ci-roles/policies";

const ACCOUNT_ID = "333022194791";

const DEPLOY_ROLE_NAME = "github-actions-pulumi-deploy";
const DEPLOY_POLICY_ARN = `arn:aws:iam::${ACCOUNT_ID}:policy/GitHubActionsPulumiDeployPolicy`;
const READ_ONLY_ACCESS_ARN = "arn:aws:iam::aws:policy/ReadOnlyAccess";
const ADMINISTRATOR_ACCESS_ARN = "arn:aws:iam::aws:policy/AdministratorAccess";

/**
 * Brings the CI deploy role under Pulumi.
 *
 * The role predates this repo's IaC: until now it existed only as a string in
 * `.github/workflows/deploy.yml`, so every grant it accumulated was a console
 * change nobody reviewed. It reached v18 of its policy that way.
 *
 * Everything here is imported, not created. Nothing in AWS changes on the
 * first apply except the two default tags landing on the policy, which had
 * none.
 *
 * Bootstrapping hazard, stated plainly: this is Pulumi managing the role that
 * Pulumi assumes. `protect: true` stops a destroy or a replace but not an
 * update, so a bad edit to the trust policy can still lock CI out of the
 * account. The recovery path is the AdministratorAccess permission set, which
 * a human assumes directly and which does not depend on CI.
 */
export const createCiRoles = () => {
  const deployRole = new aws.iam.Role(
    "githubActionsPulumiDeploy",
    {
      name: DEPLOY_ROLE_NAME,
      assumeRolePolicy: JSON.stringify(githubActionsPulumiDeployTrust),
      maxSessionDuration: 3600,
    },
    { import: DEPLOY_ROLE_NAME, protect: true },
  );

  // No protect on the policy document itself: this is the thing we now
  // deliberately edit in-repo, the same reasoning identity-center.ts applies
  // to its inline policies.
  //
  // Superseded by the AdministratorAccess attachment below, and still here on
  // purpose. Removing it has to be its own change, because the run that
  // applies the removal authenticates with this policy and this policy has no
  // iam:DeletePolicy: the call would 403 and take the whole update with it.
  // Only once admin is attached does the role hold the grant its own policy's
  // deletion needs.
  const deployPolicy = new aws.iam.Policy(
    "githubActionsPulumiDeployPolicy",
    {
      name: "GitHubActionsPulumiDeployPolicy",
      policy: JSON.stringify(githubActionsPulumiDeploy),
    },
    { import: DEPLOY_POLICY_ARN },
  );

  // Attachments are protected: detaching any one of them strips the role's
  // permissions without deleting anything, which is the quiet version of the
  // lockout above.
  new aws.iam.RolePolicyAttachment(
    "githubActionsPulumiDeployPolicyAttachment",
    { role: deployRole.name, policyArn: deployPolicy.arn },
    { import: `${DEPLOY_ROLE_NAME}/${DEPLOY_POLICY_ARN}`, protect: true },
  );

  new aws.iam.RolePolicyAttachment(
    "githubActionsPulumiDeployReadOnlyAttachment",
    { role: deployRole.name, policyArn: READ_ONLY_ACCESS_ARN },
    { import: `${DEPLOY_ROLE_NAME}/${READ_ONLY_ACCESS_ARN}`, protect: true },
  );

  // AdministratorAccess is what the role actually runs on from here. The
  // enumerated policy above was never a boundary: it grants iam:PutRolePolicy
  // on "*", so the role can attach itself an inline document granting
  // anything, and SelfManageDeployPolicy lets it publish new versions of its
  // own managed policy. It could already grant itself admin in one call.
  //
  // What the enumeration did instead was break honest deploys. A missing
  // iam:UpdateRoleDescription failed a run on main (see the comment on that
  // action in ci-roles/policies.ts); a missing iam:UpdateRole failed another
  // when a role's MaxSessionDuration changed. `pulumi up` is all-or-nothing,
  // so one 403 on a cosmetic field discards an otherwise good update, and the
  // fix is always the same red-then-green policy PR.
  //
  // The boundary belongs on who may assume the role, which is the trust
  // policy in ci-roles/policies.ts. Eight repositories are still wildcarded
  // there on `:*`, which includes pull_request refs; narrowing that is the
  // follow-up this change makes worth doing.
  new aws.iam.RolePolicyAttachment(
    "githubActionsPulumiDeployAdminAttachment",
    { role: deployRole.name, policyArn: ADMINISTRATOR_ACCESS_ARN },
    { protect: true },
  );

  // The two scoped roles below are created, not imported, and are trusted by
  // the ops repo's main branch alone. See docs/workbench-account.md, "The
  // deploy role", for why the workbench work does not just widen the role
  // above.
  //
  // Inline RolePolicy rather than managed policies on purpose: step 2 granted
  // the shared role version management over exactly one policy ARN, so any
  // managed policy created here would be unmanageable by CI. Inline documents
  // are covered by the unscoped iam:PutRolePolicy it already holds.
  //
  // No protect on either. Neither is load bearing for existing deploys, and
  // both should stay easy to correct while the workbench work is in progress.
  const orgDeployRole = new aws.iam.Role("githubActionsOrgDeploy", {
    name: "github-actions-org-deploy",
    description:
      "Organization-level Pulumi deploys (deploy-org). Assumed only by deploy-org.yml on thegoodparty/ops main.",
    assumeRolePolicy: JSON.stringify(githubActionsOrgDeployTrust),
    maxSessionDuration: 3600,
  });

  new aws.iam.RolePolicy("githubActionsOrgDeployPolicy", {
    name: "OrgDeploy",
    role: orgDeployRole.id,
    policy: JSON.stringify(githubActionsOrgDeploy),
  });

  const workbenchDeployRole = new aws.iam.Role("githubActionsWorkbenchDeploy", {
    name: "github-actions-workbench-deploy",
    description:
      "Workbench account Pulumi deploys (deploy-workbench). Assumed only by deploy-workbench.yml on thegoodparty/ops main.",
    assumeRolePolicy: JSON.stringify(githubActionsWorkbenchDeployTrust),
    maxSessionDuration: 3600,
  });

  new aws.iam.RolePolicy("githubActionsWorkbenchDeployPolicy", {
    name: "WorkbenchDeploy",
    role: workbenchDeployRole.id,
    policy: JSON.stringify(githubActionsWorkbenchDeploy),
  });

  // The PR preview role. Created rather than imported, and trusted only by
  // `pull_request` runs in this repo. Its policy is read-only across ops, org
  // and workbench, which is what makes it safe to hand to an unreviewed
  // branch: the PR supplies both the workflow and the Pulumi program. See
  // docs/pr-previews.md, step 4.
  //
  // No protect. Nothing outside the preview workflow depends on it yet, and it
  // should stay easy to correct while step 5 wires that workflow up.
  const previewRole = new aws.iam.Role("githubActionsPulumiPreview", {
    name: "github-actions-pulumi-preview",
    description:
      "Read-only Pulumi previews for ops, org and workbench from pull_request runs in thegoodparty/ops.",
    assumeRolePolicy: JSON.stringify(githubActionsPulumiPreviewTrust),
    maxSessionDuration: 3600,
  });

  new aws.iam.RolePolicy("githubActionsPulumiPreviewPolicy", {
    name: "Preview",
    role: previewRole.id,
    policy: JSON.stringify(githubActionsPulumiPreview),
  });

  return {
    deployRole,
    deployPolicy,
    orgDeployRole,
    workbenchDeployRole,
    previewRole,
  };
};
