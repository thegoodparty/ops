# Bifrost admin surface: oauth2-proxy

Bifrost OSS has no native OIDC/SSO, so the gateway's dashboard and management
API are gated by [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/)
running as a sidecar in the same Fargate task (phase 1 item 9 of
[`docs/bifrost-gateway.md`](../../docs/bifrost-gateway.md)). This directory
holds the gateway's repo-owned configuration and the two sidecar-specific
files that belong in review:

- `config.json` — the non-secret Bifrost configuration (phase 2 item 10):
  stores, providers, client settings and the `governance` block. Pulumi
  deploys it from `deploy-workbench/bifrost-config.ts`. See "`config.json`"
  below.
- `config.test.ts` — the checks that keep `config.json` honest: valid JSON,
  both providers and both Postgres stores, every `env.` reference provided by
  the deployment, no credential literal, the retention values, and Bedrock's
  model list matching `utils/bedrock-models.ts` (the list the task role's IAM
  is built from).
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

- **The stores.** `config_store` and `logs_store` are both Postgres, on the
  RDS instance item 7 created, with `ssl_mode: "require"`. Their `host`,
  `port`, `user` and `password` are `env.PG_*` references: Bifrost resolves the
  names from its process environment at load, the task definition fills
  `PG_HOST`/`PG_PORT`/`PG_USER` from `rds.ts`'s outputs and
  `DATABASE_USERNAME`, and `PG_PASSWORD` arrives through ECS `secrets` from
  the RDS-managed secret. `db_name` is the literal `bifrost`, which the test
  checks against `DATABASE_NAME` so the two cannot drift. A missing variable
  resolves to the empty string and fails startup validation, so a miswiring
  fails closed rather than quietly falling back to SQLite.
- **Retention.** `client.log_retention_days` and `logs_store.retention_days`
  are both 90. They are different settings at the pinned tag: the first is the
  cleanup job's window and the one `PUT /api/config` validates (a stored `0`
  is the bug that left the gateway unclaimable), the second is the store's own
  purge window. Both are asserted as numbers, not as key names.
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
  start. That is why those two keys stay generated: they are the credential
  the injected file provisions the account with, and the login automation uses
  for `/api` — the setup token is not a substitute. It is also why the block is
  **not** the bootstrap path — see "The first admin account" below for the
  window in which no admin account exists yet. The `engineering` team, its
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
`env.NAME` reference; the five from `bifrost/gateway` are
`BIFROST_ENCRYPTION_KEY`, `BIFROST_ADMIN_USERNAME`,
`BIFROST_ADMIN_PASSWORD`, `BIFROST_SETUP_TOKEN` and `FIREWORKS_API_KEY`.
Bedrock has no entry because its credential is the role. The store's
non-secret half is `PG_HOST`/`PG_PORT`/`PG_USER` from the task's environment,
and `PG_PASSWORD` is the RDS-managed secret the task already injects.
`config.test.ts` fails on a reference nothing provides, and
`deploy-workbench/ecs.test.ts` fails if a credential reaches the container
through `environment` instead of `secrets`.

**How it is deployed.** `deploy-workbench/bifrost-config.ts` reads this file's
bytes into the SSM parameter `/bifrost/config`, a plain **`String`** rather
than a `SecureString`: the file is in git, so encrypting the deployed copy
would only hide production's configuration from the reviewers who diff it.
The task definition injects the parameter as `BIFROST_CONFIG` (through
`secrets`, the only place ECS accepts a `valueFrom`) and overrides the
container entrypoint to write it to `/app/data/config.json` before exec'ing
the image's own entrypoint. The stock image does not read `BIFROST_CONFIG`
itself; this is upstream's ECS-guide shape. A `BIFROST_CONFIG_SHA256`
environment value makes a config edit a new task-definition revision, because
an ARN does not change when the parameter's value does.

Read the deployed config with one command (it is not encrypted):

```sh
AWS_PROFILE=<profile> aws ssm get-parameter --name /bifrost/config \
  --region us-west-2 --query Parameter.Value --output text | jq .
```

A change to this file is therefore a reviewed PR that reaches the running
gateway on the next `deploy-workbench` apply, not a console edit.

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
first (whitelisted, so it answers with no credential) and exits 0 without
writing anything when dashboard auth is already active. A redeploy is a no-op,
and a restore into an empty config store heals itself. When a claim is needed
it takes the server's own `GET /api/config` body, adds `auth_config` with the
username, password and `is_enabled: true`, and `PUT`s that back with
`X-Bifrost-Setup-Token`. It builds the payload from the server's view rather
than from `config.json` because `PUT /api/config` replaces the client and
framework configuration: a synthesised body would drop settings the store
holds. A store that already has an admin account with dashboard auth disabled
is left alone; re-enabling it needs proof of control, and that is a human
decision.

It runs inside the task, against `127.0.0.1:8080`, because once item 9's
oauth2-proxy is in front of the gateway the ALB sends every admin path to
Google sign-in before Bifrost sees it. There is no public path and no host
association. No secret is printed: the password goes from the secret to a
temporary file and into the request body, never argv, and the container logs
statuses only.

**When it fails.** It is non-essential so a claim that cannot run — a password
upstream's policy rejects, a gateway that never goes healthy — does not stop
the gateway serving inference. That also means a non-zero exit does not fail
the task: the failure is this container's `bifrost-bootstrap` log stream
(`/aws/ecs/bifrost`) and its stopped reason. A metric-filter alarm on that
stream is the follow-up that turns it into a page; this account has no
alerting target yet.

Check the claim from anywhere (the endpoint is whitelisted):

```sh
curl -sS https://bifrost.workbench.goodparty.org/api/session/is-auth-enabled \
  | jq '{is_auth_enabled, setup_required, setup_token_configured, inference_auth_enforced}'
```

`is_auth_enabled: true` and `setup_required: false` mean it is claimed.
`setup_required: true, setup_token_configured: false` is the bug this section
exists to prevent: the API is locked with no way in.

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

Now that item 10 injects `BIFROST_CONFIG`, the file's
`governance.auth_config` provisions the same admin account at boot, which makes
the claim container a no-op from the first start on a fresh deployment. Both
paths use the generated `BIFROST_ADMIN_USERNAME` / `BIFROST_ADMIN_PASSWORD`
pair; neither is a reason to remove the setup token.

Until both Google values are present, `bifrost/oauth2-proxy` holds one of three
credentials. The task definition carries all three, so the ECS agent will not
start the task until they are written (phase 2 item 11); the admin surface
stays disabled rather than partially configured, and nothing serves inference
until item 12 proves it through the ALB either way.
