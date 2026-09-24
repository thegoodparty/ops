FROM node:22-alpine

# git, gh and npm are the agent's hands: it clones omni, reads code, opens a
# PR. aws is how it reads CloudWatch and ECS events to debug a deploy, which
# is the only AWS access its role grants.
RUN apk add --no-cache git curl github-cli bash aws-cli jq ripgrep

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

# Each incident agent clones omni into its own directory under here. The task
# gets 200 GiB of ephemeral storage for exactly this.
RUN mkdir -p /app/work && adduser -D -s /bin/bash agent \
  && chown -R agent:agent /app
USER agent
ENV SHELL=/bin/bash

CMD ["node", "dist/bugboss/index.js"]
