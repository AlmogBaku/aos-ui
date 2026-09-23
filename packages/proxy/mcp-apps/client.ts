import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpError, type Tool } from "@modelcontextprotocol/sdk/types.js"

import {
  CallToolResultSchema,
  ReadResourceResultSchema,
  type CallToolResult,
  type McpAppView,
  type ReadResourceResult,
} from "../../protocol/mcp-apps"
import { isHttpsOrLoopback } from "../config"
import { createMcpServerCache } from "../core/mcp-server-cache"
import { MCP_APP_MIME_TYPE, sanitizeCsp, sanitizePermissions } from "./policy"

/** The largest UI resource a view is served from. */
export const MAX_MCP_APP_HTML_BYTES = 2 * 1024 * 1024
const MAX_TOOL_PAGES = 20
const IDLE_CLOSE_MS = 5 * 60_000

/** A view's resource, validated: its HTML and the `_meta.ui` it declared. */
export type McpAppResource = Pick<
  McpAppView,
  "html" | "csp" | "permissions" | "prefersBorder"
>

/** One MCP server: the name the runtime reports for it, and its Streamable HTTP URL. */
export type McpAppEndpoint = { name: string; url: string }

/**
 * What the operator configured for one MCP server: a `url` the proxy connects
 * to instead of the one the runtime reports, and request headers that replace
 * whatever credentials the runtime holds.
 */
export type McpServerOverride = {
  url?: string
  headers?: Readonly<Record<string, string>>
}

/** Operator overrides keyed by the server name the runtime reports. */
export type McpServerOverrides = ReadonlyMap<string, McpServerOverride>

/** The proxy's own MCP client, one pooled connection per server and URL. */
export type McpAppClient = {
  /** Whether the operator configured headers for this server name. */
  credentialed(server: string): boolean
  /** `tools/list`, cached per server. */
  tools(server: McpAppEndpoint): Promise<readonly Tool[]>
  /** `tools/list` after a lookup miss, refetched at most once per window. */
  refreshTools(server: McpAppEndpoint): Promise<readonly Tool[]>
  /** An App's UI resource; anything but `text/html;profile=mcp-app` is refused. */
  appResource(server: McpAppEndpoint, uri: string): Promise<McpAppResource>
  readResource(server: McpAppEndpoint, uri: string): Promise<ReadResourceResult>
  callTool(
    server: McpAppEndpoint,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>
  close(): Promise<void>
}

export class McpAppResourceError extends Error {
  constructor(reason: string) {
    super(`MCP App resource refused: ${reason}`)
    this.name = "McpAppResourceError"
  }
}

/** Configured headers never travel in the clear beyond this machine. */
export class McpAppConnectionRefusedError extends Error {
  constructor() {
    super("MCP server connection refused: credentials need HTTPS or loopback")
    this.name = "McpAppConnectionRefusedError"
  }
}

type Pooled = { client: Promise<Client>; timer?: ReturnType<typeof setTimeout> }

/** A server's pool and cache key: its name picks the headers, so both count. */
const keyOf = ({ name, url }: McpAppEndpoint) => JSON.stringify([name, url])

function endpointOf(key: string): McpAppEndpoint {
  const [name, url] = JSON.parse(key) as [string, string]
  return { name, url }
}

export function createMcpAppClient(
  options: { fetch?: typeof fetch; servers?: McpServerOverrides } = {}
): McpAppClient {
  const overrides: McpServerOverrides = options.servers ?? new Map()
  const pool = new Map<string, Pooled>()

  function drop(key: string, pooled: Pooled) {
    if (pool.get(key) !== pooled) return
    pool.delete(key)
    clearTimeout(pooled.timer)
    void pooled.client.then((client) => client.close()).catch(() => undefined)
  }

  async function open({ name, url }: McpAppEndpoint) {
    const override = overrides.get(name)
    const target = new URL(override?.url ?? url)
    const headers = override?.headers
    if (headers && !isHttpsOrLoopback(target))
      throw new McpAppConnectionRefusedError()
    const client = new Client({ name: "aos-ui-proxy", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(target, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(headers ? { requestInit: { headers: { ...headers } } } : {}),
      })
    )
    return client
  }

  function connect(server: McpAppEndpoint): Promise<Client> {
    const key = keyOf(server)
    const existing = pool.get(key)
    const pooled: Pooled = existing ?? { client: open(server) }
    if (!existing) {
      pool.set(key, pooled)
      pooled.client.catch(() => drop(key, pooled))
    }
    clearTimeout(pooled.timer)
    pooled.timer = setTimeout(() => drop(key, pooled), IDLE_CLOSE_MS)
    pooled.timer.unref?.()
    return pooled.client
  }

  /** One request; a failed connection is dropped so the next call reconnects. */
  async function request<T>(
    server: McpAppEndpoint,
    run: (client: Client) => Promise<T>
  ) {
    const client = await connect(server)
    try {
      return await run(client)
    } catch (error) {
      // A JSON-RPC error is the server answering; anything else is the link.
      const key = keyOf(server)
      const pooled = pool.get(key)
      if (pooled && !(error instanceof McpError)) drop(key, pooled)
      throw error
    }
  }

  const toolCache = createMcpServerCache<Tool>((key) =>
    request(endpointOf(key), async (client) => {
      const tools: Tool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : {})
        tools.push(...result.tools)
        cursor = result.nextCursor
        if (!cursor) break
      }
      return tools
    })
  )

  async function readResource(server: McpAppEndpoint, uri: string) {
    const result = ReadResourceResultSchema.parse(
      await request(server, (client) => client.readResource({ uri }))
    )
    const bytes = result.contents.reduce(
      (total, entry) =>
        total +
        ("text" in entry ? Buffer.byteLength(entry.text) : entry.blob.length),
      0
    )
    if (bytes > MAX_MCP_APP_HTML_BYTES) throw new McpAppResourceError("size")
    return result
  }

  return {
    credentialed: (server) => overrides.get(server)?.headers !== undefined,
    tools: (server) => toolCache.get(keyOf(server)),
    refreshTools: (server) => toolCache.refresh(keyOf(server)),
    readResource,
    async appResource(server, uri) {
      const { contents } = await readResource(server, uri)
      const entry = contents.find((candidate) => candidate.uri === uri)
      if (!entry || entry.mimeType !== MCP_APP_MIME_TYPE)
        throw new McpAppResourceError("mime type")
      const html =
        "text" in entry
          ? entry.text
          : Buffer.from(entry.blob, "base64").toString("utf8")
      const ui = entry._meta?.ui
      const meta =
        typeof ui === "object" && ui !== null
          ? (ui as Record<string, unknown>)
          : {}
      const csp = sanitizeCsp(meta.csp)
      const permissions = sanitizePermissions(meta.permissions)
      return {
        html,
        ...(csp ? { csp } : {}),
        ...(permissions ? { permissions } : {}),
        ...(typeof meta.prefersBorder === "boolean"
          ? { prefersBorder: meta.prefersBorder }
          : {}),
      }
    },
    async callTool(server, name, args) {
      return CallToolResultSchema.parse(
        await request(server, (client) =>
          client.callTool({ name, arguments: args })
        )
      )
    },
    async close() {
      for (const [key, pooled] of [...pool]) drop(key, pooled)
    },
  }
}
