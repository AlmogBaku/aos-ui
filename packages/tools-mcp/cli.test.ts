// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ARTIFACT_VIEW_HOST_META,
  FIXTURE_ARTIFACT_VIEW_DOMAIN,
  presentationViewNames,
} from "../../shared/presentation/views"
import { artifactStableOrigin } from "./stable-origin"

let child: ChildProcess
let origin: string
/** Stand-in documents, so the test never reads a stale build. */
const views = mkdtempSync(join(tmpdir(), "aos-ui-views-"))

/**
 * The fixture's stable origins, and the URL a harness on the host registers
 * the server at, whose key `FIXTURE_ARTIFACT_VIEW_DOMAIN` carries.
 */
const STABLE = {
  AOS_UI_MCP_APP_STABLE_ORIGINS: "http://*.mcp-apps.localhost:3917",
  AOS_UI_TOOLS_MCP_URL: "http://127.0.0.1:4110/mcp",
}

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
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...STABLE } }
  )
}

function writeViews(directory: string) {
  for (const name of presentationViewNames)
    writeFileSync(
      join(directory, `${name}.html`),
      `<head><title>${name}</title></head>`
    )
}

function writePdfjs(directory: string) {
  mkdirSync(join(directory, "pdfjs/wasm"), { recursive: true })
  writeFileSync(join(directory, "pdfjs/pdf.worker.js"), "self.onmessage = null")
  writeFileSync(join(directory, "pdfjs/wasm/jbig2.wasm"), Uint8Array.of(0, 97))
}

function writeGrammars(directory: string) {
  mkdirSync(join(directory, "grammars"))
  writeFileSync(join(directory, "grammars/typescript.json"), "{}")
}

beforeAll(async () => {
  writeViews(views)
  writePdfjs(views)
  writeGrammars(views)
  mkdirSync(join(views, "maplibre"))
  writeFileSync(join(views, "maplibre/maplibre-gl-worker.mjs"), "export {}")
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
    const artifact = await client.readResource({
      uri: "ui://aos-ui/artifact",
    })
    const decoder = await client.readResource({
      uri: "ui://aos-ui/pdfjs/wasm/jbig2.wasm",
    })
    await client.close()

    expect(contents[0]).toMatchObject({
      text: "<head><title>map</title></head>",
    })
    // Started with both stable-origin settings, the artifact view declares
    // its stable origin and names the host it expects.
    expect(artifact.contents[0]).toMatchObject({
      text: expect.stringContaining(
        `<meta name="${ARTIFACT_VIEW_HOST_META}" content="${FIXTURE_ARTIFACT_VIEW_DOMAIN}:3917">`
      ),
      _meta: { ui: { domain: FIXTURE_ARTIFACT_VIEW_DOMAIN } },
    })
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
    [
      "MapLibre's worker",
      (directory: string) => {
        writeViews(directory)
        writePdfjs(directory)
        writeGrammars(directory)
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

describe("the artifact view's stable origin", () => {
  it.each([
    [
      "with the wildcard's port",
      STABLE,
      `${FIXTURE_ARTIFACT_VIEW_DOMAIN}:3917`,
    ],
    [
      "without a port, the wildcard written in capitals",
      {
        ...STABLE,
        AOS_UI_MCP_APP_STABLE_ORIGINS: "HTTP://*.MCP-Apps.localhost",
      },
      FIXTURE_ARTIFACT_VIEW_DOMAIN,
    ],
  ])(
    "declares the key of the URL the gateway dials below the wildcard's domain, and expects it %s",
    (_case, environment, host) => {
      expect(artifactStableOrigin(environment, false).origin).toEqual({
        domain: FIXTURE_ARTIFACT_VIEW_DOMAIN,
        host,
      })
    }
  )

  it.each([
    [
      "AOS_UI_MCP_APP_STABLE_ORIGINS is unset",
      { AOS_UI_TOOLS_MCP_URL: STABLE.AOS_UI_TOOLS_MCP_URL },
      false,
    ],
    [
      "AOS_UI_TOOLS_MCP_URL is unset",
      { ...STABLE, AOS_UI_TOOLS_MCP_URL: "" },
      false,
    ],
    ["under --stdio", STABLE, true],
  ])("declares none, and says why, when %s", (reason, environment, stdio) => {
    const { origin, note } = artifactStableOrigin(environment, stdio)

    expect(origin).toBeUndefined()
    expect(note).toContain(reason)
  })

  it.each([
    [
      "a stable origins value that is no wildcard",
      { ...STABLE, AOS_UI_MCP_APP_STABLE_ORIGINS: "http://mcp-apps.localhost" },
      /AOS_UI_MCP_APP_STABLE_ORIGINS: http:\/\/mcp-apps\.localhost is not a wildcard origin/u,
    ],
    [
      "a dial URL that is no URL",
      { ...STABLE, AOS_UI_TOOLS_MCP_URL: "/mcp" },
      /AOS_UI_TOOLS_MCP_URL: \/mcp is not a URL/u,
    ],
  ])("refuses %s", (_case, environment, message) => {
    expect(() => artifactStableOrigin(environment, false)).toThrow(message)
  })
})
