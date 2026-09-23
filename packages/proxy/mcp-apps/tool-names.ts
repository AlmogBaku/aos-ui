import {
  canonicalAosToolName,
  type McpToolNameResolver,
} from "../core/aos-tool-names"
import type { McpServerCache } from "../core/mcp-server-cache"
import type { McpAppClient } from "./client"
import type { McpAppServer } from "./fallback"

/**
 * Maps a harness's raw MCP tool names back to their server and tool. A harness
 * folds both into one sanitized name, so only the server's own `tools/list`
 * recovers a tool's original name; a server the proxy cannot list resolves to
 * whatever follows its prefix.
 */

/** One configured server, with its tool names when the proxy could list them. */
export type McpToolCatalogEntry = { name: string; tools?: readonly string[] }

/** How one harness spells an MCP tool's name. */
export type McpToolNameScheme = {
  /** The raw name the harness gives one tool. */
  format(server: string, tool: string): string
  /** The raw prefix every tool of one server starts with. */
  prefix(server: string): string
  /** Whether a raw name could be an MCP tool, so an unknown one earns a refetch. */
  candidate(rawName: string): boolean
}

export type McpToolNames = {
  /** The latest loaded names, read synchronously; an unknown candidate schedules a load. */
  resolver(key: string): McpToolNameResolver
  /** Loads the names, refetching once when any of `rawNames` stays unknown. */
  load(key: string, rawNames?: Iterable<string>): Promise<McpToolNameResolver>
}

type Lookup = (
  rawName: string
) => { server: string; tool: string; known: boolean } | undefined

function lookupOf(
  scheme: McpToolNameScheme,
  catalog: readonly McpToolCatalogEntry[]
): Lookup {
  const listed = new Map<string, { server: string; tool: string }>()
  for (const server of catalog)
    for (const tool of server.tools ?? [])
      listed.set(scheme.format(server.name, tool), {
        server: server.name,
        tool,
      })
  // Longest prefix first, so `a_b` wins over `a` for `a_b_tool`.
  const prefixes = catalog
    .map((server) => ({ server, prefix: scheme.prefix(server.name) }))
    .sort((left, right) => right.prefix.length - left.prefix.length)
  return (rawName) => {
    const hit = listed.get(rawName)
    if (hit) return { ...hit, known: true }
    const match = prefixes.find(
      ({ prefix }) =>
        rawName.startsWith(prefix) && rawName.length > prefix.length
    )
    return (
      match && {
        server: match.server.name,
        tool: rawName.slice(match.prefix.length),
        // A listed server that lacks the tool may have gained it since.
        known: match.server.tools === undefined,
      }
    )
  }
}

export function createMcpToolNames(
  scheme: McpToolNameScheme,
  catalog: (
    key: string,
    fresh: boolean
  ) => Promise<readonly McpToolCatalogEntry[]>
): McpToolNames {
  const lookups = new Map<string, Lookup>()

  const unknown = (lookup: Lookup | undefined, rawName: string) =>
    scheme.candidate(rawName) &&
    !canonicalAosToolName(rawName) &&
    !lookup?.(rawName)?.known

  const resolverOf =
    (lookup: Lookup | undefined): McpToolNameResolver =>
    (rawName) => {
      const found = lookup?.(rawName)
      return found && { server: found.server, tool: found.tool }
    }

  async function loaded(key: string, fresh: boolean) {
    try {
      const lookup = lookupOf(scheme, await catalog(key, fresh))
      lookups.set(key, lookup)
      return lookup
    } catch {
      // A catalog outage leaves names as they were rather than failing a read.
      return lookups.get(key)
    }
  }

  async function load(key: string, rawNames: Iterable<string> = []) {
    const names = [...rawNames]
    let lookup = await loaded(key, false)
    if (names.some((name) => unknown(lookup, name)))
      lookup = await loaded(key, true)
    return resolverOf(lookup)
  }

  return {
    resolver(key) {
      return (rawName) => {
        const lookup = lookups.get(key)
        if (unknown(lookup, rawName))
          void load(key, [rawName]).catch(() => undefined)
        return resolverOf(lookup)(rawName)
      }
    },
    load,
  }
}

/**
 * The catalog of one key's servers: every configured server, and the tool
 * names of each one the proxy may connect to. A server that fails to list
 * still resolves by its prefix.
 */
export function mcpToolCatalog(
  servers: McpServerCache<McpAppServer>,
  client: Pick<McpAppClient, "tools" | "refreshTools">
) {
  return async (key: string, fresh: boolean) =>
    Promise.all(
      (await (fresh ? servers.refresh(key) : servers.get(key))).map(
        async ({ name, url }): Promise<McpToolCatalogEntry> => {
          if (!url) return { name }
          try {
            const endpoint = { name, url }
            const tools = await (fresh
              ? client.refreshTools(endpoint)
              : client.tools(endpoint))
            return { name, tools: tools.map((tool) => tool.name) }
          } catch {
            return { name }
          }
        }
      )
    )
}
