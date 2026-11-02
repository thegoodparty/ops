# Derived one-shot image that seeds the inactive Bifrost colour's config store
# from the active one. Step 2 of docs/bifrost-zero-downtime-deploys.md, and
# decision 17 is why this image exists at all: the pinned Bifrost release is
# Alpine plus a Go binary, so it ships neither `pg_dump` nor `psql`, and the seed
# is a dump rather than a server-side copy (decision 3).
#
# The base is the same pinned Bifrost release the other derived images use, so
# there is one upstream to pin rather than a second. The Postgres client is the
# one package added, and it is versioned deliberately:
#
#   postgresql16-client, not an unversioned alias and not the newest major.
#
# `pg_dump` refuses a server newer than itself, so a client older than the RDS
# instance cannot dump it. A client a major version *ahead* is the subtler
# failure: `pg_dump` 17 and 18 emit `SET transaction_timeout = 0`, and a
# PostgreSQL 16 server -- which is what `DATABASE_ENGINE_VERSION` in rds.ts
# creates -- rejects that as an unrecognised parameter, so the restore fails on
# its first statement after the dump succeeded. Both were checked against a real
# 16 server rather than assumed. Alpine 3.23 (the base's release) ships
# `postgresql16-client` in `main`, so the pin and the server's major are the same
# number and `bifrost-seed-image.test.ts` asserts it.
#
# `--no-cache` so nothing is fetched at task start, which is the same property
# the other two derived images have.
#
# The base runs as 1000:0, and root is needed for the package install and for
# the one chmod: `COPY` lays its files down as 0:0 whatever the active `USER` is,
# so a chmod issued after the drop back to 1000:0 is a chmod by a non-owner and
# fails with "Operation not permitted" (the failure `bootstrap.Dockerfile`
# documents from deploy run 40329170411). Drop the privilege only once nothing
# left to run needs it.
#
# The `FROM` pin is duplicated from `deploy-workbench/bifrost-seed-image.ts` and
# `bifrost-seed-image.test.ts` fails if the two, or the workflow's repository and
# tag, drift. Build context is this directory:
#
#   docker build --platform linux/amd64 \
#     -f deploy-workbench/bifrost/seed.Dockerfile deploy-workbench/bifrost

FROM maximhq/bifrost:v2.3.2@sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7

USER root
RUN apk add --no-cache postgresql16-client

COPY seed.sh /bifrost-seed/seed.sh
RUN chmod 0555 /bifrost-seed/seed.sh

# Nothing below here needs root: the dump runs as the base image's own user.
USER 1000:0

# /bin/sh, not the script directly: the base image's ENTRYPOINT is
# `/app/docker-entrypoint.sh` and its CMD is `/app/main`, so both are replaced
# rather than inherited. Inheriting them would start a second Bifrost server in
# the seed task.
ENTRYPOINT ["/bin/sh"]
CMD ["/bifrost-seed/seed.sh"]
