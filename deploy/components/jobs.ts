import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface JobsConfig {
  secretArn: string;
  clusterArn: pulumi.Output<string>;
  taskDefArn: pulumi.Output<string>;
  subnetIds: string[];
  securityGroupId: string;
}

type ManifestEntry =
  | { type: "job"; schedule: string }
  | { type: "agent"; schedule: string };

const LAMBDA_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    },
  ],
});

export const createJobs = (config: JobsConfig) => {
  const manifestPath = path.join(__dirname, "../../dist/jobs/manifest.json");

  if (!fs.existsSync(manifestPath)) {
    pulumi.log.warn(
      "No jobs manifest found at dist/jobs/manifest.json — skipping jobs.",
    );
    return {};
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<
    string,
    ManifestEntry
  >;

  const jobNames = Object.keys(manifest);
  if (jobNames.length === 0) return {};

  const hasRegularJobs = jobNames.some(
    (n) => manifest[n].type === "job" || !manifest[n].type,
  );
  const hasAgentJobs = jobNames.some((n) => manifest[n].type === "agent");

  let regularJobRole: aws.iam.Role | undefined;
  if (hasRegularJobs) {
    regularJobRole = new aws.iam.Role("jobLambdaRole", {
      name: "ops-job-lambda-role",
      assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ],
      inlinePolicies: [
        {
          name: "secrets-read",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue"],
                Resource: [config.secretArn],
              },
            ],
          }),
        },
      ],
    });
  }

  let agentJobRole: aws.iam.Role | undefined;
  if (hasAgentJobs) {
    agentJobRole = new aws.iam.Role("agentJobLambdaRole", {
      name: "ops-agent-job-lambda-role",
      assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ],
      inlinePolicies: [
        {
          name: "ecs-dispatch",
          policy: pulumi.jsonStringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: "ecs:RunTask",
                Resource: config.taskDefArn,
              },
              {
                Effect: "Allow",
                Action: "ecs:TagResource",
                Resource: config.clusterArn.apply(
                  (arn) => arn.replace(":cluster/", ":task/") + "/*",
                ),
              },
              {
                Effect: "Allow",
                Action: ["iam:PassRole"],
                Resource: ["*"],
                Condition: {
                  StringLike: {
                    "iam:PassedToService": "ecs-tasks.amazonaws.com",
                  },
                },
              },
            ],
          }),
        },
      ],
    });
  }

  const lambdas: Record<string, aws.lambda.Function> = {};

  for (const name of jobNames) {
    const entry = manifest[name];
    const isAgent = entry.type === "agent";

    const fn = new aws.lambda.Function(`job-${name}`, {
      name: `ops-job-${name}`,
      role: isAgent ? agentJobRole!.arn : regularJobRole!.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: new pulumi.asset.FileArchive(`../dist/jobs/${name}`),
      timeout: isAgent ? 30 : 60,
      memorySize: 256,
      environment: {
        variables: isAgent
          ? {
              CLUSTER_ARN: config.clusterArn,
              TASK_DEF_ARN: config.taskDefArn,
              SUBNET_IDS: config.subnetIds.join(","),
              SECURITY_GROUP_ID: config.securityGroupId,
            }
          : {
              SECRET_ARN: config.secretArn,
            },
      },
    });

    const rule = new aws.cloudwatch.EventRule(`job-${name}-schedule`, {
      name: `ops-job-${name}-schedule`,
      scheduleExpression: entry.schedule,
    });

    new aws.cloudwatch.EventTarget(`job-${name}-target`, {
      rule: rule.name,
      arn: fn.arn,
    });

    new aws.lambda.Permission(`job-${name}-permission`, {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "events.amazonaws.com",
      sourceArn: rule.arn,
    });

    lambdas[name] = fn;
  }

  return { regularJobRole, agentJobRole, lambdas };
};
