import { createStaticHandler } from "./static"

const bun = (
  globalThis as unknown as {
    Bun?: {
      serve(options: {
        hostname: string
        port: number
        fetch(request: Request): Response | Promise<Response>
      }): { stop(force?: boolean): void }
    }
  }
).Bun

if (!bun) throw new Error("Bun runtime is required")

const handler = createStaticHandler({
  root: process.env.AOS_UI_STATIC_ROOT ?? "/app/dist",
  runtimeConfig:
    process.env.AOS_UI_RUNTIME_CONFIG_FILE ?? "/run/aos-ui/runtime-config.json",
})

bun.serve({
  hostname: process.env.AOS_UI_WEB_HOST ?? "0.0.0.0",
  port: Number(process.env.AOS_UI_WEB_PORT ?? "3000"),
  fetch: async (request) =>
    (await handler(request)) ?? new Response(null, { status: 404 }),
})
