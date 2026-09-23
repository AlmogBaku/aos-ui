"use client"

import { AosToolError, AosToolFallback } from "./aos-tool-fallback"
import { normalizeRichToolState } from "./lifecycle"
import { RichToolRenderer, richToolRegistry } from "./registry"
import { readAosToolArtifact } from "./tool-artifact"
import type { RichToolFallbackComponent, RichToolPart } from "./types"

export function isAosRichTool(part: RichToolPart) {
  if (part.approval !== undefined) return true
  if (readAosToolArtifact(part.artifact)?.subagent) return true
  const registration = richToolRegistry[part.toolName]
  return registration?.validate(part).valid === true
}

/**
 * A failed call keeps its own view when that view explains the failure: a
 * terminal's exit, a diff, or a subagent's status.
 */
function explainsItsFailure(part: RichToolPart) {
  const artifact = readAosToolArtifact(part.artifact)
  return Boolean(
    artifact?.subagent || artifact?.terminals?.length || artifact?.diffs?.length
  )
}

/**
 * Preserves the semantic AOS views that have a registered, validated tool UI
 * while making every other provider call an inspectable native ToolCall.
 * Provider-supplied `toolUI` remains preferred by the message surface.
 */
export const AosToolPresentation: RichToolFallbackComponent = (part) => {
  if (
    normalizeRichToolState(part).phase === "failed" &&
    !explainsItsFailure(part)
  ) {
    return <AosToolError {...part} />
  }
  if (isAosRichTool(part)) {
    return <RichToolRenderer {...part} />
  }

  return <AosToolFallback {...part} />
}
