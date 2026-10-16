# Derived oauth2-proxy image for the Bifrost admin surface (phase 1 item 9 of
# docs/bifrost-gateway.md).
#
# The stock oauth2-proxy image has no inline email-list flag -- the only form is
# `--authenticated-emails-file` (upstream issues #968 and #3391) -- so the admin
# allowlist is baked in here and reaches the sidecar as a file at the path the
# task definition's `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` names. Granting or
# revoking access is therefore a PR to `allowed-emails.txt` and a new image
# digest, not a runtime setting.
#
# The `FROM` pin is the same digest `agent-swarm/host/docker-compose.yml` uses.
# It is duplicated from `deploy-workbench/oauth2-proxy-image.ts`, and
# `oauth2-proxy-image.test.ts` fails if the two drift. The digest is an OCI
# image index, so it pins both architectures; CI builds `--platform
# linux/amd64` for Fargate. The build context is this directory:
#
#   docker build --platform linux/amd64 -t oauth2-proxy-local deploy-workbench/bifrost
#
# See `README.md` in this directory for the manual Google Cloud step and the
# secrets the task definition injects.

FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916

COPY allowed-emails.txt /etc/oauth2-proxy/allowed-emails.txt
