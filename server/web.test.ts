// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  MCP_APP_SANDBOX_CSP,
  MCP_APP_SANDBOX_PATH,
} from "@harness-gw/sdk/protocol"

import { readWebServerConfig } from "./cli"
import { createWebApp } from "./web"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

/** A built app with a shell, the installable files, the sandbox page and a build id. */
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
  await writeFile(join(root, "build-id"), "build-2\n")
  const runtimeConfigFile = join(root, "runtime-config.json")
  await writeFile(runtimeConfigFile, '{"mode":"aos"}')
  const app = (surface: "operator" | "guest") =>
    createWebApp({ surface, root, runtimeConfigFile })
  return {
    root,
    runtimeConfigFile,
    operator: app("operator"),
    guest: app("guest"),
  }
}

const get = (app: (request: Request) => Promise<Response>, path: string) =>
  app(new Request(`https://aos.example.test${path}`))

describe("web server", () => {
  it("serves each surface's runtime configuration with the served build id", async () => {
    const { operator, guest } = await builtApp()

    const operatorConfig = await get(operator, "/runtime-config.json")
    expect(await operatorConfig.json()).toEqual({
      mode: "aos",
      buildId: "build-2",
    })
    expect(operatorConfig.headers.get("cache-control")).toBe("no-store")
    expect(await (await get(guest, "/runtime-config.json")).json()).toEqual({
      surface: "guest",
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

  it("serves the guest page under its own policy", async () => {
    const { guest, operator } = await builtApp()

    const document = await get(guest, "/")
    const policy = document.headers.get("content-security-policy")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("img-src 'self' https: data: blob:")
    // The guest page frames the MCP App sandbox proxy below.
    expect(policy).toContain("frame-src 'self'")
    expect(document.headers.get("referrer-policy")).toBe("no-referrer")
    expect(document.headers.get("x-frame-options")).toBe("DENY")
    expect(
      (await get(operator, "/")).headers.get("content-security-policy")
    ).toBeNull()
  })

  it("serves the MCP App sandbox page under its own policy on both surfaces", async () => {
    const { guest, operator } = await builtApp()

    for (const app of [guest, operator]) {
      const sandbox = await get(app, `${MCP_APP_SANDBOX_PATH}?allow=camera`)
      const policy = sandbox.headers.get("content-security-policy")
      expect(policy).toBe(MCP_APP_SANDBOX_CSP)
      expect(policy).toContain("script-src 'self'")
      expect(policy).toContain("frame-ancestors 'self'")
      expect(sandbox.headers.get("x-frame-options")).toBeNull()
    }
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
      const response = await get(guest, reserved)
      expect(response.status).toBe(404)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
    for (const installable of ["/sw.js", "/manifest.webmanifest"])
      expect((await get(operator, installable)).status).toBe(200)
  })
})

describe("web server settings", () => {
  const env =
    (values: Record<string, string>) =>
    (name: string): string | undefined =>
      values[name]

  it("listens on loopback, and adds the guest surface only when its port is set", () => {
    expect(readWebServerConfig(env({})).listeners).toEqual([
      { surface: "operator", host: "127.0.0.1", port: 3000 },
    ])
    expect(
      readWebServerConfig(env({ AOS_UI_GUEST_WEB_PORT: "3001" })).listeners
    ).toEqual([
      { surface: "operator", host: "127.0.0.1", port: 3000 },
      { surface: "guest", host: "127.0.0.1", port: 3001 },
    ])
  })

  it.each([
    [{ AOS_UI_WEB_HOST: "0.0.0.0" }, /AOS_UI_WEB_EXPOSURE=private-container/u],
    [
      { AOS_UI_GUEST_WEB_HOST: "::", AOS_UI_GUEST_WEB_PORT: "3001" },
      /AOS_UI_WEB_EXPOSURE=private-container/u,
    ],
    [{ AOS_UI_WEB_HOST: "192.0.2.10" }, /must be 127\.0\.0\.1/u],
    [{ AOS_UI_WEB_PORT: "0" }, /port between/u],
  ])("refuses %o", (values, message) => {
    expect(() => readWebServerConfig(env(values))).toThrow(message)
  })

  it("binds a wildcard host once the private container exposure is acknowledged", () => {
    expect(
      readWebServerConfig(
        env({
          AOS_UI_WEB_HOST: "0.0.0.0",
          AOS_UI_WEB_EXPOSURE: "private-container",
        })
      ).listeners
    ).toEqual([{ surface: "operator", host: "0.0.0.0", port: 3000 }])
  })
})
