// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let child: ChildProcess
let origin: string
/** Stand-in documents, so the test never reads a stale build. */
const views = mkdtempSync(join(tmpdir(), "aos-ui-views-"))

function start(directory: string) {
  return spawn(
    "bun",
    [
      "run",
      join(import.meta.dirname, "cli.ts"),
      "--http",
      "--port",
      "0",
      "--views",
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
}

beforeAll(async () => {
  for (const name of ["chart", "map", "stats"])
    writeFileSync(join(views, `${name}.html`), `<title>${name}</title>`)
  child = start(views)
  const lines = createInterface({ input: child.stdout! })
  const [line] = (await Promise.race([
    once(lines, "line"),
    once(child, "exit").then(([code]) => {
      throw new Error(`tools-mcp exited with ${code} before listening`)
    }),
  ])) as [string]
  origin = new URL(line.match(/https?:\/\/\S+/u)![0]).origin
})

afterAll(() => {
  child.kill()
  rmSync(views, { recursive: true, force: true })
})

describe("tools-mcp HTTP entry", () => {
  it("answers the health check", async () => {
    const response = await fetch(`${origin}/health`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  it("serves tools over stateless Streamable HTTP", async () => {
    const client = new Client({ name: "tools-mcp-cli-test", version: "0.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`))
    )

    const { tools } = await client.listTools()
    const result = await client.callTool({
      name: "present_artifact",
      arguments: { path: "/workspace/report.pdf" },
    })
    const { contents } = await client.readResource({
      uri: "ui://aos-ui/map",
    })
    await client.close()

    expect(contents[0]).toMatchObject({ text: "<title>map</title>" })
    expect(tools).toHaveLength(4)
    expect(result.structuredContent).toEqual({
      ok: true,
      type: "aos.artifact",
      artifact: { path: "/workspace/report.pdf", filename: "report.pdf" },
    })
  })

  it("refuses to start without the built views", async () => {
    const empty = mkdtempSync(join(tmpdir(), "aos-ui-no-views-"))
    const missing = start(empty)
    let stderr = ""
    missing.stderr!.on("data", (chunk: Buffer) => (stderr += String(chunk)))
    const [code] = (await once(missing, "exit")) as [number]
    rmSync(empty, { recursive: true, force: true })

    expect(code).toBe(1)
    expect(stderr).toContain("bun run tools-mcp:build")
  })
})
