# One image for every piece of the sim we wrote: the stand-ins, the proxy,
# the telemetry emitter, the persona, the checker, and the fan-out runner.
# node:22-alpine and alpine's github-cli match the BugBoss image, so the gh
# the stand-in's tests drive is the gh BugBoss runs.
#
# build-base and python3 stay: the checker and visible CI run `npm ci` on
# omni, which compiles native modules. docker-cli and its compose plugin are
# for the runner only, which drives the host daemon through its socket.
FROM node:22-alpine

RUN apk add --no-cache git github-cli bash curl jq openssl ripgrep \
  postgresql-client build-base python3 docker-cli docker-cli-compose aws-cli

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
