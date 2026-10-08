import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";
import { createDeployRole, DEPLOY_ROLE_NAME } from "./deploy-role";
import { createPreviewRole } from "./preview-role";
import { createAgentSwarm } from "./agent-swarm";
import { createInfraZone } from "./dns";

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
 * Step 7's cutover: the provider assumes `pulumi-deploy` on an apply, the role
 * this same stack creates in `deploy-role.ts`, which makes this file
 * self-referential in a way worth stating plainly. The apply runs as the role
 * the apply manages. That works because the role is administrator, including
 * over itself; `protect` on the role and its attachment is what keeps an edit
 * from locking CI out of the account, and the step 8 Admins Identity Center
 * assignment is the recovery path once it lands.
 *
 * Until the cutover this assumed `OrganizationAccountAccessRole`, the
 * administrator role Organizations plants in every member account, whose
 * trust names the management account *root* — any principal there holding
 * `sts:AssumeRole` — rather than a single role. The management-side grant for
 * it was removed in the same change. The in-account bootstrap role itself is
 * left alone; nothing here manages or deletes it, and removing it is a
 * console action if the account's owner wants it gone.
 *
 * `defaultTags` lives here rather than in `deploy.sh`, because the
 * `aws:defaultTags` stack config applies to the default provider, which this
 * project disables.
 *
 * `allowedAccountIds` is the second wrong-account guard: it catches this
 * provider resolving to credentials in some other account, before any
 * resource is touched.
 */
/**
 * The role the provider assumes into this account.
 *
 * Apply uses the admin deploy role. Preview mode sets this to the read-only
 * `pulumi-preview` in `deploy.sh`, so a PR preview never holds admin here.
 * `deploy.sh` sets it explicitly either way rather than leaving it to the
 * default, so a local preview followed by a local apply cannot leave the
 * preview role in the stack's config and repoint an apply at it.
 *
 * The default is the deploy role, so an apply that predates this config is
 * identical to the hardcoded ARN it replaced. The cascade check is step 7's
 * cutover, where the same `roleArn` edit was an in-place provider update, not
 * a replacement of the resources behind it.
 */
const config = new pulumi.Config();
const providerRoleName = config.get("providerRoleName") ?? DEPLOY_ROLE_NAME;

const provider = new aws.Provider("infrastructure", {
  region: "us-west-2",
  assumeRoles: [
    {
      // The role name comes from config: `pulumi-deploy` for an apply,
      // `pulumi-preview` for a preview, both set in deploy.sh. The name is
      // also spelled in the two role files and in the grants in
      // deploy/components/ci-roles/policies.ts, and a drift between them is an
      // assume failure that reads as a trust problem.
      roleArn: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/${providerRoleName}`,
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
 * open half, that STS sees the in-account deploy role.
 */
export const accountId = aws.getCallerIdentityOutput({}, { provider }).accountId;

// ---------------------------------------------------------------------------
// Spend threshold alerts, by email.
//
// Step 10 of docs/infrastructure-account.md, mirroring workbench step 13: no
// budget actions (nothing here stops spend), no anomaly detection, no Slack —
// an email when actual or forecasted monthly spend crosses a threshold. The
// amounts are the workbench budget's, copied so the two accounts read the
// same; each is a one-line change, and the wire is the point, not the values.
//
// `ABSOLUTE_VALUE` thresholds, so each number below is simply dollars and the
// budget's limit is only the console's reference bar; it is set to the highest
// threshold.
//
// Two honest caveats, the same as workbench step 13's. Forecasted alerts need
// weeks of usage history before AWS can compute a forecast at all, so on this
// young account they are silent until then by construction, not by failure.
// And every budget alert lags billing data by hours: a runaway measured in
// minutes would want an alarm on the resource doing the spending, which is not
// built here.
//
// Budgets is account-global — its ARNs carry no region — so the provider's
// region is immaterial. The Infrastructure SCP has no region deny, so unlike
// the workbench budget there is no exemption to add for it.

/** The step 1 group alias, which has been waiting for exactly this job. */
const SPEND_ALERT_EMAIL = "aws-infrastructure@goodparty.org";

const spendNotification = (
  notificationType: "ACTUAL" | "FORECASTED",
  dollars: number,
) => ({
  comparisonOperator: "GREATER_THAN",
  notificationType,
  threshold: dollars,
  thresholdType: "ABSOLUTE_VALUE",
  subscriberEmailAddresses: [SPEND_ALERT_EMAIL],
});

new aws.budgets.Budget(
  "infrastructureMonthlySpend",
  {
    name: "infrastructure-monthly-spend",
    budgetType: "COST",
    timeUnit: "MONTHLY",
    limitAmount: "20000",
    limitUnit: "USD",
    notifications: [
      // Actual spend: "this is real" early, then loud.
      spendNotification("ACTUAL", 5000),
      spendNotification("ACTUAL", 10000),
      // Forecasted: the mid-month runaway tripwires. Silent until the
      // account has enough history for a forecast to exist; see above.
      spendNotification("FORECASTED", 10000),
      spendNotification("FORECASTED", 20000),
    ],
  },
  { provider },
);

// The admin deploy role the provider above assumes. In its own file because
// its trust is the design record for the door into this account.
const deployRole = createDeployRole({ provider });

/** Evidence for the step 7 entry: the apply log should show this ARN. */
export const deployRoleArn = deployRole.arn;

// The read-only sibling a `pulumi preview` will assume once step 11 wires
// previews for this project, so a PR never reaches this account as admin.
const previewRole = createPreviewRole({ provider });

/** Evidence for the step 7 entry: the apply log should show this ARN. */
export const previewRoleArn = previewRole.arn;

// infra.goodparty.org, the account's own DNS zone. The management account's
// goodparty.org zone delegates it with one NS record in deploy/, which needs
// these name servers; after that, records here need no change there.
const infraZone = createInfraZone({ provider });

export const infraZoneId = infraZone.zoneId;
export const infraZoneNameServers = infraZone.nameServers;

// The Delegate swarm host, at delegate-swarm.infra.goodparty.org.
const agentSwarm = createAgentSwarm({ provider, zone: infraZone });

export const delegateSwarmInstanceId = agentSwarm.instance.id;
export const delegateSwarmPublicIp = agentSwarm.eip.publicIp;
