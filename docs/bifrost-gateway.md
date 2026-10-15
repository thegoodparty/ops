# Bifrost model gateway in the Workbench account

> **Status: proposal, decisions settled in review. Nothing has been deployed.**
> This document is the plan for putting GoodParty's coding harnesses behind a
> single self-hosted model gateway,
> [`maximhq/bifrost`](https://github.com/maximhq/bifrost), running in the
> `goodparty-workbench` account. It records the decisions, the reasoning and
> the few things that still need a human. It changes no infrastructure.

Today every harness reaches a model provider directly. The container ships
Fireworks credentials, and the workbench account hands each engineer a
`WorkbenchAccess` session that invokes Bedrock directly. That means provider
keys and Bedrock invocations are spread across laptops, containers and
identity, and there is nowhere to see or cap what the fleet spends. A gateway
in the middle is one place for routing, credentials, budgets and
observability.

This is the gateway's plan. It is the sibling of
[`workbench-account.md`](./workbench-account.md), which is the account's plan
and names "any future shared gateway or metering proxy for those agents" as
something that belongs in the workbench account. Read that first for the
account vocabulary, the SCP and the guardrails this plan has to live under.

## Objective and success criteria

Move coding harnesses off direct provider access and onto one gateway, without
losing the ability to code when the gateway is down.

Success, in the order it should be proven:

1. **One endpoint.** A coding harness reaches a model through
   `https://bifrost.workbench.goodparty.org` with a gateway credential, and
   never with a provider key. `gp-pi`, Claude Code and Codex CLI are the first
   three harnesses to prove it.
2. **One credential model.** An engineer gets a gateway virtual key, not a
   Fireworks key and not a Bedrock session. Revoking the key stops the traffic;
   nothing else has to be rotated.
3. **Budgets that bind.** Per-engineer and per-team spend is visible in the
   gateway and capped by it, independent of the account's billing alert.
4. **Metadata only.** Prompt and completion bodies are not persisted by the
   gateway, matching the workbench account's existing Bedrock invocation
   logging posture. See "Observability".
5. **A rollback that does not depend on the gateway.** Direct provider access
   stays in place until the last phase, and a documented break-glass path
   survives it.
6. **No new data boundary.** The gateway runs in the account that already
   exists to keep coding agents away from product and voter data.

Explicitly not a success criterion: high availability. Bifrost OSS is a
single-node product (see "One node, because OSS is one node"), and the
workbench account is deliberately not an SLO-bearing account.

## Where it runs, and why

### The workbench account is this repo's own answer

The account taxonomy in `workbench-account.md` is three buckets: product
environments, operational infrastructure, and the developer inner loop. A
model gateway for coding harnesses is the inner loop. The workbench document's
"What belongs here" lists "any future shared gateway or metering proxy for
those agents" by name, and the infrastructure document's "What belongs here"
excludes "the developer inner loop (that is the workbench account)" in the
same breath. So the placement is not a new decision; it is the one the account
was created to hold.

Two consequences of that placement are worth stating rather than discovering:

- **The workbench SCP binds the gateway, including the pipeline that
  maintains it.** Anything the SCP denies is denied to `pulumi-deploy` and to
  Bifrost. The relevant denies are in "What the policy denies" in
  `workbench-account.md` and in `deploy-org/policies.ts` (`DenyDataStores`,
  `DenyOutsideHomeRegion`, `DenyS3OutsideThisAccount`): `rds:*`,
  `dynamodb:*`, `redshift:*`; everything outside `us-west-2` except a
  `NotAction` list of global services plus `bedrock` and `aws-marketplace`;
  and `s3:*` on buckets the account does not own. The gateway needs RDS, so
  the `rds:*` deny is removed in its own small PR before the database is
  created. Everything else the gateway needs — ECS, ECR, ELB, ACM, Route 53,
  CloudWatch, Secrets Manager, KMS — is inside the region and not denied.
- **No product or voter data enters the account.** The gateway must not
  become a way around that. Content logging is off for this reason, not only
  for cost. Relaxing `rds:*` widens what the account can run but not what data
  may live in it; the RDS instance is private and holds gateway configuration
  and request metadata, nothing else.

### One node, because OSS is one node

Bifrost draws its OSS/Enterprise line at clustering. The upstream
`docs/deployment-guides/how-to/multinode.mdx` states it plainly: running
multiple OSS nodes with a Postgres backend is **not supported**, because OSS
keeps provider configs, keys, budgets and usage in memory and does not read
them back; Enterprise synchronizes them with a Raft variant. OSS is sized for
"3,000–5,000 RPS on a single instance", which is orders of magnitude above
this workload.

So the plan is one task, and the only honest HA options are Enterprise
(licensing, out of scope) or a rebuild-and-restore procedure. A second task
behind the same ALB is not a valid configuration and should not be built "just
in case". RDS Multi-AZ protects the database, not the gateway process.

### Compute: ECS Fargate

The gateway is a stateless container once its state is in RDS, so Fargate is
the right shape and the engineer's preference. There is no host to patch, no
EBS volume to snapshot and no SSM host association; the delegate worker's task
definition is the idiom to copy.

Recommended shape, all in `deploy-workbench/` and all taking the explicit
provider that project requires:

- **One `aws.ecs.Cluster`** with container insights enabled.
- **One `aws.ecs.TaskDefinition`**, `requiresCompatibilities: ["FARGATE"]`,
  `networkMode: "awsvpc"`, with the execution role carrying
  `AmazonECSTaskExecutionRolePolicy` plus `secretsmanager:GetSecretValue` on
  the gateway secret, a separate task role, `secrets` injected from Secrets
  Manager, `awslogs` log configuration and `linuxParameters.initProcessEnabled`.
  This mirrors `deploy/components/worker.ts`, the delegate's task definition,
  which is the working example in this repo of the same shape.
- **One `aws.ecs.Service`**, `desiredCount: 1`, `launchType: "FARGATE"`,
  registered against the ALB target group, in the private subnets, with a
  security group that accepts port 8080 only from the ALB security group.
  The repo has no long-running ECS service yet — the delegate dispatches
  ephemeral tasks — so this is the one genuinely new resource, and it should
  follow the same role and secret patterns.
- **Sizing:** 0.5 vCPU / 1 GB (512/1024) to start, per the upstream ECS
  guide. Bifrost adds microseconds of overhead and the load is per-engineer;
  the task size is a one-line change if it needs to grow.
- **Egress:** the task needs NAT (or VPC endpoints for ECR, Secrets Manager,
  CloudWatch and S3) to pull the image, read secrets, write logs and reach
  the provider APIs.
- **The task role is the Bedrock credential.** Upstream's Bedrock provider
  supports "Inherited AWS Credentials / IAM Role"
  (`docs/providers/supported-providers/bedrock.mdx`), and on Fargate that is
  the task role. No static AWS key is stored anywhere. The role is scoped to
  the model list in `utils/bedrock-models.ts`, and the SCP's existing
  `bedrock` exemption keeps geo-profile calls working.

Alternatives considered and not chosen: the EC2 + EBS + DLM host pattern in
`deploy-infrastructure/agent-swarm.ts` (the engineer's direction is Fargate,
and RDS removes the reason that pattern exists), and ECS on EC2. Neither is
needed.

### State: RDS Postgres

Bifrost's `config_store` (providers, virtual keys, teams, budgets) and
`logs_store` (request records) both go in RDS for PostgreSQL, which is the
robust answer and the engineer's direction. Details, backup and upgrade are in
"Persistence, backup and upgrade".

This needs the one SCP change:

- **Prerequisite PR:** remove `rds:*` from `DenyDataStores` in
  `deploy-org/policies.ts`. The grant to `github-actions-org-deploy` is
  already scoped to the `Workbench` OU (`ServiceControlPolicyAttachment` and
  `ServiceControlPolicyListingForTarget`), so no grant PR is needed in front
  of it; the policy edit applies through `deploy-org.yml`. `dynamodb:*` and
  `redshift:*` stay denied. This is a deliberate change to the account's data
  boundary, so it is reviewed as one, and the `DenyS3OutsideThisAccount`
  statement that keeps a coding agent off the management account's buckets is
  untouched.

SQLite remains a local-development fallback only; it is not the deployed
store.

### The repository facts this plan is built on

Cited so the next session can check them rather than trust this document:

| Fact | Source |
| --- | --- |
| Workbench account `024901689212`, `us-west-2` | `utils/accounts.ts`, `docs/workbench-account.md` |
| Pulumi project `deploy-workbench/`, stack `organization/workbench/main` | `deploy-workbench/Pulumi.yaml`, `deploy-workbench/index.ts` |
| CI deploy role `github-actions-workbench-deploy`, workflow `.github/workflows/deploy-workbench.yml` | `.github/workflows/deploy-workbench.yml` |
| Explicit provider, `allowedAccountIds`, default provider disabled | `deploy-workbench/index.ts`, `deploy-workbench/deploy.sh` |
| SCP denies `rds`/`dynamodb`/`redshift` (`DenyDataStores`), non-`us-west-2`, cross-account S3 | `deploy-org/policies.ts`, `docs/workbench-account.md` "What the policy denies" |
| ECS Fargate task-definition idiom (execution role, task role, secrets, awslogs) | `deploy/components/worker.ts`, `deploy/index.ts` |
| Account budget `workbench-monthly-spend` | `deploy-workbench/index.ts` |
| Bedrock invocation logging, metadata only, 365-day retention | `deploy-workbench/index.ts` |
| Identity Center `WorkbenchAccess`/`Engineers`, `AdministratorAccess`/`Admins` | `deploy/components/identity-center.ts`, `docs/workbench-account.md` |
| Secrets live in Secrets Manager, written out of band | `docs/workbench-account.md` (`gp-pi/brave-search`), `deploy-infrastructure/agent-swarm.ts` (`DELEGATE_SWARM`) |
| Delegated DNS subzone pattern | `deploy-infrastructure/dns.ts`, `deploy/components/infra-zone-delegation.ts` |
| Delegate image push to ECR | `.github/workflows/deploy.yml` (`delegate-worker`) |

The workbench account has only the default VPC today, and no Route 53 hosted
zone. The plan creates the network it needs; see "VPC" below. The
infrastructure account's `vpc-0930cabea81245d01` /
`subnet-0184e0f40b440ab13` are hardcoded in
`deploy-infrastructure/agent-swarm.ts` and belong to that account, not this
one.

## Network, TLS and ingress

### VPC

The workbench account has only the default VPC. The plan creates what it
needs during implementation rather than treating the network as an open
question:

- Two public subnets across two availability zones for the ALB.
- Two private subnets across the same two zones for the Fargate task and the
  RDS instance, with NAT egress (or VPC endpoints) for the task.
- A DB subnet group spanning the two private subnets, which RDS requires.
- Security groups: ALB → task on 8080, task → RDS on 5432, and nothing
  inbound to the task or the database from anywhere else.

A new VPC with a private/`/24`-per-AZ layout is the default plan. Using the
default VPC is acceptable for a first apply if it is faster, but the end state
above is the one to build toward, and the SCP's region and cross-account S3
denies do not interfere with any of it.

### TLS and DNS

- An internet-facing Application Load Balancer, HTTPS listener on 443 with an
  ACM certificate in `us-west-2`, and an HTTP listener that redirects to
  HTTPS. Target group on port 8080, health check `/health`.
- A Route 53 alias record for `bifrost.workbench.goodparty.org` pointing at
  the ALB.
- The workbench account owns no zone today, and review settled on giving it
  one. The repo's pattern is a delegated subzone: the infrastructure account
  owns `infra.goodparty.org`, created in `deploy-infrastructure/dns.ts` and
  delegated from the management account by the NS record in
  `deploy/components/infra-zone-delegation.ts`. The workbench account gets the
  same treatment — a `workbench.goodparty.org` zone in `deploy-workbench/`,
  delegated by one NS record added to `deploy/` in the management account.
  `bifrost.workbench.goodparty.org` is then a record the workbench stack owns.
- Reusing `infra.goodparty.org` is rejected: that zone is documented as
  "shared by every service in this account" (the infrastructure account), and
  a workbench record in it would need cross-account Route 53 write or a
  management-account PR for every name. A second delegated subzone is one NS
  record ever.

The NS delegation is the only management-account change this plan needs, and
it is a cross-project dependency in the sense of "Cross-project dependencies"
in `workbench-account.md`: the NS record must exist before ACM validation can
succeed.

### How a coding harness reaches it

Harnesses speak to provider-shaped paths on the same host, which is what makes
Bifrost a drop-in:

| Harness | Base URL | Credential header |
| --- | --- | --- |
| Claude Code / pi (Anthropic shape) | `https://bifrost.workbench.goodparty.org/anthropic` | `ANTHROPIC_AUTH_TOKEN` (virtual key) |
| Codex CLI | `https://bifrost.workbench.goodparty.org/openai/v1` | `OPENAI_API_KEY` (virtual key) |
| OpenCode | `https://bifrost.workbench.goodparty.org/openai` | virtual key |
| Gemini CLI | `https://bifrost.workbench.goodparty.org/genai` | `x-goog-api-key` (virtual key) |

The upstream `docs/quickstart/cli/coding-agents.mdx` (fetched from the
`main` branch, which is ahead of the pinned tag on this page) documents a
`bifrost` CLI that launches these harnesses against a context and a
credential, and `bifrost configure claude|codex` writes the endpoint and
virtual key into the harness's own config with an `unconfigure` that restores
the previous files. That is the intended ergonomics, and it is also the
migration tool: a harness is moved by configuration, not by code.

How the credential actually reaches an engineer's machine and the `gp-pi`
container is deliberately **not designed here**. Review settled on proving the
gateway out first and closing that loop afterwards; see "Migration", phase E.

### Public, with virtual keys

Review confirmed the public shape: an internet-facing HTTPS endpoint with
virtual-key enforcement, because it works from anywhere a harness runs,
including the cloud container, without depending on private-network
reachability. The threat model to weigh is not "can someone reach port 443";
it is "can someone get a virtual key", and the key is the control.

Inference paths (`/v1/*`, `/anthropic/*`, `/openai/*`, `/genai/*`, `/health`,
and `/metrics` if scraped) are open at the network layer and gated by virtual
keys. The admin surface is not.

### Protecting the admin surface

Bifrost OSS protects its dashboard and management API with a single
admin username and password (`governance.auth_config` in
`docs/deployment-guides/config-json/governance.mdx`). It has **no native
OIDC/SSO in OSS**: OAuth 2.0/OIDC user provisioning, SCIM, role mapping and
the ALB identity-aware-proxy integration are all Enterprise
(`docs/enterprise/user-provisioning.mdx`,
`docs/enterprise/auth-proxy/aws-alb.mdx`; the OSS
`features/sso-with-google-github` page is a "Coming soon" stub). The decision
is therefore to get SSO from the infrastructure in front of Bifrost, not from
Bifrost:

- An ALB listener rule for the admin paths (`/`, `/api/*`) carries an
  `authenticate-oidc` action before the forward action, so an unauthenticated
  request never reaches Bifrost. The inference paths are on a different rule
  with no OIDC action, because harnesses cannot do a browser redirect.
- Access is restricted to an admin group. ALB `authenticate-oidc`
  authenticates but does not authorize by group, and Bifrost OSS cannot read
  OIDC group claims, so the group restriction is enforced at the identity
  provider by scoping the OAuth application to the admin group. The OSS admin
  username/password stays as the second layer inside that.
- **Caveat to settle at implementation:** ALB's OIDC action needs a
  standards-compliant OIDC provider. AWS Identity Center is not itself an
  ALB-compatible OIDC IdP — its OIDC/SAML support is for AWS access, and
  there is no documented mapping of its endpoints to the ALB action (AWS's
  own documentation and re:Post threads say as much). The practical IdP is
  the one Identity Center already federates from (for example Google
  Workspace) or Amazon Cognito brokering Identity Center. Which one is used is
  an implementation question, not a blocker; what is decided is that the
  admin surface sits behind OIDC restricted to admins, and that Enterprise
  SSO is the alternative if the group enforcement proves awkward.

## Configuration as code

Review asked whether the configuration can be managed with IaC. It can, and it
should, in the repo's existing idiom. There are three layers, and only the
third holds secret values:

1. **Infrastructure is Pulumi.** The VPC, ALB, ACM certificate, Route 53
   record, ECS cluster, task definition, ECS service, RDS instance, security
   groups, IAM roles, log group and secret *containers* are all resources in
   `deploy-workbench/`, taking the explicit provider that project requires.
   This is the same project that already holds the account's budget and
   Bedrock logging configuration in `deploy-workbench/index.ts`.
2. **Bifrost's own configuration is a file in the repo.** A non-secret
   `config.json` lives under `deploy-workbench/` (for example
   `deploy-workbench/bifrost/config.json`) and holds the providers, the
   client settings, and the `governance` block — teams, budgets and virtual
   keys — with an `env.` reference everywhere a secret would otherwise be.
   Pulumi stores it as an SSM SecureString (or Secrets Manager entry) and
   injects it as `BIFROST_CONFIG`; the container entrypoint writes it to
   `/app/data/config.json`, which is the shape the upstream ECS guide
   documents. A change to it is a reviewed PR, not a console edit.
   `source_of_truth: "config.json"` makes the file authoritative for the
   sections it declares, so a redeploy converges to the repo instead of
   preserving UI drift; the upstream "missing vs empty" caveat in
   `docs/deployment-guides/config-json/source-of-truth.mdx` is the thing to
   watch (an omitted section is left alone, an empty one prunes).
3. **Secrets are in Secrets Manager, written out of band.** Provider keys
   (`FIREWORKS_API_KEY`, and any other provider), `BIFROST_ENCRYPTION_KEY`,
   the admin credential and the virtual-key values (`VK_*`) are secret values.
   Pulumi creates the secret containers and the read grants; the values are
   written out of band with the same procedure `DELEGATE_SWARM` and
   `gp-pi/brave-search` use. Nothing secret is committed, and nothing secret
   appears in this document.

The `governance` block supports `value: "env.VK_ENGINEER"` on a virtual key
(`docs/deployment-guides/config-json/governance.mdx`), which is what makes the
structure code and the token a secret: the key's id, provider/model scope and
team live in the file; the `sk-bf-*` value comes from Secrets Manager. Teams
and budgets are declarative in the same block. Rotating a key is changing one
secret value, not editing the file.

## Provider configuration

Bifrost takes providers from `config.json` and its config store. Provider keys
are referenced by name, never written down here or in git.

- **Fireworks** is the provider the fleet uses today. Upstream supports it as
  an OpenAI-compatible provider
  (`docs/providers/supported-providers/fireworks.mdx`), including
  `use_anthropic_endpoints` for harnesses that speak the Anthropic Messages
  shape. The key is `env.FIREWORKS_API_KEY`, injected from Secrets Manager,
  and the config allows only the models the fleet actually uses rather than
  `*`.
- **Bedrock** is the second provider. Upstream supports inherited IAM-role
  authentication (`docs/providers/supported-providers/bedrock.mdx`), and on
  Fargate that is the ECS task role, so no static AWS key is stored anywhere.
  The task role is scoped to the model list in `utils/bedrock-models.ts`, and
  the SCP's existing `bedrock` exemption keeps geo-profile calls working. This
  is what lets the gateway take over Bedrock entirely, including the per-user
  attribution the invocation log provides today.
- **Other providers** (Anthropic direct, OpenAI direct) are added only if a
  harness needs them, each with its own `env.` reference. Provider fallback
  between Fireworks and Bedrock is a configuration choice; it is the main
  reliability argument for the gateway, and it should be turned on
  deliberately with a model mapping rather than left to a default.

Note that Bifrost's own **AWS Secrets Manager vault integration
(`vault_store`) is an Enterprise feature** requiring a Postgres config store
(`docs/deployment-guides/config-json/secret-management.mdx`). On OSS the
supported pattern is `env.` references injected by the platform, which is what
this plan uses. Do not plan around `vault.*` references unless Enterprise is
on the table.

## Virtual keys and the credential model

Virtual keys are Bifrost's primary governance entity
(`docs/features/governance/virtual-keys.mdx`). The model:

- **Inference auth is mandatory.** Set
  `client.enforce_auth_on_inference: true`, so a request with no virtual key
  is refused. The OSS default is permissive, and a gateway that forwards
  anonymous traffic to a provider key is worse than no gateway.
- **One virtual key per engineer**, named with the engineer's username, plus
  one per non-human caller (the delegate worker, any CI job). The key is
  `sk-bf-*` and is presented via the header each harness expects — the same
  key can be used as `x-bf-vk`, `Authorization: Bearer`, `x-api-key` or
  `x-goog-api-key`, which is why one key works across Claude Code, Codex and
  Gemini CLI.
- **A team per group of humans.** An `engineering` team owns the human keys
  and a monthly budget; per-key budgets sit under it. Budget enforcement is a
  rationing tool: it stops one engineer starving the others, and it caps the
  fleet's spend. It does not raise the provider ceiling, which is the account
  and quota argument `workbench-account.md` already makes.
- **Expiry and offboarding.** Keys carry an `expires_at` where a contractor or
  temporary key is involved, and offboarding is "deactivate the virtual key",
  which is one action and does not touch a provider.
- **Admin auth.** Enable `governance.auth_config` (admin username/password) so
  the UI and governance API are not open, with the ALB OIDC rule in front of
  it as described above. The admin credential is a gateway secret and belongs
  in Secrets Manager, not in the repo.
- **The encryption key is load-bearing.** Provider keys stored in the config
  store are encrypted with `encryption_key`
  (`env.BIFROST_ENCRYPTION_KEY`). Losing it means re-entering every provider
  key. It is the single most important secret in this deployment and belongs
  in Secrets Manager with versioning, and in the restore runbook.
- **Ownership.** A human — jagoda — issues and revokes virtual keys for now,
  and the process is expected to iterate once the gateway is in use. This is
  a follow-up, not a blocker, and it is recorded rather than left implicit.

## Persistence, backup and upgrade

- **Store.** RDS for PostgreSQL, `config_store` and `logs_store` both
  `type: "postgres"` with `ssl_mode: "require"`. The instance is private, in
  the DB subnet group, encrypted at rest, with automated backups enabled and
  deletion protection on. Master credentials live in Secrets Manager and reach
  the task as `env.` references.
- **Availability.** Multi-AZ is the robust choice and protects the database
  against an AZ failure, but it does not make the gateway highly available:
  the OSS app is a single Fargate task, and a task replacement is still a
  short outage. Multi-AZ is therefore a cost/benefit decision rather than an
  HA claim; single-AZ with good backups is defensible for the inner loop, and
  Multi-AZ is the safe default if the budget allows.
- **Content.** `client.disable_content_logging: true` on the client, and audit
  every virtual key for `disable_content_logging: false`. Keep
  `client.allow_per_request_content_storage_override` at its default (`false`)
  so the `x-bf-disable-content-logging: false` header cannot turn content back
  on for one request. Upstream is explicit that the layers compose and that a
  key with `false` overrides the global setting
  (`docs/features/observability/content-logging.mdx`).
- **Retention.** Set `logs_store.retention_days` explicitly (90 days is a
  reasonable first value) rather than accepting the default. The account's
  Bedrock invocation log uses 365 days because it is the durable
  cost-attribution record; the gateway log is an operational and budget
  record, and 90 days covers a budget cycle. Raise it, or offload to object
  storage, if the cost history needs to outlive the budget window.
- **Backup.** RDS automated backups plus manual snapshots before an upgrade,
  with a documented restore. The encryption key and provider keys are in
  Secrets Manager and are not part of a database snapshot; a restore is
  "snapshot into the same VPC plus the same Secrets Manager values". A
  restore must be rehearsed once, because a backup nobody has restored is a
  belief.
- **Upgrade.** Pin the image by tag and digest (`maximhq/bifrost:v2.3.0` at
  the time of writing) and update it in a PR that also bumps the digest. The
  procedure is: RDS snapshot, register a new task definition, update the
  service, watch `/health` and the logs. Bifrost runs store migrations at
  startup, so the snapshot is the rollback, not the previous image alone.
  Rollback is previous digest plus snapshot if the schema moved; previous
  digest alone if it did not. RDS engine upgrades are separate and follow
  RDS's own version windows.

## Observability, usage and cost

- **Per-request records.** The built-in log store captures model, provider,
  latency, tokens and cost per request, keyed by virtual key and team
  (`docs/features/observability/default.mdx`). With content logging off, what
  remains is metadata — the same posture as the account's Bedrock invocation
  logging, and for the same reason.
- **Metrics.** Bifrost exposes `/metrics` (Prometheus) when the telemetry
  plugin is on, which it is by default. There is no Prometheus in the
  workbench account today, so the low-friction path is the CloudWatch agent
  scraping `/metrics` on the task and publishing selected series, plus
  container logs in a CloudWatch log group. A real Prometheus/Grafana stack is
  a larger decision and is not required for phase one. Note that when admin
  auth is enabled, `/metrics` requires credentials; the scraper must be
  configured accordingly, and over TLS if it crosses a network.
- **Cost tracking.** Bifrost computes cost from its model catalog. Fireworks
  pricing should be checked against the catalog and overridden with
  `custom_pricing`/pricing overrides if it is wrong or missing — a gateway
  whose per-key cost numbers are wrong is worse than one with none, because
  the budgets enforce against them.
- **Budgets and alerts.** The account already has
  `workbench-monthly-spend` in `deploy-workbench/index.ts` with actual and
  forecasted email notifications. The gateway adds per-key and per-team
  budgets inside Bifrost. The two are complementary: the AWS budget is the
  account-level backstop and lags hours; the Bifrost budget is the fast,
  per-person control. RDS adds its own storage and instance cost, which the
  account budget already covers.
- **Audit.** CloudTrail for the account covers infrastructure actions. The
  gateway's own log is the record of model traffic. Neither is a content log,
  by design.

## Migration from direct provider access, and rollback

The migration is configuration on the harness side, so it is reversible for as
long as the direct path is kept.

- **Phase A — stand up and prove out.** Deploy the gateway, and verify it
  end-to-end: `/health` green through the ALB over TLS; an inference request
  succeeds with a virtual key and fails without one; a Bedrock request
  succeeds through the task role; content logging is off; cost numbers match
  a small set of known calls. Nothing depends on it yet. This phase is the
  gate for everything after it.
- **Phase B — shadow.** Route one engineer's harnesses through it while their
  direct provider credentials stay in place. Compare cost and token numbers
  between the gateway and the provider's own billing for a week. Fix routing,
  model aliases and pricing before more people depend on it.
- **Phase C — pilot.** Move a handful of engineers and the `gp-pi` container
  to the gateway. Keep the direct Fireworks key in the container's secrets
  during this phase, unused, so a gateway outage is a one-line env change, not
  an outage.
- **Phase D — default.** Make the gateway the default for every harness.
  Remove direct provider keys from engineer environments and from the
  container's default env. Keep the break-glass direct key in Secrets Manager,
  documented and audited, for the duration of one full cycle.
- **Phase E — close the credential loop.** Design and implement how virtual
  keys are distributed to engineer machines and the `gp-pi` container, how
  they are rotated, and how offboarding works. This is deliberately gated on
  the gateway being proven out in phase A and exercised in phases B–D; it is
  not designed in this document.
- **Phase F — tighten.** Narrow `WorkbenchAccess`'s Bedrock invoke to what the
  gateway's task role needs (or remove it from engineers entirely), which is
  the payoff the workbench document's open question about removing
  `bedrock:*` from `EngineerAccess` is pointing at. This is a follow-up with
  its own PR.

**Rollback, at each phase:**

- Phases A–D: revert the harness base URL and restore the direct key. The
  direct path is still there; the gateway is bypassed, not dismantled.
- Phase E and later: the break-glass key in Secrets Manager is the path back.
  Re-issuing per-engineer direct keys is the manual fallback if that fails.
- Data rollback: the RDS snapshot. Config rollback: the repo's `config.json`
  and Secrets Manager versions.

The failure to plan around is not "the gateway returns errors" — Bifrost's
provider fallback handles a single provider being down. It is "the single OSS
task is down", at which point every harness stops. That is the reason
break-glass survives the later phases, and it is the honest cost of choosing
OSS over Enterprise clustering.

## Risks, open questions and out-of-scope

### Risks

- **Single point of failure.** OSS is single-node, so the gateway is one
  Fargate task and a choke point for all coding. RDS Multi-AZ protects the
  database, not the app. Mitigated by break-glass, not eliminated.
- **A public endpoint and an admin UI.** Inference is protected by virtual
  keys; the admin surface is protected by ALB OIDC restricted to an admin
  group plus the OSS admin password. The group restriction lives at the IdP,
  not in Bifrost, so a misconfigured OAuth app is the most likely way the plan
  causes an incident.
- **The SCP relaxation.** Removing `rds:*` from `DenyDataStores` widens what
  the workbench account can run. It is deliberate and reviewed, and the
  remaining denies (`dynamodb`, `redshift`, cross-account S3, non-`us-west-2`)
  are untouched, but the data-boundary argument in `workbench-account.md` is
  weakened by exactly this much and should be re-read before the PR merges.
- **The encryption key.** Losing it invalidates stored provider keys. It must
  be in Secrets Manager, versioned, and in the restore runbook.
- **Content logging defaults to on.** Every layer must be turned off
  explicitly, and a virtual key created with `false` silently overrides the
  global setting. The plan treats this as a data-boundary control, not a
  preference.
- **RDS backup and upgrade.** A gateway whose database cannot be restored is a
  gateway with no configuration. The snapshot-before-upgrade rule and the
  restore rehearsal are the controls; RDS engine upgrades are their own
  maintenance window.
- **Upstream velocity.** Bifrost ships frequently and the image tag moves
  weekly. Pinning by digest and upgrading deliberately is the control; `latest`
  is not acceptable for a component every harness depends on.
- **Cost attribution accuracy.** If the model catalog's pricing is wrong for
  Fireworks, budgets enforce against wrong numbers.
- **The SCP as a surprise.** The workbench SCP denies services and regions,
  and it binds the deploy pipeline too. The workbench document's own lesson —
  `aws-marketplace` broke the pipeline on its first apply — is the precedent:
  check a new action against `deploy-workbench.yml`, not only against a
  person.

### Open questions a human has to answer

Review settled most of the earlier questions. What genuinely remains:

- **The admin OIDC IdP.** Which OIDC provider fronts the admin paths, and how
  the admin group is enforced there. Identity Center is not itself an
  ALB-compatible OIDC IdP, so the candidates are the IdP Identity Center
  federates from (for example Google Workspace) or Cognito brokering it. The
  decision is an implementation detail with a security consequence; pick it
  before phase A exposes the admin surface.
- **RDS size and Multi-AZ.** Single-AZ with backups is defensible for the
  inner loop; Multi-AZ is the safe default if the budget allows. Also pick the
  instance class and storage size.
- **Model allowlist and Fireworks pricing.** Which models the fleet is allowed
  to reach, and whether Bifrost's catalog pricing for them is correct. Wrong
  pricing makes the budgets wrong.
- **Does the Bedrock invocation log stay?** Once the gateway routes Bedrock,
  the workbench step 17 log still records the calls, but attribution moves
  from `identity.arn` to the virtual key. Decide whether the log is kept for
  defense in depth, or retired.

### Out of scope

- Deploying anything. This is a plan.
- Buying or evaluating Bifrost Enterprise. **The plan is OSS for now.**
  Enterprise is a documented future option: it would add native OIDC/SSO and
  SCIM, `vault_store` secret references, clustering (real multi-node HA) and
  access profiles, at a licensing cost and a procurement step. Nothing here
  depends on it.
- Designing virtual-key distribution and `gp-pi` wiring. That is phase E,
  gated on the gateway being proven out.
- Replacing or re-scoping `WorkbenchAccess`, removing `bedrock:*` from
  `EngineerAccess`, or changing the workbench SCP beyond the `rds:*` relaxation
  described above. Those are follow-ups with their own PRs.
- Any change to the `delegate` worker, the `ops` delegate pipeline, or
  production traffic. The gateway is for the developer inner loop.
- A Prometheus/Grafana buildout. CloudWatch plus the built-in UI is the phase
  one answer.
- Multi-region, multi-account or multi-node gateway topologies.

## Phased task list

Rough sequencing; each numbered item is a PR unless it says otherwise. The
dependencies that matter are called out: nothing that assumes a name, a
network or a permission can land before the item that creates it.

**Phase 0 — prerequisites**

1. **Relax the workbench SCP for RDS.** Remove `rds:*` from `DenyDataStores`
   in `deploy-org/policies.ts`, leaving `dynamodb:*` and `redshift:*` denied.
   Applied by `deploy-org.yml`. This must merge and finish applying before the
   RDS instance can be created. Record the decision in
   `docs/workbench-account.md`'s open questions so the account's plan stays
   true.
2. **DNS delegation.** Add the `workbench.goodparty.org` zone to
   `deploy-workbench/` and the NS record to `deploy/`, in the
   infra-zone-delegation shape. The NS record must exist before ACM
   validation.
3. **Mirror the image.** Mirror `maximhq/bifrost:v2.3.0` into an ECR
   repository in the workbench account, pinned by digest, following the
   delegate image's build/push pattern in `.github/workflows/deploy.yml`.
   Decide the digest upgrade cadence.
4. **Pick the admin OIDC IdP** and confirm it can be scoped to an admin group
   (see "Open questions"). This is a decision, not a PR.

**Phase 1 — network and compute**

5. Add the network to `deploy-workbench/`: VPC, two public subnets, two
   private subnets across two AZs, NAT (or VPC endpoints), route tables, the
   DB subnet group and the security groups.
6. Add the ALB, target group, listeners, the ACM certificate and validation,
   and the Route 53 alias, all taking the explicit provider.
7. Add the RDS Postgres instance, private and encrypted, with automated
   backups and deletion protection, and its credentials in Secrets Manager.
8. Add the ECS cluster, task definition and service, copying the task-definition
   idiom in `deploy/components/worker.ts` (execution role with the managed
   ECS policy plus secrets read, a separate task role scoped to the Bedrock
   model list, `secrets` from Secrets Manager, `awslogs`, `initProcessEnabled`),
   and the CloudWatch log group.
9. Add the admin-path ALB listener rule with the `authenticate-oidc` action
   and the inference-path rule without it.

**Phase 2 — the gateway itself**

10. Commit the non-secret `config.json` under `deploy-workbench/` with
    providers, client settings and the `governance` block, using `env.`
    references; have Pulumi store it as an SSM SecureString and inject it as
    `BIFROST_CONFIG`. Set `source_of_truth: "config.json"` for the sections
    the repo owns.
11. Add the secret containers and the read grants, and write the secret
    values out of band (provider keys, `BIFROST_ENCRYPTION_KEY`, admin
    credential, `VK_*`).
12. Bring the service up and prove phase A: `/health` green through the ALB
    over TLS, inference succeeds with a virtual key and fails without one, a
    Bedrock request succeeds through the task role, and the admin path
    redirects to the IdP and rejects a non-admin.
13. Confirm content logging is actually off end-to-end: make a request with a
    known marker string and show it is absent from the log store and any
    connector. The upstream docs are explicit that the layers compose, so this
    is a test, not a reading.
14. Create the `engineering` team, its budget, and the first virtual keys
    declaratively in `config.json`; write the issue/rotate/revoke runbook next
    to the other runbooks. The owner is jagoda for now.

**Phase 3 — observability and cost**

15. Wire `/metrics` into CloudWatch (agent scrape) or the chosen metrics path,
    with the credentials the enabled admin auth requires.
16. Reconcile gateway cost numbers against a week of provider billing for the
    pilot, and add pricing overrides if they disagree.
17. Confirm the account budget and the Bifrost budgets are both wired, and
    that a threshold crossing is actually delivered (the workbench document's
    warning about alerts that only prove the wire exists).

**Phase 4 — migration**

18. Shadow: move one engineer's harnesses to the gateway, direct path intact.
    Run for a week.
19. Pilot: move a handful of engineers and the `gp-pi` container, direct key
    still present but unused.
20. Default: move every harness, keep the break-glass key, and document the
    rollback in the runbook.

**Phase 5 — close the loop and harden**

21. Credential distribution and `gp-pi` wiring (phase E above), gated on the
    gateway having proven out.
22. Tighten `WorkbenchAccess`/`EngineerAccess` Bedrock invoke and remove
    direct provider keys, in a separate PR, after a full cycle on the gateway.
23. A restore rehearsal from an RDS snapshot, recorded with its date and the
    evidence.
24. A digest-upgrade rehearsal, including a migration rollback, recorded the
    same way.

## Upstream basis and version

The plan is based on the upstream repository at tag **`transports/v2.3.0`**
(2026-10-13), the matching container image
**`docker.io/maximhq/bifrost:v2.3.0`** (published 2026-10-13), and its docs
under `docs/`. The Helm chart at that tag is `2.1.44` with a stale
`appVersion: 1.5.12`; the image tag, not the chart `appVersion`, is the
version that matters. The repository's default branch is `dev`, and the
`docs/quickstart/cli/coding-agents.mdx` page cited above was fetched from
`main`, which is ahead of the tag; the harness table is stable but should be
re-checked at implementation time.

Specific upstream pages this plan leans on, all under
`docs/` at the pinned tag unless noted:

- `deployment-guides/ecs.mdx`, `deployment-guides/docker-tuning.mdx` —
  container deployment, ports, health check.
- `deployment-guides/how-to/multinode.mdx` — the OSS single-node limit.
- `deployment-guides/config-json.mdx`,
  `deployment-guides/config-json/storage.mdx`,
  `deployment-guides/config-json/governance.mdx`,
  `deployment-guides/config-json/source-of-truth.mdx`,
  `deployment-guides/config-json/secret-management.mdx` — config, SQLite vs
  Postgres, declarative governance, reconciliation, and the Enterprise-only
  vault integration.
- `features/governance/virtual-keys.mdx` — virtual keys, teams, budgets,
  expiry, mandatory auth.
- `features/observability/default.mdx`,
  `features/observability/prometheus.mdx`,
  `features/observability/content-logging.mdx` — logging, metrics, and the
  content-logging layers.
- `providers/supported-providers/fireworks.mdx`,
  `providers/supported-providers/bedrock.mdx` — provider auth, including
  Bedrock's inherited IAM role.
- `enterprise/user-provisioning.mdx`,
  `enterprise/auth-proxy/aws-alb.mdx` — the Enterprise OIDC/SCIM and ALB IAP
  features that OSS does not have.
- `quickstart/cli/coding-agents.mdx` (from `main`) — harness paths and the
  `bifrost` CLI.

Bifrost is Apache-2.0. The features this plan deliberately does not use —
clustering, SSO, access profiles, AWS Secrets Manager `vault_store` — are
Enterprise-only, and the plan is written to stand on OSS alone.
