import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
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
import { MCP_APP_SANDBOX_PATH } from "@harness-gw/sdk/protocol"
import {
  MCP_APP_SANDBOX_ORIGIN_SETTING,
  PUBLIC_ORIGIN_SETTING,
  readDeploymentOrigins,
  type DeploymentOrigins,
} from "./shared/lane-origins.ts"
import {
  lanePageFrameSrc,
  MCP_APP_SANDBOX_SCRIPT_PATH,
  namesSandboxFile,
  sandboxAt,
  sandboxPagePolicy,
  SERVICE_WORKER_HEADER,
  stableOriginsOf,
} from "./shared/mcp-app-sandbox.ts"
import { requestedFile } from "./server/static.ts"
import {
  DEFAULT_RUNTIME_MODE,
  getRuntimeEntrypoint,
} from "./shared/runtime-modes.ts"
import { readTitleBarColors } from "./shared/theme-color.ts"
import {
  FIXTURE_AOS_UI_MCP_PATH,
  FIXTURE_ARTIFACT_VIEW_DOMAIN,
} from "./shared/presentation/views.ts"
import {
  buildGrammars,
  buildMaplibre,
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

const DEV_SERVER_PORT = 3000

type DeploymentOriginsOf = (request: IncomingMessage) => DeploymentOrigins

/**
 * The deployment's origins, read as the web server reads them
 * (`readDeploymentOrigins`): its settings, or, where they are unset, loopback
 * names on `port`, the port a request reached, which is this server's own.
 * A guest page that frames the sandbox Vite serves, as a harness overlay's
 * web-guest serves it, is listed in `AOS_UI_PUBLIC_ORIGIN` with the rest.
 */
export function deploymentOriginsAt(environment: NodeJS.ProcessEnv) {
  return (port: number | undefined): DeploymentOrigins => {
    const loopback: Record<string, string> = {
      [PUBLIC_ORIGIN_SETTING]: `http://localhost:${port},http://127.0.0.1:${port}`,
      [MCP_APP_SANDBOX_ORIGIN_SETTING]: `http://sandbox.localhost:${port}`,
    }
    return readDeploymentOrigins((name) => environment[name] || loopback[name])
  }
}

function runtimeConfigurationPlugin(
  environment: NodeJS.ProcessEnv,
  originsOf: DeploymentOriginsOf
): Plugin {
  const configureRuntimeConfiguration = (
    server: PreviewServer | ViteDevServer
  ) => {
    server.middlewares.use(
      "/runtime-config.json",
      async (request, response) => {
        response.setHeader("cache-control", "no-store")
        response.setHeader("content-type", "application/json; charset=utf-8")
        try {
          const configFile = environment.AOS_UI_RUNTIME_CONFIG_FILE
          const configured: unknown = configFile
            ? JSON.parse(await readFile(path.resolve(configFile), "utf8"))
            : serializePublicRuntimeConfiguration(
                runtimeConfigurationFromEnvironment(environment)
              )
          if (
            configured === null ||
            typeof configured !== "object" ||
            Array.isArray(configured)
          )
            throw new Error("The runtime configuration is not an object")
          // The deployment's origins, over any the file names, as the web
          // server writes them.
          response.end(JSON.stringify({ ...configured, ...originsOf(request) }))
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

/** Says once, as a server starts, that it forwards `/api/v1` to no gateway. */
function gatewayTargetNoticePlugin(target: string | undefined): Plugin {
  const notice = (server: PreviewServer | ViteDevServer) => {
    if (target === undefined)
      server.config.logger.warn(
        "AOS_UI_GATEWAY_TARGET is unset, so /api/v1 reaches no gateway. Fixture mode needs none; for aos mode, set it to the gateway's URL."
      )
  }
  return {
    name: "aos-gateway-target-notice",
    configureServer: notice,
    configurePreviewServer: notice,
  }
}

const notFound = (response: ServerResponse) => {
  response.statusCode = 404
  response.end()
}

/**
 * The web server's MCP App sandbox rule (`server/web.ts`), ahead of every
 * other answer these servers give: on the sandbox address, and exactly on each
 * stable host, only the sandbox page, under its view's policy for that
 * origin, and its relay script, each by the file the request names and never
 * as a service worker's script; on any other host at or below the stable
 * origins' domain nothing; on the lane's own addresses neither file, by that
 * file or by any path whose last segment names one, as these servers rewrite
 * paths to files, and pages that frame the sandbox origins alone.
 */
function mcpAppSandboxPlugin(originsOf: DeploymentOriginsOf): Plugin {
  const secure = (server: ViteDevServer | PreviewServer, root: string) => {
    const files = new Map(
      [MCP_APP_SANDBOX_PATH, MCP_APP_SANDBOX_SCRIPT_PATH].map((file) => [
        requestedFile(root, file),
        file,
      ])
    )
    server.middlewares.use((request, response, next) => {
      const origins = originsOf(request)
      // Prefixed, not resolved, so `//name` stays a path rather than a host.
      const url = new URL(`http://request.invalid${request.url ?? "/"}`)
      const requested = requestedFile(root, url.pathname)
      const file = requested === undefined ? undefined : files.get(requested)
      const sandbox = sandboxAt(origins, request.headers.host ?? "")
      if (sandbox === "refused") return notFound(response)
      if (sandbox === undefined) {
        if (file !== undefined || namesSandboxFile(url.pathname))
          return notFound(response)
        response.setHeader("content-security-policy", lanePageFrameSrc(origins))
        return next()
      }
      if (
        file === undefined ||
        request.headers[SERVICE_WORKER_HEADER] !== undefined
      )
        return notFound(response)
      // Served by its own path, which no fallback page answers.
      request.url = `${file}${url.search}`
      if (file === MCP_APP_SANDBOX_PATH) {
        response.setHeader(
          "content-security-policy",
          sandboxPagePolicy(sandbox, url.searchParams)
        )
        response.setHeader("cache-control", "no-store")
      }
      next()
    })
  }
  return {
    name: "aos-mcp-app-sandbox",
    configureServer: (server) => secure(server, server.config.publicDir),
    configurePreviewServer: (server) =>
      secure(
        server,
        path.resolve(server.config.root, server.config.build.outDir)
      ),
  }
}

/**
 * The real `aos-ui` server's answers, as JSON, from views built right now, its
 * artifact view on the fixture's stable origin, which a preview with stable
 * origins on frames it from and any other ignores. The view expects that
 * origin on `stablePort`, the port of the preview that turns stable origins on
 * (`AOS_UI_E2E_STABLE_ORIGINS_PORT`); without one it expects no port, which no
 * preview has, so it keeps Agent HTML storage in memory everywhere.
 */
async function recordToolsServer(stablePort: string | undefined) {
  const [views, pdfjs, grammars, maplibre] = await Promise.all([
    buildViews(),
    buildPdfjs(),
    buildGrammars(),
    buildMaplibre(),
  ])
  const domain = FIXTURE_ARTIFACT_VIEW_DOMAIN
  return JSON.stringify(
    await snapshotToolsServer(
      { views, pdfjs, grammars, maplibre },
      {
        artifactStableOrigin: {
          domain,
          host: stablePort ? `${domain}:${stablePort}` : domain,
        },
      }
    )
  )
}

/**
 * Fixture mode draws charts, maps and stats through the real `aos-ui` server:
 * its views are built and its `tools/list` and `resources/read` answers
 * recorded at `FIXTURE_AOS_UI_MCP_PATH`. The dev server records on first
 * request and again after a view or schema changes; the build writes the file
 * into `dist`, where preview and the web server serve it.
 */
function fixtureToolsServerPlugin(stablePort: string | undefined): Plugin {
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
            recorded ??= recordToolsServer(stablePort)
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
        source: await recordToolsServer(stablePort),
      })
    },
  }
}

/**
 * The build id is the entry chunk's content hash, which changes with every
 * chunk the page can load. The build writes it to `dist/build-id`, which the
 * web server adds to `/runtime-config.json`, and compiles it in as `__AOS_BUILD_ID__`;
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
 * `server/static.ts` serves to clients that accept them. It runs after
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
  const originsAt = deploymentOriginsAt(environment)
  const originsOf: DeploymentOriginsOf = (request) =>
    originsAt(request.socket.localPort)
  // Read once now, so a malformed setting stops the server and names itself;
  // the sandbox's name and the stable origins' domain, which no port changes,
  // join the allowed hosts.
  const origins = originsAt(DEV_SERVER_PORT)
  const stableDomain = stableOriginsOf(origins.mcpAppStableOrigins)?.domain
  const allowedHosts = (
    environment.AOS_UI_ALLOWED_HOSTS ??
    environment.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
  )
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean)
    .concat(
      new URL(origins.mcpAppSandboxOrigin).hostname,
      stableDomain === undefined ? [] : `.${stableDomain}`
    )
  // No default gateway: on a shared host the usual gateway port may be another
  // deployment's, so with the setting unset nothing is forwarded anywhere.
  const gatewayTarget = environment.AOS_UI_GATEWAY_TARGET || undefined
  const gatewayProxy =
    gatewayTarget === undefined
      ? undefined
      : {
          "/api/v1": {
            target: gatewayTarget,
            changeOrigin: false,
            ws: true,
            // No sandbox address, nor any host at or below the stable origins'
            // domain, reaches the gateway, WebSockets included.
            bypass: (request: IncomingMessage) =>
              sandboxAt(originsOf(request), request.headers.host ?? "") ===
              undefined
                ? undefined
                : false,
          },
        }

  return {
    cacheDir: path.resolve(
      import.meta.dirname,
      `node_modules/.vite-${cacheKey}`
    ),
    plugins: [
      // First, so the sandbox address answers nothing the others serve.
      mcpAppSandboxPlugin(originsOf),
      react(),
      reactCompiler(),
      runtimeConfigurationPlugin(environment, originsOf),
      e2eReadinessPlugin(environment),
      gatewayTargetNoticePlugin(gatewayTarget),
      fixtureToolsServerPlugin(environment.AOS_UI_E2E_STABLE_ORIGINS_PORT),
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
      },
    },
    optimizeDeps: {
      entries: ["index.html", "src/runtime-adapters/*/index.ts"],
      include: ["@base-ui/react/direction-provider", "@base-ui/react/select"],
    },
    server: {
      host: "127.0.0.1",
      port: DEV_SERVER_PORT,
      allowedHosts,
      proxy: gatewayProxy,
    },
    preview: {
      allowedHosts,
      proxy: gatewayProxy,
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
