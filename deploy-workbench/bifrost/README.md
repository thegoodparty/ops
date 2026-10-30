# Bifrost admin surface: oauth2-proxy

Bifrost OSS has no native OIDC/SSO, so the gateway's dashboard and management
API are gated by [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/)
running as a sidecar in the same Fargate task (phase 1 item 9 of
[`docs/bifrost-gateway.md`](../../docs/bifrost-gateway.md)). This directory
holds the gateway's repo-owned configuration and the two sidecar-specific
files that belong in review:

- `config.json` — the non-secret Bifrost configuration (phase 2 item 10):
  both stores, providers, client settings and the `governance` block. See
  "`config.json`" below.
- `config.test.ts` — the checks that keep `config.json` honest: valid JSON,
  both providers, both stores in Postgres, every `env.` reference a name the
  deployment actually provides, no credential literal, the US-only model rule
  (no `global.` id, `us.` Bedrock profiles only, Fireworks US router ids and
  the `us.api.fireworks.ai` endpoint, and the agreed class set pinned as
  literals), and Bedrock's US-profile subset matching
  `utils/bedrock-models.ts` (the list the task role's IAM is built from,
  alongside the `bedrock:ListFoundationModels` grant that renders it).
- `vk-mint-template.json` — the default per-person virtual key shape, as data
  ([`docs/bifrost-virtual-keys.md`](../../docs/bifrost-virtual-keys.md),
  step 1). See "Virtual-key template" below.
- `vk-mint-template.test.ts` — pins the template's provider and model lists to
  `config.json`, its Lambda-managed marker, decision 5's absences, and the same
  US-only rule from the key's side, since a key may not name a model the
  gateway would refuse.
- `allowed-emails.txt` — the admin allowlist, one `goodparty.org` address per
  line, the same shape as `agent-swarm/host/allowed-emails.txt`. Granting or
  revoking access is a PR to this file. The list is deliberately **separate**
  from the Identity Center `Admins` group, which `sheriff` mutates at runtime,
  so the two are expected to drift. The owner is **jagoda for now**.
- `Dockerfile` — the derivative of the stock oauth2-proxy image: it bakes the
  allowlist and the alpha configuration in, and keeps upstream's own
  `ENTRYPOINT`. The Go entrypoint wrapper it used to build in a stage of its
  own is gone with Bifrost's Basic login (see "The image").
- `alpha-config.yaml` — oauth2-proxy's alpha configuration, loaded with
  `--alpha-config`: the Google provider, the upstream, the listen address and
  the `injectRequestHeaders` entry that presents Bifrost's setup token on every
  proxied request, so the OSS setup lock is satisfied by the deployment rather
  than by a human. See "The image" below.
- `bootstrap.sh` and `bootstrap.Dockerfile` — the one-shot claim container
  (phase 2 item 11): the script that creates the first admin account from
  inside the task, and the derivative of the pinned Bifrost image that gives it
  `curl` and `jq`. Its pin and content-addressed tag live in
  `deploy-workbench/bootstrap-image.ts`.

The ECS task definition, the sidecar container and the ALB routing rules are
the other half of phase 1 item 9 and live in `deploy-workbench/ecs.ts` and
`deploy-workbench/ingress.ts`: the task runs this image on 4180 with the three
`OAUTH2_PROXY_*` secrets, the `BIFROST_SETUP_TOKEN` key the injected header is
read from, and the `--alpha-config` flag that loads the rest, while the settings
alpha configuration did not absorb stay as `OAUTH2_PROXY_*` environment
variables. The HTTPS listener sends `/oauth2/*` and the admin paths to the
sidecar; the inference prefixes and `/health` go straight to Bifrost, and
`/metrics` falls to the proxy default because it no longer has a credential of
its own. Those secrets are written to Secrets Manager out of band (phase 2 item
11) with `fill-secrets.sh`, never committed; see "Secrets" below.

## `config.json` (phase 2 item 10)

`config.json` is the deployment's declarative Bifrost configuration, authored
against `transports/config.schema.json` at the pinned upstream tag
`maximhq/bifrost:v2.3.2` (`deploy-workbench/bifrost-image.ts`), not the docs at
a later tag. It holds:

- **The stores.** `config_store` and `logs_store` both point at the RDS
  instance from `deploy-workbench/rds.ts` (`type: "postgres"`, `ssl_mode:
  "require"`), which is what makes gateway state — the admin account, virtual
  keys, budgets, request logs — survive a task replacement. With no
  `config_store` Bifrost creates a SQLite file inside the container, and every
  deploy takes it with it. The connection fields are `env.` references to the
  task definition's `PG_*` values rather than a connection string spelled in
  this file, and `logs_store.retention_days` is explicit (90) because the
  upstream default prunes nothing.
- **Providers.** `fireworks`, pinned to Fireworks' US-only Serverless endpoint
  (`network_config.base_url: https://us.api.fireworks.ai/inference`, the only
  `base_url` in the schema at the pinned tag) with its key read from
  `env.FIREWORKS_API_KEY` and an explicit list of US router ids
  (`accounts/fireworks/routers/<model>-us`) rather than `*`; and `bedrock`,
  whose key carries no credential at all: Bifrost inherits the ECS **task
  role** through the AWS default credential chain, so `bedrock_key_config`
  sets only the region. The Bedrock model list is the `us.`-profile subset of
  `utils/bedrock-models.ts`, which is what the task role's IAM policy
  enumerates; the test fails if the two drift, because a model in one and not
  the other is a 404 or an `AccessDenied` at runtime. The IAM grant is allowed
  to be wider than the gateway's list — it is the sandbox's direct path too —
  and that is why the config carries no bare foundation-model id and no
  `global.` profile: US-only inference is the rule (`docs/bifrost-gateway.md`,
  "US-only inference"), and DeepSeek V3.2 is the class it costs, since Bedrock
  publishes no `us.deepseek.v3.2` profile. Listing that list is a separate
  permission from invoking it: the provider renders its model list from a
  signed `GET /foundation-models`, so the task role also holds
  `bedrock:ListFoundationModels` (on `*`, since Bedrock defines no resource
  type for it). Without it the provider page shows
  `not authorized to perform: bedrock:ListFoundationModels` instead of the
  models, which the IAM tests in `deploy-workbench/ecs.test.ts` pin. The `us.`
  inference profiles in the list need no separate read — they come from the
  key's own `models` allowlist and are invoked through profile ARNs the invoke
  statement grants.
- **Prompt caching on Bedrock, and not on Fireworks.** `providers.bedrock`
  carries `prompt_cache` with `auto_inject: true` and two injection points, the
  system message and the last message (`{ "location": "message", "role":
  "system" }` and `{ "location": "message", "index": -1 }`), so a harness that
  sends no `cache_control` still gets a Bedrock `cachePoint` after the system
  prompt and after the newest turn. The points replace the default
  first-block placement, which is why `auto_inject` has to stay on; no `ttl` is
  set, because `"1h"` is the only value and it doubles the write cost. The
  `bedrock` provider is the only one with a block: Fireworks caches a repeated
  request prefix server-side, so a marker there would be a no-op. The pinned
  image matters for this half too — at `v2.3.0` the Bedrock converter dropped a
  top-level `cache_control` instead of emitting a `cachePoint`
  (maximhq/bifrost#8541), so the block only does anything on the pinned
  `v2.3.2`. See "Prompt caching" in [`docs/bifrost-gateway.md`](../../docs/bifrost-gateway.md).
- **Client settings.** Inference auth is enforced
  (`enforce_auth_on_inference: true`), direct provider keys are refused
  (`allow_direct_keys: false`), content logging is off with no per-request
  override, metadata logging is on with an explicit 90-day retention, and the
  gateway's public origin is the only allowed CORS origin.
- **Governance.** `auth_config` is present with `is_enabled: false`: Bifrost's
  own dashboard login is off, and oauth2-proxy plus the allowlist is the only
  gate a human passes. At the pinned tag a file's `auth_config` is *not*
  write-only the way an API config write is — `loadAuthConfig` in
  `transports/bifrost-http/lib/config.go` reads it at boot, hashes the password
  and writes the admin account to the config store — so the account exists with
  auth disabled, which is the state re-enabling it acts on. The username and
  password references stay for that reason: turning auth back on should be one
  decision, not a config-shape change with no credential. Re-enabling needs
  proof of operator control, and the setup token is it. The `engineering`
  team is **item 14** and is deliberately absent, not empty: under
  `source_of_truth: "config.json"` a present-but-empty section would prune rows
  created later. It carries no budget, because Bifrost-side budgets and rate
  limits were dropped on #404. Per-person virtual keys are not declared in this
  file at all: they are minted through the gateway's admin API and live only in
  Bifrost, which returns its own plaintext value
  ([`docs/bifrost-virtual-keys.md`](../../docs/bifrost-virtual-keys.md)), so
  there is never a key here to name or to prune.
- **The first-run claim.** Top-level `"setup_token":
  "env.BIFROST_SETUP_TOKEN"` (phase 2 item 11). It is top-level and not under
  `governance` because that is where `transports/config.schema.json` puts it at
  `v2.3.2`, and `resolveSetupToken` also reads the `BIFROST_SETUP_TOKEN`
  environment variable when the file does not set one. The value is a
  credential: a reference only, never a literal, and the test fails if one
  appears.
- **`source_of_truth: "config.json"`** for the sections above, so a redeploy
  converges to the repo instead of preserving UI drift. An omitted section is
  left alone; an empty one prunes.

**What is injected by env.** No secret is in the file. Every credential is an
`env.NAME` reference, and the names come from two places: the five keys in
`bifrost/gateway` that `fill-secrets.sh` writes
(`BIFROST_ENCRYPTION_KEY`, `BIFROST_ADMIN_USERNAME`, `BIFROST_ADMIN_PASSWORD`,
`BIFROST_SETUP_TOKEN`, `FIREWORKS_API_KEY`), and the task definition's own
environment and RDS-managed password entry for the Postgres connection
(`PG_HOST`, `PG_PORT`, `PG_USER`, `PG_DATABASE`, `PG_PASSWORD`). Bedrock has no
entry because its credential is the role. `config.test.ts` fails on a
reference to a name neither provides, and `deploy-workbench/ecs.test.ts` fails
on a name the task definition does not inject.

**How it reaches the container (item 10's second half).**
`deploy-workbench/ecs.ts` reads this file at deploy time, stores it in the SSM
parameter `/bifrost/config`, injects it as `BIFROST_CONFIG`, and overrides the
gateway container's entry point with upstream's documented ECS shape: write
the variable to `/app/data/config.json`, then `exec /app/docker-entrypoint.sh
/app/main`, so the image's own entry point is still PID 1 and the app-dir
checks and signal handling are unchanged. A task with no `BIFROST_CONFIG`
exits instead of starting on Bifrost's built-in defaults — which is the state
this replaced: `"config file not found at path: /app/data/config.json,
initializing with default values"`, a container-local SQLite config store, and
inference auth not enforced.

The parameter is a plain `String`, not the plan's `SecureString`. The file holds
no secret by construction (the test above enforces it), so encryption would buy
nothing, while a `SecureString` would make the ECS agent need `kms:Decrypt` on
the account's `aws/ssm` key — either a wildcard key resource or a deploy-time
`kms` lookup that a `preview` would then need permission to run. Standard tier
holds 4 KiB; this file is about 2.5 KB, which leaves room for item 14's team,
and past that it needs `tier: "Advanced"` rather than a silent truncation.

**A change to this file reaches the gateway.** The container's `secrets` entry
names the parameter's ARN, and an ARN does not change when the value does, so
the task definition also carries a digest of the file's contents as
`BIFROST_CONFIG_VERSION`. A merged edit to `config.json` therefore registers a
new task-definition revision and the service's stop-before-start rollout picks
it up; without that, the apply would update the parameter and leave every
running task on the file it booted with. The digest is also how an operator
answers "which config is this task running" from `describe-task-definition`:
the value names the content, not a write counter.

The digest is computed in the Pulumi program (`bifrostConfigVersion` in
`ecs.ts`), not read from the parameter resource. `aws.ssm.Parameter.version` is
assigned by AWS, so a preview of the apply that changes the file cannot know
it: Pulumi collapses the whole stringified `containerDefinitions` into its
unknown sentinel (`04da6b54-80e4-46f7-96ec-b56ff0331ba9`), and the pre-apply
secret check in `scripts/preflight-secrets.ts` has no definition to read. That
is what failed the deploy on the merge of #393 (run 40725087936): the check
refused, correctly, and no task was drained because the apply never ran. The
digest is known at preview, so the check sees the definition again.

Two consequences worth knowing before a deploy:

- The stores are now the RDS instance (`config_store` and `logs_store`,
  `type: "postgres"`), so gateway state survives a task replacement. Until
  this landed, every deploy took the admin account with it and the dashboard
  went back to the setup page.
- `client.enforce_auth_on_inference: true` becomes effective with the same
  apply, and no virtual key exists yet, so inference refuses everything until
  one does — minted for a person by the path in
  [`docs/bifrost-virtual-keys.md`](../../docs/bifrost-virtual-keys.md), or
  declared here for a caller that is not a person. That is the plan's phase A
  order ("inference succeeds with a virtual key and fails without one"), not a
  defect — but the two have to land close together.

## Virtual-key template

`vk-mint-template.json` is the default shape of a per-person key, committed as
data rather than built in code (step 1 of
[`docs/bifrost-virtual-keys.md`](../../docs/bifrost-virtual-keys.md); step 3's
mint Lambda and step 5's janitor consume it). The Lambda stores it as an SSM
`String`, reads it at run time, adds the per-call fields (the caller's lowercase
email as `name`, and the engineering team once item 14 creates it) and `POST`s
the result to `/api/governance/virtual-keys`. Widening a model list is therefore
a reviewed edit here plus an apply, with no Lambda code change — the tier is
data.

What it carries, and why each is a decision (decision 5):

- **A `description` starting with `lambda-managed`.** The marker is the
  janitor's only input: a key without it is never deactivated by a job, so a
  human's test or dashboard key is out of reach. The exact string is the
  implementer's, in one constant matched by both Lambdas; the test's copy is
  deliberate, so changing it is a change to the file, the test and both
  functions together rather than one silently.
- **`provider_configs` pinned explicitly**, to the model lists `config.json`
  already allows for `bedrock` and `fireworks`. An empty list is deny-by-default
  and `"*"` for a Bedrock model list is exactly the widening this design exists
  to avoid, so the template names models — the US-only ones, so a key can never
  name a model the gateway refuses. The test fails if either list drifts, in
  either direction, because a model in one file and not the other is a `404`
  or an `AccessDenied` at request time.
- **`key_ids: ["*"]` on each entry**, because a provider config with no keys
  allows none: empty is deny, and `"*"` means "use the provider's keys" — the
  deployment's, not the person's.
- **No `budgets` and no `rate_limit`.** Skipped for pass one: AWS and Fireworks
  already impose provider-level limits, and a per-person number chosen before
  there is usage data can starve a person mid-task as easily as catch a runaway.
  Coming back is a field in this file.
- **No `name`**, which is the caller's email and belongs to the mint, not the
  template: one name in a shared template is one name for everyone, and
  Bifrost's unique index on the key name would hand the first caller's key to
  the second.

## The image

The stock oauth2-proxy image has no inline email-list flag — the only form is
`--authenticated-emails-file` (upstream issues #968 and #3391) — so the
allowlist reaches the container as a file in a derived image. The `FROM` pins
the same digest `agent-swarm/host/docker-compose.yml` uses.

The image also bakes the alpha configuration, for the same reason — that a human
who passed the Google gate should not then meet Bifrost's own setup page:

- `alpha-config.yaml` is oauth2-proxy's alpha configuration, baked at
  `/etc/oauth2-proxy/alpha-config.yaml` and loaded with `--alpha-config` (the
  flag lives in `deploy-workbench/ecs.ts`, `OAUTH2_PROXY_COMMAND`). It carries
  the Google provider, the upstream and the listen address — all of which are
  *removed* options when alpha configuration is used — and, in
  `injectRequestHeaders`, the `X-Bifrost-Setup-Token` header that satisfies
  Bifrost's OSS setup lock. The value comes from `secretSource.fromEnv:
  BIFROST_SETUP_TOKEN` (injected into this container from `bifrost/gateway`),
  and `PreserveRequestValue` stays at its default false, so a client's own
  header of that name is stripped before ours is set.
- There is no entrypoint wrapper. The previous one computed
  `base64(admin_username:admin_password)` for Bifrost's Basic login; with
  dashboard auth off there is no login to answer and the header value is
  already an environment variable, so the Go wrapper, its stage, its tests and
  its `go.mod` were removed with the behavior. The image keeps upstream's own
  `ENTRYPOINT` and the task definition passes `--alpha-config=...`, which is
  what loads the provider and the upstreams.
- A second stage runs `oauth2-proxy --config-test` over the baked alpha file
  with dummy values, and the runtime image copies the file from that stage. The
  alpha structure may change between minor releases, and at the pinned tag an
  unknown key is an error at container start — after the running task has been
  drained. The build failing instead is the cheaper failure, and it is what a
  future digest bump runs into.

`deploy-workbench/oauth2-proxy-image.ts` is the single source of truth for the
upstream pin and the ECR repository, and
`deploy-workbench/oauth2-proxy-image.test.ts` fails if the Dockerfile, the
workflow and the module drift. CI builds and pushes the image to the
`bifrost-oauth2-proxy` repository in the workbench account on every workbench
change, tagged `v7.15.5-<first 12 hex of the sha256 over the image's committed
inputs>` — the allowlist, the Dockerfile and `alpha-config.yaml` — so the tag
changes when and only when the image's content does. Pulumi will reference it
by digest (phase 1). The repository is immutable, so a re-push of an existing
tag is skipped rather than rejected.

Build it locally (no push, no ECR credentials needed):

```sh
docker build --platform linux/amd64 -t oauth2-proxy-local deploy-workbench/bifrost
```

## Manual prerequisite: the Google OAuth client

This is the one part that cannot be a pull request. It is the same console step
`agent-swarm/README.md` documents under "Google login":

1. Google Cloud console, APIs and services, Credentials, Create OAuth client
   ID, type **Web application**.
2. Authorized JavaScript origin `https://bifrost.workbench.goodparty.org`,
   redirect URI `https://bifrost.workbench.goodparty.org/oauth2/callback`.
3. Make the consent screen **Internal**, so only `goodparty.org` accounts can
   sign in at all.

Then the client id, the client secret and a generated cookie secret are written
to Secrets Manager out of band (phase 2 item 11). The task definition injects
them as `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET` and
`OAUTH2_PROXY_COOKIE_SECRET`; it carries all three or none, and the deploy fails
closed if the admin surface is enabled without them.

The rest of the sidecar's configuration follows
`agent-swarm/host/docker-compose.yml` and is recorded in "Protecting the admin
surface" in the plan. The settings alpha configuration removed — the provider,
the upstream and the listen address — are in `alpha-config.yaml`; the cookie
settings, the whitelist domain, the redirect URL, the allowlist path and
`reverse-proxy` survive into the core option set and are still environment
variables in `deploy-workbench/ecs.ts`.

**Bifrost's login is off; the setup lock is presented by the sidecar.** With
`governance.auth_config.is_enabled: false` there is no shared admin password on
the human path. But "auth off" is not "API open" at the pinned tag: the OSS
server installs `SetupLockMiddleware` whenever dashboard auth is not active, so
every non-public `/api` call needs the operator's setup token in
`X-Bifrost-Setup-Token` (or the setup-session cookie). That is why the alpha
config still injects one header, and why it is the setup token rather than a
Basic credential. Two consequences worth knowing:

- The sidecar reads `BIFROST_SETUP_TOKEN` from `bifrost/gateway`. It still gets
  no provider key, no encryption key and no admin username or password.
- Leaving the old Basic injection in place would break the surface rather than
  secure it: nothing consumes a Basic header with auth off, and the setup lock
  would still `401` every `/api` call, so every allowlisted human would meet
  the setup page behind the Google gate. The image digest and the
  content-addressed tag pin the alpha file; the rollback is
  `is_enabled: true` in `config.json`, which brings the shared-password login
  back as a working state rather than an outage.

## Secrets (phase 2 item 11)

Two Secrets Manager containers in the workbench account. `fill-secrets.sh` in
this directory writes the values out of band, the same way
`agent-swarm/fill-secrets.sh` fills `DELEGATE_SWARM`. Nothing secret is
committed. Neither is a Pulumi resource (`ecs.ts` explains why: nothing in the
stack reads a secret value); the script creates a container if it is absent and
writes to it otherwise.

| Container | Key | Filled by |
| --- | --- | --- |
| `bifrost/gateway` | `BIFROST_ENCRYPTION_KEY` | generated, 32 bytes base64url |
| | `BIFROST_ADMIN_USERNAME` | generated (`bifrost-admin`), safe to print |
| | `BIFROST_ADMIN_PASSWORD` | generated, never printed |
| | `BIFROST_SETUP_TOKEN` | generated, never printed; the header the sidecar presents, first-run claim, restore and proof of control |
| | `FIREWORKS_API_KEY` | a human |
| `bifrost/oauth2-proxy` | `OAUTH2_PROXY_COOKIE_SECRET` | generated, 32 bytes base64url |
| | `OAUTH2_PROXY_CLIENT_ID` | a human, from the Google client above |
| | `OAUTH2_PROXY_CLIENT_SECRET` | a human, from the Google client above |

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are also accepted, from the prompts or
the env file, but never required: they exist only for the direct providers
"Provider configuration" in the plan allows to be added later. `VK_*` virtual
keys are deliberately absent here and stay absent: a per-person key is created
through the gateway's admin API and lives only in Bifrost, which returns its
own plaintext value, so there is no secret for this script to write
([`docs/bifrost-virtual-keys.md`](../../docs/bifrost-virtual-keys.md)). The RDS
master credentials are managed by RDS in its own secret (phase 1 item 7).

The vk-mint and vk-janitor Lambdas read `BIFROST_SETUP_TOKEN` from
`bifrost/gateway` itself, and that is decision 3 of
[`docs/bifrost-virtual-keys.md`](../../docs/bifrost-virtual-keys.md). A
dedicated `bifrost/vk-mint` container holding only the token was the earlier
shape: it kept a request-facing function away from the encryption key and the
Fireworks key, but nothing in a deploy could fill it, so it was never filled on
a first apply and the first mint failed with a `500` after a green deploy. It is
gone from the design and from the script, and the cost that was accepted in
exchange is recorded in decision 3. **An account that still has
`bifrost/vk-mint` from an older run can delete it: nothing reads it.** It was
created by the script rather than Pulumi, so removing the grants did not remove
the container.

Item 8 wires `bifrost/gateway` into the task definition's `secrets` list and
item 9 wires the three `OAUTH2_PROXY_*` keys. The sidecar also reads
`BIFROST_SETUP_TOKEN` from `bifrost/gateway` for the injected header, and
item 11's claim container reads `BIFROST_SETUP_TOKEN`,
`BIFROST_ADMIN_USERNAME` and `BIFROST_ADMIN_PASSWORD` from the same container
— no new secret, and nothing beyond those three names. Those names are the seam
between this script and the task definition, so renaming a container or a key
is a change to both.

The session has to be able to write Secrets Manager in `024901689212`. The
account's `WorkbenchAccess` set deliberately has no Secrets Manager write (its
only secret read is `gp-pi/brave-search`), so use an admin session in that
account, e.g. a profile for `AdministratorAccess`. Nobody holds that role
standing: run `/breakglass` in Slack first and wait for approval in
`#sensitive-access-requests` (see [`docs/sheriff.md`](../../docs/sheriff.md)).

```sh
# 1. the keys no human has to provide
AWS_PROFILE=<admin profile> deploy-workbench/bifrost/fill-secrets.sh --generated-only

# 2. the Google pair and the provider key(s), prompted without echo
AWS_PROFILE=<admin profile> deploy-workbench/bifrost/fill-secrets.sh

# ...or from a mode-600 env file. Values are never taken from argv, which is
# visible in `ps` and in shell history.
chmod 600 ~/.bifrost-secrets.env
$EDITOR ~/.bifrost-secrets.env   # OAUTH2_PROXY_CLIENT_ID=..., FIREWORKS_API_KEY=..., ...
AWS_PROFILE=<admin profile> deploy-workbench/bifrost/fill-secrets.sh \
  --env-file ~/.bifrost-secrets.env

# verify: key names only, never values
AWS_PROFILE=<admin profile> deploy-workbench/bifrost/fill-secrets.sh --check
```

`--generated-only` leaves the human-supplied keys absent on purpose, exits 0 and
prints which keys are still unset, so the generated pass can run before the
Google client exists. `--check` prints the key names present in each container
and exits 2 if a container is missing. `--force` overwrites the values a run
supplies: it regenerates the admin password and the cookie secret (which signs
the admin UI out once), and it does **not** rotate `BIFROST_ENCRYPTION_KEY`
unless `--rotate-encryption-key` is passed too, because rotating that key
invalidates every provider key already stored in the config store. It
regenerates `BIFROST_SETUP_TOKEN` too, on the same deliberate `--force`: it is
the first-admin and restore gate rather than a session, and the new value is in
Secrets Manager by the end of the run. Keep it after setup — see "The first
admin account" below for why. The admin password is generated to Bifrost's
first-admin policy (12+ characters with an uppercase, a lowercase, a digit and
a special character); a value generated before that was true is only replaced
by `--force`, since an already-set key is never rewritten silently.

Read the admin username back without exposing anything else:

```sh
AWS_PROFILE=<admin profile> aws secretsmanager get-secret-value \
  --secret-id bifrost/gateway --region us-west-2 \
  --query SecretString --output text | jq -r .BIFROST_ADMIN_USERNAME
```

Read the setup token back the same way when a fresh instance needs claiming:

```sh
AWS_PROFILE=<admin profile> aws secretsmanager get-secret-value \
  --secret-id bifrost/gateway --region us-west-2 \
  --query SecretString --output text | jq -r .BIFROST_SETUP_TOKEN
```

## The first admin account (phase 2 item 11)

At the pinned tag Bifrost will not create the first admin account unless the
operator's setup token is configured and supplied with the request that creates
it. With no admin account in the config store, the `/api` surface is locked and
the dashboard serves its setup page instead of the login form. The deploy
handles this itself: a non-essential one-shot container in the gateway task,
`bifrost-bootstrap` (`bootstrap.sh`, image derived by `bootstrap-image.ts`),
runs on every task start after the gateway is `HEALTHY` and creates the admin
account with the credential from `bifrost/gateway`.

It is convergent, not one-shot. It asks `GET /api/session/is-auth-enabled`
first (whitelisted by Bifrost's own auth middleware, so it answers with no
credential) and exits 0 without writing anything when dashboard auth is
already active. A redeploy is a no-op, and a restore into an empty config store
heals itself. When a claim is needed it takes the server's own `GET /api/config`
body, adds `auth_config` with the username, password and `is_enabled: true`,
and `PUT`s that back with `X-Bifrost-Setup-Token`. It builds the payload from
the server's view rather than from `config.json` because `PUT /api/config`
replaces the client and framework configuration: a synthesised body would drop
settings the store holds. A store that already has an admin account with
dashboard auth disabled is left alone; re-enabling it needs proof of control,
and that is a human decision.

That early exit is what makes the claim safe with auth disabled, and it is
worth naming the two upstream facts it rests on, because neither is obvious
from this repo:

- `loadAuthConfig` (`transports/bifrost-http/lib/config.go` at `v2.3.2`)
  persists the admin account from a file's `auth_config` even with
  `is_enabled: false`, so the row exists on the first boot after
  `BIFROST_CONFIG` is injected.
- `GET /api/config` includes `auth_config` whenever that row exists
  (`handlers/config.go`, `getConfig`, "When authConfig is nil, no admin
  account has been created yet" is the only case where it is omitted). So the
  script's `has("auth_config")` test is true, not false, on a store whose
  account was provisioned with auth disabled.

Without those two the script would fall through to the claim branch and write
`is_enabled: true`, silently undoing the decision this change makes. The
order is load-bearing, and the claim is idempotent in the direction that
matters: it only ever acts when no account exists.

**One field it has to correct, and why that mattered.** The write path is
stricter than the read path: a store that has never saved a retention returns
`client_config.log_retention_days: 0`, and `PUT /api/config` refuses anything
below 1 (`handlers/config.go` at the pinned tag, "log_retention_days must be at
least 1"). Echoing the server's own view back was therefore a 400 on the first
claim of every fresh store, and the deployed gateway sat unclaimed for exactly
that reason — the setup page kept asking for the token because no admin account
ever existed. The script now raises that one field to the smallest value the
write path accepts (`CLAIM_LOG_RETENTION_DAYS`) and leaves every other value
alone; the repo's real retention is `config.json`'s 90 days, and the file is
authoritative for it now that item 10's injection is wired. Nothing else in the
echoed payload needs correcting: the validations that run before this one
(including the first-admin password policy) had already passed.

It runs inside the task, against `127.0.0.1:8080`, because once item 9's
oauth2-proxy is in front of the gateway the ALB sends every admin path to
Google sign-in before Bifrost sees it. There is no public path and no host
association. No secret is printed: the password goes from the secret to a
temporary file and into the request body, never argv.

**When it fails.** It is non-essential so a claim that cannot run — a password
upstream's policy rejects, a gateway that never goes healthy — does not stop
the gateway serving inference. That also means a non-zero exit does not fail
the task: the failure is this container's `bifrost-bootstrap` log stream
(`/aws/ecs/bifrost`) and its stopped reason. The script prints the server's own
`error` text on a rejection and the status code with it, so a failure names its
cause instead of leaving a bare 400 to be dug out of the gateway's log; a
password-policy message there means the credential has to be regenerated with
`fill-secrets.sh --force`. A metric-filter alarm on that stream is the
follow-up that turns it into a page; this account has no alerting target yet.

**Reading the claim state is not a public `curl`.** `/api/session/is-auth-enabled`
is whitelisted by Bifrost's middleware, but not by the ALB: `/api/*` is routed
to oauth2-proxy (`ingress.ts`, `ADMIN_PATH_PATTERNS`), so from a laptop the
request is a 302 to Google sign-in, and the useful output never arrives. The
state is therefore read from inside the task (or from the claim container's
log line). Through the proxy the dashboard goes straight in: its loader calls
`GET /api/config` and, if that returns 200, redirects into the workspace
instead of rendering the setup view (`ui/app/login/layout.tsx`,
`setupSessionActive`). It returns 200 because the sidecar presents the setup
token, so `setup_required: true` never turns into a visible setup page for an
allowlisted human. That is also the one thing this file cannot prove: it is a
property of the deployed task, and phase 2 item 12 confirms it end to end.

**Doing it by hand**, for a break-glass claim or when the container's log says
it exited non-zero. Read the token and the admin password from
`bifrost/gateway` (the two read-backs above), then send the token in
`X-Bifrost-Setup-Token` on the `PUT /api/config` that creates the account
(`auth_config.setup_token` in the body is the equivalent), or open the setup
page `https://bifrost.workbench.goodparty.org` in the one case it appears: the
sidecar is not presenting the token, so the lock answers `401` and the page
asks for it. A password the policy rejects is fixed with
`fill-secrets.sh --force`, which regenerates the admin password, the setup
token and the cookie secret.

**Scope and what the token is.** The lock covers `/api/*` only: inference is
not behind it, and `client.enforce_auth_on_inference` remains the only
inference control. With dashboard auth disabled the token is load-bearing for
the admin surface: the sidecar presents it on every proxied request (see "The
image" and "`config.json`") and anything scripted against the management API
has to send `X-Bifrost-Setup-Token` itself, because `POST /api/session/login`
answers `403 Authentication is not enabled` and `APIMiddleware` has no session
to check. It is still not a bearer token for inference. Re-enabling dashboard
auth (`is_enabled: true`) makes `APIMiddleware` the gate again, retires the
token from the request path, and leaves `CheckConfiguredSetupToken` as the
proof of operator control for later `auth_config` changes. Keep it in Secrets
Manager either way: the sidecar cannot present what the secret does not hold,
and a token nobody retained is a gateway nobody can administer.

**One login, and it is Google.** The only gate on the admin surface is
oauth2-proxy plus the committed allowlist: Bifrost's own dashboard auth is off,
so there is no shared admin password on the human path, and the sidecar
presents the setup token Bifrost's lock requires rather than a person typing
it. What that does **not** buy is per-person identity: every allowlisted
address acts as the same Bifrost admin, and Bifrost's own records cannot tell
them apart. Enterprise SSO is what separates them. A plugin cannot stand in for
it at this tag, which an earlier version of this section claimed it could: the
plugin interfaces at `v2.3.2` are LLM, MCP, A2A, HTTP-transport and
observability (`core/schemas/plugin.go` in the Bifrost source), with no hook on
the dashboard or management auth path, and the shared-object loader uses Go's
`plugin.Open` (`framework/plugins/soloader.go`), which cannot load into the
pinned image's statically linked `/app/main`. The plugin route is therefore not
available here, not merely unbuilt.

`governance.auth_config` in the injected file provisions the same admin
account at boot, which makes the claim container a no-op from the first start
of a task that has `BIFROST_CONFIG` — and because the config store is now the
RDS instance, that account outlives every deploy. The claim container is still
the path for a store that has no account and no injected config: it runs on
every task start, and a restore into an empty store heals itself. Both paths
use the generated `BIFROST_ADMIN_USERNAME` / `BIFROST_ADMIN_PASSWORD` pair;
neither is a reason to remove the setup token.

Until both Google values are present, `bifrost/oauth2-proxy` holds one of three
credentials. The task definition carries all three, so the ECS agent will not
start the task until they are written (phase 2 item 11); the admin surface
stays disabled rather than partially configured, and nothing serves traffic
before item 12 proves it either way.
