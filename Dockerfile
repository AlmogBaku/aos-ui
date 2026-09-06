# syntax=docker/dockerfile:1

FROM oven/bun:1.3.10-debian AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --frozen-lockfile

FROM dependencies AS development
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
EXPOSE 3000
CMD ["bun", "run", "dev", "--hostname", "0.0.0.0"]

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN bun run build

FROM node:22.22.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
