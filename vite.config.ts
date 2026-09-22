import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  defineConfig,
  loadEnv,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from "vite"
import { VitePWA } from "vite-plugin-pwa"

import {
  resolveRuntimeConfiguration,
  serializePublicRuntimeConfiguration,
} from "./shared/runtime-config.ts"
import {
  DEFAULT_RUNTIME_MODE,
  getRuntimeEntrypoint,
} from "./shared/runtime-modes.ts"
import { readTitleBarColors } from "./shared/theme-color.ts"

function runtimeConfigurationFromEnvironment(environment: NodeJS.ProcessEnv) {
  return resolveRuntimeConfiguration({
    AOS_UI_RUNTIME_MODE: environment.AOS_UI_RUNTIME_MODE,
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

/**
 * `src/app/globals.css` owns the title-bar color; the meta tags only mirror it.
 * A missing placeholder throws so the build fails loudly instead of shipping a
 * literal `%AOS_TITLE_BAR_*%` to the browser.
 */
function titleBarColorPlugin(colors: { light: string; dark: string }): Plugin {
  return {
    name: "aos-title-bar-color",
    transformIndexHtml(html) {
      let filled = html
      for (const [placeholder, color] of [
        ["%AOS_TITLE_BAR_LIGHT%", colors.light],
        ["%AOS_TITLE_BAR_DARK%", colors.dark],
      ] as const) {
        if (!filled.includes(placeholder))
          throw new Error(`title bar color: \`${placeholder}\` is missing`)
        filled = filled.replaceAll(placeholder, color)
      }
      return filled
    },
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
  const titleBarColors = readTitleBarColors(
    readFileSync(
      path.resolve(import.meta.dirname, "src/app/globals.css"),
      "utf8"
    )
  )
  const cacheKey = (
    environment.AOS_UI_E2E_CACHE_KEY ??
    environment.AOS_UI_RUNTIME_MODE ??
    DEFAULT_RUNTIME_MODE
  ).replace(/[^a-zA-Z0-9_-]/g, "-")
  const allowedHosts = (
    environment.AOS_UI_ALLOWED_HOSTS ??
    environment.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
  )
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean)
  const aosProxy = {
    "/api/aos/v1": {
      target: environment.AOS_UI_PROXY_TARGET ?? "http://127.0.0.1:4100",
      changeOrigin: false,
      ws: true,
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
      titleBarColorPlugin(titleBarColors),
      // Push only: `src/sw/sw.ts` is bundled as-is, with no precache manifest
      // injected, no offline shell, and no registration script in the HTML.
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src/sw",
        filename: "sw.ts",
        injectManifest: { injectionPoint: undefined, rollupFormat: "iife" },
        injectRegister: false,
        manifest: {
          id: "/",
          name: "AOS",
          short_name: "AOS",
          // Same sentence as the `description` meta tag in `index.html`.
          description:
            "A multilingual workspace for provider-owned AI agents and sessions.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          lang: "en",
          // Derived from light `--sidebar`, the surface the title bar meets at
          // both top corners. The manifest carries no theme variants, so the
          // light value covers the splash and the window before the
          // `theme-color` meta tags in `index.html` apply.
          background_color: titleBarColors.light,
          theme_color: titleBarColors.light,
          icons: [
            {
              src: "/icons/pwa-64x64.png",
              sizes: "64x64",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@aos/protocol/acp": path.resolve(
          import.meta.dirname,
          "packages/protocol/acp.ts"
        ),
        "@aos/protocol/push": path.resolve(
          import.meta.dirname,
          "packages/protocol/push.ts"
        ),
        "@aos/protocol": path.resolve(
          import.meta.dirname,
          "packages/protocol/index.ts"
        ),
      },
    },
    optimizeDeps: {
      entries: ["index.html", "src/runtime-adapters/*/index.ts"],
      include: ["@base-ui/react/direction-provider", "@base-ui/react/select"],
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      allowedHosts,
      proxy: aosProxy,
    },
    preview: {
      allowedHosts,
      proxy: aosProxy,
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
