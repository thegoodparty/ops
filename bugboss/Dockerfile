FROM node:22-alpine

# git, gh and npm are the agent's hands: it clones omni, reads code, opens a
# PR. aws is how it reads CloudWatch and ECS events to debug a deploy, which
# is the only AWS access its role grants.
# uv is not optional: the agent starts the Grafana MCP toolset with
# `uvx mcp-grafana` before its session begins, so without it the spawn fails
# and the run dies rather than starting without Grafana.
RUN apk add --no-cache git curl github-cli bash aws-cli jq ripgrep uv

WORKDIR /app

# better-sqlite3 is native and has no musl prebuild, so it compiles here.
# The toolchain goes away again in the same layer to keep it out of the image.
COPY package*.json ./
RUN apk add --no-cache --virtual .build build-base python3 \
  && npm ci --omit=dev \
  && apk del .build

COPY dist/bugboss/ ./dist/bugboss/
# tsc copies no non-TS files, and db/index.ts reads this at boot from
# __dirname. Without it the container starts and dies on the first query.
COPY bugboss/db/schema.sql ./dist/bugboss/db/schema.sql

# /work is where each incident agent clones omni; the task gets 200 GiB of
# ephemeral storage for exactly that. It is /work rather than /app/work
# because that is DEFAULT_WORK_ROOT in agent/run.ts, and the container runs as
# a non-root user who cannot create a directory at the filesystem root — so a
# mismatch here fails every incident before checkout.
#
# /data holds the SQLite file, which is BUGBOSS_DB_PATH's default, and exists
# for the same reason: without it the first write throws SQLITE_CANTOPEN and
# the task crash-loops before it can report why.
RUN mkdir -p /work /data && adduser -D -s /bin/bash agent \
  && chown -R agent:agent /app /work /data
USER agent
ENV SHELL=/bin/bash

CMD ["node", "dist/bugboss/index.js"]
