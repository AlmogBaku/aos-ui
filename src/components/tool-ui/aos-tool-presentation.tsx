"use client"

import { AosToolFallback } from "./aos-tool-fallback"
import { RichToolRenderer, richToolRegistry } from "./registry"
import type { RichToolFallbackComponent, RichToolPart } from "./types"

export function isAosRichTool(part: RichToolPart) {
  if (part.approval !== undefined) return true
  const registration = richToolRegistry[part.toolName]
  return registration?.validate(part).valid === true
}

/**
 * Preserves the semantic AOS views that have a registered, validated tool UI
 * while making every other provider call an inspectable native ToolCall.
 * Provider-supplied `toolUI` remains preferred by the message surface.
 */
export const AosToolPresentation: RichToolFallbackComponent = (part) => {
  if (isAosRichTool(part)) {
    return <RichToolRenderer {...part} />
  }

  return <AosToolFallback {...part} />
}
