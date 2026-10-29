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
2. **One credential model.** A person gets their own gateway virtual key, not
   a Fireworks key and not a Bedrock session. Revoking the key stops that
   person's traffic and nothing else has to be rotated; who gets one, and what
   takes it away, is
   [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md).
3. **Spend per person, visible.** Per-person spend is visible in the gateway
   and attributable, because each key belongs to a person. **The cap is the
   provider's, not the gateway's, for now**: per-key budgets and rate limits
   were dropped by agreement on #404
   ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), "Deferred") in
   favour of the limits AWS and Fireworks already impose, plus the account's
   billing alert.
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
  It runs **two containers**: the Bifrost gateway on 8080 and the
  `oauth2-proxy` sidecar on 4180 (see "Protecting the admin surface"). This
  mirrors `deploy/components/worker.ts`, the delegate's task definition,
  which is the working example in this repo of the same shape.
- **One `aws.ecs.Service`**, `desiredCount: 1`, `launchType: "FARGATE"`,
  registered against both ALB target groups (Bifrost on 8080, oauth2-proxy on
  4180), in the private subnets, with a security group that accepts 8080 and
  4180 only from the ALB security group. The repo has no long-running ECS
  service yet — the delegate dispatches ephemeral tasks — so this is the one
  genuinely new resource, and it should follow the same role and secret
  patterns.
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
  the model list in `utils/bedrock-models.ts`, plus the one account-wide read
  that renders the provider's model list — `bedrock:ListFoundationModels`,
  which Bedrock gives no resource type to scope and which the dashboard's
  provider page needs — and the SCP's existing `bedrock` exemption keeps
  geo-profile calls working.

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
| oauth2-proxy + email-allowlist precedent | `agent-swarm/host/docker-compose.yml`, `agent-swarm/host/allowed-emails.txt`, `agent-swarm/README.md` "Google login" |
| Account budget `workbench-monthly-spend` | `deploy-workbench/index.ts` |
| Bedrock invocation logging, metadata only, 365-day retention | `deploy-workbench/index.ts` |
| Identity Center `WorkbenchAccess`/`Engineers`, `AdministratorAccess`/`Admins` | `deploy/components/identity-center.ts`, `docs/workbench-account.md` |
| Virtual-key admin routes and their search semantics at the pinned tag | `transports/bifrost-http/handlers/governance.go`, `framework/configstore/rdb.go`; the facts are collected in `docs/bifrost-virtual-keys.md` |
| An engineer's container identity is `assumed-role/AWSReservedSSO_WorkbenchAccess_<hash>/<email>` | `aws sts get-caller-identity` in the container; `docs/bifrost-virtual-keys.md` |
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
  HTTPS. Two target groups: Bifrost on 8080 (health check `/health`) and
  oauth2-proxy on 4180 (health check `/ping`).
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

Inference paths (`/v1/*`, `/anthropic/*`, `/openai/*`, `/genai/*`) are open
at the network layer and gated by virtual keys, and `/health` is open and
unauthenticated because the ALB's health check cannot present a credential.
Everything else — the dashboard, `/api/*`, `/metrics` and every other route the
gateway registers — is behind `oauth2-proxy`. The rule table in "Protecting the
admin surface" is the authoritative list, and the commentary there records the
route enumeration it was checked against at the pinned tag.

**Revised decision: Bifrost's own dashboard auth is off.** The earlier version
of this plan kept `governance.auth_config` enabled and had the sidecar inject
the shared admin Basic credential, on the claim that a human would then meet
only Google SSO. That claim was wrong in an important way: the dashboard's
gate is a **session cookie**, not a per-request credential, so the injected
Basic header authenticated the proxy's requests rather than a person, and
every allowlisted address still acted as the same admin. The decision now is
`is_enabled: false`: oauth2-proxy plus the committed email allowlist is the
only gate on the admin surface, and the edge invariant — no route reaches
Bifrost directly except the enumerated inference prefixes and `/health` — is
what keeps that true. The admin username and password references stay in
`config.json` and the setup token stays, because a store with auth disabled
needs proof of operator control before auth can be turned back on; the section
below is the detail.

### Protecting the admin surface

Bifrost OSS protects its dashboard and management API with a single
admin username and password (`governance.auth_config` in
`docs/deployment-guides/config-json/governance.mdx`). It has **no native
OIDC/SSO in OSS**: OAuth 2.0/OIDC user provisioning, SCIM, role mapping and
the ALB identity-aware-proxy integration are all Enterprise
(`docs/enterprise/user-provisioning.mdx`,
`docs/enterprise/auth-proxy/aws-alb.mdx`; the OSS
`features/sso-with-google-github` page is a "Coming soon" stub). The decision
is to put `oauth2-proxy` in front of the admin paths, following the pattern
`agent-swarm` already runs, rather than an ALB `authenticate-oidc` action.

**Shape: a sidecar in the Bifrost task, not a second ECS service.**
`oauth2-proxy` runs as a second container in the same Fargate task, listening
on 4180 while Bifrost listens on 8080. The ALB routes the admin paths to 4180
and the inference paths to 8080. One task means one lifecycle, no second
service to pay for, and no service discovery: the two containers share the
task network namespace, so oauth2-proxy proxies to `http://127.0.0.1:8080`
with no hop back through the ALB. A separate small ECS service buys nothing
here, because the gateway is single-node OSS and the two containers restart
together either way.

**Routing, and the edge invariant.** The listener rules are:

- `/oauth2/*` → oauth2-proxy (login start, Google callback, sign-out).
- `/` and `/api/*` → oauth2-proxy, so a browser or a script is authenticated
  before Bifrost sees the request.
- The four inference prefixes (`/v1/*`, `/anthropic/*`, `/openai/*`,
  `/genai/*`) → Bifrost directly, so a harness never meets a browser redirect.
  Every route under them is gated by a virtual key: the governance plugin's
  `Evaluate` is the funnel every request pipeline passes through, and
  `client.enforce_auth_on_inference: true` makes a missing or unknown key a
  `401` before any provider call (`plugins/governance/main.go`,
  `"virtual key is required"`).
- `/health` → Bifrost directly, unauthenticated. **This is the one allowed
  exception**, and it is allowed because the ALB target group's health check
  is a machine that cannot authenticate; Bifrost whitelists the path itself, in
  both its auth middleware and the OSS setup lock.
- Everything else falls through to oauth2-proxy, which is the HTTPS listener's
  **default action**. That is the half that keeps the failure direction closed:
  a route added at the next Bifrost bump is behind the proxy unless someone
  adds a rule for it.

`/metrics` is deliberately not a direct rule. It used to be, on the strength of
Bifrost's own basic auth; with that auth off the endpoint would have no
credential at all, so the rule was removed rather than left for a future
scraper to inherit as public. Nothing scrapes it yet (metrics wiring is phase 3
item 15), so the cost today is zero. A machine scraper **cannot** authenticate
through Google SSO, so the future scraper has to read `/metrics` over loopback
from a sidecar in the task — not over the ALB, where the default action sends
it to the proxy's sign-in flow.

At the pinned tag the routes Bifrost registers are `/api/*`, `/v1/*`,
`/anthropic/*`, `/openai/*`, `/genai/*`, `/cohere/*`, `/litellm/*`,
`/langchain/*`, `/pydanticai/*`, `/bedrock/*`, `/typesafe/*`, `/cursor/*`,
the seven `*_passthrough/*` prefixes, `/mcp` and `/mcp/{slug}`, `/agents/a2a/*`,
`/ws`, `/realtime`, `/.well-known/*`, `/oauth2/{authorize,register,token}`,
`/robots.txt`, `/` and `/{filepath:*}`, `/metrics` and `/health`
(`transports/bifrost-http` route registrations at `transports/v2.3.0`). The
per-route table, and which credential each route carries, is in the pull
request that made this change; the only ones any rule sends to Bifrost are the
inference prefixes and `/health`, and `deploy-workbench/ingress.test.ts` fails
if a rule adds another.

**Configuration**, following `agent-swarm/host/docker-compose.yml` where the
options survive:

- Google as the provider, with the Google Cloud OAuth consent screen set
  **Internal**, so only `goodparty.org` accounts can sign in at all. The
  provider block lives in the sidecar's alpha configuration (see below), not in
  an environment variable: `provider` is one of the options alpha format
  removes.
- `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE: /etc/oauth2-proxy/allowed-emails.txt`,
  backed by a file committed under `deploy-workbench/` (for example
  `deploy-workbench/bifrost/allowed-emails.txt`), one address per line, the
  same shape as `agent-swarm/host/allowed-emails.txt`. Granting and revoking
  access is a PR to that file. The stock oauth2-proxy image has no inline
  email-list flag — `--authenticated-emails-file` is the only form (upstream
  issues #968 and #3391) — so the file reaches the container in a derived
  image: a Dockerfile under `deploy-workbench/bifrost/` whose `FROM` is the same
  pinned digest `agent-swarm` uses
  (`quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916`)
  and whose `COPY` puts the allowlist at that path. CI builds and pushes it
  beside the Bifrost mirror, and Pulumi references it by digest, so a change to
  the list is a reviewed PR and a new digest.
- The upstream is Bifrost in the same task (`http://127.0.0.1:8080`), not the
  swarm's `static://202`: the swarm's Caddy forwards and oauth2-proxy only
  gates, while here the proxy is the reverse proxy for the admin surface. The
  two containers share the task network namespace, so this is a loopback hop
  with no round trip through the ALB.
- The three secrets — `OAUTH2_PROXY_CLIENT_ID`,
  `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET` — go in Secrets
  Manager and reach the sidecar as `secrets`, written out of band the way
  `agent-swarm/host/fill-secrets.sh` writes the swarm's `DELEGATE_SWARM`
  secret. The swarm's `render-env.sh` refuses a partial set; the task
  definition carries all three or none, and the deploy fails closed if the
  admin surface is enabled without them. The client pair is still a secret
  even though the provider moved into the alpha file: alpha config substitutes
  `${OAUTH2_PROXY_CLIENT_ID}` and `${OAUTH2_PROXY_CLIENT_SECRET}` at load time.
- The rest of the swarm's settings carry over as environment variables, since
  all of them survived into the core option set: `OAUTH2_PROXY_REVERSE_PROXY:
  "true"`, `OAUTH2_PROXY_COOKIE_SECURE: "true"`,
  `OAUTH2_PROXY_COOKIE_SAMESITE: lax`, `OAUTH2_PROXY_COOKIE_EXPIRE: 168h`,
  `OAUTH2_PROXY_COOKIE_REFRESH: 1h`,
  `OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "true"`,
  `OAUTH2_PROXY_WHITELIST_DOMAINS: bifrost.workbench.goodparty.org`, and
  `OAUTH2_PROXY_REDIRECT_URL:
  https://bifrost.workbench.goodparty.org/oauth2/callback`.

**Bifrost's own login is off, and the OSS setup lock is satisfied by the
sidecar.** `governance.auth_config.is_enabled` is false in `config.json`, so
there is no shared admin login to answer and no password on the human path.
That is not the same as "the API is open" at `v2.3.0`, and this is the detail
a future session will otherwise get wrong:

- The OSS server installs `SetupLockMiddleware` whenever dashboard auth is not
  active — no admin account, *or* an admin account with auth disabled — and it
  refuses every non-public `/api` call that does not carry the operator's setup
  token in `X-Bifrost-Setup-Token` (or the HttpOnly setup-session cookie minted
  from it) (`transports/bifrost-http/handlers/middlewares.go`,
  `SetupLockMiddleware` and `isAPIRouteWhitelisted`). The dashboard's loader
  asks `GET /api/session/is-auth-enabled`, sees `setup_required: true`, and
  renders the setup page — a *second prompt* — unless an API call with the
  cookie or header succeeds.
- So the sidecar still injects one header, and it is the setup token rather
  than a Basic credential: `injectRequestHeaders` sets
  `X-Bifrost-Setup-Token` from `BIFROST_SETUP_TOKEN`, which the task definition
  already injects into the sidecar from `bifrost/gateway`. A human who passes
  Google SSO lands on the dashboard; nothing is typed a second time.
- The token is what proves operator control for re-enabling auth (`PUT
  /api/config` with an `auth_config` block). It is held by the deployment, not
  by a person: it never reaches a browser, and a client-supplied header of that
  name is stripped before the injected one is set. `bootstrap.sh` already sends
  the same header for the first-admin claim and is a no-op once an account
  exists with auth disabled, so the two paths agree.
- The entrypoint wrapper that used to compute `base64(admin_username:
  admin_password)` was removed with the credential it encoded. It was genuinely
  dead weight: with auth off nothing consumes a Basic header, the value the
  setup lock needs is already an environment variable, and the wrapper's Go
  stage, tests and `go.mod` were maintained only for that. Two things break if
  it were left in place — the header it computes would authenticate nothing,
  and the setup lock would still 401 every `/api` call behind the proxy, so
  every allowlisted human would meet the setup page. The alpha configuration
  stays: with `--alpha-config` in use, `provider`, the upstreams and the listen
  address are removed core options and are defined nowhere else.
- The admin username and password `env.` references stay in `config.json`.
  `loadAuthConfig` still hashes the password and writes the admin account at
  boot, which is the account re-enabling auth acts on; removing the references
  would make re-enabling auth a config-shape change with no credential to
  re-enable. Nothing authenticates with them while auth is off.

Three details of the injection, all of them properties of oauth2-proxy v7.15.5
and its alpha format rather than choices of ours, checked against the pinned
image's source:

- The header is **stripped then set**. `PreserveRequestValue` defaults to
  false (`pkg/apis/options/header.go`), so the injector removes any
  client-supplied header of that name before adding its own
  (`pkg/middleware/headers.go`, `newStripHeaders`/`injectRequestHeaders`). A
  caller cannot smuggle a token upstream.
- The value comes from the environment, not the file:
  `secretSource.fromEnv`. The configuration reference for `SecretSource` lists
  `value` (base64), `fromEnv` and `fromFile`, and oauth2-proxy validates the
  `fromEnv` source against a non-empty variable before it will start
  (`pkg/validation/common.go`, `validateSecretSourceEnv`).
- `--alpha-config` is not additive-only. Options the alpha format absorbed are
  *removed* when it is used (`docs/docs/configuration/alpha_config.md`,
  "Removed options"): `provider`, `client-id`, `client-secret`, `upstream`,
  `http-address`, `set-xauthrequest` and `pass-user-headers` among them. So
  the provider, the upstream and the listen address live in
  `deploy-workbench/bifrost/alpha-config.yaml`, and those environment
  variables are gone from the task definition rather than left in place — a
  removed option is silently ignored, which is the kind of failure that looks
  like it deployed. Everything not in that list (the allowlist path, the
  redirect URL, the whitelist domain, the cookie settings, `reverse-proxy`)
  survived into the core option set and still loads from `OAUTH2_PROXY_*`.
  `pass-user-headers` and `set-xauthrequest` are dropped instead of ported:
  Bifrost reads none of the `X-Forwarded-*` or `X-Auth-Request-*` headers, and
  the only header this deployment needs is the setup token.

**Fail-closed.** A task that cannot present the setup token must not run, and
the layers are now:

1. The ECS agent resolves `BIFROST_SETUP_TOKEN` from `bifrost/gateway` before
   the container starts, so a missing key is a task that never starts.
2. oauth2-proxy itself refuses to start when the `fromEnv` variable is empty
   (`pkg/validation/common.go`, `validateSecretSourceEnv`).
3. `--alpha-config` is what supplies the provider, the upstreams and the listen
   address at this tag, so a task definition that dropped the flag gets a proxy
   that refuses to start rather than one that serves the admin paths
   unconfigured.
4. If all of that were bypassed, the direction is still closed: Bifrost's setup
   lock answers `401` or `403` rather than opening `/api`, which is the failure
   the previous design could not fall back on.

The sidecar is `essential: true`, so any of the first three takes the task with
it. That is the intended failure: a gateway whose admin surface has no door is
worse than a task that visibly will not stabilize.

**Risk, and the rollback.** `injectRequestHeaders` is alpha configuration: its
structure may change between minor releases (upstream's own warning, and the
flag's help text), and the wrapper is gone so the injected value is now a
single `fromEnv` reference. The pin is what contains that — the digest in
`deploy-workbench/bifrost/Dockerfile` and `oauth2-proxy-image.ts` — and the
image tag is content-addressed over the allowlist, the Dockerfile and the alpha
file, so no input can change under a fixed tag. The image build also runs
`oauth2-proxy --config-test` over the baked alpha file in a stage of its own,
with dummy values including a dummy `BIFROST_SETUP_TOKEN`, so a bump that
renames or removes a key fails the build rather than the deploy: at this tag an
unknown alpha key is an error at container start (`ErrorUnused` in
`pkg/apis/options/load.go`), which would drain the running task and then refuse
to start the new one. The rollback is a `config.json` change, not an image
rollback: set `governance.auth_config.is_enabled: true` and the shared admin
login is back, with the injected setup-token header ignored by
`APIMiddleware` because auth is active. That is a working state rather than an
outage — Google SSO and the allowlist still gate the surface — which is why
this is a rollback rather than a redesign.

**What SSO here is not.** Every allowlisted address signs in and then acts as
the one shared Bifrost admin. There is no per-person attribution in Bifrost's
audit records, no per-person role, and no way to revoke one person without
editing the allowlist — turning the shared password off does not create a user.
That needs Enterprise. A plugin cannot supply it at
this tag either, which the earlier version of this section got wrong: the
plugin interfaces at `v2.3.0` are LLM, MCP, A2A, HTTP-transport and
observability (`core/schemas/plugin.go`), with no hook on the dashboard or
management auth path; and the shared-object loader goes through Go's
`plugin.Open` (`framework/plugins/soloader.go`), which cannot load into the
pinned image's `/app/main` — a statically linked executable with no
dynamically linked Go runtime to share. So the allowlist plus the proxy is the
whole of what this design gets, and per-person attribution stays an
Enterprise question.

**That is about the admin surface, not about inference.** A model request is
attributable to a person because it carries that person's own virtual key
([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)), so "who spent what"
does not need Enterprise. What Enterprise would add is a per-person identity
for *dashboard actions* — who changed a provider, who edited a budget — which
is a different question and not the one the cost record answers.

**Prerequisite, manual.** A Google Cloud OAuth client of type Web
application, consent screen Internal, redirect URI
`https://bifrost.workbench.goodparty.org/oauth2/callback`. This is the same
console step `agent-swarm/README.md` documents under "Google login", and it
is the one part of this that cannot be a PR.

**The tradeoff, stated plainly.** The allowlist is a **separate list** from
the Identity Center `Admins` group. `sheriff` mutates `Admins` membership at
runtime (`docs/sheriff.md`), so the two will drift: someone granted admin
through sheriff is not automatically on the Bifrost list, and someone removed
from `Admins` keeps Bifrost admin until the allowlist PR lands. The owner of
the Bifrost admin list is **jagoda for now**, matching the virtual-key
issuance owner; aligning it with `Admins` is a follow-up decision this plan
deliberately does not make. See "Open questions".

**Why not the alternatives.**

- **ALB `authenticate-oidc`.** It authenticates but cannot authorize by
group, and ALB listener rules cannot match claims; they only forward
`x-amzn-oidc-data` and friends to the target, and Bifrost OSS cannot read
those claims. Restricting to an admin group would have to happen at the IdP
by scoping the OAuth app, a weaker and less visible control than a file in
this repo.
- **Google group membership** (`--google-group`) would need a Workspace
service account with domain-wide delegation, which `agent-swarm` explicitly
declined (`agent-swarm/README.md`, "Google login": "would need a Workspace
service account with domain-wide delegation, which we chose not to create").
The email allowlist is the pattern that avoids that.
- **AWS Verified Access with Identity Center as the trust provider** *would*
read the `Admins` group natively, which is the only option that removes the
drift, but it costs roughly $0.27/hr per endpoint (about $200/month) plus
per-GB processing. Kept as a documented future option rather than built.
- **Reading Identity Center groups in oauth2-proxy** is not possible: there
is no Identity Store provider and no generic external-authorizer hook, so the
allowlist cannot be made to track `Admins` in place.

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
   client settings, and the `governance` block — teams and virtual keys, and
   budgets when there are any — with an `env.` reference everywhere a secret
   would otherwise be.
   Pulumi stores it as a plain SSM `String` parameter (`/bifrost/config`) and
   injects it as `BIFROST_CONFIG`; the container entrypoint writes it to
   `/app/data/config.json`, which is the shape the upstream ECS guide
   documents. A change to it is a reviewed PR, not a console edit.
   `String`, not `SecureString`: the file is committed here, so encrypting the
   deployed copy protects nothing, while it would hide the configuration
   production is running from the reviewers who would diff it, and it would
   put `kms:Decrypt` on the account's `aws/ssm` key in the ECS agent's policy.
   No secret lives in the file — every credential in it is an `env.` name
   resolved from Secrets Manager, and the database password reaches the task
   through `secrets` — which `deploy-workbench/bifrost/config.test.ts`
   checks: no credential-shaped literal, and every `env.` name is one the
   deployment actually provides. The mechanism, including a digest of the
   file's contents carried in the task definition so an edit rolls the task,
   is documented in `deploy-workbench/bifrost/README.md`.
   `source_of_truth: "config.json"` makes the file authoritative for the
   sections it declares, so a redeploy converges to the repo instead of
   preserving UI drift; the upstream "missing vs empty" caveat in
   `docs/deployment-guides/config-json/source-of-truth.mdx` is the thing to
   watch (an omitted section is left alone, an empty one prunes).
3. **Secrets are in Secrets Manager, written out of band.** Provider keys
   (`FIREWORKS_API_KEY`, and any other provider), `BIFROST_ENCRYPTION_KEY`,
   the admin credential and any virtual-key value declared in the file
   (`VK_*`) are secret values. Pulumi creates the secret containers and the
   read grants; the values are written out of band with the same procedure
   `DELEGATE_SWARM` and `gp-pi/brave-search` use. Nothing secret is committed,
   and nothing secret appears in this document. A **per-person** key does not
   use this layer at all: it is created through the admin API and its value
   lives in Bifrost, which returns it, so there is no secret for anyone to
   write ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)).

The oauth2-proxy admin allowlist is a fourth repo file,
`deploy-workbench/bifrost/allowed-emails.txt`, baked into the sidecar image
rather than injected at runtime; it is described under "Protecting the admin
surface".

The `governance` block supports `value: "env.VK_ENGINEER"` on a virtual key
(`docs/deployment-guides/config-json/governance.mdx`), which is what makes the
structure code and the token a secret: the key's id, provider/model scope and
team live in the file; the `sk-bf-*` value comes from Secrets Manager. Teams,
and budgets when there are any, are declarative in the same block. Rotating a
declared key is
changing one secret value, not editing the file. This is the mechanism for a
key that is *declared* — a shared caller, not a person: per-person keys are
minted and stored in Bifrost, so they appear in neither the file nor Secrets
Manager ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)).

## Provider configuration

Bifrost takes providers from `config.json` and its config store. Provider keys
are referenced by name, never written down here or in git.

- **Fireworks** is the provider the fleet uses today. Upstream supports it as
  an OpenAI-compatible provider
  (`docs/providers/supported-providers/fireworks.mdx`), including
  `use_anthropic_endpoints` for harnesses that speak the Anthropic Messages
  shape. The key is `env.FIREWORKS_API_KEY`, injected from Secrets Manager,
  and the config allows only the models the fleet actually uses rather than
  `*`. It is pinned to Fireworks' US-only Serverless endpoint and US router
  ids; see "US-only inference" below.
- **Bedrock** is the second provider. Upstream supports inherited IAM-role
  authentication (`docs/providers/supported-providers/bedrock.mdx`), and on
  Fargate that is the ECS task role, so no static AWS key is stored anywhere.
  The task role is scoped to the model list in `utils/bedrock-models.ts` for
  invoking, and holds `bedrock:ListFoundationModels` on `*` for the model list
  itself: Bifrost's provider renders that page from a signed
  `GET /foundation-models` (AWS's `ListFoundationModels`) and not from the key
  list, so an invoke-only role serves inference and shows the provider warning
  where the models should be. Bedrock defines no resource type for that action,
  which is the one wildcard in the role. The pinned provider calls no
  `ListInferenceProfiles`/`GetInferenceProfile`: the `us.` profiles the config
  allows are listed from the key's own `models` allowlist (the list pipeline
  backfills allowlist entries the foundation-model response does not contain)
  and invoked through their profile ARNs, which the invoke statement already
  grants. The SCP's existing `bedrock` exemption keeps geo-profile calls
  working. This is what lets the gateway take over Bedrock entirely, including
  the per-user attribution the invocation log provides today.
- **Other providers** (Anthropic direct, OpenAI direct) are added only if a
  harness needs them, each with its own `env.` reference. Provider fallback
  between Fireworks and Bedrock is a configuration choice; it is the main
  reliability argument for the gateway, and it should be turned on
  deliberately with a model mapping rather than left to a default.

### US-only inference

**Decision: no request may be served outside the United States, and the
enforcement is the provider model lists in
`deploy-workbench/bifrost/config.json`.** The gateway is the only path a harness
has to a model, so the lists are where the rule can be a property of the
deployment rather than a convention: a model not in a key's list is refused
before any provider call, and the virtual-key template that a minted key is
created from carries the same lists (`bifrost-virtual-keys.md`, decision 5), so
a person's key cannot ask for what the gateway would not route.

What that means per provider, all of it checked by
`deploy-workbench/bifrost/config.test.ts`:

- **Fireworks is on US-only Serverless.** The provider block carries
  `network_config.base_url: "https://us.api.fireworks.ai/inference"`, and the
  models are Fireworks' US router ids, `accounts/fireworks/routers/<model>-us`
  (for the one class the fleet uses,
  `accounts/fireworks/routers/deepseek-v4p1-flash-us`). Both halves are
  needed: the router id scopes the model and the endpoint scopes the traffic.
  `network_config.base_url` is the only `base_url` in Bifrost's schema at the
  pinned tag — there is no per-key one — and the Fireworks provider uses it
  for every request path, defaulting to the global
  `https://api.fireworks.ai/inference` when it is unset
  (`core/providers/fireworks/fireworks.go`). Setting it is therefore what makes
  the global endpoint unreachable from the gateway rather than merely
  unchosen; leaving it out is how a future edit reintroduces global traffic
  without touching a model list.
- **Bedrock keeps only `us.` cross-region inference profiles.** Every
  `global.` id is gone, because `global.` is worldwide by definition, and every
  bare foundation-model id is gone, because a bare id is not a US commitment at
  all. The test refuses a `global.` anywhere in the file and any Bedrock model
  id without the `us.` prefix, so a `global.` never comes back as a quiet
  addition to a model list.
- **DeepSeek V3.2 is not served by the gateway**, and this is the one class the
  US-only rule costs. Bedrock has no `us.deepseek.v3.2` inference profile —
  `bedrock:ListInferenceProfiles` in `us-west-2` on 2026-10-29 returned
  `us.deepseek.r1-v1:0` as the only DeepSeek profile — so the only way to keep
  the class would have been the bare id, which is exactly the unqualified
  routing the rule forbids. The class is removed rather than kept as an
  exception. It stays in `utils/bedrock-models.ts`, because that list is the
  sandbox's direct `WorkbenchAccess` grant rather than the gateway's, and IAM
  may be wider than what the gateway serves.

Two consequences are accepted with the decision:

- **The Fireworks premium.** US-only Serverless models are priced at 1.5x the
  base model's serverless price from 2026-09-01
  (https://docs.fireworks.ai/serverless/us-only-serverless.md), and that is
  accepted as the price of the residency guarantee. It also puts pressure on
  the cost record, which is the one number the deferred budget would enforce
  against: Bifrost's catalog either prices the base model or does not know the
  router id at all, so item 16's reconciliation against a week of real billing
  is what proves the per-key numbers and produces the override. The DeepSeek
  V4.1 Flash class above is the only one on this provider today, so the premium
  is one model's worth.
- **Fireworks Enterprise data residency is deliberately not enabled.** The
  endpoint and the router ids scope the gateway's traffic; they do not scope
  the account. The same `FIREWORKS_API_KEY`, used outside Bifrost, can still
  call global models, so this decision binds the gateway and not the account's
  residency posture. Making it an account property is Fireworks' Data Residency
  setting (an Enterprise feature and a procurement step), which is out of scope
  here in the same way Bifrost Enterprise is. Stated once, here, so the residual
  is a known one: if account-wide residency is ever needed, it is a Fireworks
  contract change, not another edit to this file.

One limit of the word "US" is worth writing down rather than discovering from a
bill or an audit. A `us.` profile is a **geo** profile: AWS routes it among the
profile's member regions, and for the Anthropic models the model card describes
that geography as "within US and Canada" (`utils/bedrock-models.ts` records the
same fact for Sonnet 5.5). So on Bedrock this rule means US geography as AWS
defines it, which is the account's existing convention, not literal US soil.
Only in-region invocation would be narrower, and several of these models
support no in-region profile at all (Opus 5.5, Kimi K3), so it is not available
for the set. The Fireworks half is stricter, because US-only Serverless is US
inference by contract.

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
- **One virtual key per person**, named with the person's lowercase email —
  not their username, and not one per harness. A non-human caller (a CI job, a
  shared worker) is deliberately not a case here: it has no person to
  attribute to, and a key per tool for one person divides the number the key
  exists to produce. The key is `sk-bf-*` and is presented via the header each
  harness expects — the same key can be used as `x-bf-vk`,
  `Authorization: Bearer`, `x-api-key` or `x-goog-api-key`, which is why one
  key works across Claude Code, Codex and Gemini CLI.
- **A team per group of humans.** An `engineering` team owns the human keys, so
  the gateway can total them. It was to carry a monthly budget with per-key
  budgets under it; **per-key budgets and rate limits were dropped by agreement
  on #404** ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md),
  "Deferred"), with the providers' own limits as the stopgap. Budget
  enforcement, when it comes back, is a rationing tool: it stops one engineer
  starving the others, and it caps the fleet's spend. It does not raise the
  provider ceiling, which is the account and quota argument
  `workbench-account.md` already makes.
- **Expiry and offboarding.** Offboarding is "deactivate the virtual key",
  which is one action and does not touch a provider. Who does it, and when,
  is [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md): a scheduled
  janitor deactivates a key whose owner has left the Identity Center group,
  and sets `expires_at` plus `delete_after_expire` so the key is removed after
  a retention window rather than losing its spend history on the day someone
  leaves.
- **Admin auth is off; the proxy is the gate.** `governance.auth_config` is
  present with `is_enabled: false`. Turning the shared OSS login off is what
  makes oauth2-proxy plus the allowlist the only gate a human passes (see
  "Protecting the admin surface"); the credential references and the setup
  token stay so operator control to re-enable it is provable. Both are gateway
  secrets and belong in Secrets Manager, not in the repo.
- **The encryption key is load-bearing.** Provider keys stored in the config
  store are encrypted with `encryption_key`
  (`env.BIFROST_ENCRYPTION_KEY`). Losing it means re-entering every provider
  key. It is the single most important secret in this deployment and belongs
  in Secrets Manager with versioning, and in the restore runbook.
- **Ownership.** No human issues or revokes a per-person key: minting is an
  on-demand call from the engineer's own session and revocation is the
  janitor's reconcile loop, both designed in
  [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md). The Bifrost admin
  allowlist is still a human's list, owned by jagoda for now.

## Persistence, backup and upgrade

- **Store.** RDS for PostgreSQL, `config_store` and `logs_store` both
  `type: "postgres"` with `ssl_mode: "require"`. The instance is private, in
  the DB subnet group, encrypted at rest, with automated backups enabled and
  deletion protection on. The master credential is generated, stored and
  rotated by RDS in Secrets Manager (`manageMasterUserPassword`), never
  populated by hand, and reaches the task as an `env.` reference.
- **Availability.** Multi-AZ is the robust choice and protects the database
  against an AZ failure, but it does not make the gateway highly available:
  the OSS app is a single Fargate task, and a task replacement is still a
  short outage. Multi-AZ is therefore a cost/benefit decision rather than an
  HA claim. **Settled in item 7: single-AZ**, which is defensible for the
  inner loop; the DB subnet group already spans both private subnets, so
  `multiAz: true` in `deploy-workbench/rds.ts` is the whole of that change if
  the budget ever justifies it.
- **Content.** `client.disable_content_logging: true` on the client, and audit
  every virtual key for `disable_content_logging: false`. Keep
  `client.allow_per_request_content_storage_override` at its default (`false`)
  so the `x-bf-disable-content-logging: false` header cannot turn content back
  on for one request. Upstream is explicit that the layers compose and that a
  key with `false` overrides the global setting
  (`docs/features/observability/content-logging.mdx`).
- **Retention.** There are two settings at the pinned tag and they are not
  interchangeable. `client.log_retention_days` is the cleanup job's window and
  the one `PUT /api/config` validates — it rejects anything below `1`
  (`handlers/config.go`, "log_retention_days must be at least 1") — while
  `logs_store.retention_days` is the store's own purge window, whose valid
  range starts at `0`. A store that has never saved the first one reports `0`
  on `GET /api/config`, so anything that round-trips the server's own config
  back (the first-admin claim does) gets a `400` until it raises the value.
  `deploy-workbench/bifrost/config.json` sets both to 90 days, so there is one
  retention story rather than two. The account's
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
  a larger decision and is not required for phase one. `/metrics` has no
  direct ALB rule (see "Routing, and the edge invariant"), and a machine
  scraper cannot pass Google SSO, so the scraper must run **inside the task or
  a sidecar and read it over loopback**, with the setup token the OSS setup
  lock requires. Any credential a scraper needs is not a human's SSO session,
  so it cannot be scraped through the proxy.
- **Cost tracking.** Bifrost computes cost from its model catalog. Fireworks
  pricing should be checked against the catalog and overridden with
  `custom_pricing`/pricing overrides if it is wrong or missing — a gateway
  whose per-key cost numbers are wrong is worse than one with none, because
  those numbers are the whole answer to "who spent what" now that budgets are
  deferred, and what a budget would enforce against when one comes back.
- **Budgets and alerts.** The account already has `workbench-monthly-spend` in
  `deploy-workbench/index.ts` with actual and forecasted email notifications,
  and that is the only cap in place for now: per-key and per-team budgets
  inside Bifrost were dropped by agreement on #404
  ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), "Deferred"), leaving
  the providers' own limits as the stopgap. The AWS budget is an alert rather
  than a rationer — it lags hours and stops nothing — which is worth saying
  plainly now that it is the only guardrail on spend. RDS adds its own storage
  and instance cost, which the account budget already covers.
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
- **Phase E — close the credential loop.** How virtual keys reach a person's
  harnesses and the `gp-pi` container, and how offboarding takes them away.
  **Designed** in [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md): a key
  is minted on demand from Identity Center membership and deactivated by a
  scheduled janitor when that membership ends. Rotation is deferred there and
  recorded, not designed. Implementation is still gated on the gateway proving
  out in phase A and being exercised in phases B–D.
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
  keys; the admin surface is protected by oauth2-proxy with a static email
  allowlist and Bifrost's OSS setup lock (the shared admin password no longer
  gates a request; it is only the credential a re-enabled auth would use). The
  allowlist is separate from the
  Identity Center `Admins` group that `sheriff` mutates, so the two drift; the
  most likely incident is an admin who was removed from `Admins` but not from
  the Bifrost list, or a new admin who cannot get in. The list is the control,
  and its owner is named above.
- **The mint path holds an admin-level credential.** The per-user key Lambda
  and the janitor
  ([`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)) both read the setup
  token from Secrets Manager and call the admin API from inside the VPC. They
  are the second and third holders of that token after the oauth2-proxy
  sidecar, and the first holders that *write* with it — the sidecar only
  presents it on a request a human already made — which is why that design
  keeps both functions small, forbids logging request or response bodies, and
  scopes the secret read to one grant each. A bug there is an admin-surface
  bug, not an inference one.
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

- **The Bifrost admin allowlist versus `Admins`.** The allowlist under
  `deploy-workbench/` is maintained by hand (jagoda for now) and is a
  different list from the Identity Center `Admins` group that `sheriff`
  mutates. Decide whether to keep them separate, generate the Bifrost list
  from `Admins` (which needs an Identity Store reader oauth2-proxy does not
  have, so a small job would have to write the file), or move to Verified
  Access, which reads `Admins` natively at roughly $200/month.
- ~~**RDS size and Multi-AZ.**~~ Settled in item 7, implemented in
  `deploy-workbench/rds.ts`: **single-AZ**, `db.t4g.micro`, 20 GiB gp3 (RDS's
  minimum), no storage autoscaling, 7-day automated backup retention, and a
  master password RDS manages and rotates in Secrets Manager rather than one
  a human types. PostgreSQL 16, which is the version upstream's installation
  guide states as the minimum and the version its own guides run
  (`postgres:16-alpine`); 17 is documented as supported but never exercised
  upstream. What remains is not a decision but a test: item 23 rehearses the
  restore.
- ~~**Model allowlist.**~~ **Settled** in "US-only inference" under "Provider
  configuration": the lists are US-only, eight classes, and the Fireworks
  endpoint is the US-only host. What is left of this question is the pricing
  half, and it is now sharper rather than smaller: US-only Serverless is 1.5x
  the base price from 2026-09-01, so a catalog entry that prices the base model
  is wrong by that factor and every per-key cost number inherits the error.
  Wrong pricing makes a future budget wrong. Item 16.
- **How a person is designated for a higher tier.** One key per person and one
  default tier are designed; "who may reach the higher-grade models" is
  deliberately deferred, with the two candidate shapes — a second Identity
  Center group, or an edited per-person record — recorded in
  [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), "Deferred, recorded
  and not designed".
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
- Implementing virtual-key distribution and `gp-pi` wiring. The design is
  [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md) (phase E) and this
  document stops at naming it; the implementation is gated on the gateway
  being proven out.
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
4. **Google OAuth client and the admin allowlist.** Create the Google Cloud
   OAuth client (Web application, consent screen Internal, redirect URI
   `https://bifrost.workbench.goodparty.org/oauth2/callback`) — a manual
   console step, the same one `agent-swarm/README.md` documents — and commit
   the initial `deploy-workbench/bifrost/allowed-emails.txt`. Neither is a
   deploy; both block the phase 1 oauth2-proxy component.

**Phase 1 — network and compute**

5. Add the network to `deploy-workbench/`: VPC, two public subnets, two
   private subnets across two AZs, NAT (or VPC endpoints), route tables, the
   DB subnet group and the security groups.
6. Add the ALB, its target groups and listeners, the ACM certificate and
   validation, and the Route 53 alias, all taking the explicit provider.
7. ~~Add the RDS Postgres instance, private and encrypted, with automated
   backups and deletion protection, and its credentials in Secrets Manager.~~
   **Done** in `deploy-workbench/rds.ts`. PostgreSQL 16, single-AZ
   `db.t4g.micro`, 20 GiB gp3 with autoscaling off, 7-day automated backups,
   deletion protection, no public access, and the RDS-managed master password
   whose secret ARN is exported as `bifrostDatabaseSecretArn`. It consumes the
   DB subnet group and the task-only security group from item 5, which is not
   touched; the ECS task definition and the read grant on that secret arrive in
   item 8, so the database is created and consumed by nothing until then.
8. ~~Add the ECS cluster, task definition and service, copying the
   task-definition idiom in `deploy/components/worker.ts` (execution role with
   the managed ECS policy plus secrets read, a separate task role scoped to the
   Bedrock model list, `secrets` from Secrets Manager, `awslogs`,
   `initProcessEnabled`), and the CloudWatch log group.~~ **Done** in
   `deploy-workbench/ecs.ts`. One cluster with container insights; one Fargate
   task definition at 0.5 vCPU / 1 GB, `awsvpc`, x86_64 because the mirror pulls
   `linux/amd64`; one task, `desiredCount: 1`, with
   `minimumHealthyPercent: 0` / `maximumPercent: 100` so a deploy stops the old
   task before starting the new one rather than briefly running two — ECS's
   defaults (200/100) permit that overlap, and two OSS Bifrost processes against
   one database is the multi-node configuration upstream does not support; the
   `/aws/ecs/bifrost` log group at 30 days. It consumes item 5's private subnets
   and task security group and item 7's database secret, and declares neither
   again. It deliberately did **not** name a target group; item 9 adds the
   rules and the registration together, and its entry below supersedes this
   sentence.

   The task definition is `deploy/components/worker.ts`'s idiom, with two
   deliberate differences. The task role is a separate identity holding only
   `bedrock:Converse`, `bedrock:ConverseStream`, `bedrock:InvokeModel` and
   `bedrock:InvokeModelWithResponseStream` on `bedrockInvokeResources()`
   (`utils/bedrock-models.ts`), plus `bedrock:ListFoundationModels` on `*` so
   the provider's model list renders (see "Compute: ECS Fargate" and "Provider
   configuration"; that action has no resource type, so it is the single
   wildcard in the role), where the delegate's task role carries five
   AWS-managed read policies and wildcard resources, because the gateway is a
   proxy rather than an agent that explores the account. And the execution
   role reads three secrets, not one: `bifrost/gateway`, `bifrost/oauth2-proxy`
   (so item 9 is not also an IAM change) and the RDS-managed master secret,
   which is the `PG_PASSWORD` item 7 handed over.

   The two secret containers are **not** Pulumi resources. `fill-secrets.sh`
   created them out of band and they hold real values, so a Pulumi-owned
   container could be replaced and delete them. The task definition references
   them by the names and JSON keys that script writes —
   `bifrost/gateway`'s four into the Bifrost container — and `preview` reads
   nothing from Secrets Manager at all, which is what keeps it working without
   `secretsmanager:GetSecretValue`. At item 8 the three `OAUTH2_PROXY_*` keys
   were named in the module and read-granted but not injected; item 9 injects
   them into the sidecar. `BIFROST_CONFIG` and the rest of the runtime
   configuration are item 10, so **the container cannot answer `/health` until
   then**; the plan's staging, not a defect.

   The one place this item could not be implemented as written is the
   service's load-balancer registration, and it is a defect in the sequencing
   rather than in either item. ECS's `CreateService` rejects a target group
   that no listener or listener rule references — `InvalidParameterException:
   The target group with targetGroupArn ... does not have an associated load
   balancer` — and item 6 attaches neither group to a routing rule: the HTTPS
   listener's default action points at oauth2-proxy, deliberately fail-closed.
   So item 8 cannot register against either group, and the plan's "registered
   against both ALB target groups" cannot hold until the rules exist. The
   association and the attachment therefore arrive together in item 9, with
   the rules; meanwhile the task runs with no target registered, which is the
   safe direction — the ALB's default action answers 503, and a container
   cannot fail a health check nobody is asking for. `ingress.ts`'s note that
   item 8 registers a target into the Bifrost group predated this constraint;
   item 9 corrected it along with the registration.
9. ~~Add the oauth2-proxy sidecar to the task definition and the
   admin/inference ALB routing: the `/oauth2/*` and admin-path rules to the
   oauth2-proxy target group on 4180, the inference-prefix rule to the Bifrost
   target group on 8080, the derived oauth2-proxy image with the allowlist
   baked in, and the three `OAUTH2_PROXY_*` secret containers.~~ **Done** in
   `deploy-workbench/ecs.ts` and `deploy-workbench/ingress.ts`.

   The task definition now runs two containers: Bifrost on 8080 unchanged, and
   the derived oauth2-proxy image (`oauth2-proxy-image.ts`) on 4180 with the
   three `OAUTH2_PROXY_*` keys from `bifrost/oauth2-proxy`, the
   Google/cookie/upstream settings from "Protecting the admin surface"
   (`OAUTH2_PROXY_UPSTREAMS: http://127.0.0.1:8080`, the allowlist at
   `/etc/oauth2-proxy/allowed-emails.txt`, the redirect URL and whitelist
   domain derived from the ingress hostname), `awslogs` into the same log group
   and `initProcessEnabled`. Both containers are essential, and their cpu/memory
   reservations split the task's unchanged 0.5 vCPU / 1 GB rather than raising
   it, because Fargate rejects reservations that exceed the task.

   The HTTPS listener gains four rules, none of which re-points the default
   action: `/oauth2/*` to oauth2-proxy (priority 10), `/` and `/api/*` to
   oauth2-proxy (20), the four inference prefixes to Bifrost (30), and
   `/health` and `/metrics` to Bifrost (40). An unmatched path still falls to
   the oauth2-proxy default, and the only paths that reach the gateway directly
   are the enumerated inference and telemetry ones, so no admin or login path
   bypasses the proxy. `/health` is on Bifrost because item 12 proves it through
   the ALB, and `/metrics` stays on Bifrost's own basic auth; they are a
   separate rule because an ALB `path-pattern` condition accepts at most five
   values.

   **Superseded by the proxy-only auth change.** Dashboard auth is now off, and
   the direct rules are the inference prefixes plus `/health`; `/metrics` is no
   longer routed directly. See "Routing, and the edge invariant" and "Bifrost's
   own login is off" above. The rest of this entry is the state item 9 landed
   in.

   The service now registers the task as a target in both groups, with the
   listener rules as an explicit `dependsOn` so the groups are associated
   before `CreateService` runs. That is the registration item 8 could not make,
   and the reason moves with it; `ingress.ts` no longer claims item 8 registers
   a target.

   One consequence to know before item 12: the sidecar names all three
   `OAUTH2_PROXY_*` keys, so the ECS agent will not start the task until item 11
   has written them to `bifrost/oauth2-proxy`. That is the plan's sequence —
   nothing can serve traffic before item 10 supplies `BIFROST_CONFIG` anyway —
   and it fails closed rather than starting a proxy without its credentials.
   This item changes no secret value, no `config.json` and no image pin, and
   nothing was deployed.

**Phase 2 — the gateway itself**

10. Commit the non-secret `config.json` under `deploy-workbench/` with
    providers, client settings and the `governance` block, using `env.`
    references; have Pulumi store it as a plain SSM `String` parameter and
    inject it as `BIFROST_CONFIG`. Set `source_of_truth: "config.json"` for
    the sections the repo owns.
11. Add the secret containers and the read grants, and write the secret
    values out of band (provider keys, `BIFROST_ENCRYPTION_KEY`, admin
    credential, `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`,
    `OAUTH2_PROXY_COOKIE_SECRET`, and `VK_*` only for a key declared here —
    per-person keys are minted, not written, so they have no `VK_*`).
12. Bring the service up and prove phase A: `/health` green through the ALB
    over TLS, inference succeeds with a virtual key and fails without one, a
    Bedrock request succeeds through the task role, and the admin path
    redirects to Google sign-in and rejects an address not on the allowlist.
13. Confirm content logging is actually off end-to-end: make a request with a
    known marker string and show it is absent from the log store and any
    connector. The upstream docs are explicit that the layers compose, so this
    is a test, not a reading.
14. Create the `engineering` team declaratively in `config.json` — the team and
    no budget, since Bifrost-side budgets and rate limits were dropped by
    agreement on #404 — and write the issue/rotate/revoke runbook next to the
    other runbooks. **Superseded in part** by
    [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md): a per-person key is
    minted from Identity Center membership rather than declared here, so this
    file carries the team and no key per person, and the runbook becomes the
    design document beside `gp-pi bifrost-key`.

**Phase 3 — observability and cost**

15. Wire `/metrics` into CloudWatch (agent scrape) or the chosen metrics path.
    It is no longer reachable over the ALB and cannot be scraped through Google
    SSO, so the scraper reads it over loopback from the task or a sidecar, with
    the setup token the OSS setup lock requires.
16. Reconcile gateway cost numbers against a week of provider billing for the
    pilot, and add pricing overrides if they disagree. The US-only premium is
    the expected first disagreement: Fireworks' US-only Serverless is 1.5x the
    base model's price, and Bifrost's catalog may price the base model or have
    no entry for the router id at all, so the override is the multiplier and
    the check is that the gateway's number matches the bill rather than the
    catalog.
17. Confirm the account budget is wired and that a threshold crossing is
    actually delivered (the workbench document's warning about alerts that only
    prove the wire exists). The Bifrost-side budgets this item used to name
    were dropped by agreement on #404, so the account budget is the only one to
    prove.

**Phase 4 — migration**

18. Shadow: move one engineer's harnesses to the gateway, direct path intact.
    Run for a week.
19. Pilot: move a handful of engineers and the `gp-pi` container, direct key
    still present but unused.
20. Default: move every harness, keep the break-glass key, and document the
    rollback in the runbook.

**Phase 5 — close the loop and harden**

21. Credential distribution and `gp-pi` wiring (phase E above), gated on the
    gateway having proven out. **Designed** in
    [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), whose own numbered
    steps 1–6 are the implementation plan for it; a PR implementing one of
    them names that document and its step, not this item.
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
