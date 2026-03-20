FROM node:22-alpine

RUN apk add --no-cache git curl github-cli uv bash aws-cli
RUN curl -sL https://sentry.io/get-cli/ | sh
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/delegate/ ./dist/delegate/
RUN adduser -D -s /bin/bash agent && chown -R agent:agent /app
USER agent
ENV SHELL=/bin/bash
RUN git init

CMD ["node", "dist/delegate/worker/entrypoint.js"]
