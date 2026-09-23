/** The tools the `aos-ui` MCP server exposes, as the browser names them. */
const AOS_TOOLS = new Set([
  "render_chart",
  "render_map",
  "render_stats",
  "present_artifact",
])

/**
 * The `aos-ui` tools under whatever prefix a harness gives an MCP tool:
 * `mcp__aos_ui__render_chart`, `aos-ui_render_chart`, and their
 * hyphen/underscore variants all name `render_chart`.
 */
const AOS_TOOL_NAME = new RegExp(
  `^(?:mcp__)?aos[-_]ui(?:__|_)(${[...AOS_TOOLS].join("|")})$`,
  "u"
)

/** How a harness's configuration may name the `aos-ui` server. */
const AOS_UI_SERVER = /^aos[-_]ui$/u

/** The bare AOS tool a prefixed MCP tool name refers to, if it is one. */
export function canonicalAosToolName(raw: string): string | undefined {
  return AOS_TOOL_NAME.exec(raw)?.[1]
}

/** Whether a canonical name is one of the bare `aos-ui` tools. */
export function isAosToolName(toolName: string): boolean {
  return AOS_TOOLS.has(toolName)
}

/** Whether a configured MCP server is the `aos-ui` server its bare tools belong to. */
export function isAosUiServerName(server: string): boolean {
  return AOS_UI_SERVER.test(server)
}

/** Splits a harness's raw MCP tool name into its server and tool, if it is one. */
export type McpToolNameResolver = (
  rawName: string
) => { server: string; tool: string } | undefined

/** The canonical name of an MCP tool outside the `aos-ui` server. */
export function formatMcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/**
 * The name the browser sees: the bare tool for an `aos-ui` tool,
 * `mcp__server__tool` for any other MCP tool the resolver recognizes, and the
 * raw name otherwise.
 */
export function canonicalToolName(
  rawName: string,
  resolve: McpToolNameResolver
): string {
  const aosTool = canonicalAosToolName(rawName)
  if (aosTool) return aosTool
  const mcpTool = resolve(rawName)
  return mcpTool ? formatMcpToolName(mcpTool.server, mcpTool.tool) : rawName
}
