# Base image and npm registry can be overridden at build time:
#   --build-arg NODE_IMAGE=registry.internal/library/node:22-alpine
#   --build-arg NPM_REGISTRY=https://nexus.internal/repository/npm-proxy/
ARG NODE_IMAGE=node:22-alpine

# Layer order matters for build speed: package files are copied and installed
# before the source, so changing App.jsx reuses the cached npm install.

# ---------- Stage 1: build the React client ----------
FROM ${NODE_IMAGE} AS client-build
ARG NPM_REGISTRY
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci
COPY client/ ./
RUN npm run build

# ---------- Stage 2: install server runtime dependencies ----------
FROM ${NODE_IMAGE} AS server-deps
ARG NPM_REGISTRY
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci --omit=dev

# ---------- Stage 3: final runtime image ----------
# Only Node, the server code, its node_modules and the built client end up here.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app

COPY --from=server-deps --chown=node:node /app/server/node_modules ./server/node_modules
COPY --chown=node:node server/package.json server/index.js ./server/
COPY --from=client-build --chown=node:node /app/client/dist ./client/dist

# Don't run as root inside the container
USER node
WORKDIR /app/server
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/ || exit 1

CMD ["node", "index.js"]
