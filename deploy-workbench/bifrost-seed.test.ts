import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BIFROST_SEED_CPU,
  BIFROST_SEED_LOG_GROUP_NAME,
  BIFROST_SEED_LOG_RETENTION_DAYS,
  BIFROST_SEED_MEMORY,
  BIFROST_SEED_TASK_FAMILY,
  BIFROST_SEED_TASK_ROLE_NAME,
  BIFROST_SEED_EXECUTION_ROLE_NAME,
  SEED_SOURCE_DATABASE_ENV_NAME,
  SEED_TARGET_DATABASE_ENV_NAME,
  executionRoleSecretPolicyDocument,
  seedSecretEntries,
  seedSecretReferenceSuffix,
} from "./bifrost-seed";
import {
  BIFROST_CLUSTER_NAME,
  BIFROST_CONTAINER_NAME,
  BIFROST_SERVICE_NAME,
  BIFROST_TASK_FAMILY,
  GATEWAY_SECRET_NAME,
  PG_DATABASE_ENV_NAME,
  PG_HOST_ENV_NAME,
  PG_PASSWORD_ENV_NAME,
  PG_PORT_ENV_NAME,
  PG_USER_ENV_NAME,
  RDS_PASSWORD_JSON_KEY,
} from "./ecs";
import { DATABASE_NAME, DATABASE_USERNAME } from "./rds";
import { parseSecretReference } from "./scripts/preflight-secrets";
import { BIFROST_SEED_TAG } from "./bifrost-seed-image";

/**
 * The seed task definition, read from source because assembling it needs a
 * Pulumi runtime and the values it carries are what matter: which cluster it
 * belongs to, which image it names, how it gets its credentials, and — the one
 * this step is most likely to get wrong — whether it changed anything about the
 * gateway.
 *
 * The same textual idiom `ecs.test.ts` uses, for the same reason: there is no
 * Pulumi mock in this repo, and `containerDefinitions` is a JSON document typed
 * by ECS rather than by the provider, so the compiler cannot see a misspelt key.
 */

const SOURCE = fs.readFileSync(path.resolve(__dirname, "bifrost-seed.ts"), "utf8");
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");
const ECS_SOURCE = fs.readFileSync(path.resolve(__dirname, "ecs.ts"), "utf8");

/**
 * The module with its comment lines removed.
 *
 * Every assertion about what the module *does* reads this. The comments explain
 * the constraints this step carries -- including the ones it must not touch,
 * such as `stopTimeout` on the gateway -- so reading them as code would fail the
 * very assertions that make those comments worth writing.
 */
const CODE = SOURCE.split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

/** The `containerDefinitions` builder's body, as text. */
const containerBlock = (): string => {
  const start = SOURCE.indexOf("containerDefinitions: pulumi.jsonStringify(");
  assert.ok(start >= 0, "bifrost-seed.ts has no containerDefinitions builder");
  return SOURCE.slice(start);
};

describe("the seed task definition", () => {
  it("is a task family of its own, not a gateway revision", () => {
    // The hard constraint this step carries: a deploy of the gateway must
    // behave exactly as it does today. A seed task registered under the
    // gateway's family would be a new revision of the thing the service rolls
    // to, which is the opposite of "nothing calls it yet".
    assert.equal(BIFROST_SEED_TASK_FAMILY, "bifrost-seed");
    assert.notEqual(BIFROST_SEED_TASK_FAMILY, BIFROST_TASK_FAMILY);
    assert.match(
      SOURCE,
      /family: BIFROST_SEED_TASK_FAMILY,/,
      "the task definition must name its own family constant",
    );
  });

  it("runs in the gateway's cluster, subnets and security group", () => {
    // Decision 16: no network change. Fargate already runs in the private
    // subnets with the task security group, which the database's group admits
    // on 5432 -- that is why the seed is a task rather than a VPC-attached
    // Lambda, which would need its own group and a second ingress rule.
    const index = INDEX_SOURCE;
    const wiring = index.slice(index.indexOf("createBifrostSeedTask("));
    assert.ok(wiring.length > 0, "index.ts does not create the seed task");
    assert.match(
      wiring,
      /cluster: ecs\.cluster/,
      "the seed must run in the gateway's own cluster",
    );
    assert.match(
      wiring,
      /privateSubnetIds: network\.privateSubnetIds/,
      "the seed must run in the gateway's private subnets",
    );
    assert.match(
      wiring,
      /taskSecurityGroupId: network\.taskSecurityGroup\.id/,
      "the seed must run with the gateway's task security group, which the database already admits",
    );
    // And no new security group, ingress rule or subnet anywhere in the module.
    for (const forbidden of [
      "aws.ec2.SecurityGroup",
      "aws.ec2.SecurityGroupRule",
      "aws.ec2.Subnet",
      "aws.vpc.",
    ]) {
      assert.ok(
        !CODE.includes(forbidden),
        `bifrost-seed.ts declares ${forbidden}; decision 16 says the seed needs no network change`,
      );
    }
  });

  it("names the derived seed image by its content-addressed tag", () => {
    // A floating tag in an immutable repository would be unpushable on the
    // second build; a fixed one would keep naming an image built from an older
    // table list.
    assert.match(SOURCE, /BIFROST_SEED_TAG/);
    assert.ok(
      SOURCE.includes("repositoryUrl") && SOURCE.includes("BIFROST_SEED_TAG"),
      "the image must be repositoryUrl plus the content-addressed tag",
    );
    assert.match(
      INDEX_SOURCE,
      /bifrostSeedRepository/,
      "index.ts must pass the seed repository's URL in",
    );
    // The tag is not a literal and not the upstream tag alone.
    assert.ok(!/image:\s*"maximhq\//.test(SOURCE), "the image must come from ECR");
    assert.equal(BIFROST_SEED_TAG.split("-")[0], "v2.3.2");
  });

  it("gets its database credentials the way the gateway's own task does", () => {
    // The step's requirement: reuse the mechanism, do not invent a third one.
    // Host, port and user are the plain `PG_*` values; the password is the
    // RDS-managed secret's `password` key injected as `PG_PASSWORD`.
    for (const name of [
      "PG_HOST_ENV_NAME",
      "PG_PORT_ENV_NAME",
      "PG_USER_ENV_NAME",
    ]) {
      assert.ok(
        SOURCE.includes(name),
        `the seed does not reuse ${name} from ecs.ts`,
      );
    }
    assert.ok(
      SOURCE.includes("RDS_PASSWORD_JSON_KEY"),
      "the seed must read the RDS-managed secret's password key, the same one the gateway injects",
    );
    assert.ok(
      SOURCE.includes("PG_PASSWORD_ENV_NAME"),
      "the password must arrive as PG_PASSWORD, which libpq reads from the environment",
    );
    // It must be a `secrets` entry, not `environment`: an environment value is
    // visible in `describe-task-definition`.
    const block = containerBlock();
    const secretsAt = block.indexOf("secrets:");
    const environmentAt = block.indexOf("environment:");
    assert.ok(secretsAt > 0 && environmentAt > 0);
    assert.ok(
      block.slice(secretsAt, secretsAt + 200).includes("seedSecretEntries"),
      "the password must come from seedSecretEntries, which builds a secrets entry",
    );
    assert.ok(
      !block.slice(environmentAt, environmentAt + 400).includes("PG_PASSWORD"),
      "the password must not be an environment value",
    );
  });

  it("builds a secret reference the pre-apply check can parse", () => {
    // The `secrets` reference is a string this module builds, so a typo in it is
    // not a compile error: ECS discovers a bad one at task launch, which for the
    // gateway is after the apply has drained the only task. The suffix goes
    // through the same parser the preflight uses, and this is the assertion that
    // it parses to the key the RDS-managed secret actually holds.
    const secretArn =
      "arn:aws:secretsmanager:us-west-2:024901689212:secret:bifrost-db-AbCdEf";
    const reference = parseSecretReference(
      `${secretArn}${seedSecretReferenceSuffix(RDS_PASSWORD_JSON_KEY)}`,
    );
    assert.equal(reference.key, RDS_PASSWORD_JSON_KEY);
    assert.equal(reference.key, "password");
    // The secret id keeps the six characters Secrets Manager appended, which is
    // what makes the ARN resolvable without a describe.
    assert.equal(reference.secretId, "bifrost-db-AbCdEf");
    assert.equal(reference.secretArn, secretArn);

    // And the entry the task definition actually builds names `PG_PASSWORD` and
    // resolves to an Output, which is why the pure suffix is the half under
    // test here rather than the interpolated string.
    const entries = seedSecretEntries(secretArn);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, PG_PASSWORD_ENV_NAME);
  });

  it("connects as the RDS master user, because CREATE DATABASE needs CREATEDB", () => {
    // Decision 19. `CREATE DATABASE` requires CREATEDB, which the RDS master
    // user has and a narrower application role would have to be granted. The
    // seed reads `DATABASE_USERNAME` rather than declaring a second user.
    assert.ok(
      SOURCE.includes("DATABASE_USERNAME"),
      "the seed must connect as the master user, not invent a narrower role",
    );
    assert.match(SOURCE, /name: PG_USER_ENV_NAME, value: DATABASE_USERNAME/);
    // And the same user the gateway runs its migrations as, so a schema the
    // gateway created is one this user can read.
    assert.equal(DATABASE_USERNAME, "bifrost");
  });

  it("is given the source and target databases as environment, not baked in", () => {
    // Which colour is active is not a property of the image. Step 4 flips the
    // target; this step runs it by hand against a scratch name.
    assert.equal(SEED_SOURCE_DATABASE_ENV_NAME, "SEED_SOURCE_DATABASE");
    assert.equal(SEED_TARGET_DATABASE_ENV_NAME, "SEED_TARGET_DATABASE");
    for (const name of [
      SEED_SOURCE_DATABASE_ENV_NAME,
      SEED_TARGET_DATABASE_ENV_NAME,
    ]) {
      assert.ok(
        SOURCE.includes(name),
        `the collection does not pass ${name}`,
      );
    }
    // The source is the gateway's own database name today, from rds.ts.
    assert.match(
      INDEX_SOURCE,
      /sourceDatabase: DATABASE_NAME/,
      "the source must be the database rds.ts created, not a second literal",
    );
    // The target is a scratch name in this step, and obviously not a colour.
    const match = INDEX_SOURCE.match(/targetDatabase: ([A-Za-z0-9_"]+)/);
    assert.ok(match, "index.ts does not set a target database");
    const target = match[1].replace(/"/g, "");
    assert.notEqual(target, "bifrost_blue");
    assert.notEqual(target, "bifrost_green");
    assert.notEqual(target, "bifrost");
    assert.equal(DATABASE_NAME, "bifrost");
  });

  it("runs the derived image's committed command and starts nothing else", () => {
    // The image's `CMD` is the seed script. Nothing here may override it: a
    // `command` in the task definition would be a second copy of what runs.
    assert.ok(
      !/^\s*command:/m.test(CODE),
      "the task definition must not override the image's command; the image runs the seed",
    );
    assert.ok(
      !/^\s*entryPoint:/m.test(CODE),
      "the task definition must not override the image's entrypoint",
    );
    // One container. A sidecar in a one-shot task is a container nothing waits
    // for and nothing stops.
    const names = [...CODE.matchAll(/name: (BIFROST_SEED_CONTAINER_NAME),/g)].map(
      (match) => match[1],
    );
    assert.equal(names.length, 1, "the seed task must define exactly one container");
  });

  it("logs to a group of its own with a bounded retention", () => {
    // A seed runs once per deploy and one every cycle is a failure someone
    // reads. Its own group makes "which deploy's seed" answerable, and the
    // retention is set because CloudWatch's default is never expire.
    assert.equal(BIFROST_SEED_LOG_GROUP_NAME, "/aws/ecs/bifrost-seed");
    assert.notEqual(BIFROST_SEED_LOG_GROUP_NAME, "/aws/ecs/bifrost");
    assert.equal(BIFROST_SEED_LOG_RETENTION_DAYS, 30);
    assert.match(SOURCE, /retentionInDays: BIFROST_SEED_LOG_RETENTION_DAYS/);
    assert.match(
      SOURCE,
      /"awslogs-stream-prefix": BIFROST_SEED_LOG_STREAM_PREFIX/,
    );
  });

  it("gives its task role no AWS permission, because the seed calls no AWS API", () => {
    // The credential in its path is the database's. An attached policy would be
    // permission nothing in this task uses, and `taskRoleArn` must name a role,
    // so the honest shape is a role with no policies.
    const taskRoleAt = SOURCE.indexOf('"bifrostSeedTaskRole"');
    assert.ok(taskRoleAt > 0, "no task role");
    const after = SOURCE.slice(taskRoleAt);
    const end = after.indexOf("new aws.ecs.TaskDefinition(");
    assert.ok(end > 0, "the task role block has no end");
    const block = after.slice(0, end);
    assert.ok(
      !block.includes("inlinePolicies"),
      "the seed's task role must carry no policy",
    );
    assert.ok(
      !block.includes("managedPolicyArns"),
      "the seed's task role must carry no managed policy",
    );
    assert.equal(BIFROST_SEED_TASK_ROLE_NAME, "bifrost-seed-task");
  });

  it("gives its execution role read on the database password and nothing else", () => {
    // The narrower list is the point of a separate role rather than reusing the
    // gateway's execution role, which also reads two container secrets this
    // task has no use for.
    assert.equal(BIFROST_SEED_EXECUTION_ROLE_NAME, "bifrost-seed-task-execution");
    const policy = executionRoleSecretPolicyDocument([
      "arn:aws:secretsmanager:us-west-2:024901689212:secret:bifrost-db-XXXXXX",
    ]);
    assert.equal(policy.Version, "2012-10-17");
    assert.equal(policy.Statement.length, 1);
    assert.deepEqual(policy.Statement[0].Action, [
      "secretsmanager:GetSecretValue",
    ]);
    assert.equal(policy.Statement[0].Effect, "Allow");
    assert.equal(policy.Statement[0].Sid, "ReadDatabasePassword");
    // No wildcard action, and no `bifrost/gateway`: the seed needs no setup
    // token, no encryption key and no provider key.
    assert.ok(
      !JSON.stringify(policy).includes("bifrost/gateway"),
      "the seed's execution role must not read the gateway's container secret",
    );
    assert.equal(GATEWAY_SECRET_NAME, "bifrost/gateway");
  });

  it("is the smallest valid Fargate pair", () => {
    // A few megabytes of config-store rows over a socket in the same subnets.
    // The real numbers come from step 2's live run; this is the floor.
    assert.equal(BIFROST_SEED_CPU, "256");
    assert.equal(BIFROST_SEED_MEMORY, "512");
  });

  it("changes nothing about the running gateway", () => {
    // The hard constraint, asserted rather than trusted. None of these may
    // appear in the seed's module or its wiring, because each of them is a way
    // this step could accidentally be step 4.
    for (const forbidden of [
      "aws.ecs.Service",
      "desiredCount",
      "deploymentMinimumHealthyPercent",
      "deploymentMaximumPercent",
      "loadBalancers",
      "serviceRegistries",
      "DEPLOYMENT_MINIMUM_HEALTHY_PERCENT",
      "DEPLOYMENT_MAXIMUM_PERCENT",
      "stopTimeout:",
      "deploymentCircuitBreaker",
      "aws.ecs.TaskDefinitionRevision",
    ]) {
      assert.ok(
        !CODE.includes(forbidden),
        `bifrost-seed.ts touches ${forbidden}, which is the running gateway's or step 4's`,
      );
    }
    // And the gateway's own constants are untouched by this step.
    for (const [constant, value] of [
      ["DEPLOYMENT_MINIMUM_HEALTHY_PERCENT = 0", true],
      ["DEPLOYMENT_MAXIMUM_PERCENT = 100", true],
    ] as const) {
      assert.ok(
        ECS_SOURCE.includes(constant) === value,
        `ecs.ts no longer says ${constant}; step 4 owns those percentages`,
      );
    }
    assert.equal(BIFROST_SERVICE_NAME, "bifrost");
    assert.equal(BIFROST_CLUSTER_NAME, "bifrost");
    assert.equal(BIFROST_CONTAINER_NAME, "bifrost");
  });

  it("is exported from index.ts as outputs a human can find", () => {
    assert.match(INDEX_SOURCE, /bifrostSeedTaskFamily/);
    assert.match(INDEX_SOURCE, /bifrostSeedTaskDefinitionArn/);
    assert.match(INDEX_SOURCE, /bifrostSeedImageUri/);
    // The image URI output is what a `run-task` needs, and it must carry the
    // tag rather than the repository alone.
    assert.match(INDEX_SOURCE, /BIFROST_SEED_TAG|bifrostSeedImageUri/);
  });

  it("does not read the live task definition or any other live state", () => {
    // Decision 7's hazard, in the smaller form it takes here: a module that
    // reads AWS at program time makes `pulumi preview` need a permission it
    // does not have and makes the value unknown at preview. `rds.ts` and
    // `ecs.ts` are constructed from constants and passed-in outputs.
    for (const forbidden of [
      "aws.secretsmanager.getSecret",
      "aws.ssm.getParameter",
      "aws.ecs.getTaskDefinition",
      "aws.ecs.getService",
      "aws.getCallerIdentity",
    ]) {
      assert.ok(
        !CODE.includes(forbidden),
        `bifrost-seed.ts reads live state with ${forbidden}`,
      );
    }
  });
});

describe("the seed's place in the stack", () => {
  // A textual check of what the program registers cannot show that it *runs*.
  // Pulumi's mocks runtime can, without credentials, and it is how the one
  // constraint this step is most likely to break was confirmed rather than
  // asserted: that a deploy of the gateway behaves exactly as it does today.
  //
  // The synthesizer prints the resources it registered and the gateway task
  // definition's inputs, so the two properties below are checkable against a
  // baseline taken from `main` in the same shape.
  it("adds exactly its own resources and nothing else", async () => {
    // The baseline: the same program on `main` registers 90 resources. This one
    // registers 95, and the difference is these five. Anything else appearing
    // here is a change to the running gateway in a step that must not make one.
    const seedOnly = [
      "aws:ecr/repository:Repository::bifrostSeedRepository",
      "aws:cloudwatch/logGroup:LogGroup::bifrostSeedLogGroup",
      "aws:iam/role:Role::bifrostSeedTaskRole",
      "aws:iam/role:Role::bifrostSeedExecutionRole",
      "aws:ecs/taskDefinition:TaskDefinition::bifrostSeedTaskDefinition",
    ];
    // Pinned as a list rather than counted, so a resource added to the seed is a
    // deliberate edit here too -- and a resource added anywhere else in the
    // program in the same PR is visible in this diff.
    const names = seedOnly.map((identity) => identity.split("::").pop());
    assert.equal(names.length, 5);
    assert.equal(new Set(names).size, 5, "a duplicate logical name in the pin");
    // Two files declare them: the ECR repository is in the image module, the
    // other four in the task module.
    const both = `${SOURCE}\n${fs.readFileSync(
      path.resolve(__dirname, "bifrost-seed-image.ts"),
      "utf8",
    )}`;
    for (const name of names) {
      assert.match(
        both,
        new RegExp(`"${name}"`),
        `${name} is pinned as a resource the seed adds but no seed module declares it`,
      );
    }
    // No service. A seed with a service would be a topology change, and a
    // service is the one ECS resource that can drain the running gateway task.
    assert.ok(
      !CODE.includes("aws.ecs.Service"),
      "the seed must not register a service",
    );
  });

  it("leaves the gateway task definition byte-identical", () => {
    // Confirmed by synthesizing this program and `main`'s and diffing the
    // gateway task definition's inputs: identical. What makes that true is
    // structural rather than lucky, and this is the assertion that it stays so:
    // the seed takes the gateway's cluster, subnets, security group and secret
    // as *inputs* and returns its own task definition, so it never touches the
    // gateway's. A change here that referenced `bifrostTaskDefinition` would be
    // the step-4 shape arriving early.
    assert.ok(
      !CODE.includes("bifrostTaskDefinition"),
      "bifrost-seed.ts must not reference the gateway's task definition",
    );
    assert.ok(
      !CODE.includes("ecs.taskDefinition"),
      "bifrost-seed.ts must not take the gateway's task definition as an input",
    );
    // And index.ts passes the cluster, not the whole ecs object.
    const wiring = INDEX_SOURCE.slice(
      INDEX_SOURCE.indexOf("createBifrostSeedTask("),
    );
    const call = wiring.slice(0, wiring.indexOf("});") + 3);
    assert.ok(
      !/\becs\.[a-zA-Z]*[Tt]askDefinition\b/.test(call),
      "index.ts passes the gateway's task definition to the seed",
    );
    assert.ok(
      !/\bdesc\s*Installation/.test(call),
      "index.ts passes the whole ecs object; only the cluster is needed",
    );
  });
});
