import react from "@vitejs/plugin-react"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { defineConfig, loadEnv, type Plugin } from "vite"

import { resolveRuntimeConfiguration } from "./shared/runtime-config.ts"

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
  })
}

function runtimeConfigurationPlugin(environment: NodeJS.ProcessEnv): Plugin {
  return {
    name: "aos-runtime-configuration",
    configureServer(server) {
      server.middlewares.use(
        "/runtime-config.json",
        async (_request, response) => {
          response.setHeader("cache-control", "no-store")
          response.setHeader("content-type", "application/json; charset=utf-8")
          try {
            const configFile = environment.AOS_UI_RUNTIME_CONFIG_FILE
            const body = configFile
              ? await readFile(path.resolve(configFile), "utf8")
              : JSON.stringify(runtimeConfigurationFromEnvironment(environment))
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
    "opencode"
  ).replace(/[^a-zA-Z0-9_-]/g, "-")

  return {
    cacheDir: path.resolve(
      import.meta.dirname,
      `node_modules/.vite-${cacheKey}`
    ),
    plugins: [react(), runtimeConfigurationPlugin(environment)],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
      },
    },
    optimizeDeps: {
      entries: ["index.html", "src/components/aos-ui-*-app.tsx"],
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      proxy: {
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
          rewrite: (pathname) => pathname.replace(/^\/hermes/, ""),
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 650,
    },
  }
})
