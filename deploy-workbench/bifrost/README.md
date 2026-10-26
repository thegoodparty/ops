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
  deployment actually provides, no credential literal, and Bedrock's model
  list matching `utils/bedrock-models.ts` (the list the task role's IAM is
  built from).
- `allowed-emails.txt` — the admin allowlist, one `goodparty.org` address per
  line, the same shape as `agent-swarm/host/allowed-emails.txt`. Granting or
  revoking access is a PR to this file. The list is deliberately **separate**
  from the Identity Center `Admins` group, which `sheriff` mutates at runtime,
  so the two are expected to drift. The owner is **jagoda for now**.
- `Dockerfile` — a one-line derivative of the stock oauth2-proxy image that
  bakes the allowlist in.
- `bootstrap.sh` and `bootstrap.Dockerfile` — the one-shot claim container
  (phase 2 item 11): the script that creates the first admin account from
  inside the task, and the derivative of the pinned Bifrost image that gives it
  `curl` and `jq`. Its pin and content-addressed tag live in
  `deploy-workbench/bootstrap-image.ts`.

The ECS task definition, the sidecar container and the ALB routing rules are
the other half of phase 1 item 9 and live in `deploy-workbench/ecs.ts` and
`deploy-workbench/ingress.ts`: the task runs this image on 4180 with the three
`OAUTH2_PROXY_*` secrets and the settings from the plan's "Protecting the admin
surface", and the HTTPS listener sends `/oauth2/*` and the admin paths to it.
Those secrets are written to Secrets Manager out of band (phase 2 item 11) with
`fill-secrets.sh`, never committed; see "Secrets" below.

## `config.json` (phase 2 item 10)

`config.json` is the deployment's declarative Bifrost configuration, authored
against `transports/config.schema.json` at the pinned upstream tag
`maximhq/bifrost:v2.3.0` (`deploy-workbench/bifrost-image.ts`), not the docs at
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
- **Providers.** `fireworks`, with its key read from `env.FIREWORKS_API_KEY`
  and an explicit model allowlist (not `*`), and `bedrock`, whose key carries
  no credential at all: Bifrost inherits the ECS **task role** through the AWS
  default credential chain, so `bedrock_key_config` sets only the region. The
  Bedrock model list is the same set `utils/bedrock-models.ts` derives, which
  is what the task role's IAM policy enumerates; the test fails if the two
  drift, because a model in one and not the other is a 404 or an
  `AccessDenied` at runtime.
- **Client settings.** Inference auth is enforced
  (`enforce_auth_on_inference: true`), direct provider keys are refused
  (`allow_direct_keys: false`), content logging is off with no per-request
  override, metadata logging is on with an explicit 90-day retention, and the
  gateway's public origin is the only allowed CORS origin.
- **Governance.** Admin username/password auth is on, with both values
  referenced as `env.` names. At the pinned tag a file's `auth_config` is
  *not* write-only the way an API config write is: `loadAuthConfig` in
  `transports/bifrost-http/lib/config.go` reads it at boot, hashes the
  password and writes the admin account to the config store, so once this file
  is injected the account exists and dashboard auth is active from the first
  start — which is why the claim container is a no-op from the first start of
  a task with `BIFROST_CONFIG` (see "The first admin account" below). That is
  why those two keys stay generated: they are the credential the injected file
  provisions the account with, and the login automation uses for `/api` — the
  setup token is not a substitute. The `engineering` team, its
  budget and the first virtual keys are **item 14** and are deliberately
  absent, not empty: under `source_of_truth: "config.json"` a present-but-empty
  section would prune rows created later.
- **The first-run claim.** Top-level `"setup_token":
  "env.BIFROST_SETUP_TOKEN"` (phase 2 item 11). It is top-level and not under
  `governance` because that is where `transports/config.schema.json` puts it at
  `v2.3.0`, and `resolveSetupToken` also reads the `BIFROST_SETUP_TOKEN`
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
holds 4 KiB; this file is about 2.5 KB, which leaves room for item 14's teams
and virtual key names, and past that it needs `tier: "Advanced"` rather than a
silent truncation.

**A change to this file reaches the gateway.** The container's `secrets` entry
names the parameter's ARN, and an ARN does not change when the value does, so
the task definition also carries the parameter's *version* as
`BIFROST_CONFIG_VERSION`. A merged edit to `config.json` therefore registers a
new task-definition revision and the service's stop-before-start rollout picks
it up; without that, the apply would update the parameter and leave every
running task on the file it booted with. The version is also how an operator
answers "which config is this task running" from
`describe-task-definition`.

Two consequences worth knowing before a deploy:

- The stores are now the RDS instance (`config_store` and `logs_store`,
  `type: "postgres"`), so gateway state survives a task replacement. Until
  this landed, every deploy took the admin account with it and the dashboard
  went back to the setup page.
- `client.enforce_auth_on_inference: true` becomes effective with the same
  apply, and item 14's virtual keys do not exist yet, so inference refuses
  everything until they do. That is the plan's phase A order ("inference
  succeeds with a virtual key and fails without one"), not a defect — but the
  two items have to land close together.

## The image

The stock oauth2-proxy image has no inline email-list flag — the only form is
`--authenticated-emails-file` (upstream issues #968 and #3391) — so the
allowlist reaches the container as a file in a derived image. The `FROM` pins
the same digest `agent-swarm/host/docker-compose.yml` uses.

`deploy-workbench/oauth2-proxy-image.ts` is the single source of truth for the
upstream pin and the ECR repository, and
`deploy-workbench/oauth2-proxy-image.test.ts` fails if the Dockerfile, the
workflow and the module drift. CI builds and pushes the image to the
`bifrost-oauth2-proxy` repository in the workbench account on every workbench
change, tagged `v7.15.5-<first 12 hex of the allowlist sha256>` so the tag
changes when and only when the list does. Pulumi will reference it by digest
(phase 1). The repository is immutable, so a re-push of an existing tag is
skipped rather than rejected.

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

The rest of the sidecar's configuration — `OAUTH2_PROXY_UPSTREAMS:
http://127.0.0.1:8080`, the cookie settings, the whitelist domain and the
redirect URL — follows `agent-swarm/host/docker-compose.yml` and is recorded in
"Protecting the admin surface" in the plan. The OSS admin username/password
stays as the second layer inside oauth2-proxy.

## Secrets (phase 2 item 11)

Two Secrets Manager containers in the workbench account. Pulumi creates them
empty (item 11) and the read grants; `fill-secrets.sh` in this directory writes
the values out of band, the same way `agent-swarm/fill-secrets.sh` fills
`DELEGATE_SWARM`. Nothing secret is committed.

| Container | Key | Filled by |
| --- | --- | --- |
| `bifrost/gateway` | `BIFROST_ENCRYPTION_KEY` | generated, 32 bytes base64url |
| | `BIFROST_ADMIN_USERNAME` | generated (`bifrost-admin`), safe to print |
| | `BIFROST_ADMIN_PASSWORD` | generated, never printed |
| | `BIFROST_SETUP_TOKEN` | generated, never printed; first-run claim, restore and proof of control |
| | `FIREWORKS_API_KEY` | a human |
| `bifrost/oauth2-proxy` | `OAUTH2_PROXY_COOKIE_SECRET` | generated, 32 bytes base64url |
| | `OAUTH2_PROXY_CLIENT_ID` | a human, from the Google client above |
| | `OAUTH2_PROXY_CLIENT_SECRET` | a human, from the Google client above |

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are also accepted, from the prompts or
the env file, but never required: they exist only for the direct providers
"Provider configuration" in the plan allows to be added later. `VK_*` virtual
keys are deliberately absent here — they belong to the `engineering` team in
phase 2 item 14, and their names follow the keys `config.json` declares. The RDS
master credentials are managed by RDS in its own secret (phase 1 item 7).

Item 8 wires `bifrost/gateway` into the task definition's `secrets` list and
item 9 wires the three `OAUTH2_PROXY_*` keys. Item 11's claim container reads
only `BIFROST_SETUP_TOKEN`, `BIFROST_ADMIN_USERNAME` and
`BIFROST_ADMIN_PASSWORD` from the same container — no new secret, and nothing
beyond those three. Those names are the seam between this script and the task
definition, so renaming a container or a key is a change to both.

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
log line), and from the dashboard, which serves the setup page while the lock
is on and the login form once the account exists.

**Doing it by hand**, for a break-glass claim or when the container's log says
it exited non-zero. Read the token and the admin password from
`bifrost/gateway` (the two read-backs above), then either open
`https://bifrost.workbench.goodparty.org`, enter the token on the setup page and
create the admin account it hands off to, or send the token in
`X-Bifrost-Setup-Token` on the `PUT /api/config` that creates the account
(`auth_config.setup_token` in the body is the equivalent). A password the
policy rejects is fixed with `fill-secrets.sh --force`, which regenerates the
admin password, the setup token and the cookie secret.

**Scope and what the token is not.** The lock covers `/api/*` only: inference
is not behind it, and `client.enforce_auth_on_inference` remains the only
inference control. Once dashboard auth is active, `APIMiddleware` never
consults the token and `ClearBootstrapToken` nils the first-admin half, so it
is not a login and never becomes a bearer token; its one remaining role is
`CheckConfiguredSetupToken`, the proof of operator control for `auth_config`
changes made while dashboard auth is disabled. Keep it in Secrets Manager: a
rebuilt task whose config store is empty has no admin account, and a token
nobody retained is a gateway nobody can administer. Anything scripted against
the management API signs in as the admin account — `BIFROST_ADMIN_USERNAME` /
`BIFROST_ADMIN_PASSWORD` via `POST /api/session/login` — or uses a scoped key
for inference; the setup token is not a substitute for those two keys.

**One login after the Google gate.** OSS dashboard auth accepts HTTP Basic, a
Bearer session token or the session cookie, and has no trusted-header mode, so
a human who passes oauth2-proxy's Google gate still meets Bifrost's own login
with the admin credential above. Enterprise SSO removes that second login;
Bifrost's plugin interface also has an authentication hook that could accept
oauth2-proxy's identity header instead, which is available but neither built
nor planned here.

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
