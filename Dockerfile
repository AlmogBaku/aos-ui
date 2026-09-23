# syntax=docker/dockerfile:1

FROM oven/bun:1.3.10-debian AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM dependencies AS development
COPY . .
EXPOSE 3000
CMD ["bun", "run", "dev", "--host", "0.0.0.0"]

FROM dependencies AS builder
COPY . .
RUN bun run build

FROM dependencies AS tools-mcp
COPY --chown=bun:bun packages/tools-mcp ./packages/tools-mcp
COPY --chown=bun:bun shared/presentation ./shared/presentation
RUN bun run tools-mcp:build
USER bun
EXPOSE 4110
CMD ["bun", "run", "packages/tools-mcp/cli.ts", "--http", "--host", "0.0.0.0", "--port", "4110"]

FROM dependencies AS proxy
COPY --chown=bun:bun packages ./packages
COPY --chown=bun:bun shared ./shared
COPY --from=builder --chown=bun:bun /app/dist /app/dist
USER bun
EXPOSE 3000 3001
CMD ["bun", "run", "static:serve"]
