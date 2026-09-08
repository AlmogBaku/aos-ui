"use client"

import type { StatsPayload } from "./payloads/stats"

import { StatsDisplay } from "@/components/tool-ui/stats-display"

import { ToolChrome } from "./common"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart } from "./types"

export function StatsTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: StatsPayload
}) {
  const state = normalizeRichToolState(part)
  const stats = payload.result
  const { labels, locale } = useToolUiLocale()

  return (
    <ToolChrome
      title={payload.args.title ?? labels.toolNames.stats}
      state={state}
    >
      {stats ? (
        <StatsDisplay
          id={part.toolCallId}
          title={stats.title}
          description={stats.description}
          stats={stats.stats}
          locale={locale}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{labels.stats.waiting}</p>
      )}
    </ToolChrome>
  )
}
