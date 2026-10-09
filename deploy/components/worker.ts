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

  const reviewsBucket = new aws.s3.BucketV2("reviewsBucket", {
    bucket: "delegate-reviews",
  });

  new aws.s3.BucketVersioningV2("reviewsBucketVersioning", {
    bucket: reviewsBucket.id,
    versioningConfiguration: { status: "Enabled" },
  });

  new aws.s3.BucketPublicAccessBlock("reviewsBucketPublicAccess", {
    bucket: reviewsBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketServerSideEncryptionConfigurationV2("reviewsBucketEncryption", {
    bucket: reviewsBucket.id,
    rules: [
      {
        applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" },
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
              Sid: "ReviewBucketObjects",
              Effect: "Allow",
              Action: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
              Resource: ["arn:aws:s3:::delegate-reviews/*"],
            },
            {
              Sid: "ReviewBucketList",
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: ["arn:aws:s3:::delegate-reviews"],
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
        environment: [
          { name: "AWS_DEFAULT_REGION", value: "us-west-2" },
          { name: "REVIEW_BUCKET", value: "delegate-reviews" },
          // The image tag is the ops commit; the review record stores it as
          // agentVersion so evals can name the variant that produced a review.
          { name: "AGENT_VERSION", value: config.imageUri.split(":").pop() ?? "unknown" },
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
