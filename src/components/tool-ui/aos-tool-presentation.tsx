"use client"

import { McpAppCard } from "@/components/mcp-apps/mcp-app-card"
import { isMcpAppToolPart } from "@/components/mcp-apps/tool-part"

import {
  AosToolError,
  AosToolFallback,
  showsAsTerminal,
} from "./aos-tool-fallback"
import { normalizeRichToolState } from "./lifecycle"
import { RichToolRenderer, richToolRegistry } from "./registry"
import { readAosToolArtifact } from "./tool-artifact"
import type { RichToolFallbackComponent, RichToolPart } from "./types"

function isRegisteredRichTool(part: RichToolPart) {
  if (part.approval !== undefined) return true
  if (readAosToolArtifact(part.artifact)?.subagent) return true
  const registration = richToolRegistry[part.toolName]
  return registration?.validate(part).valid === true
}

/** A registered view or an MCP App: first-class content, never folded away. */
export function isAosRichTool(part: RichToolPart) {
  return isRegisteredRichTool(part) || isMcpAppToolPart(part)
}

/**
 * A failed call keeps its own view when that view explains the failure: a
 * terminal's exit, a command's output, a diff, or a subagent's status.
 */
function explainsItsFailure(part: RichToolPart) {
  const artifact = readAosToolArtifact(part.artifact)
  return (
    Boolean(
      artifact?.subagent ||
      artifact?.terminals?.length ||
      artifact?.diffs?.length
    ) || showsAsTerminal(part)
  )
}

/**
 * Preserves the semantic AOS views that have a registered, validated tool UI,
 * then hosts a call's declared MCP App view, and makes every other provider
 * call an inspectable native ToolCall. Provider-supplied `toolUI` remains
 * preferred by the message surface.
 */
export const AosToolPresentation: RichToolFallbackComponent = (part) => {
  if (
    normalizeRichToolState(part).phase === "failed" &&
    !explainsItsFailure(part)
  ) {
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
