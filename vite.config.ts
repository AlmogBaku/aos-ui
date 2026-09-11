import react from "@vitejs/plugin-react"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  defineConfig,
  loadEnv,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from "vite"

import {
  resolveRuntimeConfiguration,
  serializePublicRuntimeConfiguration,
} from "./shared/runtime-config.ts"
import {
  DEFAULT_RUNTIME_MODE,
  getRuntimeEntrypoint,
} from "./shared/runtime-modes.ts"

function runtimeConfigurationFromEnvironment(environment: NodeJS.ProcessEnv) {
  return resolveRuntimeConfiguration({
    AOS_UI_RUNTIME_MODE: environment.AOS_UI_RUNTIME_MODE,
    AOS_UI_HERMES_BASE_URL: environment.AOS_UI_HERMES_BASE_URL,
    AOS_UI_OPENCODE_BASE_URL: environment.AOS_UI_OPENCODE_BASE_URL,
    AOS_UI_OPENCODE_PROVIDER_ID: environment.AOS_UI_OPENCODE_PROVIDER_ID,
    AOS_UI_OPENCODE_MODEL_ID: environment.AOS_UI_OPENCODE_MODEL_ID,
    AOS_UI_OPENCODE_WORKTREE: environment.AOS_UI_OPENCODE_WORKTREE,
    AOS_UI_AG_UI_URL: environment.AOS_UI_AG_UI_URL,
    AOS_UI_AG_UI_WORKSPACE_URL: environment.AOS_UI_AG_UI_WORKSPACE_URL,
    AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED:
      environment.AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED,
    AOS_UI_COMPOSER_CONTEXT_ENABLED:
      environment.AOS_UI_COMPOSER_CONTEXT_ENABLED,
  })
}

function runtimeConfigurationPlugin(environment: NodeJS.ProcessEnv): Plugin {
  const configureRuntimeConfiguration = (
    server: PreviewServer | ViteDevServer
  ) => {
    server.middlewares.use(
      "/runtime-config.json",
      async (_request, response) => {
        response.setHeader("cache-control", "no-store")
        response.setHeader("content-type", "application/json; charset=utf-8")
        try {
          const configFile = environment.AOS_UI_RUNTIME_CONFIG_FILE
          const body = configFile
            ? await readFile(path.resolve(configFile), "utf8")
            : JSON.stringify(
                serializePublicRuntimeConfiguration(
                  runtimeConfigurationFromEnvironment(environment)
                )
              )
          response.end(body)
        } catch {
          response.statusCode = 500
          response.end(
            JSON.stringify({
              status: "unavailable",
              reason: "invalid-public-config",
            })
          )
        }
      }
    )
  }

  return {
    name: "aos-runtime-configuration",
    configureServer: configureRuntimeConfiguration,
    configurePreviewServer: configureRuntimeConfiguration,
  }
}

function e2eReadinessPlugin(environment: NodeJS.ProcessEnv): Plugin {
  const runtimeMode = environment.AOS_UI_RUNTIME_MODE ?? DEFAULT_RUNTIME_MODE
  const runtimeEntry = getRuntimeEntrypoint(runtimeMode)
  return {
    name: "aos-e2e-readiness",
    configureServer(server) {
      if (!environment.AOS_UI_E2E_CACHE_KEY) return
      let ready: Promise<void> | undefined
      server.middlewares.use("/__aos_e2e_ready", async (_request, response) => {
        try {
          ready ??= (async () => {
            const optimizer = server.environments.client.depsOptimizer
            await optimizer?.scanProcessing
            await Promise.all(
              Object.values(optimizer?.metadata.discovered ?? {}).flatMap(
                ({ processing }) => (processing ? [processing] : [])
              )
            )
            await Promise.all([
              server.warmupRequest("/src/main.tsx"),
              ...(runtimeEntry ? [server.warmupRequest(runtimeEntry)] : []),
            ])
            await server.waitForRequestsIdle()
            await Promise.all(
              Object.values(optimizer?.metadata.discovered ?? {}).flatMap(
                ({ processing }) => (processing ? [processing] : [])
              )
            )
          })()
          await ready
          response.statusCode = 204
          response.end()
        } catch {
          ready = undefined
          response.statusCode = 503
          response.end()
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const environment = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  }
  const cacheKey = (
    environment.AOS_UI_E2E_CACHE_KEY ??
    environment.AOS_UI_RUNTIME_MODE ??
    DEFAULT_RUNTIME_MODE
  ).replace(/[^a-zA-Z0-9_-]/g, "-")
  const hermesProxy = {
    "/auth": {
      target: environment.AOS_UI_HERMES_TARGET ?? "http://127.0.0.1:9119",
      changeOrigin: false,
      headers: { "X-Forwarded-Prefix": "/hermes" },
    },
    "/hermes": {
      target: environment.AOS_UI_HERMES_TARGET ?? "http://127.0.0.1:9119",
      changeOrigin: false,
      ws: true,
      headers: { "X-Forwarded-Prefix": "/hermes" },
      rewrite: (pathname: string) => pathname.replace(/^\/hermes/, ""),
    },
  }

  return {
    cacheDir: path.resolve(
      import.meta.dirname,
      `node_modules/.vite-${cacheKey}`
    ),
    plugins: [
      react(),
      runtimeConfigurationPlugin(environment),
      e2eReadinessPlugin(environment),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
      },
    },
    optimizeDeps: {
      entries: ["index.html", "src/runtime-adapters/*/composition.tsx"],
      include: ["@base-ui/react/direction-provider", "@base-ui/react/select"],
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      proxy: hermesProxy,
    },
    preview: {
      proxy: hermesProxy,
      // Playwright starts a fresh preview for every runtime matrix. Avoid a
      // browser retaining an obsolete hashed chunk between those servers.
      headers: {
        "Cache-Control": "no-store",
      },
    },
    build: {
      chunkSizeWarningLimit: 650,
    },
  }
})
