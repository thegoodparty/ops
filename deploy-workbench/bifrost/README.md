# Bifrost admin surface: oauth2-proxy

Bifrost OSS has no native OIDC/SSO, so the gateway's dashboard and management
API are gated by [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/)
running as a sidecar in the same Fargate task (phase 1 item 9 of
[`docs/bifrost-gateway.md`](../../docs/bifrost-gateway.md)). This directory
holds the gateway's repo-owned configuration and the two sidecar-specific
files that belong in review:

- `config.json` — the non-secret Bifrost configuration (phase 2 item 10):
  providers, client settings and the `governance` block. See
  "`config.json`" below.
- `config.test.ts` — the checks that keep `config.json` honest: valid JSON,
  both providers, every `env.` reference filled by `fill-secrets.sh`, no
  credential literal, and Bedrock's model list matching
  `utils/bedrock-models.ts` (the list the task role's IAM is built from).
- `allowed-emails.txt` — the admin allowlist, one `goodparty.org` address per
  line, the same shape as `agent-swarm/host/allowed-emails.txt`. Granting or
  revoking access is a PR to this file. The list is deliberately **separate**
  from the Identity Center `Admins` group, which `sheriff` mutates at runtime,
  so the two are expected to drift. The owner is **jagoda for now**.
- `Dockerfile` — a one-line derivative of the stock oauth2-proxy image that
  bakes the allowlist in.

The ECS task definition, the sidecar container and the ALB routing rules are
the other half of phase 1 item 9 and land in a later PR. The three
`OAUTH2_PROXY_*` secrets are written to Secrets Manager out of band (phase 2
item 11) with `fill-secrets.sh`, never committed; see "Secrets" below.

## `config.json` (phase 2 item 10)

`config.json` is the deployment's declarative Bifrost configuration, authored
against `transports/config.schema.json` at the pinned upstream tag
`maximhq/bifrost:v2.3.0` (`deploy-workbench/bifrost-image.ts`), not the docs at
a later tag. It holds:

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
  referenced as `env.` names. The `engineering` team, its budget and the first
  virtual keys are **item 14** and are deliberately absent, not empty: under
  `source_of_truth: "config.json"` a present-but-empty section would prune
  rows created later.
- **`source_of_truth: "config.json"`** for the sections above, so a redeploy
  converges to the repo instead of preserving UI drift. An omitted section is
  left alone; an empty one prunes.

**What is injected by env.** No secret is in the file. Every credential is an
`env.NAME` reference, and the names are exactly the keys
`fill-secrets.sh` writes: `BIFROST_ENCRYPTION_KEY`,
`BIFROST_ADMIN_USERNAME`, `BIFROST_ADMIN_PASSWORD` and `FIREWORKS_API_KEY`
from `bifrost/gateway`. Bedrock has no entry because its credential is the
role. `config.test.ts` parses the script's key arrays and fails on a
reference to any name the script does not populate.

**Not yet wired.** Pulumi storing this file as an SSM SecureString and
injecting it as `BIFROST_CONFIG`, with the container entrypoint writing it to
`/app/data/config.json`, is the other half of item 10 and arrives in its own
PR; it edits the ECS task definition, which
[#343](https://github.com/thegoodparty/ops/pull/343) currently owns. Two
things follow from that, and neither is fixed here:

- Nothing reads `config.json` until then, so changing this file alone changes
  no running gateway.
- `config_store` and `logs_store` are absent. Their host, port, user and
  database are Pulumi outputs of `rds.ts`, not secrets, and no env name for
  them exists yet; the gateway therefore falls back to its local SQLite store
  until the injection PR adds the Postgres pair (and the task-definition env
  that carries the non-password half, alongside the `PG_PASSWORD` secret that
  is already injected). **Do not deploy this file as the gateway's complete
  configuration.**

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
item 9 wires the three `OAUTH2_PROXY_*` keys. Those names are the seam between
this script and the task definition, so renaming a container or a key is a
change to both.

The session has to be able to write Secrets Manager in `024901689212`. The
account's `WorkbenchAccess` set deliberately has no Secrets Manager write (its
only secret read is `gp-pi/brave-search`), so use an admin session in that
account, e.g. a profile for `AdministratorAccess`:

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
invalidates every provider key already stored in the config store.

Read the admin username back without exposing anything else:

```sh
AWS_PROFILE=<admin profile> aws secretsmanager get-secret-value \
  --secret-id bifrost/gateway --region us-west-2 \
  --query SecretString --output text | jq -r .BIFROST_ADMIN_USERNAME
```

Until both Google values are present, `bifrost/oauth2-proxy` holds one of three
credentials. The task definition must carry all three or none (item 9), so the
admin surface stays disabled rather than partially configured.
