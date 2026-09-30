// Fan-out for Tier 1 BugBoss evals: one ECS task per (scenario, side, rep).
//
// EC2, not Fargate, because the sim's safety rests on Docker networking that
// Fargate does not offer. Every container in an awsvpc task shares one
// network namespace and none can get its own DNS name or extraHosts, so
// BugBoss could reach every stand-in's /__control port on localhost, reach
// Bedrock directly instead of through the counting proxy, and read the task
// role from 169.254.170.2. So each run is a single `runner` container holding
// the host's Docker socket, which brings up the same compose stack
// (bugboss-evals/sim/compose/stack.yml) a local run uses. BugBoss then sits on
// an internal Docker network with no default route, and the proof of that
// (bugboss-evals/sim/boundary.test.ts) covers what actually runs here.
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const ACCOUNT_ID = "333022194791";
const REGION = "us-west-2";
const VPC_ID = "vpc-0763fa52c32ebcf6a";

export const CLUSTER_NAME = "bugboss-evals";
export const TASK_FAMILY = "bugboss-evals-run";
export const RESULTS_BUCKET = "goodparty-bugboss-evals";
export const ECR_REPOSITORY = "bugboss-evals";
export const RUNNER_IMAGE = `${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPOSITORY}:runner`;
export const WORK_DIR = "/var/lib/bugboss-evals";
export const WORKFLOW_ROLE_NAME = "github-actions-bugboss-eval";
export const MODEL_ROLE_NAME = "bugboss-evals-model";
export const MODEL_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${MODEL_ROLE_NAME}`;
export const WORKFLOW_FILE = "bugboss-eval.yml";
export const OPS_MAIN_SUBJECT = "repo:thegoodparty/ops:ref:refs/heads/main";

// m6i.4xlarge: 16 vCPU, 64 GiB. A whole stack is BugBoss plus its agents'
// omni checkouts and test runs, the hidden check's own omni install in the
// GitHub stand-in, Grafana, Loki, Prometheus, Tempo, MinIO, two Postgres and
// the stand-ins. That fits in the reservation below, so an instance takes two
// runs, and pairs start together on one host more often than not, which is
// what keeps Bedrock latency comparable between the two sides.
export const INSTANCE_TYPE = "m6i.4xlarge";

// Resolved by EC2 at each launch rather than read by Pulumi, so a preview
// needs no SSM grant and a new recommended AMI is not a diff.
export const ECS_AMI = "resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id";
export const INSTANCE_MEMORY_MIB = 65536;
export const INSTANCE_VCPU = 16;
export const ROOT_VOLUME_GIB = 200;
export const MAX_INSTANCES = 12;

// ECS reserves memory for itself and the OS out of what the instance reports,
// so the registrable figure is below the nominal 64 GiB. Two runs at 24 GiB
// leave 16 GiB of it for that and for bursts.
export const ECS_AGENT_HEADROOM_MIB = 4096;

// The reservation is a scheduling figure for the whole stack, not a limit on
// the runner container: the runner itself is a Node process driving docker
// compose, and the stack's containers are started by the host daemon outside
// ECS accounting. Prod's BugBoss gets 16 GB for fifteen concurrent agents; a
// sim run works one incident with one agent, so 24 GB covers that agent's
// checkout and vitest, the hidden check's install beside it, and the
// observability containers, with headroom for a scenario that runs both at
// once after a merge.
export const RUNNER_MEMORY_RESERVATION_MIB = 24576;
export const RUNNER_CPU = 6144;

const TAGS = { Environment: "infra", Project: "bugboss-evals" };

const BEDROCK_RESOURCES = [
  "arn:aws:bedrock:*::foundation-model/*",
  `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/*`,
  `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:application-inference-profile/*`,
];

const ECR_REPOSITORY_ARN = `arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${ECR_REPOSITORY}`;
const RESULTS_BUCKET_ARN = `arn:aws:s3:::${RESULTS_BUCKET}`;

// Tier 2 resumes real incidents from their recorded Pi sessions. The runner
// reads one, cuts it at the PR, and hands the replay container only the cut;
// nothing that runs variant code gets this grant or the object.
export const PROD_SESSIONS_ARN = "arn:aws:s3:::bugboss-prod/sessions/incident/*";

export const ECR_PULL_ACTIONS = [
  "ecr:BatchCheckLayerAvailability",
  "ecr:BatchGetImage",
  "ecr:GetDownloadUrlForLayer",
];

export const ECR_PUSH_ACTIONS = [
  "ecr:CompleteLayerUpload",
  "ecr:InitiateLayerUpload",
  "ecr:PutImage",
  "ecr:UploadLayerPart",
];

type Statement = {
  Sid?: string;
  Effect: "Allow";
  Action: string[];
  Resource: string[];
};

export type PolicyDocument = { Version: "2012-10-17"; Statement: Statement[] };

// GetAuthorizationToken cannot be resource-scoped; it only issues a login and
// grants nothing on any repository by itself.
const ecrLogin: Statement = {
  Sid: "EcrLogin",
  Effect: "Allow",
  Action: ["ecr:GetAuthorizationToken"],
  Resource: ["*"],
};

const resultsReadWrite: Statement[] = [
  {
    Sid: "ResultsObjects",
    Effect: "Allow",
    Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
    Resource: [`${RESULTS_BUCKET_ARN}/*`],
  },
  {
    Sid: "ResultsList",
    Effect: "Allow",
    Action: ["s3:ListBucket"],
    Resource: [RESULTS_BUCKET_ARN],
  },
];

/**
 * IMDSv2 only, with a hop limit of 1: the token PUT's reply dies one hop past
 * the host, so no container on any bridge network, the stack's or the
 * runner's, can read the host role. Only the ECS agent, on the host network,
 * reaches it, and the host role holds nothing but the agent's managed policy.
 */
export const INSTANCE_METADATA_OPTIONS = {
  httpEndpoint: "enabled",
  httpTokens: "required",
  httpPutResponseHopLimit: 1,
};

/**
 * The only real credentials in a run. The runner assumes this role from its
 * task role and writes the session to a directory that only the model proxy
 * and the persona mount (sim/orchestrator.ts), so it is scoped to model calls
 * and nothing else.
 */
export const modelPolicy = (): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "Model",
      Effect: "Allow",
      Action: ["bedrock:InvokeModel*"],
      Resource: BEDROCK_RESOURCES,
    },
  ],
});

export const runnerTaskPolicy = (logGroupArn: string): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AssumeModelRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      Resource: [MODEL_ROLE_ARN],
    },
    ecrLogin,
    {
      Sid: "EcrPull",
      Effect: "Allow",
      Action: ECR_PULL_ACTIONS,
      Resource: [ECR_REPOSITORY_ARN],
    },
    ...resultsReadWrite,
    {
      Sid: "ReplayCheckpoints",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: [PROD_SESSIONS_ARN],
    },
    {
      Sid: "Logs",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: [`${logGroupArn}:*`],
    },
  ],
});

export const workflowPolicy = (args: {
  taskRoleArn: string;
  executionRoleArn: string;
}): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    ecrLogin,
    {
      Sid: "EcrPushPull",
      Effect: "Allow",
      Action: [...ECR_PULL_ACTIONS, ...ECR_PUSH_ACTIONS],
      Resource: [ECR_REPOSITORY_ARN],
    },
    {
      Sid: "RunEvalTasks",
      Effect: "Allow",
      Action: ["ecs:RunTask"],
      Resource: [
        `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:*`,
      ],
    },
    {
      Sid: "WatchEvalTasks",
      Effect: "Allow",
      Action: ["ecs:DescribeTasks", "ecs:StopTask"],
      Resource: [`arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task/${CLUSTER_NAME}/*`],
    },
    {
      Sid: "PassEvalRoles",
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: [args.taskRoleArn, args.executionRoleArn],
    },
    ...resultsReadWrite,
    // The judge runs in the workflow, after every run has finished.
    {
      Sid: "Judge",
      Effect: "Allow",
      Action: ["bedrock:InvokeModel*"],
      Resource: BEDROCK_RESOURCES,
    },
  ],
});

// Pinned to the workflow file as well as the ref, for the reason
// ci-roles/policies.ts gives: `sub` is shared by every workflow on main.
export const workflowTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Federated: `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": OPS_MAIN_SUBJECT,
          "token.actions.githubusercontent.com:job_workflow_ref": `thegoodparty/ops/.github/workflows/${WORKFLOW_FILE}@refs/heads/main`,
        },
      },
    },
  ],
};

// The lockdown for BugBoss is the internal Docker network, not this group.
// This only stops the host itself reaching anything but HTTP and HTTPS:
// Bedrock, ECR, Docker Hub and the npm registry.
export const INSTANCE_EGRESS = [443, 80].map((port) => ({
  protocol: "tcp",
  fromPort: port,
  toPort: port,
  cidrBlocks: ["0.0.0.0/0"],
}));

export const ECR_LIFECYCLE_POLICY = {
  rules: [
    {
      rulePriority: 1,
      description: "Per-commit variant and sim images outlive their eval by two weeks at most",
      selection: {
        tagStatus: "tagged",
        tagPatternList: ["bugboss-*", "sim-*"],
        countType: "sinceImagePushed",
        countUnit: "days",
        countNumber: 14,
      },
      action: { type: "expire" },
    },
    {
      rulePriority: 2,
      description: "Untagged layers left by re-pushing runner",
      selection: {
        tagStatus: "untagged",
        countType: "sinceImagePushed",
        countUnit: "days",
        countNumber: 1,
      },
      action: { type: "expire" },
    },
  ],
};

const ecsTrust = (service: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: service },
      },
    ],
  });

export interface BugBossEvalsConfig {
  subnetIds: string[];
}

export const createBugBossEvals = (config: BugBossEvalsConfig) => {
  const bucket = new aws.s3.Bucket("bugbossEvalsBucket", {
    bucket: RESULTS_BUCKET,
    tags: TAGS,
  });

  new aws.s3.BucketPublicAccessBlock("bugbossEvalsBucketPublicAccess", {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  // Run results and Tier 2 variant tarballs expire; seed bundles under omni/
  // and replay/ do not, because a missing one fails every run of that
  // scenario or case until somebody uploads it by hand (`cli.ts seed-bundle
  // --upload`, `cli.ts replay-bundle --upload`).
  new aws.s3.BucketLifecycleConfiguration("bugbossEvalsBucketLifecycle", {
    bucket: bucket.id,
    rules: [
      {
        id: "expire-runs",
        status: "Enabled",
        filter: { prefix: "runs/" },
        expiration: { days: 90 },
      },
      {
        id: "expire-variants",
        status: "Enabled",
        filter: { prefix: "variants/" },
        expiration: { days: 14 },
      },
      {
        id: "abort-incomplete-uploads",
        status: "Enabled",
        filter: {},
        abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      },
    ],
  });

  // Mutable because the task definition names the `runner` tag, which every
  // eval pushes afresh. Variant and sim images are tagged per commit and are
  // no use after the eval that built them.
  const repository = new aws.ecr.Repository("bugbossEvalsRepository", {
    name: ECR_REPOSITORY,
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: { scanOnPush: false },
    encryptionConfigurations: [{ encryptionType: "AES256" }],
    tags: TAGS,
  });

  new aws.ecr.LifecyclePolicy("bugbossEvalsRepositoryLifecycle", {
    repository: repository.name,
    policy: JSON.stringify(ECR_LIFECYCLE_POLICY),
  });

  const logGroup = new aws.cloudwatch.LogGroup("bugbossEvalsLogGroup", {
    name: "/aws/ecs/bugboss-evals",
    retentionInDays: 30,
    tags: TAGS,
  });

  const cluster = new aws.ecs.Cluster("bugbossEvalsCluster", {
    name: CLUSTER_NAME,
    tags: TAGS,
  });

  const instanceRole = new aws.iam.Role("bugbossEvalsInstanceRole", {
    name: "bugboss-evals-instance-role",
    assumeRolePolicy: ecsTrust("ec2.amazonaws.com"),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
    ],
    tags: TAGS,
  });

  const instanceProfile = new aws.iam.InstanceProfile(
    "bugbossEvalsInstanceProfile",
    { name: "bugboss-evals-instance", role: instanceRole.name, tags: TAGS },
  );

  const securityGroup = new aws.ec2.SecurityGroup("bugbossEvalsSg", {
    name: "bugboss-evals-host",
    description: "BugBoss eval hosts: no ingress, HTTP and HTTPS egress only",
    vpcId: VPC_ID,
    ingress: [],
    egress: INSTANCE_EGRESS,
    tags: TAGS,
  });

  const launchTemplate = new aws.ec2.LaunchTemplate("bugbossEvalsLaunchTemplate", {
    name: "bugboss-evals",
    imageId: ECS_AMI,
    instanceType: INSTANCE_TYPE,
    iamInstanceProfile: { arn: instanceProfile.arn },
    metadataOptions: INSTANCE_METADATA_OPTIONS,
    networkInterfaces: [
      {
        associatePublicIpAddress: "true",
        securityGroups: [securityGroup.id],
        deleteOnTermination: "true",
      },
    ],
    blockDeviceMappings: [
      {
        deviceName: "/dev/xvda",
        ebs: {
          volumeSize: ROOT_VOLUME_GIB,
          volumeType: "gp3",
          deleteOnTermination: "true",
          encrypted: "true",
        },
      },
    ],
    userData: Buffer.from(
      [
        "#!/bin/bash",
        `echo ECS_CLUSTER=${CLUSTER_NAME} >> /etc/ecs/ecs.config`,
        // Task roles in bridge mode are off by default on Linux, and the
        // runner's is the only route to the model role now that IMDS is
        // closed to containers.
        "echo ECS_ENABLE_TASK_IAM_ROLE=true >> /etc/ecs/ecs.config",
        `mkdir -p ${WORK_DIR}`,
      ].join("\n"),
    ).toString("base64"),
    tagSpecifications: [
      { resourceType: "instance", tags: TAGS },
      { resourceType: "volume", tags: TAGS },
    ],
    tags: TAGS,
  });

  const autoScalingGroup = new aws.autoscaling.Group("bugbossEvalsAsg", {
    name: "bugboss-evals",
    minSize: 0,
    maxSize: MAX_INSTANCES,
    desiredCapacity: 0,
    vpcZoneIdentifiers: config.subnetIds,
    launchTemplate: { id: launchTemplate.id, version: "$Latest" },
    // Managed termination protection needs this, and it is what stops a
    // scale-in from killing a host with a run still on it.
    protectFromScaleIn: true,
    tags: [
      ...Object.entries(TAGS).map(([key, value]) => ({
        key,
        value,
        propagateAtLaunch: true,
      })),
      { key: "AmazonECSManaged", value: "true", propagateAtLaunch: true },
    ],
  }, { ignoreChanges: ["desiredCapacity"] });

  const capacityProvider = new aws.ecs.CapacityProvider("bugbossEvalsCapacity", {
    name: "bugboss-evals",
    autoScalingGroupProvider: {
      autoScalingGroupArn: autoScalingGroup.arn,
      managedTerminationProtection: "ENABLED",
      managedScaling: {
        status: "ENABLED",
        targetCapacity: 100,
        minimumScalingStepSize: 1,
        maximumScalingStepSize: MAX_INSTANCES,
      },
    },
    tags: TAGS,
  });

  new aws.ecs.ClusterCapacityProviders("bugbossEvalsClusterCapacity", {
    clusterName: cluster.name,
    capacityProviders: [capacityProvider.name],
    defaultCapacityProviderStrategies: [
      { capacityProvider: capacityProvider.name, weight: 1 },
    ],
  });

  const executionRole = new aws.iam.Role("bugbossEvalsExecutionRole", {
    name: "bugboss-evals-execution-role",
    assumeRolePolicy: ecsTrust("ecs-tasks.amazonaws.com"),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    ],
    tags: TAGS,
  });

  const taskRole = new aws.iam.Role("bugbossEvalsTaskRole", {
    name: "bugboss-evals-task-role",
    assumeRolePolicy: ecsTrust("ecs-tasks.amazonaws.com"),
    inlinePolicies: [
      {
        name: "inline",
        policy: logGroup.arn.apply((arn) =>
          JSON.stringify(runnerTaskPolicy(arn)),
        ),
      },
    ],
    tags: TAGS,
  });

  new aws.iam.Role("bugbossEvalsModelRole", {
    name: MODEL_ROLE_NAME,
    description: "Bedrock only. Assumed by the eval runner for the model proxy and the persona.",
    assumeRolePolicy: taskRole.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Action: "sts:AssumeRole", Effect: "Allow", Principal: { AWS: arn } },
        ],
      }),
    ),
    inlinePolicies: [{ name: "inline", policy: JSON.stringify(modelPolicy()) }],
    tags: TAGS,
  });

  const taskDefinition = new aws.ecs.TaskDefinition("bugbossEvalsTaskDef", {
    family: TASK_FAMILY,
    networkMode: "bridge",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    volumes: [
      { name: "docker-socket", hostPath: "/var/run/docker.sock" },
      { name: "work", hostPath: WORK_DIR },
    ],
    containerDefinitions: pulumi.jsonStringify([
      {
        name: "runner",
        image: RUNNER_IMAGE,
        cpu: RUNNER_CPU,
        memoryReservation: RUNNER_MEMORY_RESERVATION_MIB,
        essential: true,
        // Enough for the orchestrator to collect outputs and bring the stack
        // down when the workflow stops a task at its timeout.
        stopTimeout: 120,
        // The same path on both sides: compose resolves bind mounts on the
        // host, so a run directory the runner writes must exist at that path
        // there too.
        mountPoints: [
          { sourceVolume: "docker-socket", containerPath: "/var/run/docker.sock" },
          { sourceVolume: "work", containerPath: WORK_DIR },
        ],
        environment: [
          { name: "AWS_REGION", value: REGION },
          { name: "AWS_DEFAULT_REGION", value: REGION },
          { name: "BUGBOSS_EVALS_WORK", value: WORK_DIR },
          { name: "EVALS_BUCKET", value: bucket.bucket },
          { name: "BUGBOSS_EVALS_MODEL_ROLE_ARN", value: MODEL_ROLE_ARN },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup.name,
            "awslogs-region": REGION,
            "awslogs-stream-prefix": "runner",
          },
        },
      },
    ]),
    tags: TAGS,
  });

  const workflowRole = new aws.iam.Role("githubActionsBugbossEval", {
    name: WORKFLOW_ROLE_NAME,
    description:
      "Tier 1 BugBoss eval fan-out. Assumed only by bugboss-eval.yml on thegoodparty/ops main.",
    assumeRolePolicy: JSON.stringify(workflowTrust),
    // The workflow waits up to five hours on its runs, then judges them.
    maxSessionDuration: 21600,
    tags: TAGS,
  });

  new aws.iam.RolePolicy("githubActionsBugbossEvalPolicy", {
    name: "BugbossEval",
    role: workflowRole.id,
    policy: pulumi
      .all([taskRole.arn, executionRole.arn])
      .apply(([taskRoleArn, executionRoleArn]) =>
        JSON.stringify(workflowPolicy({ taskRoleArn, executionRoleArn })),
      ),
  });

  return {
    repository,
    bucket,
    cluster,
    taskDefinition,
    workflowRole,
    logGroup,
  };
};
