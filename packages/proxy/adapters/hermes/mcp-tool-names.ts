import { createHash } from "node:crypto"

import type { McpToolNameScheme } from "../../mcp-apps/tool-names"

/**
 * Hermes' MCP tool names, ported from `tools/mcp_tool_schema.py`
 * (`sanitize_mcp_name_component`, `mcp_prefixed_tool_name`): the raw name is
 * `mcp__<server>__<tool>` with both parts sanitized, clamped to 64 characters
 * by a stable hash suffix.
 */

const PREFIX = "mcp__"
const MAX_LENGTH = 64
const HASH_LENGTH = 8

/** Every character outside `[A-Za-z0-9_]`, hyphens included, becomes `_`. */
export function sanitizeHermesMcpName(value: string) {
  return value.replace(/[^A-Za-z0-9_]/gu, "_")
}

/** The name Hermes registers one MCP tool under. */
export function hermesMcpToolName(server: string, tool: string) {
  const full = `${PREFIX}${sanitizeHermesMcpName(server)}__${sanitizeHermesMcpName(tool)}`
  // Sanitized names are ASCII, so a UTF-16 length is Python's code-point length.
  if (full.length <= MAX_LENGTH) return full
  const suffix = `_${createHash("sha256").update(full, "utf8").digest("hex").slice(0, HASH_LENGTH)}`
  return full.slice(0, MAX_LENGTH - suffix.length) + suffix
}

export const HERMES_MCP_TOOL_NAMES: McpToolNameScheme = {
  format: hermesMcpToolName,
  prefix: (server) => `${PREFIX}${sanitizeHermesMcpName(server)}__`,
  candidate: (rawName) => rawName.startsWith(PREFIX),
}
