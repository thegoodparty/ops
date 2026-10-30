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
# The base runs as 1000:0 and root is needed for the package install and for
# the one chmod below: `COPY` lays its files down as 0:0 whatever the active
# `USER` is, so a chmod issued after the drop back to 1000:0 is a chmod by a
# non-owner and fails with "Operation not permitted". Drop the privilege only
# once nothing left to run needs it.
#
# The `FROM` pin is duplicated from `deploy-workbench/bootstrap-image.ts` and
# `bootstrap-image.test.ts` fails if the two, or the workflow's repository and
# tag, drift. Build context is this directory:
#
#   docker build --platform linux/amd64 \
#     -f deploy-workbench/bifrost/bootstrap.Dockerfile deploy-workbench/bifrost

FROM maximhq/bifrost:v2.3.2@sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7

USER root
RUN apk add --no-cache curl jq

COPY bootstrap.sh /bifrost-bootstrap/bootstrap.sh
RUN chmod 0555 /bifrost-bootstrap/bootstrap.sh

# Nothing below here needs root: the claim runs as the base image's own user.
USER 1000:0

# /bin/sh, not the script directly: the base image's CMD is replaced rather
# than inherited, so the container runs the claim and then exits.
ENTRYPOINT ["/bin/sh"]
CMD ["/bifrost-bootstrap/bootstrap.sh"]
