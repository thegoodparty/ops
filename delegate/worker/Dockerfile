FROM node:22-alpine

RUN apk add --no-cache git curl github-cli uv bash aws-cli jq ripgrep
RUN curl -sL https://sentry.io/get-cli/ | sh
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/delegate/ ./dist/delegate/

# Vendor the Superpowers skills library (systematic-debugging, etc.) so the
# slack-responder can load it as a local Claude Agent SDK plugin. Pinned to a
# release tag for reproducible builds — no runtime marketplace fetch.
RUN git clone --depth 1 --branch v6.2.0 https://github.com/obra/superpowers /app/plugins/superpowers

RUN adduser -D -s /bin/bash agent && chown -R agent:agent /app
USER agent
ENV SHELL=/bin/bash
RUN git init

CMD ["node", "dist/delegate/worker/entrypoint.js"]
