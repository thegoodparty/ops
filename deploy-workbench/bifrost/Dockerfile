# Derived oauth2-proxy image for the Bifrost admin surface (phase 1 item 9 of
# docs/bifrost-gateway.md).
#
# It exists for two reasons, both of them things the stock image cannot do:
#
# 1. The stock image has no inline email-list flag -- the only form is
#    `--authenticated-emails-file` (upstream issues #968 and #3391) -- so the
#    admin allowlist is baked in here and reaches the sidecar as a file at the
#    path the task definition's `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` names.
#    Granting or revoking access is therefore a PR to `allowed-emails.txt` and
#    a new image digest, not a runtime setting.
# 2. Bifrost keeps its own admin login, and no human should have to type it a
#    second time behind the Google gate. `alpha-config.yaml` injects that
#    credential upstream (`injectRequestHeaders`); `entrypoint.go` computes the
#    header value from the two secrets the task already injects, and fails the
#    container closed when either is missing. See "Protecting the admin
#    surface" in README.md.
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

# The entrypoint wrapper is built here, in a stage of its own, because the
# runtime image is `gcr.io/distroless/static:nonroot` -- no shell, no coreutils
# -- and a wrapper has to exist as a static binary to have any chance of
# running there. It has no dependencies beyond the Go standard library, so this
# stage needs no module downloads, and it runs the wrapper's own tests before
# building: an entrypoint that does not fail closed (or that mangles the Basic
# credential) fails the image build, which fails the deploy before the running
# task is drained.
#
# The builder is pinned by digest for the same reason the runtime image is: a
# floating tag would let a new Go release change the binary that ends up in an
# ECR tag that is supposed to be immutable. Bump it deliberately.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS entrypoint

WORKDIR /src

COPY go.mod entrypoint.go entrypoint_test.go ./

# The tests run on the build host's own architecture (no GOOS/GOARCH), so they
# execute rather than needing emulation; the build below cross-compiles to the
# target the runtime stage needs.
RUN go test ./...

ARG TARGETOS=linux
ARG TARGETARCH

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/bifrost-oauth2-entrypoint .

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
# the same mechanism the task definition relies on.
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
    BIFROST_ADMIN_AUTHORIZATION="Basic ZHVtbXk6ZHVtbXk="

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
# the request-header injection. It is a file because `--alpha-config` takes a
# path, and it is baked rather than mounted so the sidecar's behaviour is a
# reviewed commit like the allowlist is. Taken from the validated stage above.
COPY --from=alpha-config-check /etc/oauth2-proxy/alpha-config.yaml /etc/oauth2-proxy/alpha-config.yaml

COPY --from=entrypoint /out/bifrost-oauth2-entrypoint /bin/bifrost-oauth2-entrypoint

# Replaces the image's `ENTRYPOINT ["/bin/oauth2-proxy"]`: the wrapper execs
# that binary itself, so PID 1 is oauth2-proxy and signals are handled exactly
# as upstream intends. `CMD` is deliberately left unset -- the task definition
# passes `--alpha-config=...`, and the wrapper refuses to start without it.
ENTRYPOINT ["/bin/bifrost-oauth2-entrypoint"]
