import * as aws from "@pulumi/aws";
import {
  githubActionsPulumiDeploy,
  githubActionsPulumiDeployTrust,
} from "./ci-roles/policies";

const ACCOUNT_ID = "333022194791";

const DEPLOY_ROLE_NAME = "github-actions-pulumi-deploy";
const DEPLOY_POLICY_ARN = `arn:aws:iam::${ACCOUNT_ID}:policy/GitHubActionsPulumiDeployPolicy`;
const READ_ONLY_ACCESS_ARN = "arn:aws:iam::aws:policy/ReadOnlyAccess";

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
  // to its inline policies. Deletion is blocked a second way regardless, by
  // iam:DeletePolicy being absent from the role's own grants.
  const deployPolicy = new aws.iam.Policy(
    "githubActionsPulumiDeployPolicy",
    {
      name: "GitHubActionsPulumiDeployPolicy",
      policy: JSON.stringify(githubActionsPulumiDeploy),
    },
    { import: DEPLOY_POLICY_ARN },
  );

  // Attachments are protected: detaching either one strips the role's
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

  return { deployRole, deployPolicy };
};
