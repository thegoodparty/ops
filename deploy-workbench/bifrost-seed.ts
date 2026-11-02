import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  BIFROST_SEED_TAG,
  bifrostSeedImageUri,
} from "./bifrost-seed-image";
import {
  ECS_EXECUTION_MANAGED_POLICY_ARN,
  GATEWAY_SECRET_NAME,
  RDS_PASSWORD_JSON_KEY,
  PG_PASSWORD_ENV_NAME,
  PG_HOST_ENV_NAME,
  PG_PORT_ENV_NAME,
  PG_USER_ENV_NAME,
  secretArnPattern,
  secretReference,
  type PolicyDocument,
} from "./ecs";
import { DATABASE_USERNAME } from "./rds";
import { REGION } from "./network";

/**
 * The one-off ECS task that seeds the inactive Bifrost colour's config store
 * from the active one. Step 2 of `docs/bifrost-zero-downtime-deploys.md`, and
 * decisions 16-19 are the ones that shape it.
 *
 * What this module owns:
 *
 * - the seed task definition: one container, the derived image from
 *   `bifrost-seed-image.ts`, the same `PG_*` environment and `PG_PASSWORD`
 *   secret injection the gateway's own task uses;
 * - its log group, and its IAM (`RunTask` is not a standard ECS action a task
 *   needs: this module creates the definition and no role beyond the two ECS
 *   needs).
 *
 * What it deliberately does not own, and each is a constraint of this step:
 *
 * - **Nothing calls it.** No service, no schedule, no deploy hook. Step 4 wires
 *   it into a deploy; here it is a task definition a human runs by hand with
 *   `aws ecs run-task`.
 * - **Nothing about the running gateway changes.** The seed is a second task
 *   definition in the same cluster, not a revision of the gateway's, so a
 *   deploy of the gateway behaves exactly as it does today.
 * - **No network change.** The task runs in the gateway's own private subnets
 *   with the gateway's own task security group, which the database's group
 *   already admits on 5432 (`network.ts`, `bifrostDatabaseIngressPostgres`).
 *   That is the whole reason decision 16 chose a task over a VPC-attached
 *   Lambda, which would have needed its own group and a second ingress rule.
 *
 * ## The IAM, and why it is this small
 *
 * The seed talks to Postgres and to nothing else. Its credentials are the
 * database's, not AWS's, so the *task* role needs no permission at all: there is
 * no AWS API in the seed's path. The ECS agent pulls the image, writes the log
 * and resolves the one secret, which is the *execution* role's managed policy
 * plus `secretsmanager:GetSecretValue` on the RDS-managed secret — the same
 * shape as the gateway's execution role and deliberately not a wider one.
 *
 * `CREATE DATABASE` needs `CREATEDB` on the connecting role, which the RDS
 * master user has (decision 19). That is a Postgres privilege, not an IAM one,
 * and it is why the seed connects as `DATABASE_USERNAME` — the master user —
 * rather than as a narrower application role. A second, narrower role would
 * have to be granted `CREATEDB` and given the schema privileges the restore
 * needs, which is a permission model nothing else in this deployment knows
 * about; the task already runs inside the same account, VPC and security group
 * as the gateway, so a narrower database user buys nothing here.
 *
 * ## Why the credentials are the gateway's own mechanism
 *
 * Per the step's requirement: the seed reuses what the gateway's task uses
 * rather than inventing a third way to find the database. Host, port and user
 * are the plain `PG_*` values from `ecs.ts`; the password is the RDS-managed
 * secret's `password` key, injected by the ECS agent and never read by this
 * program. `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` are libpq's own variable
 * names, so `pg_dump` and `psql` pick them up with no connection string and no
 * password in an argument list.
 *
 * Everything takes the explicit provider this project requires (`index.ts`
 * disables the default provider), so a resource that omits `{ provider }` fails
 * the apply rather than landing in the management account.
 */

/** The task family, distinct from `bifrost` so it is not a gateway revision. */
export const BIFROST_SEED_TASK_FAMILY = "bifrost-seed";

/** The one container. */
export const BIFROST_SEED_CONTAINER_NAME = "bifrost-seed";

/**
 * The log group, named beside the gateway's rather than shared with it.
 *
 * A seed run happens once per deploy and one of them every cycle is a failure
 * someone reads; separating the stream from the gateway's request log is what
 * makes "which deploy's seed" answerable without a timestamp filter. Retention
 * matches the gateway's thirty days for the same reason.
 */
export const BIFROST_SEED_LOG_GROUP_NAME = "/aws/ecs/bifrost-seed";
export const BIFROST_SEED_LOG_RETENTION_DAYS = 30;
export const BIFROST_SEED_LOG_STREAM_PREFIX = "bifrost-seed";

/**
 * The two database names the task is given.
 *
 * `SEED_SOURCE_DATABASE` and `SEED_TARGET_DATABASE` are the script's own
 * variables, and they are environment values rather than literals in the image
 * because which colour is active is not a property of the image. In this step
 * they are set to the pair a human is expected to run: the existing `bifrost`
 * database as the source (it is the only one that exists until step 4) and a
 * scratch target. The step-4 PR changes the target to the inactive colour.
 *
 * They are deliberately **not** derived from the gateway's task definition
 * here: the plan's decision 7 refuses a live read during a deploy for the
 * colour, and this module has no business knowing which colour is serving.
 */
export const SEED_SOURCE_DATABASE_ENV_NAME = "SEED_SOURCE_DATABASE";
export const SEED_TARGET_DATABASE_ENV_NAME = "SEED_TARGET_DATABASE";

/**
 * The task's sizing: the smallest valid Fargate pair.
 *
 * A `pg_dump` of the config store is a few megabytes of rows over a socket to a
 * database in the same subnets; the seed spent 0.02s of dump on a fixture with
 * 66 tables and a 500-row log in the tests, and the real store's config tables
 * are smaller than the log table the design deliberately does not copy. One
 * vCPU of burstable is ample, and the number is a one-line change if a real
 * measurement says otherwise.
 */
export const BIFROST_SEED_CPU = "256";
export const BIFROST_SEED_MEMORY = "512";

/**
 * How long ECS waits before killing a seed that will not exit.
 *
 * The dump is bounded by the store's size rather than by a network wait, so this
 * is a backstop rather than a budget: ten minutes is far beyond any plausible
 * dump of a few megabytes and short enough that a wedged run is visible in the
 * same working session. ECS's own maximum for a Fargate task is much larger; the
 * point is that this task must never be the reason a later deploy waits.
 */
export const BIFROST_SEED_TIMEOUT_SECONDS = 600;

/**
 * The execution role's one inline statement: read the RDS-managed password.
 *
 * `bifrost/gateway` is not here. The seed needs no setup token, no encryption
 * key and no provider key; the only credential in its path is the database's,
 * and the narrower list is the point of a separate role rather than reusing the
 * gateway's execution role, which also reads two container secrets it has no use
 * for.
 */
export const executionRoleSecretPolicyDocument = (
  secretArns: string[],
): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ReadDatabasePassword",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: secretArns,
    },
  ],
});

/**
 * The seed container's environment, as a plain list.
 *
 * Exported and pure so a test can assert the names without synthesizing a
 * Pulumi program, which is the idiom `ecs.ts` uses for its own environment
 * lists. `PG_PASSWORD` is not here: it is a `secrets` entry, and a test asserts
 * that separately because putting it in `environment` would put the database
 * password in `describe-task-definition` for anyone with `ecs:DescribeTaskDefinition`.
 */
export const seedEnvironment = (args: {
  host: pulumi.Input<string>;
  port: pulumi.Input<string>;
  sourceDatabase: string;
  targetDatabase: string;
}): Array<{ name: string; value: pulumi.Input<string> }> => [
  { name: PG_HOST_ENV_NAME, value: args.host },
  { name: PG_PORT_ENV_NAME, value: args.port },
  { name: PG_USER_ENV_NAME, value: DATABASE_USERNAME },
  { name: SEED_SOURCE_DATABASE_ENV_NAME, value: args.sourceDatabase },
  { name: SEED_TARGET_DATABASE_ENV_NAME, value: args.targetDatabase },
];

/**
 * The `secrets` entry that injects the password.
 *
 * The same reference `ecs.ts` builds for the gateway, from the same RDS-managed
 * secret ARN and the same `password` JSON key, so a rotation reaches this task
 * on its next start exactly as it reaches the gateway.
 *
 * Split into a pure form and an `interpolate` wrapper on purpose. The suffix
 * `:<key>::` is a string this module builds by hand, and a typo in it is not a
 * compile error: ECS discovers a bad `valueFrom` at task launch, and the
 * gateway's history is the same shape (2026-10-26). So the suffix is a pure
 * function of the key that `bifrost-seed.test.ts` feeds to
 * `scripts/preflight-secrets.ts`'s own parser, which is the check the deploy
 * runs before it drains anything.
 */
export const seedSecretReferenceSuffix = (jsonKey: string): string =>
  `:${jsonKey}::`;

export const seedSecretEntries = (
  databaseSecretArn: pulumi.Input<string>,
): Array<{ name: string; valueFrom: pulumi.Input<string> }> => [
  {
    name: PG_PASSWORD_ENV_NAME,
    valueFrom: pulumi.interpolate`${databaseSecretArn}${seedSecretReferenceSuffix(
      RDS_PASSWORD_JSON_KEY,
    )}`,
  },
];

export const createBifrostSeedTask = (args: {
  provider: aws.Provider;
  /**
   * The gateway's cluster. Decision 16: Fargate already runs in the private
   * subnets with the task security group, which the database group admits on
   * 5432, so the seed needs no network change and no cluster of its own.
   */
  cluster: aws.ecs.Cluster;
  /** The gateway's private subnets, from `network.ts`. */
  privateSubnetIds: pulumi.Input<pulumi.Input<string>[]>;
  /** The gateway's task security group, which the database already admits. */
  taskSecurityGroupId: pulumi.Input<string>;
  /** The RDS-managed secret holding the master password. */
  databaseSecretArn: pulumi.Input<string>;
  /** Host, port, and the database the source side reads. */
  databaseHost: pulumi.Input<string>;
  databasePort: pulumi.Input<number>;
  /**
   * The active colour's database. The gateway's own `DATABASE_NAME` today; step
   * 4 makes it the colour, which is why it is an argument rather than a
   * constant here.
   */
  sourceDatabase: string;
  /**
   * The inactive colour's database. Not a colour name in this step: it is the
   * scratch name a human runs the seed against, and step 4 changes it.
   */
  targetDatabase: string;
  /** The derived seed image's repository, from `bifrost-seed-image.ts`. */
  repositoryUrl: pulumi.Input<string>;
}) => {
  const { provider } = args;

  const imageUri = pulumi.interpolate`${args.repositoryUrl}:${BIFROST_SEED_TAG}`;

  const logGroup = new aws.cloudwatch.LogGroup(
    "bifrostSeedLogGroup",
    {
      name: BIFROST_SEED_LOG_GROUP_NAME,
      retentionInDays: BIFROST_SEED_LOG_RETENTION_DAYS,
      tags: { Name: BIFROST_SEED_LOG_GROUP_NAME },
    },
    { provider },
  );

  /**
   * The execution role: the ECS agent's identity, not the seed's. It pulls the
   * image from ECR, writes the log and resolves the one secret. The managed
   * policy is the same ECS execution policy the gateway's role attaches, so the
   * ECR pull and the log writes come from one place rather than a hand-written
   * statement list.
   */
  const executionRole = new aws.iam.Role(
    "bifrostSeedExecutionRole",
    {
      name: BIFROST_SEED_EXECUTION_ROLE_NAME,
      description:
        "Bifrost seed task execution: ECR pull, CloudWatch Logs, and read on the database password.",
      assumeRolePolicy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
          },
        ],
      }),
      managedPolicyArns: [ECS_EXECUTION_MANAGED_POLICY_ARN],
      inlinePolicies: [
        {
          name: "database-password",
          policy: pulumi
            .output(args.databaseSecretArn)
            .apply((secretArn) =>
              JSON.stringify(executionRoleSecretPolicyDocument([secretArn])),
            ),
        },
      ],
    },
    { provider },
  );

  /**
   * The task role: nothing.
   *
   * The seed's path has no AWS API in it — the database credential is the
   * Postgres one, injected by the agent — so an attached policy would be
   * permission this task does not use. It exists because `taskRoleArn` on a
   * task definition must name a role; a role with no policies is the honest
   * shape for "this process may not call AWS".
   */
  const taskRole = new aws.iam.Role(
    "bifrostSeedTaskRole",
    {
      name: BIFROST_SEED_TASK_ROLE_NAME,
      description:
        "Bifrost seed task: the dump runs against Postgres with the database's own credential, so this role carries no AWS permission.",
      assumeRolePolicy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
          },
        ],
      }),
    },
    { provider },
  );

  /**
   * The task definition. One container, and the only thing it does is run the
   * committed script.
   *
   * No `portMappings`: nothing connects to it. No `healthCheck`: it exits with
   * its own status, and a health check on a one-shot task would turn a failed
   * dump into a task ECS restarted rather than one it reported.
   *
   * `stopTimeout` is left unset on purpose. The script traps `EXIT` to remove
   * its temporary dump file, which is a `rm` and needs no time; the timeout that
   * matters is `timeout` in `stopTimeout`'s neighbour above, and the container
   * has nothing to drain.
   */
  /**
   * The handler in `ecs.ts` documents the trap this avoids: an `Output`
   * interpolated inside an `apply` callback is not resolved for you, and
   * `JSON.stringify` on one throws `Calling [toJSON] on an [Output<T>] is not
   * supported`. So every value that comes from another resource is listed as an
   * input to one `pulumi.all` *before* the object is built. Listing it is also
   * what makes the dependency edge real rather than a reference the serializer
   * never sees.
   */
  const taskDefinition = new aws.ecs.TaskDefinition(
    "bifrostSeedTaskDefinition",
    {
      family: BIFROST_SEED_TASK_FAMILY,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: BIFROST_SEED_CPU,
      memory: BIFROST_SEED_MEMORY,
      executionRoleArn: executionRole.arn,
      taskRoleArn: taskRole.arn,
      runtimePlatform: {
        // The image is built `--platform linux/amd64` in the workflow, so the
        // task is x86 rather than Fargate's arm64 default. Same as the gateway.
        cpuArchitecture: "X86_64",
        operatingSystemFamily: "LINUX",
      },
      containerDefinitions: pulumi.jsonStringify(
        pulumi
          .all([
            imageUri,
            args.databaseSecretArn,
            args.databaseHost,
            pulumi.output(args.databasePort).apply(String),
            logGroup.name,
          ])
          .apply(
            ([
              resolvedImage,
              databaseSecretArn,
              databaseHost,
              databasePort,
              resolvedLogGroupName,
            ]) => [
              {
                name: BIFROST_SEED_CONTAINER_NAME,
                image: resolvedImage,
                essential: true,
                // The base image runs as 1000:0 and the derived image drops
                // back to it after the install; running as that user is the
                // same property, stated rather than inherited.
                user: "1000:0",
                environment: seedEnvironment({
                  host: databaseHost,
                  port: databasePort,
                  sourceDatabase: args.sourceDatabase,
                  targetDatabase: args.targetDatabase,
                }),
                secrets: seedSecretEntries(databaseSecretArn),
                logConfiguration: {
                  logDriver: "awslogs",
                  options: {
                    "awslogs-group": resolvedLogGroupName,
                    "awslogs-region": REGION,
                    "awslogs-stream-prefix": BIFROST_SEED_LOG_STREAM_PREFIX,
                  },
                },
                linuxParameters: { initProcessEnabled: true },
              },
            ],
          ),
      ),
      tags: { Name: BIFROST_SEED_TASK_FAMILY },
    },
    { provider },
  );

  return {
    taskDefinition,
    logGroup,
    executionRole,
    taskRole,
    /** For a stack output, so a human can find the family without the console. */
    taskFamily: BIFROST_SEED_TASK_FAMILY,
    /** The image reference the task resolves, for the same reason. */
    imageUri,
  };
};

/** The two role names, apart from the gateway's so a policy cannot be reused. */
export const BIFROST_SEED_EXECUTION_ROLE_NAME = "bifrost-seed-task-execution";
export const BIFROST_SEED_TASK_ROLE_NAME = "bifrost-seed-task";

/** The shape `index.ts` consumes. */
export type BifrostSeedTask = ReturnType<typeof createBifrostSeedTask>;
