import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

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
        environment: [{ name: "AWS_DEFAULT_REGION", value: "us-west-2" }],
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
