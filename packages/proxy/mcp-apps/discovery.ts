import type { McpAppServer } from "./fallback"

/**
 * Which of a runtime's native MCP servers the proxy may dial itself, for
 * runtimes that keep no UI resources of their own. Each adapter reduces its
 * native entry to a `NativeMcpServer`; the reachability rule is shared.
 */

/** One native MCP server entry, reduced to what decides reachability. */
export type NativeMcpServer = {
  name: string
  /** On, and on the Streamable HTTP transport the proxy speaks. */
  dialable: boolean
  url?: string | null
  /** The native entry sends credentials of its own (auth, headers, OAuth). */
  credentials: boolean
}

/**
 * A dialable server that asks for no credentials, or whose credentials the
 * operator configured for the proxy, at an HTTP(S) URL.
 */
export function reachableUrl(
  server: NativeMcpServer,
  credentialed: (name: string) => boolean
): string | undefined {
  if (!server.dialable || !server.url) return
  if (server.credentials && !credentialed(server.name)) return
  try {
    const url = new URL(server.url)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

/** Every native server by name, with a URL only where the proxy may dial it. */
export function mcpServersFromNative(
  servers: readonly NativeMcpServer[],
  credentialed: (name: string) => boolean = () => false
): McpAppServer[] {
  return servers.map((server) => {
    const url = reachableUrl(server, credentialed)
    return { name: server.name, ...(url ? { url } : {}) }
  })
}
