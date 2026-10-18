// @vitest-environment node

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createToolsServer } from "./server"

const client = new Client({ name: "tools-mcp-test", version: "0.0.0" })

/** Stand-ins for the built documents, which `views/build.test.ts` covers. */
const views = {
  chart: "<!doctype html><title>chart</title>",
  map: "<!doctype html><title>map</title>",
  stats: "<!doctype html><title>stats</title>",
  artifact: "<!doctype html><title>artifact</title>",
}

/** Stand-ins for pdf.js's files, which `views/build.test.ts` also covers. */
const pdfjs = new Map([
  ["pdf.worker.js", new TextEncoder().encode("self.onmessage = null")],
  ["wasm/jbig2.wasm", Uint8Array.of(0, 97, 115, 109)],
])
const grammars = new Map([
  ["go.json", new TextEncoder().encode('{"name":"go"}')],
])
const maplibre = new Map([
  ["maplibre-gl-worker.mjs", new TextEncoder().encode("export {}")],
])

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createToolsServer({ views, pdfjs, grammars, maplibre }).connect(
    serverTransport
  )
  await client.connect(clientTransport)
})

afterAll(() => client.close())

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

function errorText(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).toBe(true)
  return (result.content as Array<{ text: string }>)
    .map(({ text }) => text)
    .join("\n")
}

/** The render tools' text channel: a heading, then the parsed value as JSON. */
function fallback(result: Awaited<ReturnType<typeof call>>) {
  const [content] = result.content as Array<{ type: string; text: string }>
  expect(result.content).toHaveLength(1)
  expect(content!.type).toBe("text")
  const [heading, json] = content!.text.split("\n\nStructured fallback:\n")
  return { heading, value: JSON.parse(json!) as unknown }
}

const chart = {
  title: "Illustrative comparison",
  xKey: "label",
  series: [{ key: "value", label: "Example value" }],
  data: [
    { label: "A", value: 2 },
    { label: "B", value: 3 },
  ],
}

describe("tools/list", () => {
  it("lists exactly the four read-only tools with schemas and guidance", async () => {
    const { tools } = await client.listTools()

    expect(tools.map(({ name }) => name).sort()).toEqual([
      "present_artifact",
      "render_chart",
      "render_map",
      "render_stats",
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true)
      expect(tool.inputSchema.type, tool.name).toBe("object")
      expect(tool.description!.length, tool.name).toBeLessThan(1000)
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    expect(byName.get("render_chart")!.description).toMatch(/Mermaid/u)
    expect(byName.get("render_map")!.description).toMatch(/HTML/u)
    // A tool-search listing shows only the first sentence, clipped to 60 characters.
    const [firstSentence] = byName
      .get("present_artifact")!
      .description!.split(/(?<=[.!?])\s/u)
    expect(firstSentence!.length).toBeLessThanOrEqual(60)
    expect(firstSentence).toMatch(/instead of a MEDIA: line/u)
    expect(byName.get("present_artifact")!.description).toMatch(
      /again after each change/u
    )
    expect(byName.get("present_artifact")!.description).toMatch(
      /one path is one Artifact/u
    )
  })
})

describe("MCP App views", () => {
  const declared = [
    ["render_chart", "ui://aos-ui/chart", "chart", { csp: {} }],
    [
      "render_map",
      "ui://aos-ui/map",
      "map",
      { csp: { connectDomains: ["https://tiles.openfreemap.org"] } },
    ],
    ["render_stats", "ui://aos-ui/stats", "stats", { csp: {} }],
    // The page adds each call's own file addresses to this view's policy,
    // which declares only the CDNs the Agent HTML it previews may load from,
    // named here so that adding one is deliberate; its Copy button writes the
    // clipboard.
    [
      "present_artifact",
      "ui://aos-ui/artifact",
      "artifact",
      {
        csp: {
          resourceDomains: [
            "https://fonts.googleapis.com",
            "https://fonts.gstatic.com",
            "https://cdn.tailwindcss.com",
          ],
        },
        permissions: { clipboardWrite: {} },
      },
    ],
  ] as const

  it.each(declared)("%s declares %s", async (name, resourceUri) => {
    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === name)

    expect(tool?._meta?.ui).toEqual({ resourceUri })
  })

  it("lists one App resource per view", async () => {
    const { resources } = await client.listResources()

    expect(resources.map(({ uri }) => uri).sort()).toEqual([
      "ui://aos-ui/artifact",
      "ui://aos-ui/chart",
      "ui://aos-ui/map",
      "ui://aos-ui/stats",
    ])
    for (const resource of resources)
      expect(resource.mimeType, resource.uri).toBe("text/html;profile=mcp-app")
  })

  it.each(declared)(
    "serves %s's view with its CSP and permissions",
    async (_name, uri, view, ui) => {
      const { contents } = await client.readResource({ uri })

      expect(contents).toEqual([
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: views[view],
          _meta: { ui },
        },
      ])
    }
  )

  it("declares the stable origin it is given on the artifact view alone, in its listing and its content", async () => {
    const domain = "0123456789abcdef0123456789abcdef.mcp-apps.example.test"
    const stable = new Client({ name: "tools-mcp-test", version: "0.0.0" })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await createToolsServer({ views }, { artifactDomain: domain }).connect(
      serverTransport
    )
    await stable.connect(clientTransport)

    const { resources } = await stable.listResources()
    for (const [, uri, , ui] of declared) {
      const expected = uri === "ui://aos-ui/artifact" ? { ...ui, domain } : ui
      const listed = resources.find((resource) => resource.uri === uri)
      const [content] = (await stable.readResource({ uri })).contents
      expect(listed?._meta?.ui, uri).toEqual(expected)
      expect(content?._meta?.ui, uri).toEqual(expected)
    }
    await stable.close()
  })
})

describe("view files", () => {
  // The views' sandboxes fetch nothing, so the artifact view reads pdf.js's
  // worker, data, and decoders by name, and the map view MapLibre's worker;
  // "lists one App resource per view" keeps them out of the resource list the
  // fixture snapshot reads.
  it("serves each worker as script text, other files as bytes, and nothing else", async () => {
    const worker = await client.readResource({
      uri: "ui://aos-ui/pdfjs/pdf.worker.js",
    })
    const mapWorker = await client.readResource({
      uri: "ui://aos-ui/maplibre/maplibre-gl-worker.mjs",
    })
    const decoder = await client.readResource({
      uri: "ui://aos-ui/pdfjs/wasm/jbig2.wasm",
    })

    expect(worker.contents).toEqual([
      {
        uri: "ui://aos-ui/pdfjs/pdf.worker.js",
        mimeType: "text/javascript",
        text: "self.onmessage = null",
      },
    ])
    expect(mapWorker.contents).toEqual([
      {
        uri: "ui://aos-ui/maplibre/maplibre-gl-worker.mjs",
        mimeType: "text/javascript",
        text: "export {}",
      },
    ])
    expect(decoder.contents).toEqual([
      {
        uri: "ui://aos-ui/pdfjs/wasm/jbig2.wasm",
        mimeType: "application/octet-stream",
        blob: "AGFzbQ==",
      },
    ])
    await expect(
      client.readResource({ uri: "ui://aos-ui/pdfjs/wasm/quickjs-eval.wasm" })
    ).rejects.toThrow(
      /No pdf\.js file at ui:\/\/aos-ui\/pdfjs\/wasm\/quickjs-eval\.wasm/u
    )
  })

  it("serves each grammar as JSON text, and no grammar it was not built with", async () => {
    const go = await client.readResource({
      uri: "ui://aos-ui/grammars/go.json",
    })

    expect(go.contents).toEqual([
      {
        uri: "ui://aos-ui/grammars/go.json",
        mimeType: "application/json",
        text: '{"name":"go"}',
      },
    ])
    await expect(
      client.readResource({ uri: "ui://aos-ui/grammars/cobol.json" })
    ).rejects.toThrow(/No grammar at ui:\/\/aos-ui\/grammars\/cobol\.json/u)
  })
})

describe("render_chart", () => {
  it("returns the presentation receipt with the line type by default", async () => {
    const result = await call("render_chart", chart)
    const value = { ...chart, type: "line" }

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      ok: true,
      type: "aos.presentation",
      kind: "render_chart",
      value,
    })
    expect(fallback(result)).toEqual({
      heading: "Illustrative comparison is ready for display.",
      value,
    })
  })

  it.each([
    [
      "a row without its axis value",
      { data: [{ value: 2 }] },
      "Missing axis value",
    ],
    [
      "a non-numeric series value",
      { data: [{ label: "A", value: "two" }] },
      "Series values must be numeric",
    ],
    [
      "a pie with two series",
      {
        type: "pie",
        series: [
          { key: "value", label: "Value" },
          { key: "other", label: "Other" },
        ],
        data: [{ label: "A", value: 1, other: 2 }],
      },
      "Pie charts require exactly one numeric series",
    ],
    [
      "a pie with a zero total",
      { type: "pie", data: [{ label: "A", value: 0 }] },
      "Pie chart values must be non-negative with a positive total",
    ],
  ])("rejects %s", async (_case, override, message) => {
    expect(
      errorText(await call("render_chart", { ...chart, ...override }))
    ).toContain(message)
  })
})

describe("render_map", () => {
  const map = {
    title: "Illustrative coordinate",
    locations: [{ id: "origin", label: "Origin", latitude: 0, longitude: 0 }],
  }

  it("returns the presentation receipt", async () => {
    const result = await call("render_map", map)

    expect(result.structuredContent).toEqual({
      ok: true,
      type: "aos.presentation",
      kind: "render_map",
      value: map,
    })
  })

  it("rejects an out-of-range latitude", async () => {
    const locations = [{ ...map.locations[0], latitude: 91 }]
    expect(errorText(await call("render_map", { ...map, locations }))).toMatch(
      /latitude/u
    )
  })
})

describe("render_stats", () => {
  it("names an untitled presentation in the fallback text", async () => {
    const stats = { stats: [{ key: "count", label: "Count", value: 2 }] }
    const result = await call("render_stats", stats)

    expect(result.structuredContent).toEqual({
      ok: true,
      type: "aos.presentation",
      kind: "render_stats",
      value: stats,
    })
    expect(fallback(result)).toEqual({
      heading: "presentation is ready for display.",
      value: stats,
    })
  })

  it("rejects an empty stats list", async () => {
    expect(errorText(await call("render_stats", { stats: [] }))).toMatch(
      /stats/u
    )
  })
})

describe("present_artifact", () => {
  // A result reaches guests through the view, so it names the file and never
  // its path; the gateway reads the path from the call's own arguments. A title
  // keeps the path's extension, which the view and a download type it by.
  const anyFileId = { fileId: expect.stringMatching(/^[0-9a-f]{16}$/u) }
  it.each([
    [{ path: "/workspace/out/report.pdf" }, { filename: "report.pdf" }],
    [
      {
        path: "/workspace/nonexistent/data.csv",
        title: "Quarterly data",
        mimeType: "text/csv",
      },
      { filename: "Quarterly data.csv", mimeType: "text/csv" },
    ],
    [
      { path: "/workspace/out/report.pdf", title: "Q3 report.PDF" },
      { filename: "Q3 report.PDF" },
    ],
  ])(
    "shows %j by name, without its path or touching the filesystem",
    async (args, value) => {
      const result = await call("present_artifact", args)

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({
        ok: true,
        type: "aos.presentation",
        kind: "present_artifact",
        value: { ...value, ...anyFileId },
      })
      expect(fallback(result)).toEqual({
        heading: `${value.filename} is ready for display.`,
        value: { ...value, ...anyFileId },
      })
      expect(JSON.stringify(result)).not.toContain("/workspace")
    }
  )

  it("gives one path one id whatever its title or spelling, and another path another", async () => {
    const id = async (args: Record<string, unknown>) =>
      (
        (await call("present_artifact", args)).structuredContent as {
          value: { fileId: string }
        }
      ).value.fileId
    const plain = await id({ path: "/workspace/out/report.pdf" })

    expect(await id({ path: "/workspace/out/report.pdf", title: "Q3" })).toBe(
      plain
    )
    expect(await id({ path: "/workspace/out/./report.pdf" })).toBe(plain)
    expect(await id({ path: "/workspace/out/report-v2.pdf" })).not.toBe(plain)
  })

  it.each([
    [
      "a relative path",
      { path: "out/report.pdf" },
      /path: Path must be absolute/u,
    ],
    ["the root directory", { path: "/" }, /name a file/u],
    ["an empty path", { path: "" }, /path: Too small/u],
    [
      "a path with a control character",
      { path: "/workspace/a\u0000b" },
      /path: Path must not contain control characters/u,
    ],
    [
      "an overlong title",
      { path: "/a", title: "t".repeat(161) },
      /title: Too big/u,
    ],
    ["a malformed mimeType", { path: "/a", mimeType: "text" }, /mimeType: /u],
    [
      "an extra key",
      { path: "/a", url: "https://example.com" },
      /Unrecognized key: "url"/u,
    ],
  ])("rejects %s", async (_case, args, issue) => {
    expect(errorText(await call("present_artifact", args))).toMatch(issue)
  })
})
