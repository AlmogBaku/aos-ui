// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { MCP_APP_SANDBOX_PATH } from "@harness-gw/sdk/protocol"

import type { LaneOrigins } from "../shared/lane-origins"
import {
  MCP_APP_SANDBOX_SCRIPT_PATH,
  sandboxPageUrl,
} from "../shared/mcp-app-sandbox"
import { readWebServerConfig, startWebServer } from "./cli"
import { createWebApp } from "./web"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

/** The one sandbox both lanes' views load from. */
const SANDBOX = "https://sandbox.example.test"
const OPERATOR: LaneOrigins = {
  publicOrigins: ["https://aos.example.test", "https://aos.tail.example.test"],
  mcpAppSandboxOrigin: SANDBOX,
}
const GUEST: LaneOrigins = {
  publicOrigins: ["https://guest.example.test"],
  mcpAppSandboxOrigin: SANDBOX,
}
/** Every lane's pages, which may frame the sandbox page. */
const LANE_ORIGINS = [...OPERATOR.publicOrigins, ...GUEST.publicOrigins]

/**
 * A built app with a shell, the installable files, the sandbox page and its
 * script, and a build id, whose operator file names origins of its own.
 */
async function builtApp() {
  const root = await mkdtemp(join(tmpdir(), "aos-web-"))
  directories.push(root)
  await writeFile(join(root, "index.html"), "<html>shell</html>")
  await writeFile(join(root, "sw.js"), "self")
  await writeFile(join(root, "manifest.webmanifest"), "{}")
  await writeFile(
    join(root, MCP_APP_SANDBOX_PATH.slice(1)),
    "<html>relay</html>"
  )
  await writeFile(join(root, MCP_APP_SANDBOX_SCRIPT_PATH.slice(1)), "relay")
  await writeFile(join(root, "build-id"), "build-2\n")
  const runtimeConfigFile = join(root, "runtime-config.json")
  await writeFile(
    runtimeConfigFile,
    JSON.stringify({
      mode: "aos",
      publicOrigins: ["https://configured.example.test"],
      mcpAppSandboxOrigin: "https://configured-sandbox.example.test",
    })
  )
  return {
    root,
    runtimeConfigFile,
    operator: createWebApp({
      surface: "operator",
      root,
      runtimeConfigFile,
      origins: OPERATOR,
      frameAncestors: LANE_ORIGINS,
    }),
    guest: createWebApp({
      surface: "guest",
      root,
      runtimeConfigFile,
      origins: GUEST,
      frameAncestors: LANE_ORIGINS,
    }),
  }
}

type WebApp = (request: Request) => Promise<Response>

/** A request to the app at `origin`, by default the operator lane's own. */
const get = (app: WebApp, path: string, origin = OPERATOR.publicOrigins[0]) =>
  app(new Request(`${origin}${path}`))

/** Every directive of `policy` named `name`. */
const directives = (policy: string | null, name: string) =>
  (policy ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.split(" ")[0] === name)

describe("web server", () => {
  it("serves each surface's runtime configuration with its own lane's origins, the one sandbox origin, and the served build id", async () => {
    const { operator, guest } = await builtApp()

    const operatorConfig = await get(operator, "/runtime-config.json")
    expect(await operatorConfig.json()).toEqual({
      mode: "aos",
      publicOrigins: OPERATOR.publicOrigins,
      mcpAppSandboxOrigin: SANDBOX,
      buildId: "build-2",
    })
    expect(operatorConfig.headers.get("cache-control")).toBe("no-store")
    expect(
      await (
        await get(guest, "/runtime-config.json", GUEST.publicOrigins[0])
      ).json()
    ).toEqual({
      surface: "guest",
      publicOrigins: GUEST.publicOrigins,
      mcpAppSandboxOrigin: SANDBOX,
      buildId: "build-2",
    })
  })

  it("answers 503 while the operator configuration is missing", async () => {
    const { operator, runtimeConfigFile } = await builtApp()
    await rm(runtimeConfigFile)

    const response = await get(operator, "/runtime-config.json")
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("leaves every API path to the gateway", async () => {
    const { operator, guest } = await builtApp()

    for (const app of [operator, guest]) {
      expect((await get(app, "/api/v1/agents")).status).toBe(404)
      expect((await get(app, "/healthz")).status).toBe(200)
    }
  })

  it("serves each surface's page framing the sandbox origin alone", async () => {
    const { guest, operator } = await builtApp()

    const document = await get(guest, "/", GUEST.publicOrigins[0])
    const policy = document.headers.get("content-security-policy")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("img-src 'self' https: data: blob:")
    expect(directives(policy, "frame-src")).toEqual([
      "frame-src https://sandbox.example.test",
    ])
    expect(document.headers.get("referrer-policy")).toBe("no-referrer")
    expect(document.headers.get("x-frame-options")).toBe("DENY")
    expect(
      (await get(operator, "/")).headers.get("content-security-policy")
    ).toBe("frame-src https://sandbox.example.test")
  })

  it.each(["operator", "guest"] as const)(
    "serves the sandbox address from the %s listener: the page under the view's own policy, which every lane's pages may frame, its script, and nothing else",
    async (surface) => {
      const app = (await builtApp())[surface]
      const sandbox = SANDBOX
      const page = sandboxPageUrl(OPERATOR, {
        allow: "camera",
        csp: { connectDomains: ["https://api.example.test"] },
        // A file on any lane's origin is the view's to read, and a location
        // cannot end the policy and widen who may frame it.
        fileLocations: [`${GUEST.publicOrigins[0]}/report; frame-ancestors *`],
      })

      const response = await app(new Request(page ?? ""))
      expect(response.status).toBe(200)
      const policy = response.headers.get("content-security-policy")
      const [connect] = directives(policy, "connect-src")
      expect(connect).toContain("https://api.example.test")
      expect(connect).toContain("https://guest.example.test/report")
      expect(directives(policy, "frame-ancestors")).toEqual([
        `frame-ancestors ${LANE_ORIGINS.join(" ")}`,
      ])
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-frame-options")).toBeNull()
      expect(
        (await get(app, MCP_APP_SANDBOX_SCRIPT_PATH, sandbox)).status
      ).toBe(200)
      // `worker-src 'self'` names this origin, so it serves no worker script.
      expect(
        (
          await app(
            new Request(`${sandbox}${MCP_APP_SANDBOX_SCRIPT_PATH}`, {
              headers: { "service-worker": "script" },
            })
          )
        ).status
      ).toBe(404)
      for (const path of [
        "/",
        "/api/v1/healthz",
        "/runtime-config.json",
        "/sw.js",
        "/healthz",
      ])
        expect((await get(app, path, sandbox)).status).toBe(404)
    }
  )

  it("serves neither sandbox file on a lane's own addresses, however its path is spelled, nor any path naming one, but serves a file named only like them", async () => {
    const { guest, operator, root } = await builtApp()

    for (const [app, lane] of [
      [operator, OPERATOR],
      [guest, GUEST],
    ] as const)
      for (const origin of lane.publicOrigins)
        for (const path of [
          MCP_APP_SANDBOX_PATH,
          `/${MCP_APP_SANDBOX_PATH}`,
          "/mcp-app-sandbox%2Ehtml",
          `${MCP_APP_SANDBOX_PATH}/`,
          // Resolves to the page, though its last segment names nothing.
          `${MCP_APP_SANDBOX_PATH}%2F.`,
          MCP_APP_SANDBOX_SCRIPT_PATH,
          // Paths a server may rewrite to a sandbox file.
          "/mcp-app-sandbox",
          "/MCP-App-Sandbox",
          "/%6Dcp-app-sandbox",
          "/mcp-app-sandbox/",
          "/public/mcp-app-sandbox.html",
          "/@fs/app/public/mcp-app-sandbox.js",
        ])
          expect((await get(app, path, origin)).status).toBe(404)

    // A chunk built from the sandbox's shared module is the lane's own.
    await mkdir(join(root, "assets"))
    await writeFile(join(root, "assets", "mcp-app-sandbox-abc123.js"), "chunk")
    const chunk = await get(operator, "/assets/mcp-app-sandbox-abc123.js")
    expect(chunk.status).toBe(200)
    expect(await chunk.text()).toBe("chunk")
  })

  it("keeps the operator's installable shell off the guest surface", async () => {
    const { guest, operator } = await builtApp()

    for (const reserved of [
      "/auth",
      "/auth/callback",
      // A guest installs no workspace and registers no service worker, and an
      // encoded path reaches the same file the static handler would decode.
      "/sw.js",
      "/sw%2Ejs",
      "/manifest.webmanifest",
    ]) {
      const response = await get(guest, reserved, GUEST.publicOrigins[0])
      expect(response.status).toBe(404)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
    for (const installable of ["/sw.js", "/manifest.webmanifest"])
      expect((await get(operator, installable)).status).toBe(200)
  })
})

describe("web server settings", () => {
  /** Each lane's loopback origins and the one sandbox, as Compose defaults them. */
  const OPERATOR_LANE = {
    AOS_UI_PUBLIC_ORIGIN: "http://localhost:3000,http://127.0.0.1:3000",
    AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.localhost:3000",
  }
  const GUEST_LANE = {
    AOS_UI_GUEST_PUBLIC_ORIGIN: "http://localhost:3001,http://127.0.0.1:3001",
  }
  const operatorListener = {
    surface: "operator",
    host: "127.0.0.1",
    port: 3000,
    publicOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  }
  const env =
    (values: Record<string, string | undefined>) =>
    (name: string): string | undefined =>
      values[name]

  it("listens on loopback, and adds the guest surface and its lane only when its port is set, both lanes on the one sandbox", () => {
    const operatorOnly = readWebServerConfig(env(OPERATOR_LANE))
    expect(operatorOnly.listeners).toEqual([operatorListener])
    expect(operatorOnly.mcpAppSandboxOrigin).toBe(
      "http://sandbox.localhost:3000"
    )
    const both = readWebServerConfig(
      env({ ...OPERATOR_LANE, ...GUEST_LANE, AOS_UI_GUEST_WEB_PORT: "3001" })
    )
    expect(both.listeners).toEqual([
      operatorListener,
      {
        surface: "guest",
        host: "127.0.0.1",
        port: 3001,
        publicOrigins: ["http://localhost:3001", "http://127.0.0.1:3001"],
      },
    ])
    expect(both.mcpAppSandboxOrigin).toBe("http://sandbox.localhost:3000")
  })

  it.each([
    ["on", { AOS_UI_GUEST_WEB_PORT: "3001" }, 2],
    ["off", {}, 1],
  ] as const)(
    "gives every listener the one sandbox, whose page any of them serves for every lane's pages to frame, the guest's with its listener %s",
    async (_label, guest, listeners) => {
      const { root, runtimeConfigFile } = await builtApp()
      const apps: WebApp[] = []
      startWebServer(
        readWebServerConfig(
          env({
            ...OPERATOR_LANE,
            ...GUEST_LANE,
            ...guest,
            AOS_UI_STATIC_ROOT: root,
            AOS_UI_RUNTIME_CONFIG_FILE: runtimeConfigFile,
          })
        ),
        ({ fetch }) => {
          apps.push(fetch)
          return { stop() {} }
        }
      )

      expect(apps).toHaveLength(listeners)
      for (const app of apps) {
        const config = await get(app, "/runtime-config.json")
        expect(await config.json()).toMatchObject({
          mcpAppSandboxOrigin: "http://sandbox.localhost:3000",
        })
        const page = await get(
          app,
          MCP_APP_SANDBOX_PATH,
          "http://sandbox.localhost:3000"
        )
        expect(
          directives(
            page.headers.get("content-security-policy"),
            "frame-ancestors"
          )
        ).toEqual([
          `frame-ancestors http://localhost:3000 http://127.0.0.1:3000${
            listeners === 2
              ? " http://localhost:3001 http://127.0.0.1:3001"
              : ""
          }`,
        ])
      }
    }
  )

  it.each([
    [{ AOS_UI_WEB_HOST: "0.0.0.0" }, /AOS_UI_WEB_EXPOSURE=private-container/u],
    [
      { AOS_UI_GUEST_WEB_HOST: "::", AOS_UI_GUEST_WEB_PORT: "3001" },
      /AOS_UI_WEB_EXPOSURE=private-container/u,
    ],
    [{ AOS_UI_WEB_HOST: "192.0.2.10" }, /must be 127\.0\.0\.1/u],
    [{ AOS_UI_WEB_PORT: "0" }, /port between/u],
    [{ AOS_UI_PUBLIC_ORIGIN: undefined }, /^AOS_UI_PUBLIC_ORIGIN must list/u],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: undefined },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must name/u,
    ],
    [
      { AOS_UI_PUBLIC_ORIGIN: "http://localhost:3000/" },
      /^AOS_UI_PUBLIC_ORIGIN: http:\/\/localhost:3000\/ is not an exact origin/u,
    ],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.localhost:3000; *" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN: .* is not an exact origin/u,
    ],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://localhost:3000" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must differ in host and port from every origin in AOS_UI_PUBLIC_ORIGIN$/u,
    ],
    // Routing tells origins apart by host and port alone.
    [
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://aos.example.test",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must differ in host and port from every origin in AOS_UI_PUBLIC_ORIGIN$/u,
    ],
    [
      {
        AOS_UI_GUEST_WEB_PORT: "3001",
        AOS_UI_GUEST_PUBLIC_ORIGIN:
          "http://localhost:3001,https://sandbox.localhost:3000",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must differ in host and port from every origin in AOS_UI_GUEST_PUBLIC_ORIGIN$/u,
    ],
    [
      { AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN is a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists https:\/\/aos\.example\.test, which is not$/u,
    ],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN is not a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists http:\/\/localhost:3000, which is$/u,
    ],
    [
      {
        AOS_UI_GUEST_WEB_PORT: "3001",
        AOS_UI_GUEST_PUBLIC_ORIGIN: "https://guest.example.test",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN is a loopback origin, but AOS_UI_GUEST_PUBLIC_ORIGIN lists https:\/\/guest\.example\.test, which is not$/u,
    ],
    [
      {
        AOS_UI_PUBLIC_ORIGIN:
          "http://localhost:3000,http://127.evil.example.test:3000",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN is a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists http:\/\/127\.evil\.example\.test:3000, which is not$/u,
    ],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://127.0.0.1:3005" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must be a name below localhost/u,
    ],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://localhost:3005" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must be a name below localhost/u,
    ],
    [
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.example.test",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must be https:, since AOS_UI_PUBLIC_ORIGIN lists https:\/\/aos\.example\.test/u,
    ],
    [
      {
        AOS_UI_PUBLIC_ORIGIN: "http://aos.example.test",
        AOS_UI_GUEST_WEB_PORT: "3001",
        AOS_UI_GUEST_PUBLIC_ORIGIN: "https://guest.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.example.test",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must be https:, since AOS_UI_GUEST_PUBLIC_ORIGIN lists https:\/\/guest\.example\.test/u,
    ],
    [
      { AOS_UI_GUEST_WEB_PORT: "3001", AOS_UI_GUEST_PUBLIC_ORIGIN: undefined },
      /^AOS_UI_GUEST_PUBLIC_ORIGIN must list/u,
    ],
    [
      {
        AOS_UI_GUEST_WEB_PORT: "3001",
        AOS_UI_GUEST_PUBLIC_ORIGIN:
          "http://localhost:3001,http://localhost:3000",
      },
      /^http:\/\/localhost:3000 is in both AOS_UI_PUBLIC_ORIGIN and AOS_UI_GUEST_PUBLIC_ORIGIN$/u,
    ],
  ])("refuses %o", (values, message) => {
    expect(() =>
      readWebServerConfig(env({ ...OPERATOR_LANE, ...GUEST_LANE, ...values }))
    ).toThrow(message)
  })

  it("reads an https lane whose sandbox is the lane's name on another port", () => {
    const config = readWebServerConfig(
      env({
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://aos.example.test:8443",
      })
    )
    expect(config.listeners[0]?.publicOrigins).toEqual([
      "https://aos.example.test",
    ])
    expect(config.mcpAppSandboxOrigin).toBe("https://aos.example.test:8443")
  })

  it("binds a wildcard host once the private container exposure is acknowledged", () => {
    expect(
      readWebServerConfig(
        env({
          ...OPERATOR_LANE,
          AOS_UI_WEB_HOST: "0.0.0.0",
          AOS_UI_WEB_EXPOSURE: "private-container",
        })
      ).listeners
    ).toEqual([{ ...operatorListener, host: "0.0.0.0" }])
  })
})
