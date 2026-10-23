import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";

// Self-hosted GitHub Actions runners on ECS. Design, the security model and
// the switch-on checklist are in gh-runners/README.md; read it before
// changing anything here.
//
// Two halves. The dispatch Lambda receives the GitHub App's workflow_job
// webhook and, per queued gp-ecs job, starts one runner task. Runner tasks run
// on an EC2 capacity provider because jobs need a Docker daemon (service
// containers, docker build), which Fargate cannot give them.

const NAME = "gh-runners";
const REGION = "us-west-2";
// The same VPC and public subnet as the swarm host. Bridge-mode tasks use the
// instance's public IP for egress, so no NAT gateway is needed.
const VPC_ID = "vpc-0930cabea81245d01";
const SUBNET_IDS = ["subnet-0184e0f40b440ab13"];
const LOG_GROUP = `/${NAME}`;
export const CLUSTER_NAME = NAME;
export const RUNNER_FAMILY = "gh-runner";
export const RUNNER_CONTAINER = "runner";
const DISPATCH_NAME = `${NAME}-dispatch`;
const DISPATCH_LOG_GROUP = `/${NAME}/dispatch`;
const ORG = "thegoodparty";
const RUNNER_GROUP = "gp-ecs";
const ALLOWED_REPOS = ["thegoodparty/ops", "thegoodparty/omni"];

// Two runner tasks fit on one m7i.2xlarge (8 vCPU, 32 GiB) after the ECS
// agent's reservation. A task matches GitHub's 4-core larger runner.
const INSTANCE_TYPE = "m7i.2xlarge";
const RUNNER_CPU = 4096;
const RUNNER_MEMORY_MIB = 14336;
const MAX_INSTANCES = 4;

const TAGS = { Name: NAME, Project: NAME };

const ROOT = path.resolve(__dirname, "../gh-runners");

const listFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    )
    .sort();

// A content hash of the image's build context, used as its tag. CI builds and
// pushes under the same tag (gh-runners/push-images.sh calls this), so a
// preview of an unchanged image shows no task definition diff, and a pushed
// tag never needs to move.
export const imageTag = (image: "runner") => {
  const dir = path.join(ROOT, image);
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(dir).filter((f) => !f.endsWith(".md"))) {
    hash.update(path.relative(dir, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
};

export const instanceUserData = () =>
  [
    "#!/bin/bash",
    "set -euo pipefail",
    `echo ECS_CLUSTER=${CLUSTER_NAME} >> /etc/ecs/ecs.config`,
    // Tags are content hashes and never move, so a cached image is always
    // the right one. This is what makes a warm host start a job in seconds.
    "echo ECS_IMAGE_PULL_BEHAVIOR=prefer-cached >> /etc/ecs/ecs.config",
    // Each job's /var/lib/docker is a task volume on the root disk. Reclaim
    // it soon after the task stops rather than after the 3h default.
    "echo ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=2m >> /etc/ecs/ecs.config",
    "echo ECS_ENABLE_TASK_IAM_ROLE=false >> /etc/ecs/ecs.config",
  ].join("\n");

// Bundled here rather than by a build step, the same as buildSheriffCode: the
// deploy-infrastructure workflow and its preview run no build.
export const buildDispatchCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "gh-runners-dispatch/handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("esbuild produced no output for the gh-runners dispatch handler");
  }
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

export const createGhRunners = (args: { provider: aws.Provider }) => {
  const { provider } = args;
  const opts = { provider };

  const runnerRepo = new aws.ecr.Repository(
    "ghRunnersRunnerRepo",
    {
      name: `${NAME}/runner`,
      imageTagMutability: "IMMUTABLE",
      imageScanningConfiguration: { scanOnPush: true },
      forceDelete: true,
      tags: TAGS,
    },
    opts,
  );

  new aws.ecr.LifecyclePolicy(
    "ghRunnersRunnerRepoLifecycle",
    {
      repository: runnerRepo.name,
      policy: JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: "Keep the last 10 images",
            selection: {
              tagStatus: "any",
              countType: "imageCountMoreThan",
              countNumber: 10,
            },
            action: { type: "expire" },
          },
        ],
      }),
    },
    opts,
  );

  const logGroup = new aws.cloudwatch.LogGroup(
    "ghRunnersLogs",
    { name: LOG_GROUP, retentionInDays: 14, tags: TAGS },
    opts,
  );

  const securityGroup = new aws.ec2.SecurityGroup(
    "ghRunnersSecurityGroup",
    {
      name: NAME,
      description: "GitHub Actions runners: egress only",
      vpcId: VPC_ID,
      egress: [
        {
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
        },
      ],
      tags: TAGS,
    },
    opts,
  );

  const cluster = new aws.ecs.Cluster(
    "ghRunnersCluster",
    { name: CLUSTER_NAME, tags: TAGS },
    opts,
  );

  const instanceRole = new aws.iam.Role(
    "ghRunnersInstanceRole",
    {
      name: `${NAME}-instance`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags: TAGS,
    },
    opts,
  );

  for (const [key, policyArn] of [
    ["Ecs", "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"],
    ["Ssm", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"],
  ] as const) {
    new aws.iam.RolePolicyAttachment(
      `ghRunnersInstance${key}`,
      { role: instanceRole.name, policyArn },
      opts,
    );
  }

  const instanceProfile = new aws.iam.InstanceProfile(
    "ghRunnersInstanceProfile",
    { name: `${NAME}-instance`, role: instanceRole.name, tags: TAGS },
    opts,
  );

  const launchTemplate = new aws.ec2.LaunchTemplate(
    "ghRunnersLaunchTemplate",
    {
      name: NAME,
      // Resolved by EC2 at launch, so every new host gets the current
      // ECS-optimized AMI and a preview needs no SSM read.
      imageId:
        "resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id",
      instanceType: INSTANCE_TYPE,
      iamInstanceProfile: { arn: instanceProfile.arn },
      networkInterfaces: [
        {
          associatePublicIpAddress: "true",
          securityGroups: [securityGroup.id],
          deleteOnTermination: "true",
        },
      ],
      // Hop limit 1 keeps job containers, which sit one network hop behind
      // the host, from reading the instance role off IMDS.
      metadataOptions: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 1,
      },
      blockDeviceMappings: [
        {
          deviceName: "/dev/xvda",
          ebs: {
            volumeSize: 200,
            volumeType: "gp3",
            iops: 6000,
            throughput: 500,
            encrypted: "true",
            deleteOnTermination: "true",
          },
        },
      ],
      userData: Buffer.from(instanceUserData()).toString("base64"),
      tagSpecifications: [
        { resourceType: "instance", tags: TAGS },
        { resourceType: "volume", tags: TAGS },
      ],
      tags: TAGS,
    },
    opts,
  );

  const asg = new aws.autoscaling.Group(
    "ghRunnersAsg",
    {
      name: NAME,
      minSize: 0,
      maxSize: MAX_INSTANCES,
      vpcZoneIdentifiers: SUBNET_IDS,
      launchTemplate: { id: launchTemplate.id, version: "$Latest" },
      // Required by managed termination protection: ECS lifts it on a host
      // only once the host runs no tasks, so a scale-in never kills a job.
      protectFromScaleIn: true,
      tags: [
        { key: "AmazonECSManaged", value: "true", propagateAtLaunch: true },
        { key: "Name", value: NAME, propagateAtLaunch: true },
      ],
    },
    // The capacity provider owns desiredCapacity, and the schedules below own
    // minSize.
    { provider, ignoreChanges: ["desiredCapacity", "minSize"] },
  );

  // One warm host in working hours, so the first job of the day does not wait
  // ~3 minutes for a boot and an image pull. Times are UTC: 13:00-02:00 is
  // 06:00-19:00 Pacific in daylight time.
  new aws.autoscaling.Schedule(
    "ghRunnersWarmMorning",
    {
      scheduledActionName: `${NAME}-warm`,
      autoscalingGroupName: asg.name,
      recurrence: "0 13 * * 1-5",
      minSize: 1,
      maxSize: MAX_INSTANCES,
      desiredCapacity: -1,
    },
    opts,
  );

  new aws.autoscaling.Schedule(
    "ghRunnersColdEvening",
    {
      scheduledActionName: `${NAME}-cold`,
      autoscalingGroupName: asg.name,
      recurrence: "0 2 * * 2-6",
      minSize: 0,
      maxSize: MAX_INSTANCES,
      desiredCapacity: -1,
    },
    opts,
  );

  const capacityProvider = new aws.ecs.CapacityProvider(
    "ghRunnersCapacityProvider",
    {
      name: NAME,
      autoScalingGroupProvider: {
        autoScalingGroupArn: asg.arn,
        managedTerminationProtection: "ENABLED",
        managedDraining: "ENABLED",
        managedScaling: {
          status: "ENABLED",
          targetCapacity: 100,
          minimumScalingStepSize: 1,
          maximumScalingStepSize: MAX_INSTANCES,
          instanceWarmupPeriod: 60,
        },
      },
      tags: TAGS,
    },
    opts,
  );

  new aws.ecs.ClusterCapacityProviders(
    "ghRunnersClusterCapacityProviders",
    {
      clusterName: cluster.name,
      capacityProviders: [capacityProvider.name],
      defaultCapacityProviderStrategies: [
        { capacityProvider: capacityProvider.name, weight: 1 },
      ],
    },
    opts,
  );

  const ecsTasksTrust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ecs-tasks.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });

  const secret = new aws.secretsmanager.Secret(
    "ghRunnersGithubAppSecret",
    {
      name: "GH_RUNNERS_GITHUB_APP",
      description:
        "GitHub App credentials for the gh-runners dispatch Lambda: JSON with app_id, installation_id, private_key, webhook_secret. Filled by hand; see gh-runners/README.md.",
      tags: TAGS,
    },
    { provider, protect: true },
  );

  const executionRole = new aws.iam.Role(
    "ghRunnersExecutionRole",
    { name: `${NAME}-execution`, assumeRolePolicy: ecsTasksTrust, tags: TAGS },
    opts,
  );

  new aws.iam.RolePolicyAttachment(
    "ghRunnersExecutionManaged",
    {
      role: executionRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    },
    opts,
  );

  // No task role on the runner. A job gets AWS access the way it does on a
  // GitHub-hosted runner, through OIDC, and nothing else.
  const runnerTaskDefinition = new aws.ecs.TaskDefinition(
    "ghRunnerTaskDefinition",
    {
      family: RUNNER_FAMILY,
      requiresCompatibilities: ["EC2"],
      // Bridge, not awsvpc: one container runs its own dockerd, so a service
      // container's published port lands on that container's localhost, the
      // same as on a hosted runner. awsvpc on EC2 would also need private
      // subnets and a NAT gateway.
      networkMode: "bridge",
      cpu: String(RUNNER_CPU),
      memory: String(RUNNER_MEMORY_MIB),
      executionRoleArn: executionRole.arn,
      volumes: [
        {
          name: "docker-data",
          dockerVolumeConfiguration: { scope: "task", driver: "local" },
        },
      ],
      containerDefinitions: pulumi
        .all([runnerRepo.repositoryUrl, logGroup.name])
        .apply(([repoUrl, logGroupName]) =>
          JSON.stringify([
            {
              name: RUNNER_CONTAINER,
              image: `${repoUrl}:${imageTag("runner")}`,
              essential: true,
              // dockerd needs it. This is the one real escape hatch to the
              // host; the README's security section is about this line.
              privileged: true,
              mountPoints: [
                { sourceVolume: "docker-data", containerPath: "/var/lib/docker" },
              ],
              ulimits: [{ name: "nofile", softLimit: 65536, hardLimit: 65536 }],
              stopTimeout: 120,
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": logGroupName,
                  "awslogs-region": REGION,
                  "awslogs-stream-prefix": "runner",
                },
              },
            },
          ]),
        ),
      tags: TAGS,
    },
    opts,
  );

  const clusterArn = `arn:aws:ecs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:cluster/${CLUSTER_NAME}`;

  const dispatchLogGroup = new aws.cloudwatch.LogGroup(
    "ghRunnersDispatchLogs",
    { name: DISPATCH_LOG_GROUP, retentionInDays: 14, tags: TAGS },
    opts,
  );

  const dispatchRole = new aws.iam.Role(
    "ghRunnersDispatchRole",
    {
      name: DISPATCH_NAME,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags: TAGS,
    },
    opts,
  );

  const dispatchPolicy = new aws.iam.RolePolicy(
    "ghRunnersDispatchPolicy",
    {
      name: "dispatch-runner-tasks",
      role: dispatchRole.name,
      policy: pulumi
        .all([secret.arn, executionRole.arn])
        .apply(([secretArn, executionRoleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "OwnLogs",
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:${DISPATCH_LOG_GROUP}:*`,
              },
              {
                Sid: "ReadGithubAppSecret",
                Effect: "Allow",
                Action: "secretsmanager:GetSecretValue",
                Resource: secretArn,
              },
              {
                Sid: "RunRunnerTasks",
                Effect: "Allow",
                Action: "ecs:RunTask",
                Resource: `arn:aws:ecs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:task-definition/${RUNNER_FAMILY}:*`,
                Condition: { ArnEquals: { "ecs:cluster": clusterArn } },
              },
              {
                Sid: "TagRunnerTasksAtLaunch",
                Effect: "Allow",
                Action: "ecs:TagResource",
                Resource: `arn:aws:ecs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:task/${CLUSTER_NAME}/*`,
                Condition: { StringEquals: { "ecs:CreateAction": "RunTask" } },
              },
              {
                Sid: "PassRunnerExecutionRole",
                Effect: "Allow",
                Action: "iam:PassRole",
                Resource: executionRoleArn,
                Condition: {
                  StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
                },
              },
            ],
          }),
        ),
    },
    opts,
  );

  const dispatchFunction = new aws.lambda.Function(
    "ghRunnersDispatch",
    {
      name: DISPATCH_NAME,
      role: dispatchRole.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildDispatchCode(),
      // GitHub gives up on a delivery after 10 seconds.
      timeout: 10,
      memorySize: 256,
      loggingConfig: { logFormat: "Text", logGroup: dispatchLogGroup.name },
      environment: {
        variables: {
          SECRET_ARN: secret.arn,
          ORG,
          RUNNER_GROUP,
          ALLOWED_REPOS: ALLOWED_REPOS.join(","),
          ECS_CLUSTER: CLUSTER_NAME,
          RUNNER_TASK_DEFINITION: RUNNER_FAMILY,
          RUNNER_CAPACITY_PROVIDER: capacityProvider.name,
        },
      },
      tags: TAGS,
    },
    { provider, dependsOn: [dispatchLogGroup, dispatchPolicy] },
  );

  // Public, like the delegate and sheriff webhooks. The handler rejects any
  // request without a valid X-Hub-Signature-256 before it does anything.
  const dispatchUrl = new aws.lambda.FunctionUrl(
    "ghRunnersDispatchUrl",
    { functionName: dispatchFunction.name, authorizationType: "NONE" },
    opts,
  );

  // New function URLs need both statements for public invoke.
  new aws.lambda.Permission(
    "ghRunnersDispatchUrlInvoke",
    {
      action: "lambda:InvokeFunctionUrl",
      function: dispatchFunction.name,
      principal: "*",
      functionUrlAuthType: "NONE",
    },
    opts,
  );

  new aws.lambda.Permission(
    "ghRunnersDispatchUrlInvokeFunction",
    {
      action: "lambda:InvokeFunction",
      function: dispatchFunction.name,
      principal: "*",
      invokedViaFunctionUrl: true,
    },
    opts,
  );

  return {
    cluster,
    runnerRepo,
    runnerTaskDefinition,
    dispatchFunction,
    webhookUrl: dispatchUrl.functionUrl,
    secret,
  };
};
