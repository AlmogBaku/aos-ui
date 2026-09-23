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
}

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createToolsServer({ views }).connect(serverTransport)
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
      /after its final edit/u
    )
  })
})

describe("MCP App views", () => {
  const declared = [
    ["render_chart", "ui://aos-ui/chart", "chart", {}],
    [
      "render_map",
      "ui://aos-ui/map",
      "map",
      { connectDomains: ["https://tiles.openfreemap.org"] },
    ],
    ["render_stats", "ui://aos-ui/stats", "stats", {}],
  ] as const

  it.each(declared)("%s declares %s", async (name, resourceUri) => {
    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === name)

    expect(tool?._meta?.ui).toEqual({ resourceUri })
  })

  it("leaves present_artifact without a view", async () => {
    const { tools } = await client.listTools()
    const tool = tools.find(({ name }) => name === "present_artifact")

    expect(tool?._meta?.ui).toBeUndefined()
  })

  it("lists one App resource per view", async () => {
    const { resources } = await client.listResources()

    expect(resources.map(({ uri }) => uri).sort()).toEqual([
      "ui://aos-ui/chart",
      "ui://aos-ui/map",
      "ui://aos-ui/stats",
    ])
    for (const resource of resources)
      expect(resource.mimeType, resource.uri).toBe("text/html;profile=mcp-app")
  })

  it.each(declared)(
    "serves %s's view with its CSP",
    async (_name, uri, view, csp) => {
      const { contents } = await client.readResource({ uri })

      expect(contents).toEqual([
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: views[view],
          _meta: { ui: { csp } },
        },
      ])
    }
  )
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
  it.each([
    [
      { path: "/workspace/out/report.pdf" },
      { path: "/workspace/out/report.pdf", filename: "report.pdf" },
    ],
    [
      {
        path: "/workspace/nonexistent/data.csv",
        title: "Quarterly data",
        mimeType: "text/csv",
      },
      {
        path: "/workspace/nonexistent/data.csv",
        filename: "Quarterly data",
        mimeType: "text/csv",
      },
    ],
  ])("publishes %j without touching the filesystem", async (args, artifact) => {
    const result = await call("present_artifact", args)
    const receipt = { ok: true, type: "aos.artifact", artifact }

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(receipt)
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(receipt) },
    ])
  })

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
