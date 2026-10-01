// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { presentationViewNames } from "../../shared/presentation/views"

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

function writeViews(directory: string) {
  for (const name of presentationViewNames)
    writeFileSync(join(directory, `${name}.html`), `<title>${name}</title>`)
}

function writePdfjs(directory: string) {
  mkdirSync(join(directory, "pdfjs/wasm"), { recursive: true })
  writeFileSync(join(directory, "pdfjs/pdf.worker.js"), "self.onmessage = null")
  writeFileSync(join(directory, "pdfjs/wasm/jbig2.wasm"), Uint8Array.of(0, 97))
}

beforeAll(async () => {
  writeViews(views)
  writePdfjs(views)
  mkdirSync(join(views, "grammars"))
  writeFileSync(join(views, "grammars/typescript.json"), "{}")
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
    const decoder = await client.readResource({
      uri: "ui://aos-ui/pdfjs/wasm/jbig2.wasm",
    })
    await client.close()

    expect(contents[0]).toMatchObject({ text: "<title>map</title>" })
    expect(decoder.contents[0]).toMatchObject({ blob: "AGE=" })
    expect(tools).toHaveLength(4)
    expect(result.structuredContent).toMatchObject({
      value: { filename: "report.pdf" },
    })
  })

  it.each([
    ["the built views", () => undefined],
    ["pdf.js's files", writeViews],
    [
      "the grammars",
      (directory: string) => {
        writeViews(directory)
        writePdfjs(directory)
      },
    ],
  ])("refuses to start without %s", async (_missing, prepare) => {
    const directory = mkdtempSync(join(tmpdir(), "aos-ui-no-views-"))
    prepare(directory)
    const missing = start(directory)
    let stderr = ""
    missing.stderr!.on("data", (chunk: Buffer) => (stderr += String(chunk)))
    const [code] = (await once(missing, "exit")) as [number]
    rmSync(directory, { recursive: true, force: true })

    expect(code).toBe(1)
    expect(stderr).toContain("bun run tools-mcp:build")
  })
})
