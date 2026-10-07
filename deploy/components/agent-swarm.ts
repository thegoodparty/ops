import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// The agent-swarm host was built by hand on 2026-10-05 and is adopted here
// with `import`. Every imported resource below has to describe the live one
// exactly, or the import fails at apply time; `protect` keeps a later edit
// from replacing the instance, whose root volume holds the swarm's SQLite
// state. See agent-swarm/HANDOFF.md.

const ACCOUNT_ID = "333022194791";
const REGION = "us-west-2";
const INSTANCE_ID = "i-04cc03c17787f5d59";
const NAME = "agent-swarm";
const HOSTNAME = "swarm.goodparty.org";
const HOSTED_ZONE_ID = "Z10392302OXMPNQLPO07K";
const SECRET_NAME = "AGENT_SWARM";
const SLACK_ALERTS_CHANNEL = "C0C6RUJ9VMK";
const CONFIG_BUCKET = `agent-swarm-config-${ACCOUNT_ID}`;
const METRIC_NAMESPACE = "AgentSwarm";

// `Environment: infra` keeps the EngineerAccess permission set, which grants
// `*` on anything tagged `dev`, off the host. `Project` overrides the stack
// default of `ops`.
const TAGS = { Name: NAME, Environment: "infra", Project: NAME };

const ROOT = path.resolve(__dirname, "../../agent-swarm");
const HOST_DIR = path.join(ROOT, "host");

const listFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    )
    .sort();

export const hostFiles = () =>
  listFiles(HOST_DIR).map((file) => path.relative(HOST_DIR, file));

// Folded into the association's command so that any change to any host file
// changes the association, which is what makes SSM run it again.
export const hostFilesHash = () => {
  const hash = crypto.createHash("sha256");
  for (const file of hostFiles()) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(HOST_DIR, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const syncCommand = (hash: string) =>
  [
    "#!/bin/bash",
    `# agent-swarm host files ${hash}`,
    "set -euo pipefail",
    "STAGE=$(mktemp -d /tmp/agent-swarm-config.XXXXXX)",
    "trap 'rm -rf \"$STAGE\"' EXIT",
    `aws s3 sync --only-show-errors --region ${REGION} s3://${CONFIG_BUCKET}/host/ "$STAGE/"`,
    'bash "$STAGE/install.sh" "$STAGE"',
  ].join("\n");

const readJson = (file: string) =>
  JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")));

export const createAgentSwarm = () => {
  const secret = aws.secretsmanager.getSecretOutput({ name: SECRET_NAME });

  const securityGroup = new aws.ec2.SecurityGroup(
    "agentSwarmSecurityGroup",
    {
      name: NAME,
      description: "agent-swarm playground host: 80/443 public",
      vpcId: "vpc-12fb466a",
      ingress: [
        {
          description: "http",
          protocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrBlocks: ["0.0.0.0/0"],
        },
        {
          description: "https",
          protocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
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
    { import: "sg-075cb6173b8b55291", protect: true },
  );

  const role = new aws.iam.Role(
    "agentSwarmHostRole",
    {
      name: "agent-swarm-host",
      assumeRolePolicy: readJson("iam/agent-swarm-host-trust.json"),
      tags: TAGS,
    },
    { import: "agent-swarm-host", protect: true },
  );

  new aws.iam.RolePolicyAttachment(
    "agentSwarmHostSsm",
    {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    },
    {
      import:
        "agent-swarm-host/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    },
  );

  new aws.iam.RolePolicy(
    "agentSwarmHostInline",
    {
      name: "agent-swarm-host-inline",
      role: role.name,
      policy: readJson("iam/agent-swarm-host-inline.json"),
    },
    { import: "agent-swarm-host:agent-swarm-host-inline" },
  );

  // Read-only AWS for the agents themselves; worker containers reach the
  // instance role through IMDS (hop limit 2).
  new aws.iam.RolePolicy(
    "agentSwarmAwsReadonly",
    {
      name: "agent-swarm-aws-readonly",
      role: role.name,
      policy: readJson("iam/agent-swarm-aws-readonly.json"),
    },
    { import: "agent-swarm-host:agent-swarm-aws-readonly" },
  );

  const instanceProfile = new aws.iam.InstanceProfile(
    "agentSwarmInstanceProfile",
    { name: "agent-swarm-host", role: role.name, tags: TAGS },
    { import: "agent-swarm-host", protect: true },
  );

  const configBucket = new aws.s3.Bucket("agentSwarmConfigBucket", {
    bucket: CONFIG_BUCKET,
    tags: TAGS,
  });

  new aws.s3.BucketPublicAccessBlock("agentSwarmConfigBucketPublicAccess", {
    bucket: configBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketLifecycleConfiguration("agentSwarmConfigBucketLifecycle", {
    bucket: configBucket.id,
    rules: [
      {
        id: "expire-ssm-output",
        status: "Enabled",
        filter: { prefix: "ssm-output/" },
        expiration: { days: 30 },
      },
    ],
  });

  const containerLogGroup = new aws.cloudwatch.LogGroup(
    "agentSwarmContainerLogs",
    {
      name: "/agent-swarm/containers",
      retentionInDays: 30,
      tags: TAGS,
    },
    // Created by hand to test the awslogs driver on the live host first.
    { import: "/agent-swarm/containers" },
  );

  // Kept apart from the two imported policies so that adopting them changes
  // nothing. This is what the host itself needs to be operated: its config
  // files, a place for SSM to write run output, and its health metrics.
  new aws.iam.RolePolicy("agentSwarmHostOps", {
    name: "agent-swarm-host-ops",
    role: role.name,
    policy: configBucket.arn.apply((bucketArn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ReadHostFiles",
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: `${bucketArn}/host/*`,
          },
          {
            Sid: "ListHostFiles",
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: bucketArn,
            Condition: { StringLike: { "s3:prefix": ["host/*", "host/"] } },
          },
          {
            Sid: "WriteSsmOutput",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: `${bucketArn}/ssm-output/*`,
          },
          {
            Sid: "HealthMetrics",
            Effect: "Allow",
            Action: ["cloudwatch:PutMetricData"],
            Resource: "*",
            Condition: {
              StringEquals: { "cloudwatch:namespace": METRIC_NAMESPACE },
            },
          },
        ],
      }),
    ),
  });

  const instance = new aws.ec2.Instance(
    "agentSwarmInstance",
    {
      ami: "ami-0d53cc9bd365ad65b",
      instanceType: "m6a.xlarge",
      subnetId: "subnet-b61a32fd",
      vpcSecurityGroupIds: [securityGroup.id],
      iamInstanceProfile: instanceProfile.name,
      metadataOptions: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 2,
      },
      rootBlockDevice: {
        volumeSize: 120,
        volumeType: "gp3",
        iops: 3000,
        throughput: 125,
        encrypted: true,
        deleteOnTermination: true,
        tags: TAGS,
      },
      userData: fs.readFileSync(path.join(ROOT, "ec2-user-data.sh"), "utf8"),
      tags: TAGS,
    },
    {
      import: INSTANCE_ID,
      protect: true,
      // A new AMI or first-boot script must not replace a host whose root
      // volume is the swarm's state. They apply only to a rebuild.
      ignoreChanges: ["ami", "userData", "userDataBase64"],
    },
  );

  const eip = new aws.ec2.Eip(
    "agentSwarmEip",
    { domain: "vpc", tags: TAGS },
    { import: "eipalloc-0041bc8ffac0a5efd", protect: true },
  );

  new aws.ec2.EipAssociation(
    "agentSwarmEipAssociation",
    { allocationId: eip.allocationId, instanceId: instance.id },
    { import: "eipassoc-0a60427319458cee6" },
  );

  new aws.route53.Record(
    "agentSwarmDns",
    {
      zoneId: HOSTED_ZONE_ID,
      name: HOSTNAME,
      type: "A",
      ttl: 300,
      records: [eip.publicIp],
    },
    { import: `${HOSTED_ZONE_ID}_${HOSTNAME}_A` },
  );

  const hash = hostFilesHash();
  const objects = hostFiles().map(
    (file) =>
      new aws.s3.BucketObjectv2(`agentSwarmHostFile:${file}`, {
        bucket: configBucket.id,
        key: `host/${file}`,
        source: new pulumi.asset.FileAsset(path.join(HOST_DIR, file)),
        tags: TAGS,
      }),
  );

  // Runs once whenever the command changes, which is whenever any host file
  // does. `pulumi up` waits for it, so a host that fails to take a change
  // fails the deploy instead of drifting quietly.
  new aws.ssm.Association(
    "agentSwarmHostSync",
    {
      name: "AWS-RunShellScript",
      associationName: "agent-swarm-host-sync",
      targets: [{ key: "InstanceIds", values: [instance.id] }],
      parameters: {
        commands: syncCommand(hash),
        executionTimeout: "3600",
      },
      outputLocation: {
        s3BucketName: configBucket.bucket,
        s3KeyPrefix: "ssm-output",
      },
      waitForSuccessTimeoutSeconds: 2400,
    },
    { dependsOn: [...objects, containerLogGroup] },
  );

  // Nightly crash-consistent snapshot of the whole instance. SQLite in WAL
  // mode on the same disk recovers from that like from a power cut. The
  // `SECRETS_ENCRYPTION_KEY` the snapshot's secrets are encrypted with lives
  // in the AGENT_SWARM secret, not on the disk.
  const dlmRole = new aws.iam.Role("agentSwarmDlmRole", {
    name: "agent-swarm-dlm",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "dlm.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
    tags: TAGS,
  });

  new aws.iam.RolePolicyAttachment("agentSwarmDlmPolicy", {
    role: dlmRole.name,
    policyArn:
      "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
  });

  new aws.dlm.LifecyclePolicy("agentSwarmSnapshots", {
    description: "agent-swarm host nightly snapshots",
    executionRoleArn: dlmRole.arn,
    state: "ENABLED",
    policyDetails: {
      resourceTypes: ["INSTANCE"],
      targetTags: { Name: NAME },
      schedules: [
        {
          name: "nightly",
          createRule: { interval: 24, intervalUnit: "HOURS", times: "10:00" },
          retainRule: { count: 14 },
          copyTags: true,
          tagsToAdd: { Name: NAME, Project: NAME },
        },
      ],
    },
    tags: TAGS,
  });

  // Alarms post to the swarm's own Slack alerts channel as the Swarm bot.
  // The poster runs outside the host so it still speaks when the host is
  // the thing that died.
  const alarmTopic = new aws.sns.Topic("agentSwarmAlarms", {
    name: "agent-swarm-alarms",
    tags: TAGS,
  });

  const notifierRole = new aws.iam.Role("agentSwarmNotifierRole", {
    name: "agent-swarm-alarm-notifier",
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
  });

  new aws.iam.RolePolicyAttachment("agentSwarmNotifierLogs", {
    role: notifierRole.name,
    policyArn:
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  new aws.iam.RolePolicy("agentSwarmNotifierSecret", {
    name: "read-agent-swarm-secret",
    role: notifierRole.name,
    policy: secret.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "secretsmanager:GetSecretValue",
            Resource: arn,
          },
        ],
      }),
    ),
  });

  const notifier = new aws.lambda.Function("agentSwarmNotifier", {
    name: "agent-swarm-alarm-notifier",
    role: notifierRole.arn,
    runtime: aws.lambda.Runtime.NodeJS22dX,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
      "index.mjs": new pulumi.asset.FileAsset(
        path.join(__dirname, "agent-swarm-notifier.mjs"),
      ),
    }),
    timeout: 30,
    memorySize: 128,
    environment: {
      variables: {
        SECRET_ID: secret.arn,
        SLACK_CHANNEL: SLACK_ALERTS_CHANNEL,
      },
    },
    tags: TAGS,
  });

  new aws.lambda.Permission("agentSwarmNotifierInvoke", {
    function: notifier.name,
    action: "lambda:InvokeFunction",
    principal: "sns.amazonaws.com",
    sourceArn: alarmTopic.arn,
  });

  new aws.sns.TopicSubscription("agentSwarmNotifierSubscription", {
    topic: alarmTopic.arn,
    protocol: "lambda",
    endpoint: notifier.arn,
  });

  const alarm = (
    name: string,
    args: Omit<
      aws.cloudwatch.MetricAlarmArgs,
      "name" | "alarmActions" | "okActions" | "tags"
    >,
    extraActions: string[] = [],
  ) =>
    new aws.cloudwatch.MetricAlarm(`agentSwarmAlarm:${name}`, {
      name: `agent-swarm-${name}`,
      alarmActions: [alarmTopic.arn, ...extraActions],
      okActions: [alarmTopic.arn],
      tags: TAGS,
      ...args,
    });

  alarm(
    "system-check",
    {
      alarmDescription:
        "AWS cannot reach the agent-swarm host (hardware or network). EC2 recovers it onto new hardware; the stack restarts with it.",
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed_System",
      dimensions: { InstanceId: instance.id },
      statistic: "Maximum",
      period: 60,
      evaluationPeriods: 2,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "missing",
    },
    [`arn:aws:automate:${REGION}:ec2:recover`],
  );

  alarm(
    "instance-check",
    {
      alarmDescription:
        "The agent-swarm host's OS is not responding. EC2 reboots it; systemd brings the stack back.",
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed_Instance",
      dimensions: { InstanceId: instance.id },
      statistic: "Maximum",
      period: 60,
      evaluationPeriods: 3,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "missing",
    },
    [`arn:aws:automate:${REGION}:ec2:reboot`],
  );

  // Missing data is breaching: no data means the host or its health timer
  // has stopped, which is the case this alarm exists for.
  alarm("api-unhealthy", {
    alarmDescription:
      "The agent-swarm API has failed /health for 5 minutes, or the host has stopped reporting. Connect: aws ssm start-session --region us-west-2 --target " +
      INSTANCE_ID,
    namespace: METRIC_NAMESPACE,
    metricName: "ApiHealthy",
    statistic: "Minimum",
    period: 60,
    evaluationPeriods: 5,
    threshold: 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "breaching",
  });

  alarm("public-unhealthy", {
    alarmDescription: `https://${HOSTNAME}/health has failed from the host for 5 minutes while the API itself may be up: Caddy, TLS or DNS.`,
    namespace: METRIC_NAMESPACE,
    metricName: "PublicHealthy",
    statistic: "Minimum",
    period: 60,
    evaluationPeriods: 5,
    threshold: 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "notBreaching",
  });

  alarm("disk-80", {
    alarmDescription:
      "The agent-swarm host's root disk is over 80% full. Images, workspaces and SQLite share it.",
    namespace: METRIC_NAMESPACE,
    metricName: "DiskUsedPercent",
    statistic: "Maximum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 80,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  });

  return { instance, url: `https://${HOSTNAME}`, configBucket };
};
