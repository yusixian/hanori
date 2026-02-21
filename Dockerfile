FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/bot/package.json packages/bot/
COPY packages/server/package.json packages/server/
COPY packages/panel/package.json packages/panel/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /app/packages/bot/node_modules ./packages/bot/node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=deps /app/packages/panel/node_modules ./packages/panel/node_modules
COPY . .
RUN pnpm -r build

# Production
FROM base AS runner
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /app/packages/bot/node_modules ./packages/bot/node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/dist ./packages/shared/
COPY packages/database/package.json packages/database/dist ./packages/database/
COPY packages/bot/package.json packages/bot/dist ./packages/bot/
COPY packages/server/package.json packages/server/dist ./packages/server/

# Copy panel build output as static files for Hono to serve
COPY --from=builder /app/packages/panel/dist ./packages/server/public

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
