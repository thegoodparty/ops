import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { DEFAULT_MODEL_ID } from "../../bugboss/bedrock/model";
import { TEST_DB_ENV_VAR } from "../../bugboss/testdb";

const ACCOUNT_ID = "333022194791";
const REGION = "us-west-2";
const VPC_ID = "vpc-0763fa52c32ebcf6a";
const HOSTED_ZONE_ID = "Z10392302OXMPNQLPO07K";
const HOSTNAME = "bugboss.goodparty.org";
const BUCKET_NAME = "bugboss-prod";
const SECRET_NAME = "BUGBOSS";
const CONTAINER_PORT = 3000;

// Fargate takes container `memory` as a hard limit whose sum may not exceed
// the task's, and container `cpu` as a relative share a container may burst
// past while others are idle. So the CPU slice is free and the memory one is
// not.
//
// The task grows by the sidecar's share rather than BugBoss giving it up.
// Nobody has measured fifteen agents against 16 GB, and the failure if 14
// turned out to be too little is an OOM-killed child mid-incident -- quiet,
// and exactly the shape of failure this system exists to avoid.
//
// The sidecar gets 3 GB rather than 2 because of what the two limits do when
// they are hit. Measured on this image at 203 concurrent backends: 905 MB
// resident, so ~3.8 MB a backend above a 128 MB shared_buffers, which puts
// the 400-connection ceiling near 1.65 GB. In 2 GB that is 20% of headroom.
// Exhausting connections is loud and survivable -- Postgres says "too many
// clients already" and the run fails. Exhausting memory is not: the sidecar
// is OOM-killed, nothing restarts a non-essential container, and every agent
// loses its test database at once. So size the memory so the connection
// ceiling is always what gives first.
export const TASK_CPU = 4096;
export const TASK_MEMORY = 19456;
export const POSTGRES_CPU = 512;
export const POSTGRES_MEMORY = 3072;
export const BUGBOSS_CPU = 3584;
export const BUGBOSS_MEMORY = 16384;

// Matches omni's own harness (packages/gp-api/src/test-postgres.ts) so an
// agent gets the database that file expects. It cannot set these itself: they
// are postmaster-context settings, fixed when the server starts, and the whole
// point here is a server the harness did not start.
//
// Durability buys nothing and costs a lot: the per-test reset TRUNCATEs, whose
// commit syncs a freshly created relation file per table, measured there at
// ~350-400ms against ~10ms with these off. Nothing in this database outlives
// the task.
//
// 300 is what omni asks for, sized for concurrent checkouts on one machine.
// This task is fifteen of them: a run draws roughly 25 at the harness's pool
// cap, so 400 covers the circuit breaker's worth of agents all testing at once.
// Past it Postgres says "too many clients already", which is loud.
const POSTGRES_SETTINGS = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
  "-c",
  "max_connections=400",
];

// Credentials the harness already expects, and the maintenance database it
// derives every per-suite database from. All three are fixed by
// packages/gp-api/src/test-postgres.ts; they are not secrets, because nothing
// outside this task's network namespace can reach this port.
const POSTGRES_USER = "test_user";
const POSTGRES_PASSWORD = "test_password";
const POSTGRES_DB = "postgres";
const POSTGRES_PORT = 5432;

/**
 * Exported so the value this deploy writes is checked against the guard that
 * reads it, rather than the two agreeing by inspection.
 */
export const TEST_DB_URL = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}`;

// `Environment: infra` is a protection, not a label. The EngineerAccess SSO
// permission set grants every engineer `Action: ["*"]` on anything tagged
// `Environment: dev`, so tagging BugBoss `dev` would hand every engineer full
// control of the incident system. `ops` has no `prod` tag value; prod-only
// means `infra`. `Project` overrides the stack default of `ops`.
const TAGS = { Environment: "infra", Project: "bugboss" };

/**
 * The model the agent is invoked through, so the spend is attributable.
 *
 * Bedrock puts no cost tag on an InvokeModel request. An application
 * inference profile is the only mechanism AWS offers: a tagged wrapper you
 * pass as `modelId`, whose usage then lands under those tags in Cost
 * Explorer. Without it every dollar BugBoss spends is indistinguishable from
 * every other Bedrock call in the account.
 *
 * It is not a control. Cost Explorer lags about a day, so nothing can be
 * enforced on this. What it buys is the one number the local price table can
 * be checked against -- which matters because that table is Pi's hardcoded
 * per-model list, and the day AWS moves a rate it goes stale with nothing in
 * an estimate that could say so. Every cost BugBoss reports is an estimate
 * for that reason; this is how anyone ever finds out the estimate drifted.
 *
 * Opus only, deliberately. The agent's model is runtime-configurable through
 * BUGBOSS_MODEL_ID and retunes from SSM without a deploy, so the mapping
 * below is a map rather than a switch: a model nobody wrapped falls back to
 * the bare id and loses its attribution, which is the right way round.
 */
const AGENT_INFERENCE_PROFILE_SOURCE = `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/${DEFAULT_MODEL_ID}`;

export interface BugBossConfig {
  imageUri: pulumi.Input<string>;
  subnetIds: string[];
}

export const createBugBoss = (config: BugBossConfig) => {
  const bucket = new aws.s3.Bucket("bugbossBucket", {
    bucket: BUCKET_NAME,
    tags: TAGS,
  });

  new aws.s3.BucketPublicAccessBlock("bugbossBucketPublicAccess", {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketVersioning("bugbossBucketVersioning", {
    bucket: bucket.id,
    versioningConfiguration: { status: "Enabled" },
  });

  new aws.s3.BucketLifecycleConfiguration("bugbossBucketLifecycle", {
    bucket: bucket.id,
    rules: [
      // Session transcripts are never expired. They are the whole record of
      // what an agent did and why, they are what a post-mortem is checked
      // against months later, and they are small. Nothing here deletes them.
      //
      // Versioning plus a whole-object PUT of the snapshot on every committed
      // write means thousands of noncurrent versions a day. Without this the
      // bucket grows without bound for a database that stays single-digit
      // megabytes. The ten newest are always retained, which is the rollback
      // window; anything older than a day beyond that is gone.
      {
        id: "expire-noncurrent-state",
        status: "Enabled",
        filter: { prefix: "state/" },
        noncurrentVersionExpiration: {
          noncurrentDays: 1,
          newerNoncurrentVersions: 10,
        },
      },
      {
        id: "abort-incomplete-uploads",
        status: "Enabled",
        filter: {},
        abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      },
    ],
  });

  const logGroup = new aws.cloudwatch.LogGroup("bugbossLogGroup", {
    name: "/aws/ecs/bugboss",
    retentionInDays: 30,
    tags: TAGS,
  });

  // Looked up, never declared. The secret is created and populated by hand,
  // so declaring it here would fail the whole stack update on the first apply
  // with ResourceExistsException, and owning the container would tie rotating
  // a credential to running a deploy.
  //
  // Deliberately not `DELEGATES`. That secret maps every key into every
  // container, so sharing it would give every Delegate agent BugBoss's
  // credentials and vice versa.
  const secret = aws.secretsmanager.getSecretOutput({ name: SECRET_NAME });

  const albSecurityGroup = new aws.ec2.SecurityGroup("bugbossAlbSg", {
    name: "bugboss-alb",
    description: "Public HTTPS ingress to the BugBoss ALB",
    vpcId: VPC_ID,
    ingress: [
      {
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ["0.0.0.0/0"],
        description: "Grafana, Slack and Claude Code over HTTPS",
      },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: TAGS,
  });

  // The SG hardcoded in index.ts is the VPC default, which only allows ingress
  // from 10.0.0.0/16. Fine for outbound-only Delegate tasks, wrong for a
  // service behind an ALB.
  const serviceSecurityGroup = new aws.ec2.SecurityGroup("bugbossServiceSg", {
    name: "bugboss-service",
    description: "BugBoss task: ALB ingress, unrestricted egress",
    vpcId: VPC_ID,
    ingress: [
      {
        protocol: "tcp",
        fromPort: CONTAINER_PORT,
        toPort: CONTAINER_PORT,
        securityGroups: [albSecurityGroup.id],
        description: "ALB to container",
      },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: TAGS,
  });

  const loadBalancer = new aws.lb.LoadBalancer("bugbossAlb", {
    name: "bugboss",
    loadBalancerType: "application",
    internal: false,
    securityGroups: [albSecurityGroup.id],
    subnets: config.subnetIds,
    // Explicit rather than implicit, because the ingest path is designed
    // against this number: the webhook has to acknowledge inside it or
    // Grafana sees a dead endpoint and retries into duplicate work. 60 is
    // AWS's default, so this changes nothing today and stops the number
    // moving silently underneath that design.
    idleTimeout: 60,
    tags: TAGS,
  });

  const targetGroup = new aws.lb.TargetGroup("bugbossTargetGroup", {
    name: "bugboss",
    port: CONTAINER_PORT,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: VPC_ID,
    // Deploys are stop-then-start, so draining time is added directly to the
    // outage window. The 300s default would make every `ops` merge a five
    // minute gap in alert ingest.
    deregistrationDelay: 15,
    healthCheck: {
      path: "/health",
      matcher: "200",
      interval: 15,
      timeout: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    },
    tags: TAGS,
  });

  // The deploy role has `acm:DescribeCertificate` and `acm:ListCertificates`
  // but not `acm:RequestCertificate`, so this looks up the existing wildcard
  // rather than issuing its own. That is also why the hostname is a single
  // label under goodparty.org: `*.goodparty.org` does not cover a deeper name.
  const certificate = aws.acm.getCertificateOutput({
    domain: "goodparty.org",
    statuses: ["ISSUED"],
    mostRecent: true,
  });

  // The default action is a 404: the listener rule below is an allowlist, so
  // a path that is not routed never reaches the process. Adding an endpoint
  // means adding it here.
  const listener = new aws.lb.Listener("bugbossListener", {
    loadBalancerArn: loadBalancer.arn,
    port: 443,
    protocol: "HTTPS",
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    certificateArn: certificate.arn,
    defaultActions: [
      {
        type: "fixed-response",
        fixedResponse: {
          contentType: "text/plain",
          messageBody: "not found",
          statusCode: "404",
        },
      },
    ],
    tags: TAGS,
  });

  new aws.lb.ListenerRule("bugbossIngressRoutes", {
    listenerArn: listener.arn,
    priority: 10,
    conditions: [{ pathPattern: { values: ["/grafana", "/slack"] } }],
    actions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
    tags: TAGS,
  });

  new aws.route53.Record("bugbossDns", {
    zoneId: HOSTED_ZONE_ID,
    name: HOSTNAME,
    type: "A",
    aliases: [
      {
        name: loadBalancer.dnsName,
        zoneId: loadBalancer.zoneId,
        evaluateTargetHealth: true,
      },
    ],
  });

  const executionRole = new aws.iam.Role("bugbossExecutionRole", {
    name: "bugboss-execution-role",
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
              Resource: [secret.arn],
            },
          ],
        }),
      },
    ],
    tags: TAGS,
  });

  const taskRole = new aws.iam.Role("bugbossTaskRole", {
    name: "bugboss-task-role",
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
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "SessionsEvidenceAndSnapshot",
              Effect: "Allow",
              Action: [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:AbortMultipartUpload",
              ],
              Resource: [pulumi.interpolate`${bucket.arn}/*`],
            },
            {
              Effect: "Allow",
              Action: ["s3:ListBucket", "s3:GetBucketLocation"],
              Resource: [bucket.arn],
            },
            {
              Effect: "Allow",
              Action: ["bedrock:InvokeModel*"],
              Resource: [
                "arn:aws:bedrock:*::foundation-model/*",
                `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/*`,
                `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:application-inference-profile/*`,
              ],
            },
            {
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: [secret.arn],
            },
            // The phase-to-model mapping lives in SSM so it retunes without a
            // deploy, which is also why the parameters are not declared here:
            // Pulumi would revert every retune on the next apply.
            {
              Sid: "ModelRoutingParameters",
              Effect: "Allow",
              Action: ["ssm:GetParameter", "ssm:GetParametersByPath"],
              Resource: [
                `arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/bugboss/*`,
              ],
            },
            // Everything below this line is what an incident agent reads to
            // investigate. Primary observability is Grafana (Loki, Tempo and
            // Prometheus over MCP), so AWS is only for the layer beneath it:
            // a task that never started, an OOM kill, a crash that happened
            // before anything reached Loki. That is why there is no RDS or
            // load balancer access here; neither is reachable that way and
            // neither was ever needed.
            //
            // Service events, which say why a task failed to start or was
            // replaced, come back in DescribeServices output.
            {
              Sid: "DeploymentState",
              Effect: "Allow",
              Action: ["ecs:Describe*", "ecs:List*"],
              Resource: ["*"],
            },
            // The line is our application logs, which an agent may read,
            // against infrastructure and security logs, which it may not:
            // VPC flow logs, GuardDuty, RDS OS metrics and the VPN groups
            // stay unreadable. A new prefix belongs here only if it carries
            // logs our own code emits.
            //
            // Derive the prefixes from the live account rather than from the
            // service that writes them. SST does not use `/ecs` or
            // `/aws/ecs`, so leaving `/sst/cluster/*` out would silently
            // exclude gp-api, election-api and people-api.
            {
              Sid: "ApplicationLogContent",
              Effect: "Allow",
              Action: [
                "logs:FilterLogEvents",
                "logs:GetLogEvents",
                "logs:DescribeLogStreams",
              ],
              Resource: [
                `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/ecs/*`,
                `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/ecs/*`,
                `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/sst/cluster/*`,
                `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/*`,
              ],
            },
            // Unscoped because a resource-restricted DescribeLogGroups denies
            // the whole call rather than filtering it, which breaks discovery
            // outright. Group names are not content.
            {
              Sid: "LogGroupDiscovery",
              Effect: "Allow",
              Action: ["logs:DescribeLogGroups"],
              Resource: ["*"],
            },
            // Metrics cannot be resource-scoped meaningfully, and they are
            // numbers rather than content.
            {
              Sid: "Metrics",
              Effect: "Allow",
              Action: [
                "cloudwatch:GetMetricData",
                "cloudwatch:GetMetricStatistics",
                "cloudwatch:ListMetrics",
              ],
              Resource: ["*"],
            },
          ],
        }),
      },
    ],
    tags: TAGS,
  });

  // `copyFrom` a system-defined inference profile is what makes this an
  // application inference profile rather than a second cross-region one.
  // The tags are the whole point of the resource: they are what Cost
  // Explorer groups by, and they are the same TAGS everything else here
  // carries so the spend lines up with the rest of BugBoss.
  const agentInferenceProfile = new aws.bedrock.InferenceProfile(
    "bugbossAgentInferenceProfile",
    {
      name: "bugboss-incident-agent",
      description:
        "Incident agent invocations, so Bedrock spend is attributable to BugBoss",
      modelSource: { copyFrom: AGENT_INFERENCE_PROFILE_SOURCE },
      tags: TAGS,
    },
  );

  const cluster = new aws.ecs.Cluster("bugbossCluster", {
    name: "bugboss",
    settings: [{ name: "containerInsights", value: "enabled" }],
    tags: TAGS,
  });

  const taskDefinition = new aws.ecs.TaskDefinition("bugbossTaskDef", {
    family: "bugboss",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: String(TASK_CPU),
    memory: String(TASK_MEMORY),
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    runtimePlatform: {
      cpuArchitecture: "X86_64",
      operatingSystemFamily: "LINUX",
    },
    // The Fargate maximum. Fifteen concurrent agents in `FIXING` hold a
    // measured 4.79 GB omni tree each, which is 72 GB, plus the image, one
    // shared npm cache, and the SQLite file with its `VACUUM INTO` snapshot.
    // Investigating agents clone source only and cost a fraction of that, so
    // the ceiling is rarely approached. Everything above the free 20 GiB runs
    // about fifteen dollars a month, which is not worth trading against
    // running out of disk halfway through an incident. The sidecar's data
    // directory shares this too: near-empty schemas cloned per suite, which
    // is single-digit gigabytes even with every agent testing at once.
    ephemeralStorage: { sizeInGib: 200 },
    containerDefinitions: pulumi.jsonStringify([
      {
        name: "bugboss",
        image: config.imageUri,
        cpu: BUGBOSS_CPU,
        memory: BUGBOSS_MEMORY,
        essential: true,
        portMappings: [{ containerPort: CONTAINER_PORT, protocol: "tcp" }],
        environment: [
          { name: "AWS_DEFAULT_REGION", value: REGION },
          { name: "PORT", value: String(CONTAINER_PORT) },
          { name: "BUGBOSS_BUCKET", value: bucket.bucket },
          // The sidecar below, on the task's shared network namespace. This
          // is what an incident agent inherits so omni's test harness takes a
          // Postgres instead of trying to start one; bugboss/testdb refuses
          // anything but loopback here and alarms at boot if nothing answers.
          { name: TEST_DB_ENV_VAR, value: TEST_DB_URL },
          // A map, keyed by the logical model id the agent is configured
          // with. An entry that matches nothing costs a run its line in Cost
          // Explorer and nothing else, which is what a retune to a model
          // nobody wrapped has to do.
          {
            name: "BUGBOSS_INFERENCE_PROFILES",
            value: pulumi.jsonStringify({
              [DEFAULT_MODEL_ID]: agentInferenceProfile.arn,
            }),
          },
        ],
        // The whole secret as one JSON value rather than a key-per-env-var
        // map: the key list belongs to the application, and duplicating it
        // here would mean a deploy failure every time the app adds a
        // credential.
        secrets: [{ name: "BUGBOSS_SECRETS", valueFrom: secret.arn }],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup.name,
            "awslogs-region": REGION,
            "awslogs-stream-prefix": "bugboss",
          },
        },
        // Agents are child processes, so PID 1 has to reap them.
        linuxParameters: { initProcessEnabled: true },
      },
      // Fargate has no Docker socket, so testcontainers -- which is how omni
      // starts a database for 200 of gp-api's 576 test files -- has nothing to
      // talk to. An agent could not run any of them, and pushed fixes whose
      // only check was a CI round trip. Containers in one task share a network
      // namespace, so this is reachable on loopback and needs no host, no
      // daemon and no credential.
      //
      // Isolating the fifteen agents that share it is omni's job, not ours,
      // and its harness already does it: the schema template is named for a
      // digest of the migrations it holds, each suite clones that into its own
      // database and drops it in afterAll, and a sweep collects clones a
      // killed run left behind -- age-gated, so it cannot take one a live run
      // is using. That was all built for "one container serves every checkout
      // on the machine". This task is that machine.
      //
      // NOT essential. An essential container that exits stops the task, and
      // a test database is not worth an incident system. Nothing depends on it
      // either: BugBoss must boot and work alerts whether or not this is up.
      // The cost of that choice is that its absence is quiet, which is why the
      // Boss probes it at boot and alarms, and why omni's harness names
      // OMNI_TEST_POSTGRES_URL in the failure an agent actually reads.
      //
      // Its data is the container's writable layer, on the task's 200 GiB of
      // ephemeral storage, so it is gone when the task is -- and every merge
      // to ops main replaces this task. Nothing accumulates across deploys.
      {
        name: "postgres",
        image: "public.ecr.aws/docker/library/postgres:16-alpine",
        cpu: POSTGRES_CPU,
        memory: POSTGRES_MEMORY,
        essential: false,
        command: ["postgres", ...POSTGRES_SETTINGS],
        environment: [
          { name: "POSTGRES_USER", value: POSTGRES_USER },
          { name: "POSTGRES_PASSWORD", value: POSTGRES_PASSWORD },
          { name: "POSTGRES_DB", value: POSTGRES_DB },
        ],
        // No portMappings. The port is reachable inside the task by virtue of
        // the shared namespace; publishing it would put a trust-nothing
        // Postgres on the task ENI, which has a public IP.
        //
        // The health check changes nothing about the task, since nothing is
        // essential here and nothing depends on it. It is here to be read:
        // DescribeTasks reports it, and an agent already holds ecs:Describe*,
        // so "is the test database up" has an answer that does not require
        // inferring one from a failing suite.
        healthCheck: {
          command: [
            "CMD-SHELL",
            `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB} || exit 1`,
          ],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 60,
        },
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup.name,
            "awslogs-region": REGION,
            "awslogs-stream-prefix": "postgres",
          },
        },
      },
    ]),
    tags: TAGS,
  });

  const service = new aws.ecs.Service("bugbossService", {
    name: "bugboss",
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    // Turning BugBoss off is a change to this line, not a manual scale.
    // Pulumi owns the count, so scaling the service by hand is drift the
    // next ops deploy silently undoes — which is how it came back twice on
    // 2026-09-28 while it was meant to be stopped.
    desiredCount: 1,
    launchType: "FARGATE",
    // Stop-then-start, and this is the one invariant the whole design rests
    // on: two tasks would put two processes on the same SQLite file and the
    // same agent sessions. A rolling deploy is a correctness bug here, not a
    // tuning choice. Accepting the gap in ingest is the trade.
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    // Roll back a revision that never reaches steady state, rather than
    // retrying it forever. This is recovery, not monitoring: nothing is
    // notified, the service simply returns to the last revision that ran.
    //
    // It earns its place because the two ways this container failed to boot
    // during the build were both silent and both total -- an unwritable
    // database path and a required setting the task definition never passed.
    // With minimumHealthyPercent at 0 there is no old task still serving, so
    // a bad revision is not a degraded deploy, it is an outage that waits for
    // someone to notice.
    deploymentCircuitBreaker: { enable: true, rollback: true },
    healthCheckGracePeriodSeconds: 120,
    // Default tags do not reach resources created at runtime — see
    // delegate/lambdas/dispatch.ts, which re-applies both by hand on RunTask.
    // This covers the tasks ECS launches; anything else BugBoss creates while
    // running has to set `Environment: infra` and `Project: bugboss` itself.
    propagateTags: "SERVICE",
    networkConfiguration: {
      subnets: config.subnetIds,
      securityGroups: [serviceSecurityGroup.id],
      // The public subnets route 0.0.0.0/0 straight to the IGW and there is no
      // NAT, so without a public IP the task has no egress to Bedrock, GitHub,
      // Slack or npm.
      assignPublicIp: true,
    },
    loadBalancers: [
      {
        targetGroupArn: targetGroup.arn,
        containerName: "bugboss",
        containerPort: CONTAINER_PORT,
      },
    ],
    tags: TAGS,
  });

  return {
    bucket,
    cluster,
    service,
    taskDefinition,
    taskRole,
    logGroup,
    loadBalancer,
    url: `https://${HOSTNAME}`,
  };
};
