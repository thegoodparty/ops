import * as aws from "@pulumi/aws";

import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";

/**
 * CodeBuild-hosted GitHub Actions runners. See `gh-runners/README.md`.
 *
 * One runner project with an organization-scoped webhook: GitHub sends every
 * `workflow_job.queued` event in the org to CodeBuild, and CodeBuild starts a
 * fresh build, which registers one ephemeral runner, for each job whose
 * `runs-on` names this project.
 */

const NAME = "gh-runners";
const REGION = "us-west-2";

export const GH_RUNNERS_PROJECT_NAME = NAME;
export const GH_RUNNERS_LOG_GROUP = `/${NAME}`;
export const GH_RUNNERS_GITHUB_ORG = "thegoodparty";

/**
 * The connection is created PENDING and CodeBuild creates the org webhook in
 * GitHub through it, so the webhook cannot exist until a human has completed
 * the handshake in the console. The switch-on PR flips this.
 */
export const CONNECTION_READY = false;

/**
 * The label a workflow puts in `runs-on`. CodeBuild ignores a queued job
 * unless the project name in it matches this project exactly; the run id and
 * attempt let it stop the build when the run is cancelled.
 */
export const GH_RUNNERS_RUNS_ON =
  "codebuild-" + NAME + "-${{ github.run_id }}-${{ github.run_attempt }}";

/**
 * Queued jobs from omni and ops only. The docs do not say whether
 * `REPOSITORY_NAME` is matched against `name` or `owner/name`, so the pattern
 * accepts both.
 */
export const ghRunnersFilterGroups = [
  {
    filters: [
      { type: "EVENT", pattern: "WORKFLOW_JOB_QUEUED" },
      { type: "REPOSITORY_NAME", pattern: "^(thegoodparty/)?(omni|ops)$" },
    ],
  },
];

const TAGS = { Name: NAME, Project: NAME };

export const ghRunnersTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "codebuild.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: {
        StringEquals: { "aws:SourceAccount": INFRASTRUCTURE_ACCOUNT_ID },
      },
    },
  ],
} as const;

/**
 * The build's own role: write its logs and fetch GitHub tokens through the one
 * connection. Nothing else. A job that needs AWS assumes its own role through
 * GitHub OIDC, exactly as it would on a hosted runner.
 *
 * The connection is a `codeconnections` ARN, so the legacy
 * `codestar-connections` actions do not apply to it.
 */
export const ghRunnersPolicy = (connectionArn: string) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "OwnLogs",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: [
        `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:${GH_RUNNERS_LOG_GROUP}`,
        `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:${GH_RUNNERS_LOG_GROUP}:*`,
      ],
    },
    {
      Sid: "GitHubConnection",
      Effect: "Allow",
      Action: [
        "codeconnections:GetConnectionToken",
        "codeconnections:GetConnection",
        "codeconnections:UseConnection",
      ],
      Resource: connectionArn,
    },
  ],
});

export const createGhRunners = (args: { provider: aws.Provider }) => {
  const { provider } = args;

  const connection = new aws.codeconnections.Connection(
    "ghRunnersConnection",
    {
      name: NAME,
      providerType: "GitHub",
      tags: TAGS,
    },
    { provider },
  );

  const logGroup = new aws.cloudwatch.LogGroup(
    "ghRunnersLogs",
    {
      name: GH_RUNNERS_LOG_GROUP,
      retentionInDays: 14,
      tags: TAGS,
    },
    { provider },
  );

  const role = new aws.iam.Role(
    "ghRunnersRole",
    {
      name: `${NAME}-codebuild`,
      description:
        "CodeBuild service role for the gh-runners project: its own logs and the gh-runners GitHub connection. Jobs reach AWS through their own OIDC roles.",
      assumeRolePolicy: JSON.stringify(ghRunnersTrust),
      tags: TAGS,
    },
    { provider },
  );

  const rolePolicy = new aws.iam.RolePolicy(
    "ghRunnersRolePolicy",
    {
      name: NAME,
      role: role.name,
      policy: connection.arn.apply((arn) =>
        JSON.stringify(ghRunnersPolicy(arn)),
      ),
    },
    { provider },
  );

  const project = new aws.codebuild.Project(
    "ghRunners",
    {
      name: GH_RUNNERS_PROJECT_NAME,
      description:
        "Ephemeral GitHub Actions runners for thegoodparty/omni and thegoodparty/ops, one build per queued job.",
      serviceRole: role.arn,
      buildTimeout: 120,
      artifacts: { type: "NO_ARTIFACTS" },
      environment: {
        type: "LINUX_CONTAINER",
        // Ubuntu 24.04, so `sudo apt-get` and Playwright's --with-deps work as
        // they do on ubuntu-latest.
        image: "aws/codebuild/standard:8.0",
        computeType: "BUILD_GENERAL1_LARGE",
        // A Docker daemon inside the build container, for `services:`
        // containers and docker build/buildx.
        privilegedMode: true,
      },
      source: {
        type: "GITHUB",
        // The required location for an organization-scoped webhook.
        location: "CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION",
        auth: { type: "CODECONNECTIONS", resource: connection.arn },
      },
      logsConfig: {
        cloudwatchLogs: { groupName: logGroup.name },
      },
      tags: TAGS,
    },
    { provider, dependsOn: [rolePolicy] },
  );

  // Automatic creation: the AWS Connector for GitHub app holds
  // organization_hooks:write, so CodeBuild creates the org webhook itself.
  const webhook = CONNECTION_READY
    ? new aws.codebuild.Webhook(
        "ghRunnersWebhook",
        {
          projectName: project.name,
          buildType: "BUILD",
          filterGroups: ghRunnersFilterGroups,
          scopeConfiguration: {
            name: GH_RUNNERS_GITHUB_ORG,
            scope: "GITHUB_ORGANIZATION",
          },
        },
        { provider },
      )
    : undefined;

  return { connection, logGroup, role, project, webhook };
};
