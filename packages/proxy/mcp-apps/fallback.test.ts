// @vitest-environment node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { afterEach, describe, expect, it } from "vitest"

import { captureLogs } from "../../../test/support/log-capture"
import * as ids from "../core/ids"
import {
  ServerSessionNotFoundError,
  type ServerRuntime,
  type SessionScope,
} from "../core/runtime"
import { withMcpApps } from "./annotate"
import {
  createMcpAppClient,
  McpAppConnectionRefusedError,
  type McpAppClient,
  type McpServerOverrides,
} from "./client"
import {
  createMcpAppsFallback,
  McpAppNotFoundError,
  McpAppRefusedError,
  type StoredMcpToolCall,
} from "./fallback"
import { createMcpToolNames } from "./tool-names"

const VIEW_URI = "ui://weather/forecast"
const TOOLS = [
  {
    name: "show-forecast",
    inputSchema: { type: "object" as const },
    _meta: { ui: { resourceUri: VIEW_URI } },
  },
  {
    name: "refresh_forecast",
    inputSchema: { type: "object" as const },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "delete_station",
    inputSchema: { type: "object" as const },
    _meta: { ui: { visibility: ["model"] } },
  },
  { name: "plain_lookup", inputSchema: { type: "object" as const } },
]

/**
 * A Streamable HTTP MCP App server, answered in process through `fetch`; given
 * an `authorization`, it answers 401 to any request that does not carry it.
 */
function appServer(authorization?: string) {
  const seen = { listTools: 0, calls: [] as string[], urls: new Set<string>() }
  const handle = async (request: Request) => {
    seen.urls.add(request.url)
    if (
      authorization !== undefined &&
      request.headers.get("authorization") !== authorization
    )
      return new Response(null, { status: 401 })
    const server = new Server(
      { name: "weather", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, () => {
      seen.listTools += 1
      return { tools: TOOLS }
    })
    server.setRequestHandler(CallToolRequestSchema, (call) => {
      seen.calls.push(call.params.name)
      return { content: [{ type: "text", text: `ran ${call.params.name}` }] }
    })
    server.setRequestHandler(ReadResourceRequestSchema, (read) => ({
      contents: [
        {
          uri: read.params.uri,
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><p>Forecast</p>",
          _meta: {
            ui: {
              csp: {
                connectDomains: [
                  "https://api.weather.test",
                  "wss://live.weather.test",
                  "javascript:x",
                ],
              },
              prefersBorder: false,
            },
          },
        },
      ],
    }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handle(new Request(input, init))) as typeof globalThis.fetch
  return { seen, fetch }
}

const scope: SessionScope = {
  agentId: "agent-1",
  providerSessionId: "session-1",
  sessionId: "session-1",
}

const stored: Record<string, StoredMcpToolCall> = {
  "call-forecast": {
    toolName: "mcp__weather__show-forecast",
    input: { city: "Haifa" },
    result: { content: [{ type: "text", text: "Sunny" }] },
  },
  "call-declared": {
    toolName: "mcp__weather__plain_lookup",
    input: {},
    result: {
      content: [{ type: "text", text: "Rain" }],
      _meta: { ui: { resourceUri: VIEW_URI } },
    },
  },
}

let client: McpAppClient | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
})

function fallback(
  options: {
    weatherUrl?: string
    authorization?: string
    servers?: McpServerOverrides
  } = {}
) {
  const server = appServer(options.authorization)
  client = createMcpAppClient({
    fetch: server.fetch,
    servers: options.servers,
  })
  const logs = captureLogs()
  const apps = createMcpAppsFallback(
    {
      servers: async () => [
        {
          name: "weather",
          url: options.weatherUrl ?? "http://weather.test/mcp",
        },
        { name: "notes", url: "http://notes.test/mcp" },
      ],
      storedCall: async (_scope, toolCallId) => stored[toolCallId],
    },
    client,
    logs.logger
  )
  return { apps, seen: server.seen, logs }
}

describe("MCP Apps fallback host", () => {
  it("opens the view with its sanitized CSP, the call's input, and its result", async () => {
    const { apps } = fallback()

    await expect(
      apps.describe(scope, {
        toolCallId: "call-forecast",
        toolName: "mcp__weather__show-forecast",
      })
    ).resolves.toBe(true)
    await expect(apps.open(scope, "call-forecast")).resolves.toEqual({
      html: "<!doctype html><p>Forecast</p>",
      csp: {
        connectDomains: ["https://api.weather.test", "wss://live.weather.test"],
      },
      prefersBorder: false,
      toolInput: { city: "Haifa" },
      toolResult: { content: [{ type: "text", text: "Sunny" }] },
    })
  })

  it("lets a view call an app-visible tool on its own server", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.callTool(scope, "call-forecast", "refresh_forecast", {})
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "ran refresh_forecast" }],
    })
    expect(seen.calls).toEqual(["refresh_forecast"])
  })

  it("refuses a model-only tool and a tool of another server", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.callTool(scope, "call-forecast", "delete_station", {})
    ).rejects.toBeInstanceOf(McpAppRefusedError)
    await expect(
      apps.callTool(scope, "call-forecast", "create_note", {})
    ).rejects.toBeInstanceOf(McpAppRefusedError)
    await expect(
      apps.readResource(scope, "call-forecast", "https://notes.test/secret")
    ).rejects.toBeInstanceOf(McpAppRefusedError)
    expect(seen.calls).toEqual([])
  })

  it("answers not found for a call this Session does not hold", async () => {
    const { apps } = fallback()

    await expect(apps.open(scope, "call-elsewhere")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    await expect(
      apps.callTool(scope, "call-elsewhere", "refresh_forecast", {})
    ).rejects.toBeInstanceOf(McpAppNotFoundError)
  })

  it("takes the view a stored result names without listing tools", async () => {
    const { apps, seen } = fallback()

    await expect(
      apps.describe(scope, {
        toolCallId: "call-declared",
        toolName: "mcp__weather__plain_lookup",
        result: stored["call-declared"]!.result,
      })
    ).resolves.toBe(true)
    await expect(apps.open(scope, "call-declared")).resolves.toMatchObject({
      html: "<!doctype html><p>Forecast</p>",
    })
    expect(seen.listTools).toBe(0)
  })

  describe("with operator-configured headers", () => {
    const SECRET = "Bearer weather-s3cret"
    const servers: McpServerOverrides = new Map([
      ["weather", { headers: { Authorization: SECRET } }],
    ])

    it("sends them to a server that requires them", async () => {
      const { apps, logs } = fallback({
        weatherUrl: "https://weather.test/mcp",
        authorization: SECRET,
        servers,
      })

      await expect(
        apps.describe(scope, {
          toolCallId: "call-forecast",
          toolName: "mcp__weather__show-forecast",
        })
      ).resolves.toBe(true)
      await expect(apps.open(scope, "call-forecast")).resolves.toMatchObject({
        html: "<!doctype html><p>Forecast</p>",
      })
      expect(JSON.stringify(logs.records())).not.toContain("s3cret")
    })

    it("refuses to send them over plain HTTP, and falls back to text", async () => {
      const { apps, seen } = fallback({ authorization: SECRET, servers })

      await expect(
        apps.describe(scope, {
          toolCallId: "call-forecast",
          toolName: "mcp__weather__show-forecast",
        })
      ).resolves.toBe(false)
      const refused = await apps.open(scope, "call-forecast").catch((e) => e)
      expect(refused).toBeInstanceOf(McpAppConnectionRefusedError)
      expect(String(refused)).not.toContain("s3cret")
      expect(seen.listTools).toBe(0)
    })
  })

  it("keeps the newest running calls of the newest Sessions until a Session is gone", async () => {
    const { apps } = fallback()
    const runtime = withMcpApps({
      mcpApps: apps,
      turns: {
        start: async () => Promise.reject(new Error("unused")),
        recover: async () => Promise.reject(new ServerSessionNotFoundError()),
      },
      deleteSession: async () => undefined,
      publicError: () => undefined,
    } as unknown as ServerRuntime)
    const session = (n: number): SessionScope => ({
      agentId: "agent-1",
      providerSessionId: ids.providerSessionId(`session-${n}`),
      sessionId: ids.sessionId(`session-${n}`),
    })
    const observe = (at: SessionScope, toolCallId: string) =>
      apps.observe?.(at, {
        toolCallId,
        toolName: "mcp__weather__show-forecast",
      })
    const view = { html: "<!doctype html><p>Forecast</p>" }

    // A Session keeps its newest 32 running calls.
    for (let call = 0; call <= 32; call++) observe(scope, `live-${call}`)
    await expect(apps.open(scope, "live-1")).resolves.toMatchObject(view)
    await expect(apps.open(scope, "live-0")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    // The fallback keeps the newest 8 Sessions.
    for (let n = 2; n <= 9; n++) observe(session(n), "live-0")
    await expect(apps.open(scope, "live-1")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    // A Session deleted, or one a recover finds gone, keeps none.
    await runtime.deleteSession("agent-1", session(2).providerSessionId)
    await expect(
      runtime.turns.recover(session(3), {
        sessionId: session(3).sessionId,
        turnId: "turn-1",
      })
    ).rejects.toBeInstanceOf(ServerSessionNotFoundError)
    await expect(apps.open(session(2), "live-0")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    await expect(apps.open(session(3), "live-0")).rejects.toBeInstanceOf(
      McpAppNotFoundError
    )
    await expect(apps.open(session(4), "live-0")).resolves.toMatchObject(view)
  })

  describe("with an operator-configured URL", () => {
    it("connects there instead of the URL the runtime reports", async () => {
      const { apps, seen } = fallback({
        servers: new Map([["weather", { url: "http://tools-mcp:4110/mcp" }]]),
      })

      await expect(apps.open(scope, "call-forecast")).resolves.toMatchObject({
        html: "<!doctype html><p>Forecast</p>",
      })
      expect([...seen.urls]).toEqual(["http://tools-mcp:4110/mcp"])
    })

    it("sends headers to the override URL", async () => {
      const SECRET = "Bearer weather-s3cret"
      const secured = fallback({
        authorization: SECRET,
        servers: new Map([
          [
            "weather",
            {
              url: "https://weather.internal/mcp",
              headers: { Authorization: SECRET },
            },
          ],
        ]),
      })
      await expect(
        secured.apps.open(scope, "call-forecast")
      ).resolves.toMatchObject({ html: "<!doctype html><p>Forecast</p>" })
      expect([...secured.seen.urls]).toEqual(["https://weather.internal/mcp"])
    })

    it("refuses to send headers to a plain-HTTP override the runtime reported as HTTPS", async () => {
      const SECRET = "Bearer weather-s3cret"
      const plain = fallback({
        weatherUrl: "https://weather.test/mcp",
        authorization: SECRET,
        servers: new Map([
          [
            "weather",
            {
              url: "http://tools-mcp:4110/mcp",
              headers: { Authorization: SECRET },
            },
          ],
        ]),
      })
      await expect(
        plain.apps.open(scope, "call-forecast")
      ).rejects.toBeInstanceOf(McpAppConnectionRefusedError)
      expect(plain.seen.urls.size).toBe(0)
    })
  })
})

describe("MCP tool name split", () => {
  it("matches the longest server once the server list loads", async () => {
    const names = createMcpToolNames(
      {
        format: (server, tool) => `mcp__${server}__${tool}`,
        prefix: (server) => `mcp__${server}__`,
        candidate: (rawName) => rawName.startsWith("mcp__"),
      },
      async () => [{ name: "a" }, { name: "a__b" }]
    )

    expect(await names.split("agent-1", "mcp__a__b__c")).toEqual({
      server: "a__b",
      tool: "c",
    })
    expect(await names.split("agent-1", "mcp__z__c")).toBeUndefined()
  })
})
