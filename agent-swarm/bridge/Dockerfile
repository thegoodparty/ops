FROM node:22-alpine

# No dependencies and no build step, so there is no install layer and no
# node_modules in the image.
WORKDIR /app

COPY package.json index.mjs ./

# The state file lives here by default. It is created and owned up front so the
# non-root runtime user can write the incident counter, including when this path
# is a freshly mounted named volume (Docker copies the image dir's ownership).
RUN mkdir -p /state && chown node:node /state

# node:22-alpine ships this unprivileged user; running as it keeps a hostile
# alert payload from owning the container.
USER node

ENV PORT=3014
EXPOSE 3014

CMD ["node", "index.mjs"]
