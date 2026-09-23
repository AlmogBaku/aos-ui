import {
  isMcpAppCspDomain,
  McpUiCspSchema,
  McpUiPermissionsSchema,
  type McpUiCsp,
  type McpUiPermissions,
} from "../../protocol/mcp-apps"

/**
 * The MCP Apps rules the proxy enforces for a view (spec 2026-01-26). Pure, so
 * every rule reads the same whichever runtime and transport a call came from.
 */

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

type ToolMeta = { _meta?: Record<string, unknown> | undefined }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A `ui://` URI; the only resources a view may name. */
export function isUiResourceUri(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("ui://") && value.length > 5
  )
}

/** The view a tool (or a stored result) declares, from `_meta.ui.resourceUri`. */
export function declaredResourceUri(carrier: unknown): string | undefined {
  const meta = record(record(carrier)?._meta)
  const uri = record(meta?.ui)?.resourceUri ?? meta?.["ui/resourceUri"]
  return isUiResourceUri(uri) ? uri : undefined
}

/** Who may call a tool; `["model","app"]` when the tool declares nothing. */
export function toolVisibility(tool: ToolMeta): readonly string[] {
  const visibility = record(record(tool._meta)?.ui)?.visibility
  return Array.isArray(visibility) &&
    visibility.every((entry) => typeof entry === "string")
    ? visibility
    : ["model", "app"]
}

export function isAppVisible(tool: ToolMeta) {
  return toolVisibility(tool).includes("app")
}

/**
 * Splits a canonical `mcp__<server>__<tool>` name against the configured
 * servers, longest name first so a server whose name extends another's wins.
 */
export function splitCanonicalMcpName(
  toolName: string,
  serverNames: readonly string[]
): { server: string; tool: string } | undefined {
  const byLength = [...serverNames].sort((a, b) => b.length - a.length)
  for (const server of byLength) {
    const prefix = `mcp__${server}__`
    if (toolName.startsWith(prefix) && toolName.length > prefix.length)
      return { server, tool: toolName.slice(prefix.length) }
  }
  return undefined
}

/** A resource's `_meta.ui.csp` with every invalid origin dropped. */
export function sanitizeCsp(value: unknown): McpUiCsp | undefined {
  const parsed = McpUiCspSchema.safeParse(value)
  if (!parsed.success) return undefined
  const csp: McpUiCsp = {}
  for (const [key, domains] of Object.entries(parsed.data) as Array<
    [keyof McpUiCsp, string[] | undefined]
  >) {
    const valid = domains?.filter((domain) => isMcpAppCspDomain(key, domain))
    if (valid?.length) csp[key] = valid
  }
  return csp
}

export function sanitizePermissions(
  value: unknown
): McpUiPermissions | undefined {
  const parsed = McpUiPermissionsSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
