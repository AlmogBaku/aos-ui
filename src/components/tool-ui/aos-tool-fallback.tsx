"use client"

import { useState } from "react"

import { ToolCall } from "@/components/assistant-ui/elements/tool-call"

import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import { safeToolPresentation } from "./safe-presentation"
import {
  toolIconForName,
  toolIconKind,
  toolPrimaryArgument,
} from "./tool-call-presentation"
import type { RichToolFallbackComponent } from "./types"

/**
 * Safe AOS presentation for tool calls without a provider-supplied rich UI.
 *
 * The assistant-ui toolkit owns known rich call UIs. This component is the
 * deliberately inspectable boundary for every remaining call, including
 * unknown, errored, interrupted, and provider-specific calls.
 */
export const AosToolFallback: RichToolFallbackComponent = (part) => {
  const [open, setOpen] = useState(false)
  const state = normalizeRichToolState(part)
  const { labels, locale } = useToolUiLocale()
  const displayState =
    state.phase === "complete" || state.phase === "answered"
      ? "complete"
      : state.phase === "running" || state.phase === "submitting"
        ? "running"
        : state.phase === "pending"
          ? "attention"
          : state.phase === "cancelled"
            ? "cancelled"
            : "failed"
  const request = safeToolPresentation(part.args).text
  const result = safeToolPresentation(part.result).text
  const action = labels.assistant.toolActions[toolIconKind(part.toolName)]
  const query = toolPrimaryArgument(part.toolName, part.args)

  return (
    <ToolCall
      label={action.complete}
      activeLabel={action.active}
      requestLabel={locale === "he" ? "בקשה" : "Request"}
      resultLabel={locale === "he" ? "תוצאה" : "Result"}
      query={query}
      request={request}
      result={result}
      running={state.phase === "running" || state.phase === "submitting"}
      state={displayState}
      open={open}
      onOpenChange={setOpen}
      icon={toolIconForName(part.toolName)}
    />
  )
}
