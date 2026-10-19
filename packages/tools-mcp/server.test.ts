// @vitest-environment node

import { artifactFileId } from "@harness-gw/sdk/node"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest"

import { ARTIFACT_VIEW_HOST_META } from "../../shared/presentation/views"
import { useFakeClock } from "../../test/support/fake-clock"
import { fileReadSettings, type FileReadOptions } from "./file-reads"
import { toolsServerFactory } from "./server"

const client = new Client({ name: "tools-mcp-test", version: "0.0.0" })

/** Stand-ins for the built documents, which `views/build.test.ts` covers. */
const views = {
  chart: "<!doctype html><head><title>chart</title></head>",
  map: "<!doctype html><head><title>map</title></head>",
  stats: "<!doctype html><head><title>stats</title></head>",
  artifact: "<!doctype html><head><title>artifact</title></head>",
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
  await toolsServerFactory({ views, pdfjs, grammars, maplibre })().connect(
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
    // The view reads its file through the server, so its policy declares
    // only the CDNs the Agent HTML it previews may load from, named here so
    // that adding one is deliberate; its Copy button writes the clipboard.
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

  it("declares the stable origin it is given on the artifact view alone, in its listing and its content, and names in its HTML the host it expects", async () => {
    const domain = "0123456789abcdef0123456789abcdef.mcp-apps.example.test"
    const host = `${domain}:8443`
    const stable = new Client({ name: "tools-mcp-test", version: "0.0.0" })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await toolsServerFactory(
      { views },
      { artifactStableOrigin: { domain, host } }
    )().connect(serverTransport)
    await stable.connect(clientTransport)

    const { resources } = await stable.listResources()
    for (const [, uri, view, ui] of declared) {
      const artifact = view === "artifact"
      const listed = resources.find((resource) => resource.uri === uri)
      const [content] = (await stable.readResource({ uri })).contents
      expect(listed?._meta?.ui, uri).toEqual(artifact ? { ...ui, domain } : ui)
      expect(content?._meta?.ui, uri).toEqual(artifact ? { ...ui, domain } : ui)
      const text = content && "text" in content ? content.text : undefined
      if (artifact)
        expect(text).toContain(
          `<meta name="${ARTIFACT_VIEW_HOST_META}" content="${host}">`
        )
      else expect(text, uri).toBe(views[view])
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

describe("file reads", () => {
  const LANE = "http://localhost:3000"
  const PASS = "pass-secret-1"
  const ROUTE = "/api/v1/agents/a1/sessions/s1/tool-calls/c1/app/files/path"
  const address = `${LANE}${ROUTE}?pass=${PASS}`

  /** A client of a server `factory` makes. */
  async function connect(factory: ReturnType<typeof toolsServerFactory>) {
    const reading = new Client({ name: "tools-mcp-test", version: "0.0.0" })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await factory().connect(serverTransport)
    await reading.connect(clientTransport)
    onTestFinished(() => reading.close())
    return reading
  }

  /**
   * A client of a server that answers file reads by `fileReads`, its every
   * fetch answered by `answer`.
   */
  async function reader(
    fileReads: Omit<Partial<FileReadOptions>, "fetch"> = {},
    answer: NonNullable<FileReadOptions["fetch"]> = async () =>
      new Response("Quarterly notes")
  ) {
    const fetch = vi.fn(answer)
    const factory = toolsServerFactory(
      { views },
      { fileReads: { origins: [LANE], fetch, ...fileReads } }
    )
    return { client: await connect(factory), fetch }
  }

  /** Everything the server wrote to the console, as one string. */
  function consoleOutput() {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined)
    )
    return () =>
      spies.flatMap((spy) => spy.mock.calls.map((call) => call.join(" ")))
  }

  it.each([
    ["a tool call's file", ROUTE],
    [
      "a published Artifact's file",
      "/api/v1/agents/a1/sessions/s1/artifacts/r1/app/files/path",
    ],
  ])(
    "reads %s at its address once, keeping nothing, and answers it typed by the response",
    async (_case, route) => {
      const uri = `${LANE}${route}?pass=${PASS}`
      const { client: reading, fetch } = await reader(
        {},
        async () =>
          new Response("Quarterly notes", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
      )

      const { contents } = await reading.readResource({ uri })

      expect(contents).toEqual([
        {
          uri,
          mimeType: "text/plain; charset=utf-8",
          blob: Buffer.from("Quarterly notes").toString("base64"),
        },
      ])
      expect(fetch).toHaveBeenCalledOnce()
      const [target, init] = fetch.mock.calls[0]!
      expect(String(target)).toBe(uri)
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
      })
      expect(init.headers).toBeUndefined()
    }
  )

  it.each([
    ["another origin", `http://files.example.test${ROUTE}?pass=${PASS}`],
    ["a lane's other path", `${LANE}${ROUTE}/more?pass=${PASS}`],
    [
      "the route outside the gateway's prefix",
      `${LANE}${ROUTE.slice("/api/v1".length)}?pass=${PASS}`,
    ],
    [
      "another collection",
      `${LANE}/api/v1/agents/a1/sessions/s1/messages/c1/app/files/path?pass=${PASS}`,
    ],
    ["a path that climbs out", `${LANE}${ROUTE}/../../../healthz?pass=${PASS}`],
    [
      "an address with credentials",
      `http://user:pw@localhost:3000${ROUTE}?pass=${PASS}`,
    ],
    // The lane would judge a read without a pass by the listener's own login.
    ["an address without a pass", `${LANE}${ROUTE}?pas=${PASS}`],
    ["an address with an empty pass", `${LANE}${ROUTE}?pass=`],
    ["another scheme", `ftp://localhost:3000${ROUTE}?pass=${PASS}`],
    ["a ui:// resource no view serves", "ui://aos-ui/unknown"],
  ])("finds no resource at %s, reading nothing", async (_case, uri) => {
    const { client: reading, fetch } = await reader()

    const refused = reading.readResource({ uri }).catch((error: Error) => error)

    expect(await refused).toMatchObject({
      message: expect.stringMatching(/Resource not found/u),
    })
    expect(JSON.stringify(await refused)).not.toContain(PASS)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("finds no file at all while no lane's origin is set", async () => {
    const { client: reading, fetch } = await reader({ origins: [] })

    await expect(reading.readResource({ uri: address })).rejects.toThrow(
      /Resource not found/u
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })

  it.each([
    ["a 403", "denied", async () => new Response(null, { status: 403 })],
    [
      "a body past the limit",
      "tooLarge",
      async () => new Response(stream(["xxxx", "xxxx", "x"])),
    ],
    [
      "a declared length past the limit",
      "tooLarge",
      async () =>
        new Response(stream([]), { headers: { "content-length": "9" } }),
    ],
    ["a 404", "unreachable", async () => new Response(null, { status: 404 })],
    [
      "a redirect",
      "unreachable",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://files.example.test/" },
        }),
    ],
    [
      "a network failure",
      "unreachable",
      async (target: string | URL) => {
        throw new TypeError(`Unable to connect to ${String(target)}`)
      },
    ],
    [
      "no answer in time",
      "unreachable",
      (_target: string | URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          )
        ),
    ],
  ] as const)(
    "names %s as %s, without repeating or logging the pass",
    async (_case, reason, answer) => {
      const output = consoleOutput()
      const { client: reading } = await reader(
        { limit: 8, timeoutMs: 1 },
        answer
      )

      const failed = await reading
        .readResource({ uri: address })
        .catch((error: Error) => error)

      expect(failed).toMatchObject({ data: { reason } })
      expect(JSON.stringify(failed)).not.toContain(PASS)
      expect((failed as Error).message).not.toContain(PASS)
      // The failure is logged by its location alone.
      expect(output().join("\n")).toContain(`${LANE}${ROUTE}`)
      expect(output().join("\n")).not.toContain(PASS)
    }
  )

  it("fetches one read at a time for every server it makes, hands the next turn to the first waiting, and refuses a read past its queue or its wait as unreachable", async () => {
    const clock = useFakeClock()
    const answers: Array<(response: Response) => void> = []
    const fetch = vi.fn<NonNullable<FileReadOptions["fetch"]>>(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve)
        })
    )
    const factory = toolsServerFactory(
      { views },
      {
        fileReads: {
          origins: [LANE],
          fetch,
          concurrency: 1,
          queue: 2,
          waitMs: 1_000,
        },
      }
    )
    const [one, other] = await Promise.all([connect(factory), connect(factory)])
    const file = (argument: string) =>
      `${LANE}${ROUTE.replace(/path$/u, argument)}?pass=${PASS}`
    const fetched = () =>
      fetch.mock.calls.map(([target]) => target.pathname.split("/").at(-1))
    const reason = (read: Promise<unknown>) =>
      read.then(
        () => undefined,
        (error: { data?: { reason?: string } }) => error.data?.reason
      )

    const first = one.readResource({ uri: file("a") })
    const second = other.readResource({ uri: file("b") })
    const third = one.readResource({ uri: file("c") })
    expect(await reason(other.readResource({ uri: file("d") }))).toBe(
      "unreachable"
    )
    await clock.advance(0)
    expect(fetched()).toEqual(["a"])

    answers[0]!(new Response("A"))
    expect((await first).contents).toHaveLength(1)
    await clock.advance(0)
    expect(fetched()).toEqual(["a", "b"])
    answers[1]!(new Response("B"))
    expect((await second).contents).toHaveLength(1)
    await clock.advance(0)
    expect(fetched()).toEqual(["a", "b", "c"])
    answers[2]!(new Response("C"))
    expect((await third).contents).toHaveLength(1)

    const held = one.readResource({ uri: file("e") })
    const waited = reason(other.readResource({ uri: file("f") }))
    await clock.advance(999)
    expect(fetched()).toEqual(["a", "b", "c", "e"])
    await clock.advance(1)
    expect(await waited).toBe("unreachable")
    answers[3]!(new Response("E"))
    expect((await held).contents).toHaveLength(1)
    await clock.advance(0)
    expect(fetched()).toEqual(["a", "b", "c", "e"])
  })

  it("reads a lane at its upstream under the lane's own Host, and any other lane as it is", async () => {
    const guest = "http://localhost:3001"
    const { client: reading, fetch } = await reader({
      origins: [LANE, guest],
      upstreams: new Map([[LANE, "http://caddy:18080"]]),
    })

    await reading.readResource({ uri: address })
    await reading.readResource({ uri: `${guest}${ROUTE}?pass=${PASS}` })

    const [[upstream, upstreamInit], [direct, directInit]] = fetch.mock.calls
    expect(String(upstream)).toBe(`http://caddy:18080${ROUTE}?pass=${PASS}`)
    expect(upstreamInit?.headers).toEqual({ host: "localhost:3000" })
    expect(String(direct)).toBe(`${guest}${ROUTE}?pass=${PASS}`)
    expect(directInit?.headers).toBeUndefined()
  })

  it("takes the lanes from AOS_UI_PUBLIC_ORIGIN and their upstreams from AOS_UI_TOOLS_MCP_LANE_UPSTREAMS", () => {
    const { options, note } = fileReadSettings({
      AOS_UI_PUBLIC_ORIGIN: `${LANE}, http://localhost:3001`,
      AOS_UI_TOOLS_MCP_LANE_UPSTREAMS: ` ${LANE}=http://caddy:18080 ,`,
    })

    expect(options).toEqual({
      origins: [LANE, "http://localhost:3001"],
      upstreams: new Map([[LANE, "http://caddy:18080"]]),
    })
    expect(note).toContain(`${LANE} (at http://caddy:18080)`)
    expect(fileReadSettings({}).options.origins).toEqual([])
    expect(fileReadSettings({}).note).toContain("AOS_UI_PUBLIC_ORIGIN is unset")
  })

  it.each([
    "http://localhost:3000",
    "http://localhost:3000=caddy:18080",
    "http://localhost:3000=http://caddy:18080/files",
    "http://localhost:3000=http://caddy:18080=http://web:4200",
  ])("refuses the upstream %s", (entry) => {
    expect(() =>
      fileReadSettings({
        AOS_UI_PUBLIC_ORIGIN: LANE,
        AOS_UI_TOOLS_MCP_LANE_UPSTREAMS: entry,
      })
    ).toThrow(
      /^AOS_UI_TOOLS_MCP_LANE_UPSTREAMS: .* is not <lane origin>=<base URL>/u
    )
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

  it("gives one path the id the gateway gives it, whatever its title or spelling, and another path another", async () => {
    const id = async (args: Record<string, unknown>) =>
      (
        (await call("present_artifact", args)).structuredContent as {
          value: { fileId: string }
        }
      ).value.fileId
    const plain = await id({ path: "/workspace/out/report.pdf" })

    expect(plain).toBe(artifactFileId("/workspace/out/report.pdf"))
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
