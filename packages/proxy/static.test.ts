// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createStaticHandler } from "./static"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe("proxy static serving", () => {
  it("serves runtime config and Vite assets with an SPA fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await writeFile(join(root, "index.html"), "<html>shell</html>")
    await mkdir(join(root, "assets"))
    await writeFile(join(root, "assets", "app.js"), "console.log(1)")
    const runtimeConfig = join(root, "runtime-config.json")
    await writeFile(runtimeConfig, '{"mode":"aos"}')
    const fetch = createStaticHandler({ root, runtimeConfig })

    const config = await fetch(
      new Request("https://aos.example.test/runtime-config.json")
    )
    expect(config?.status).toBe(200)
    expect(await config?.text()).toBe('{"mode":"aos"}')
    expect(config?.headers.get("cache-control")).toBe("no-store")

    const asset = await fetch(
      new Request("https://aos.example.test/assets/app.js")
    )
    expect(asset?.status).toBe(200)
    expect(await asset?.text()).toBe("console.log(1)")
    expect(asset?.headers.get("cache-control")).toContain("immutable")

    const route = await fetch(new Request("https://aos.example.test/agent/a"))
    expect(route?.status).toBe(200)
    expect(await route?.text()).toBe("<html>shell</html>")
  })

  it("serves the installable shell's manifest and icons as themselves", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await writeFile(join(root, "manifest.webmanifest"), '{"name":"AOS"}')
    await mkdir(join(root, "icons"))
    await writeFile(join(root, "icons", "aos-192.png"), "png")
    const fetch = createStaticHandler({
      root,
      runtimeConfig: join(root, "runtime-config.json"),
    })

    const manifest = await fetch(
      new Request("https://aos.example.test/manifest.webmanifest")
    )
    expect(manifest?.headers.get("content-type")).toBe(
      "application/manifest+json; charset=UTF-8"
    )

    const icon = await fetch(
      new Request("https://aos.example.test/icons/aos-192.png")
    )
    expect(icon?.headers.get("content-type")).toBe("image/png")
  })

  it("leaves normalized APIs to Hono and rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await writeFile(join(root, "index.html"), "shell")
    const fetch = createStaticHandler({
      root,
      runtimeConfig: join(root, "runtime-config.json"),
    })

    expect(
      await fetch(new Request("https://aos.example.test/api/aos/v1/agents"))
    ).toBeUndefined()
    expect(
      await fetch(new Request("https://aos.example.test/%2e%2e%2fsecret"))
    ).toBeUndefined()
  })
})
