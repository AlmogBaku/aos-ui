import {
  canonicalToolName as canonicalMcpToolName,
  type McpToolNameResolver,
} from "../../core/aos-tool-names"
import type { McpToolNameScheme } from "../../mcp-apps/tool-names"

/** OpenCode's native tool names AOS renames. */
export const OPENCODE_CANONICAL_TOOL_NAMES = new Map<string, string>([
  ["task", "delegate_subagent"],
])

const NO_MCP_TOOLS: McpToolNameResolver = () => undefined

/**
 * The public name of a native tool: the `aos-ui` MCP server's tools read under
 * their bare AOS names, and another MCP tool `resolve` recognizes reads as
 * `mcp__<server>__<tool>` under its original names.
 */
export function canonicalOpenCodeToolName(
  name: string,
  resolve: McpToolNameResolver = NO_MCP_TOOLS
) {
  return (
    OPENCODE_CANONICAL_TOOL_NAMES.get(name) ??
    canonicalMcpToolName(name, resolve)
  )
}

/** OpenCode keeps `[A-Za-z0-9_-]` of a server or tool name and turns the rest to `_`. */
export function sanitizeOpenCodeMcpName(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_")
}

/** OpenCode registers an MCP tool as `<server>_<tool>`, both sanitized. */
export const OPENCODE_MCP_TOOL_NAMES: McpToolNameScheme = {
  format: (server, tool) =>
    `${sanitizeOpenCodeMcpName(server)}_${sanitizeOpenCodeMcpName(tool)}`,
  prefix: (server) => `${sanitizeOpenCodeMcpName(server)}_`,
  candidate: (rawName) => rawName.includes("_"),
}

/**
 * Projects one native tool call onto the canonical vocabulary AOS emits.
 *
 * Renaming alone is not enough for the delegation tool: OpenCode reports the
 * child's outcome as plain text, while the canonical activity result carries a
 * `summary`. Every other name, and every other result shape, passes through.
 */
export function canonicalOpenCodeToolCall<Args, Result>(
  name: string,
  args: Args,
  result: Result,
  resolve?: McpToolNameResolver
): { toolName: string; args: Args; result: Result | { summary: string } } {
  const toolName = canonicalOpenCodeToolName(name, resolve)
  const summary =
    toolName === "delegate_subagent" && typeof result === "string"
      ? result.trim()
      : ""
  return { toolName, args, result: summary ? { summary } : result }
}
