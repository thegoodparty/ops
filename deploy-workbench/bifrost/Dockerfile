# Derived oauth2-proxy image for the Bifrost admin surface (phase 1 item 9 of
# docs/bifrost-gateway.md, revised when Bifrost's own dashboard auth was turned
# off).
#
# It exists for two reasons, both of them things the stock image cannot do:
#
# 1. The stock image has no inline email-list flag -- the only form is
#    `--authenticated-emails-file` (upstream issues #968 and #3391) -- so the
#    admin allowlist is baked in here and reaches the sidecar as a file at the
#    path the task definition's `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` names.
#    Granting or revoking access is therefore a PR to `allowed-emails.txt` and
#    a new image digest, not a runtime setting.
# 2. `alpha-config.yaml` carries everything the `--alpha-config` flag removes
#    from the core options -- the Google provider, the upstream and the listen
#    address -- and one injected header. With Bifrost's dashboard auth off, the
#    OSS setup lock is what gates `/api`, so the sidecar presents the operator's
#    setup token from `bifrost/gateway` on every proxied request; a human then
#    meets Google SSO and nothing else. See "The image" in README.md.
#
# There is no entrypoint wrapper any more. The previous one computed
# `base64(admin_username:admin_password)` for Bifrost's Basic login; with
# `governance.auth_config.is_enabled` false there is no password to encode and
# the value the header needs (`BIFROST_SETUP_TOKEN`) is already an environment
# variable injected by the task definition, so the binary, its Go toolchain
# stage and its tests were dead weight and were removed with the behavior they
# implemented.
#
# The `FROM` pin is the same digest `agent-swarm/host/docker-compose.yml` uses.
# It is duplicated from `deploy-workbench/oauth2-proxy-image.ts`, and
# `oauth2-proxy-image.test.ts` fails if the two drift. Every `FROM` in this file
# that names the upstream image has to be that same reference -- there are two,
# the config check and the runtime stage, for the reason at the second one. The
# digest is an OCI image index, so it pins both architectures; CI builds
# `--platform linux/amd64` for Fargate. The build context is this directory:
#
#   docker build --platform linux/amd64 -t oauth2-proxy-local deploy-workbench/bifrost
#
# See `README.md` in this directory for the manual Google Cloud step and the
# secrets the task definition injects.

# Build-time assertion that the pinned release still accepts the alpha
# configuration this image bakes, and still reads the options that survived
# into its core config from `OAUTH2_PROXY_*`.
#
# The reason it exists is the risk recorded in `docs/bifrost-gateway.md`: the
# alpha structure may change between minor releases. The digest pin means a
# bump is a reviewed PR, but review is a person reading a diff, and the
# failure it would miss is a renamed or removed alpha key -- which, at this
# tag, fails at *container start* (`ErrorUnused` in `pkg/apis/options/load.go`)
# rather than at build time, so a bad bump would drain the running task and
# then refuse to start the new one. `--config-test` exercises the same loader
# without starting a server, so the bump fails here instead.
#
# The environment is dummy on purpose and is confined to this stage: the
# runtime stage starts from the pinned image again, so none of it reaches the
# image that ships. `${...}` in the alpha file is substituted from it, which is
# the same mechanism the task definition relies on. `BIFROST_SETUP_TOKEN` is
# set because the injected header reads it with `fromEnv`, and oauth2-proxy
# refuses to load a config whose `fromEnv` source is empty -- which is also the
# fail-closed behavior the real task gets from a missing secret key.
FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916 AS alpha-config-check

COPY allowed-emails.txt /etc/oauth2-proxy/allowed-emails.txt
COPY alpha-config.yaml /etc/oauth2-proxy/alpha-config.yaml

ENV OAUTH2_PROXY_CLIENT_ID=build-time-config-check-not-a-real-client-id \
    OAUTH2_PROXY_CLIENT_SECRET=build-time-config-check-not-a-real-client-secret \
    OAUTH2_PROXY_COOKIE_SECRET=0123456789abcdef0123456789abcdef \
    OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE=/etc/oauth2-proxy/allowed-emails.txt \
    OAUTH2_PROXY_REDIRECT_URL=https://example.invalid/oauth2/callback \
    OAUTH2_PROXY_WHITELIST_DOMAINS=example.invalid \
    OAUTH2_PROXY_REVERSE_PROXY=true \
    OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true \
    BIFROST_SETUP_TOKEN=build-time-config-check-not-a-real-setup-token

# Exec form, because the runtime image is distroless and has no shell to run a
# string-form `RUN` with.
RUN ["/bin/oauth2-proxy", "--alpha-config=/etc/oauth2-proxy/alpha-config.yaml", "--config-test"]

# The runtime stage. The same pin appears twice because the check above has to
# be a dependency of this stage to run at all (BuildKit skips stages nothing
# references), and inheriting from the check stage instead would bake its dummy
# environment into the shipped image. The alpha configuration is copied *from*
# the stage that validated it, so the file that ships is the file that passed.
FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916

COPY allowed-emails.txt /etc/oauth2-proxy/allowed-emails.txt

# The alpha configuration: the provider, the upstream, the listen address and
# the injected setup-token header. It is a file because `--alpha-config` takes a
# path, and it is baked rather than mounted so the sidecar's behaviour is a
# reviewed commit like the allowlist is. Taken from the validated stage above.
COPY --from=alpha-config-check /etc/oauth2-proxy/alpha-config.yaml /etc/oauth2-proxy/alpha-config.yaml

# The upstream image's own `ENTRYPOINT ["/rootfs/oauth2-proxy"]` is left in
# place: there is no wrapper to replace it, and `CMD` is deliberately unset --
# the task definition passes `--alpha-config=...`, and without that flag the
# proxy has no provider and no upstream and refuses to start.
