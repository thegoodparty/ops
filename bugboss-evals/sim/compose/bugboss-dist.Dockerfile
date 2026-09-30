# Compiles a variant's dist/ inside a build container and exports it, so the
# variant's own bugboss/Dockerfile can then build the image it would ship.
# The variant's code runs here, never on the host holding the docker socket.
FROM node:22-alpine AS build
RUN apk add --no-cache build-base python3
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc

FROM scratch
COPY --from=build /src/dist /dist
