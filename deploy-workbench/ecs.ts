import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { bedrockInvokeResources } from "../utils/bedrock-models";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";
import {
  BIFROST_PORT,
  createWorkbenchNetwork,
  OAUTH2_PROXY_PORT,
  REGION,
} from "./network";
import { BIFROST_HOSTNAME } from "./ingress";
import type { BifrostIngress } from "./ingress";
import {
  OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_TAG,
} from "./oauth2-proxy-image";
import { BifrostDatabase } from "./rds";

/**
 * The Bifrost gateway's compute: the ECS cluster, the task definition, the
 * service and the CloudWatch log group, plus the two IAM roles the task needs.
 * Phase 1 item 8 of `docs/bifrost-gateway.md`, extended by item 9; "Compute:
 * ECS Fargate" and the item 8 and item 9 entries in its phased task list are
 * the requirement this file implements.
 *
 * What this module owns:
 *
 * - Owns: the ECS cluster, one Fargate task definition with two containers
 *   (Bifrost on 8080 and the oauth2-proxy sidecar on 4180), one ECS service
 *   with `desiredCount: 1` registered as a target in both ingress target
 *   groups, the `/aws/ecs/bifrost` log group, the execution role (managed ECS
 *   task-execution policy plus read on the task's secrets) and the separate
 *   task role (the Bedrock model list and nothing else).
 * - Owns since item 9: the oauth2-proxy sidecar, its three `OAUTH2_PROXY_*`
 *   secret references, and the service's two `loadBalancers` entries. The
 *   rules that make those target groups attachable are `ingress.ts`'s; this
 *   file takes the ingress object and depends on its listener rules, because
 *   ECS's `CreateService` rejects a target group that no listener or listener
 *   rule references (`InvalidParameterException: The target group with
 *   targetGroupArn ... does not have an associated load balancer`). That was
 *   the constraint that kept item 8 from registering a target at all; the
 *   rules and the registration have to land together, and they do, here.
 * - Does not own: the network, the security groups, the ALB, the target
 *   groups or the database. Those are items 5, 6 and 7, and this file consumes
 *   their exports rather than declaring a second copy of any of them. In
 *   particular there is no target group, listener or security group here.
 * - Does not own: the derived oauth2-proxy image or the allowlist baked into
 *   it. `oauth2-proxy-image.ts` pins the image and
 *   `bifrost/allowed-emails.txt` is the list; this file only names the tag and
 *   the container path the image writes the list to.
 * - Does not own: `BIFROST_CONFIG`, the SSM parameter that carries the
 *   non-secret `config.json`, or the rest of the gateway's runtime
 *   configuration. Those are item 10. **The consequence, stated plainly: the
 *   container cannot return a real `/health` until item 10 lands, so the
 *   service will not pass its target group health check before then.** That is
 *   expected and is recorded in the item 8 entry in the plan. Nothing here
 *   invents configuration to make the check green.
 * - Does not own: the two secret containers. `bifrost/gateway` and
 *   `bifrost/oauth2-proxy` were created out of band by
 *   `deploy-workbench/bifrost/fill-secrets.sh` and hold real values; declaring
 *   `aws.secretsmanager.Secret` here would put their lifecycle in Pulumi, and
 *   a replace would delete the values. This file only names them, and reads
 *   nothing from them: not the value, and not even the metadata, so `preview`
 *   needs no Secrets Manager permission at all. See `deploy/delegate-secret.ts`
 *   and `docs/pr-previews.md` step 3 for why the key list is declared in the
 *   repo instead of looked up.
 *
 * The task-definition idiom is `deploy/components/worker.ts` (documented in
 * `docs/bifrost-gateway.md` as the working example to copy): `secrets` from
 * Secrets Manager, `awslogs`, `linuxParameters.initProcessEnabled`. The
 * divergences are marked `DIFFERS:` in place, and summed up in the PR body.
 *
 * Everything takes the explicit provider this project requires. The workbench
 * stack disables the default provider (`deploy.sh`), so a resource that omits
 * `{ provider }` fails the apply rather than landing in the management account.
 */

/**
 * The network phase 1 item 5 created and the database item 7 created. Their
 * modules' return types are the shapes this file consumes, so the two cannot
 * drift from what is passed in.
 */
type WorkbenchNetwork = ReturnType<typeof createWorkbenchNetwork>;

/**
 * Names. Cluster and service names are account-unique within the region, the
 * task family is what the plan's upgrade procedure increments, and the two
 * container names are what the service's `loadBalancers` entries have to agree
 * with — so they are constants rather than strings in more than one place.
 */
export const BIFROST_CLUSTER_NAME = "bifrost";
export const BIFROST_SERVICE_NAME = "bifrost";
export const BIFROST_TASK_FAMILY = "bifrost";
export const BIFROST_CONTAINER_NAME = "bifrost";

/**
 * The sidecar's container name. It is what the second `loadBalancers` entry on
 * the service names, so it is a constant for the same reason as Bifrost's.
 */
export const OAUTH2_PROXY_CONTAINER_NAME = "oauth2-proxy";

/**
 * The rolling-update bounds, and the one place a default would be wrong.
 *
 * ECS's defaults for a REPLICA service are `maximumPercent: 200` and
 * `minimumHealthyPercent: 100`, which permits the scheduler to start a
 * replacement task before draining the old one. With `desiredCount: 1` that is
 * briefly **two** Bifrost processes, and OSS Bifrost is single-node by design:
 * "One node, because OSS is one node" in `docs/bifrost-gateway.md` records
 * that OSS keeps provider configs, keys, budgets and usage in memory and does
 * not read them back from Postgres, which is why upstream does not support
 * multi-node OSS at all. Two instances would hold divergent in-memory state
 * against one database, and Bifrost runs its store migrations at startup, so
 * the pair can also race the schema.
 *
 * `minimumHealthyPercent: 0` with `maximumPercent: 100` is the documented
 * stop-before-start shape: the scheduler may not exceed `desiredCount`, so it
 * drains the old task before starting the new one. The cost is a short gap
 * between tasks rather than an overlapping pair, which is the trade the plan
 * already makes everywhere else — a task replacement is a short outage — and
 * it is the only shape that keeps the single-node invariant true during a
 * deploy.
 */
export const DEPLOYMENT_MINIMUM_HEALTHY_PERCENT = 0;
export const DEPLOYMENT_MAXIMUM_PERCENT = 100;

/**
 * The log group. Named beside the delegate's `/aws/ecs/delegate` rather than
 * with it, because this is a different account and a different stack: the two
 * are only reachable separately, and a shared name would imply otherwise.
 *
 * Thirty days, matching the delegate's group. The durable cost-attribution
 * record for this account is the Bedrock invocation log at 365 days; this is
 * the gateway containers' own operational log, it grows with traffic, and a
 * month covers "what happened around the time this broke".
 *
 * One group for both containers, not one each: they are one task and one
 * operational story, and the `awslogs` stream name carries the container name,
 * so the sidecar's lines are separable without a second group.
 */
export const BIFROST_LOG_GROUP_NAME = "/aws/ecs/bifrost";
export const BIFROST_LOG_RETENTION_DAYS = 30;
export const BIFROST_LOG_STREAM_PREFIX = "bifrost";

/**
 * The two IAM roles, named apart on purpose. The execution role is assumed by
 * the ECS agent to pull the image, write logs and resolve `secrets`; the task
 * role is the identity the Bifrost process itself runs as, and the plan makes
 * it the Bedrock credential. Collapsing them would hand the gateway's own
 * network-facing process the ECS and Secrets Manager permissions it does not
 * use, which is the whole thing the split buys.
 */
export const EXECUTION_ROLE_NAME = "bifrost-task-execution";
export const TASK_ROLE_NAME = "bifrost-task";

/**
 * The managed policy the execution role needs for ECR pulls and `awslogs`.
 * AWS's own, not a hand-written equivalent: it is the documented minimum for
 * Fargate, and restating it inline would be a copy that goes stale.
 */
export const ECS_EXECUTION_MANAGED_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy";

/**
 * The task size: 0.5 vCPU / 1 GB, per "Sizing" in the plan. Fargate's valid
 * cpu/memory pairs put 512 CPU at 1024 through 4096 MB; this is the smallest
 * pair, which is what "start small, one-line change" means here — raising it
 * is this constant and the containers' own reservations below.
 *
 * Fargate requires the container-level reservations to fit inside the task, so
 * item 9's sidecar takes its share out of the task rather than out of thin air:
 * the two containers together reserve exactly the task's 512 CPU / 1024 MB,
 * which is unchanged from item 8's single container. Bifrost keeps almost all
 * of it; oauth2-proxy is a small Go reverse proxy with a static allowlist and
 * needs a fraction. The split is spelled as constants with a test that their
 * sums equal the task, because a reservation that exceeds the task is an apply
 * failure (`The sum of the container memory and CPU reservations exceeds the
 * task reservation`) and a container with no reservation at all would silently
 * compete with Bifrost for the whole task.
 */
export const TASK_CPU = "512";
export const TASK_MEMORY = "1024";

export const BIFROST_CONTAINER_CPU = 448;
export const BIFROST_CONTAINER_MEMORY = 896;
export const OAUTH2_PROXY_CONTAINER_CPU = 64;
export const OAUTH2_PROXY_CONTAINER_MEMORY = 128;

/**
 * The secret containers, by the names `fill-secrets.sh` already uses. Both are
 * script-owned (see the header): nothing here declares, versions or writes
 * them, and a rename is a change to that script and this constant together.
 */
export const GATEWAY_SECRET_NAME = "bifrost/gateway";
export const OAUTH2_PROXY_SECRET_NAME = "bifrost/oauth2-proxy";

/**
 * The keys inside `bifrost/gateway`, in the order the runbook's header lists
 * them. These are the four the gateway container gets, and they are the keys
 * the script writes — the same names, so nothing has to be renamed on either
 * side.
 *
 * A `const` array rather than a lookup against the live secret: `preview` must
 * run without `secretsmanager:GetSecretValue`, and a key list read from the
 * secret would also mean a silent task-definition change the next time someone
 * fills one. `deploy/delegate-secret.ts` made the same call for the delegate's
 * `DELEGATES` secret.
 *
 * `BIFROST_ADMIN_USERNAME` and `BIFROST_ADMIN_PASSWORD` are the OSS admin
 * credential for the dashboard and governance API; they arrive here now
 * because they belong to this container, and they are inert until the admin
 * surface is reachable (item 9 puts oauth2-proxy in front of it).
 */
export const GATEWAY_SECRET_KEYS = [
  "BIFROST_ENCRYPTION_KEY",
  "BIFROST_ADMIN_USERNAME",
  "BIFROST_ADMIN_PASSWORD",
  "FIREWORKS_API_KEY",
] as const;

/**
 * The keys inside `bifrost/oauth2-proxy`: the three credentials the plan
 * requires all-or-none. Item 9's sidecar injects all three from this container
 * and nothing else reads them.
 */
export const OAUTH2_PROXY_SECRET_KEYS = [
  "OAUTH2_PROXY_CLIENT_ID",
  "OAUTH2_PROXY_CLIENT_SECRET",
  "OAUTH2_PROXY_COOKIE_SECRET",
] as const;

/**
 * The RDS-managed master password, injected as the task's `PG_PASSWORD`.
 *
 * Item 7's module returns `secretArn` for exactly this ("The secret's ARN is
 * returned below for item 8 to inject as the task's `PG_PASSWORD`"), so the
 * injection lands here rather than waiting for item 10. Only the password:
 * host, port, database name and user are non-secret configuration and belong
 * to `config.json`'s `env.` references in item 10, and inventing them here
 * would be the runtime configuration the plan puts in that item.
 *
 * `password` is the key RDS uses in the JSON it writes for a managed master
 * user (`username`, `password`, `engine`, `host`, `port`,
 * `dbInstanceIdentifier`).
 */
export const RDS_PASSWORD_JSON_KEY = "password";
export const PG_PASSWORD_ENV_NAME = "PG_PASSWORD";

/**
 * The one plain environment variable. Bifrost's Bedrock provider authenticates
 * as the task role, and the AWS SDKs the provider sits on resolve a region
 * from the environment; without this the gateway has no region to invoke in.
 * Everything else about the runtime — providers, stores, governance — is
 * `BIFROST_CONFIG` in item 10.
 */
export const AWS_REGION_ENV_NAME = "AWS_REGION";

/**
 * The sidecar's non-secret configuration, as a table rather than a list of
 * literals in the container definition so the test can pin every value.
 *
 * The settings follow `agent-swarm/host/docker-compose.yml`'s `oauth2-proxy`
 * service, which is the working precedent in this repo, with the two
 * differences the plan names:
 *
 * - `OAUTH2_PROXY_UPSTREAMS` is Bifrost in the same task, not `static://202`:
 *   the swarm's Caddy forwards and oauth2-proxy only gates, while here the
 *   proxy is the reverse proxy for the admin surface. The two containers share
 *   the task network namespace, so `127.0.0.1` is Bifrost with no hop back
 *   through the ALB. The port comes from `network.ts`, the same constant the
 *   Bifrost container publishes and the security group admits.
 * - `OAUTH2_PROXY_REDIRECT_URL` and `OAUTH2_PROXY_WHITELIST_DOMAINS` are this
 *   gateway's hostname, derived from `ingress.ts` rather than spelled again,
 *   so a hostname change cannot leave the Google callback pointing at the old
 *   name.
 *
 * The allowlist path is the constant the derived image's `Dockerfile` writes
 * to (`oauth2-proxy-image.ts`), not a literal here: a mismatch is a proxy that
 * starts with a missing file, and it would be a silent one.
 *
 * Every value is a string. ECS environment entries are strings, and oauth2-proxy
 * reads these names as its own flags; `"true"` quoted is the same setting the
 * swarm's compose file uses, not a boolean ECS would reject.
 */
export const OAUTH2_PROXY_ENVIRONMENT: Readonly<Record<string, string>> = {
  OAUTH2_PROXY_PROVIDER: "google",
  OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE:
    OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_REDIRECT_URL: `https://${BIFROST_HOSTNAME}/oauth2/callback`,
  OAUTH2_PROXY_HTTP_ADDRESS: `0.0.0.0:${OAUTH2_PROXY_PORT}`,
  OAUTH2_PROXY_REVERSE_PROXY: "true",
  OAUTH2_PROXY_UPSTREAMS: `http://127.0.0.1:${BIFROST_PORT}`,
  OAUTH2_PROXY_COOKIE_SECURE: "true",
  OAUTH2_PROXY_COOKIE_SAMESITE: "lax",
  OAUTH2_PROXY_COOKIE_EXPIRE: "168h",
  OAUTH2_PROXY_COOKIE_REFRESH: "1h",
  OAUTH2_PROXY_SET_XAUTHREQUEST: "true",
  OAUTH2_PROXY_PASS_USER_HEADERS: "true",
  OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "true",
  OAUTH2_PROXY_WHITELIST_DOMAINS: BIFROST_HOSTNAME,
};

/**
 * The actions each role is allowed. Exported as data so the test can assert
 * that neither contains a wildcard, and so "what may this identity do" is one
 * list to read rather than a policy document to parse.
 *
 * The execution role reads secrets and nothing else beyond its managed policy;
 * the task role invokes the enumerated models and does nothing else. No
 * `secretsmanager:*`, no `bedrock:*`, no wildcard resource on either.
 */
export const EXECUTION_SECRET_ACTIONS = ["secretsmanager:GetSecretValue"] as const;

/**
 * The invoke actions, matching the set `WorkbenchAccess` grants engineers
 * (`deploy/components/identity-center/policies.ts`): the two `InvokeModel`
 * forms and the two `Converse` forms, because which pair the provider uses is
 * a property of Bifrost's Bedrock provider rather than of this policy, and
 * granting only one pair is an AccessDenied that reads like missing model
 * access.
 *
 * Deliberately absent, and worth stating because it is the "nothing wilder"
 * half of the requirement:
 *
 * - `bedrock:Get*` / `bedrock:List*`, which `WorkbenchAccess` holds wide so a
 *   person is never blocked mid-task. The gateway is not a person and invokes
 *   a fixed model list; if item 12 shows the provider enumerating the catalog
 *   at boot, this is where that read is added, named rather than wildcarded.
 * - anything `aws-marketplace`, which is what auto-subscribes a model nobody
 *   chose. Subscriptions are out of band, per the plan and step 11.
 */
export const TASK_BEDROCK_ACTIONS = [
  "bedrock:Converse",
  "bedrock:ConverseStream",
  "bedrock:InvokeModel",
  "bedrock:InvokeModelWithResponseStream",
] as const;

/**
 * The IAM resource ARN of a secret this stack does not own.
 *
 * Secrets Manager appends six random characters to the name in the real ARN,
 * so a policy has to wildcard them; `-??????` is the form the rest of this repo
 * uses for the same reason (`deploy/components/ci-roles/policies.ts`). A
 * `getSecret` data source would give the exact ARN, but it reads metadata from
 * AWS at preview time and this project's preview role deliberately holds no
 * permissions, so the name is constructed instead.
 */
export const secretArnPattern = (name: string): string =>
  `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:${name}-??????`;

/**
 * The `valueFrom` reference ECS resolves at task start: the secret name, the
 * JSON key and the defaults for version stage and version id.
 *
 * The suffix-less form is a partial ARN, which Secrets Manager accepts and
 * resolves by name in the same account and region — the same account and
 * region this task runs in. It is used here because the six random characters
 * are unknowable without a describe, and because the container must be able to
 * move to a recreated secret (a delete and refill in `fill-secrets.sh`) without
 * a task-definition change.
 */
export const secretReference = (name: string, jsonKey: string): string =>
  `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:${name}:${jsonKey}::`;

/** The shape both policy documents below share, so the test can walk them. */
export type PolicyStatement = {
  Sid?: string;
  Effect: "Allow";
  Action: string[];
  Resource: string[];
};

export type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

/**
 * The execution role's inline policy: read the three secrets the task
 * resolves. `bifrost/gateway` and `bifrost/oauth2-proxy` are the plan's two,
 * and the RDS-managed master password is the third because item 7 handed it to
 * this item. Nothing else: the ECR pull and the log writes come from the
 * managed policy attached alongside it.
 */
export const executionRoleSecretsPolicyDocument = (
  secretArns: string[],
): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ReadInjectedSecrets",
      Effect: "Allow",
      Action: [...EXECUTION_SECRET_ACTIONS],
      Resource: secretArns,
    },
  ],
});

/**
 * The task role's policy: invoke exactly the models in
 * `utils/bedrock-models.ts`, which is the same list the subscription script
 * walks and the same one `WorkbenchAccess` composes from. One list, so a model
 * added there is reachable by the gateway without a second edit, and a model
 * removed there is not.
 */
export const taskRolePolicyDocument = (
  bedrockResources: string[],
): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "InvokeSelectedBedrockModels",
      Effect: "Allow",
      Action: [...TASK_BEDROCK_ACTIONS],
      Resource: bedrockResources,
    },
  ],
});

export const createBifrostEcs = (args: {
  provider: aws.Provider;
  network: WorkbenchNetwork;
  database: BifrostDatabase;
  /**
   * The ingress item 6 created and item 9's rules attach. The service needs two
   * things from it: the target groups to register into, and the listener rules
   * as an explicit dependency — ECS refuses a target group that no listener or
   * rule references, so the rules must exist before `CreateService` runs.
   */
  ingress: BifrostIngress;
  /**
   * The mirrored repository's URL, from `bifrost-image.ts`. The tag is
   * appended here from `BIFROST_UPSTREAM_TAG` so the pin lives in one module;
   * the repository is immutable, so the tag cannot be repointed and the
   * reference is as reproducible as a digest. The ECR digest the mirror
   * produces is not a Pulumi value (the push happens in the workflow, after
   * the apply), which is the reason the tag carries the pin rather than a
   * digest literal that the first mirror run would have to supply.
   */
  repositoryUrl: pulumi.Input<string>;
  /**
   * The derived oauth2-proxy image's repository, from `oauth2-proxy-image.ts`.
   * Its tag is content-addressed on the admin allowlist, so it comes from that
   * module rather than from a literal; a changed list is a new tag and a new
   * task definition revision.
   */
  oauth2ProxyRepositoryUrl: pulumi.Input<string>;
}) => {
  const {
    provider,
    network,
    database,
    ingress,
    repositoryUrl,
    oauth2ProxyRepositoryUrl,
  } = args;

  const imageUri = pulumi.interpolate`${repositoryUrl}:${BIFROST_UPSTREAM_TAG}`;
  const oauth2ProxyImageUri = pulumi.interpolate`${oauth2ProxyRepositoryUrl}:${OAUTH2_PROXY_TAG}`;

  /**
   * The cluster. Container insights on, per the plan: it is the only
   * task-level view of CPU and memory this account has, and the gateway is a
   * single task whose saturation nobody would otherwise see.
   */
  const cluster = new aws.ecs.Cluster(
    "bifrostCluster",
    {
      name: BIFROST_CLUSTER_NAME,
      settings: [{ name: "containerInsights", value: "enabled" }],
    },
    { provider },
  );

  /**
   * The log group. Referenced by the container's `awslogs` configuration
   * below rather than named there as a string, so the group and the driver
   * cannot drift. Retention is set: the CloudWatch default is never expire,
   * and a group that receives a line per request forever is the one value
   * certainly wrong (the same argument `index.ts` makes for the invocation
   * log).
   */
  const logGroup = new aws.cloudwatch.LogGroup(
    "bifrostLogGroup",
    {
      name: BIFROST_LOG_GROUP_NAME,
      retentionInDays: BIFROST_LOG_RETENTION_DAYS,
      tags: { Name: BIFROST_LOG_GROUP_NAME },
    },
    { provider },
  );

  /**
   * The execution role: the ECS agent's identity, not the gateway's. It pulls
   * the image from ECR, writes the container's logs and resolves the `secrets`
   * block before the container starts.
   *
   * DIFFERS from `deploy/components/worker.ts`: that role grants read on one
   * secret by its exact Pulumi ARN, because Pulumi owns that container. These
   * three are script-owned or RDS-owned, so two are named patterns and the
   * third is the ARN item 7 returned — which is also why the policy is built
   * with `apply` rather than inline.
   */
  const executionRole = new aws.iam.Role(
    "bifrostExecutionRole",
    {
      name: EXECUTION_ROLE_NAME,
      description:
        "Bifrost gateway task execution: ECR pull, CloudWatch Logs, and read on the task's injected secrets.",
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
          name: "secrets",
          policy: database.secretArn.apply((databaseSecretArn) =>
            JSON.stringify(
              executionRoleSecretsPolicyDocument([
                secretArnPattern(GATEWAY_SECRET_NAME),
                secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
                databaseSecretArn,
              ]),
            ),
          ),
        },
      ],
    },
    { provider },
  );

  /**
   * The task role: what the Bifrost process itself is, and the plan's Bedrock
   * credential. The plan is explicit that upstream's Bedrock provider takes
   * "Inherited AWS Credentials / IAM Role", so on Fargate this role is the
   * whole credential — no static AWS key is stored anywhere.
   *
   * No managed policies at all. DIFFERS from `deploy/components/worker.ts`,
   * whose task role carries five AWS-managed read policies because the
   * delegate is a general-purpose agent that is expected to explore the
   * account. The gateway is a proxy: it may invoke its models and nothing
   * else, and the `Resource` list is the model list rather than `*`.
   */
  const taskRole = new aws.iam.Role(
    "bifrostTaskRole",
    {
      name: TASK_ROLE_NAME,
      description:
        "Bifrost gateway task: invoke the models in utils/bedrock-models.ts and nothing else.",
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
      inlinePolicies: [
        {
          name: "bedrock",
          policy: pulumi.jsonStringify(
            taskRolePolicyDocument(bedrockInvokeResources()),
          ),
        },
      ],
    },
    { provider },
  );

  /**
   * The task definition, in the idiom of `deploy/components/worker.ts`.
   *
   * Differences from that one, each deliberate:
   *
   * - Two containers: Bifrost, and the oauth2-proxy sidecar that gates the
   *   admin surface. Item 8 shipped Bifrost alone; item 9 adds the sidecar
   *   once its image and secret references exist.
   * - No review bucket, no `AGENT_VERSION`, no metric filters: those are the
   *   delegate's concerns, not the gateway's.
   * - `cpu`/`memory` are 512/1024 rather than 1024/4096, per the plan's
   *   sizing, and the containers' own reservations split that total rather
   *   than each repeating it; see the constants above.
   * - The `secrets` block is not a list of keys read from a secret. It is the
   *   declared lists above, plus `PG_PASSWORD` from the RDS-managed ARN; see
   *   the module header for why nothing here reads Secrets Manager. Bifrost
   *   gets `bifrost/gateway`'s four and `PG_PASSWORD`; the sidecar gets
   *   `bifrost/oauth2-proxy`'s three and nothing else, so neither container
   *   sees the other's credentials.
   * - `AWS_REGION` is set because the Bedrock provider needs a region; the
   *   delegate sets `AWS_DEFAULT_REGION` for the same reason. The sidecar has
   *   no AWS configuration at all: it is a Google OAuth proxy.
   *
   * Every value that comes from another resource is put through one `pulumi.all`
   * *before* the object is built, including `logGroup.name`. An `Output`
   * interpolated inside an `apply` callback is not resolved for you: the
   * callback's return value is taken as-is, and `JSON.stringify` on it throws
   * `Calling [toJSON] on an [Output<T>] is not supported`
   * (`@pulumi/pulumi/output.js`), which would fail the apply at the task
   * definition with a message that says nothing about the log group. Listing it
   * as an input is also what makes the dependency edge real, rather than a
   * reference the serializer never sees.
   */
  const containerDefinitions = pulumi
    .all([
      imageUri,
      oauth2ProxyImageUri,
      database.secretArn,
      logGroup.name,
    ])
    .apply(
      ([
        resolvedImage,
        resolvedOauth2ProxyImage,
        databaseSecretArn,
        resolvedLogGroupName,
      ]) => [
        {
          name: BIFROST_CONTAINER_NAME,
          image: resolvedImage,
          cpu: BIFROST_CONTAINER_CPU,
          memory: BIFROST_CONTAINER_MEMORY,
          essential: true,
          portMappings: [
            {
              containerPort: BIFROST_PORT,
              hostPort: BIFROST_PORT,
              protocol: "tcp",
            },
          ],
          environment: [{ name: AWS_REGION_ENV_NAME, value: REGION }],
          secrets: [
            ...GATEWAY_SECRET_KEYS.map((key) => ({
              name: key,
              valueFrom: secretReference(GATEWAY_SECRET_NAME, key),
            })),
            {
              name: PG_PASSWORD_ENV_NAME,
              valueFrom: `${databaseSecretArn}:${RDS_PASSWORD_JSON_KEY}::`,
            },
          ],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": resolvedLogGroupName,
              "awslogs-region": REGION,
              "awslogs-stream-prefix": BIFROST_LOG_STREAM_PREFIX,
            },
          },
          // An init process as PID 1, so signals reach Bifrost and a zombie is
          // reaped: the same reason the delegate's container sets it.
          linuxParameters: { initProcessEnabled: true },
        },
        {
          name: OAUTH2_PROXY_CONTAINER_NAME,
          image: resolvedOauth2ProxyImage,
          cpu: OAUTH2_PROXY_CONTAINER_CPU,
          memory: OAUTH2_PROXY_CONTAINER_MEMORY,
          // Essential, so a proxy that cannot start takes the task with it
          // rather than leaving a gateway whose admin surface has no door.
          // The alternative — non-essential, so Bifrost keeps serving
          // inference while a crash-looping proxy 503s the admin paths — was
          // considered and rejected: the sidecar is given all three
          // credentials unconditionally, so a proxy that will not start is a
          // missing or wrong value in Secrets Manager, and a task that never
          // stabilizes is the visible failure. The fail-closed property does
          // not depend on this flag: the ALB has no rule that sends an admin
          // path to Bifrost at all.
          essential: true,
          portMappings: [
            {
              containerPort: OAUTH2_PROXY_PORT,
              hostPort: OAUTH2_PROXY_PORT,
              protocol: "tcp",
            },
          ],
          environment: Object.entries(OAUTH2_PROXY_ENVIRONMENT).map(
            ([name, value]) => ({ name, value }),
          ),
          secrets: OAUTH2_PROXY_SECRET_KEYS.map((key) => ({
            name: key,
            valueFrom: secretReference(OAUTH2_PROXY_SECRET_NAME, key),
          })),
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": resolvedLogGroupName,
              "awslogs-region": REGION,
              "awslogs-stream-prefix": BIFROST_LOG_STREAM_PREFIX,
            },
          },
          // The sidecar gets the same PID 1 treatment: it forwards signals and
          // reaps its own children the same way Bifrost does, and ECS's
          // stop sequence depends on it.
          linuxParameters: { initProcessEnabled: true },
        },
      ],
    );

  const taskDefinition = new aws.ecs.TaskDefinition(
    "bifrostTaskDefinition",
    {
      family: BIFROST_TASK_FAMILY,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: TASK_CPU,
      memory: TASK_MEMORY,
      executionRoleArn: executionRole.arn,
      taskRoleArn: taskRole.arn,
      runtimePlatform: {
        // The mirror pulls `--platform linux/amd64` (bifrost-image.ts), so the
        // task is x86 rather than Fargate's arm64 default.
        cpuArchitecture: "X86_64",
        operatingSystemFamily: "LINUX",
      },
      containerDefinitions: pulumi.jsonStringify(containerDefinitions),
    },
    { provider },
  );

  /**
   * The service. One task, by design and not by oversight: OSS Bifrost is
   * single-node ("One node, because OSS is one node" in the plan), so
   * `desiredCount: 1` is the configuration, not a starting point.
   * A second task behind the same ALB is not a valid topology and is not
   * "just in case" material.
   *
   * It runs in the private subnets with the task security group, which admits
   * 8080 and 4180 from the ALB group only and lets everything out through the
   * NAT; all three are item 5's, and none is re-declared here.
   *
   * Both `loadBalancers` entries are item 9's, and they land now because the
   * rules that make the groups attachable land with them (`ingress.ts`). ECS's
   * `CreateService` rejects a target group that no listener or listener rule
   * references (`InvalidParameterException: The target group with targetGroupArn
   * ... does not have an associated load balancer`), so the service's
   * `dependsOn` names every listener rule explicitly. That dependency is the
   * point: without it Pulumi could create the service before the rules and
   * fail exactly the way item 8 predicted, and it would be an ordering race
   * rather than a deterministic error.
   *
   * Registration is by container name and port, not by ARN: each target group
   * receives the task's IP on the port its own container publishes, which is
   * why the constants above and `network.ts`'s port constants are the single
   * source for both sides.
   *
   * The deployment percentages are set rather than left to the provider, because
   * ECS's defaults would run two tasks at once during an update; see the
   * constants above. This is not autoscaling and not a second task: it caps a
   * deployment at the one instance OSS Bifrost supports.
   */
  const service = new aws.ecs.Service(
    "bifrostService",
    {
      name: BIFROST_SERVICE_NAME,
      cluster: cluster.arn,
      taskDefinition: taskDefinition.arn,
      desiredCount: 1,
      launchType: "FARGATE",
      loadBalancers: [
        {
          targetGroupArn: ingress.bifrostTargetGroup.arn,
          containerName: BIFROST_CONTAINER_NAME,
          containerPort: BIFROST_PORT,
        },
        {
          targetGroupArn: ingress.oauth2ProxyTargetGroup.arn,
          containerName: OAUTH2_PROXY_CONTAINER_NAME,
          containerPort: OAUTH2_PROXY_PORT,
        },
      ],
      // The ECS API calls these `deploymentConfiguration.maximumPercent` and
      // `minimumHealthyPercent`; the Pulumi provider models them as these two
      // top-level arguments, and reserves `deploymentConfiguration` for the
      // deployment *strategy* block (bake time, canary, blue/green). See the
      // constants above for why they are not the defaults.
      deploymentMinimumHealthyPercent: DEPLOYMENT_MINIMUM_HEALTHY_PERCENT,
      deploymentMaximumPercent: DEPLOYMENT_MAXIMUM_PERCENT,
      networkConfiguration: {
        subnets: network.privateSubnetIds,
        securityGroups: [network.taskSecurityGroup.id],
        // Private subnets: there is no route to the internet gateway, so a
        // public IP would be unusable as well as unwanted.
        assignPublicIp: false,
      },
      tags: { Name: BIFROST_SERVICE_NAME },
    },
    {
      provider,
      // The rules reference both target groups, so waiting for them is what
      // makes each group associated before ECS registers the task. See the
      // header and the comment above.
      dependsOn: ingress.listenerRules,
    },
  );

  return {
    cluster,
    taskDefinition,
    service,
    logGroup,
    executionRole,
    taskRole,
    /** For a stack output, so a human can find the task without the console. */
    containerName: BIFROST_CONTAINER_NAME,
    /** The sidecar's container name, for the same reason. */
    oauth2ProxyContainerName: OAUTH2_PROXY_CONTAINER_NAME,
  };
};
