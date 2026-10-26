# The upstream worker image at this tag ships Node 22.23.3, which the
# October 2026 Node.js security release fixes in 22.23.4:
# https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
# Delete this directory once upstream ships 22.23.4 or later (README,
# "Upgrade agent-swarm").
ARG AGENT_SWARM_VERSION
FROM ghcr.io/desplega-ai/agent-swarm-worker:${AGENT_SWARM_VERSION}

RUN apt-get update \
    && apt-get install -y --only-upgrade nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node -e ' \
  const v = process.versions.node.split(".").map(Number); \
  if ((v[0] - 22 || v[1] - 23 || v[2] - 4) < 0) { \
    console.error(`worker-patch: node ${process.version} is older than v22.23.4`); \
    process.exit(1); \
  }' \
    && node -v
