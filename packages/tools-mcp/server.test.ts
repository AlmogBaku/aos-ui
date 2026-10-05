// @vitest-environment node

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
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

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createToolsServer({ views, pdfjs, grammars }).connect(serverTransport)
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
      expect(tool.description!.length, tool.name).toBeLessThan(600)
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    expect(byName.get("render_chart")!.description).toMatch(/Mermaid/u)
    expect(byName.get("render_map")!.description).toMatch(/HTML/u)
    expect(byName.get("present_artifact")!.description).toMatch(/absolute/u)
    expect(byName.get("present_artifact")!.description).toMatch(
      /again after each change/u
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
    // The page adds each call's own file addresses to this view's policy;
    // its Copy button writes the clipboard.
    [
      "present_artifact",
      "ui://aos-ui/artifact",
      "artifact",
      { csp: {}, permissions: { clipboardWrite: {} } },
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
})

describe("view files", () => {
  // The artifact view's sandbox fetches nothing, so it reads pdf.js's worker,
  // data, and decoders by name; "lists one App resource per view" keeps them
  // out of the resource list the fixture snapshot reads.
  it("serves the worker as script text, other files as bytes, and nothing else", async () => {
    const worker = await client.readResource({
      uri: "ui://aos-ui/pdfjs/pdf.worker.js",
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
  // its path; the proxy reads the path from the call's own arguments. A title
  // keeps the path's extension, which the view and a download type it by.
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
        value,
      })
      expect(fallback(result)).toEqual({
        heading: `${value.filename} is ready for display.`,
        value,
      })
      expect(JSON.stringify(result)).not.toContain("/workspace")
    }
  )

  it.each([
    ["a relative path", { path: "out/report.pdf" }, /absolute at path/u],
    ["the root directory", { path: "/" }, /name a file/u],
    ["an empty path", { path: "" }, /at path/u],
    [
      "a path with a control character",
      { path: "/workspace/a\u0000b" },
      /control characters at path/u,
    ],
    ["an overlong title", { path: "/a", title: "t".repeat(161) }, /at title/u],
    ["a malformed mimeType", { path: "/a", mimeType: "text" }, /at mimeType/u],
    [
      "an extra key",
      { path: "/a", url: "https://example.com" },
      /Unrecognized key: "url"/u,
    ],
  ])("rejects %s", async (_case, args, issue) => {
    expect(errorText(await call("present_artifact", args))).toMatch(issue)
  })
})
