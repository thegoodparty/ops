import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { MANAGEMENT_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  bifrostVkReaderTrust,
  VK_READER_SESSION_NAME,
} from "../deploy/components/bifrost-vk-reader";
import { GATEWAY_SECRET_NAME, secretArnPattern, BIFROST_CONFIG_PARAMETER_NAME } from "./ecs";
import { REGION } from "./network";
import {
  GOVERNANCE_OVERRIDES_PARAMETER_NAME,
  VK_MINT_TEMPLATE_PARAMETER_NAME,
} from "./governance-parameters";
import { BIFROST_PORT } from "./network";
import { BIFROST_DISCOVERY_DNS_NAME } from "./discovery";
import {
  SETUP_TOKEN_SECRET_JSON_KEY,
  SETUP_TOKEN_SECRET_NAME,
  VK_READER_ROLE_ARN,
} from "./bifrost-vk-mint";
import {
  VK_JANITOR_FUNCTION_DESCRIPTION,
  VK_JANITOR_FUNCTION_NAME,
  VK_JANITOR_INTERVAL_MINUTES,
  VK_JANITOR_LOG_GROUP_NAME,
  VK_JANITOR_LOG_RETENTION_DAYS,
  VK_JANITOR_MEMORY_MB,
  VK_JANITOR_ROLE_DESCRIPTION,
  VK_JANITOR_RULE_DESCRIPTION,
  VK_JANITOR_NAME,
  VK_JANITOR_RESERVED_CONCURRENCY,
  VK_JANITOR_ROLE_NAME,
  VK_JANITOR_SCHEDULE_EXPRESSION,
  VK_JANITOR_TIMEOUT_SECONDS,
  RECONCILER_PARAMETERS,
  vkJanitorEnvironment,
  vkJanitorExecutionPolicy,
} from "./bifrost-vk-janitor";

/**
 * Step 5's infrastructure, pinned without standing up Pulumi, the same shape as
 * `bifrost-vk-mint.test.ts`: the literals other files depend on, and the grants
 * that are too easy to widen by accident.
 *
 * The two directions of the trust get their own test because they are two files
 * that apply asynchronously: this stack creates the role the merged
 * `bifrost-vk-reader` trust names, and this role grants itself an
 * `sts:AssumeRole` on the reader. A drift either way is an `AccessDenied` at
 * the first directory read, not an apply-time error.
 */

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost-vk-janitor.ts"),
  "utf8",
);
const CORE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost/vk-janitor-core.ts"),
  "utf8",
);
const NETWORK_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "network.ts"),
  "utf8",
);
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

const policy = () =>
  vkJanitorExecutionPolicy({
    region: REGION,
    logGroupArn: `arn:aws:logs:us-west-2:${WORKBENCH_ACCOUNT_ID}:log-group:${VK_JANITOR_LOG_GROUP_NAME}`,
  });

describe("the execution role the merged reader trust depends on", () => {
  it("is named exactly bifrost-vk-janitor, the literal step 2's trust names", () => {
    assert.equal(VK_JANITOR_NAME, "bifrost-vk-janitor");
    assert.equal(VK_JANITOR_ROLE_NAME, "bifrost-vk-janitor");
    assert.equal(VK_JANITOR_FUNCTION_NAME, "bifrost-vk-janitor");

    const trustedRoleArns = bifrostVkReaderTrust.Statement.flatMap((statement) =>
      (statement as { Condition?: { ArnEquals?: Record<string, string[]> } })
        .Condition?.ArnEquals?.["aws:PrincipalArn"] ?? [],
    );
    const expected = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/${VK_JANITOR_ROLE_NAME}`;
    assert.ok(
      trustedRoleArns.includes(expected),
      `deploy/components/bifrost-vk-reader.ts does not trust ${expected}; the first AssumeRole would be an AccessDenied`,
    );
  });

  it("grants itself sts:AssumeRole on the reader role and nothing wider", () => {
    assert.equal(
      VK_READER_ROLE_ARN,
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/bifrost-vk-reader`,
    );
    assert.ok(!VK_READER_ROLE_ARN.includes(WORKBENCH_ACCOUNT_ID));

    const assume = policy().Statement.find((s) => s.Sid === "AssumeVkReader");
    assert.ok(assume, "no AssumeVkReader statement");
    assert.deepEqual(assume.Action, ["sts:AssumeRole"]);
    assert.deepEqual(assume.Resource, [VK_READER_ROLE_ARN]);
    assert.ok(!assume.Resource.includes("*"));
  });

  it("passes VK_READER_SESSION_NAME rather than retyping the literal", () => {
    assert.equal(VK_READER_SESSION_NAME, "bifrost-vk-reader");
    assert.equal(vkJanitorEnvironment().READER_SESSION_NAME, VK_READER_SESSION_NAME);
    assert.match(SOURCE, /READER_SESSION_NAME:\s*VK_READER_SESSION_NAME,/);
    assert.doesNotMatch(SOURCE, /READER_SESSION_NAME:\s*"bifrost-vk-reader"/);
  });
});

describe("the function, its schedule and its network", () => {
  it("reaches the task by its private name on the gateway's port, not through the ALB", () => {
    const environment = vkJanitorEnvironment();
    assert.equal(
      environment.BIFROST_BASE_URL,
      `http://${BIFROST_DISCOVERY_DNS_NAME}:${BIFROST_PORT}`,
    );
    assert.equal(BIFROST_DISCOVERY_DNS_NAME, "bifrost.workbench.local");
    assert.equal(BIFROST_PORT, 8080);
    assert.doesNotMatch(environment.BIFROST_BASE_URL, /goodparty\.org/);
  });

  it("is scheduled every five minutes from a named constant (decision 4), with a timeout below the interval", () => {
    // Decision 4 of `docs/bifrost-reconciler.md`, down from the hour open item 3
    // of `bifrost-virtual-keys.md` chose. The number itself is pinned in
    // `bifrost/vk-janitor-contract.test.ts` beside the guards it has to satisfy;
    // this asserts the stack actually uses it.
    assert.equal(VK_JANITOR_INTERVAL_MINUTES, 5);
    assert.equal(VK_JANITOR_SCHEDULE_EXPRESSION, "rate(5 minutes)");
    // The expression is derived from the constant, so changing the interval
    // cannot leave the rule and the documented number disagreeing.
    assert.match(
      SOURCE,
      /scheduleExpression:\s*VK_JANITOR_SCHEDULE_EXPRESSION/,
    );
    assert.equal(VK_JANITOR_TIMEOUT_SECONDS, 120);
    assert.ok(VK_JANITOR_TIMEOUT_SECONDS < VK_JANITOR_INTERVAL_MINUTES * 60);
    // A reconcile that reads, classifies and writes must not have two runs
    // interleaved.
    assert.equal(VK_JANITOR_RESERVED_CONCURRENCY, 1);
    assert.match(SOURCE, /reservedConcurrentExecutions:\s*VK_JANITOR_RESERVED_CONCURRENCY/);
  });

  it("has one EventBridge rule, target and invoke permission", () => {
    assert.match(SOURCE, /new aws\.cloudwatch\.EventRule\(/);
    assert.match(SOURCE, /new aws\.cloudwatch\.EventTarget\(/);
    const permission = /new aws\.lambda\.Permission\(([\s\S]*?)\{ provider \}/.exec(SOURCE);
    assert.ok(permission, "no lambda:Permission for the schedule");
    assert.match(permission[1], /action:\s*"lambda:InvokeFunction"/);
    assert.match(permission[1], /principal:\s*"events\.amazonaws\.com"/);
    assert.match(permission[1], /sourceArn:\s*rule\.arn/);
  });

  /**
   * The trap the plan records: a second `aws.lambda.Permission` on one function
   * must not reuse the first's statement id. Lambda refuses a duplicate id on a
   * function's resource policy (`AddPermission`'s `ResourceConflictException`, a
   * `409`) and the apply fails with "The statement id already exists", so the
   * failure is at apply time and looks like a Pulumi problem.
   *
   * Step 4 adds the deploy's invoke, which is a same-account IAM call and needs
   * no permission resource at all, so there is still exactly one rule and one
   * permission. No permission here carries a literal `statementId`, which is why
   * the count is the assertion that matters: Pulumi derives a distinct id per
   * resource, so the only way to collide is to write one down twice, and the
   * second half of this test fails on exactly that.
   */
  it("declares one rule and one permission, and no duplicate statement id", () => {
    const rules = [...SOURCE.matchAll(/new aws\.cloudwatch\.EventRule\(/g)].length;
    const permissions = [...SOURCE.matchAll(/new aws\.lambda\.Permission\(/g)].length;
    assert.equal(rules, 1, "one rule: revocation and both convergence halves share the five-minute tick");
    assert.equal(
      permissions,
      1,
      "one permission per rule; the deploy's invoke is a same-account IAM call and needs no resource-based policy",
    );

    const ids = [...SOURCE.matchAll(/statementId:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.equal(
      new Set(ids).size,
      ids.length,
      "two permissions on one function must not share a statementId: Lambda answers a duplicate with a 409 and the apply fails",
    );
    // Today there are none, because Pulumi derives a distinct id per resource
    // and naming one would replace a live permission for no gain. The day a
    // second rule appears, this is where a copied literal shows up.
    assert.deepEqual(ids, []);
  });

  it("passes the trigger label the handler reads, on both callers", () => {
    // The rule's payload and the deploy's are the contract between the two, and
    // the handler reads `trigger` and nothing else.
    assert.match(
      SOURCE,
      /input:\s*JSON\.stringify\(\{ action: "reconcile", trigger: "schedule" \}\)/,
    );
    assert.match(
      fs.readFileSync(
        path.resolve(__dirname, "scripts/verify-convergence.ts"),
        "utf8",
      ),
      /JSON\.stringify\(\{ action: "reconcile", trigger: "deploy" \}\)/,
    );
  });

  it("is a scheduled function, not an endpoint: no Function URL and no IAM-gated URL", () => {
    // The mint's door is a Function URL; the janitor has no caller but
    // EventBridge, so it must not grow one by accident.
    assert.doesNotMatch(SOURCE, /aws\.lambda\.FunctionUrl/);
    assert.doesNotMatch(SOURCE, /authorizationType/);
    assert.match(SOURCE, /principal:\s*"events\.amazonaws\.com"/);
  });

  it("is attached to the gateway's private subnets with its own security group", () => {
    assert.match(SOURCE, /subnetIds:\s*network\.privateSubnetIds/);
    assert.match(SOURCE, /securityGroupIds:\s*\[securityGroup\.id\]/);
    assert.match(SOURCE, /name:\s*"bifrost-vk-janitor",/);
    assert.equal(VK_JANITOR_MEMORY_MB, 256);
  });

  it("adds its own 8080 ingress rule to the task security group, from its own group only", () => {
    const ingress = /new aws\.vpc\.SecurityGroupIngressRule\(\s*"bifrostTaskIngressVkJanitor",([\s\S]*?)\{ provider \}/.exec(
      SOURCE,
    );
    assert.ok(ingress, "no ingress rule on the task's group");
    const body = ingress[1];
    assert.match(body, /securityGroupId:\s*network\.taskSecurityGroup\.id/);
    assert.match(body, /fromPort:\s*BIFROST_PORT/);
    assert.match(body, /toPort:\s*BIFROST_PORT/);
    assert.match(body, /referencedSecurityGroupId:\s*securityGroup\.id/);
    // A CIDR would admit more than this function; the task group's invariant is
    // that every rule names a group.
    assert.doesNotMatch(body, /cidrIpv4/);

    // The gateway's own group description is deliberately unchanged: it is
    // ForceNew, and both Lambdas' exceptions are documented where their rules
    // are, not in a string that would replace the group.
    assert.match(
      NETWORK_SOURCE,
      /Bifrost gateway Fargate task: 8080 \(Bifrost\) and 4180 \(oauth2-proxy\) from the ALB only\./,
    );
  });

  it("egresses 8080 to the task, 443 to AWS APIs and DNS to the resolver", () => {
    assert.match(SOURCE, /fromPort:\s*BIFROST_PORT,\s*toPort:\s*BIFROST_PORT,\s*referencedSecurityGroupId:\s*network\.taskSecurityGroup\.id/);
    assert.match(SOURCE, /fromPort:\s*443,\s*toPort:\s*443,\s*cidrIpv4:\s*"0\.0\.0\.0\/0"/);
    assert.match(SOURCE, /fromPort:\s*53,\s*toPort:\s*53,\s*cidrIpv4:\s*VPC_CIDR/);
  });

  it("is wired into the stack and exports its evidence", () => {
    assert.match(INDEX_SOURCE, /createBifrostVkJanitor\(\{\s*provider,\s*network\s*\}\)/);
    assert.match(INDEX_SOURCE, /export const vkBifrostJanitorFunctionArn/);
    assert.match(INDEX_SOURCE, /export const vkBifrostJanitorScheduleRuleName/);
  });
});

/**
 * The descriptions this stack writes, against the length each service enforces.
 *
 * This exists because one of them already failed an apply. `Deploy workbench`
 * on `main` (run 41892991673, the merge of #453) died on
 *
 *     Lambda: UpdateFunctionConfiguration ValidationException:
 *     1.validation error detected: Value 'Deactivates Bifrost virtual keys ...'
 *     at 'description' failed to satisfy constraint: Member must have length
 *     less than or equal to 256
 *
 * The string was 276 characters. Nothing before the apply could see it:
 * `pulumi preview` does not apply a service's field constraints, and a
 * TypeScript type has no length, so the run that found out was the one that had
 * already moved the rule's schedule and left the stack half-migrated. So the
 * check lives here, in the suite every PR runs.
 *
 * The assertion is against the *interpolated* constant, not the source text of
 * it, which is why the two descriptions are exported from the Pulumi module
 * rather than written inline: a `SOURCE` regex would have to re-implement the
 * template substitution to know how long the apply's string is, and the number
 * that matters is the one AWS is sent.
 *
 * The table is per service on purpose. There is no single "AWS description
 * limit"; each entry names the call that enforces its number, and only
 * constraints that are written down in the API reference are here. Adding a
 * row means finding the limit first, not guessing one.
 */
describe("the descriptions stay inside the limits the services enforce", () => {
  const AWS_LIMITS: {
    what: string;
    value: string;
    max: number;
    /** The documentation the number comes from, quoted in the failure. */
    from: string;
  }[] = [
    {
      what: "the Lambda function's description",
      value: VK_JANITOR_FUNCTION_DESCRIPTION,
      max: 256,
      from: "CreateFunction/UpdateFunctionConfiguration: 'Member must have length less than or equal to 256'",
    },
    {
      what: "the EventBridge rule's description",
      value: VK_JANITOR_RULE_DESCRIPTION,
      max: 512,
      from: "events:PutRule, Description: 'Maximum length of 512'",
    },
    {
      what: "the execution role's description",
      value: VK_JANITOR_ROLE_DESCRIPTION,
      max: 1000,
      from: "iam:CreateRole, Description: 'Maximum length of 1000'",
    },
  ];

  it("keeps every one of them under its limit", () => {
    const over = AWS_LIMITS.filter((entry) => entry.value.length > entry.max).map(
      (entry) =>
        `${entry.what} is ${entry.value.length} characters, over the ${entry.max} ` +
        `that ${entry.from} allows: ${JSON.stringify(entry.value)}`,
    );
    assert.deepEqual(over, []);
  });

  it("applies the exported strings, so a longer inline copy cannot sneak past", () => {
    assert.match(SOURCE, /description:\s*VK_JANITOR_FUNCTION_DESCRIPTION/);
    assert.match(SOURCE, /description:\s*VK_JANITOR_RULE_DESCRIPTION/);
    assert.match(SOURCE, /description:\s*VK_JANITOR_ROLE_DESCRIPTION/);
  });

  /**
   * Fitting is not the same as still describing the function, and the fix for
   * a length failure must not be a sentence that lost a job. Every behaviour
   * (revocation, governance convergence, config convergence) and both triggers
   * are named in the string, so a later trim that drops one of them fails here
   * rather than in a review.
   */
  it("still names every job and both triggers it was shortened to keep", () => {
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /^Deactivates Bifrost virtual keys/);
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /owner has left the Engineers group/);
    // Governance convergence and config convergence, the two halves of the loop.
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /governance/);
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /live config/);
    // The five-minute tick and the deploy's invoke, which are the two triggers.
    assert.match(
      VK_JANITOR_FUNCTION_DESCRIPTION,
      new RegExp(`every ${VK_JANITOR_INTERVAL_MINUTES} minutes`),
    );
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /on every workbench deploy/);
    // The plan references stay, because they are what tells an operator which
    // design the sentence is true against.
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /docs\/bifrost-virtual-keys\.md/);
    assert.match(VK_JANITOR_FUNCTION_DESCRIPTION, /docs\/bifrost-reconciler\.md/);
  });
});

describe("the shared secret and the grants", () => {
  it("reads the same setup-token container the mint reads (decision 6)", () => {
    assert.equal(SETUP_TOKEN_SECRET_NAME, GATEWAY_SECRET_NAME);
    assert.equal(vkJanitorEnvironment().SETUP_TOKEN_SECRET_NAME, GATEWAY_SECRET_NAME);
    assert.equal(
      vkJanitorEnvironment().SETUP_TOKEN_SECRET_JSON_KEY,
      SETUP_TOKEN_SECRET_JSON_KEY,
    );

    const secret = policy().Statement.find((s) => s.Sid === "ReadSetupToken");
    assert.ok(secret, "no ReadSetupToken statement");
    assert.deepEqual(secret.Action, ["secretsmanager:GetSecretValue"]);
    assert.deepEqual(secret.Resource, [secretArnPattern(GATEWAY_SECRET_NAME)]);

    // One container, named through the shared constant, and nothing broader:
    // this grant reaches the gateway's encryption and Fireworks keys too (the
    // cost decision 3 records), and it must not reach a second secret.
    const secretResources = policy()
      .Statement.flatMap((s) => s.Resource)
      .filter((r) => r.includes(":secret:"));
    assert.deepEqual(secretResources, [secretArnPattern(GATEWAY_SECRET_NAME)]);
    assert.doesNotMatch(SOURCE, /VK_MINT_SECRET/);
    assert.doesNotMatch(SOURCE, /["']bifrost\/(gateway|vk-mint)["']/);
  });

  it("holds the token in the secret, never in the function's environment", () => {
    assert.deepEqual(Object.keys(vkJanitorEnvironment()).sort(), [
      "BIFROST_BASE_URL",
      "CONFIG_PARAMETER_NAME",
      "OVERRIDES_PARAMETER_NAME",
      "READER_ROLE_ARN",
      "READER_SESSION_NAME",
      "SETUP_TOKEN_SECRET_JSON_KEY",
      "SETUP_TOKEN_SECRET_NAME",
      "TEMPLATE_PARAMETER_NAME",
    ]);
    // Names of parameters, never a parameter's value or the token. The SSM
    // values are read at run time under the role, which is what makes the
    // difference between a name here and a secret here.
    assert.ok(
      !Object.values(vkJanitorEnvironment()).some((value) =>
        /token-[a-z0-9]/i.test(value),
      ),
    );
    for (const name of ["TEMPLATE_PARAMETER_NAME", "OVERRIDES_PARAMETER_NAME"] as const) {
      assert.match(vkJanitorEnvironment()[name], /^\/bifrost\//);
    }
  });

  it("grants no identitystore action, no CreateLogGroup and no KMS", () => {
    const actions = policy().Statement.flatMap((s) => s.Action);
    assert.deepEqual(actions.sort(), [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter",
      "sts:AssumeRole",
    ]);
    assert.ok(!actions.some((action) => action.startsWith("identitystore:")));
    assert.ok(!actions.includes("kms:Decrypt"));
    assert.ok(!actions.includes("logs:CreateLogGroup"));
  });

  /**
   * The reversal. Before step 3 this test asserted the opposite, because the
   * function was a revocation sweep that needed no desired state. It is now a
   * convergence loop, which cannot converge to a document it may not read, and
   * the plan names these two tests as the ones that reverse in the same PR as
   * the grant.
   */
  it("reads the three reconciler parameters by name, and nothing wider", () => {
    const statement = policy().Statement.find(
      (s) => s.Sid === "ReadReconcilerParameters",
    );
    assert.ok(statement, "no ReadReconcilerParameters statement");
    assert.deepEqual(statement.Action, ["ssm:GetParameter"]);

    // Exactly the three the plan names: the config store, the template and the
    // per-person overrides. No wildcard on the name, and no `GetParameters` or
    // `GetParametersByPath` — the plural and the path walk reach more than this
    // job has any use for.
    assert.deepEqual(
      statement.Resource.map((arn) =>
        arn.replace(/^arn:aws:ssm:[^:]+:[0-9]{12}:parameter/, ""),
      ),
      [...RECONCILER_PARAMETERS],
    );
    assert.deepEqual([...RECONCILER_PARAMETERS], [
      BIFROST_CONFIG_PARAMETER_NAME,
      VK_MINT_TEMPLATE_PARAMETER_NAME,
      GOVERNANCE_OVERRIDES_PARAMETER_NAME,
    ]);
    assert.deepEqual([...RECONCILER_PARAMETERS], [
      "/bifrost/config",
      "/bifrost/vk-mint-template",
      "/bifrost/governance-overrides",
    ]);

    const actions = policy().Statement.flatMap((s) => s.Action);
    assert.ok(!actions.includes("ssm:GetParameters"));
    assert.ok(!actions.includes("ssm:GetParametersByPath"));
    assert.ok(!actions.some((action) => /^ssm:(Put|Delete)/.test(action)));
    // The ARNs carry the stack's region, not a literal, so a region move cannot
    // leave the grant pointing at a partition that does not exist.
    assert.equal(BIFROST_CONFIG_PARAMETER_NAME, "/bifrost/config");
    for (const arn of statement.Resource) {
      assert.match(
        arn,
        new RegExp(
          `^arn:aws:ssm:${REGION}:${WORKBENCH_ACCOUNT_ID}:parameter/bifrost/`,
        ),
      );
    }
  });

  it("writes to its own log group, with a retention longer than the key window", () => {
    assert.equal(VK_JANITOR_LOG_GROUP_NAME, "/aws/lambda/bifrost-vk-janitor");
    assert.equal(VK_JANITOR_LOG_RETENTION_DAYS, 90);
    assert.match(SOURCE, /retentionInDays:\s*VK_JANITOR_LOG_RETENTION_DAYS/);
    const logs = policy().Statement.find((s) => s.Sid === "WriteOwnLogs");
    assert.ok(logs);
    assert.deepEqual(logs.Resource, [
      `arn:aws:logs:us-west-2:${WORKBENCH_ACCOUNT_ID}:log-group:${VK_JANITOR_LOG_GROUP_NAME}:*`,
    ]);
  });

  it("names its parameters rather than declaring them, and passes their names as configuration", () => {
    // The parameters are step 2's, published by `governance-parameters.ts` and
    // by `ecs.ts`; a janitor that declared them would be a second writer.
    assert.doesNotMatch(SOURCE, /aws\.ssm\.Parameter\(/);
    // The handler reads them by the names this module passes in, so the
    // environment and the grant cannot disagree about which parameter is which.
    assert.equal(
      vkJanitorEnvironment().TEMPLATE_PARAMETER_NAME,
      VK_MINT_TEMPLATE_PARAMETER_NAME,
    );
    assert.equal(
      vkJanitorEnvironment().OVERRIDES_PARAMETER_NAME,
      GOVERNANCE_OVERRIDES_PARAMETER_NAME,
    );
    assert.match(SOURCE, /TEMPLATE_PARAMETER_NAME:\s*VK_MINT_TEMPLATE_PARAMETER_NAME/);
    assert.match(SOURCE, /OVERRIDES_PARAMETER_NAME:\s*GOVERNANCE_OVERRIDES_PARAMETER_NAME/);
    // Step 4's half, and it is a parameter *name* here rather than a value: the
    // handler reads it under the role, which is what makes it a name and not a
    // secret. Asserted as one of the three the grant covers, so the environment
    // and the policy cannot disagree about which parameter it is.
    assert.equal(vkJanitorEnvironment().CONFIG_PARAMETER_NAME, BIFROST_CONFIG_PARAMETER_NAME);
    assert.match(SOURCE, /CONFIG_PARAMETER_NAME:\s*BIFROST_CONFIG_PARAMETER_NAME/);
    assert.ok((RECONCILER_PARAMETERS as readonly string[]).includes(BIFROST_CONFIG_PARAMETER_NAME));
  });
});

describe("the marker is the shared constant, not a local copy", () => {
  it("imports isManagedKeyDescription from vk-marker.ts", () => {
    assert.match(CORE_SOURCE, /import \{ isManagedKeyDescription \} from "\.\/vk-marker"/);
    assert.match(CORE_SOURCE, /isManagedKeyDescription\(key\.description\)/);
    // The literal would be a second declaration of the one string decision 5
    // says both Lambdas must match.
    assert.doesNotMatch(CORE_SOURCE, /["'`]lambda-managed/);
  });
});
