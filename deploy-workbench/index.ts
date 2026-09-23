import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

/**
 * Contents of the `goodparty-workbench` account.
 *
 * Stack: `organization/workbench/main`. Account: 024901689212, reached by
 * assuming a role from the management account. Role running the deploy:
 * `github-actions-workbench-deploy`, via
 * `.github/workflows/deploy-workbench.yml`.
 *
 * Empty of real resources on purpose. Steps 8 through 11 of
 * docs/workbench-account.md are what fill this account, and step 10 creates
 * the first resource that belongs here. What this file establishes now is the
 * path into the account, so that the next step debugs its own resources
 * rather than the credential chain underneath them.
 *
 * Unlike `deploy/` and `deploy-org/`, everything here takes an explicit
 * provider. Those two run in the account their credentials already belong to;
 * this one does not, and the default provider would quietly land resources in
 * the management account instead. `deploy.sh` disables the default provider
 * so that omitting `{ provider }` fails the apply rather than succeeding in
 * the wrong account.
 */

// Hardcoded rather than read from the `org` stack. See "Cross-project
// dependencies" in the doc: an account id is immutable for the life of the
// account, so a StackReference would buy propagation that can never fire, at
// the cost of backend read access and the state passphrase in every consuming
// project. Matches how identity-center.ts hardcodes ACCOUNT_ID.
const WORKBENCH_ACCOUNT_ID = "024901689212";

/**
 * The way into the account.
 *
 * `OrganizationAccountAccessRole` is created automatically by Organizations
 * when it provisions a member account, and it is effectively administrator.
 * Step 10 replaces it with a scoped in-account role and repoints this
 * `assumeRole` at that; the matching `sts:AssumeRole` grant on
 * `github-actions-workbench-deploy` moves at the same time rather than being
 * joined by a second one.
 *
 * `defaultTags` lives here rather than in `deploy.sh`. The `aws:defaultTags`
 * stack config the other two projects set applies to the *default* provider,
 * which this project disables, so setting it there would silently tag
 * nothing.
 *
 * `assumeRoles`, plural and an array, is the @pulumi/aws v7 spelling. The
 * singular `assumeRole` in the plan's sketch was v6 and no longer type
 * checks; the array is for role chaining, and one element is the ordinary
 * case.
 *
 * `allowedAccountIds` is the second guard, independent of the disabled
 * default provider. That one catches a resource that names no provider; this
 * one catches this provider resolving to credentials in some other account,
 * which is the same wrong-account create arriving by a different route. The
 * provider refuses to do anything rather than writing to the wrong place.
 */
/**
 * Named rather than repeated. The provider needs it, and so does the
 * `aws:SourceArn` condition on the logging role's trust policy further down,
 * where a mismatch would not fail loudly: it would just refuse Bedrock the
 * assume and leave an enabled logging configuration writing nothing.
 */
const REGION = "us-west-2";

const provider = new aws.Provider("workbench", {
  region: REGION,
  assumeRoles: [
    {
      roleArn: `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/OrganizationAccountAccessRole`,
      // Shows up in the workbench account's CloudTrail as the session name.
      // Worth setting for an assume this privileged: it distinguishes a CI
      // apply from a human who assumed the same role by hand.
      sessionName: "pulumi-deploy-workbench",
    },
  ],
  allowedAccountIds: [WORKBENCH_ACCOUNT_ID],
  defaultTags: { tags: { Environment: "workbench", Project: "workbench" } },
});

/**
 * The account this stack actually reached, recorded as an output.
 *
 * Not what forces the assume. Checked rather than assumed: a provider that
 * nothing uses is still registered and still validates its credentials, so
 * the role is assumed either way and a broken chain fails the apply with or
 * without this line. `allowedAccountIds` above is what turns landing in the
 * wrong account into an error.
 *
 * It earns its place as evidence. `pulumi stack output accountId` gives a
 * human, and the step 7 entry in docs/workbench-account.md, something to read
 * that says 024901689212, rather than an absence of errors in a run log.
 * `sts:GetCallerIdentity` needs no permission, so it adds nothing to the
 * grant.
 */
export const accountId = aws.getCallerIdentityOutput({}, { provider }).accountId;

// ---------------------------------------------------------------------------
// Model invocation logging: who used how many tokens.
//
// Step 17 of docs/workbench-account.md, which carries the full design and the
// reasoning for the two things most likely to be questioned here: why the
// bodies are switched off, and why this is not application inference
// profiles.
//
// The short version. Every invocation log record carries `identity.arn`
// automatically, and because engineers reach this account through Identity
// Center that ARN ends in their username. It also carries input and output
// token counts. Between them that is per-user, per-prompt attribution with
// nothing to create per engineer, nothing to configure in pi, and no way for
// a caller to misattribute itself.

const LOG_GROUP_NAME = "/aws/bedrock/modelinvocations";

/**
 * Where the records land.
 *
 * Retention is set rather than left at the default, which is never expire.
 * This log group gets a record per model call for as long as the account is
 * in use, so "never" is the one value that is certainly wrong. Ninety days is
 * long enough to answer a question about last quarter's spend and short
 * enough that nothing accumulates unwatched.
 */
const invocationLogs = new aws.cloudwatch.LogGroup(
  "modelInvocationLogs",
  { name: LOG_GROUP_NAME, retentionInDays: 90 },
  { provider },
);

/**
 * The role Bedrock assumes to write them.
 *
 * The two conditions are AWS's documented shape for this trust, and they are
 * the confused-deputy guard: without them any account able to induce Bedrock
 * to assume this role could write into our log group. `SourceAccount` pins
 * the caller and `SourceArn` pins it to Bedrock in this account.
 */
const invocationLogsRole = new aws.iam.Role(
  "modelInvocationLogsRole",
  {
    name: "bedrock-model-invocation-logs",
    assumeRolePolicy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "bedrock.amazonaws.com" },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: { "aws:SourceAccount": WORKBENCH_ACCOUNT_ID },
            ArnLike: {
              "aws:SourceArn": `arn:aws:bedrock:${REGION}:${WORKBENCH_ACCOUNT_ID}:*`,
            },
          },
        },
      ],
    }),
  },
  { provider },
);

// Scoped to the one log stream Bedrock writes, not to the log group, which is
// the resource shape AWS documents for this. No CreateLogGroup: the group is
// the Pulumi resource above, and a service that can create its own log groups
// can create them outside anything we manage.
new aws.iam.RolePolicy(
  "modelInvocationLogsRolePolicy",
  {
    role: invocationLogsRole.name,
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: pulumi.interpolate`${invocationLogs.arn}:log-stream:aws/bedrock/modelinvocations`,
        },
      ],
    }),
  },
  { provider },
);

/**
 * Logging itself, metadata only.
 *
 * **Every one of these flags defaults to `true`.** This is opt-out, not
 * opt-in, so omitting them logs the full prompt and completion of every call
 * a coding agent makes, which in this account means repository contents in a
 * log group. They are listed exhaustively and explicitly for that reason:
 * a reader should not have to know the default to see what this does.
 *
 * What survives is what we want. AWS describes each flag as controlling
 * whether that modality's *data* is included in the delivery, and the record
 * format keeps `input.inputTokenCount` as a sibling of `input.inputBodyJson`
 * rather than inside it. So the record, its `identity.arn` and its token
 * counts are expected to remain.
 *
 * Expected, not confirmed: no AWS page states that a record is still written
 * when every modality is off, and the failure mode is silent, an enabled
 * configuration over an empty log group. Step 17's acceptance criterion is
 * one real invocation followed by reading this group, for exactly that
 * reason.
 *
 * Known gap: the API has a fifth flag, `audioDataDeliveryEnabled`, and the
 * provider does not expose it, so it cannot be set here and presumably stays
 * on. No model in `utils/bedrock-models.ts` accepts audio today, so nothing
 * is delivered. Adding one reopens this, and the fix would be a
 * `PutModelInvocationLoggingConfiguration` call outside Pulumi.
 *
 * Singleton per region by AWS's design, which the provider warns about: this
 * resource must not be declared in a second stack or the two will overwrite
 * each other.
 */
new aws.bedrockmodel.InvocationLoggingConfiguration(
  "modelInvocationLogging",
  {
    loggingConfig: {
      cloudwatchConfig: {
        logGroupName: invocationLogs.name,
        roleArn: invocationLogsRole.arn,
      },
      textDataDeliveryEnabled: false,
      imageDataDeliveryEnabled: false,
      embeddingDataDeliveryEnabled: false,
      videoDataDeliveryEnabled: false,
    },
  },
  { provider },
);

/** Where to look, so the step 17 check does not start with a console hunt. */
export const invocationLogGroup = invocationLogs.name;
