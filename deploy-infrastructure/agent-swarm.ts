import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import {
  INFRASTRUCTURE_ACCOUNT_ID,
  MANAGEMENT_ACCOUNT_ID,
} from "../utils/accounts";

// The Delegate swarm host: one EC2 instance running agent-swarm in Docker
// Compose. Operating procedures are in agent-swarm/README.md, history and
// decisions in agent-swarm/HANDOFF.md.

const NAME = "delegate-swarm";
const REGION = "us-west-2";
const AVAILABILITY_ZONE = "us-west-2a";
const VPC_ID = "vpc-0930cabea81245d01";
const SUBNET_ID = "subnet-0184e0f40b440ab13";
const CONFIG_BUCKET = `delegate-swarm-config-${INFRASTRUCTURE_ACCOUNT_ID}`;
const LOG_GROUP = "/delegate-swarm/containers";
const PROD_READ_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/delegate-swarm-prod-read`;
const DATA_VOLUME_NAME = "delegate-swarm-data";
const DATA_VOLUME_PLACEHOLDER = "__DATA_VOLUME_ID__";

// Overrides the provider's `infrastructure` default tags.
const TAGS = { Name: NAME, Environment: "infra", Project: NAME };

const ROOT = path.resolve(__dirname, "../agent-swarm");
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
    `# delegate-swarm host files ${hash}`,
    "set -euo pipefail",
    "STAGE=$(mktemp -d /tmp/delegate-swarm-config.XXXXXX)",
    "trap 'rm -rf \"$STAGE\"' EXIT",
    `aws s3 sync --only-show-errors --region ${REGION} s3://${CONFIG_BUCKET}/host/ "$STAGE/"`,
    'bash "$STAGE/install.sh" "$STAGE"',
  ].join("\n");

// Without the placeholder the data volume is never mounted and Docker state
// lands on the root volume, which an instance replacement throws away.
export const userData = (dataVolumeId: string) => {
  const script = fs.readFileSync(path.join(ROOT, "ec2-user-data.sh"), "utf8");
  if (!script.includes(DATA_VOLUME_PLACEHOLDER)) {
    throw new Error(
      `agent-swarm/ec2-user-data.sh has no ${DATA_VOLUME_PLACEHOLDER} placeholder`,
    );
  }
  return script.replaceAll(DATA_VOLUME_PLACEHOLDER, dataVolumeId);
};

export const createAgentSwarm = (args: { provider: aws.Provider }) => {
  const { provider } = args;

  const securityGroup = new aws.ec2.SecurityGroup(
    "delegateSwarmSecurityGroup",
    {
      name: NAME,
      description: "Delegate swarm host: 80/443 public",
      vpcId: VPC_ID,
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
    { provider },
  );

  // Filled by hand with agent-swarm/fill-secrets.sh, never by Pulumi. It
  // holds SECRETS_ENCRYPTION_KEY, without which the swarm's stored secrets
  // cannot be decrypted.
  const secret = new aws.secretsmanager.Secret(
    "delegateSwarmSecret",
    {
      name: "DELEGATE_SWARM",
      description: "Delegate swarm runtime secrets. Filled by hand with agent-swarm/fill-secrets.sh.",
      tags: TAGS,
    },
    { provider, protect: true },
  );

  const configBucket = new aws.s3.Bucket(
    "delegateSwarmConfigBucket",
    { bucket: CONFIG_BUCKET, tags: TAGS },
    { provider },
  );

  new aws.s3.BucketPublicAccessBlock(
    "delegateSwarmConfigBucketPublicAccess",
    {
      bucket: configBucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    { provider },
  );

  new aws.s3.BucketLifecycleConfiguration(
    "delegateSwarmConfigBucketLifecycle",
    {
      bucket: configBucket.id,
      rules: [
        {
          id: "expire-ssm-output",
          status: "Enabled",
          filter: { prefix: "ssm-output/" },
          expiration: { days: 30 },
        },
      ],
    },
    { provider },
  );

  const containerLogGroup = new aws.cloudwatch.LogGroup(
    "delegateSwarmContainerLogs",
    { name: LOG_GROUP, retentionInDays: 30, tags: TAGS },
    { provider },
  );

  const role = new aws.iam.Role(
    "delegateSwarmHostRole",
    {
      name: "delegate-swarm-host",
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
    { provider },
  );

  const ssmCore = new aws.iam.RolePolicyAttachment(
    "delegateSwarmHostSsm",
    {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    },
    { provider },
  );

  const hostPolicy = new aws.iam.RolePolicy(
    "delegateSwarmHostPolicy",
    {
      name: "delegate-swarm-host",
      role: role.name,
      policy: pulumi
        .all([secret.arn, configBucket.arn])
        .apply(([secretArn, bucketArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadSwarmSecret",
                Effect: "Allow",
                Action: "secretsmanager:GetSecretValue",
                Resource: secretArn,
              },
              {
                Sid: "ContainerLogs",
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: [
                  `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:/delegate-swarm/*`,
                  `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:/delegate-swarm/*:log-stream:*`,
                ],
              },
              {
                Sid: "ReadHostFiles",
                Effect: "Allow",
                Action: "s3:GetObject",
                Resource: `${bucketArn}/host/*`,
              },
              {
                Sid: "ListHostFiles",
                Effect: "Allow",
                Action: "s3:ListBucket",
                Resource: bucketArn,
                Condition: { StringLike: { "s3:prefix": ["host/*", "host/"] } },
              },
              // The SSM agent uploads run output with a bucket-owner ACL and
              // checks the bucket's encryption first.
              {
                Sid: "WriteSsmOutput",
                Effect: "Allow",
                Action: ["s3:PutObject", "s3:PutObjectAcl"],
                Resource: `${bucketArn}/ssm-output/*`,
              },
              {
                Sid: "ReadBucketEncryption",
                Effect: "Allow",
                Action: "s3:GetEncryptionConfiguration",
                Resource: bucketArn,
              },
              // The agents' production reads go through this role in the
              // management account; worker containers reach the instance
              // role through IMDS, which is why the hop limit is 2.
              {
                Sid: "AssumeProdRead",
                Effect: "Allow",
                Action: "sts:AssumeRole",
                Resource: PROD_READ_ROLE_ARN,
              },
            ],
          }),
        ),
    },
    { provider },
  );

  const instanceProfile = new aws.iam.InstanceProfile(
    "delegateSwarmInstanceProfile",
    { name: "delegate-swarm-host", role: role.name, tags: TAGS },
    { provider },
  );

  // Docker's data root, so the swarm's SQLite state outlives the instance.
  // retainOnDelete keeps it even if this resource is removed from the
  // program.
  const dataVolume = new aws.ebs.Volume(
    "delegateSwarmDataVolume",
    {
      availabilityZone: AVAILABILITY_ZONE,
      size: 150,
      type: "gp3",
      encrypted: true,
      tags: { ...TAGS, Name: DATA_VOLUME_NAME },
    },
    { provider, protect: true, retainOnDelete: true },
  );

  const instance = new aws.ec2.Instance(
    "delegateSwarmInstance",
    {
      ami: "ami-0d53cc9bd365ad65b",
      instanceType: "m6a.xlarge",
      subnetId: SUBNET_ID,
      vpcSecurityGroupIds: [securityGroup.id],
      iamInstanceProfile: instanceProfile.name,
      metadataOptions: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 2,
      },
      rootBlockDevice: {
        volumeSize: 40,
        volumeType: "gp3",
        encrypted: true,
        deleteOnTermination: true,
        tags: TAGS,
      },
      userData: dataVolume.id.apply(userData),
      tags: TAGS,
    },
    {
      provider,
      protect: true,
      // A new AMI or first-boot script must not replace a running host. They
      // apply only to a rebuild.
      ignoreChanges: ["ami", "userData", "userDataBase64"],
    },
  );

  // deleteBeforeReplace: a volume attaches to one instance at a time, so a
  // replacement has to detach from the old instance first. Stopping it first
  // keeps the detach from pulling a mounted filesystem out from under Docker.
  const dataVolumeAttachment = new aws.ec2.VolumeAttachment(
    "delegateSwarmDataVolumeAttachment",
    {
      deviceName: "/dev/sdf",
      volumeId: dataVolume.id,
      instanceId: instance.id,
      stopInstanceBeforeDetaching: true,
    },
    { provider, deleteBeforeReplace: true },
  );

  const eip = new aws.ec2.Eip(
    "delegateSwarmEip",
    { domain: "vpc", instance: instance.id, tags: TAGS },
    { provider, protect: true },
  );

  const hash = hostFilesHash();
  const objects = hostFiles().map(
    (file) =>
      new aws.s3.BucketObjectv2(
        `delegateSwarmHostFile:${file}`,
        {
          bucket: configBucket.id,
          key: `host/${file}`,
          source: new pulumi.asset.FileAsset(path.join(HOST_DIR, file)),
          tags: TAGS,
        },
        { provider },
      ),
  );

  // Runs once whenever the command changes, which is whenever any host file
  // does. `pulumi up` waits for it, so a host that fails to take a change
  // fails the deploy instead of drifting quietly.
  new aws.ssm.Association(
    "delegateSwarmHostSync",
    {
      name: "AWS-RunShellScript",
      associationName: "delegate-swarm-host-sync",
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
    {
      provider,
      dependsOn: [
        ...objects,
        containerLogGroup,
        dataVolumeAttachment,
        hostPolicy,
        ssmCore,
      ],
    },
  );

  // Nightly crash-consistent snapshot of the data volume. SQLite in WAL mode
  // recovers from that like from a power cut. SECRETS_ENCRYPTION_KEY lives in
  // the secret, not on the volume.
  const dlmRole = new aws.iam.Role(
    "delegateSwarmDlmRole",
    {
      name: "delegate-swarm-dlm",
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
    },
    { provider },
  );

  new aws.iam.RolePolicyAttachment(
    "delegateSwarmDlmPolicy",
    {
      role: dlmRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
    },
    { provider },
  );

  new aws.dlm.LifecyclePolicy(
    "delegateSwarmSnapshots",
    {
      description: "Delegate swarm data volume nightly snapshots",
      executionRoleArn: dlmRole.arn,
      state: "ENABLED",
      policyDetails: {
        resourceTypes: ["VOLUME"],
        targetTags: { Name: DATA_VOLUME_NAME },
        schedules: [
          {
            name: "nightly",
            createRule: { interval: 24, intervalUnit: "HOURS", times: "10:00" },
            retainRule: { count: 14 },
            copyTags: true,
          },
        ],
      },
      tags: TAGS,
    },
    { provider },
  );

  return { instance, eip };
};
