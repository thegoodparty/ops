import * as aws from "@pulumi/aws";
import {
  githubActionsOrgDeploy,
  githubActionsOrgDeployTrust,
  githubActionsPulumiDeploy,
  githubActionsPulumiDeployTrust,
  githubActionsPulumiPlan,
  githubActionsPulumiPlanTrust,
  githubActionsJudgeSweepTrust,
  githubActionsPulumiPreview,
  githubActionsPulumiPreviewTrust,
  githubActionsWorkbenchDeploy,
  githubActionsWorkbenchDeployTrust,
} from "./ci-roles/policies";

const ACCOUNT_ID = "333022194791";

const DEPLOY_ROLE_NAME = "github-actions-pulumi-deploy";
const DEPLOY_POLICY_ARN = `arn:aws:iam::${ACCOUNT_ID}:policy/GitHubActionsPulumiDeployPolicy`;
const READ_ONLY_ACCESS_ARN = "arn:aws:iam::aws:policy/ReadOnlyAccess";

// Written by omni, not here: packages/gp-ai/infrastructure/modules/
// universal-judge-sweep-policy, instantiated at environments/dev/ and applied
// by omni's release train. The grant and the role that holds it are owned by
// different repos on purpose — what the judge may touch is a fact about the
// judge's buckets and queue, which live in omni's terraform, while who may
// assume anything in this account is a fact about CI identity, which lives
// here. The ARN is the seam.
//
// `-dev` is in the name because the policy exists in dev only, which is a
// property of the judge rather than of this role: the Fargate side refuses a
// judge dispatch outside dev in two places, so a prod twin would be a grant
// nothing can use.
const JUDGE_SWEEP_POLICY_ARN = `arn:aws:iam::${ACCOUNT_ID}:policy/UniversalJudgeSweep-dev`;
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

  // The Terraform plan role, step 4 of docs/deploy-role-trust.md. Trusted by
  // `pull_request` in omni and gp-terraform-dataplatform, which plan Terraform
  // on PRs and today assume the shared admin role to do it.
  //
  // Unlike the preview role above, this one carries a managed policy as well
  // as its inline document. `terraform plan` reads whatever its roots manage,
  // across a dozen services, and enumerating that is a standing breakage every
  // time a root is added. `ReadOnlyAccess` covers the reads; the inline
  // document's denies remove the two things that make ReadOnlyAccess unsafe
  // here, Pulumi state and secret material, neither of which a plan needs.
  //
  // No protect. Nothing depends on it until step 5 points the workflows at it.
  const planRole = new aws.iam.Role("githubActionsPulumiPlan", {
    name: "github-actions-pulumi-plan",
    description:
      "Read-only Terraform plans from pull_request runs in thegoodparty/omni and thegoodparty/gp-terraform-dataplatform.",
    assumeRolePolicy: JSON.stringify(githubActionsPulumiPlanTrust),
    maxSessionDuration: 3600,
  });

  new aws.iam.RolePolicy("githubActionsPulumiPlanPolicy", {
    name: "Plan",
    role: planRole.id,
    policy: JSON.stringify(githubActionsPulumiPlan),
  });

  new aws.iam.RolePolicyAttachment("githubActionsPulumiPlanReadOnlyAttachment", {
    role: planRole.name,
    policyArn: READ_ONLY_ACCESS_ARN,
  });

  // The Universal Judge's sweep role, assumed by thegoodparty/omni's
  // judge.yml. See githubActionsJudgeSweepTrust for who may assume it and why
  // it is pinned to one workflow file on main.
  //
  // No inline document at all, unlike every role above. Its whole grant is the
  // attachment, because the resources it names — two S3 buckets and a queue —
  // are omni's and are described where they are created. Duplicating them here
  // would mean the prefix a judge may stage under is written in two repos, and
  // the one that drifts would be this one.
  //
  // No protect. Nothing depends on it until judge.yml names it, and an
  // unreachable test harness is a safe thing to leave easy to correct.
  const judgeSweepRole = new aws.iam.Role("githubActionsJudgeSweep", {
    name: "github-actions-judge-sweep",
    description:
      "Universal Judge background sweeps from judge.yml on main in thegoodparty/omni. Dev only.",
    assumeRolePolicy: JSON.stringify(githubActionsJudgeSweepTrust),
    // FOUR HOURS, not the one hour every role above takes.
    //
    // Those roles run Pulumi and Terraform, which finish in minutes. This one
    // waits: a background sweep dispatches a Fargate run and then polls S3
    // until the artifact lands, and the agents declare timeouts up to an hour
    // EACH, several per arm, inside a job allowed three hours.
    //
    // At the default the credentials expire mid-poll, and the shape of that
    // failure is the expensive one: the dispatch has already happened, the
    // Fargate task keeps running and billing, and the poll fails with an auth
    // error that the sweep records as an infraError — a run paid for and
    // excluded from the comparison. Raising it is the only fix available,
    // because `role-duration-seconds` cannot exceed what the role allows.
    //
    // Four hours covers the job's own `timeout-minutes: 180` with slack and
    // nothing beyond it. The credentials cannot outlive the job that holds
    // them, so the extra window is reachable only by a job already running.
    maxSessionDuration: 14400,
  });

  new aws.iam.RolePolicyAttachment("githubActionsJudgeSweepAttachment", {
    role: judgeSweepRole.name,
    policyArn: JUDGE_SWEEP_POLICY_ARN,
  });

  return {
    deployRole,
    deployPolicy,
    orgDeployRole,
    workbenchDeployRole,
    previewRole,
    planRole,
    judgeSweepRole,
  };
};
