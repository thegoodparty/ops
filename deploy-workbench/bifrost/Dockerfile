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
# `oauth2-proxy-image.test.ts` fails if the two drift. The digest is an OCI
# image index, so it pins both architectures; CI builds `--platform
# linux/amd64` for Fargate. The build context is this directory:
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

FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916

COPY allowed-emails.txt /etc/oauth2-proxy/allowed-emails.txt

# The alpha configuration: the provider, the upstream, the listen address and
# the request-header injection. It is a file because `--alpha-config` takes a
# path, and it is baked rather than mounted so the sidecar's behaviour is a
# reviewed commit like the allowlist is.
COPY alpha-config.yaml /etc/oauth2-proxy/alpha-config.yaml

COPY --from=entrypoint /out/bifrost-oauth2-entrypoint /bin/bifrost-oauth2-entrypoint

# Replaces the image's `ENTRYPOINT ["/bin/oauth2-proxy"]`: the wrapper execs
# that binary itself, so PID 1 is oauth2-proxy and signals are handled exactly
# as upstream intends. `CMD` is deliberately left unset -- the task definition
# passes `--alpha-config=...`, and the wrapper refuses to start without it.
ENTRYPOINT ["/bin/bifrost-oauth2-entrypoint"]
