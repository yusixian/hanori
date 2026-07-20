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

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/bot/package.json packages/bot/
COPY packages/server/package.json packages/server/
COPY packages/panel/package.json packages/panel/
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
COPY --from=deps /app/packages/coding-worker/node_modules ./packages/coding-worker/node_modules
COPY . .
RUN pnpm -r build

# Production
FROM base AS runner
ENV NODE_ENV=production
RUN corepack disable 2>/dev/null; rm -rf /root/.cache /tmp/*
RUN apk add --no-cache git postgresql17-client && mkdir -p /data/backups /app/data /workspaces /git-metadata && chown node:node /workspaces /git-metadata

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

# Copy panel build output as static files for Hono to serve
COPY --from=builder /app/packages/panel/dist ./public

EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "packages/server/dist/index.js"]

# Pi runs out-of-process so its memory and shell tools are isolated from the bot server.
FROM base AS coding-worker
ENV NODE_ENV=production
ENV COREPACK_HOME=/opt/corepack
RUN corepack prepare pnpm@10.5.2 --activate && apk add --no-cache bash git ripgrep && mkdir -p /workspaces /git-metadata /tmp/pi-agent && chown -R node:node /workspaces /git-metadata /tmp/pi-agent

COPY --from=worker-runtime-deps /app/node_modules ./node_modules
COPY --from=worker-runtime-deps /app/packages/coding-worker/node_modules ./packages/coding-worker/node_modules
COPY --from=builder /app/packages/coding-worker/package.json ./packages/coding-worker/
COPY --from=builder /app/packages/coding-worker/dist ./packages/coding-worker/dist

USER node
EXPOSE 3010
CMD ["sh", "-c", "umask 077; printf '%s' \"$CODING_WORKER_SECRET\" > /tmp/coding-worker-secret; exec env -u CODING_WORKER_SECRET node --max-old-space-size=768 packages/coding-worker/dist/index.js"]

# Keep the existing default `docker build .` behavior on the main application image.
FROM runner AS app
