FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Keep optional Pi dependencies out of the main application image.
FROM base AS app-runtime-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/bot/package.json packages/bot/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @cos-tool-bot/server...

# The worker runtime only needs Pi and its production dependency graph.
FROM base AS worker-runtime-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/coding-worker/package.json packages/coding-worker/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @cos-tool-bot/coding-worker

# The worker reaches public HTTP(S) only through this DNS-aware policy proxy.
FROM alpine:3.21 AS coding-egress-proxy
RUN apk add --no-cache squid
COPY infrastructure/coding-egress-proxy/squid.conf /etc/squid/squid.conf
USER squid
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/bot/package.json packages/bot/
COPY packages/server/package.json packages/server/
COPY packages/panel/package.json packages/panel/
COPY packages/docs/package.json packages/docs/
COPY packages/coding-worker/package.json packages/coding-worker/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /app/packages/bot/node_modules ./packages/bot/node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=deps /app/packages/panel/node_modules ./packages/panel/node_modules
COPY --from=deps /app/packages/docs/node_modules ./packages/docs/node_modules
COPY --from=deps /app/packages/coding-worker/node_modules ./packages/coding-worker/node_modules
COPY . .
ARG APP_VERSION=""
RUN APP_VERSION="$APP_VERSION" node scripts/write-deployment-version.mjs
ARG DOCS_SITE_URL=""
RUN DOCS_SITE_URL="$DOCS_SITE_URL" pnpm -r build

# Production
FROM base AS runner
ENV NODE_ENV=production
RUN corepack disable 2>/dev/null; rm -rf /root/.cache /tmp/*
RUN apk add --no-cache ffmpeg git postgresql17-client && mkdir -p /data/backups /app/data /workspaces /git-metadata && chown node:node /workspaces /git-metadata

# Pin yt-dlp and its compatible YouTube EJS solver; the existing Node runtime executes challenges.
COPY infrastructure/bilibili-ytdlp/requirements.txt /opt/bilibili-ytdlp/requirements.txt
RUN apk add --no-cache python3 py3-pip \
  && python3 -m venv /opt/bilibili-ytdlp/venv \
  && /opt/bilibili-ytdlp/venv/bin/pip install --no-cache-dir -r /opt/bilibili-ytdlp/requirements.txt
ENV PATH="/opt/bilibili-ytdlp/venv/bin:${PATH}"

COPY --from=app-runtime-deps /app/node_modules ./node_modules
COPY --from=app-runtime-deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=app-runtime-deps /app/packages/bot/node_modules ./packages/bot/node_modules
COPY --from=app-runtime-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/database/drizzle ./packages/database/drizzle
COPY --from=builder /app/packages/bot/package.json ./packages/bot/
COPY --from=builder /app/packages/bot/dist ./packages/bot/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/deployment-version ./deployment-version

# Copy panel build output as static files for Hono to serve
COPY --from=builder /app/packages/panel/dist ./public
COPY --from=builder /app/packages/docs/build/client/docs ./public/docs
COPY --from=builder /app/packages/docs/build/client/docs.data ./public/docs.data

EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "packages/server/dist/index.js"]

# Lody's native modules (node-pty) have no musl prebuilds, so the harness bridge runs on glibc.
FROM node:22-bookworm-slim AS lody-bridge
ARG LODY_VERSION=0.103.0
ENV NODE_ENV=production
RUN npm install -g "lody@${LODY_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /home/node/.lody /opt/lody-bridge \
  && chown node:node /home/node/.lody
# Older BuildKit applies COPY --chmod to directories it creates, which left /opt/lody-bridge
# untraversable for the node user; create it first and set modes explicitly.
COPY infrastructure/lody-bridge/server.mjs infrastructure/lody-bridge/allowlist.mjs infrastructure/lody-bridge/waiter.mjs infrastructure/lody-bridge/runtime.mjs infrastructure/lody-bridge/entrypoint.sh /opt/lody-bridge/
RUN chmod 755 /opt/lody-bridge /opt/lody-bridge/entrypoint.sh \
  && chmod 644 /opt/lody-bridge/server.mjs /opt/lody-bridge/allowlist.mjs /opt/lody-bridge/waiter.mjs /opt/lody-bridge/runtime.mjs
USER node
ENV HOME=/home/node
ENTRYPOINT ["/opt/lody-bridge/entrypoint.sh"]

# Pi runs out-of-process so its memory and shell tools are isolated from the bot server.
FROM base AS coding-worker
ENV NODE_ENV=production
ENV COREPACK_HOME=/opt/corepack
RUN corepack prepare pnpm@10.5.2 --activate && apk add --no-cache bash git ripgrep su-exec tini && mkdir -p /job /coding-control /tmp/pi-agent && chown node:node /tmp/pi-agent

COPY --from=worker-runtime-deps /app/node_modules ./node_modules
COPY --from=worker-runtime-deps /app/packages/coding-worker/node_modules ./packages/coding-worker/node_modules
COPY --from=builder /app/packages/coding-worker/package.json ./packages/coding-worker/
COPY --from=builder /app/packages/coding-worker/dist ./packages/coding-worker/dist
COPY --chmod=755 infrastructure/coding-worker/entrypoint.sh /usr/local/bin/coding-worker-entrypoint

ENTRYPOINT ["/usr/local/bin/coding-worker-entrypoint"]
CMD ["node", "--max-old-space-size=768", "packages/coding-worker/dist/index.js"]

# Audio conversion has no network, application dependencies, or provider credentials.
FROM node:22-alpine AS media-worker
RUN apk add --no-cache ffmpeg tini && mkdir -p /opt/media-worker /media-control /media-jobs
COPY infrastructure/media-worker/server.mjs /opt/media-worker/server.mjs
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--max-old-space-size=128", "/opt/media-worker/server.mjs"]

# Keep the existing default `docker build .` behavior on the main application image.
FROM runner AS app
