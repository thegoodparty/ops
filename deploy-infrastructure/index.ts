import * as aws from "@pulumi/aws";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";
import { createDeployRole } from "./deploy-role";
import { createPreviewRole } from "./preview-role";
import { createAgentSwarm } from "./agent-swarm";

/**
 * Contents of the `goodparty-infrastructure` account.
 *
 * Stack: `organization/infrastructure/main`. Account: 394495727159, reached
 * by assuming a role from the management account. Role running the deploy:
 * `github-actions-infrastructure-deploy`, via
 * `.github/workflows/deploy-infrastructure.yml`.
 *
 * Modelled on `deploy-workbench/`, the other project whose provider points at
 * an account its credentials do not belong to. Everything here takes an
 * explicit provider, and `deploy.sh` disables the default one, so a resource
 * that omits `{ provider }` fails the apply rather than landing in the
 * management account.
 */

/**
 * The way into the account.
 *
 * Step 7's first PR: `OrganizationAccountAccessRole`, the administrator role
 * Organizations plants in every member account, trusted to the management
 * account root. It is the only door that exists before this stack's first
 * apply. That apply creates `pulumi-deploy` below, and step 7's second PR
 * repoints `roleArn` at it and removes the bootstrap grant on
 * `github-actions-infrastructure-deploy`. The apply that creates a role
 * cannot assume it, which is why this takes two PRs.
 *
 * `defaultTags` lives here rather than in `deploy.sh`, because the
 * `aws:defaultTags` stack config applies to the default provider, which this
 * project disables.
 *
 * `allowedAccountIds` is the second wrong-account guard: it catches this
 * provider resolving to credentials in some other account, before any
 * resource is touched.
 */
const provider = new aws.Provider("infrastructure", {
  region: "us-west-2",
  assumeRoles: [
    {
      roleArn: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/OrganizationAccountAccessRole`,
      // The session name in this account's CloudTrail. It separates a CI
      // apply from a human who assumed the same role by hand.
      sessionName: "pulumi-deploy-infrastructure",
    },
  ],
  allowedAccountIds: [INFRASTRUCTURE_ACCOUNT_ID],
  defaultTags: {
    tags: { Environment: "infrastructure", Project: "infrastructure" },
  },
});

/**
 * Evidence, not what forces the assume: an explicit provider is configured
 * and its credentials validated whether or not anything uses it. The step 7
 * entry records this output reading 394495727159, which also closes step 3's
 * open half, that STS sees `OrganizationAccountAccessRole`.
 */
export const accountId = aws.getCallerIdentityOutput({}, { provider }).accountId;

// The admin deploy role step 7's second PR repoints the provider at. In its
// own file because its trust is the design record for the door into this
// account.
const deployRole = createDeployRole({ provider });

/** Evidence for the step 7 entry: the apply log should show this ARN. */
export const deployRoleArn = deployRole.arn;

// The read-only sibling a `pulumi preview` will assume once step 11 wires
// previews for this project, so a PR never reaches this account as admin.
const previewRole = createPreviewRole({ provider });

/** Evidence for the step 7 entry: the apply log should show this ARN. */
export const previewRoleArn = previewRole.arn;

// The Delegate swarm host. DNS for delegate-swarm.goodparty.org lives in the
// management account's zone and is pointed at this address separately.
const agentSwarm = createAgentSwarm({ provider });

export const delegateSwarmInstanceId = agentSwarm.instance.id;
export const delegateSwarmPublicIp = agentSwarm.eip.publicIp;
