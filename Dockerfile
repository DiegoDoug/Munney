# Munney — deployable container image.
# Zero runtime dependencies: the app ships entirely on Node's standard library
# (node:sqlite, node:http), so there is no `npm install` step for production.
FROM node:22-alpine

# node:sqlite is an experimental core module in Node 22; no flag is required,
# it only prints an experimental warning at startup.
ENV NODE_ENV=production \
    PORT=4321 \
    HOST=0.0.0.0 \
    MUNNEY_DB=/app/data/munney.db

WORKDIR /app

# Copy only what the server needs at runtime.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Persist the SQLite database outside the image layer.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4321

# Simple liveness check against a lightweight JSON endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/accounts >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
