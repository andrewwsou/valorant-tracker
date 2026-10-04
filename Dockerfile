# syntax=docker/dockerfile:1

# Production image, built in stages so the final image holds only the compiled
# server: no source code, no dev dependencies, no secrets.

ARG NODE_VERSION=22

# 1. deps: install every package. Dev dependencies are needed to build.
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
# The schema must be present so the install step can generate the Prisma client.
COPY prisma ./prisma
RUN npm ci

# 2. migrate: one-off job that applies pending database migrations, then exits.
FROM deps AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# 3. build: compile the app into a self-contained server (output: "standalone").
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 4. runner: the image that actually ships.
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl

# HOSTNAME must be set: Docker sets it to the container ID, and the Next.js
# server would then listen only on that address instead of all interfaces.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Never run as root inside the container.
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
