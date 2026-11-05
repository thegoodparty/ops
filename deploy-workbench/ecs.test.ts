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
  BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES,
  BIFROST_CONFIG_SOURCE_PATH,
  BIFROST_CONFIG_VERSION_ENV_NAME,
  BIFROST_BOOT_ONLY_PATHS,
  BIFROST_LIVE_PATHS,
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
  BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS,
  BIFROST_SERVICE_NAME,
  BIFROST_SHUTDOWN_CLEANUP_BUDGET_SECONDS,
  BIFROST_STOP_TIMEOUT_SECONDS,
  BIFROST_TASK_FAMILY,
  DEPLOYMENT_CIRCUIT_BREAKER,
  DEPLOYMENT_MAXIMUM_PERCENT,
  DEPLOYMENT_MINIMUM_HEALTHY_PERCENT,
  ECS_EXECUTION_MANAGED_POLICY_ARN,
  EXECUTION_PARAMETER_ACTIONS,
  EXECUTION_ROLE_NAME,
  EXECUTION_SECRET_ACTIONS,
  GATEWAY_PASSWORD_ENV_NAMES,
  GATEWAY_PLAIN_ENV_NAMES,
  GATEWAY_SECRET_KEYS,
  GATEWAY_SECRET_NAME,
  OAUTH2_PROXY_CONTAINER_CPU,
  OAUTH2_PROXY_CONTAINER_MEMORY,
  OAUTH2_PROXY_CONTAINER_NAME,
  OAUTH2_PROXY_COMMAND,
  OAUTH2_PROXY_ENVIRONMENT,
  OAUTH2_PROXY_GATEWAY_SECRET_KEYS,
  OAUTH2_PROXY_SECRET_KEYS,
  OAUTH2_PROXY_SECRET_NAME,
  PG_DATABASE_ENV_NAME,
  BIFROST_PG_PASSWORD_TIMEOUT_SECONDS,
  PG_HOST_ENV_NAME,
  PG_PASSWORD_ENV_NAME,
  PG_PORT_ENV_NAME,
  PG_SECRET_ARN_ENV_NAME,
  PG_USER_ENV_NAME,
  RDS_PASSWORD_JSON_KEY,
  TASK_BEDROCK_ACTIONS,
  TASK_BEDROCK_READ_ACTIONS,
  TASK_BEDROCK_READ_RESOURCES,
  TASK_SECRET_ACTIONS,
  TASK_CPU,
  TASK_MEMORY,
  TASK_ROLE_NAME,
  bifrostConfigClassificationProblems,
  bifrostConfigDigestInput,
  bifrostConfigLeafPaths,
  bifrostConfigVersion,
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
import {
  BIFROST_GATEWAY_TAG,
  BIFROST_PG_PASSWORD_CONTAINER_PATH,
} from "./pg-password-image";
import {
  BIFROST_HOSTNAME,
  TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS,
  TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS,
  TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS,
  TARGET_GROUP_HEALTHY_THRESHOLD,
  TARGET_GROUP_UNHEALTHY_THRESHOLD,
} from "./ingress";
import {
  OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH,
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

/** A parsed `config.json`, loose on purpose: the drift tests add leaves to it. */
type BifrostConfigDocument = Record<string, any>;

/**
 * The committed file, with one edit applied to the parsed document.
 *
 * Re-serialised rather than string-spliced, so an edit here is a value change
 * and nothing else. `bifrostConfigVersion` reads parsed JSON, so the whitespace
 * `JSON.stringify` produces is already not part of the digest — which one of the
 * assertions below relies on.
 */
const editedBifrostConfig = (
  edit: (document: BifrostConfigDocument) => void,
): string => {
  const document = JSON.parse(BIFROST_CONFIG_SOURCE) as BifrostConfigDocument;
  edit(document);
  return JSON.stringify(document, null, 2);
};

/** The same document with every object's keys reversed, to pin order-independence. */
const reorderedBifrostConfig = (): string => {
  const reverseKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .reverse()
          .map(([key, entry]) => [key, reverseKeys(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(
    reverseKeys(JSON.parse(BIFROST_CONFIG_SOURCE)),
    null,
    2,
  );
};
const ALPHA_CONFIG_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost/alpha-config.yaml"),
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

  it("gives the execution role the script-owned secrets and the task role Bedrock plus the database password", () => {
    // The split the step-6 change moved the database password across:
    // `password_command` runs inside the container, so the call to
    // `secretsmanager:GetSecretValue` is made with the task role. The execution
    // role still resolves the two script-owned secrets into the containers.
    const executionPolicy = executionRoleSecretsPolicyDocument([
      secretArnPattern(GATEWAY_SECRET_NAME),
      secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
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

    const rdsSecretArn = `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:rds!db-1a2b3c4d-5e6f-7890-abcd-ef1234567890`;
    const taskPolicy = taskRolePolicyDocument(bedrockInvokeResources(), [
      rdsSecretArn,
    ]);
    const taskActions = taskPolicy.Statement.flatMap((s) => s.Action);
    assert.deepEqual([...TASK_BEDROCK_ACTIONS], [
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]);
    assert.deepEqual([...TASK_BEDROCK_READ_ACTIONS], [
      "bedrock:ListFoundationModels",
    ]);
    assert.deepEqual(taskActions, [
      ...TASK_BEDROCK_ACTIONS,
      ...TASK_BEDROCK_READ_ACTIONS,
      ...TASK_SECRET_ACTIONS,
    ]);

    // The one secret action the task role holds, and the one resource it names.
    const secretStatement = taskPolicy.Statement.filter((s) =>
      s.Action.some((a) => a.startsWith("secretsmanager:")),
    );
    assert.equal(secretStatement.length, 1);
    assert.equal(secretStatement[0].Sid, "ReadDatabasePassword");
    assert.deepEqual(secretStatement[0].Action, ["secretsmanager:GetSecretValue"]);
    assert.deepEqual(secretStatement[0].Resource, [rdsSecretArn]);

    // The rest is still Bedrock, so an edit that folds a second service into an
    // existing statement fails here rather than in an AccessDenied.
    for (const statement of taskPolicy.Statement) {
      const actions = statement.Action.filter((a) => !a.startsWith("secretsmanager:"));
      assert.ok(
        actions.every((a) => a.startsWith("bedrock:")),
        `unexpected action in ${statement.Sid}`,
      );
    }
  });

  it("lets the task role list the catalog so the model list renders", () => {
    // The gateway can serve inference with only the invoke actions and still
    // show a warning where the model list should be. Bifrost's Bedrock provider
    // renders that page from a signed `GET /foundation-models`
    // (`core/providers/bedrock/bedrock.go`, `listModelsByKey` at `v2.3.0`),
    // i.e. `bedrock:ListFoundationModels`, and the role had no read at all.
    const policy = taskRolePolicyDocument(bedrockInvokeResources(), [
      `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:rds!db-x`,
    ]);
    const catalog = policy.Statement.filter((s) =>
      s.Action.includes("bedrock:ListFoundationModels"),
    );
    assert.equal(catalog.length, 1, "one statement must carry the catalog read");
    assert.deepEqual(catalog[0].Action, [...TASK_BEDROCK_READ_ACTIONS]);
    assert.equal(catalog[0].Sid, "ReadBedrockFoundationModelCatalog");

    // `ListFoundationModels` has no resource type in Bedrock's service
    // authorization reference, so the resource is `*` and nothing narrower is
    // valid. That is the only reason this role holds a wildcard.
    assert.deepEqual(catalog[0].Resource, ["*"]);
    assert.deepEqual([...TASK_BEDROCK_READ_RESOURCES], ["*"]);

    // The read is not folded into the invoke statement, whose resources are
    // the model ARNs, and nothing blanket (`bedrock:Get*`, `bedrock:List*`) is
    // granted: the provider calls this one listing and no per-model describe.
    const invoke = policy.Statement.find(
      (s) => s.Sid === "InvokeSelectedBedrockModels",
    );
    assert.ok(invoke);
    assert.deepEqual(invoke.Action, [...TASK_BEDROCK_ACTIONS]);
    assert.deepEqual(invoke.Resource, bedrockInvokeResources());
    for (const action of policy.Statement.flatMap((s) => s.Action)) {
      // `secretsmanager:GetSecretValue` contains "Get", and the database
      // password's read is exactly that one action on one ARN. Everything else
      // is the Bedrock set, where no `bedrock:Get*` is granted.
      if (action.startsWith("secretsmanager:")) continue;
      assert.ok(!action.includes("Get"), action);
      assert.ok(!/^bedrock:List(InferenceProfiles|CustomModels)/.test(action), action);
    }
  });

  it("scopes the task role to the model list, not to wildcard resources", () => {
    // The plan: "The role is scoped to the model list in
    // utils/bedrock-models.ts". Composed here from the same function
    // WorkbenchAccess uses, so adding a model there reaches the gateway too.
    const policy = taskRolePolicyDocument(bedrockInvokeResources(), [
      `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:rds!db-x`,
    ]);
    const invoke = policy.Statement.find(
      (s) => s.Sid === "InvokeSelectedBedrockModels",
    );
    assert.ok(invoke);
    const resources = invoke.Resource;
    assert.deepEqual(resources, bedrockInvokeResources());
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
    // secret name patterns on the execution role and the exact ARN item 7
    // returns for the RDS-managed master password on the task role — so the
    // no-wildcard property is exercised over the RDS ARN too, not only over the
    // two secret references.
    const rdsSecretArn = `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:rds!db-1a2b3c4d-5e6f-7890-abcd-ef1234567890`;
    const executionSecretArns = [
      secretArnPattern(GATEWAY_SECRET_NAME),
      secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
    ];
    const executionPolicy =
      executionRoleSecretsPolicyDocument(executionSecretArns);
    const taskPolicy = taskRolePolicyDocument(bedrockInvokeResources(), [
      rdsSecretArn,
    ]);

    for (const document of [executionPolicy, taskPolicy]) {
      assert.equal(document.Version, "2012-10-17");
      for (const statement of document.Statement) {
        assert.equal(statement.Effect, "Allow");
        for (const action of statement.Action) {
          assert.ok(!action.includes("*"), `wildcard action ${action}`);
        }
        assert.ok(statement.Resource.length > 0);
        // The catalog read is the one statement that may name `*`, because
        // `bedrock:ListFoundationModels` has no resource type to scope to.
        // Everything else is an enumerated ARN.
        if (statement.Sid === "ReadBedrockFoundationModelCatalog") {
          assert.deepEqual(statement.Resource, ["*"]);
          continue;
        }
        for (const resource of statement.Resource) {
          assert.notEqual(resource, "*", "a resource must not be *");
        }
      }
    }

    // The execution role's resources are the two script-owned secret ARNs it
    // grants, in the shapes the module uses: both carry the six random
    // characters Secrets Manager appends, wildcarded with `?`. Neither may
    // acquire a `*`, which is the property being pinned.
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
    for (const resource of executionResources) {
      assert.match(resource, /-\?\?\?\?\?\?$/, resource);
    }

    // The task role's one secret is the RDS-managed ARN, exactly as item 7
    // returns it: no `?` pattern, because nothing here describes the secret.
    const taskSecretResources = taskPolicy.Statement.filter((statement) =>
      statement.Action.some((action) => action.startsWith("secretsmanager:")),
    ).flatMap((statement) => statement.Resource);
    assert.deepEqual(taskSecretResources, [rdsSecretArn]);

    // The task role's invoke resources are model ARNs. They carry exactly one
    // wildcard, the region, and that is deliberate: the destination set differs
    // per model (`utils/bedrock-models.ts`), so enumerating regions fails
    // intermittently and looks identical to missing model access.
    const invokeResources =
      taskPolicy.Statement.find(
        (statement) => statement.Sid === "InvokeSelectedBedrockModels",
      )?.Resource ?? [];
    assert.equal(invokeResources.length, bedrockInvokeResources().length);
    for (const resource of invokeResources) {
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
    // The bare wildcards the module may contain: the catalog read's resource,
    // which Bedrock gives no resource type to scope, and the config path
    // allowlist's one-key wildcard (`BIFROST_PATH_ANY_KEY`, which matches a
    // provider name in `providers.*.keys[].value`) — a path segment in a
    // string comparison, not an IAM resource. Anything else is a widening, and
    // this is the assertion that keeps it to those two.
    assert.deepEqual(ECS_SOURCE.match(/"\*"/g), ['"*"', '"*"']);
    assert.ok(
      ECS_SOURCE.includes('export const TASK_BEDROCK_READ_RESOURCES = ["*"]'),
      "the wildcard must be the catalog read's resource",
    );
    assert.ok(
      ECS_SOURCE.includes('const BIFROST_PATH_ANY_KEY = "*"'),
      "the other wildcard must be the config path allowlist's key segment",
    );
    assert.ok(
      !/Resource:\s*(\[?\s*)?["']\*["']/.test(ECS_SOURCE),
      "a resource must be named rather than written as a literal wildcard",
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
    // container; the sidecar gets its own three from its own container, plus
    // the setup token from the gateway's — the value the alpha configuration
    // injects as Bifrost's setup-lock header. It never gets the gateway's
    // provider key, encryption key or admin username/password.
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
    assert.deepEqual([...OAUTH2_PROXY_GATEWAY_SECRET_KEYS], [
      "BIFROST_SETUP_TOKEN",
    ]);
    assert.ok(
      sidecar.includes("secretReference(GATEWAY_SECRET_NAME, key)"),
      "the sidecar's setup token must come from the gateway's own secret",
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
    // replacement, so a dropped reference is the SQLite regression again. The
    // password is deliberately absent: it is not an `env.` reference any more
    // (`PG_SECRET_ARN` names where it comes from, and the stores resolve it with
    // a `password_command`), and asserting it here would pin the shape step 6
    // removed.
    for (const name of ["PG_HOST", "PG_PORT", "PG_USER", "PG_DATABASE"]) {
      assert.ok(
        referenced.includes(name),
        `config.json no longer resolves env.${name}, so the stores would fall back to SQLite`,
      );
    }
    assert.ok(
      !referenced.includes("PG_PASSWORD"),
      "config.json must not reference env.PG_PASSWORD: the password is resolved per connection, not injected",
    );
  });

  it("injects the four non-secret Postgres values from the database module", () => {
    // host and port are item 7's outputs; user and database name are that
    // module's constants. Nothing here spells a connection string a second
    // time, and the password is resolved by the container rather than injected.
    assert.equal(PG_HOST_ENV_NAME, "PG_HOST");
    assert.equal(PG_PORT_ENV_NAME, "PG_PORT");
    assert.equal(PG_USER_ENV_NAME, "PG_USER");
    assert.equal(PG_DATABASE_ENV_NAME, "PG_DATABASE");
    assert.equal(PG_SECRET_ARN_ENV_NAME, "PG_SECRET_ARN");
    const block = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    for (const fragment of [
      "{ name: PG_HOST_ENV_NAME, value: databaseAddress }",
      "{ name: PG_PORT_ENV_NAME, value: databasePort }",
      "{ name: PG_USER_ENV_NAME, value: DATABASE_USERNAME }",
      "{ name: PG_DATABASE_ENV_NAME, value: DATABASE_NAME }",
      "{ name: PG_SECRET_ARN_ENV_NAME, value: databaseSecretArn }",
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

  it("resolves the database password per connection instead of injecting it", () => {
    // Step 6 of docs/bifrost-zero-downtime-deploys.md (decision 20). The body
    // used to be a `secrets` entry, `PG_PASSWORD`, `valueFrom`
    // `${databaseSecretArn}:password::`; Bifrost read it once at process start,
    // so an RDS rotation left the running gateway on the previous password and
    // every new physical connection failed with SQLSTATE 28P01.
    assert.equal(RDS_PASSWORD_JSON_KEY, "password");
    assert.equal(PG_PASSWORD_ENV_NAME, "PG_PASSWORD");
    assert.equal(PG_SECRET_ARN_ENV_NAME, "PG_SECRET_ARN");

    const block = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    // The name is gone from the gateway's secrets: no `PG_PASSWORD` entry, and
    // nothing in the container reads the secret's `password` key through the
    // ECS agent.
    assert.ok(
      !block.includes("valueFrom: `${databaseSecretArn}:${RDS_PASSWORD_JSON_KEY}::`"),
      block,
    );
    assert.ok(!block.includes("PG_PASSWORD_ENV_NAME"), block);
    // What replaced it: the ARN in the plain environment, for the
    // `password_command` the stores declare.
    assert.ok(
      block.includes("{ name: PG_SECRET_ARN_ENV_NAME, value: databaseSecretArn }"),
      block,
    );
    // The ARN is an identifier, not a credential, so it is deliberately not a
    // `secrets` entry: resolving it there would route the read through the
    // execution role, which is the identity this step takes it away from.
    const secretsBlock = block.slice(block.indexOf("secrets: ["));
    assert.ok(
      !secretsBlock.includes("PG_SECRET_ARN_ENV_NAME"),
      "the secret ARN must be plain environment, not a `secrets` entry",
    );

    // The read grant moved to the task role, which is the principal that makes
    // the call now, and it names the RDS ARN exactly.
    assert.ok(
      resourceBlock("bifrostTaskRole").includes("database.secretArn.apply"),
      "the task role must be granted read on the RDS secret",
    );
    assert.ok(
      !resourceBlock("bifrostExecutionRole").includes("database.secretArn.apply"),
      "the execution role no longer resolves the database secret; the container does",
    );
  });

  it("never declares, versions or reads a secret's value", () => {
    // The two containers are script-owned and already hold real values; a
    // Pulumi-declared `Secret` or `SecretVersion` here could replace one and
    // delete them. Nothing in this module reads a value either, which is what
    // keeps `preview` free of `secretsmanager:GetSecretValue`.
    //
    // The one `GetSecretValue` in the deployment is a string in a policy
    // document's `Action` (`TASK_SECRET_ACTIONS`), never a call: the CLI call
    // is in `bifrost/pg-password.sh`, which runs inside the container.
    for (const forbidden of [
      "new aws.secretsmanager.Secret(",
      "aws.secretsmanager.SecretVersion",
      "aws.secretsmanager.getSecret",
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
    // The setup token from `bifrost/gateway`, and nothing else from it: the
    // baked alpha configuration injects exactly that as the header Bifrost's
    // setup lock reads. The provider key, the encryption key and the admin
    // username/password stay with the gateway and the claim container.
    assert.ok(
      sidecar.includes("OAUTH2_PROXY_GATEWAY_SECRET_KEYS.map"),
      sidecar,
    );
    assert.ok(
      sidecar.includes("secretReference(GATEWAY_SECRET_NAME, key)"),
      sidecar,
    );
    assert.deepEqual([...OAUTH2_PROXY_GATEWAY_SECRET_KEYS], [
      "BIFROST_SETUP_TOKEN",
    ]);
    for (const key of OAUTH2_PROXY_GATEWAY_SECRET_KEYS) {
      assert.ok(
        (GATEWAY_SECRET_KEYS as readonly string[]).includes(key),
        `${key} is not one of the gateway container's injected secrets`,
      );
    }
    for (const key of [
      "FIREWORKS_API_KEY",
      "BIFROST_ENCRYPTION_KEY",
      "BIFROST_ADMIN_USERNAME",
      "BIFROST_ADMIN_PASSWORD",
    ]) {
      assert.ok(
        !(OAUTH2_PROXY_GATEWAY_SECRET_KEYS as readonly string[]).includes(key),
        `the sidecar must not receive ${key}`,
      );
    }
    // The database password and AWS configuration stay out: the sidecar is a
    // Google OAuth proxy, not an AWS client.
    assert.ok(!sidecar.includes("PG_PASSWORD_ENV_NAME"), sidecar);
    assert.ok(!sidecar.includes("AWS_REGION_ENV_NAME"), sidecar);
    // Essential, so a proxy that cannot start takes the task with it instead
    // of leaving a gateway with an admin surface that has no door.
    assert.ok(sidecar.includes("essential: true"), sidecar);
  });

  it("loads the baked alpha configuration so the setup token is injected", () => {
    // The flag is what loads the provider, the upstreams, the listen address
    // and `injectRequestHeaders`. Without it oauth2-proxy has none of them at
    // this tag and refuses to start, which is the state this change relies on
    // rather than a silently unconfigured door.
    assert.deepEqual([...OAUTH2_PROXY_COMMAND], [
      `--alpha-config=${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
    ]);

    const sidecar = containerDefinitionBlock("OAUTH2_PROXY_CONTAINER_NAME");
    assert.ok(sidecar.includes("command: [...OAUTH2_PROXY_COMMAND]"), sidecar);
    // The image's entrypoint is upstream's own; an entryPoint override here
    // would be a second thing to maintain for no behavior.
    assert.ok(!sidecar.includes("entryPoint:"), sidecar);

    // The value itself is never configuration: it arrives as a secret from
    // `bifrost/gateway`, so the alpha file's `fromEnv` reads the same value
    // the gateway and the claim container get. A static value in the
    // environment would be a second copy that can drift.
    assert.ok(!("BIFROST_SETUP_TOKEN" in OAUTH2_PROXY_ENVIRONMENT));

    // The alpha configuration is baked by the image, so the port it listens on
    // and the upstream it proxies to have to be the ports `network.ts` gives
    // the containers and the ALB target groups. The literal is in the YAML
    // because that is what runs; this is the pin that keeps it honest.
    assert.ok(
      ALPHA_CONFIG_SOURCE.includes(`bindAddress: 0.0.0.0:${OAUTH2_PROXY_PORT}`),
      ALPHA_CONFIG_SOURCE,
    );
    assert.ok(
      ALPHA_CONFIG_SOURCE.includes(
        `uri: http://127.0.0.1:${BIFROST_PORT}`,
      ),
      ALPHA_CONFIG_SOURCE,
    );
    // And it is the only place they are stated: the same settings as removed
    // options would be silently ignored under `--alpha-config`, which is the
    // failure this test is here to prevent.
    for (const removed of [
      "OAUTH2_PROXY_PROVIDER",
      "OAUTH2_PROXY_UPSTREAMS",
      "OAUTH2_PROXY_HTTP_ADDRESS",
      "OAUTH2_PROXY_SET_XAUTHREQUEST",
      "OAUTH2_PROXY_PASS_USER_HEADERS",
    ]) {
      assert.ok(
        !(removed in OAUTH2_PROXY_ENVIRONMENT),
        `${removed} is removed when --alpha-config is used and would be ignored; its value belongs in bifrost/alpha-config.yaml`,
      );
    }
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
    // The first boot after a config change migrates the store: 23.1s was
    // measured, so the start period has to leave room for a slower one.
    assert.equal(BIFROST_HEALTH_CHECK.startPeriod, 90);
  });

  it("gives the sidecar the plan's Google settings, derived not copied", () => {
    // The provider moved into the alpha configuration (removed option under
    // `--alpha-config`); this is the environment that still configures the
    // proxy around it.
    assert.equal(
      OAUTH2_PROXY_ENVIRONMENT.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE,
      OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
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

  it("gives the gateway 120 seconds to shut down, outlasting its drain and its cleanup", () => {
    // Unset, ECS applies its default of 30 seconds and `SIGKILL`s the container
    // at it. After `SIGTERM` the process drains HTTP first — `fasthttp`'s
    // `Shutdown` waits for open connections with no deadline of its own — and
    // then waits up to 30 seconds for its cleanup, whose last act is the final
    // governance budget dump. The container's own budget is therefore
    // "however long the drain takes plus up to 30s", and a `stopTimeout` of 30
    // overlaps it: the dump races the deadline that kills it. The dump is the
    // write a deploy cannot lose, so the stop timeout is Fargate's maximum.
    const block = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    // `containerDefinitions` is one `pulumi.jsonStringify` string typed by ECS,
    // not by the Pulumi provider, so a misspelt key here is not a compile
    // error; this textual assertion is what keeps it honest.
    assert.match(
      block,
      /\n\s*stopTimeout: BIFROST_STOP_TIMEOUT_SECONDS,/,
      `the gateway container does not set a stopTimeout\n${block}`,
    );
    // 120 is the ceiling Fargate accepts, so it is not a number to raise.
    assert.equal(BIFROST_STOP_TIMEOUT_SECONDS, 120);
    // It has to outlast the cleanup budget the process gives itself (30s) plus
    // the connection drain it does first, which is the target group's
    // deregistration delay here.
    assert.ok(
      BIFROST_STOP_TIMEOUT_SECONDS >
        BIFROST_SHUTDOWN_CLEANUP_BUDGET_SECONDS +
          TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS,
      "the stop timeout must outlast the drain and the cleanup, not equal them",
    );
    // The sidecar and the claim container are not the process doing the dump.
    for (const name of [
      "OAUTH2_PROXY_CONTAINER_NAME",
      "BIFROST_BOOTSTRAP_CONTAINER_NAME",
    ]) {
      assert.ok(
        !containerDefinitionBlock(name).includes("stopTimeout:"),
        `${name} must not carry the gateway's stop timeout`,
      );
    }
  });

  it("rolls a failed deployment back to the previous revision", () => {
    // Absent, a revision that cannot become healthy sits at running 0 /
    // desired 1 until a human notices; `scripts/verify-service.ts` turns that
    // into a red run but cannot roll anything back. With the breaker on, ECS
    // stops the deployment and returns the service to the last revision that
    // completed successfully, which still points at a database that is still
    // there.
    const service = resourceBlock("bifrostService");
    assert.ok(
      service.includes(
        "deploymentCircuitBreaker: DEPLOYMENT_CIRCUIT_BREAKER",
      ),
      `the service does not enable the deployment circuit breaker\n${service}`,
    );
    // `@pulumi/aws` types this block, both fields required, so this is a
    // resource assertion rather than a textual one: a missing or misspelt
    // field is a compile error at the resource, not a silent omission.
    assert.deepEqual(DEPLOYMENT_CIRCUIT_BREAKER, {
      enable: true,
      rollback: true,
    });
  });

  it("does not replace a task whose ALB checks have not passed yet", () => {
    // The ALB starts failing its target-group check on a replacement task
    // before the process answers, because `/health` is served by the process and
    // the process is in its store migrations. Three failures at a 10s interval
    // is roughly 30 seconds in, well inside the boot the container's start
    // period covers, and the container check cannot stop ECS acting on it. With
    // the ECS default grace period of 0 the service stops the task there, and
    // being stop-before-start it then runs the same migrations again from the
    // beginning. So the grace period is set, and the resource must carry it.
    const service = resourceBlock("bifrostService");
    assert.ok(
      service.includes(
        "healthCheckGracePeriodSeconds: BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS",
      ),
      service,
    );

    // Derived from the two windows it has to clear, not a number of its own:
    // the container check's whole tolerance — its start period plus the retries
    // it still allows afterwards — and then the ALB's promotion window, because
    // the grace clock starts at RUNNING while the two successes that promote
    // the target only begin once the process answers.
    assert.equal(BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS, 160);
    assert.equal(
      BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS,
      BIFROST_HEALTH_CHECK.startPeriod +
        BIFROST_HEALTH_CHECK.interval * BIFROST_HEALTH_CHECK.retries +
        TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS +
        TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS *
          TARGET_GROUP_HEALTHY_THRESHOLD,
    );
    // Not just the start period: the container check ignores failures for that
    // long and then allows its retries, so a boot ending inside that window is
    // one the deployment means to keep. A grace period that expired earlier
    // would let the ALB replace exactly that task.
    assert.ok(
      BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS >
        BIFROST_HEALTH_CHECK.startPeriod +
          BIFROST_HEALTH_CHECK.interval * BIFROST_HEALTH_CHECK.retries,
      "the grace period must cover the container check's whole tolerance, not only its start period",
    );
    assert.ok(
      BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS >
        TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS *
          TARGET_GROUP_UNHEALTHY_THRESHOLD,
      "the grace period must outlast the ALB declaring the booting target unhealthy",
    );
    // Still one task and still stop-before-start: the grace period delays ECS's
    // reaction to a failing check, it is not a second task to replace it with.
    assert.equal(DEPLOYMENT_MINIMUM_HEALTHY_PERCENT, 0);
    assert.equal(DEPLOYMENT_MAXIMUM_PERCENT, 100);
    assert.ok(service.includes("desiredCount: 1"), service);
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

  it("names the pinned images from the derived-image modules, not floating tags", () => {
    // The task's image is the derived gateway image (step 6, decision 20), and
    // its tag is content-addressed on the `password_command` script and its
    // Dockerfile, so it comes from `pg-password-image.ts` rather than a literal
    // in the task definition.
    assert.ok(
      ECS_SOURCE.includes("${gatewayRepositoryUrl}:${BIFROST_GATEWAY_TAG}"),
      ECS_SOURCE,
    );
    assert.match(BIFROST_GATEWAY_TAG, /^v2\.4\.0-[0-9a-f]{12}$/);
    // That tag starts from the upstream release the mirror pins, so a bump still
    // moves one version and not two.
    assert.equal(BIFROST_UPSTREAM_TAG, "v2.4.0");
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
    assert.ok(parameterBlock.includes("value: bifrostConfig,"), parameterBlock);
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

  it("carries a preview-known config version, and changes it only for a boot-only edit", () => {
    // The ARN is stable across value changes, so a `secrets` entry alone leaves
    // every running task on the config it booted with: a merged `config.json`
    // PR would update the parameter and change nothing that is running. A
    // value that changes with the file registers a new task-definition revision
    // and the service's stop-before-start rollout picks the new file up.
    //
    // The value is a digest computed from the file in this program, NOT
    // `configParameter.version`. AWS assigns the parameter's version, so a
    // preview of the apply that changes the file cannot know it: Pulumi renders
    // the entire containerDefinitions string as its unknown sentinel, the
    // pre-apply secret check has no definition to read, and the deploy stops
    // before the apply that would have rolled the task (2026-10-28, run
    // 40725087936, the merge of #393). A digest is known at preview and says
    // which config a task is running by its content rather than by a counter.
    assert.equal(BIFROST_CONFIG_VERSION_ENV_NAME, "BIFROST_CONFIG_VERSION");
    assert.equal(
      bifrostConfigVersion(),
      bifrostConfigVersion(BIFROST_CONFIG_SOURCE),
      "the default must be the reviewed config.json",
    );
    // The shape is unchanged from what the preflight check accepts: a
    // 12-hex-character prefix of a SHA-256.
    assert.match(bifrostConfigVersion(), /^[0-9a-f]{12}$/);
    assert.ok(
      !ECS_SOURCE.includes("configParameter.version"),
      "the parameter's version is unknown at preview; carrying it collapses containerDefinitions",
    );

    // What step 1 of `docs/bifrost-reconciler.md` changed: the digest is over
    // PARSED JSON, so whitespace, key order and a reformat are not changes.
    // Hashing the bytes answered "did the text change", which rolled the task
    // for a live edit and equally for a reformat of the whole file.
    assert.equal(
      bifrostConfigVersion(editedBifrostConfig(() => {})),
      bifrostConfigVersion(),
      "a re-serialisation of the same values must not move the digest",
    );
    assert.equal(
      bifrostConfigVersion(reorderedBifrostConfig()),
      bifrostConfigVersion(),
      "key order is not a boot-only fact, so reordering the file must not move the digest",
    );

    const bifrostBlock = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(
      bifrostBlock.includes("name: BIFROST_CONFIG_VERSION_ENV_NAME") &&
        bifrostBlock.includes("value: configVersion"),
      `the gateway container does not carry the config version\n${bifrostBlock}`,
    );
    // The dependency edge is still real: the task definition names the
    // parameter's ARN, so Pulumi finishes the parameter update first.
    assert.ok(
      containerBlock().includes("configParameter.arn,"),
      "the task definition must still depend on the parameter resource",
    );
  });

  it("classifies every leaf of config.json as boot-only or live, and both lists are real", () => {
    // The drift test decision 2 asks for. Three failures, and the asymmetry of
    // their consequences is why the first one matters most:
    //
    //   - a leaf on neither list is unclassified, and an unclassified boot-only
    //     leaf is a change that never rolls the task and never applies (silent;
    //     the `75d30ae` class of bug);
    //   - a leaf on both lists is an allowlist entry claiming something the
    //     reconciler converges live, so every edit to it restarts the task for
    //     nothing;
    //   - a rule matching no leaf is an allowlist that has rotted.
    //
    // There is deliberately no expected-path list here. The assertion is that
    // the two committed lists partition the file, so a new leaf in
    // `config.json` fails the suite until somebody classifies it.
    assert.deepEqual(
      bifrostConfigClassificationProblems(),
      [],
      "every leaf of bifrost/config.json must be classified boot-only or live, and every rule must match a leaf",
    );
    assert.ok(BIFROST_BOOT_ONLY_PATHS.length > 0);
    assert.ok(BIFROST_LIVE_PATHS.length > 0);

    // "In the digest" is asserted against the digest's own input, which is one
    // `path=value` line per boot-only leaf, so a reader can see what is
    // covered rather than having to invert a hash.
    const digestLines = bifrostConfigDigestInput().split("\n");
    assert.ok(digestLines.length > 0);
    for (const line of digestLines) {
      const at = line.slice(0, line.indexOf("="));
      assert.ok(
        bifrostConfigLeafPaths().includes(at),
        `the digest claims ${at}, which is not a leaf of the file`,
      );
    }
    for (const expected of [
      "config_store.config.host=",
      "config_store.enabled=",
      "config_store.config.password_command.command=",
      "logs_store.retention_days=",
      "logs_store.config.max_open_conns=",
      "encryption_key=",
      "setup_token=",
      "providers.fireworks.keys[0].value=",
      "providers.bedrock.keys[0].value=",
      "source_of_truth=",
    ]) {
      assert.ok(
        digestLines.some((line) => line.startsWith(expected)),
        `the boot-only digest is missing ${expected}\n${bifrostConfigDigestInput()}`,
      );
    }
    // The live half, spot-checked against one line per class the plan's table
    // puts on the live side. None of these may appear in the digest.
    for (const excluded of [
      "$schema=",
      "client.",
      "governance.",
      "providers.fireworks.network_config.",
      "providers.bedrock.prompt_cache.",
      "providers.fireworks.keys[0].models",
      "providers.fireworks.keys[0].aliases.",
      "providers.fireworks.keys[0].weight=",
      "providers.fireworks.keys[0].name=",
      "providers.bedrock.keys[0].bedrock_key_config.",
    ]) {
      assert.ok(
        !digestLines.some((line) => line.startsWith(excluded)),
        `${excluded} is converged live and must not be in the digest`,
      );
    }
  });

  it("registers no new digest for a provider metadata, alias or model-catalog edit", () => {
    // The first visible evidence the split is real (success criterion 1): these
    // are exactly the edits that used to roll the task, and that
    // `docs/bifrost-reconciler.md` exists to stop rolling it. Every one of them
    // is in the plan's "Live" column.
    const before = bifrostConfigVersion();
    const edits: Array<[string, (doc: BifrostConfigDocument) => void]> = [
      [
        "provider network_config.base_url",
        (doc) => {
          doc.providers.fireworks.network_config.base_url =
            "https://us.api.fireworks.ai/inference/v1";
        },
      ],
      [
        "provider key models (the model catalog)",
        (doc) => {
          doc.providers.bedrock.keys[0].models = [
            "us.anthropic.claude-sonnet-5-5",
          ];
        },
      ],
      [
        "provider key aliases: the model_id an alias points at",
        (doc) => {
          doc.providers.fireworks.keys[0].aliases["worker-default"].model_id =
            "accounts/fireworks/routers/another-router";
        },
      ],
      [
        "provider key aliases: a whole new alias",
        (doc) => {
          doc.providers.fireworks.keys[0].aliases["new-alias"] = {
            model_id:
              "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
            model_name:
              "accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
          };
        },
      ],
      [
        "provider key weight",
        (doc) => {
          doc.providers.fireworks.keys[0].weight = 7;
        },
      ],
      [
        "provider prompt cache",
        (doc) => {
          doc.providers.bedrock.prompt_cache.auto_inject = false;
        },
      ],
      [
        "client config",
        (doc) => {
          doc.client.log_retention_days = 30;
        },
      ],
      [
        "governance auth config",
        (doc) => {
          doc.governance.auth_config.is_enabled = true;
        },
      ],
    ];

    for (const [what, edit] of edits) {
      assert.equal(
        bifrostConfigVersion(editedBifrostConfig(edit)),
        before,
        `${what} is converged live and must not register a new task-definition revision`,
      );
    }
  });

  it("registers a new digest for a store, key-value, encryption, setup-token or source-of-truth edit", () => {
    // Success criterion 4: a boot-only edit still rolls the task. This is the
    // direction whose failure is silent, so each class gets its own case rather
    // than one shared "something changed" assertion.
    const before = bifrostConfigVersion();
    const edits: Array<[string, (doc: BifrostConfigDocument) => void]> = [
      [
        "config_store connection detail",
        (doc) => {
          doc.config_store.config.max_open_conns = 51;
        },
      ],
      [
        "a logs_store leaf outside the connection block",
        (doc) => {
          doc.logs_store.retention_days = 30;
        },
      ],
      [
        "logs_store password_command timeout",
        (doc) => {
          doc.logs_store.config.password_command.timeout = "45s";
        },
      ],
      [
        "encryption_key",
        (doc) => {
          doc.encryption_key = "env.SOME_OTHER_ENCRYPTION_KEY";
        },
      ],
      [
        "setup_token",
        (doc) => {
          doc.setup_token = "env.SOME_OTHER_SETUP_TOKEN";
        },
      ],
      [
        "providers.*.keys[].value",
        (doc) => {
          doc.providers.fireworks.keys[0].value =
            "env.ROTATED_FIREWORKS_API_KEY";
        },
      ],
      [
        "providers.*.keys[].value, where the value was the empty string",
        (doc) => {
          doc.providers.bedrock.keys[0].value = "env.SOMETHING";
        },
      ],
      [
        "source_of_truth",
        (doc) => {
          doc.source_of_truth = "database";
        },
      ],
    ];

    for (const [what, edit] of edits) {
      assert.notEqual(
        bifrostConfigVersion(editedBifrostConfig(edit)),
        before,
        `${what} is read at boot and must register a new task-definition revision`,
      );
    }
  });

  it("tells keys[].value apart from keys[].aliases in the same array entry", () => {
    // The reason the allowlist is a list of paths and not of top-level keys, and
    // the case open item 1 names as the first to pin: `providers` is a mixed
    // section. A key list cannot say "roll on `keys[].value`, converge on
    // `keys[].aliases`": with `providers` on the list an alias edit rolls the
    // task and the plan is decorative, and with `providers` off it a key-value
    // change never applies.
    const valueEdit = editedBifrostConfig((doc) => {
      doc.providers.fireworks.keys[0].value = "env.ROTATED_FIREWORKS_API_KEY";
    });
    const aliasEdit = editedBifrostConfig((doc) => {
      doc.providers.fireworks.keys[0].aliases["worker-default"].description =
        "a different description for the same target";
    });

    // Both edits touch the same object in the same array; only one is boot-only.
    assert.notEqual(
      bifrostConfigVersion(valueEdit),
      bifrostConfigVersion(),
      "a provider key's value is resolved by the task at boot, so it must roll the task",
    );
    assert.equal(
      bifrostConfigVersion(aliasEdit),
      bifrostConfigVersion(),
      "an alias in the same key entry converges live, so it must not roll the task",
    );
  });

  it("fails the drift test on an unclaimed leaf, an overlap, and a stale entry", () => {
    // A drift test that only passes on the happy path is not a drift test. Each
    // failure is provoked here with a deliberately broken input, so the
    // assertions above are known to be load-bearing rather than vacuous.
    const unclassified = editedBifrostConfig((doc) => {
      doc.governance.brand_new_leaf = { enabled: true };
    });
    // `governance` is a live subtree, so a new leaf under it is classified by
    // the subtree rule and is not a problem. That is asserted, because a
    // subtree rule that quietly stopped matching would otherwise only show up
    // as an unclaimed leaf in production.
    assert.deepEqual(bifrostConfigClassificationProblems(unclassified), []);

    // A top-level section nobody classified, added at the root: this is the
    // shape of an upstream schema addition, and it fails.
    const unclassifiedRoot = editedBifrostConfig((doc) => {
      doc.vector_store = { enabled: true, type: "postgres" };
    });
    const rootProblems = bifrostConfigClassificationProblems(unclassifiedRoot);
    assert.ok(
      rootProblems.some(
        (problem) =>
          problem.startsWith("vector_store.enabled ") ||
          problem.startsWith("vector_store.type "),
      ),
      `a leaf neither list claims must fail the drift test:\n${rootProblems.join("\n")}`,
    );

    // A boot-only rule that claims a live leaf. This is what putting
    // `providers` on the list wholesale would look like: the "needless
    // restart" direction, cheap but wrong.
    const overlapping = bifrostConfigClassificationProblems(
      BIFROST_CONFIG_SOURCE,
      {
        bootOnly: [
          ...BIFROST_BOOT_ONLY_PATHS,
          { path: "providers.*.keys[].aliases", subtree: true },
        ],
      },
    );
    assert.ok(
      overlapping.some((problem) =>
        problem.includes(
          "providers.fireworks.keys[0].aliases.worker-default.description",
        ),
      ),
      `an entry claiming a leaf the reconciler converges live must fail:\n${overlapping.join("\n")}`,
    );

    // A stale entry: the section is gone from the file, or the name was never
    // right. Either way an allowlist nobody prunes stops describing the file.
    const stale = bifrostConfigClassificationProblems(BIFROST_CONFIG_SOURCE, {
      bootOnly: [
        ...BIFROST_BOOT_ONLY_PATHS,
        { path: "vector_store", subtree: true },
      ],
    });
    assert.ok(
      stale.some((problem) =>
        problem.includes('the boot-only path "vector_store" matches no leaf'),
      ),
      `an allowlist entry that matches no leaf must fail:\n${stale.join("\n")}`,
    );

    // A missing boot-only rule is the silent direction: the digest simply stops
    // covering a leaf that is read at boot, and the leaf's change never applies.
    const missing = bifrostConfigClassificationProblems(BIFROST_CONFIG_SOURCE, {
      bootOnly: BIFROST_BOOT_ONLY_PATHS.filter(
        (rule) => rule.path !== "setup_token",
      ),
    });
    assert.ok(
      missing.some((problem) => problem.startsWith("setup_token ")),
      `dropping a boot-only rule must fail, or that leaf changes without applying:\n${missing.join("\n")}`,
    );

    // And the wildcard is what makes `providers.*.keys[].value` cover every
    // provider and every key, rather than the two that happen to be in the file
    // today. A second key under a provider is claimed without editing a rule.
    const twoKeys = editedBifrostConfig((doc) => {
      doc.providers.fireworks.keys.push({
        name: "fireworks-secondary",
        value: "env.OTHER_FIREWORKS_API_KEY",
        models: [],
        weight: 1,
      });
    });
    assert.deepEqual(bifrostConfigClassificationProblems(twoKeys), []);
    assert.ok(
      bifrostConfigDigestInput(twoKeys).includes(
        "providers.fireworks.keys[1].value=",
      ),
      "a second key's value is boot-only without the allowlist needing an entry per key",
    );
  });

  it("keeps config.json inside the SSM standard tier, with the headroom the comments now claim", () => {
    // 4,085 bytes against the standard tier's 4 KiB, measured on 2026-11-04
    // after the Bedrock model list moved to `global.` profiles: 11 bytes of
    // headroom, not the couple of kilobytes a comment in `ecs.ts` and one in
    // `bifrost/README.md` used to claim. The number is asserted rather than
    // left to a comment, because the
    // failure mode of getting it wrong is a rejected `PutParameter` in an
    // apply that has already merged.
    assert.equal(BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES, 4096);
    const bytes = Buffer.byteLength(BIFROST_CONFIG_SOURCE, "utf8");
    assert.ok(
      bytes < BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES,
      `bifrost/config.json is ${bytes} bytes and the standard tier holds ${BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES}; past that the parameter needs tier: "Advanced"`,
    );
    // The headroom is small enough to be worth naming exactly, which is what
    // the comment block does. If this fails the comment is the stale part.
    assert.equal(
      BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES - bytes,
      11,
      "the 11-byte headroom in the ecs.ts comment block must be the measured one",
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
    // The warm is between the write and the exec; see the memory test below for
    // why it exists and what bounds it.
    assert.ok(
      command.indexOf(BIFROST_PG_PASSWORD_CONTAINER_PATH) <
        command.indexOf("exec /app/docker-entrypoint.sh /app/main"),
      `the warm must run before the process starts: ${command}`,
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
    // The password command's inputs are their own list: they are what the
    // container carries for the command, not names config.json may resolve.
    // Putting `PG_SECRET_ARN` in the list above would let a
    // `"password": "env.PG_SECRET_ARN"` pass the reference test and try to
    // authenticate with an ARN.
    assert.deepEqual([...GATEWAY_PASSWORD_ENV_NAMES], [PG_SECRET_ARN_ENV_NAME]);
    for (const name of GATEWAY_PASSWORD_ENV_NAMES) {
      assert.ok(
       !(GATEWAY_PLAIN_ENV_NAMES as readonly string[]).includes(name),
        `${name} must not be a name config.json may resolve`,
      );
    }
    assert.ok(block.includes("{ name: PG_SECRET_ARN_ENV_NAME, value: databaseSecretArn }"));
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
      INDEX_SOURCE.includes(
        "gatewayRepositoryUrl: bifrostGatewayRepository.repositoryUrl",
      ),
      "index.ts does not pass the derived gateway repository; the task would run an image with no password command",
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
    assert.ok(
      INDEX_SOURCE.includes(
        "export const bifrostGatewayRepositoryUrl",
      ),
      "index.ts must export the derived gateway image's repository, like the other derived images",
    );
  });

  it("names the password command path the derived image installs", () => {
    // The path is stated twice on purpose and the two have to agree: the
    // Dockerfile's `COPY` destination decides where the executable is, and
    // `config.json`'s `password_command.command` names it. Bifrost's
    // `validatePasswordCommand` only rejects a whitespace-split path and a
    // shell, so a wrong path is not a config error — it is a dial that fails
    // with "no such file or directory" on the first connection.
    assert.equal(
      BIFROST_PG_PASSWORD_CONTAINER_PATH,
      "/usr/local/bin/bifrost-pg-password",
    );
    assert.ok(
      !BIFROST_PG_PASSWORD_CONTAINER_PATH.includes(" "),
      "the schema's `command` pattern is ^\\S+$",
    );
    assert.ok(/^\/(usr|opt|app)\//.test(BIFROST_PG_PASSWORD_CONTAINER_PATH));
  });
});

describe("the password command's memory at boot", () => {
  /**
   * The gateway container's own limit (`BIFROST_CONTAINER_MEMORY`) was sized
   * for Bifrost alone, before the container forked anything. A cache miss now
   * forks a Python `aws-cli`, and the two stores have separate caches
   * (`postgresconn.go`: "One cache per pool"), so `singleflight` collapses a
   * burst within a pool but not across them: the first connection after boot
   * and the first after each `cache_ttl` expiry can be two forks at once.
   *
   * The numbers here are measured, not assumed:
   *
   * - One `aws secretsmanager get-secret-value` peaks at 71 MiB RSS (five runs
   *   in the build container, aarch64, warm page cache).
   * - Two concurrent invocations peak at 142 MiB summed `VmHWM` and 121 MiB
   *   summed `Pss`, so half of the second one's footprint is shared pages
   *   rather than new ones.
   * - The gateway's own high-water mark, from the service's
   *   `MemoryUtilization` (a percentage of the task's 1024 MiB), is 65.97% on
   *   2026-10-25, i.e. about 676 MiB.
   *
   * The fix is the entry point's warm below rather than a bigger task: the
   * measured concurrent figure fits inside the existing reservation, and the
   * warm keeps the expensive cold part (the interpreter and botocore import
   * faulting in from the image layer) to one serial pass before Bifrost starts
   * instead of two racing for 0.44 vCPU.
   *
   * 676 + 142 = 818 MiB of the 896 MiB limit, so the margin is 78 MiB. That is
   * the tripwire: if the gateway's peak passes ~750 MiB the reservation is what
   * needs to change, and the container will be killed before a deploy notices.
   */
  const GATEWAY_PEAK_MIB = 676;
  const PASSWORD_COMMAND_PEAK_MIB = 71;
  const CONCURRENT_PEAK_MIB = 142;

  it("fits the gateway and two concurrent password commands in its reservation", () => {
    assert.equal(CONCURRENT_PEAK_MIB, PASSWORD_COMMAND_PEAK_MIB * 2);
    assert.ok(
      GATEWAY_PEAK_MIB + CONCURRENT_PEAK_MIB <= BIFROST_CONTAINER_MEMORY,
      `the gateway's ${GATEWAY_PEAK_MIB} MiB peak plus two ${PASSWORD_COMMAND_PEAK_MIB} MiB password commands is ${
        GATEWAY_PEAK_MIB + CONCURRENT_PEAK_MIB
      } MiB, over the ${BIFROST_CONTAINER_MEMORY} MiB reservation; raise BIFROST_CONTAINER_MEMORY and TASK_MEMORY together rather than lowering this`,
    );
    // The reservation is still inside the task, which the sizing test above
    // already asserts; this only says the arithmetic above is not satisfied by
    // a value that is under what was measured.
    assert.ok(BIFROST_CONTAINER_MEMORY > GATEWAY_PEAK_MIB + CONCURRENT_PEAK_MIB);
    assert.equal(BIFROST_CONTAINER_MEMORY, 896);
  });

  it("is not relying on singleflight across the two pools", () => {
    // The reason the concurrency above is real and the warm is worth doing: the
    // cache is per pool, because `postgresconn.Open` constructs one
    // `passwordCache` per call and the two stores call it separately. Pinned as
    // a statement of what the group in the source says, so a future reader who
    // assumes "singleflight covers the two stores" finds the assumption
    // already answered here.
    const source = fs.readFileSync(
      path.resolve(__dirname, "bifrost/pg-password.sh"),
      "utf8",
    );
    assert.ok(
      source.includes("singleflight"),
      "the script's header must still explain what singleflight does and does not collapse",
    );
    // And the entry point is the only place the two-pool gap is closed, so a
    // removed warm fails here rather than only in the string assertions above.
    assert.ok(
      BIFROST_CONTAINER_COMMAND.join(" ").includes(
        BIFROST_PG_PASSWORD_CONTAINER_PATH,
      ),
      "the warm is the mitigation for the per-pool cache; without it the first connection in each pool is a concurrent fork",
    );
  });

  it("warms the command once, in the entry point, before Bifrost starts", () => {
    // The cheapest fix of the two the review named, and the reason it is the
    // cheapest: it changes no task size, so it changes no bill, and the work it
    // removes is the cold interpreter import. Done in the entry point because
    // that is the last place before Bifrost's own pools open, and ECS has no
    // init container to put it in.
    //
    // What it does not do, because the comment should not overclaim it: it
    // cannot populate Bifrost's own cache, which lives inside the process this
    // runs before. The userland is what warms, so the residual risk is a later
    // `cache_ttl` expiry producing two concurrent forks into a warm page cache.
    // The reservation arithmetic in the test above is what bounds that; the warm
    // only removes the expensive case.
    const command = BIFROST_CONTAINER_COMMAND.join(" ");
    const warmAt = command.indexOf(BIFROST_PG_PASSWORD_CONTAINER_PATH);
    assert.notEqual(
      warmAt,
      -1,
      `the entry point must run the password command once before Bifrost starts: ${command}`,
    );
    assert.ok(
      warmAt < command.indexOf("exec /app/docker-entrypoint.sh /app/main"),
      `the warm must run before the process starts, or it races the pools it is warming for: ${command}`,
    );
    // The warm's output is discarded and its failure is swallowed. It is an
    // optimisation, so it must not become a way for a transient
    // GetSecretValue failure at boot to stop the task: `password_command`
    // failures are per connection and retried on the next dial, and a boot
    // that dies instead is the outage this whole change is against.
    assert.match(
      command,
      /bifrost-pg-password[^;]*>\/dev\/null/,
      `the warm must not print the password anywhere: ${command}`,
    );
    assert.match(
      command,
      /\|\|\s*true|;\s*timeout/,
      `a failed warm must not fail the boot: ${command}`,
    );
    assert.ok(
      !command.includes("PGPASSWORD"),
      "the warm runs the same command, not a second credential path",
    );
  });

  it("bounds the warm so a hung CLI cannot hold the boot open", () => {
    // The container's health check is what eventually replaces a task that
    // never becomes healthy, and that is 90 s of start period away. The warm is
    // given the same budget the `password_command` itself gets in
    // `bifrost/config.json`, so the worst case is the same as a slow dial
    // rather than an unbounded one.
    const command = BIFROST_CONTAINER_COMMAND.join(" ");
    assert.match(
      command,
      new RegExp(`timeout ${BIFROST_PG_PASSWORD_TIMEOUT_SECONDS} `),
      `the warm must be bounded by the password_command timeout: ${command}`,
    );
    const config = JSON.parse(fs.readFileSync(BIFROST_CONFIG_SOURCE_PATH, "utf8"));
    for (const store of ["config_store", "logs_store"] as const) {
      assert.equal(
        config[store].config.password_command.timeout,
        `${BIFROST_PG_PASSWORD_TIMEOUT_SECONDS}s`,
        "the warm's bound and config.json's timeout are the same number, so a change to one is a change to the other",
      );
    }
  });
});

describe("the task role's secret read, which replaces the old prohibition", () => {
  /**
   * This replaces the assertion that used to read
   *
   *     the task role must not read secrets: the agent does that, not Bifrost
   *
   * It was true while `PG_PASSWORD` was an ECS `secrets` entry: the agent
   * resolved the value with the execution role, and the gateway process never
   * made a Secrets Manager call. Step 6 of
   * `docs/bifrost-zero-downtime-deploys.md` moves that call into the container
   * (`password_command`), so the task role is now the principal that makes it.
   * The prohibition is replaced, not deleted, by the narrower statement it
   * becomes: exactly one secret, named by its exact ARN, one action, and
   * nothing else in the role.
   */
  const rdsSecretArn = `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:rds!db-1a2b3c4d-5e6f-7890-abcd-ef1234567890`;

  it("reads exactly one secret: the RDS-managed ARN, with no pattern and no second entry", () => {
    const policy = taskRolePolicyDocument(bedrockInvokeResources(), [
      rdsSecretArn,
    ]);
    const statements = policy.Statement.filter((statement) =>
      statement.Action.some((action) => action.startsWith("secretsmanager:")),
    );
    assert.equal(
      statements.length,
      1,
      "the task role must hold exactly one secretsmanager statement",
    );
    assert.deepEqual(statements[0].Action, ["secretsmanager:GetSecretValue"]);
    assert.deepEqual(
      statements[0].Resource,
      [rdsSecretArn],
      "the resource must be the exact ARN Pulumi returns, not a name pattern",
    );
    // No second secret sneaks in through the same statement, and the exact ARN
    // is the whole list: `secretArnPattern`'s `-??????` would authorise every
    // secret with that name, including a future one this deployment does not
    // create.
    assert.equal(statements[0].Resource.length, 1);
    assert.ok(!statements[0].Resource[0].includes("?"));
    assert.ok(!statements[0].Resource[0].includes("*"));
  });

  it("gets that one ARN from the database module, not a second description of it", () => {
    // The grant and the container's `PG_SECRET_ARN` must be the same secret.
    // Two independent descriptions of it could drift, and the drift would be an
    // AccessDenied on the first dial rather than a preview failure.
    const taskRole = resourceBlock("bifrostTaskRole");
    assert.ok(
      taskRole.includes("database.secretArn.apply"),
      "the task role's policy must be built from database.secretArn",
    );
    assert.ok(
      taskRole.includes("taskRolePolicyDocument(bedrockInvokeResources(), [") &&
        taskRole.includes("databaseSecretArn,"),
      `the task role must pass the one ARN to taskRolePolicyDocument\n${taskRole}`,
    );
    const block = containerDefinitionBlock("BIFROST_CONTAINER_NAME");
    assert.ok(
      block.includes("{ name: PG_SECRET_ARN_ENV_NAME, value: databaseSecretArn }"),
      "the command reads the same ARN the role is granted",
    );
  });

  it("still holds nothing but Bedrock beyond that one statement", () => {
    // The narrower half of the replaced assertion: the exception is a secret
    // read for the password command, and it did not become a door for anything
    // else.
    const policy = taskRolePolicyDocument(bedrockInvokeResources(), [
      rdsSecretArn,
    ]);
    const nonBedrock = policy.Statement.filter((statement) =>
      statement.Action.some((action) => !action.startsWith("bedrock:")),
    );
    assert.equal(nonBedrock.length, 1, "one statement may name a non-Bedrock service");
    assert.equal(nonBedrock[0].Sid, "ReadDatabasePassword");
    for (const action of nonBedrock[0].Action) {
      assert.ok(action.startsWith("secretsmanager:"), action);
    }
  });
});
