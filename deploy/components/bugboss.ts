import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const ACCOUNT_ID = "333022194791";
const REGION = "us-west-2";
const VPC_ID = "vpc-0763fa52c32ebcf6a";
const HOSTED_ZONE_ID = "Z10392302OXMPNQLPO07K";
const HOSTNAME = "bugboss.goodparty.org";
const BUCKET_NAME = "bugboss-prod";
const SECRET_NAME = "BUGBOSS";
const CONTAINER_PORT = 3000;
const AGENT_ROLE_NAME = "bugboss-agent";

// Referenced, not constructed: naming the agent role here rather than reading
// `agentRole.arn` is what keeps the two roles out of a dependency cycle, since
// the agent role's trust policy has to name the task role and IAM rejects a
// principal that does not exist yet. A Resource field takes no such check.
const AGENT_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${AGENT_ROLE_NAME}`;

// `Environment: infra` is a protection, not a label. The EngineerAccess SSO
// permission set grants every engineer `Action: ["*"]` on anything tagged
// `Environment: dev`, so tagging BugBoss `dev` would hand every engineer full
// control of the incident system. `ops` has no `prod` tag value; prod-only
// means `infra`. `Project` overrides the stack default of `ops`.
const TAGS = { Environment: "infra", Project: "bugboss" };

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
            // Agents run as child processes in this container, so the
            // parent assumes this one role and hands the temporary
            // credentials down. The containment boundary is the role, not a
            // list of environment variable names someone has to keep current.
            {
              Sid: "AssumeAgentRole",
              Effect: "Allow",
              Action: ["sts:AssumeRole"],
              Resource: [AGENT_ROLE_ARN],
            },
            // The only way into the container when the Boss itself is the
            // broken thing. The `infra` tag keeps this to administrators.
            {
              Sid: "BreakGlassExec",
              Effect: "Allow",
              Action: [
                "ssmmessages:OpenDataChannel",
                "ssmmessages:OpenControlChannel",
                "ssmmessages:CreateDataChannel",
                "ssmmessages:CreateControlChannel",
              ],
              Resource: ["*"],
            },
          ],
        }),
      },
    ],
    tags: TAGS,
  });

  // What a compromised agent gets, and the design assumes one is. Primary
  // observability is Grafana — Loki, Tempo and Prometheus over MCP — so AWS
  // is only for the layer beneath it: a task that never started, an OOM kill,
  // a crash that happened before anything reached Loki. That is why there is
  // no RDS or load balancer access here; neither is reachable that way and
  // neither was ever needed.
  //
  // No S3, no Secrets Manager, no ECS or ECR write, no IAM, and no
  // `sts:AssumeRole`, so it cannot pivot. Attribution comes free from the
  // role session name the parent sets per incident, which CloudTrail records.
  const agentRole = new aws.iam.Role("bugbossAgentRole", {
    name: AGENT_ROLE_NAME,
    description:
      "Assumed by bugboss-task-role and handed to each incident agent child process.",
    assumeRolePolicy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "sts:AssumeRole",
          Principal: { AWS: taskRole.arn },
        },
      ],
    }),
    // Twelve hours, the maximum. Incidents outlive the one-hour default and a
    // credential expiry mid-investigation forces an agent restart.
    maxSessionDuration: 43200,
    inlinePolicies: [
      {
        name: "inline",
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "OwnModelCalls",
              Effect: "Allow",
              Action: ["bedrock:InvokeModel*"],
              Resource: [
                "arn:aws:bedrock:*::foundation-model/*",
                `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/*`,
                `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:application-inference-profile/*`,
              ],
            },
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

  const cluster = new aws.ecs.Cluster("bugbossCluster", {
    name: "bugboss",
    settings: [{ name: "containerInsights", value: "enabled" }],
    tags: TAGS,
  });

  const taskDefinition = new aws.ecs.TaskDefinition("bugbossTaskDef", {
    family: "bugboss",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "4096",
    memory: "16384",
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
    // running out of disk halfway through an incident.
    ephemeralStorage: { sizeInGib: 200 },
    containerDefinitions: pulumi.jsonStringify([
      {
        name: "bugboss",
        image: config.imageUri,
        cpu: 4096,
        memory: 16384,
        essential: true,
        portMappings: [{ containerPort: CONTAINER_PORT, protocol: "tcp" }],
        environment: [
          { name: "AWS_DEFAULT_REGION", value: REGION },
          { name: "PORT", value: String(CONTAINER_PORT) },
          { name: "BUGBOSS_BUCKET", value: bucket.bucket },
          { name: "BUGBOSS_AGENT_ROLE_ARN", value: agentRole.arn },
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
    ]),
    tags: TAGS,
  });

  const service = new aws.ecs.Service("bugbossService", {
    name: "bugboss",
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
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
    enableExecuteCommand: true,
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
    agentRole,
    logGroup,
    loadBalancer,
    url: `https://${HOSTNAME}`,
  };
};
