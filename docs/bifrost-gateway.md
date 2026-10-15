# Bifrost model gateway in the Workbench account

> **Status: proposal. Nothing has been deployed.** This document is the plan
> for putting GoodParty's coding harnesses behind a single self-hosted model
> gateway, [`maximhq/bifrost`](https://github.com/maximhq/bifrost), running in
> the `goodparty-workbench` account. It records the decisions, the reasoning
> and the things that still need a human. It changes no infrastructure.

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
   `https://bifrost.<zone>` with a gateway credential, and never with a
   provider key. `gp-pi`, Claude Code and Codex CLI are the first three
   harnesses to prove it.
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

Three consequences of that placement are worth stating rather than
discovering:

- **The workbench SCP binds the gateway, including the pipeline that
  maintains it.** Anything the SCP denies is denied to `pulumi-deploy` and to
  Bifrost. The relevant denies are in "What the policy denies" in
  `workbench-account.md` and in `deploy-org/policies.ts`: `rds:*`,
  `dynamodb:*`, `redshift:*`; everything outside `us-west-2` except a
  `NotAction` list of global services plus `bedrock` and `aws-marketplace`;
  and `s3:*` on buckets the account does not own. The gateway's own needs —
  ECR, ECS or EC2, EBS, ELB, ACM, Route 53, CloudWatch, Secrets Manager — are
  all inside the region and none of them is denied. The one that matters is
  **no RDS**, which is why the persistence decision below is SQLite.
- **The account is sleepy, and the gateway is not quite.** The workbench
  document justifies the account by the absence of an availability
  obligation: "If it throttles, an engineer waits. Nobody is paged." A gateway
  every harness depends on is closer to that line than Bedrock is, because it
  is a single choke point rather than one of several paths. It is still not
  production, and no page should fire, but the plan should not pretend the
  obligation is zero. The rollback section is the mitigation.
- **No product or voter data enters the account.** The gateway must not
  become a way around that. Content logging is off for this reason, not only
  for cost.

### One node, because OSS is one node

Bifrost draws its OSS/Enterprise line at clustering. The upstream
`docs/deployment-guides/how-to/multinode.mdx` states it plainly: running
multiple OSS nodes with a Postgres backend is **not supported**, because OSS
keeps provider configs, keys, budgets and usage in memory and does not read
them back; Enterprise synchronizes them with a Raft variant. OSS is sized for
"3,000–5,000 RPS on a single instance", which is orders of magnitude above
this workload.

So the plan is one node, and the only honest HA options are Enterprise
(licensing, out of scope here) or a rebuild-and-restore procedure. A second
node behind the same ALB is not a valid configuration and should not be built
"just in case".

### Compute: an EC2 host, mirroring the delegate swarm

The stateful part is the constraint. The gateway needs a SQLite file that
survives task or instance replacement, and `rds:*` is denied by the SCP.
That leaves a block device, which in this repo already has a pattern:
`deploy-infrastructure/agent-swarm.ts` runs a single EC2 instance with Docker
Compose, a `protect`ed and `retainOnDelete` EBS data volume, nightly DLM
snapshots, an SSM association that applies host files, CloudWatch logs, an EIP
and a Route 53 record. The gateway should be built the same way.

Recommended shape:

- One EC2 instance (`m6a.large` or smaller; Bifrost adds microseconds of
  overhead and the load is per-engineer), reached only through the ALB and
  administered through SSM Session Manager. In a private subnet it needs NAT
  egress to reach provider APIs; on the default VPC it sits in a public subnet
  whose security group admits only the ALB. Either is workable; the first is
  the cleaner end state.
- Docker Compose running the `bifrost` container. The ALB terminates TLS, so
  no reverse proxy is required. The image is pinned by tag **and digest**.
- An encrypted `gp3` EBS data volume mounted at the Bifrost app directory,
  holding `config.db`, `logs.db` and the `config.json` seed. `protect:
  true, retainOnDelete: true`, exactly as the swarm volume is.
- A nightly DLM snapshot policy, and a documented restore.

Alternatives, with why they are not the recommendation:

- **ECS Fargate + EFS.** Matches the `delegate` compute idiom and the
  upstream ECS guide, and EFS is allowed by the SCP. But SQLite over NFS is a
  locking hazard, and a single Fargate task with an EFS mount is not a
  materially better availability story than one EC2 instance. Revisit if the
  team would rather not manage a host.
- **RDS/Aurora Postgres.** The clean production answer, and the one the
  upstream ECS guide assumes. It is denied by the workbench SCP. Running it
  would need an SCP exemption, which is a deliberate weakening of the
  account's data boundary and a human-reviewed change in its own right. If
  Postgres is wanted, the honest move is to add the exemption knowingly, not
  to route around the deny.
- **Run it in the infrastructure account,** where RDS is allowed. Rejected:
  the inner loop belongs in workbench, and the infrastructure account's SCP
  was written to permit privileged automation, not to be the data boundary
  for coding agents.

### The repository facts this plan is built on

Cited so the next session can check them rather than trust this document:

| Fact | Source |
| --- | --- |
| Workbench account `024901689212`, `us-west-2` | `utils/accounts.ts`, `docs/workbench-account.md` |
| Pulumi project `deploy-workbench/`, stack `organization/workbench/main` | `deploy-workbench/Pulumi.yaml`, `deploy-workbench/index.ts` |
| CI deploy role `github-actions-workbench-deploy`, workflow `.github/workflows/deploy-workbench.yml` | `.github/workflows/deploy-workbench.yml` |
| Explicit provider, `allowedAccountIds`, default provider disabled | `deploy-workbench/index.ts`, `deploy-workbench/deploy.sh` |
| SCP denies `rds`/`dynamodb`/`redshift`, non-`us-west-2`, cross-account S3 | `docs/workbench-account.md` "What the policy denies", `deploy-org/policies.ts` |
| Account budget `workbench-monthly-spend` | `deploy-workbench/index.ts` |
| Bedrock invocation logging, metadata only, 365-day retention | `deploy-workbench/index.ts` |
| Identity Center `WorkbenchAccess`/`Engineers`, `AdministratorAccess`/`Admins` | `deploy/components/identity-center.ts`, `docs/workbench-account.md` |
| Secrets live in Secrets Manager, written out of band | `docs/workbench-account.md` (`gp-pi/brave-search`), `deploy-infrastructure/agent-swarm.ts` (`DELEGATE_SWARM`) |
| EC2 + EBS + DLM + SSM host pattern | `deploy-infrastructure/agent-swarm.ts` |
| Delegated DNS subzone pattern | `deploy-infrastructure/dns.ts`, `deploy/components/infra-zone-delegation.ts` |
| Delegate image push to ECR | `.github/workflows/deploy.yml` (`delegate-worker`) |

Two facts are **not** in the repository, and are open questions rather than
assumptions: the workbench account's VPC and subnets, and whether it owns a
Route 53 hosted zone. Neither appears anywhere in `deploy-workbench/`, the
workbench document or `utils/`. The infrastructure account's
`vpc-0930cabea81245d01` / `subnet-0184e0f40b440ab13` are hardcoded in
`deploy-infrastructure/agent-swarm.ts` and belong to that account, not this
one.

## Network, TLS and ingress

### VPC placement

The gateway needs a VPC with at least two subnets for the ALB and one subnet
for the instance, plus a route to the internet for provider egress. If the
workbench account has only the AWS default VPC, that is enough for a first
deployment but should be a named decision: a dedicated VPC with private
subnets and a NAT gateway (or VPC endpoints for ECR, Secrets Manager,
CloudWatch and S3) is the cleaner end state, and the SCP's region and
cross-account S3 denies do not interfere with any of it.

The instance is not reachable from the internet. It is administered through
SSM Session Manager, as the swarm host is. Its security group accepts port
8080 only from the ALB security group.

### TLS and DNS

- An internet-facing Application Load Balancer, HTTPS listener on 443 with an
  ACM certificate in `us-west-2`, and an HTTP listener that redirects to
  HTTPS. Target group on port 8080, health check `/health`.
- A Route 53 alias record for `bifrost.<zone>` pointing at the ALB.
- ACM DNS validation needs a zone the account controls. The workbench account
  has none today. The repo's pattern is a delegated subzone: the
  infrastructure account owns `infra.goodparty.org`, created in
  `deploy-infrastructure/dns.ts` and delegated from the management account by
  the NS record in `deploy/components/infra-zone-delegation.ts`. The
  workbench account should get the same treatment — a `workbench.goodparty.org`
  zone in `deploy-workbench/`, delegated by one NS record added to `deploy/`
  in the management account. `bifrost.workbench.goodparty.org` is then a
  record the workbench stack owns.
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

Two things the plan must do itself:

- **Provision the credential.** The virtual key has to reach the harness.
  For engineer machines, the CLI/configure path is fine. For the `gp-pi`
  container, the key belongs in Secrets Manager next to `gp-pi/brave-search`
  and is read with the same `WorkbenchAccess` session the container already
  holds; the container's harness env then points at the gateway.
- **Keep the admin surface off the public path.** Bifrost serves its Web UI
  and admin API on the same listener as inference. An ALB listener rule should
  allow the inference paths (`/v1/*`, `/anthropic/*`, `/openai/*`,
  `/genai/*`, `/health`, `/metrics` if scraping) from the internet, and
  restrict the UI and `/api/*` to a private network or an office/VPN CIDR
  allowlist. If that is too fiddly for phase one, the fallback is to enable
  admin auth and accept a publicly reachable login page; that is a decision,
  not a default.

### Public versus VPN-only

The recommendation is a public HTTPS endpoint with virtual-key enforcement,
because it works from anywhere a harness runs, including the cloud container,
without depending on private-network reachability. The alternative — an
internal ALB reachable only over a private path such as the `gpvpn` stack —
is stronger against scanning and credential-stuffing, at the cost of making
that path a dependency of the coding loop. The threat model to weigh is not
"can someone reach port 443"; it is "can someone get a virtual key", and the
key is the control either way. This is left as an explicit decision rather
than assumed. Note that the repo does not document whether engineers already
have a working VPN path to AWS; `gpvpn` appears only as a repository in the
`github-actions-pulumi-deploy` trust list (`docs/deploy-role-trust.md`,
`deploy/components/ci-roles/policies.ts`).

## Provider configuration

Bifrost takes providers from `config.json` and/or its config store. Provider
keys are referenced by name, never written down here or in git.

- **Fireworks** is the provider the fleet uses today. Upstream supports it as
  an OpenAI-compatible provider
  (`docs/providers/supported-providers/fireworks.mdx`), including
  `use_anthropic_endpoints` for harnesses that speak the Anthropic Messages
  shape. The key is `env.FIREWORKS_API_KEY`, injected from Secrets Manager,
  and the config allows only the models the fleet actually uses rather than
  `*`.
- **Bedrock** is the second provider, and it is the interesting one: upstream
  supports "Inherited AWS Credentials / IAM Role" authentication
  (`docs/providers/supported-providers/bedrock.mdx`), which means the EC2
  instance profile is the credential. No static AWS key is stored anywhere.
  The instance role is scoped to the same model list in
  `utils/bedrock-models.ts` that `WorkbenchAccess` uses today, and the SCP's
  existing `bedrock` exemption keeps geo-profile calls working. This is what
  lets the gateway take over Bedrock entirely, including the per-user
  attribution the invocation log provides today.
- **Other providers** (Anthropic direct, OpenAI direct) are added only if a
  harness needs them, each with its own `env.` reference. Provider fallback
  between Fireworks and Bedrock is a configuration choice; it is the main
  reliability argument for the gateway, and it should be turned on
  deliberately with a model mapping rather than left to a default.

Secrets discipline for this document and the PR that eventually implements
it: no key, token or account secret appears in a plan, a `config.json` checked
into git, or a PR body. The seed `config.json` references `env.*`; the values
live in AWS Secrets Manager, written out of band the way `DELEGATE_SWARM` and
`gp-pi/brave-search` are.

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
- **Admin auth.** Enable `auth_config` (admin username/password, or Enterprise
  SSO if that is ever bought) so the UI and governance API are not open. The
  admin credential is a gateway secret and belongs in Secrets Manager, not in
  the repo.
- **The encryption key is load-bearing.** Provider keys stored in the config
  store are encrypted with `encryption_key`
  (`env.BIFROST_ENCRYPTION_KEY`). Losing it means re-entering every provider
  key. It is the single most important secret in this deployment and belongs
  in Secrets Manager with versioning, and in the restore runbook.

Key issuance is deliberately a runtime action, not a Pulumi resource: keys
live in the config store, are created through the UI or API, and are not in
git. That is also why the plan needs a short runbook (issue, rotate, revoke)
rather than a Pulumi resource per engineer.

## Persistence, backup and upgrade

- **Stores.** `config_store` (providers, virtual keys, teams, budgets) and
  `logs_store` (request records) both on SQLite, on the EBS data volume. The
  upstream default is SQLite, and it is the only supported OSS option that
  fits the SCP. Postgres is available the day an SCP exemption exists.
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
- **Backup.** Nightly DLM snapshots of the data volume, retaining two weeks,
  mirroring `deploy-infrastructure/agent-swarm.ts`. The encryption key and
  provider keys are in Secrets Manager and are not part of the snapshot; a
  restore is "volume from snapshot, same Secrets Manager values". A restore
  must be rehearsed once, because a backup nobody has restored is a belief.
- **Upgrade.** Pin the image by tag and digest (`maximhq/bifrost:v2.3.0` at
  the time of writing) and update it in a PR that also bumps the digest. The
  procedure is: snapshot the volume, pull the new image, `docker compose up
  -d`, watch `/health` and the logs. Bifrost runs store migrations at startup,
  so the snapshot is the rollback, not the previous binary alone. Rollback is
  previous digest + snapshot if the schema moved; previous digest alone if it
  did not.
- **Configuration source.** Use file-only (`config_store.enabled: false`) for
  providers and client settings if the team wants the repo to be the source of
  truth, accepting that UI edits are then unavailable. Or use the config store
  for governance and a `config.json` seed for providers. Either is upstream-
  supported; the decision affects whether virtual keys are managed in the UI
  or declared, and the UI path is what makes per-engineer keys practical. This
  plan assumes the config store is enabled.

## Observability, usage and cost

- **Per-request records.** The built-in log store captures model, provider,
  latency, tokens and cost per request, keyed by virtual key and team
  (`docs/features/observability/default.mdx`). With content logging off, what
  remains is metadata — the same posture as the account's Bedrock invocation
  logging, and for the same reason.
- **Metrics.** Bifrost exposes `/metrics` (Prometheus) when the telemetry
  plugin is on, which it is by default. There is no Prometheus in the
  workbench account today, so the low-friction path is the CloudWatch agent
  scraping `/metrics` on the host and publishing selected series, plus
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
  account-level backstop and lags hours; the Bifrost budget is the
  fast, per-person control.
- **Audit.** CloudTrail for the account covers infrastructure actions. The
  gateway's own log is the record of model traffic. Neither is a content log,
  by design.

## Migration from direct provider access, and rollback

The migration is configuration on the harness side, so it is reversible for as
long as the direct path is kept.

- **Phase A — shadow.** Stand up the gateway and route one engineer's
  harnesses through it while their direct provider credentials stay in place.
  Compare cost and token numbers between the gateway and the provider's own
  billing for a week. Fix routing, model aliases and pricing before more
  people depend on it.
- **Phase B — pilot.** Move a handful of engineers and the `gp-pi` container
  to the gateway. Keep the direct Fireworks key in the container's secrets
  during this phase, unused, so a gateway outage is a one-line env change, not
  an outage.
- **Phase C — default.** Make the gateway the default for every harness.
  Remove direct provider keys from engineer environments and from the
  container's default env. Keep the break-glass direct key in Secrets Manager,
  documented and audited, for the duration of one full cycle.
- **Phase D — tighten.** Narrow `WorkbenchAccess`'s Bedrock invoke to what the
  gateway's instance role needs (or remove it from engineers entirely), which
  is the payoff the workbench document's open question about removing
  `bedrock:*` from `EngineerAccess` is pointing at. This is a follow-up with
  its own PR.

**Rollback, at each phase:**

- Phases A–C: revert the harness base URL and restore the direct key. The
  direct path is still there; the gateway is bypassed, not dismantled.
- Phase D and later: the break-glass key in Secrets Manager is the path back.
  Re-issuing per-engineer direct keys is the manual fallback if that fails.
- Data rollback: the EBS snapshot. Config rollback: Secrets Manager versions.

The failure to plan around is not "the gateway returns errors" — Bifrost's
provider fallback handles a single provider being down. It is "the single OSS
node is down", at which point every harness stops. That is the reason
break-glass survives phase D, and it is the honest cost of choosing OSS over
Enterprise clustering.

## Risks, open questions and out-of-scope

### Risks

- **Single point of failure.** OSS is single-node; the gateway is a choke
  point for all coding. Mitigated by break-glass, not eliminated.
- **A public endpoint and an admin UI.** Inference is protected by virtual
  keys; the UI/API needs its own protection (ALB listener rule or auth).
  Getting this wrong is the most likely way the plan causes an incident.
- **The encryption key.** Losing it invalidates stored provider keys. It must
  be in Secrets Manager, versioned, and in the restore runbook.
- **Content logging defaults to on.** Every layer must be turned off
  explicitly, and a virtual key created with `false` silently overrides the
  global setting. The plan treats this as a data-boundary control, not a
  preference.
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

- **VPC and subnets.** The workbench account's network is not described
  anywhere in the repo. Is there a VPC to use, is it the default VPC, and are
  there private subnets with egress? Everything else in "Network" depends on
  this.
- **DNS zone.** Should the workbench account get a delegated
  `workbench.goodparty.org` zone (recommended, one NS record in `deploy/`), or
  is there an existing zone the plan did not find?
- **Public or VPN-only ingress.** Recommended public HTTPS with virtual keys;
  the alternative is a private path (is `gpvpn` a usable VPN for engineers
  today, and from the cloud container?). This is a threat-model decision, not
  a technical one.
- **Compute: EC2 or Fargate.** Recommended EC2 + EBS for SQLite, mirroring the
  swarm host; Fargate + EFS is the alternative if managing a host is
  unwelcome. This also decides whether the repo grows an ECS or an EC2 idiom
  in `deploy-workbench/`.
- **Postgres or SQLite.** SQLite is the recommendation because `rds:*` is
  denied. If Postgres is wanted, that is an SCP exemption and a deliberate
  change to the account's data boundary, which needs its own decision.
- **Who owns key issuance and offboarding.** The gateway is only as good as
  the process that revokes a key when someone leaves. Name the owner before
  phase C.
- **Enterprise or OSS.** Everything above assumes OSS. Enterprise would add
  clustering, SSO, vault references and access profiles, and changes the
  availability story; it also costs money and is a procurement decision.

### Out of scope

- Deploying anything. This is a plan.
- Buying or evaluating Bifrost Enterprise.
- Replacing or re-scoping `WorkbenchAccess`, removing `bedrock:*` from
  `EngineerAccess`, or changing the workbench SCP. Those are follow-ups with
  their own PRs, even where this plan depends on them.
- Any change to the `delegate` worker, the `ops` delegate pipeline, or
  production traffic. The gateway is for the developer inner loop.
- A Prometheus/Grafana buildout. CloudWatch plus the built-in UI is the phase
  one answer.
- Multi-region, multi-account or multi-node gateway topologies.

## Phased task list

Rough sequencing; each numbered item is a PR unless it says otherwise. The
dependency that matters is called out: nothing that assumes a name or a
network can land before the item that creates it.

**Phase 0 — decisions and prerequisites (no infrastructure)**

1. Answer the open questions above, at least the VPC, DNS, ingress and compute
   ones. Record the answers in this document.
2. Verify the workbench account's VPC, subnets, default VPC state and any
   existing hosted zone with read-only AWS calls. Record the ids here.
3. Mirror `maximhq/bifrost:v2.3.0` into an ECR repository in the workbench
   account (or a shared one), pinned by digest, following the delegate image's
   build/push pattern in `.github/workflows/deploy.yml`. Decide the digest
   upgrade cadence.

**Phase 1 — network and compute**

4. Add a `bifrostZone` (or reuse the decided zone) and the delegation NS
   record: the zone in `deploy-workbench/`, the NS record in `deploy/`, in the
   infra-zone-delegation shape. The grant/ordering rule from
   `workbench-account.md` applies.
5. Add the gateway's networking and compute to `deploy-workbench/`: security
   groups, the EC2 instance (or ECS service), the EBS data volume, the ALB +
   target group + listeners, the ACM certificate and validation, and the
   Route 53 alias. No EIP: the ALB is the address. All resources take the
   explicit provider, as the project requires.
6. Add the Secrets Manager secrets (Bifrost `encryption_key`, admin
   credential, Fireworks key), created out of band with the ARNs referenced
   from the stack, not values in git. Extend the workbench secret-read grant
   if the container is to read a virtual key.
7. Add the DLM snapshot policy, the SSM host-sync association and the
   CloudWatch log group, following `deploy-infrastructure/agent-swarm.ts`.

**Phase 2 — the gateway itself**

8. Seed `config.json`: providers (Fireworks via `env.FIREWORKS_API_KEY`,
   Bedrock via inherited instance role), client settings
   (`enforce_auth_on_inference: true`, `disable_content_logging: true`,
   retention), and the admin auth config.
9. Bring the service up and verify: `/health` is green through the ALB over
   TLS, an inference request succeeds with a virtual key and fails without
   one, and a Bedrock request succeeds through the instance role.
10. Create the `engineering` team, its budget, and the first virtual keys.
    Write the issue/rotate/revoke runbook next to the other runbooks.
11. Confirm content logging is actually off end-to-end: make a request with a
    known marker string and show it is absent from the log store and any
    connector. The upstream docs are explicit that the layers compose, so this
    is a test, not a reading.

**Phase 3 — observability and cost**

12. Wire `/metrics` into CloudWatch (agent scrape) or the chosen metrics path,
    with the credentials the enabled admin auth requires.
13. Reconcile gateway cost numbers against a week of provider billing for the
    pilot, and add pricing overrides if they disagree.
14. Confirm the account budget and the Bifrost budgets are both wired, and
    that a threshold crossing is actually delivered (the workbench document's
    warning about alerts that only prove the wire exists).

**Phase 4 — migration**

15. Pilot: move one engineer's harnesses and the `gp-pi` container to the
    gateway, with the direct path intact. Run for a week.
16. Default: move every harness, keep the break-glass key, and document the
    rollback in the runbook.
17. Tighten: narrow `WorkbenchAccess`/`EngineerAccess` Bedrock invoke and
    remove direct provider keys, in a separate PR, after a full cycle on the
    gateway.

**Phase 5 — hardening**

18. WAF on the ALB if the public-endpoint decision stands; admin-surface
    allowlisting if not.
19. A restore rehearsal from an EBS snapshot, recorded with its date and the
    evidence.
20. A digest-upgrade rehearsal, including a migration rollback, recorded the
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
  `deployment-guides/config-json/secret-management.mdx` — config, SQLite vs
  Postgres, the Enterprise-only vault integration.
- `features/governance/virtual-keys.mdx` — virtual keys, teams, budgets,
  expiry, mandatory auth.
- `features/observability/default.mdx`,
  `features/observability/prometheus.mdx`,
  `features/observability/content-logging.mdx` — logging, metrics, and the
  content-logging layers.
- `providers/supported-providers/fireworks.mdx`,
  `providers/supported-providers/bedrock.mdx` — provider auth, including
  Bedrock's inherited IAM role.
- `quickstart/cli/coding-agents.mdx` (from `main`) — harness paths and the
  `bifrost` CLI.

Bifrost is Apache-2.0. The features this plan deliberately does not use —
clustering, SSO, access profiles, AWS Secrets Manager `vault_store` — are
Enterprise-only, and the plan is written to stand on OSS alone.
