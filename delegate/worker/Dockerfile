FROM public.ecr.aws/docker/library/node:22.23.5-alpine

RUN apk add --no-cache git curl github-cli uv bash aws-cli jq ripgrep

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/delegate/ ./dist/delegate/
COPY delegate/review/postmortems/ ./dist/delegate/review/postmortems/

RUN adduser -D -s /bin/bash agent && chown -R agent:agent /app
USER agent
ENV SHELL=/bin/bash
RUN git init

CMD ["node", "dist/delegate/worker/entrypoint.js"]
