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

FROM dependencies AS proxy
COPY --chown=bun:bun packages ./packages
USER bun
EXPOSE 4100
CMD ["bun", "run", "proxy:serve", "--", "--config", "/run/aos-ui/proxy-config.json"]

FROM dependencies AS builder
COPY . .
RUN bun run build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine AS runner
ENV AOS_UI_WEB_PORT=3000 \
    AOS_UI_PROXY_HOST=127.0.0.1 \
    AOS_UI_PROXY_PORT=4100

COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder --chown=nginx:nginx /app/dist /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/runtime-config.json

USER nginx
EXPOSE 3000
