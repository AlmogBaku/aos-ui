// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  FIXTURE_MCP_APP_FILES,
  FIXTURE_MCP_APP_FILES_PATH,
} from "../shared/presentation/views"
import { createStaticHandler } from "./static"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe("static serving", () => {
  it("serves Vite assets with an SPA fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await writeFile(join(root, "index.html"), "<html>shell</html>")
    await mkdir(join(root, "assets"))
    await writeFile(join(root, "assets", "app.js"), "console.log(1)")
    const fetch = createStaticHandler({ root })

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

  it("serves a precompressed copy the client accepts and the raw file otherwise", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await mkdir(join(root, "assets"))
    await writeFile(join(root, "assets", "app.js"), "raw")
    await writeFile(join(root, "assets", "app.js.br"), "brotli")
    await writeFile(join(root, "assets", "app.js.gz"), "gzipped")
    await writeFile(join(root, "assets", "only.js"), "uncompressed")
    const fetch = createStaticHandler({
      root,
    })
    const get = (path: string, acceptEncoding?: string, method = "GET") =>
      fetch(
        new Request(`https://aos.example.test${path}`, {
          method,
          headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
        })
      )

    const brotli = await get("/assets/app.js", "gzip, deflate, br, zstd")
    expect(brotli?.headers.get("content-encoding")).toBe("br")
    expect(brotli?.headers.get("content-type")).toBe(
      "application/javascript; charset=UTF-8"
    )
    expect(brotli?.headers.get("content-length")).toBe("6")
    expect(brotli?.headers.get("vary")).toBe("Accept-Encoding")
    expect(await brotli?.text()).toBe("brotli")

    const gzip = await get("/assets/app.js", "gzip")
    expect(gzip?.headers.get("content-encoding")).toBe("gzip")
    expect(await gzip?.text()).toBe("gzipped")

    const refused = await get("/assets/app.js", "br;q=0, gzip")
    expect(refused?.headers.get("content-encoding")).toBe("gzip")

    const raw = await get("/assets/app.js")
    expect(raw?.headers.get("content-encoding")).toBeNull()
    expect(raw?.headers.get("vary")).toBe("Accept-Encoding")
    expect(await raw?.text()).toBe("raw")

    const missing = await get("/assets/only.js", "br, gzip")
    expect(missing?.headers.get("content-encoding")).toBeNull()
    expect(await missing?.text()).toBe("uncompressed")

    const head = await get("/assets/app.js", "br", "HEAD")
    expect(head?.headers.get("content-encoding")).toBe("br")
    expect(head?.headers.get("content-length")).toBe("6")
    expect(await head?.text()).toBe("")
  })

  it("adds Access-Control-Allow-Origin: null only to fixture MCP App file paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await mkdir(join(root, "fixture", "mcp-app-files"), { recursive: true })
    const pdfPath = `${FIXTURE_MCP_APP_FILES_PATH}/${FIXTURE_MCP_APP_FILES.pdf}`
    await writeFile(join(root, pdfPath), "fake pdf")
    await writeFile(
      join(root, "fixture", "mcp-app-files", "other.pdf"),
      "not a fixture file"
    )
    await writeFile(join(root, "index.html"), "<html>shell</html>")
    const fetch = createStaticHandler({
      root,
    })

    // Exact fixture file path carries the header.
    const pdfResp = await fetch(
      new Request(`https://aos.example.test${pdfPath}`)
    )
    expect(pdfResp?.headers.get("access-control-allow-origin")).toBe("null")
    expect(pdfResp?.headers.has("access-control-allow-credentials")).toBe(false)

    // A neighbor path that is not one of the three file names does not.
    const other = await fetch(
      new Request(
        `https://aos.example.test${FIXTURE_MCP_APP_FILES_PATH}/other.pdf`
      )
    )
    expect(other?.headers.get("access-control-allow-origin")).toBeNull()

    // The SPA shell does not carry the header.
    const shell = await fetch(
      new Request("https://aos.example.test/index.html")
    )
    expect(shell?.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "aos-static-"))
    directories.push(root)
    await writeFile(join(root, "index.html"), "shell")
    const fetch = createStaticHandler({
      root,
    })

    expect(
      await fetch(new Request("https://aos.example.test/%2e%2e%2fsecret"))
    ).toBeUndefined()
  })
})
