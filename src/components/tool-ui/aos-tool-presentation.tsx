"use client"

import { McpAppCard } from "@/components/mcp-apps/mcp-app-card"
import { isMcpAppToolPart } from "@/components/mcp-apps/tool-part"

import { AosToolError, AosToolFallback } from "./aos-tool-fallback"
import { normalizeRichToolState } from "./lifecycle"
import { RichToolRenderer, richToolRegistry } from "./registry"
import type { RichToolFallbackComponent, RichToolPart } from "./types"

function isRegisteredRichTool(part: RichToolPart) {
  if (part.approval !== undefined) return true
  const registration = richToolRegistry[part.toolName]
  return registration?.validate(part).valid === true
}

/** A registered view or an MCP App: first-class content, never folded away. */
export function isAosRichTool(part: RichToolPart) {
  return isRegisteredRichTool(part) || isMcpAppToolPart(part)
}

/**
 * Preserves the semantic AOS views that have a registered, validated tool UI,
 * then hosts a call's declared MCP App view, and makes every other provider
 * call an inspectable native ToolCall. Provider-supplied `toolUI` remains
 * preferred by the message surface.
 */
export const AosToolPresentation: RichToolFallbackComponent = (part) => {
  if (normalizeRichToolState(part).phase === "failed") {
    return <AosToolError {...part} />
  }
  if (isRegisteredRichTool(part)) {
    return <RichToolRenderer {...part} />
  }
  if (isMcpAppToolPart(part)) {
    return <McpAppCard {...part} />
  }

  return <AosToolFallback {...part} />
}
