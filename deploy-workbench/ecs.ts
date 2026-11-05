import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { bedrockInvokeResources } from "../utils/bedrock-models";
import { BIFROST_BOOTSTRAP_TAG } from "./bootstrap-image";
import {
  BIFROST_GATEWAY_TAG,
  BIFROST_PG_PASSWORD_CONTAINER_PATH,
} from "./pg-password-image";
import {
  BIFROST_PORT,
  createWorkbenchNetwork,
  OAUTH2_PROXY_PORT,
  REGION,
} from "./network";
import {
  BIFROST_HOSTNAME,
  TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS,
  TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS,
  TARGET_GROUP_HEALTHY_THRESHOLD,
} from "./ingress";
import type { BifrostIngress } from "./ingress";
import type { BifrostDiscovery } from "./discovery";
import {
  OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH,
  OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_TAG,
} from "./oauth2-proxy-image";
import { BifrostDatabase, DATABASE_NAME, DATABASE_USERNAME } from "./rds";

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
 *   task-execution policy plus read on the two script-owned secrets) and the
 *   separate task role (the Bedrock model list, the catalog listing that renders
 *   it, and read on the one RDS-managed secret its `password_command` resolves).
 * - Owns since step 6 of `docs/bifrost-zero-downtime-deploys.md`: the task role's
 *   `secretsmanager:GetSecretValue` grant on the RDS-managed secret, the
 *   `PG_SECRET_ARN` environment entry the container's password command reads it
 *   from, and the task's image, which is now the derived gateway image rather
 *   than the mirror (`pg-password-image.ts`). The `PG_PASSWORD` `secrets` entry
 *   is gone: a value injected once at task start cannot follow a rotation.
 * - Owns since item 9: the oauth2-proxy sidecar, its three `OAUTH2_PROXY_*`
 *   secret references plus the one `bifrost/gateway` key the injected header is
 *   read from, the `--alpha-config` flag that loads the alpha file, and the
 *   service's two `loadBalancers` entries. The rules that make those
 *   target groups attachable are `ingress.ts`'s; this file takes the ingress
 *   object and depends on its listener rules, because
 *   ECS's `CreateService` rejects a target group that no listener or listener
 *   rule references (`InvalidParameterException: The target group with
 *   targetGroupArn ... does not have an associated load balancer`). That was
 *   the constraint that kept item 8 from registering a target at all; the
 *   rules and the registration have to land together, and they do, here.
 * - Does not own: the network, the security groups, the ALB, the target
 *   groups or the database. Those are items 5, 6 and 7, and this file consumes
 *   their exports rather than declaring a second copy of any of them. In
 *   particular there is no target group, listener or security group here.
 * - Does not own: the derived oauth2-proxy image, the allowlist baked into it
 *   or the alpha configuration that carries the provider, the upstream and the
 *   injected setup-token header. `oauth2-proxy-image.ts` pins the image,
 *   `bifrost/allowed-emails.txt` is the list and `bifrost/alpha-config.yaml` is
 *   the rest; this file only names the tag, the container paths and the
 *   `--alpha-config` flag that loads it.
 * - Does not own: `config.json` itself. That file is item 10's, in
 *   `bifrost/config.json`, and is the deployment's declarative configuration;
 *   this module only stores it and gets it into the container.
 * - Owns since item 10: the SSM parameter that carries `config.json`, the
 *   `BIFROST_CONFIG` injection, the container entry point that writes it to
 *   `/app/data/config.json`, and the four non-secret Postgres env values
 *   `config.json` resolves by name. Before this landed the container started
 *   with Bifrost's built-in defaults: `"config file not found at path:
 *   /app/data/config.json, initializing with default values"`, a default SQLite
 *   config store (so no admin account survived a task replacement) and
 *   inference auth not enforced. Item 8's note that the task could not answer a
 *   real `/health` without item 10 is what this closes.
 * - Does not own: the two secret containers. `bifrost/gateway` and
 *   `bifrost/oauth2-proxy` were created out of band by
 *   `deploy-workbench/bifrost/fill-secrets.sh` and hold real values; declaring
 *   `aws.secretsmanager.Secret` here would put their lifecycle in Pulumi, and
 *   a replace would delete the values. This file only names them, and reads
 *   nothing from them: not the value, and not even the metadata, so `preview`
 *   needs no Secrets Manager permission at all. See `deploy/delegate-secret.ts`
 *   and `docs/pr-previews.md` step 3 for why the key list is declared in the
 *   repo instead of looked up.
 * - Does not read the RDS-managed secret either, now that the container does:
 *   the ARN comes from `rds.ts` as a resource output, and the value is read
 *   inside the task, at connection time, by `bifrost/pg-password.sh`. Nothing
 *   in this program calls `GetSecretValue`, so `preview` still needs no
 *   Secrets Manager permission. The one grant this file adds is IAM, not a
 *   read.
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
 *
 * That "short" gap is set by two things outside this module, and on 2026-10-26
 * it was seven and a half minutes: the target groups' deregistration delay
 * (300s by default) and their health check timing, both pinned in
 * `ingress.ts`. Reducing them is the fix for the outage shape; it does not
 * make the gap zero. Removing it entirely means the rolling update above, and
 * that needs an answer for two instances racing the store migrations first.
 */
export const DEPLOYMENT_MINIMUM_HEALTHY_PERCENT = 0;
export const DEPLOYMENT_MAXIMUM_PERCENT = 100;

/**
 * ECS's deployment circuit breaker, on the service below.
 *
 * Absent, a task definition that cannot become healthy sits at running 0 /
 * desired 1 until a human notices — the shape the 2026-10-26 outage had.
 * `deploy-workbench/scripts/verify-service.ts` turns that state into a red run,
 * but it is a detector: it cannot put the service back. With the breaker
 * enabled and set to roll back, ECS stops the failed deployment itself and
 * returns the service to the last revision that completed successfully.
 *
 * `rollback: true` is the half that matters. `enable: true` alone stops the
 * deployment and leaves the service where it is.
 *
 * Unlike the percentages above, this is a typed field on `aws.ecs.Service`
 * (`ServiceDeploymentCircuitBreaker`, both members required in `@pulumi/aws`
 * v7), so a missing or misspelt field is a compile error rather than a knob
 * that silently does nothing. It changes nothing about a deploy that succeeds.
 */
export const DEPLOYMENT_CIRCUIT_BREAKER = {
  enable: true,
  rollback: true,
};

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
 *
 * The bootstrap container below deliberately takes no reservation at all: the
 * two above already sum to the task, and it is a curl+jq one-shot that lives
 * for seconds. Fargate allows an unreserved container; it draws from whatever
 * is not reserved at the time.
 */
export const TASK_CPU = "512";
export const TASK_MEMORY = "1024";

export const BIFROST_CONTAINER_CPU = 448;
export const BIFROST_CONTAINER_MEMORY = 896;
export const OAUTH2_PROXY_CONTAINER_CPU = 64;
export const OAUTH2_PROXY_CONTAINER_MEMORY = 128;

/**
 * How long ECS gives the gateway container to shut down before it is
 * `SIGKILL`ed: 120 seconds, Fargate's maximum.
 *
 * Unset, the task-definition default of 30 seconds applies, and 30 is a value
 * the container's own shutdown sequence does not fit inside. After `SIGTERM`
 * the process drains HTTP first — `fasthttp`'s `Shutdown` waits for open
 * connections and has no deadline of its own — and then waits up to
 * `BIFROST_SHUTDOWN_CLEANUP_BUDGET_SECONDS` for its cleanup goroutine, whose
 * last act is the governance plugin's final budget dump. So shutdown's budget
 * is "however long the drain takes, plus up to 30 seconds", and a stop timeout
 * of 30 does not merely truncate it: it overlaps it, so the final dump races
 * the deadline that kills it.
 *
 * The dump is the write a deploy cannot lose — it carries every bit of usage
 * the outgoing task recorded since its last periodic pass — so the margin is
 * deliberately generous rather than tuned. 120 is the ceiling Fargate accepts;
 * a larger number is rejected at the task definition rather than honoured.
 *
 * This sits in the container definition below, which is a single
 * `pulumi.jsonStringify` JSON document typed by ECS and not by the Pulumi
 * provider, so a misspelt key is not a compile error. `ecs.test.ts` pins it
 * textually for that reason.
 */
export const BIFROST_STOP_TIMEOUT_SECONDS = 120;

/**
 * The cleanup budget the process gives itself after it has drained HTTP, and
 * the term the stop timeout above has to leave room for. It is not a value this
 * deployment can set; it is read from the pinned gateway's shutdown path and
 * recorded here so the stop timeout's arithmetic is checkable.
 */
export const BIFROST_SHUTDOWN_CLEANUP_BUDGET_SECONDS = 30;

/**
 * The secret containers, by the names `fill-secrets.sh` already uses. Both are
 * script-owned (see the header): nothing here declares, versions or writes
 * them, and a rename is a change to that script and this constant together.
 */
export const GATEWAY_SECRET_NAME = "bifrost/gateway";
export const OAUTH2_PROXY_SECRET_NAME = "bifrost/oauth2-proxy";

/**
 * The keys inside `bifrost/gateway`, in the order the runbook's header lists
 * them. These are the five the gateway container gets, and they are the keys
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
 * credential. With dashboard auth turned off in `config.json` they no longer
 * authenticate a request; they stay injected because the file still references
 * them and because an admin account with auth disabled needs proof of operator
 * control before someone re-enables it. `BIFROST_SETUP_TOKEN` is that proof at
 * the pinned tag: while dashboard auth is not active the OSS setup lock
 * requires it on every non-public `/api` call, and it is also the first-admin
 * claim secret (phase 2 item 11). At the pinned tag Bifrost reads it from this
 * environment variable as well as from `config.json`'s top-level `setup_token`
 * (`resolveSetupToken` in `transports/bifrost-http/lib/config.go` at
 * `v2.3.0`).
 */
export const GATEWAY_SECRET_KEYS = [
  "BIFROST_ENCRYPTION_KEY",
  "BIFROST_ADMIN_USERNAME",
  "BIFROST_ADMIN_PASSWORD",
  "BIFROST_SETUP_TOKEN",
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
 * The one `bifrost/gateway` key the sidecar reads, and the reason it reads it:
 * the baked alpha configuration injects `X-Bifrost-Setup-Token` on every
 * request it proxies upstream (`deploy-workbench/bifrost/alpha-config.yaml`),
 * so the OSS setup lock is satisfied by the deployment rather than by a human
 * typing a second credential.
 *
 * This replaced the admin username/password pair the sidecar used to receive.
 * Those two existed so a wrapper could compute Bifrost's Basic credential into
 * an `Authorization` header; with `governance.auth_config.is_enabled` false
 * there is no login to answer, and an injected Basic header is not the setup
 * token, so the wrapper and the pair are gone. The token is read from the same
 * `bifrost/gateway` container the gateway container and the claim container
 * use, so there is no second secret and no copy that can drift.
 *
 * The sidecar still gets no provider key, no encryption key and nothing from
 * the database.
 */
export const OAUTH2_PROXY_GATEWAY_SECRET_KEYS = ["BIFROST_SETUP_TOKEN"] as const;

/**
 * The sidecar's command: the one flag that makes its baked alpha configuration
 * load.
 *
 * It is here rather than in the image's `CMD` so the flag is part of the task
 * definition, where `ecs.test.ts` can pin it against the path the Dockerfile
 * writes. Without it, the provider, the upstreams, the listen address and the
 * setup-token header are all absent at v7.15.5 -- alpha configuration absorbs
 * those options and oauth2-proxy has no other source for them -- so the proxy
 * refuses to start rather than serving an unconfigured door.
 */
export const OAUTH2_PROXY_COMMAND = [
  `--alpha-config=${OAUTH2_PROXY_ALPHA_CONFIG_CONTAINER_PATH}`,
] as const;

/**
 * The one-shot container that claims a fresh deployment (phase 2 item 11), and
 * the three keys it reads from `bifrost/gateway`.
 *
 * Upstream's setup lock only accepts one call while no admin account exists: a
 * `PUT /api/config` carrying `auth_config`, authenticated with this token. It
 * has to come from inside the task — once item 9's oauth2-proxy fronts the
 * gateway, the ALB sends admin paths to Google sign-in before they reach
 * Bifrost, and `127.0.0.1:8080` inside the task's namespace is the only path
 * that does not.
 *
 * It is `essential: false` on purpose. A claim that cannot run (the gateway is
 * not healthy, the password fails upstream's policy) must not stop the gateway
 * serving inference; the failure is visible as this container's `awslogs`
 * stream and its stopped reason, and a metric-filter alarm on it is the
 * follow-up that turns it into a page. It is ordered after the gateway is
 * `HEALTHY`, which is why the gateway container now carries an ECS
 * `healthCheck`: `dependsOn` conditions are ECS's, not Docker's, and the
 * `HEALTHCHECK` in the upstream Dockerfile is invisible to Fargate.
 */
export const BIFROST_BOOTSTRAP_CONTAINER_NAME = "bifrost-bootstrap";
export const BIFROST_BOOTSTRAP_LOG_STREAM_PREFIX = "bifrost-bootstrap";

/** The subset of `bifrost/gateway` the claim container reads, and no more. */
export const BIFROST_BOOTSTRAP_SECRET_KEYS = [
  "BIFROST_SETUP_TOKEN",
  "BIFROST_ADMIN_USERNAME",
  "BIFROST_ADMIN_PASSWORD",
] as const;

/**
 * The address the claim talks to. The task's containers share a network
 * namespace, so this is the gateway with no hop back through the ALB; the port
 * comes from `network.ts`, the same constant the container publishes and the
 * security group admits.
 */
export const BIFROST_API_BASE_URL_ENV_NAME = "BIFROST_API_BASE_URL";
export const BIFROST_API_BASE_URL = `http://127.0.0.1:${BIFROST_PORT}`;

/**
 * The gateway's ECS health check, which is what the claim's `dependsOn: HEALTHY`
 * waits on. `/health` is whitelisted by Bifrost's auth middleware and is served
 * from the process itself, so this tests the gateway rather than the ALB. The
 * command uses busybox `wget`, which the upstream runtime image ships (its own
 * Dockerfile HEALTHCHECK uses the same binary).
 *
 * The values are generous on purpose: this is a Go process that loads its
 * config store on start, and a start period that is too short would restart a
 * healthy task mid-boot. Three failures at 15s intervals is the same
 * order of magnitude the upstream Dockerfile uses, and the start period is 90
 * seconds because the first boot after a config change runs the store's
 * migrations: the 2026-10-26 apply measured 23.1s ("Time spent in Bifrost
 * server bootstrap") against an empty RDS, and the 30 seconds this used to be
 * left about seven seconds of margin before a slow boot was reported
 * unhealthy. A task that is slow because it is migrating is not a task to
 * restart.
 *
 * This is only half of that guarantee. It governs the container-level check,
 * which ECS acts on, and says nothing about the ALB's target-group check, which
 * ECS also acts on and which starts failing well before this start period has
 * run out; see `BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS` below, which is the
 * other half.
 */
export const BIFROST_HEALTH_CHECK: {
  command: string[];
  interval: number;
  timeout: number;
  retries: number;
  startPeriod: number;
} = {
  command: [
    "CMD-SHELL",
    `wget -q -O /dev/null ${BIFROST_API_BASE_URL}/health || exit 1`,
  ],
  interval: 15,
  timeout: 5,
  retries: 3,
  startPeriod: 90,
};

/**
 * How long ECS ignores a new task whose ALB health checks have not passed yet:
 * the service's `healthCheckGracePeriodSeconds`, and the reason `ingress.ts`
 * can keep the target-group timing short without turning a slow boot into a
 * replacement loop.
 *
 * The two checks measure the same boot from opposite sides, and ECS starts the
 * clock at `RUNNING` rather than when the process answers. So the ALB check on
 * a replacement task fails for the whole of the boot: Bifrost's `/health` is
 * served by the process, which is inside the store migrations for the first
 * ~23 seconds and longer on a slow one. With the pinned `unhealthyThreshold: 3`
 * at a 10-second interval the target group declares the target unhealthy about
 * twenty to thirty seconds in, and with ECS's default grace period of 0 the
 * service acts on that immediately: it stops the task and starts another. The
 * container's `startPeriod: 90` cannot prevent that, because it governs only
 * the container-level check. Since the service is stop-before-start with
 * `desiredCount: 1`, the replacement starts the same migrations again from the
 * beginning — a replacement loop with an empty gateway, which is worse than
 * the gap this deployment is accepted to have.
 *
 * The value is derived, not guessed, from the longest boot the deployment
 * already says it will tolerate. That is the container check's whole tolerance,
 * not just its start period: failures are ignored for `startPeriod`, and after
 * it the check still allows `retries` consecutive failures `interval` apart
 * before it calls the task unhealthy, so a boot that ends at 90 + 3 * 15 = 135
 * seconds is one the container check would still have called healthy. A grace
 * period that expired at the start period alone would let the ALB replace that
 * task anyway, which is the loop again, one boot length further out. So:
 *
 *   startPeriod               90
 *   retries * interval        + 3 * 15 = 45  (the failures after it)
 *   one ALB check in flight   + 5            (its timeout)
 *   two ALB interval ticks    + 2 * 10 = 20  (the two successes)
 *   = 160 seconds
 *
 * The ALB terms are there because ECS starts the grace clock at `RUNNING`,
 * before the process answers, while the two successes that promote the target
 * only begin once it does: the container check can call a task healthy at 135
 * seconds while the ALB still needs its two checks after that. The tests hold
 * the value to this sum and above the target group's own unhealthy window.
 *
 * 160 seconds is also the point of diminishing returns: lengthening it further
 * would tolerate a boot the container check has already given up on, and the
 * grace period is what bounds how long a genuinely broken task is left in place
 * before ECS replaces it.
 *
 * The cost is one-sided. The grace period suppresses ECS's reaction to failing
 * load balancer health checks; it does not change the health checks, the
 * target's state or the traffic, so a task that recovers inside it is promoted
 * by the ALB after the usual two successes and nothing waits 160 seconds. A
 * task that is genuinely broken is left in place for up to 160 seconds per
 * attempt instead of ~30 before ECS replaces it. The gateway answers 503 in both
 * cases, so that is slower failure detection with the same outage shape, and it
 * is the trade for never restarting a task that is merely migrating.
 * `deploy-workbench/scripts/verify-service.ts` is what turns a service that
 * never converges into a red deploy run (600s default), so the slower detection
 * is bounded and visible.
 */
export const BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS =
  BIFROST_HEALTH_CHECK.startPeriod +
  BIFROST_HEALTH_CHECK.interval * BIFROST_HEALTH_CHECK.retries +
  TARGET_GROUP_HEALTH_CHECK_TIMEOUT_SECONDS +
  TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS * TARGET_GROUP_HEALTHY_THRESHOLD;

/**
 * The slowest gateway boot this deployment has measured, in seconds: the
 * 2026-10-26 apply's "Time spent in Bifrost server bootstrap" against an empty
 * RDS, which is what `BIFROST_HEALTH_CHECK.startPeriod` was raised to 90 for.
 *
 * Recorded as a constant rather than only in prose because `config.json`'s
 * `password_command.timeout` has to fit around it: the CLI's timeout is spent
 * once per pool during store init, so a timeout that is generous in isolation
 * can still push a migrating boot past the start period and turn it into a
 * failed task. `bifrost/config.test.ts` holds the sum to the start period.
 */
export const BIFROST_MEASURED_BOOT_SECONDS = 23.1;

/**
 * A single warm `aws secretsmanager get-secret-value`, in seconds: the slower
 * end of five measured runs in the build container (0.62-0.88 s wall, 71 MiB
 * peak RSS, four cores, aarch64).
 *
 * It is a floor, not a prediction of the task. The task has 0.44 vCPU and a
 * cold page cache, so the real cold start is several times this, which is why
 * `config.json`'s timeout is many multiples of it rather than a small margin.
 * The number is here so the test can assert that multiple instead of restating
 * the timeout as a taste.
 */
export const BIFROST_MEASURED_CLI_SECONDS = 0.88;

/**
 * The RDS-managed master password's location, resolved by the container per
 * physical connection rather than injected at task start.
 *
 * Step 6 of `docs/bifrost-zero-downtime-deploys.md` (decision 20). This used to
 * be an ECS `secrets` entry: `PG_PASSWORD`, `valueFrom`
 * `${databaseSecretArn}:password::`. Bifrost reads that once, when the process
 * starts, so a rotation left the running gateway on the previous password until
 * the next task replacement — the 2026-11-02 event: `SQLSTATE 28P01` on every
 * new physical connection, `/health` pings the stores, the container went
 * unhealthy and ECS replaced it. Now `bifrost/config.json` declares a
 * `password_command` for both stores and the gateway image ships the script
 * that runs it (`pg-password-image.ts`), so a rotation heals within the
 * command's `cache_ttl` without a restart.
 *
 * Three names carry it:
 *
 * - `PG_SECRET_ARN` is the ARN, in the container's environment. It cannot be an
 *   argument of the command: the schema's `args` are literal strings and
 *   nothing expands an `env.` reference in them (`PasswordCommandConfig.Args`
 *   is a plain `[]string` filled by `json.Unmarshal`).
 * - `RDS_PASSWORD_JSON_KEY` is the key RDS writes in the JSON it owns for a
 *   managed master user (`username`, `password`, `engine`, `host`, `port`,
 *   `dbInstanceIdentifier`), and the script reads it from the `AWSCURRENT`
 *   version — RDS writes a rotation there, so nothing has to look at
 *   `AWSPENDING`.
 * - `PG_PASSWORD_ENV_NAME` is what the execution role used to inject and what
 *   `config.json` used to reference. It is no longer injected and no longer
 *   referenced; it is kept here as the single statement of the name that step
 *   removed, so a test can assert its absence rather than a reader having to
 *   grep for a string that appears nowhere.
 */
export const RDS_PASSWORD_JSON_KEY = "password";
export const PG_PASSWORD_ENV_NAME = "PG_PASSWORD";
export const PG_SECRET_ARN_ENV_NAME = "PG_SECRET_ARN";

/**
 * How long the entry point's warm gives the password command, in seconds.
 *
 * The same number as `bifrost/config.json`'s `password_command.timeout`, and
 * spelled here because the warm is shell in the task definition rather than a
 * field in that file. The two are asserted equal in `ecs.test.ts`: a warm with
 * a longer budget than the command could hang the boot for longer than the
 * thing it is warming for, and a shorter one would abandon a resolution the
 * first dial is about to need anyway.
 *
 * 30 rather than the pinned tag's 10s default, for the reason
 * `bifrost/config.test.ts`'s timeout budget records: two cold `aws-cli` starts
 * on a 0.44 vCPU task are not the warm measurement, and 30s still leaves the
 * whole slow boot inside the health check's 90s start period.
 */
export const BIFROST_PG_PASSWORD_TIMEOUT_SECONDS = 30;

/**
 * The plain environment variables, and what each is for.
 *
 * `AWS_REGION` is the Bedrock provider's region: the AWS SDKs the provider
 * sits on resolve one from the environment, and without it the gateway has no
 * region to invoke in.
 *
 * The four `PG_*` values are the non-secret half of the Postgres connection
 * that `config.json`'s `config_store` and `logs_store` resolve by name. They
 * are Pulumi outputs of `rds.ts` (host, port) or constants that module owns
 * (user, database name), so the connection string has one source rather than a
 * copy in a JSON file. The password is not here and is not a `secrets` entry
 * either: `PG_SECRET_ARN` below names the RDS-managed secret and the container
 * resolves the password from it per connection (`PG_SECRET_ARN_ENV_NAME`).
 *
 * Bifrost resolves `host`, `port`, `user`, `password` and `db_name` as
 * `schemas.SecretVar`, which accepts a literal, `env.NAME` or a `vault.path`
 * (`framework/postgresconn/postgresconn.go` at the pinned tag), so an `env.`
 * reference is supported on every one of them, not only the ones the upstream
 * docs' example happens to show.
 */
export const AWS_REGION_ENV_NAME = "AWS_REGION";
export const PG_HOST_ENV_NAME = "PG_HOST";
export const PG_PORT_ENV_NAME = "PG_PORT";
export const PG_USER_ENV_NAME = "PG_USER";
export const PG_DATABASE_ENV_NAME = "PG_DATABASE";

/**
 * Every env name the gateway container receives that is *not* one of its
 * Secrets Manager keys. Together with `GATEWAY_SECRET_KEYS` that is the
 * complete set an `env.` reference in `config.json` can name, which is what
 * makes a reference that resolves to nothing a test failure rather than a
 * runtime surprise. The password is deliberately not in either list: it is not
 * an `env.` reference any more, it is what the gateway's `password_command`
 * prints (`PG_SECRET_ARN_ENV_NAME`).
 *
 * `PG_SECRET_ARN` is deliberately *not* in this list even though the container
 * carries it. This list is "names `config.json` may resolve", and an ARN is not
 * a password: a `"password": "env.PG_SECRET_ARN"` would authenticate with the
 * ARN. It is asserted as its own container environment entry instead, in
 * `GATEWAY_PASSWORD_ENV_NAMES` below.
 */
export const GATEWAY_PLAIN_ENV_NAMES = [
  AWS_REGION_ENV_NAME,
  PG_HOST_ENV_NAME,
  PG_PORT_ENV_NAME,
  PG_USER_ENV_NAME,
  PG_DATABASE_ENV_NAME,
] as const;

/**
 * The gateway container's remaining environment entries: what the password
 * command reads, rather than what `config.json` resolves.
 *
 * `PG_SECRET_ARN` is an identifier, not a credential: the read is authorised by
 * the task role, and the ARN is the Pulumi output that `pulumi stack output
 * bifrostDatabaseSecretArn` already shows. It is an `environment` entry rather
 * than a `secrets` entry on purpose — resolving it through the execution role
 * is the identity this step takes the read away from.
 *
 * It has to be an environment entry at all because `password_command.args` are
 * literal strings: nothing expands an `env.` reference inside them.
 */
export const GATEWAY_PASSWORD_ENV_NAMES = [PG_SECRET_ARN_ENV_NAME] as const;

/**
 * The gateway's runtime configuration (phase 2 item 10): the non-secret
 * `bifrost/config.json`, stored as an SSM parameter and injected as
 * `BIFROST_CONFIG`.
 *
 * Why a parameter rather than an `environment` entry with the JSON inlined in
 * the task definition: the file is 4,085 bytes today (`wc -c`, measured on
 * `deploy-workbench/bifrost/config.json`) and grows when item 14 adds teams and
 * virtual keys, and task-definition environment entries are the wrong place for
 * a document that changes on its own schedule. Why SSM rather
 * than Secrets Manager: the file holds no secret by construction - every
 * credential in it is an `env.NAME` reference, which `bifrost/config.test.ts`
 * enforces - so a secret container would buy nothing but a second out-of-band
 * write step for the value the repo already owns.
 *
 * `String`, not `SecureString`, and the reason is a permission rather than a
 * preference. A `SecureString` is encrypted with the account's `aws/ssm` key,
 * so the ECS agent would need `kms:Decrypt` on it; the key cannot be named
 * without a deploy-time `kms` lookup, and a wildcard key resource is the shape
 * every other policy in this module avoids. The parameter is therefore plain
 * text, in an account only the fleet's own roles can read, holding a file that
 * is in git. Nothing secret is lost, and `describe-parameter` stays a way to
 * see what the gateway is actually running with.
 *
 * Standard tier, which holds 4 KiB. The file is 4,085 bytes today, so there are
 * **11 bytes** of headroom, not the couple of kilobytes an earlier version of
 * this comment claimed; every addition from here is a deliberate byte budget
 * rather than free space. Past 4 KiB this needs `tier: "Advanced"` explicitly
 * (8 KiB, and AWS charges for it), because the provider would otherwise fail
 * the apply rather than truncate. `BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES`
 * below pins the ceiling and `ecs.test.ts` fails the suite before the file
 * crosses it, so the next person to add a provider finds out here rather than
 * in a failed apply.
 *
 * The leading slash is not decoration: SSM rejects a hierarchical name that is
 * not fully qualified, so `PutParameter` fails with "Parameter name must be a
 * fully qualified name" on anything shaped like `bifrost/config`. The ARN it
 * resolves to is still `...:parameter/bifrost/config`.
 * `deploy-infrastructure/group-sync-lambda.ts` (`GROUP_SYNC_PARAMETER_NAME`)
 * is the repo's other one and is written the same way.
 */
export const BIFROST_CONFIG_ENV_NAME = "BIFROST_CONFIG";
export const BIFROST_CONFIG_PARAMETER_NAME = "/bifrost/config";

/**
 * The standard tier's content limit for an SSM `String` parameter, in bytes.
 *
 * Named rather than written into a comment because `bifrost/config.json` is
 * 4,085 bytes today, which leaves 11 bytes of headroom: the margin is small
 * enough that the suite should fail when it is crossed, not a reviewer. An
 * over-limit value is rejected by `PutParameter` rather than truncated, so the
 * apply fails loudly, but only after a merge. Past this the parameter needs
 * `tier: "Advanced"` (8 KiB, charged).
 */
export const BIFROST_CONFIG_PARAMETER_STANDARD_TIER_BYTES = 4096;

/**
 * One committed classification of a `config.json` path: either a boot-only path
 * that `BIFROST_CONFIG_VERSION` must cover, or a live path the reconciler
 * (`docs/bifrost-reconciler.md`) converges without a restart.
 *
 * `path` is dotted, with two wildcards: `*` matches exactly one object key and
 * `[]` matches exactly one array index. `providers.*.keys[].value` is the entry
 * that forces this to be a path list rather than a list of top-level keys:
 * `providers` is a mixed section, where a key's `value` is boot-only (it holds
 * an `env.` reference only the task can resolve) while the same key's `models`,
 * `aliases` and `weight` all converge live. No set of top-level keys can say
 * that, which is why "just hash `providers`" is the bug this allowlist exists
 * to avoid: it rolls the task on an alias edit, which is the restart the plan
 * is written to remove.
 *
 * `subtree` claims every leaf below `path` (for a section whose whole contents
 * are on one side); otherwise the entry claims exactly the leaf at `path`.
 */
export interface BifrostConfigPathRule {
  readonly path: string;
  readonly subtree: boolean;
}

/**
 * The boot-only subset: what `BIFROST_CONFIG_VERSION` hashes, and therefore the
 * only part of `config.json` whose change rolls the task.
 *
 * From "The split" and decision 2 of `docs/bifrost-reconciler.md`: the two store
 * connection blocks are read once when the pools are built, `encryption_key`
 * cannot change without cleaning the database, `setup_token` is resolved at
 * boot, and a provider key's *value* is an `env.` reference that only the task
 * can resolve. `ecs.test.ts` walks every leaf of the committed file against this
 * list and its live counterpart in both directions, so an omission or an
 * over-claim is a failing test rather than a restart nobody can explain.
 *
 * Two leaves are classified here rather than in the plan, whose table does not
 * place them, and both calls are deliberate:
 *
 * - `source_of_truth` is **boot-only**. It is read at boot and decides pruning
 *   (`transports/bifrost-http/lib/config.go:454-459`, `:4752-4789`), and no
 *   admin route changes it, so a reconciler cannot converge it: a change would
 *   sit unapplied until a restart, which is the silent failure this digest
 *   exists to prevent. It is a constant that moves only with a deliberate
 *   source-of-truth decision (decision 16), and that decision should roll the
 *   task.
 * - `$schema` is **live**, i.e. excluded. It is an editor pointer with no
 *   runtime effect at any point, so a change to it can never require a boot.
 *   Excluding it is also the cheap direction of the asymmetry below.
 */
export const BIFROST_BOOT_ONLY_PATHS = [
  { path: "config_store", subtree: true },
  { path: "logs_store", subtree: true },
  { path: "encryption_key", subtree: false },
  { path: "setup_token", subtree: false },
  { path: "providers.*.keys[].value", subtree: false },
  { path: "source_of_truth", subtree: false },
] as const satisfies readonly BifrostConfigPathRule[];

/**
 * The live subset: everything the reconciler converges into the running process,
 * and therefore everything the digest must *not* cover.
 *
 * Committed for the same reason the boot-only list is, and not merely derived as
 * "whatever is left": the drift test needs both sides to be a statement, so a
 * leaf that lands on neither side fails the suite instead of quietly becoming
 * live by default. It is also what makes "an allowlist entry that claims a leaf
 * the reconciler converges live" a test failure: the two lists must partition
 * the file, so an overlap is a misclassification in one of them.
 *
 * Sources are the rows of "The split": `PUT /api/config` for `client`,
 * `PUT /api/providers/{provider}` for `network_config` and `prompt_cache`,
 * the key update route for `name`/`models`/`aliases`/`weight`/
 * `bedrock_key_config`, `PUT /api/models/catalog` for the catalog, and the
 * governance routes for `governance`.
 */
export const BIFROST_LIVE_PATHS = [
  { path: "$schema", subtree: false },
  { path: "client", subtree: true },
  { path: "governance", subtree: true },
  { path: "providers.*.network_config", subtree: true },
  { path: "providers.*.prompt_cache", subtree: true },
  { path: "providers.*.keys[].name", subtree: false },
  { path: "providers.*.keys[].models", subtree: true },
  { path: "providers.*.keys[].aliases", subtree: true },
  { path: "providers.*.keys[].weight", subtree: false },
  { path: "providers.*.keys[].bedrock_key_config", subtree: true },
] as const satisfies readonly BifrostConfigPathRule[];

/**
 * A digest of the configuration's *boot-only* contents, carried into the task
 * definition as an environment variable so that a change there reaches the
 * running gateway.
 *
 * Without it the seam is dead: the container's `secrets` entry names the
 * parameter's ARN (`valueFrom: configParameterArn`), and an ARN does not change
 * when the value does. A PR that edits a boot-only path in `config.json` would
 * update the parameter and leave every running task on the file it booted with,
 * which defeats "configuration is a reviewed PR" — the apply would look like it
 * had converged. A value that changes with that subset registers a new
 * task-definition revision, and the service's stop-before-start rollout picks
 * the new config up.
 *
 * **Not the whole file, any more.** `docs/bifrost-reconciler.md` splits the file
 * into what a declarative reconciler can converge into the running process
 * (client config, provider metadata, key models/aliases/weight, the model
 * catalog, governance) and what is only read at boot. Hashing the whole file
 * made every live edit — an alias, a model list, a retention day — register a
 * new revision and roll the task, which is the outage that plan exists to stop
 * paying for. So the digest is computed from the parsed JSON, over the leaves
 * that `BIFROST_BOOT_ONLY_PATHS` claims and nothing else. Parsed rather than
 * raw, because the question is "did a boot-only *value* change", and whitespace,
 * key order or a reformat is not a change: hashing the bytes answered a
 * different question and rolled the task for both.
 *
 * The failure mode of getting this classification wrong is asymmetric, and both
 * directions are pinned by `ecs.test.ts`:
 *
 * - A **boot-only leaf the allowlist misses** is a change that never rolls the
 *   task and therefore never applies. It is silent, and it is exactly the class
 *   of bug commit `75d30ae` was written to close. This is the direction the
 *   drift test exists for, and the one that must never be traded away.
 * - A **live leaf wrongly included** is a needless restart. It is visible (a
 *   revision and a task ARN that should not have moved) and it is cheap (a
 *   stop-before-start roll of one task), which is why the allowlist errs toward
 *   including a leaf when the classification is genuinely unclear.
 *
 * The digest, not the parameter resource's `version` output. That version is
 * assigned by AWS, so at preview time it is an unknown for any apply that
 * changes the file: Pulumi renders the whole `containerDefinitions` string as
 * its unknown sentinel (`04da6b54-80e4-46f7-96ec-b56ff0331ba9`), and the
 * pre-apply secret check in `scripts/preflight-secrets.ts` then has no task
 * definition to read. That is what failed run 40725087936 (the merge of #393):
 * the preflight could not parse the sentinel, the apply never ran, and the
 * bug looked like a preflight defect rather than the unknown it was. A digest
 * of the same values is computed here, in the program, so it is known at
 * preview; it also answers "which config is this task running" from
 * `describe-task-definition` more precisely than a counter does, because the
 * value identifies the content rather than the number of writes.
 *
 * The dependency on the parameter itself is unchanged: `BIFROST_CONFIG`'s
 * `valueFrom` names `configParameterArn`, so the task definition still waits
 * for the parameter update before it is registered.
 */
export const BIFROST_CONFIG_VERSION_ENV_NAME = "BIFROST_CONFIG_VERSION";

/**
 * How much of the digest is carried: enough that a collision is not a concern,
 * short enough to read in `describe-task-definition`.
 */
const BIFROST_CONFIG_VERSION_LENGTH = 12;

/** The wildcards a `BifrostConfigPathRule.path` may contain. */
const BIFROST_PATH_ANY_KEY = "*";
const BIFROST_PATH_ANY_INDEX = "[]";

const escapeRegExpLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One rule as a matcher over a leaf path such as `providers.fireworks.keys[0].value`. */
const bifrostPathRuleRegExp = (rule: BifrostConfigPathRule): RegExp => {
  const body = rule.path
    .split(".")
    .map((segment) =>
      segment === BIFROST_PATH_ANY_KEY
        ? "[^.[\\]]+"
        : segment
            .split(BIFROST_PATH_ANY_INDEX)
            .map(escapeRegExpLiteral)
            .join("\\[[0-9]+\\]"),
    )
    .join("\\.");
  // A subtree entry claims everything below its path, so the boundary is a
  // lookahead rather than the end of the string; a leaf entry ends there.
  return new RegExp(`^${body}${rule.subtree ? "(?=$|\\.|\\[)" : "$"}`);
};

/**
 * Every leaf of the parsed file, as `[path, value]` in document order. A leaf is
 * any non-object value, `null` included; an empty object or array contributes
 * none, which is why a rule that stops matching a leaf is a drift-test failure
 * rather than a silently empty digest.
 */
const bifrostConfigLeaves = (
  config: string,
): Array<readonly [string, unknown]> => {
  const out: Array<readonly [string, unknown]> = [];
  const walk = (value: unknown, at: string): void => {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      } else {
        for (const [key, entry] of Object.entries(
          value as Record<string, unknown>,
        )) {
          walk(entry, at ? `${at}.${key}` : key);
        }
      }
      return;
    }
    out.push([at, value]);
  };
  walk(JSON.parse(config), "");
  return out;
};

/** Every leaf path in the parsed file, in document order. */
export const bifrostConfigLeafPaths = (
  config: string = readBifrostConfig(),
): string[] => bifrostConfigLeaves(config).map(([at]) => at);

/**
 * The leaves a set of rules claims, in document order. Parameterised over the
 * rules so a test can hand it a deliberately broken list and check that the
 * failure it produces is the one the drift test is supposed to produce.
 */
export const bifrostConfigClaimedLeaves = (
  config: string,
  rules: readonly BifrostConfigPathRule[],
): string[] => {
  const matchers = rules.map(bifrostPathRuleRegExp);
  return bifrostConfigLeaves(config)
    .map(([at]) => at)
    .filter((at) => matchers.some((matches) => matches.test(at)));
};

/**
 * The digest's input: one `path=value` line per boot-only leaf, sorted by path so
 * that a reordering of keys in the file does not move the digest (key order is
 * not a boot-only fact) while any changed value does.
 *
 * Exported because the drift test asserts against exactly this string: "every
 * leaf whose path matches an allowlist entry is in the digest input, and every
 * leaf whose path does not is excluded" is a statement about this value, not
 * about the hash of it.
 */
export const bifrostConfigDigestInput = (
  config: string = readBifrostConfig(),
  rules: readonly BifrostConfigPathRule[] = BIFROST_BOOT_ONLY_PATHS,
): string => {
  const matchers = rules.map(bifrostPathRuleRegExp);
  return bifrostConfigLeaves(config)
    .filter(([at]) => matchers.some((matches) => matches.test(at)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([at, value]) => `${at}=${JSON.stringify(value)}`)
    .join("\n");
};

/**
 * What is wrong with the committed classification, in both directions, as
 * human-readable lines a test asserts is empty.
 *
 * Three failures, and the first is the one that matters: a leaf claimed by
 * neither list is unclassified, and an unclassified boot-only leaf is the
 * silent non-convergence this whole seam exists to prevent. A leaf claimed by
 * both is an allowlist entry that claims something the reconciler converges
 * live, which would turn every such edit into a restart. And a rule that
 * matches no leaf is a stale entry, which is how an allowlist rots.
 *
 * Deliberately not called from the digest itself. A Pulumi program that threw on
 * an unclassified leaf would turn a config edit into a failed apply with no way
 * to make progress from the change being applied; the suite is where the
 * classification is enforced, and the digest treats "unclaimed" as "live",
 * which is the cheap direction of the asymmetry.
 */
export const bifrostConfigClassificationProblems = (
  config: string = readBifrostConfig(),
  rules: {
    readonly bootOnly?: readonly BifrostConfigPathRule[];
    readonly live?: readonly BifrostConfigPathRule[];
  } = {},
): string[] => {
  const bootOnly = rules.bootOnly ?? BIFROST_BOOT_ONLY_PATHS;
  const live = rules.live ?? BIFROST_LIVE_PATHS;
  const leaves = bifrostConfigLeafPaths(config);
  const problems: string[] = [];

  const bootOnlyLeaves = new Set(bifrostConfigClaimedLeaves(config, bootOnly));
  const liveLeaves = new Set(bifrostConfigClaimedLeaves(config, live));

  for (const at of leaves) {
    const boot = bootOnlyLeaves.has(at);
    const liveClaimed = liveLeaves.has(at);
    if (boot && liveClaimed) {
      problems.push(
        `${at} is claimed by both the boot-only and the live path lists: it cannot both roll the task and be converged live`,
      );
    } else if (!boot && !liveClaimed) {
      problems.push(
        `${at} is claimed by neither list: it is unclassified, and a boot-only leaf here would change without ever applying`,
      );
    }
  }

  for (const [kind, list] of [
    ["boot-only", bootOnly],
    ["live", live],
  ] as const) {
    for (const rule of list) {
      if (!leaves.some((at) => bifrostPathRuleRegExp(rule).test(at))) {
        problems.push(
          `the ${kind} path "${rule.path}" matches no leaf in config.json: a stale allowlist entry, or a section the file lost`,
        );
      }
    }
  }

  return problems;
};

/**
 * The digest carried as `BIFROST_CONFIG_VERSION`: a prefix of the SHA-256 of the
 * boot-only leaves' `path=value` lines.
 *
 * Pure and sync and computed from the file, so a test can pin it without a
 * Pulumi runtime and `pulumi preview` can know it before anything is applied.
 */
export const bifrostConfigVersion = (
  config: string = readBifrostConfig(),
): string =>
  createHash("sha256")
    .update(bifrostConfigDigestInput(config), "utf8")
    .digest("hex")
    .slice(0, BIFROST_CONFIG_VERSION_LENGTH);

/** Where upstream's own container reads it from, and `APP_DIR` in its image. */
export const BIFROST_APP_DIR = "/app/data";
export const BIFROST_CONFIG_FILE_PATH = `${BIFROST_APP_DIR}/config.json`;

/**
 * The repo file the parameter is built from, read at deploy time so the
 * deployed configuration is the reviewed one and not a copy that can drift.
 */
export const BIFROST_CONFIG_SOURCE_PATH = path.resolve(
  __dirname,
  "bifrost/config.json",
);
export const readBifrostConfig = (): string =>
  fs.readFileSync(BIFROST_CONFIG_SOURCE_PATH, "utf8");

/**
 * The entry point and command that turn the injected variable into the file
 * Bifrost actually reads. This is upstream's own documented ECS shape
 * (`docs/deployment-guides/ecs.mdx` at the pinned tag): write `BIFROST_CONFIG`
 * to `/app/data/config.json`, then `exec` the image's entry point with its
 * normal argument so PID 1 is still upstream's script and the app dir checks
 * and signal handling are unchanged.
 *
 * `printf '%s'` rather than `echo`: the value is JSON and `echo` would add a
 * trailing newline to it, which is harmless to Bifrost but makes the on-disk
 * file differ from the reviewed one. `umask 077` keeps the file private to the
 * container user. A missing variable exits rather than starting a gateway on
 * defaults: a task with no configuration is exactly the state this closes.
 *
 * The warm in the middle is the memory fix for `password_command`. Bifrost's
 * two stores open separate pools with separate password caches
 * (`postgresconn.go`, "One cache per pool"), so `singleflight` collapses a
 * burst inside one pool and not across the two: the connections each store
 * makes while `initStores` runs can be two concurrent forks of a Python
 * `aws-cli` (71 MiB RSS each, measured) on a task with 0.44 vCPU.
 *
 * What the warm does and does not do, stated precisely because the difference
 * matters: it does not populate Bifrost's cache, which lives inside the process
 * the warm runs before and which nothing outside that process can reach. What
 * it warms is the page cache. On a cold task every `aws-cli` invocation faults
 * in the interpreter and botocore from the image layer, and running the command
 * once here, serially, does that faulting once and alone instead of twice at
 * the same moment while also contending for less than half a core. The first
 * connection in each pool then forks into an already-warm userland, so the
 * peak RSS overlap is short rather than the whole of two cold starts, and it
 * also puts the slow case before the process starts rather than inside its
 * store init, where a `password_command` timeout is fatal.
 *
 * The residual risk is honest: `cache_ttl` expiry can still produce two
 * concurrent forks later in the task's life. Those are cheap ones, with the
 * userland already resident, which is why the arithmetic in `ecs.test.ts` is
 * what decides whether the reservation is big enough rather than the warm
 * being treated as a guarantee.
 *
 * Deliberately tolerant of failure, and that is not sloppiness: the warm is an
 * optimisation, so a transient `GetSecretValue` error here must not be the
 * thing that kills a task. A real failure still surfaces on the first dial,
 * where `password_command`'s own timeout and error reporting apply and where
 * Bifrost retries rather than exits. Its output goes to `/dev/null`, so the
 * password never reaches a log, and it is bounded by the same 30 s
 * `config.json` gives the command itself so a hung CLI cannot hold the boot.
 */
export const BIFROST_CONTAINER_ENTRY_POINT = ["/bin/sh", "-c"] as const;
export const BIFROST_CONTAINER_COMMAND = [
  `if [ -z "$${BIFROST_CONFIG_ENV_NAME}" ]; then echo "${BIFROST_CONFIG_ENV_NAME} is not set" >&2; exit 1; fi; ` +
    `umask 077; ` +
    `printf '%s' "$${BIFROST_CONFIG_ENV_NAME}" > ${BIFROST_CONFIG_FILE_PATH} || exit 1; ` +
    `timeout ${BIFROST_PG_PASSWORD_TIMEOUT_SECONDS} ${BIFROST_PG_PASSWORD_CONTAINER_PATH} >/dev/null 2>&1 || true; ` +
    `exec /app/docker-entrypoint.sh /app/main`,
] as const;

/**
 * The sidecar's non-secret configuration that is *not* in the alpha
 * configuration file, as a table rather than a list of literals in the
 * container definition so the test can pin every value.
 *
 * The settings follow `agent-swarm/host/docker-compose.yml`'s `oauth2-proxy`
 * service, which is the working precedent in this repo, with these differences:
 *
 * - The sidecar runs with `--alpha-config` (`OAUTH2_PROXY_COMMAND`), because
 *   the provider, the upstreams, the listen address and the injected
 *   setup-token header are only expressible there. That moves three settings
 *   out of this table and into `bifrost/alpha-config.yaml`: the provider
 *   (`OAUTH2_PROXY_PROVIDER`), the upstream (`OAUTH2_PROXY_UPSTREAMS`, Bifrost
 *   in the same task rather than the swarm's `static://202`, since here the
 *   proxy is the reverse proxy) and the listen address
 *   (`OAUTH2_PROXY_HTTP_ADDRESS`). At v7.15.5 those flags are *removed* when
 *   alpha configuration is used — an edit that leaves them here would be
 *   silently ignored, not rejected — so they are gone from this table on
 *   purpose rather than by omission.
 * - `OAUTH2_PROXY_SET_XAUTHREQUEST` and `OAUTH2_PROXY_PASS_USER_HEADERS` are
 *   gone for the same reason: both are removed options under alpha
 *   configuration, and their replacements are `injectResponseHeaders` and
 *   `injectRequestHeaders` entries. Bifrost does not read `X-Forwarded-User` or
 *   `X-Auth-Request-User`; the only header it needs is the setup token the
 *   alpha configuration injects.
 * - `OAUTH2_PROXY_REDIRECT_URL` and `OAUTH2_PROXY_WHITELIST_DOMAINS` are this
 *   gateway's hostname, derived from `ingress.ts` rather than spelled again,
 *   so a hostname change cannot leave the Google callback pointing at the old
 *   name. They stay here: both survived into the core option set and still
 *   load from `OAUTH2_PROXY_*` with alpha configuration.
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
  OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE:
    OAUTH2_PROXY_ALLOWLIST_CONTAINER_PATH,
  OAUTH2_PROXY_REDIRECT_URL: `https://${BIFROST_HOSTNAME}/oauth2/callback`,
  OAUTH2_PROXY_REVERSE_PROXY: "true",
  OAUTH2_PROXY_COOKIE_SECURE: "true",
  OAUTH2_PROXY_COOKIE_SAMESITE: "lax",
  OAUTH2_PROXY_COOKIE_EXPIRE: "168h",
  OAUTH2_PROXY_COOKIE_REFRESH: "1h",
  OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "true",
  OAUTH2_PROXY_WHITELIST_DOMAINS: BIFROST_HOSTNAME,
};

/**
 * The actions each role is allowed. Exported as data so the test can assert
 * that neither contains a wildcard, and so "what may this identity do" is one
 * list to read rather than a policy document to parse.
 *
 * The execution role reads the two script-owned secrets and nothing else beyond
 * its managed policy; the task role invokes the enumerated models, reads the
 * one account-wide catalog listing that draws the dashboard's model list, and
 * reads the RDS-managed master secret, and does nothing else. No
 * `secretsmanager:*`, no `bedrock:*`, and one wildcard resource in the whole
 * file: the catalog read, which Bedrock gives no resource type to scope (see
 * `TASK_BEDROCK_READ_RESOURCES`).
 *
 * The database password used to be the execution role's, because ECS resolved it
 * into `PG_PASSWORD`. It is the task role's now: `password_command` runs inside
 * the container, so the call to `GetSecretValue` is made by the process that
 * assumes the task role, and a grant on the execution role would authorise an
 * identity that no longer makes the call (`docs/bifrost-zero-downtime-deploys.md`,
 * decision 20).
 */
export const EXECUTION_SECRET_ACTIONS = ["secretsmanager:GetSecretValue"] as const;

/**
 * The task role's one Secrets Manager action, and the reason it is not wider.
 *
 * The ECS agent is not in this path: the gateway's own `password_command`
 * (`bifrost/pg-password.sh` in the derived image) calls `GetSecretValue` on
 * the RDS-managed secret with the task role's container credentials. The
 * resource is that secret's exact ARN — no `-??????` pattern, because Pulumi
 * owns the describe that produced it (`database.secretArn`) and the ARN does
 * not change when RDS rotates the value in place.
 */
export const TASK_SECRET_ACTIONS = ["secretsmanager:GetSecretValue"] as const;

/**
 * The one action the config parameter needs, and no wider.
 *
 * The ECS agent resolves a `secrets` entry whose `valueFrom` is an SSM
 * parameter ARN with `ssm:GetParameters` (the plural form, since it batches).
 * Not `ssm:GetParameter`, not `ssm:GetParametersByPath`: the ARN names this one
 * parameter, so a path or `*` grant would widen a permission the gateway has no
 * use for.
 */
export const EXECUTION_PARAMETER_ACTIONS = ["ssm:GetParameters"] as const;

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
 *   a fixed model list. The one read it turned out to need is named, not
 *   wildcarded: `TASK_BEDROCK_READ_ACTIONS` below, added when bringing the
 *   service up showed the provider enumerating the catalog to render its model
 *   list.
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
 * The one Bedrock read the provider makes to render its model list.
 *
 * `ListModels` in Bifrost's Bedrock provider is a signed `GET
 * /foundation-models` against the Bedrock control plane, which is AWS's
 * `ListFoundationModels` (`core/providers/bedrock/bedrock.go`, `listModelsByKey`
 * at upstream tag `v2.3.0`). The dashboard's Model Providers page calls it, and
 * an identity without this action gets the provider's error instead of a list:
 *
 *     User: arn:aws:sts::024901689212:assumed-role/bifrost-task/... is not
 *     authorized to perform: bedrock:ListFoundationModels because no
 *     identity-based policy allows the bedrock:ListFoundationModels action
 *
 * The invoke set above serves a request; it does not draw the page. The two are
 * separate statements rather than one wider one because they take opposite
 * resource shapes: invoke names the models, this names nothing.
 *
 * Deliberately not here, each checked against the pinned provider rather than
 * assumed, because "the model list" suggests reads the provider never makes:
 *
 * - `bedrock:ListInferenceProfiles` / `bedrock:GetInferenceProfile`. Nothing at
 *   `v2.3.0` calls them. The `us.` and `global.` inference profiles
 *   `bifrost/config.json` allows are listed from the key's own `models`
 *   allowlist — the list pipeline backfills allowlist entries the
 *   foundation-model response does not contain (`BackfillModels` in
 *   `core/providers/utils/models.go`) — and invoked through their profile ARNs,
 *   which the invoke statement already grants.
 * - `bedrock:GetFoundationModel`, the singular describe. The list response
 *   carries the fields Bifrost reads.
 * - whatever the Mantle `/v1/models` call `listModelsByKey` also makes. That is
 *   best-effort: a failure is logged and the foundation-model list is returned
 *   anyway, and no model this deployment allows is Mantle-only, so it is not
 *   granted.
 */
export const TASK_BEDROCK_READ_ACTIONS = ["bedrock:ListFoundationModels"] as const;

/**
 * `ListFoundationModels` is account-wide, so its resource can only be `*`.
 *
 * Bedrock's service authorization reference defines no resource type for it —
 * not a model ARN, not a profile ARN — so a narrower `Resource` fails rather
 * than scoping the call. It is therefore the single wildcard in either role,
 * and it is named here once (rather than inline) so the wildcard checks in
 * `ecs.test.ts` can tell this deliberate one from an edit that widens
 * something else.
 */
export const TASK_BEDROCK_READ_RESOURCES = ["*"] as const;

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
 * The execution role's inline policy: read the two script-owned secrets the ECS
 * agent resolves into the containers. `bifrost/gateway` and
 * `bifrost/oauth2-proxy` are the plan's two. The RDS-managed master password is
 * deliberately not here any more: it is no longer a `secrets` entry, so the
 * agent never resolves it, and the container reads it with the task role
 * (`docs/bifrost-zero-downtime-deploys.md`, decision 20). Nothing else: the ECR
 * pull and the log writes come from the managed policy attached alongside it.
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
 * The execution role's second policy: read the one config parameter the task
 * injects as `BIFROST_CONFIG`. Kept separate from the secrets statement so
 * "what may this identity read" stays one statement per kind of resource
 * rather than one list of mixed ARNs.
 */
export const executionRoleConfigParameterPolicyDocument = (
  parameterArns: string[],
): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ReadConfigParameter",
      Effect: "Allow",
      Action: [...EXECUTION_PARAMETER_ACTIONS],
      Resource: parameterArns,
    },
  ],
});

/**
 * The task role's policy: invoke exactly the models in
 * `utils/bedrock-models.ts`, which is the same list the subscription script
 * walks and the same one `WorkbenchAccess` composes from. One list, so a model
 * added there is reachable by the gateway without a second edit, and a model
 * removed there is not.
 *
 * Plus the catalog read. Without it the gateway can serve inference but cannot
 * show its models: the dashboard's provider page asks Bifrost to list them and
 * `ListFoundationModels` is refused, which is the warning this pair of
 * statements fixes. The read is kept to the one action the provider calls, on
 * the one resource shape IAM permits for it — see
 * `TASK_BEDROCK_READ_ACTIONS` and `TASK_BEDROCK_READ_RESOURCES`.
 *
 * Plus the database password, which is the one secret this process reads itself:
 * `secretsmanager:GetSecretValue` on the RDS-managed secret's exact ARN, and
 * nothing wider. It is a third statement rather than part of either Bedrock one
 * because it is a different service and a different principal than the agent
 * that used to read it.
 */
export const taskRolePolicyDocument = (
  bedrockResources: string[],
  databaseSecretArns: string[],
): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "InvokeSelectedBedrockModels",
      Effect: "Allow",
      Action: [...TASK_BEDROCK_ACTIONS],
      Resource: bedrockResources,
    },
    {
      Sid: "ReadBedrockFoundationModelCatalog",
      Effect: "Allow",
      Action: [...TASK_BEDROCK_READ_ACTIONS],
      Resource: [...TASK_BEDROCK_READ_RESOURCES],
    },
    {
      Sid: "ReadDatabasePassword",
      Effect: "Allow",
      Action: [...TASK_SECRET_ACTIONS],
      Resource: databaseSecretArns,
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
   * The derived gateway image's repository, from `pg-password-image.ts`. It
   * replaces the mirror as the task's image, so it can run the
   * `password_command` the stores resolve (`docs/bifrost-zero-downtime-deploys.md`,
   * decision 20). Its tag is content-addressed on the command script and the
   * Dockerfile, so it comes from that module rather than from a literal; a
   * changed command is a new tag and a new task definition revision.
   *
   * `bifrost-image.ts` is still the module that owns the upstream pin, and the
   * mirror's repository is still created by `index.ts`; the derived image's
   * Dockerfile `FROM`s that pinned digest, and the drift tests hold the two
   * together.
   */
  gatewayRepositoryUrl: pulumi.Input<string>;
  /**
   * The derived oauth2-proxy image's repository, from `oauth2-proxy-image.ts`.
   * Its tag is content-addressed on the admin allowlist, so it comes from that
   * module rather than from a literal; a changed list is a new tag and a new
   * task definition revision.
   */
  oauth2ProxyRepositoryUrl: pulumi.Input<string>;
  /**
   * The derived bootstrap image's repository, from `bootstrap-image.ts`. Its
   * tag is content-addressed on the claim script and its Dockerfile, so it
   * comes from that module rather than from a literal; a changed claim is a
   * new tag and a new task definition revision.
   */
  bootstrapRepositoryUrl: pulumi.Input<string>;
  /**
   * The Cloud Map service the task registers itself into, so the vk-mint Lambda
   * has a name for the task that survives a replacement (step 3 of
   * `docs/bifrost-virtual-keys.md`; the reasoning is `discovery.ts`'s). The
   * service's ARN is the whole input: registration is one field on the ECS
   * service below, not a second resource here.
   */
  discovery: BifrostDiscovery;
}) => {
  const {
    provider,
    network,
    database,
    ingress,
    gatewayRepositoryUrl,
    oauth2ProxyRepositoryUrl,
    bootstrapRepositoryUrl,
    discovery,
  } = args;

  const imageUri = pulumi.interpolate`${gatewayRepositoryUrl}:${BIFROST_GATEWAY_TAG}`;
  const oauth2ProxyImageUri = pulumi.interpolate`${oauth2ProxyRepositoryUrl}:${OAUTH2_PROXY_TAG}`;
  const bootstrapImageUri = pulumi.interpolate`${bootstrapRepositoryUrl}:${BIFROST_BOOTSTRAP_TAG}`;

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
   * The gateway's runtime configuration, as the SSM parameter the task
   * injects. Pulumi owns it and its value is the reviewed `config.json`, so a
   * configuration change is a PR - and a change to the boot-only subset of it
   * registers a new task-definition revision rather than being a console edit,
   * which is what `source_of_truth: "config.json"` in the file expects.
   *
   * The file is read here rather than imported as an asset: the parameter's
   * value is a string, and an asset would make the diff depend on an uploaded
   * object key instead of the file's contents.
   *
   * Read once, into a constant, because the same bytes are also digested into
   * `BIFROST_CONFIG_VERSION` below; two reads could in principle disagree and
   * put a version on the task definition that does not describe the parameter.
   * The hash is computed here rather than in the task-definition block for the
   * same reason, and it is known at preview, which the parameter's own version
   * is not. See `BIFROST_CONFIG_VERSION_ENV_NAME`.
   */
  const bifrostConfig = readBifrostConfig();
  const configVersion = bifrostConfigVersion(bifrostConfig);
  const configParameter = new aws.ssm.Parameter(
    "bifrostConfigParameter",
    {
      name: BIFROST_CONFIG_PARAMETER_NAME,
      type: "String",
      value: bifrostConfig,
      description:
        "Bifrost gateway config.json (docs/bifrost-gateway.md phase 2 item 10); injected as BIFROST_CONFIG.",
      tags: { Name: BIFROST_CONFIG_PARAMETER_NAME },
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
   * two script-owned secrets have to be granted by a name pattern, since the
   * six random characters Secrets Manager appends are unknowable without a
   * describe this project's preview role may not make. The RDS-managed secret is
   * no longer here at all: the container reads it with the task role, so the
   * agent has nothing to resolve (`docs/bifrost-zero-downtime-deploys.md`,
   * decision 20).
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
          policy: JSON.stringify(
            executionRoleSecretsPolicyDocument([
              secretArnPattern(GATEWAY_SECRET_NAME),
              secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
            ]),
          ),
        },
        {
          name: "config-parameter",
          policy: configParameter.arn.apply((parameterArn) =>
            JSON.stringify(
              executionRoleConfigParameterPolicyDocument([parameterArn]),
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
   * account. The gateway is a proxy: it may invoke its models, read the one
   * account-wide catalog listing that draws its model list, read the one
   * database secret its own `password_command` resolves, and nothing else. The
   * invoke statement's `Resource` list is the model list rather than `*`; the
   * catalog statement's is `*` because Bedrock offers nothing to scope it to;
   * the secret statement is the RDS ARN and no wildcard.
   */
  const taskRole = new aws.iam.Role(
    "bifrostTaskRole",
    {
      name: TASK_ROLE_NAME,
      description:
        "Bifrost gateway task: invoke the models in utils/bedrock-models.ts, list the Bedrock catalog, read the RDS-managed database password, and nothing else.",
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
          // Built with `apply` because the secret statement's resource is the
          // RDS-managed secret's ARN, which is a Pulumi output (item 7's).
          policy: database.secretArn.apply((databaseSecretArn) =>
            JSON.stringify(
              taskRolePolicyDocument(bedrockInvokeResources(), [
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
   * The task definition, in the idiom of `deploy/components/worker.ts`.
   *
   * Differences from that one, each deliberate:
   *
   * - Two containers: Bifrost, and the oauth2-proxy sidecar that gates the
   *   admin surface. Item 8 shipped Bifrost alone; item 9 adds the sidecar
   *   once its image and secret references exist. A third, non-essential
   *   one-shot container (item 11) claims the deployment after the gateway is
   *   healthy; see `BIFROST_BOOTSTRAP_CONTAINER_NAME` above.
   * - No review bucket, no `AGENT_VERSION`, no metric filters: those are the
   *   delegate's concerns, not the gateway's.
   * - `cpu`/`memory` are 512/1024 rather than 1024/4096, per the plan's
   *   sizing, and the containers' own reservations split that total rather
   *   than each repeating it; see the constants above.
   * - The `secrets` block is not a list of keys read from a secret. It is the
   *   declared lists above, plus `BIFROST_CONFIG` from the SSM parameter; see
   *   the module header for why nothing here reads Secrets Manager. Bifrost gets
   *   `bifrost/gateway`'s five and `BIFROST_CONFIG`; the sidecar gets
   *   `bifrost/oauth2-proxy`'s three plus `bifrost/gateway`'s setup token,
   *   which the alpha configuration injects upstream. It gets no provider key,
   *   no encryption key and no admin username or password. The ECS agent
   *   resolves every entry before the container starts, so a key listed here and
   *   absent from the secret is a task that never starts: `fill-secrets.sh` has
   *   to write `BIFROST_SETUP_TOKEN` before a task definition naming it deploys,
   *   exactly as it already has to write the sidecar's three and the gateway's
   *   five. The database password is not one of them any more: it is not a value
   *   the agent can resolve once and forget, so `config.json` resolves it per
   *   physical connection and the gateway image's `password_command` prints it
   *   (`PG_SECRET_ARN_ENV_NAME`, `docs/bifrost-zero-downtime-deploys.md`
   *   decision 20).
   * - The environment carries `AWS_REGION`, because the Bedrock provider needs
   *   a region (the delegate sets `AWS_DEFAULT_REGION` for the same reason),
   *   the four non-secret Postgres values `config.json` resolves by name, and
   *   `PG_SECRET_ARN` for the password command. The sidecar has no AWS
   *   configuration at all: it is a Google OAuth proxy.
   * - The entry point is overridden, which the delegate's container does not
   *   do. Upstream's own ECS guide is the reason: the gateway has to write the
   *   injected config to `/app/data/config.json` before Bifrost starts, and
   *   ECS has no init-container equivalent here. `BIFROST_CONTAINER_COMMAND`
   *   writes it, warms the password command once and then `exec`s the image's
   *   own entry point, so PID 1, signal handling and the app-dir checks stay
   *   upstream's. The warm is there because the two stores open separate
   *   password caches; see the constant's own comment.
   *
   * Every value that comes from another resource is put through one `pulumi.all`
   * *before* the object is built, including `logGroup.name`, `database.address`,
   * `database.port` and `configParameter.arn`. An `Output`
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
      bootstrapImageUri,
      database.secretArn,
      database.address,
      database.port.apply(String),
      logGroup.name,
      configParameter.arn,
    ])
    .apply(
      ([
        resolvedImage,
        resolvedOauth2ProxyImage,
        resolvedBootstrapImage,
        databaseSecretArn,
        databaseAddress,
        databasePort,
        resolvedLogGroupName,
        configParameterArn,
      ]) => [
        {
          name: BIFROST_CONTAINER_NAME,
          image: resolvedImage,
          cpu: BIFROST_CONTAINER_CPU,
          memory: BIFROST_CONTAINER_MEMORY,
          essential: true,
          healthCheck: BIFROST_HEALTH_CHECK,
          // Fargate's maximum, and the reason is the shutdown the container
          // is given: ECS's default of 30s is the same 30s the process allows
          // its own cleanup after draining, so the final budget dump races the
          // kill. See `BIFROST_STOP_TIMEOUT_SECONDS`.
          stopTimeout: BIFROST_STOP_TIMEOUT_SECONDS,
          // Upstream's documented ECS shape (`docs/deployment-guides/ecs.mdx`
          // at the pinned tag): the injected config becomes the file Bifrost
          // reads, and then the image's own entry point starts the process.
          entryPoint: [...BIFROST_CONTAINER_ENTRY_POINT],
          command: [...BIFROST_CONTAINER_COMMAND],
          portMappings: [
            {
              containerPort: BIFROST_PORT,
              hostPort: BIFROST_PORT,
              protocol: "tcp",
            },
          ],
          environment: [
            { name: AWS_REGION_ENV_NAME, value: REGION },
            { name: PG_HOST_ENV_NAME, value: databaseAddress },
            { name: PG_PORT_ENV_NAME, value: databasePort },
            { name: PG_USER_ENV_NAME, value: DATABASE_USERNAME },
            { name: PG_DATABASE_ENV_NAME, value: DATABASE_NAME },
            // Where the password comes from, for the `password_command` both
            // stores now declare. The ARN is an identifier, not a credential:
            // the read is the task role's, and the value never reaches this
            // container's environment. It cannot be an argument of the command
            // instead -- `password_command.args` are literal strings and
            // nothing expands an `env.` reference in them.
            { name: PG_SECRET_ARN_ENV_NAME, value: databaseSecretArn },
            // A boot-only config change has to roll the task; see the
            // constant. This is a digest computed from the file in this
            // program, over the boot-only subset only, deliberately not the
            // parameter's preview-unknown version output: an unknown here
            // collapses the whole `containerDefinitions` string into Pulumi's
            // unknown sentinel, which is unreadable to the pre-apply secret
            // check.
            {
              name: BIFROST_CONFIG_VERSION_ENV_NAME,
              value: configVersion,
            },
          ],
          secrets: [
            ...GATEWAY_SECRET_KEYS.map((key) => ({
              name: key,
              valueFrom: secretReference(GATEWAY_SECRET_NAME, key),
            })),
            // The one `secrets` entry that is not a secret: an SSM parameter
            // ARN. ECS resolves it through the execution role's
            // `ssm:GetParameters` grant and hands the value to the entry point
            // above as an environment variable.
            {
              name: BIFROST_CONFIG_ENV_NAME,
              valueFrom: configParameterArn,
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
          // considered and rejected: the sidecar is given its Google pair, its
          // cookie secret and the setup token unconditionally, so a proxy that
          // will not start is a missing or wrong value in Secrets Manager, and
          // a task that never stabilizes is the visible failure. The
          // fail-closed property does not depend on this flag: the ALB has no
          // rule that sends an admin path to Bifrost at all.
          essential: true,
          // The image's entrypoint is upstream's own: with dashboard auth off
          // there is no Basic credential to compute, and the header value the
          // alpha file injects is the setup token the secret below already
          // provides. This argument is the alpha configuration that carries
          // the provider, the upstream, the listen address and the header.
          command: [...OAUTH2_PROXY_COMMAND],
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
          secrets: [
            ...OAUTH2_PROXY_SECRET_KEYS.map((key) => ({
              name: key,
              valueFrom: secretReference(OAUTH2_PROXY_SECRET_NAME, key),
            })),
            // The setup token the baked alpha configuration injects as
            // `X-Bifrost-Setup-Token`, read from `bifrost/gateway`. That is
            // what satisfies Bifrost's OSS setup lock while dashboard auth is
            // off, so a human who passed the Google gate lands on the
            // dashboard rather than on the setup page.
            ...OAUTH2_PROXY_GATEWAY_SECRET_KEYS.map((key) => ({
              name: key,
              valueFrom: secretReference(GATEWAY_SECRET_NAME, key),
            })),
          ],
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
        {
          name: BIFROST_BOOTSTRAP_CONTAINER_NAME,
          image: resolvedBootstrapImage,
          // No cpu/memory reservation: the two containers above already sum to
          // the task's 512/1024, and this one lives for seconds. Fargate lets
          // an unreserved container draw on what is not reserved.
          //
          // Non-essential, so a claim that cannot run (a password upstream's
          // policy rejects, a gateway that never goes healthy) leaves the
          // gateway serving inference and surfaces as this container's log
          // stream and stopped reason, not as a task that never starts. The
          // Logs Insights / metric-filter alarm that would make it a page is a
          // follow-up; there is no alerting target in this account yet.
          essential: false,
          environment: [
            {
              name: BIFROST_API_BASE_URL_ENV_NAME,
              value: BIFROST_API_BASE_URL,
            },
          ],
          secrets: BIFROST_BOOTSTRAP_SECRET_KEYS.map((key) => ({
            name: key,
            valueFrom: secretReference(GATEWAY_SECRET_NAME, key),
          })),
          // ECS's condition, not Docker's HEALTHCHECK: the claim needs a
          // gateway that has finished loading its config store, and this is
          // the only way to state that in a task definition.
          dependsOn: [
            { containerName: BIFROST_CONTAINER_NAME, condition: "HEALTHY" },
          ],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": resolvedLogGroupName,
              "awslogs-region": REGION,
              // Its own prefix, so the claim's output is one filterable stream
              // rather than a line among the gateway's request logs.
              "awslogs-stream-prefix": BIFROST_BOOTSTRAP_LOG_STREAM_PREFIX,
            },
          },
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
   *
   * `healthCheckGracePeriodSeconds` is set for the same reason: the provider
   * default is 0, which lets the ALB's target-group check replace a task while
   * it is still running its store migrations. See the constant.
   *
   * The deployment circuit breaker is the one knob here that is about a deploy
   * that has already failed rather than one in progress: a revision that cannot
   * become healthy rolls back to the previous one by itself. See
   * `DEPLOYMENT_CIRCUIT_BREAKER`.
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
      // A revision that cannot become healthy rolls itself back to the last one
      // that did, instead of sitting at running 0 / desired 1 until someone
      // notices. `verify-service.ts` detects that state; only ECS can undo it.
      // Called out in the service doc comment above.
      deploymentCircuitBreaker: DEPLOYMENT_CIRCUIT_BREAKER,
      /**
       * The task's stable name inside the VPC, `bifrost.workbench.local`.
       *
       * Added by step 3 of `docs/bifrost-virtual-keys.md`, and the reason is
       * worth stating here because this file's header used to say there was no
       * service discovery on purpose (which was true of the ALB/sidecar hop —
       * those two containers share a namespace and use `127.0.0.1:8080`). The
       * vk-mint Lambda is outside the task's namespace and has to reach the
       * admin API on 8080, which `/api` through the ALB cannot serve (Google
       * SSO). The task's ENI address changes on every replacement, so the name
       * has to come from the scheduler; `discovery.ts` records the
       * alternatives that were rejected.
       *
       * Registration is per-task, so the record follows a replacement after the
       * namespace's 10-second TTL.
       */
      serviceRegistries: { registryArn: discovery.service.arn },
      healthCheckGracePeriodSeconds: BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS,
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
    /**
     * The `/bifrost/config` parameter, so the reconciler's read grant can name
     * its ARN. It is returned rather than re-read because a `get` here would be
     * a second statement of the name, and the grant and the resource have to
     * agree about which parameter the loop reads.
     */
    configParameter,
    /** For a stack output, so a human can find the task without the console. */
    containerName: BIFROST_CONTAINER_NAME,
    /** The sidecar's container name, for the same reason. */
    oauth2ProxyContainerName: OAUTH2_PROXY_CONTAINER_NAME,
  };
};
