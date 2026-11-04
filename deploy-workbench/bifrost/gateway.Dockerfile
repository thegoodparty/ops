# The gateway image, derived from the pinned Bifrost release so the container
# can resolve its own database password on every physical connection (step 6 of
# docs/bifrost-zero-downtime-deploys.md, decision 20).
#
# Why derived and not a bind mount or an entry-point override: Bifrost's
# `password_command` is exec'd without a shell
# (`framework/postgresconn/postgresconn.go`, `RunPasswordCommand`, which also
# refuses `sh`/`bash` as the command itself), so the thing it runs has to be an
# executable inside the image. The Alpine runtime ships no AWS CLI and signing a
# `GetSecretValue` by hand against the image's `curl` would be a reimplementation
# of the CLI, not a cheaper one. `aws-cli` and `jq` come from the base image's
# own Alpine repositories at build time (v3.23 main and community, the same
# repositories alpine-minirootfs 3.23.5 configures); nothing is pulled at task
# start. `aws-cli` is 2.32.7-r0 there, about 116 MiB installed, and it brings
# `python3` and the botocore crt dependencies with it.
#
# The base is the same pinned release the bootstrap image derives from, by the
# same digest, and this image keeps every part of upstream's contract that the
# task definition relies on: `ENTRYPOINT ["/app/docker-entrypoint.sh"]`,
# `CMD ["/app/main"]`, `USER 1000:0`, `APP_DIR=/app/data` and the app dir's
# group-writable ownership. The task overrides the entry point to write
# `BIFROST_CONFIG` and then `exec`s `/app/docker-entrypoint.sh /app/main`, so
# the override works only if those paths and that user survive the derivation.
#
# Root is needed for the package install and for the one chmod below: `COPY`
# lays its files down as 0:0 whatever the active `USER` is, so a chmod issued
# after the drop back to 1000:0 is a chmod by a non-owner and fails with
# "Operation not permitted" (the failure bootstrap.Dockerfile hit in deploy run
# 40329170411). Drop the privilege only once nothing left to run needs it.
#
# The `FROM` pin is duplicated from `deploy-workbench/pg-password-image.ts` and
# `pg-password-image.test.ts` fails if the two, the bootstrap Dockerfile's
# `FROM` or the workflow's repository and tag drift. Build context is this
# directory:
#
#   docker build --platform linux/amd64 \
#     -f deploy-workbench/bifrost/gateway.Dockerfile deploy-workbench/bifrost

FROM maximhq/bifrost:v2.4.0@sha256:a1c90607dcfd13c1fb2f9476ceb3bb24407a50ade7fdf3e61a59fb42b09e5c57

USER root
RUN apk add --no-cache aws-cli jq

COPY pg-password.sh /usr/local/bin/bifrost-pg-password
RUN chmod 0555 /usr/local/bin/bifrost-pg-password

# Nothing below here needs root. Restate the base image's own user rather than
# inheriting it, so a future base bump that changed its user is a diff here
# instead of a task that quietly starts as root. No step that needs root may
# follow this line; the test fails if one does.
USER 1000:0

# Upstream's own entry point and command, restated rather than inherited, so
# the override in `ecs.ts` (`exec /app/docker-entrypoint.sh /app/main`) names a
# file this image is known to have.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["/app/main"]
