import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib"
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
  MCP_APP_SANDBOX_CSP,
  MCP_APP_SANDBOX_PATH,
} from "./packages/protocol/mcp-apps.ts"
import {
  DEFAULT_RUNTIME_MODE,
  getRuntimeEntrypoint,
} from "./shared/runtime-modes.ts"
import { readTitleBarColors } from "./shared/theme-color.ts"
import {
  FIXTURE_AOS_UI_MCP_PATH,
  FIXTURE_MCP_APP_FILE_PATHS,
} from "./shared/presentation/views.ts"
import {
  buildGrammars,
  buildPdfjs,
  buildViews,
} from "./packages/tools-mcp/views/build.ts"
import { snapshotToolsServer } from "./packages/tools-mcp/snapshot.ts"
import { reactCompiler } from "./react-compiler.config.ts"

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

/**
 * Adds `Access-Control-Allow-Origin: null` to the synthetic fixture
 * files the artifact view fetches from an opaque-origin sandbox frame. Mirrors
 * what `packages/proxy/static.ts` does in production.
 */
function fixtureMcpAppFilesPlugin(): Plugin {
  const paths = new Set(FIXTURE_MCP_APP_FILE_PATHS)
  const addHeader = (server: PreviewServer | ViteDevServer) => {
    server.middlewares.use((request, response, next) => {
      if (paths.has(request.url?.split("?")[0] ?? ""))
        response.setHeader("access-control-allow-origin", "null")
      next()
    })
  }
  return {
    name: "aos-fixture-mcp-app-files",
    configureServer: addHeader,
    configurePreviewServer: addHeader,
  }
}

/** The MCP App sandbox page carries the policy the proxy serves it with. */
function mcpAppSandboxPlugin(): Plugin {
  const secure = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] === MCP_APP_SANDBOX_PATH)
        response.setHeader("Content-Security-Policy", MCP_APP_SANDBOX_CSP)
      next()
    })
  }
  return {
    name: "aos-mcp-app-sandbox",
    configureServer: secure,
    configurePreviewServer: secure,
  }
}

/** The real `aos-ui` server's answers, as JSON, from views built right now. */
async function recordToolsServer() {
  const [views, pdfjs, grammars] = await Promise.all([
    buildViews(),
    buildPdfjs(),
    buildGrammars(),
  ])
  return JSON.stringify(await snapshotToolsServer({ views, pdfjs, grammars }))
}

/**
 * Fixture mode draws charts, maps and stats through the real `aos-ui` server:
 * its views are built and its `tools/list` and `resources/read` answers
 * recorded at `FIXTURE_AOS_UI_MCP_PATH`. The dev server records on first
 * request and again after a view or schema changes; the build writes the file
 * into `dist`, where preview and the Bun proxy serve it.
 */
function fixtureToolsServerPlugin(): Plugin {
  const sources = [
    path.resolve(import.meta.dirname, "packages/tools-mcp"),
    path.resolve(import.meta.dirname, "shared/presentation"),
  ]
  return {
    name: "aos-fixture-tools-server",
    configureServer(server) {
      let recorded: Promise<string> | undefined
      server.watcher.add(sources)
      server.watcher.on("all", (_event, file) => {
        if (sources.some((source) => file.startsWith(source)))
          recorded = undefined
      })
      server.middlewares.use(
        FIXTURE_AOS_UI_MCP_PATH,
        async (_request, response) => {
          response.setHeader("cache-control", "no-store")
          try {
            recorded ??= recordToolsServer()
            const body = await recorded
            response.setHeader(
              "content-type",
              "application/json; charset=utf-8"
            )
            response.end(body)
          } catch (error) {
            recorded = undefined
            server.config.logger.error(String(error))
            response.statusCode = 500
            response.end()
          }
        }
      )
    },
    async generateBundle() {
      if (this.environment.name !== "client") return
      this.emitFile({
        type: "asset",
        fileName: FIXTURE_AOS_UI_MCP_PATH.slice(1),
        source: await recordToolsServer(),
      })
    },
  }
}

/**
 * The build id is the entry chunk's content hash, which changes with every
 * chunk the page can load. The build writes it to `dist/build-id`, where the
 * proxy reads it for `initialize`, and compiles it in as `__AOS_BUILD_ID__`;
 * the dev server has none. The entry is hashed before the value is compiled
 * in, so the build writes a placeholder and swaps it once the hash is known.
 */
function buildIdPlugin(): Plugin {
  const placeholder = "__AOS_BUILD_ID_PLACEHOLDER__"
  return {
    name: "aos-build-id",
    config: (_config, { command }) => ({
      define: {
        __AOS_BUILD_ID__:
          command === "build" ? JSON.stringify(placeholder) : "null",
      },
    }),
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return
      const chunks = Object.values(bundle).filter(
        (output) => output.type === "chunk"
      )
      const entry = chunks.find((chunk) => chunk.isEntry)
      if (!entry) throw new Error("The build has no entry chunk")
      // `[name]-[hash].js`, Vite's entry file name.
      const buildId = path
        .basename(entry.fileName, ".js")
        .slice(entry.name.length + 1)
      for (const chunk of chunks)
        chunk.code = chunk.code.replaceAll(placeholder, buildId)
      this.emitFile({ type: "asset", fileName: "build-id", source: buildId })
    },
  }
}

/**
 * Writes `.br` and `.gz` beside every text asset in the client build, which
 * `packages/proxy/static.ts` serves to clients that accept them. It runs after
 * every other plugin's `closeBundle`, `VitePWA`'s `sw.js` included, so no copy
 * can describe a file that is still being written.
 */
function precompressPlugin(): Plugin {
  const compressible = /\.(?:js|css|html|svg|json|webmanifest|wasm)$/u
  const brotli = promisify(brotliCompress)
  const gzipped = promisify(gzip)
  let outDir = ""
  return {
    name: "aos-precompress",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        const files = await readdir(outDir, { recursive: true })
        await Promise.all(
          files
            .filter((file) => compressible.test(file))
            .map(async (file) => {
              const target = path.join(outDir, file)
              const source = await readFile(target)
              if (source.byteLength < 1024) return
              await Promise.all([
                brotli(source, {
                  params: {
                    [zlibConstants.BROTLI_PARAM_QUALITY]:
                      zlibConstants.BROTLI_MAX_QUALITY,
                    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
                  },
                }).then((copy) => writeFile(`${target}.br`, copy)),
                gzipped(source, { level: 9 }).then((copy) =>
                  writeFile(`${target}.gz`, copy)
                ),
              ])
            })
        )
      },
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
      reactCompiler(),
      runtimeConfigurationPlugin(environment),
      e2eReadinessPlugin(environment),
      mcpAppSandboxPlugin(),
      fixtureMcpAppFilesPlugin(),
      fixtureToolsServerPlugin(),
      buildIdPlugin(),
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
      precompressPlugin(),
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
        "@aos/protocol/mcp-apps": path.resolve(
          import.meta.dirname,
          "packages/protocol/mcp-apps.ts"
        ),
        "@aos/protocol": path.resolve(
          import.meta.dirname,
          "packages/protocol/index.ts"
        ),
        "@aos/lifecycle": path.resolve(
          import.meta.dirname,
          "packages/lifecycle/index.ts"
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
