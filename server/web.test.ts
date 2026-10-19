// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { MCP_APP_SANDBOX_PATH } from "@harness-gw/sdk/protocol"

import type { DeploymentOrigins } from "../shared/lane-origins"
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
const OPERATOR_PAGES = [
  "https://aos.example.test",
  "https://aos.tail.example.test",
]
const GUEST_PAGES = ["https://guest.example.test"]
/** Every lane's pages, which may frame the sandbox page, and the sandbox. */
const ORIGINS: DeploymentOrigins = {
  publicOrigins: [...OPERATOR_PAGES, ...GUEST_PAGES],
  mcpAppSandboxOrigin: SANDBOX,
}
/**
 * The stable origins' wildcard, its domain itself on its port, and a stable
 * host's key label under it.
 */
const STABLE_ORIGINS = "https://*.mcp-apps.example.test:8443"
const STABLE_DOMAIN = "https://mcp-apps.example.test:8443"
const KEY = "0123456789abcdef0123456789abcdef"
const STABLE_ORIGIN = `https://${KEY}.mcp-apps.example.test:8443`

/**
 * A built app with a shell, the installable files, the sandbox page and its
 * script, and a build id, whose operator file names origins of its own; its
 * lanes have `ORIGINS` with what `overrides` names, by default no stable
 * origins.
 */
async function builtApp(overrides: Partial<DeploymentOrigins> = {}) {
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
      origins: { ...ORIGINS, ...overrides },
    }),
    guest: createWebApp({
      surface: "guest",
      root,
      runtimeConfigFile,
      origins: { ...ORIGINS, ...overrides },
    }),
  }
}

type WebApp = (request: Request) => Promise<Response>

/** A request to the app at `origin`, by default the operator lane's own. */
const get = (app: WebApp, path: string, origin = OPERATOR_PAGES[0]) =>
  app(new Request(`${origin}${path}`))

/** Every directive of `policy` named `name`. */
const directives = (policy: string | null, name: string) =>
  (policy ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.split(" ")[0] === name)

describe("web server", () => {
  it("serves each surface's runtime configuration with every lane's origins, the one sandbox origin, and the served build id", async () => {
    const { operator, guest } = await builtApp()

    const operatorConfig = await get(operator, "/runtime-config.json")
    expect(await operatorConfig.json()).toEqual({
      mode: "aos",
      ...ORIGINS,
      buildId: "build-2",
    })
    expect(operatorConfig.headers.get("cache-control")).toBe("no-store")
    expect(
      await (await get(guest, "/runtime-config.json", GUEST_PAGES[0])).json()
    ).toEqual({ surface: "guest", ...ORIGINS, buildId: "build-2" })
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

  it.each([
    ["the sandbox origin alone", {}, "frame-src https://sandbox.example.test"],
    [
      "the sandbox origin and the stable origins' wildcard",
      { mcpAppStableOrigins: STABLE_ORIGINS },
      `frame-src https://sandbox.example.test ${STABLE_ORIGINS}`,
    ],
  ] as const)(
    "serves each surface's page framing %s",
    async (_label, stable, frameSrc) => {
      const { guest, operator } = await builtApp(stable)

      const document = await get(guest, "/", GUEST_PAGES[0])
      const policy = document.headers.get("content-security-policy")
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).toContain("img-src 'self' https: data: blob:")
      expect(directives(policy, "frame-src")).toEqual([frameSrc])
      expect(document.headers.get("referrer-policy")).toBe("no-referrer")
      expect(document.headers.get("x-frame-options")).toBe("DENY")
      expect(
        (await get(operator, "/")).headers.get("content-security-policy")
      ).toBe(frameSrc)
    }
  )

  it.each(["operator", "guest"] as const)(
    "serves the sandbox address from the %s listener: the page under the view's own policy, which every lane's pages may frame, its script, and nothing else",
    async (surface) => {
      const app = (await builtApp())[surface]
      const sandbox = SANDBOX
      const page = sandboxPageUrl(SANDBOX, {
        allow: "camera",
        csp: { connectDomains: ["https://api.example.test"] },
      })
      // A view reads its files through its page, so a file a query names,
      // even on a lane's origin, is no source of the policy, and cannot end
      // it and widen who may frame it.
      const file = new URLSearchParams({
        file: `${GUEST_PAGES[0]}/report; frame-ancestors *`,
      })

      const response = await app(new Request(`${page}&${file}`))
      expect(response.status).toBe(200)
      const policy = response.headers.get("content-security-policy")
      const [connect] = directives(policy, "connect-src")
      expect(connect).toContain("https://api.example.test")
      expect(policy).not.toContain(`${GUEST_PAGES[0]}/report`)
      expect(directives(policy, "frame-ancestors")).toEqual([
        `frame-ancestors ${ORIGINS.publicOrigins.join(" ")}`,
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

  it.each(["operator", "guest"] as const)(
    "serves exactly a stable host from the %s listener as the sandbox address, under the policy for its own origin, beside the shared sandbox at their domain itself",
    async (surface) => {
      const app = (
        await builtApp({
          mcpAppSandboxOrigin: STABLE_DOMAIN,
          mcpAppStableOrigins: STABLE_ORIGINS,
        })
      )[surface]
      // A view may not reach its own sandbox origin; the shared one is just
      // another host to it.
      const csp = { connectDomains: [STABLE_ORIGIN, STABLE_DOMAIN] }
      const page = sandboxPageUrl(STABLE_ORIGIN, { allow: "", csp })

      const response = await app(new Request(page ?? ""))
      expect(response.status).toBe(200)
      const policy = response.headers.get("content-security-policy")
      expect(directives(policy, "connect-src")).toEqual([
        `connect-src ${STABLE_DOMAIN}`,
      ])
      expect(directives(policy, "frame-ancestors")).toEqual([
        `frame-ancestors ${ORIGINS.publicOrigins.join(" ")}`,
      ])
      expect(
        (await get(app, MCP_APP_SANDBOX_SCRIPT_PATH, STABLE_ORIGIN)).status
      ).toBe(200)
      for (const path of ["/", "/api/v1/healthz", "/runtime-config.json"])
        expect((await get(app, path, STABLE_ORIGIN)).status).toBe(404)
      // The domain itself is the shared sandbox there, never a near miss.
      expect((await get(app, MCP_APP_SANDBOX_PATH, STABLE_DOMAIN)).status).toBe(
        200
      )
    }
  )

  it.each([
    ["a 31-digit key", `https://${KEY.slice(1)}.mcp-apps.example.test:8443`],
    ["a 33-digit key", `https://${KEY}0.mcp-apps.example.test:8443`],
    [
      "a label that is not hex",
      `https://${"g".repeat(32)}.mcp-apps.example.test:8443`,
    ],
    ["an extra label", `https://${KEY}.extra.mcp-apps.example.test:8443`],
    ["another port", `https://${KEY}.mcp-apps.example.test:9443`],
    ["no port", `https://${KEY}.mcp-apps.example.test`],
    ["the domain itself", STABLE_DOMAIN],
  ])(
    "refuses every path on %s below the stable origins",
    async (_label, origin) => {
      const { operator } = await builtApp({
        mcpAppStableOrigins: STABLE_ORIGINS,
      })

      for (const path of [MCP_APP_SANDBOX_PATH, "/", "/runtime-config.json"])
        expect((await get(operator, path, origin)).status).toBe(404)
    }
  )

  it("serves neither sandbox file on a lane's own addresses, however its path is spelled, nor any path naming one, but serves a file named only like them", async () => {
    const { guest, operator, root } = await builtApp()

    for (const [app, pages] of [
      [operator, OPERATOR_PAGES],
      [guest, GUEST_PAGES],
    ] as const)
      for (const origin of pages)
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
      const response = await get(guest, reserved, GUEST_PAGES[0])
      expect(response.status).toBe(404)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
    for (const installable of ["/sw.js", "/manifest.webmanifest"])
      expect((await get(operator, installable)).status).toBe(200)
  })
})

describe("web server settings", () => {
  const OPERATOR_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]
  const GUEST_ORIGINS = ["http://localhost:3001", "http://127.0.0.1:3001"]
  const LANES = [...OPERATOR_ORIGINS, ...GUEST_ORIGINS]
  /** The operator's loopback origins and sandbox, as Compose defaults them. */
  const OPERATOR_LANE = {
    AOS_UI_PUBLIC_ORIGIN: OPERATOR_ORIGINS.join(","),
    AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.localhost:3002",
  }
  /** Both lanes' loopback origins, as a harness overlay defaults them. */
  const BOTH_LANES = { ...OPERATOR_LANE, AOS_UI_PUBLIC_ORIGIN: LANES.join(",") }
  const env =
    (values: Record<string, string | undefined>) =>
    (name: string): string | undefined =>
      values[name]

  it("listens on loopback, and adds the guest surface only when its port is set, both on every origin the one list names", () => {
    const operator = readWebServerConfig(env(OPERATOR_LANE))
    expect(operator.listeners).toEqual([
      { surface: "operator", host: "127.0.0.1", port: 3000 },
    ])
    expect(operator.origins).toEqual({
      publicOrigins: OPERATOR_ORIGINS,
      mcpAppSandboxOrigin: "http://sandbox.localhost:3002",
    })
    const both = readWebServerConfig(
      env({ ...BOTH_LANES, AOS_UI_GUEST_WEB_PORT: "3001" })
    )
    expect(both.listeners).toEqual([
      { surface: "operator", host: "127.0.0.1", port: 3000 },
      { surface: "guest", host: "127.0.0.1", port: 3001 },
    ])
    expect(both.origins.publicOrigins).toEqual(LANES)
  })

  it("leaves the guest surface off when its port is empty, as the operator-only overlay leaves it", () => {
    const config = readWebServerConfig(
      env({
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://aos-sandbox.example",
        AOS_UI_GUEST_WEB_PORT: "",
      })
    )
    expect(config.listeners.map(({ surface }) => surface)).toEqual(["operator"])
  })

  it("gives every listener the one sandbox and the one list of origins, whose pages any of them lets frame the sandbox page", async () => {
    const { root, runtimeConfigFile } = await builtApp()
    const apps: WebApp[] = []
    startWebServer(
      readWebServerConfig(
        env({
          ...BOTH_LANES,
          AOS_UI_GUEST_WEB_PORT: "3001",
          AOS_UI_STATIC_ROOT: root,
          AOS_UI_RUNTIME_CONFIG_FILE: runtimeConfigFile,
        })
      ),
      ({ fetch }) => {
        apps.push(fetch)
        return { stop() {} }
      }
    )

    expect(apps).toHaveLength(2)
    for (const app of apps) {
      // The pages the header lets frame the sandbox are the ones each
      // surface's views report their policy for.
      const config = await get(app, "/runtime-config.json")
      expect(await config.json()).toMatchObject({
        publicOrigins: LANES,
        mcpAppSandboxOrigin: "http://sandbox.localhost:3002",
      })
      const page = await get(
        app,
        MCP_APP_SANDBOX_PATH,
        "http://sandbox.localhost:3002"
      )
      expect(
        directives(
          page.headers.get("content-security-policy"),
          "frame-ancestors"
        )
      ).toEqual([`frame-ancestors ${LANES.join(" ")}`])
    }
  })

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
    // Every origin listed, not only the first.
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://127.0.0.1:3000" },
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
      { AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN is a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists https:\/\/aos\.example\.test, which is not$/u,
    ],
    [
      { AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test" },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN is not a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists http:\/\/localhost:3000, which is$/u,
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
    // Every origin listed, not only the first.
    [
      {
        AOS_UI_PUBLIC_ORIGIN:
          "http://aos.example.test,https://guest.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.example.test",
      },
      /^AOS_UI_MCP_APP_SANDBOX_ORIGIN must be https:, since AOS_UI_PUBLIC_ORIGIN lists https:\/\/guest\.example\.test/u,
    ],
    // The stable origins name one wildcard origin whose stable hosts a view's
    // domain can name.
    ...[
      "http://mcp-apps.localhost:3000",
      "http://*.mcp-apps.localhost:3000/",
      "http://*.*.mcp-apps.localhost:3000",
      "http://*.mcp-apps.localhost:3000,http://*.other.localhost:3000",
      "ws://*.mcp-apps.localhost:3000",
      "http://*.mcp-apps.localhost:80",
      "http://*.mcp-apps.localhost:65536",
      "http://*.mcp-apps.local_host:3000",
      // Too long for a key label below it: 286 characters to a domain's 253.
      `http://*.${Array(4).fill("a".repeat(60)).join(".")}.localhost:3000`,
    ].map((value): [Record<string, string>, RegExp] => [
      { AOS_UI_MCP_APP_STABLE_ORIGINS: value },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS: .* is not a wildcard origin/u,
    ]),
    // No page's host is at or below their domain, and no sandbox host below it.
    [
      { AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.localhost:3000" },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS must name a domain that no origin in AOS_UI_PUBLIC_ORIGIN is at or below, but http:\/\/localhost:3000 is$/u,
    ],
    // Every origin listed, not only the first.
    [
      {
        AOS_UI_PUBLIC_ORIGIN:
          "http://localhost:3000,http://guest.mcp-apps.localhost:3001",
        AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.mcp-apps.localhost:3000",
      },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS must name a domain that no origin in AOS_UI_PUBLIC_ORIGIN is at or below, but http:\/\/guest\.mcp-apps\.localhost:3001 is$/u,
    ],
    [
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test",
        AOS_UI_MCP_APP_STABLE_ORIGINS: "https://*.example.test:8443",
      },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS must name a domain that no origin in AOS_UI_PUBLIC_ORIGIN is at or below, but https:\/\/aos\.example\.test is$/u,
    ],
    [
      {
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "http://sandbox.mcp-apps.localhost:3002",
        AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.mcp-apps.localhost:3002",
      },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS must name a domain that AOS_UI_MCP_APP_SANDBOX_ORIGIN is not below, but http:\/\/sandbox\.mcp-apps\.localhost:3002 is$/u,
    ],
    [
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test",
        AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.mcp-apps.example.test",
      },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS must be https:, since AOS_UI_PUBLIC_ORIGIN lists https:\/\/aos\.example\.test/u,
    ],
    [
      { AOS_UI_MCP_APP_STABLE_ORIGINS: "https://*.mcp-apps.example.test" },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS is not a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists http:\/\/localhost:3000, which is$/u,
    ],
    [
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test",
        AOS_UI_MCP_APP_STABLE_ORIGINS: "https://*.mcp-apps.localhost",
      },
      /^AOS_UI_MCP_APP_STABLE_ORIGINS is a loopback origin, but AOS_UI_PUBLIC_ORIGIN lists https:\/\/aos\.example\.test, which is not$/u,
    ],
  ])("refuses %o", (values, message) => {
    expect(() =>
      readWebServerConfig(env({ ...OPERATOR_LANE, ...values }))
    ).toThrow(message)
  })

  it("reads an https lane whose sandbox is the lane's name on another port", () => {
    expect(
      readWebServerConfig(
        env({
          AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
          AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://aos.example.test:8443",
        })
      ).origins
    ).toEqual({
      publicOrigins: ["https://aos.example.test"],
      mcpAppSandboxOrigin: "https://aos.example.test:8443",
    })
  })

  it.each([
    [
      "lowercased, on its own port",
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test",
        AOS_UI_MCP_APP_STABLE_ORIGINS: " HTTPS://*.MCP-Apps.Example.test:8443 ",
      },
      "https://*.mcp-apps.example.test:8443",
    ],
    [
      "on the default port",
      {
        AOS_UI_PUBLIC_ORIGIN: "https://aos.example.test",
        AOS_UI_MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.test",
        AOS_UI_MCP_APP_STABLE_ORIGINS: "https://*.mcp-apps.example.test",
      },
      "https://*.mcp-apps.example.test",
    ],
    [
      "below localhost beside loopback lanes",
      {
        ...OPERATOR_LANE,
        AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.mcp-apps.localhost:3000",
      },
      "http://*.mcp-apps.localhost:3000",
    ],
    [
      "at the sandbox's own name, on another port",
      {
        ...OPERATOR_LANE,
        AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.sandbox.localhost:3005",
      },
      "http://*.sandbox.localhost:3005",
    ],
    [
      "unset as empty, as Compose leaves it",
      { ...OPERATOR_LANE, AOS_UI_MCP_APP_STABLE_ORIGINS: "" },
      undefined,
    ],
  ])("reads the stable origins %s", (_label, values, stable) => {
    expect(readWebServerConfig(env(values)).origins.mcpAppStableOrigins).toBe(
      stable
    )
  })

  it.each([
    [
      "set",
      "http://*.mcp-apps.localhost:3000",
      expect.objectContaining({
        mcpAppStableOrigins: "http://*.mcp-apps.localhost:3000",
      }),
      200,
      404,
    ],
    [
      "unset",
      undefined,
      expect.not.objectContaining({ mcpAppStableOrigins: expect.anything() }),
      404,
      200,
    ],
  ] as const)(
    "with the stable origins %s, every listener reports them over any its file names, and serves a stable host as one or as a lane's",
    async (_label, stable, reported, sandboxPage, shell) => {
      const { root, runtimeConfigFile } = await builtApp()
      await writeFile(
        runtimeConfigFile,
        JSON.stringify({
          mode: "aos",
          mcpAppStableOrigins: "https://*.configured.example.test",
        })
      )
      const apps: WebApp[] = []
      startWebServer(
        readWebServerConfig(
          env({
            ...BOTH_LANES,
            AOS_UI_GUEST_WEB_PORT: "3001",
            AOS_UI_MCP_APP_STABLE_ORIGINS: stable,
            AOS_UI_STATIC_ROOT: root,
            AOS_UI_RUNTIME_CONFIG_FILE: runtimeConfigFile,
          })
        ),
        ({ fetch }) => {
          apps.push(fetch)
          return { stop() {} }
        }
      )

      const host = `http://${KEY}.mcp-apps.localhost:3000`
      for (const app of apps) {
        expect(await (await get(app, "/runtime-config.json")).json()).toEqual(
          reported
        )
        expect((await get(app, MCP_APP_SANDBOX_PATH, host)).status).toBe(
          sandboxPage
        )
        expect((await get(app, "/", host)).status).toBe(shell)
      }
    }
  )

  it("binds a wildcard host once the private container exposure is acknowledged", () => {
    expect(
      readWebServerConfig(
        env({
          ...OPERATOR_LANE,
          AOS_UI_WEB_HOST: "0.0.0.0",
          AOS_UI_WEB_EXPOSURE: "private-container",
        })
      ).listeners
    ).toEqual([{ surface: "operator", host: "0.0.0.0", port: 3000 }])
  })
})
