FROM public.ecr.aws/docker/library/node:22-alpine

RUN apk add --no-cache git curl github-cli uv bash aws-cli jq ripgrep
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
