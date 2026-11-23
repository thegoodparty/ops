# The upstream worker image at this tag ships Node 22.23.3, which the
# October 2026 Node.js security release fixes in 22.23.4:
# https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
# Once upstream ships 22.23.4 or later, drop the node upgrade below, but keep
# this directory and the gws install with it (README, "Upgrade agent-swarm").
ARG AGENT_SWARM_VERSION
FROM ghcr.io/desplega-ai/agent-swarm-worker:${AGENT_SWARM_VERSION}

RUN apt-get update \
    && apt-get install -y --only-upgrade nodejs \
    && rm -rf /var/lib/apt/lists/*

# Google Workspace CLI for every agent container: Swain Molster asked for it on
# all of them (2026-11-23). Installed as root into /usr/local/bin because an
# agent's home is not a volume here, so anything installed at container start is
# lost on the next recreate. Pinned: postinstall downloads a prebuilt binary
# from GitHub releases, and the command surface is generated from Google's
# Discovery Service, so an unpinned minor could change under a running schedule.
RUN npm install -g @googleworkspace/cli@0.22.5 \
    && gws --version

RUN node -e ' \
  const v = process.versions.node.split(".").map(Number); \
  if ((v[0] - 22 || v[1] - 23 || v[2] - 4) < 0) { \
    console.error(`worker-patch: node ${process.version} is older than v22.23.4`); \
    process.exit(1); \
  }' \
    && node -v
