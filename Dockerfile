# syntax=docker/dockerfile:1
# PACTORA, self-hosted. See docs/self-hosting.md, "Run it with Docker".
#
#   docker compose -f docker-compose.selfhost.yml up -d --build
#
# Builds the app once, then runs it with Node.js 24. Migrations are applied
# on every start (they are idempotent), so an upgrade is: pull, rebuild,
# restart. Documents are kept in /data/storage, which should be a volume.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# A network that intercepts TLS can hand the build its CA as a secret:
#   docker build --secret id=build_ca,src=/path/to/ca.crt .
# Without it, nothing changes. The secret is never stored in an image layer.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build

FROM node:24-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    STORAGE_DRIVER=local \
    STORAGE_LOCAL_DIR=/data/storage
RUN groupadd --system pactora && useradd --system --gid pactora --home /app pactora \
    && mkdir -p /data/storage && chown -R pactora:pactora /data
COPY --from=build --chown=pactora:pactora /app ./
RUN npm prune --omit=dev --no-audit --no-fund --offline
USER pactora
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node db/migrate.mjs && exec npx next start --port ${PORT}"]
