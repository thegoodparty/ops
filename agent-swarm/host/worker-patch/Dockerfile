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

# The Databricks CLI, the swarm's only route to the warehouse. Pinned to the
# release the delegate-sql service principal was verified against on 2026-11-25
# and checked against that release's own SHA256SUMS, so a build either installs
# exactly v1.28.0 or fails. up.sh tags this image with this file's hash, so an
# edit here rebuilds and recreates every agent.
ARG DATABRICKS_CLI_VERSION=1.28.0
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) arch=amd64; sha=39da99295fb9e848f3fe10873c42df5736089a877a22faf06897ca26093a2cd7 ;; \
      aarch64) arch=arm64; sha=ebada2988bbf7396879b30e17001d5b0ed7673cf1c7013f4ce27ccb80710fa76 ;; \
      *) echo "worker-patch: no pinned databricks CLI checksum for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "$tmp/cli.zip" \
      "https://github.com/databricks/cli/releases/download/v${DATABRICKS_CLI_VERSION}/databricks_cli_${DATABRICKS_CLI_VERSION}_linux_${arch}.zip"; \
    echo "${sha}  $tmp/cli.zip" | sha256sum -c -; \
    unzip -q "$tmp/cli.zip" -d "$tmp"; \
    install -m 0755 "$tmp/databricks" /usr/local/bin/databricks; \
    rm -rf "$tmp"; \
    [ "$(databricks version | sed -n 's/^Databricks CLI v//p')" = "$DATABRICKS_CLI_VERSION" ]

# The profile every agent authenticates with. Deliberately no host and no
# credentials: DATABRICKS_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET
# are injected as secrets and the CLI fills them in from the environment, so
# nothing secret is written into the image or into a config file. The profile
# itself is not optional -- without `--profile delegate-sql` the CLI asks for the
# all-apis scope, which this service principal rejects.
#
# Pinned by DATABRICKS_CONFIG_FILE rather than left to ~/.databrickscfg: no agent
# home is a volume, and this hook runs as root while the agents run as worker.
# To use profiles of your own in an agent shell, point DATABRICKS_CONFIG_FILE
# somewhere writable; /etc/databrickscfg is read-only to the worker.
RUN printf '%s\n' \
      '[delegate-sql]' \
      'auth_type = oauth-m2m' \
      'scopes = sql' \
      > /etc/databrickscfg \
    && chmod 0644 /etc/databrickscfg
ENV DATABRICKS_CONFIG_FILE=/etc/databrickscfg
