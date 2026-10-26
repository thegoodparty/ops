import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AWS_REGION_ENV_NAME,
  BIFROST_API_BASE_URL,
  BIFROST_API_BASE_URL_ENV_NAME,
  BIFROST_BOOTSTRAP_CONTAINER_NAME,
  BIFROST_BOOTSTRAP_LOG_STREAM_PREFIX,
  BIFROST_BOOTSTRAP_SECRET_KEYS,
  BIFROST_CONFIG_ENV_NAME,
  BIFROST_CONFIG_FILE_PATH,
  BIFROST_CONFIG_PARAMETER_NAME,
  BIFROST_CONFIG_SOURCE_PATH,
  BIFROST_CONFIG_VERSION_ENV_NAME,
  BIFROST_CONTAINER_COMMAND,
  BIFROST_CONTAINER_ENTRY_POINT,
  BIFROST_CLUSTER_NAME,
  BIFROST_CONTAINER_CPU,
  BIFROST_CONTAINER_MEMORY,
  BIFROST_CONTAINER_NAME,
  BIFROST_LOG_GROUP_NAME,
  BIFROST_LOG_RETENTION_DAYS,
  BIFROST_LOG_STREAM_PREFIX,
  BIFROST_HEALTH_CHECK,
  BIFROST_SERVICE_NAME,
  BIFROST_TASK_FAMILY,
  DEPLOYMENT_MAXIMUM_PERCENT,
  DEPLOYMENT_MINIMUM_HEALTHY_PERCENT,
  ECS_EXECUTION_MANAGED_POLICY_ARN,
  EXECUTION_PARAMETER_ACTIONS,
  EXECUTION_ROLE_NAME,
  EXECUTION_SECRET_ACTIONS,
  GATEWAY_PLAIN_ENV_NAMES,
  GATEWAY_SECRET_KEYS,
  GATEWAY_SECRET_NAME,
  OAUTH2_PROXY_CONTAINER_CPU,
  OAUTH2_PROXY_CONTAINER_MEMORY,
  OAUTH2_PROXY_CONTAINER_NAME,
  OAUTH2_PROXY_ENVIRONMENT,
  OAUTH2_PROXY_SECRET_KEYS,
  OAUTH2_PROXY_SECRET_NAME,
  PG_DATABASE_ENV_NAME,
  PG_HOST_ENV_NAME,
  PG_PASSWORD_ENV_NAME,
  PG_PORT_ENV_NAME,
  PG_USER_ENV_NAME,
  RDS_PASSWORD_JSON_KEY,
  TASK_BEDROCK_ACTIONS,
  TASK_CPU,
  TASK_MEMORY,
  TASK_ROLE_NAME,
  executionRoleConfigParameterPolicyDocument,
  executionRoleSecretsPolicyDocument,
  readBifrostConfig,
  secretArnPattern,
  secretReference,
  taskRolePolicyDocument,
} from "./ecs";
import { BIFROST_PORT, OAUTH2_PROXY_PORT, REGION } from "./network";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { bedrockInvokeResources } from "../utils/bedrock-models";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";
import { BIFROST_HOSTNAME } from "./ingress";
import {
  OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_TAG,
} from "./oauth2-proxy-image";

/**
 * The ECS module's constants, its two policy documents, and the wiring of the
 * task definition, checked without standing up a Pulumi resource. The
 * resources themselves are exercised by the CI `pulumi preview` on the pull
 * request; what a unit test can usefully pin is the handful of things that
 * would break silently in an apply: the execution/task role split, the secret
 * references by name and key (a rename there is a container that starts
 * without its credentials), `initProcessEnabled`, the log configuration, the
 * subnet and security-group wiring, and the absence of any wildcard IAM
 * action.
 *
 * The task definition's arguments are asserted against the source, the way
 * `rds.test.ts` and `ingress.test.ts` do it, because the resource cannot be
 * constructed here without a Pulumi runtime.
 */

const ECS_SOURCE = fs.readFileSync(path.resolve(__dirname, "ecs.ts"), "utf8");
const INDEX_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);
const FILL_SECRETS_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost/fill-secrets.sh"),
  "utf8",
);
const BIFROST_CONFIG_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost/config.json"),
  "utf8",
);

/**
 * The `env.NAME` references in `bifrost/config.json`. Only the name is looked
 * at; the test never resolves one and never sees a value.
 */
const configEnvReferences = (): string[] => {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^env\.([A-Z][A-Z0-9_]*)$/.exec(value);
      if (match) out.push(match[1]);
    } else if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
    } else if (value && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        walk(entry);
      }
    }
  };
  walk(JSON.parse(BIFROST_CONFIG_SOURCE));
  return out;
};

/**
 * The source of one named resource's constructor call, from its logical-name
 * literal to the next `new aws.` (or the end of the file). Enough to tell
 * whether an argument belongs to that resource rather than a sibling, which a
 * bare `includes` on the whole file cannot.
 */
const resourceBlock = (logicalName: string): string => {
  const marker = `"${logicalName}"`;
  const start = ECS_SOURCE.indexOf(marker);
  assert.ok(start >= 0, `ecs.ts has no resource named ${logicalName}`);
  const rest = ECS_SOURCE.slice(start);
  const next = rest.indexOf("new aws.", 1);
  return next >= 0 ? rest.slice(0, next) : rest;
};

/**
 * The container-definition body, which ecs.ts builds above the task definition
 * (it is assembled as an `Output` first, then passed in). Assertions about the
 * container — its secrets, its log driver, its init process, its port — read
 * this rather than the task-definition block, which holds only the task-level
 * arguments.
 */
const containerBlock = (): string => {
  const start = ECS_SOURCE.indexOf("const containerDefinitions");
  assert.ok(start >= 0, "ecs.ts has no containerDefinitions builder");
  const end = ECS_SOURCE.indexOf("new aws.ecs.TaskDefinition(");
  assert.ok(
    end > start,
    "the container definitions must precede the task definition",
  );
  return ECS_SOURCE.slice(start, end);
};

/**
 * One container's definition, from its `name:` line to the start of the next
 * container object (or the end of the builder for the last one). The builder
 * holds an array of containers, so a whole-block `includes` cannot tell the
 * sidecar's secrets from Bifrost's; this can. The end marker names the container
 * constants rather than any `name:` line, because the secrets and environment
 * entries inside a container also use that key.
 */
const containerDefinitionBlock = (nameConstant: string): string => {
  const block = containerBlock();
  const marker = new RegExp(`\\n\\s*name: ${nameConstant},`);
  const start = block.search(marker);
  assert.ok(start >= 0, `ecs.ts has no container named ${nameConstant}`);
  const rest = block.slice(start + 1);
  const next = rest.search(
    /\n\s*name: (?:BIFROST_CONTAINER_NAME|OAUTH2_PROXY_CONTAINER_NAME|BIFROST_BOOTSTRAP_CONTAINER_NAME),/,
  );
  return next >= 0 ? rest.slice(0, next) : rest;
};

describe("bifrost ecs", () => {
  it("runs one Fargate task at the plan's sizing", () => {
    // 0.5 vCPU / 1 GB, per "Compute: ECS Fargate" — the smallest valid
    // Fargate pair, and a one-line change if the load ever needs more.
    assert.equal(TASK_CPU, "512");
    assert.equal(TASK_MEMORY, "1024");

    const block = resourceBlock("bifrostTaskDefinition");
    assert.ok(block.includes('networkMode: "awsvpc"'), block);
    assert.ok(block.includes('requiresCompatibilities: ["FARGATE"]'), block);
    assert.ok(block.includes("cpu: TASK_CPU"));
    assert.ok(block.includes("memory: TASK_MEMORY"));
    assert.ok(block.includes("family: BIFROST_TASK_FAMILY"));
    assert.equal(BIFROST_TASK_FAMILY, "bifrost");
  });

  it("keeps the execution role and the task role split", () => {
    // Two roles, two names, two logical resources. Collapsing them would hand
    // the network-facing gateway process the ECS and Secrets Manager
    // permissions it never uses.
    assert.notEqual(EXECUTION_ROLE_NAME, TASK_ROLE_NAME);

    const taskDef = resourceBlock("bifrostTaskDefinition");
    assert.ok(
      taskDef.includes("executionRoleArn: executionRole.arn"),
      "the task definition must use the execution role it creates",
    );
    assert.ok(
      taskDef.includes("taskRoleArn: taskRole.arn"),
      "the task definition must use the task role it creates",
    );

    // The execution role is the ECS agent's: the managed task-execution
    // policy for ECR and logs, plus read on the injected secrets. It holds no
    // managed policy beyond that one.
    const executionRole = resourceBlock("bifrostExecutionRole");
    assert.ok(
      executionRole.includes(
        "managedPolicyArns: [ECS_EXECUTION_MANAGED_POLICY_ARN]",
      ),
      executionRole,
    );
    assert.equal(
      ECS_EXECUTION_MANAGED_POLICY_ARN,
      "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    );

    // The task role is the gateway's identity: no managed policies at all,
    // which is the whole difference from the delegate's task role.
    const taskRole = resourceBlock("bifrostTaskRole");
    assert.ok(
      !taskRole.includes("managedPolicyArns"),
      "the task role must not carry AWS-managed policies",
    );

    // Neither role's assumptions are shared with anything else, and neither
    // is assumed by a human.
    for (const name of [EXECUTION_ROLE_NAME, TASK_ROLE_NAME]) {
      assert.match(name, /^bifrost-/);
    }
  });

  it("gives the execution role secrets read and the task role nothing but Bedrock", () => {
    const executionPolicy = executionRoleSecretsPolicyDocument([
      secretArnPattern(GATEWAY_SECRET_NAME),
      secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
      "arn:aws:secretsmanager:us-west-2:024901689212:secret:rds!db-abc123",
    ]);
    const executionActions = executionPolicy.Statement.flatMap((s) => s.Action);
    assert.deepEqual([...EXECUTION_SECRET_ACTIONS], [
      "secretsmanager:GetSecretValue",
    ]);
    assert.ok(executionActions.every((a) => a.startsWith("secretsmanager:")));
    assert.ok(
      executionActions.every((a) => !a.includes("bedrock")),
      "the execution role must not hold Bedrock actions",
    );

    const taskPolicy = taskRolePolicyDocument(bedrockInvokeResources());
    const taskActions = taskPolicy.Statement.flatMap((s) => s.Action);
    assert.deepEqual([...TASK_BEDROCK_ACTIONS], [
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]);
    assert.ok(taskActions.every((a) => a.startsWith("bedrock:")));
    assert.ok(
      taskActions.every((a) => !a.includes("secretsmanager")),
      "the task role must not read secrets: the agent does that, not Bifrost",
    );
  });

  it("scopes the task role to the model list, not to wildcard resources", () => {
    // The plan: "The role is scoped to the model list in
    // utils/bedrock-models.ts". Composed here from the same function
    // WorkbenchAccess uses, so adding a model there reaches the gateway too.
    const policy = taskRolePolicyDocument(bedrockInvokeResources());
    const resources = policy.Statement.flatMap((s) => s.Resource);
    assert.ok(resources.length > 0);
    for (const arn of resources) {
      assert.match(arn, /^arn:aws:bedrock:/);
      assert.ok(
        arn.includes(":inference-profile/") || arn.includes(":foundation-model/"),
        arn,
      );
    }
    assert.ok(ECS_SOURCE.includes("bedrockInvokeResources()"));
  });

  it("has no wildcard IAM action or a wildcard resource on either role", () => {
    // The failure this catches is an edit that "fixes" an AccessDenied by
    // widening to `bedrock:*` or `Resource: "*"`, which is exactly the broad
    // grant the plan rules out.
    //
    // Built with the same three ARN shapes `ecs.ts` grants — the two script-owned
    // secret name patterns and the exact ARN item 7 returns for the RDS-managed
    // master password — so the no-wildcard property is exercised over the RDS
    // ARN too, not only over the two secret references.
    const rdsSecretArn = `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:rds!db-1a2b3c4d-5e6f-7890-abcd-ef1234567890`;
    const executionSecretArns = [
      secretArnPattern(GATEWAY_SECRET_NAME),
      secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
      rdsSecretArn,
    ];
    const executionPolicy =
      executionRoleSecretsPolicyDocument(executionSecretArns);
    const taskPolicy = taskRolePolicyDocument(bedrockInvokeResources());

    for (const document of [executionPolicy, taskPolicy]) {
      assert.equal(document.Version, "2012-10-17");
      for (const statement of document.Statement) {
        assert.equal(statement.Effect, "Allow");
        for (const action of statement.Action) {
          assert.ok(!action.includes("*"), `wildcard action ${action}`);
        }
        assert.ok(statement.Resource.length > 0);
        for (const resource of statement.Resource) {
          assert.notEqual(resource, "*", "a resource must not be *");
        }
      }
    }

    // The execution role's resources are the three secret ARNs it grants, in
    // the shapes the module uses: the two script-owned names carry the six
    // random characters Secrets Manager appends, wildcarded; the RDS-managed
    // secret is granted by its exact ARN, which carries no wildcard at all.
    // Neither shape may acquire a `*`, which is the property being pinned.
    const executionResources = executionPolicy.Statement.flatMap(
      (statement) => statement.Resource,
    );
    assert.deepEqual(executionResources, executionSecretArns);
    for (const resource of executionResources) {
      assert.match(
        resource,
        /^arn:aws:secretsmanager:us-west-2:024901689212:secret:/,
        resource,
      );
      assert.equal(
        resource.split("*").length - 1,
        0,
        `a secret resource must not carry a wildcard: ${resource}`,
      );
    }
    // The only wildcard anywhere in these ARNs is the six `?` characters of
    // the script-owned name patterns; `?` is a single-character glob, not a
    // rest-of-ARN wildcard, and it is not `*`.
    for (const resource of executionResources.slice(0, 2)) {
      assert.match(resource, /-\?\?\?\?\?\?$/, resource);
    }
    assert.equal(executionResources[2], rdsSecretArn);

    // The task role's are model ARNs. They carry exactly one wildcard, the
    // region, and that is deliberate: the destination set differs per model
    // (`utils/bedrock-models.ts`), so enumerating regions fails intermittently
    // and looks identical to missing model access.
    for (const resource of taskPolicy.Statement.flatMap(
      (statement) => statement.Resource,
    )) {
      assert.match(resource, /^arn:aws:bedrock:\*:/, resource);
      assert.equal(
        resource.split("*").length - 1,
        1,
        `only the region may be wildcarded: ${resource}`,
      );
    }
    // And nothing in the module sneaks a wildcard into an inline document.
    assert.ok(
      !/Action:\s*(\[?\s*)?["'][a-z0-9]+:\*["']/.test(ECS_SOURCE),
      "ecs.ts must not contain a service-wildcard action",
    );
    assert.ok(
      !/Resource:\s*(\[?\s*)?["']\*["']/.test(ECS_SOURCE),
      "ecs.ts must not contain a wildcard resource",
    );
    assert.ok(
      !/"\*"/.test(ECS_SOURCE),
      "ecs.ts must not contain a bare wildcard",
    );
  });

  it("references the gateway secrets by the names and keys fill-secrets.sh writes", () => {
    // The script announced the two containers, and its key names are what the
    // plan injects. Nothing is renamed on either side: this is the assertion
    // that keeps the task definition and the runbook in step.
    assert.equal(GATEWAY_SECRET_NAME, "bifrost/gateway");
    assert.equal(OAUTH2_PROXY_SECRET_NAME, "bifrost/oauth2-proxy");
    assert.ok(
      FILL_SECRETS_SOURCE.includes(`GATEWAY_SECRET="${GATEWAY_SECRET_NAME}"`),
      "fill-secrets.sh names a different gateway secret",
    );
    assert.ok(
      FILL_SECRETS_SOURCE.includes(`OAUTH_SECRET="${OAUTH2_PROXY_SECRET_NAME}"`),
      "fill-secrets.sh names a different oauth2-proxy secret",
    );

    assert.deepEqual([...GATEWAY_SECRET_KEYS], [
      "BIFROST_ENCRYPTION_KEY",
      "BIFROST_ADMIN_USERNAME",
      "BIFROST_ADMIN_PASSWORD",
      "BIFROST_SETUP_TOKEN",
      "FIREWORKS_API_KEY",
    ]);
    assert.deepEqual([...OAUTH2_PROXY_SECRET_KEYS], [
      "OAUTH2_PROXY_CLIENT_ID",
      "OAUTH2_PROXY_CLIENT_SECRET",
      "OAUTH2_PROXY_COOKIE_SECRET",
    ]);
    for (const key of [...GATEWAY_SECRET_KEYS, ...OAUTH2_PROXY_SECRET_KEYS]) {
      assert.ok(
        FILL_SECRETS_SOURCE.includes(key),
        `fill-secrets.sh does not write ${key}`,
      );
    }

    // The gateway container gets exactly its own five, by name, from its own
    // container; the sidecar gets its own three, from its own container. Each
    // container's secrets name its own secret container and never the other's.
    const gateway = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(gateway.includes("GATEWAY_SECRET_KEYS.map"), gateway);
    assert.ok(
      gateway.includes("secretReference(GATEWAY_SECRET_NAME, key)"),
      gateway,
    );
    assert.ok(
      !gateway.includes("OAUTH2_PROXY_SECRET_NAME"),
      "the Bifrost container must not receive the OAuth proxy's credentials",
    );
    const sidecar = containerDefinitionBlock("OAUTH2_PROXY_CONTAINER_NAME");
    assert.ok(sidecar.includes("OAUTH2_PROXY_SECRET_KEYS.map"), sidecar);
    assert.ok(
      sidecar.includes("secretReference(OAUTH2_PROXY_SECRET_NAME, key)"),
      sidecar,
    );
    assert.ok(
      !sidecar.includes("GATEWAY_SECRET_NAME"),
      "the sidecar must not receive the gateway's provider or admin secrets",
    );
  });

  it("injects every name config.json resolves from the environment", () => {
    // The hole this closes: a name `config.json` resolves by `env.NAME`, but
    // that the task definition never injects, resolves to nothing at runtime.
    // Every reference in the file has to be one of the gateway container's own
    // secrets or one of its plain environment entries, and the second half is
    // what item 10's Postgres connection depends on.
    const referenced = configEnvReferences();
    assert.ok(referenced.length > 0, "config.json references no env vars");
    const injected = new Set<string>([
      ...GATEWAY_SECRET_KEYS,
      ...GATEWAY_PLAIN_ENV_NAMES,
      PG_PASSWORD_ENV_NAME,
    ]);
    const block = containerBlock();
    for (const name of referenced) {
      assert.ok(
        injected.has(name),
        `config.json resolves env.${name}, which neither the gateway container's secrets nor its environment carries; the reference would resolve to nothing`,
      );
      assert.ok(
        block.includes(`name: ${name}`) ||
          (GATEWAY_SECRET_KEYS as readonly string[]).includes(name),
        `ecs.ts does not inject env.${name}`,
      );
    }
    // And the bootstrap token is one of them, so the claim path cannot quietly
    // lose its injection again.
    assert.ok(
      referenced.includes("BIFROST_SETUP_TOKEN"),
      "config.json no longer resolves env.BIFROST_SETUP_TOKEN",
    );
    // The Postgres half is what makes the config store survive a task
    // replacement, so a dropped reference is the SQLite regression again.
    for (const name of [
      "PG_HOST",
      "PG_PORT",
      "PG_USER",
      "PG_PASSWORD",
      "PG_DATABASE",
    ]) {
      assert.ok(
        referenced.includes(name),
        `config.json no longer resolves env.${name}, so the stores would fall back to SQLite`,
      );
    }
  });

  it("injects the four non-secret Postgres values from the database module", () => {
    // host and port are item 7's outputs; user and database name are that
    // module's constants. Nothing here spells a connection string a second
    // time, and the password stays the RDS-managed secret.
    assert.equal(PG_HOST_ENV_NAME, "PG_HOST");
    assert.equal(PG_PORT_ENV_NAME, "PG_PORT");
    assert.equal(PG_USER_ENV_NAME, "PG_USER");
    assert.equal(PG_DATABASE_ENV_NAME, "PG_DATABASE");
    const block = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    for (const fragment of [
      "{ name: PG_HOST_ENV_NAME, value: databaseAddress }",
      "{ name: PG_PORT_ENV_NAME, value: databasePort }",
      "{ name: PG_USER_ENV_NAME, value: DATABASE_USERNAME }",
      "{ name: PG_DATABASE_ENV_NAME, value: DATABASE_NAME }",
    ]) {
      assert.ok(block.includes(fragment), `${fragment} is missing\n${block}`);
    }
    // The port is the number RDS reports, so it cannot drift from the security
    // group that admits it; ECS would reject a number, hence the conversion.
    assert.ok(
      ECS_SOURCE.includes("database.port.apply(String)"),
      "the Postgres port must be the database's own output, stringified",
    );
  });

  it("builds a valueFrom that names the secret, the key and the defaults", () => {
    assert.equal(
      secretReference(GATEWAY_SECRET_NAME, "BIFROST_ENCRYPTION_KEY"),
      `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:bifrost/gateway:BIFROST_ENCRYPTION_KEY::`,
    );
    // Partial ARN: no random six-character suffix, because nothing here may
    // describe the secret, and a refill must not need a task-definition change.
    assert.ok(
      !secretReference(GATEWAY_SECRET_NAME, "X").includes("?"),
      "a valueFrom cannot wildcard the ARN suffix",
    );
    // The IAM resource is the opposite: Secrets Manager appends six random
    // characters, so the grant has to wildcard exactly them.
    assert.equal(
      secretArnPattern(GATEWAY_SECRET_NAME),
      `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:bifrost/gateway-??????`,
    );
    assert.equal(REGION, "us-west-2");
  });

  it("injects the RDS-managed master password item 7 handed over", () => {
    // rds.ts: "The secret's ARN is returned below for item 8 to inject as the
    // task's `PG_PASSWORD`". Only the password; host, port, user and database
    // belong to config.json in item 10.
    assert.equal(RDS_PASSWORD_JSON_KEY, "password");
    assert.equal(PG_PASSWORD_ENV_NAME, "PG_PASSWORD");
    const block = containerBlock();
    assert.ok(
      block.includes("valueFrom: `${databaseSecretArn}:${RDS_PASSWORD_JSON_KEY}::`"),
      block,
    );
    // And the read grant names the same ARN.
    assert.ok(
      resourceBlock("bifrostExecutionRole").includes("database.secretArn.apply"),
      "the execution role must be granted read on the RDS secret",
    );
  });

  it("never declares, versions or reads a secret's value", () => {
    // The two containers are script-owned and already hold real values; a
    // Pulumi-declared `Secret` or `SecretVersion` here could replace one and
    // delete them. Nothing in this module reads a value either, which is what
    // keeps `preview` free of `secretsmanager:GetSecretValue`.
    for (const forbidden of [
      "new aws.secretsmanager.Secret(",
      "aws.secretsmanager.SecretVersion",
      "aws.secretsmanager.getSecret",
      "getSecretValue",
    ]) {
      assert.ok(
        !ECS_SOURCE.includes(forbidden),
        `ecs.ts must not use ${forbidden}`,
      );
    }
  });

  it("runs Bifrost under an init process with awslogs", () => {
    for (const name of [
      "BIFROST_CONTAINER_NAME",
      "OAUTH2_PROXY_CONTAINER_NAME",
    ]) {
      const block = containerDefinitionBlock(name);
      // Both are the delegate's idiom, copied deliberately: PID 1 reaps and
      // forwards signals, and the container's stdout is the log group. Item 9
      // gives the sidecar the same treatment: it is the container that holds
      // the task's public admin door, so it must shut down on a signal.
      assert.ok(
        block.includes("linuxParameters: { initProcessEnabled: true }"),
        `${name} must set initProcessEnabled`,
      );
      assert.ok(block.includes('logDriver: "awslogs"'), block);
      // The name is resolved through the surrounding `pulumi.all` rather than
      // read as an Output inside the `apply` callback; see the dedicated test
      // below for why that distinction is load-bearing.
      assert.ok(block.includes('"awslogs-group": resolvedLogGroupName'), block);
      assert.ok(block.includes('"awslogs-region": REGION'), block);
      assert.ok(
        block.includes('"awslogs-stream-prefix": BIFROST_LOG_STREAM_PREFIX'),
        block,
      );
    }
    assert.equal(BIFROST_LOG_STREAM_PREFIX, "bifrost");
  });

  it("keeps the log group named, retained and the container's port", () => {
    assert.equal(BIFROST_LOG_GROUP_NAME, "/aws/ecs/bifrost");
    assert.equal(BIFROST_LOG_RETENTION_DAYS, 30);
    const logGroup = resourceBlock("bifrostLogGroup");
    assert.ok(logGroup.includes("name: BIFROST_LOG_GROUP_NAME"), logGroup);
    assert.ok(
      logGroup.includes("retentionInDays: BIFROST_LOG_RETENTION_DAYS"),
      "the log group must set a retention; CloudWatch never expires by default",
    );

    const block = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(block.includes("containerPort: BIFROST_PORT"), block);
    assert.equal(BIFROST_PORT, 8080);
    assert.equal(BIFROST_CONTAINER_NAME, "bifrost");
  });

  it("runs in the private subnets with the task security group", () => {
    const service = resourceBlock("bifrostService");
    assert.ok(service.includes("subnets: network.privateSubnetIds"), service);
    assert.ok(
      service.includes("securityGroups: [network.taskSecurityGroup.id]"),
      "the service must use item 5's task security group",
    );
    assert.ok(service.includes("assignPublicIp: false"), service);
    assert.ok(
      !service.includes("publicSubnetIds"),
      "the task must not run in the public subnets",
    );
  });

  it("declares no target group, listener or security group of its own", () => {
    // All of them exist in items 5 and 6. A second copy would be a target
    // nothing routes to and a group nothing references.
    for (const forbidden of [
      "new aws.lb.TargetGroup(",
      "new aws.lb.Listener(",
      "new aws.lb.LoadBalancer(",
      "new aws.ec2.SecurityGroup(",
      "new aws.vpc.SecurityGroup",
    ]) {
      assert.ok(
        !ECS_SOURCE.includes(forbidden),
        `ecs.ts must not declare ${forbidden}`,
      );
    }
    assert.equal(BIFROST_SERVICE_NAME, "bifrost");
  });

  it("registers the task as a target in both listener-referenced groups", () => {
    // Item 8 could not register at all: ECS's CreateService rejects a target
    // group that no listener or listener rule references
    //   InvalidParameterException: The target group with targetGroupArn ...
    //   does not have an associated load balancer.
    // Item 9 adds the rules (ingress.ts) and the registration together.
    const service = resourceBlock("bifrostService");
    assert.ok(service.includes("loadBalancers: ["), service);
    assert.ok(
      service.includes("targetGroupArn: ingress.bifrostTargetGroup.arn"),
      service,
    );
    assert.ok(
      service.includes("targetGroupArn: ingress.oauth2ProxyTargetGroup.arn"),
      service,
    );
    // Each group receives the container that publishes its port, which is what
    // the target groups' health checks (Bifrost /health, proxy /ping) assume.
    const bifrostEntry = service.indexOf(
      "targetGroupArn: ingress.bifrostTargetGroup.arn",
    );
    const proxyEntry = service.indexOf(
      "targetGroupArn: ingress.oauth2ProxyTargetGroup.arn",
    );
    assert.ok(bifrostEntry >= 0 && proxyEntry > bifrostEntry, service);
    const bifrostLoadBalancer = service.slice(bifrostEntry, proxyEntry);
    const proxyLoadBalancer = service.slice(proxyEntry, service.indexOf("],\n", proxyEntry));
    assert.ok(
      bifrostLoadBalancer.includes("containerName: BIFROST_CONTAINER_NAME") &&
        bifrostLoadBalancer.includes("containerPort: BIFROST_PORT"),
      "the Bifrost target group must receive the Bifrost container on 8080",
    );
    assert.ok(
      proxyLoadBalancer.includes("containerName: OAUTH2_PROXY_CONTAINER_NAME") &&
        proxyLoadBalancer.includes("containerPort: OAUTH2_PROXY_PORT"),
      "the oauth2-proxy target group must receive the sidecar on 4180",
    );
    // The listener rules are an explicit dependency, so the groups are
    // associated before ECS registers the task rather than by luck of
    // Pulumi's ordering.
    assert.ok(service.includes("dependsOn: ingress.listenerRules"), service);
    // And the module now depends on the ingress on purpose, with the reason
    // still recorded so nobody deletes the dependency.
    assert.ok(ECS_SOURCE.includes('from "./ingress"'));
    assert.ok(ECS_SOURCE.includes("does not have an associated load balancer"));
  });

  it("runs the oauth2-proxy sidecar beside Bifrost, on its own port and secrets", () => {
    // Item 9: the admin surface's only door. Same task and network namespace,
    // so it proxies to 127.0.0.1:8080 without a hop back through the ALB.
    assert.equal(OAUTH2_PROXY_CONTAINER_NAME, "oauth2-proxy");
    assert.equal(OAUTH2_PROXY_CONTAINER_CPU, 64);
    assert.equal(OAUTH2_PROXY_CONTAINER_MEMORY, 128);

    const sidecar = containerDefinitionBlock("OAUTH2_PROXY_CONTAINER_NAME");
    assert.ok(sidecar.includes("image: resolvedOauth2ProxyImage"), sidecar);
    assert.ok(sidecar.includes("containerPort: OAUTH2_PROXY_PORT"), sidecar);
    assert.equal(OAUTH2_PROXY_PORT, 4180);
    assert.ok(sidecar.includes("OAUTH2_PROXY_SECRET_KEYS.map"), sidecar);
    assert.ok(
      sidecar.includes("secretReference(OAUTH2_PROXY_SECRET_NAME, key)"),
      sidecar,
    );
    // The admin surface gets its three credentials and nothing else: no
    // database password, no provider key, no AWS configuration.
    assert.ok(!sidecar.includes("PG_PASSWORD_ENV_NAME"), sidecar);
    assert.ok(!sidecar.includes("GATEWAY_SECRET_NAME"), sidecar);
    assert.ok(!sidecar.includes("AWS_REGION_ENV_NAME"), sidecar);
    // Essential, so a proxy that cannot start takes the task with it instead
    // of leaving a gateway with an admin surface that has no door.
    assert.ok(sidecar.includes("essential: true"), sidecar);
  });

  it("claims the deployment from a one-shot container after the gateway is healthy", () => {
    // Item 11. Upstream's setup lock accepts one call while no admin account
    // exists, and it has to come from inside the task: once oauth2-proxy
    // fronts the gateway the ALB sends admin paths to Google first.
    assert.equal(BIFROST_BOOTSTRAP_CONTAINER_NAME, "bifrost-bootstrap");
    assert.equal(
      BIFROST_BOOTSTRAP_LOG_STREAM_PREFIX,
      "bifrost-bootstrap",
      "the claim's output must be a filterable stream of its own",
    );
    assert.equal(BIFROST_API_BASE_URL, `http://127.0.0.1:${BIFROST_PORT}`);
    assert.equal(BIFROST_API_BASE_URL_ENV_NAME, "BIFROST_API_BASE_URL");

    // Exactly the three keys the claim reads, all of them already injected
    // into the gateway container from the same secret; no new secret, and no
    // provider or encryption key anywhere near it.
    assert.deepEqual([...BIFROST_BOOTSTRAP_SECRET_KEYS], [
      "BIFROST_SETUP_TOKEN",
      "BIFROST_ADMIN_USERNAME",
      "BIFROST_ADMIN_PASSWORD",
    ]);
    for (const key of BIFROST_BOOTSTRAP_SECRET_KEYS) {
      assert.ok(
        (GATEWAY_SECRET_KEYS as readonly string[]).includes(key),
        `${key} is not one of the gateway container's injected secrets`,
      );
    }
    for (const key of ["FIREWORKS_API_KEY", "BIFROST_ENCRYPTION_KEY"]) {
      assert.ok(
        !(BIFROST_BOOTSTRAP_SECRET_KEYS as readonly string[]).includes(key),
        `the claim must not receive ${key}`,
      );
    }

    const bootstrap = containerDefinitionBlock(
      "BIFROST_BOOTSTRAP_CONTAINER_NAME",
    );
    assert.ok(bootstrap.includes("image: resolvedBootstrapImage"), bootstrap);
    assert.ok(
      bootstrap.includes("essential: false"),
      "a claim that cannot run must not take the gateway down with it",
    );
    assert.ok(bootstrap.includes("dependsOn"), bootstrap);
    assert.ok(
      bootstrap.includes('condition: "HEALTHY"'),
      "the claim must wait for a gateway that finished loading, not just a started process",
    );
    assert.ok(
      bootstrap.includes("BIFROST_BOOTSTRAP_SECRET_KEYS.map"),
      bootstrap,
    );
    assert.ok(
      bootstrap.includes("secretReference(GATEWAY_SECRET_NAME, key)"),
      bootstrap,
    );
    assert.ok(!bootstrap.includes("PG_PASSWORD_ENV_NAME"), bootstrap);
    assert.ok(!bootstrap.includes("OAUTH2_PROXY_SECRET_NAME"), bootstrap);
    // No reservation: the other two containers sum to the task exactly, and
    // this one lives for seconds. A `cpu:`/`memory:` here is the sum exceeding
    // the task at apply time.
    assert.ok(!bootstrap.includes("cpu: "), bootstrap);
    assert.ok(!bootstrap.includes("memory: "), bootstrap);

    // ECS's `dependsOn: HEALTHY` needs an ECS health check; the image's own
    // Dockerfile HEALTHCHECK is invisible to Fargate.
    const gateway = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(gateway.includes("healthCheck: BIFROST_HEALTH_CHECK"), gateway);
    assert.deepEqual(BIFROST_HEALTH_CHECK.command, [
      "CMD-SHELL",
      `wget -q -O /dev/null ${BIFROST_API_BASE_URL}/health || exit 1`,
    ]);
    assert.ok(BIFROST_HEALTH_CHECK.retries >= 3);
    assert.ok(BIFROST_HEALTH_CHECK.startPeriod >= 15);
  });

  it("gives the sidecar the plan's Google settings, derived not copied", () => {
    assert.equal(OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_PROVIDER, "google");
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE,
      OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
    );
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_UPSTREAMS,
      `http://127.0.0.1:${BIFROST_PORT}`,
    );
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_HTTP_ADDRESS,
      `0.0.0.0:${OAUTH2_PROXY_PORT}`,
    );
    // The callback and the cookie domain follow the ingress hostname, so a
    // hostname change cannot leave the Google client pointing at the old one.
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_REDIRECT_URL,
      `https://${BIFROST_HOSTNAME}/oauth2/callback`,
    );
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_WHITELIST_DOMAINS,
      BIFROST_HOSTNAME,
    );
    assert.equal(OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_REVERSE_PROXY, "true");
    assert.equal(OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_COOKIE_SECURE, "true");
    assert.equal(OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_COOKIE_SAMESITE, "lax");
    assert.equal(OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_COOKIE_EXPIRE, "168h");
    assert.equal(OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_COOKIE_REFRESH, "1h");
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_SKIP_PROVIDER_BUTTON,
      "true",
    );
    // ECS environment values are strings, so every one of these is too.
    for (const value of Object.values(OAUTH2_PROXY_ENVIRONMENT)) {
      assert.equal(typeof value, "string");
    }
    // The allowlist is a file, never an inline value: the stock image has no
    // inline flag, which is the reason the derived image exists at all.
    assert.ok(
      !("OAUTH2_PROXY_AUTHENTICATED_EMAILS" in OAUTH2_PROXY_ENVIRONMENT),
    );
    const sidecar = containerDefinitionBlock("OAUTH2_PROXY_CONTAINER_NAME");
    assert.ok(
      sidecar.includes("Object.entries(OAUTH2_PROXY_ENVIRONMENT)"),
      sidecar,
    );
  });

  it("fits both containers' reservations inside the task, with no growth", () => {
    // Fargate refuses a task whose container reservations exceed the task's
    // cpu/memory. The sidecar's share comes out of the single container's
    // former whole-task reservation rather than raising the task size, which
    // is item 8's and stays at 0.5 vCPU / 1 GB.
    assert.equal(
      BIFROST_CONTAINER_CPU + OAUTH2_PROXY_CONTAINER_CPU,
      Number(TASK_CPU),
    );
    assert.equal(
      BIFROST_CONTAINER_MEMORY + OAUTH2_PROXY_CONTAINER_MEMORY,
      Number(TASK_MEMORY),
    );
    assert.ok(BIFROST_CONTAINER_CPU > OAUTH2_PROXY_CONTAINER_CPU);
    assert.ok(BIFROST_CONTAINER_MEMORY > OAUTH2_PROXY_CONTAINER_MEMORY);

    const gateway = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(gateway.includes("cpu: BIFROST_CONTAINER_CPU"), gateway);
    assert.ok(gateway.includes("memory: BIFROST_CONTAINER_MEMORY"), gateway);

    // The sum above runs on the exported constants, so it proves nothing about
    // what the sidecar ships unless the definition actually uses them: a
    // hardcoded `cpu: 64`, or no reservation at all, would pass the sums.
    const sidecar = containerDefinitionBlock("OAUTH2_PROXY_CONTAINER_NAME");
    assert.ok(
      sidecar.includes("cpu: OAUTH2_PROXY_CONTAINER_CPU,"),
      "the sidecar must take its cpu from OAUTH2_PROXY_CONTAINER_CPU",
    );
    assert.ok(
      sidecar.includes("memory: OAUTH2_PROXY_CONTAINER_MEMORY,"),
      "the sidecar must take its memory from OAUTH2_PROXY_CONTAINER_MEMORY",
    );
  });

  it("resolves the log group name before building the containers", () => {
    // An Output read inside an `apply` callback is not resolved for you: the
    // callback's return value is taken as-is and `JSON.stringify` throws
    // "Calling [toJSON] on an [Output<T>] is not supported", so the apply would
    // fail at the task definition. The fix is to list it as an input of the
    // surrounding `pulumi.all`, and this pins that it is not read again
    // inside the builder.
    const builder = containerBlock();
    assert.ok(builder.includes("pulumi"), builder);
    assert.ok(builder.includes("logGroup.name"), builder);
    assert.ok(builder.includes("imageUri"), builder);
    assert.ok(
      builder.includes("resolvedOauth2ProxyImage"),
      "the sidecar image must be resolved through pulumi.all too",
    );
    assert.ok(
      builder.includes("resolvedBootstrapImage"),
      "the claim image must be resolved through pulumi.all too",
    );
    assert.ok(
      !builder.includes('"awslogs-group": logGroup.name'),
      "the log group name must be resolved through pulumi.all, not read in apply",
    );
    assert.ok(builder.includes("resolvedLogGroupName"));
  });

  it("stops the old task before starting the new one during a deploy", () => {
    // ECS defaults are maximumPercent 200 / minimumHealthyPercent 100, which
    // with desiredCount 1 lets a rolling update run two tasks at once. OSS
    // Bifrost is single-node (it keeps provider configs, keys, budgets and
    // usage in memory and does not re-read them) and runs store migrations at
    // startup, so an overlapping pair is a state divergence and a migration
    // race, not just double cost.
    assert.equal(DEPLOYMENT_MINIMUM_HEALTHY_PERCENT, 0);
    assert.equal(DEPLOYMENT_MAXIMUM_PERCENT, 100);

    // Spelled the way the Pulumi provider spells them: the ECS API's
    // `deploymentConfiguration` block is the deployment *strategy* in
    // @pulumi/aws v7, and the two bounds are top-level arguments.
    const service = resourceBlock("bifrostService");
    assert.ok(
      service.includes(
        "deploymentMinimumHealthyPercent: DEPLOYMENT_MINIMUM_HEALTHY_PERCENT",
      ),
      service,
    );
    assert.ok(
      service.includes(
        "deploymentMaximumPercent: DEPLOYMENT_MAXIMUM_PERCENT",
      ),
      service,
    );
    // The cap is what makes stop-before-start: never above desiredCount.
    assert.ok(DEPLOYMENT_MAXIMUM_PERCENT <= 100);
  });

  it("is one task, in a cluster with container insights", () => {
    const service = resourceBlock("bifrostService");
    assert.ok(service.includes("desiredCount: 1"), service);
    assert.ok(service.includes('launchType: "FARGATE"'), service);
    // OSS Bifrost is single-node; a second task is not a valid topology.
    assert.ok(
      !/desiredCount:\s*(BIFROST_|TASK_|[2-9])/.test(service),
      "the service must run exactly one task",
    );
    // Nothing autoscales it, which would be a second task by another name.
    assert.ok(!ECS_SOURCE.includes("aws.appautoscaling"), ECS_SOURCE);

    assert.equal(BIFROST_CLUSTER_NAME, "bifrost");
    const cluster = resourceBlock("bifrostCluster");
    assert.ok(
      cluster.includes('settings: [{ name: "containerInsights", value: "enabled" }]'),
      "the cluster must enable container insights",
    );
  });

  it("names the pinned images from the mirror stores, not floating tags", () => {
    assert.ok(ECS_SOURCE.includes("${repositoryUrl}:${BIFROST_UPSTREAM_TAG}"));
    // The Bifrost pin itself lives in bifrost-image.ts and is asserted there.
    assert.equal(BIFROST_UPSTREAM_TAG, "v2.3.0");
    assert.ok(ECS_SOURCE.includes('cpuArchitecture: "X86_64"'));
    // The sidecar's tag is content-addressed on the allowlist, so it comes
    // from oauth2-proxy-image.ts rather than a literal in the task definition.
    assert.ok(
      ECS_SOURCE.includes("${oauth2ProxyRepositoryUrl}:${OAUTH2_PROXY_TAG}"),
    );
    assert.ok(OAUTH2_PROXY_TAG.startsWith("v7.15.5-"));
    assert.match(OAUTH2_PROXY_TAG, /^v7\.15\.5-[0-9a-f]{12}$/);
  });

  it("injects the reviewed config.json as BIFROST_CONFIG from an SSM parameter", () => {
    // Phase 2 item 10's second half. Before this, the container started with
    // "config file not found at path: /app/data/config.json, initializing with
    // default values": a default SQLite config store (so no admin account
    // survived a task replacement), inference auth not enforced, and the
    // governance block inert.
    assert.equal(BIFROST_CONFIG_ENV_NAME, "BIFROST_CONFIG");
    assert.equal(BIFROST_CONFIG_PARAMETER_NAME, "/bifrost/config");
    // SSM rejects a hierarchical name that is not fully qualified, and the
    // rejection is a ValidationException at apply time rather than a preview
    // diff, so the leading slash is pinned here rather than discovered in a
    // deploy.
    assert.ok(
      BIFROST_CONFIG_PARAMETER_NAME.startsWith("/"),
      "an SSM parameter name containing a slash must be fully qualified",
    );

    // The parameter's value is the repo's own file, read at deploy time, so
    // the deployed configuration is the reviewed one and cannot drift.
    assert.ok(
      BIFROST_CONFIG_SOURCE_PATH.endsWith("bifrost/config.json"),
      BIFROST_CONFIG_SOURCE_PATH,
    );
    assert.equal(
      readBifrostConfig(),
      BIFROST_CONFIG_SOURCE,
      "the injected value must be exactly the reviewed config.json",
    );
    const parameterBlock = resourceBlock("bifrostConfigParameter");
    assert.ok(parameterBlock.includes("type: \"String\""), parameterBlock);
    assert.ok(parameterBlock.includes("value: readBifrostConfig()"), parameterBlock);
    assert.ok(
      !parameterBlock.includes("SecureString"),
      "a SecureString would need a KMS decrypt grant on a file that holds no secret",
    );

    // The container gets it as a `secrets` entry resolved by the ECS agent.
    const bifrostBlock = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(
      bifrostBlock.includes("name: BIFROST_CONFIG_ENV_NAME") &&
        bifrostBlock.includes("valueFrom: configParameterArn"),
      `the gateway container does not inject BIFROST_CONFIG\n${bifrostBlock}`,
    );

    // And the role that resolves it may read exactly that parameter.
    assert.deepEqual([...EXECUTION_PARAMETER_ACTIONS], ["ssm:GetParameters"]);    const policy = executionRoleConfigParameterPolicyDocument([
      "arn:aws:ssm:us-west-2:024901689212:parameter/bifrost/config",
    ]);
    assert.equal(policy.Statement[0].Action[0], "ssm:GetParameters");
    assert.equal(
      policy.Statement[0].Resource[0],
      "arn:aws:ssm:us-west-2:024901689212:parameter/bifrost/config",
    );
    assert.ok(
      !JSON.stringify(policy).includes("*"),
      "the config parameter grant must not wildcard",
    );
    const roleBlock = resourceBlock("bifrostExecutionRole");
    assert.ok(
      roleBlock.includes("configParameter.arn.apply"),
      "the execution role is not granted read on the config parameter",
    );
  });

  it("rolls the task when config.json changes, not only when its ARN does", () => {
    // The ARN is stable across value changes, so a `secrets` entry alone leaves
    // every running task on the config it booted with: a merged `config.json`
    // PR would update the parameter and change nothing that is running. The
    // parameter's version increments on each value change, so carrying it as an
    // environment value registers a new task-definition revision and the
    // service's stop-before-start rollout picks the new file up.
    assert.equal(BIFROST_CONFIG_VERSION_ENV_NAME, "BIFROST_CONFIG_VERSION");
    assert.ok(
      ECS_SOURCE.includes("configParameter.version.apply(String)"),
      "the task definition must depend on the parameter's version, not only its ARN",
    );
    const bifrostBlock = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(
      bifrostBlock.includes("name: BIFROST_CONFIG_VERSION_ENV_NAME") &&
        bifrostBlock.includes("value: configParameterVersion"),
      `the gateway container does not carry the config version\n${bifrostBlock}`,
    );
    // The value comes from the parameter resource, so the dependency edge is
    // real rather than a constant that never changes.
    assert.ok(
      containerBlock().includes("configParameterVersion,"),
      "the version must be destructured out of the pulumi.all above the containers",
    );
  });

  it("writes the injected config to the file upstream reads, then execs its entry point", () => {
    // Upstream's ECS guide's own shape: ECS has no init container here, so the
    // write happens in the container's entry point and the image's entry point
    // still ends up as PID 1.
    assert.equal(BIFROST_CONFIG_FILE_PATH, "/app/data/config.json");
    assert.deepEqual([...BIFROST_CONTAINER_ENTRY_POINT], ["/bin/sh", "-c"]);
    assert.equal(BIFROST_CONTAINER_COMMAND.length, 1);
    const command = BIFROST_CONTAINER_COMMAND[0];
    assert.ok(
      command.includes("$BIFROST_CONFIG"),
      `the command does not read the injected variable: ${command}`,
    );
    assert.ok(
      command.includes("> /app/data/config.json"),
      `the command does not write the file Bifrost reads: ${command}`,
    );
    assert.ok(
      command.trimEnd().endsWith("exec /app/docker-entrypoint.sh /app/main"),
      `the command must hand off to the image's entry point: ${command}`,
    );
    // A task with no injected config must fail rather than start on defaults,
    // which is the state this whole change exists to end.
    assert.ok(
      command.includes("exit 1"),
      `the command must fail closed when the config is missing: ${command}`,
    );
    const bifrostBlock = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(
      bifrostBlock.includes("entryPoint: [...BIFROST_CONTAINER_ENTRY_POINT]") &&
        bifrostBlock.includes("command: [...BIFROST_CONTAINER_COMMAND]"),
      `the gateway container does not use the config-writing entry point\n${bifrostBlock}`,
    );
    // The sidecar and the claim container keep the images' own entry points.
    for (const name of [
      "OAUTH2_PROXY_CONTAINER_NAME",
      "BIFROST_BOOTSTRAP_CONTAINER_NAME",
    ]) {
      assert.ok(
        !containerDefinitionBlock(name).includes("entryPoint:"),
        `${name} must not inherit the gateway's entry point`,
      );
    }
  });

  it("takes its plain environment variables from the network and database modules", () => {
    assert.equal(AWS_REGION_ENV_NAME, "AWS_REGION");
    const block = containerBlock();
    assert.ok(
      block.includes("{ name: AWS_REGION_ENV_NAME, value: REGION }"),
      block,
    );
    // Every plain name the gateway sees is declared here rather than spelled
    // in config.json, so a change to one is a change to this module.
    assert.deepEqual(
      [...GATEWAY_PLAIN_ENV_NAMES],
      [
        AWS_REGION_ENV_NAME,
        PG_HOST_ENV_NAME,
        PG_PORT_ENV_NAME,
        PG_USER_ENV_NAME,
        PG_DATABASE_ENV_NAME,
      ],
    );
  });

  it("is wired into index.ts with the network and the database", () => {
    assert.ok(
      INDEX_SOURCE.includes("createBifrostEcs"),
      "index.ts does not create the ECS resources",
    );
    for (const arg of ["network,", "database,", "ingress,"]) {
      assert.ok(
        INDEX_SOURCE.includes(`  ${arg}`),
        `index.ts does not pass ${arg} to createBifrostEcs`,
      );
    }
    assert.ok(
      INDEX_SOURCE.includes("repositoryUrl: bifrostRepository.repositoryUrl"),
      "index.ts does not pass the mirrored repository to the task definition",
    );
    assert.ok(
      INDEX_SOURCE.includes(
        "oauth2ProxyRepositoryUrl: oauth2ProxyRepository.repositoryUrl",
      ),
      "index.ts does not pass the derived oauth2-proxy repository to the task definition",
    );
    assert.ok(
      INDEX_SOURCE.includes(
        "bootstrapRepositoryUrl: bifrostBootstrapRepository.repositoryUrl",
      ),
      "index.ts does not pass the derived bootstrap repository; the claim container's image URI would be built from an undefined repository",
    );
    assert.ok(
      INDEX_SOURCE.includes("export const bifrostLogGroupName"),
      "index.ts must export the log group name for item 12",
    );
  });
});
