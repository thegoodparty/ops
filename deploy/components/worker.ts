import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { secondOpinionInvokeResources } from "../../utils/bedrock-models";

export interface WorkerConfig {
  imageUri: string;
  secretArn: string;
  secretKeys: string[];
  subnetIds: string[];
  securityGroupIds: string[];
}

export const createWorker = (config: WorkerConfig) => {
  const cluster = new aws.ecs.Cluster("agentCluster", {
    name: "delegate-cluster",
    settings: [{ name: "containerInsights", value: "enabled" }],
  });

  const logGroup = new aws.cloudwatch.LogGroup("agentLogGroup", {
    name: "/aws/ecs/delegate",
    retentionInDays: 30,
  });

  new aws.cloudwatch.LogMetricFilter("workflowPhaseCompleted", {
    name: "workflow-phase-completed",
    logGroupName: logGroup.name,
    pattern: '{ $.event = "workflow_phase_completed" }',
    metricTransformation: {
      namespace: "Delegate/Workflow",
      name: "PhaseCompleted",
      value: "1",
      dimensions: {
        phase: "$.phase",
        outcome: "$.outcome",
      },
    },
  });

  // Cost is dimensioned by both phase AND outcome so we can chart cost-of-
  // failures separately — a high cost-on-error trend is the early-warning
  // signal for an agent looping in its error path.
  new aws.cloudwatch.LogMetricFilter("workflowPhaseCost", {
    name: "workflow-phase-cost",
    logGroupName: logGroup.name,
    pattern: '{ $.event = "workflow_phase_completed" }',
    metricTransformation: {
      namespace: "Delegate/Workflow",
      name: "PhaseCostUsd",
      value: "$.costUsd",
      dimensions: {
        phase: "$.phase",
        outcome: "$.outcome",
      },
    },
  });

  const executionRole = new aws.iam.Role("agentExecutionRole", {
    name: "delegate-execution-role",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
        },
      ],
    }),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    ],
    inlinePolicies: [
      {
        name: "secrets",
        policy: pulumi.jsonStringify({
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

  const taskRole = new aws.iam.Role("agentTaskRole", {
    name: "delegate-task-role",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
        },
      ],
    }),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess",
      "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
      "arn:aws:iam::aws:policy/AmazonRDSReadOnlyAccess",
      "arn:aws:iam::aws:policy/AWSSSOReadOnly",
      "arn:aws:iam::aws:policy/AWSSSODirectoryReadOnly",
    ],
    inlinePolicies: [
      {
        name: "inline",
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "ssmmessages:OpenDataChannel",
                "ssmmessages:OpenControlChannel",
                "ssmmessages:CreateDataChannel",
                "ssmmessages:CreateControlChannel",
              ],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["ecs:Describe*", "ecs:List*"],
              Resource: ["*"],
            },
            {
              Sid: "IAMRoleAndPolicyLookups",
              Effect: "Allow",
              Action: [
                "iam:GetRole",
                "iam:ListRoles",
                "iam:GetRolePolicy",
                "iam:ListRolePolicies",
                "iam:ListAttachedRolePolicies",
                "iam:GetPolicy",
                "iam:ListPolicies",
                "iam:GetPolicyVersion",
                "iam:ListPolicyVersions",
                "iam:ListEntitiesForPolicy",
                "iam:GetInstanceProfile",
                "iam:ListInstanceProfiles",
                "iam:ListInstanceProfilesForRole",
              ],
              Resource: ["*"],
            },
            {
              Sid: "LambdaMetadataNoEnvVars",
              Effect: "Allow",
              Action: [
                "lambda:ListEventSourceMappings",
                "lambda:GetEventSourceMapping",
                "lambda:GetPolicy",
                "lambda:ListAliases",
                "lambda:GetAccountSettings",
                "lambda:ListLayers",
                "lambda:ListLayerVersions",
                "lambda:GetLayerVersion",
                "lambda:ListTags",
                "lambda:ListFunctionUrlConfigs",
                "lambda:GetFunctionUrlConfig",
              ],
              Resource: ["*"],
            },
            // The pr-reviewer's second-opinion pass, which reviews the same
            // diff with a non-Claude frontier model and signs its Bedrock
            // calls as this role — no static API key anywhere.
            //
            // Scoped to one model, not to Bedrock. `aws-marketplace:*` is
            // deliberately absent: that permission is what lets a
            // prompt-injected agent pull an arbitrary model out of the
            // catalogue and invoke it, and this agent reads untrusted PR
            // content for a living. Bedrock would otherwise subscribe on
            // first invocation, so the model is subscribed out of band
            // instead — `scripts/enable-bedrock-models.ts`, whose header
            // spells this out, and `docs/workbench-account.md`.
            {
              Sid: "BedrockSecondOpinionReview",
              Effect: "Allow",
              Action: [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
              ],
              Resource: secondOpinionInvokeResources(),
            },
          ],
        }),
      },
    ],
  });

  const taskDefinition = new aws.ecs.TaskDefinition("agentTaskDef", {
    family: "delegate",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "4096",
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    runtimePlatform: {
      cpuArchitecture: "X86_64",
      operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.jsonStringify([
      {
        name: "agent",
        image: config.imageUri,
        cpu: 1024,
        memory: 4096,
        essential: true,
        // Both, not one. `AWS_DEFAULT_REGION` is what the CLI reads;
        // the SDK's credential and SigV4 signing path prefers `AWS_REGION`
        // and does not fall back to the other, so the second-opinion pass
        // would have had no region to sign with.
        environment: [
          { name: "AWS_DEFAULT_REGION", value: "us-west-2" },
          { name: "AWS_REGION", value: "us-west-2" },
        ],
        secrets: config.secretKeys.sort().map((key) => ({
          name: key,
          valueFrom: `${config.secretArn}:${key}::`,
        })),
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup.name,
            "awslogs-region": "us-west-2",
            "awslogs-stream-prefix": "agent",
          },
        },
        linuxParameters: { initProcessEnabled: true },
      },
    ]),
  });

  return {
    cluster,
    taskDefinition,
    logGroup,
    subnetIds: config.subnetIds,
    securityGroupIds: config.securityGroupIds,
  };
};
