# Derived one-shot image that claims a fresh Bifrost deployment (phase 2 item
# 11 of docs/bifrost-gateway.md). It runs as a non-essential container in the
# gateway's own task, ordered after the gateway is healthy, so it reaches
# 127.0.0.1:8080 without a public path.
#
# The base is the same pinned Bifrost release the gateway runs, so the claim
# runs on exactly the image and Alpine userland it is claiming, with no second
# upstream to pin. curl and jq are added because the Alpine runtime has neither:
# `bootstrap.sh` has to GET the live config, add `auth_config` and PUT the
# result back, and a body spliced together without a JSON parser is the kind of
# change that silently drops a setting. Both packages come from the base
# image's own Alpine repositories at build time; nothing is pulled at task
# start.
#
# The base runs as 1000:0 and the package install is the only reason to be
# root. The `FROM` pin is duplicated from `deploy-workbench/bootstrap-image.ts`
# and `bootstrap-image.test.ts` fails if the two, or the workflow's repository
# and tag, drift. Build context is this directory:
#
#   docker build --platform linux/amd64 \
#     -f deploy-workbench/bifrost/bootstrap.Dockerfile deploy-workbench/bifrost

FROM maximhq/bifrost:v2.3.0@sha256:8f37e33a8caa85faf59a875605c61d1d934738e517d8fe96e2d9fcf6f0ef9098

USER root
RUN apk add --no-cache curl jq
USER 1000:0

COPY bootstrap.sh /bifrost-bootstrap/bootstrap.sh
RUN chmod 0555 /bifrost-bootstrap/bootstrap.sh

# /bin/sh, not the script directly: the base image's CMD is replaced rather
# than inherited, so the container runs the claim and then exits.
ENTRYPOINT ["/bin/sh"]
CMD ["/bifrost-bootstrap/bootstrap.sh"]
