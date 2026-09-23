"use client"

import type { ToolCallMessagePart } from "@assistant-ui/react"
import { useEffect, useState } from "react"

import { useToolUiLocale } from "./locale"
import {
  formatToolDuration,
  formatToolLocation,
} from "./tool-call-presentation"
import type { AosDiffStats, AosToolLocation } from "./tool-artifact"

type ToolTiming = ToolCallMessagePart["timing"]

/**
 * A tool call's elapsed time from its `timing`, ticking once a second while it
 * runs. Unlike `useToolCallElapsed` it needs no part scope, so a run group
 * that renders its parts itself can time each one.
 */
export function useToolElapsedMs(
  timing: ToolTiming,
  running: boolean
): number | undefined {
  const live = timing !== undefined && timing.completedAt === undefined
  const ticking = live && running
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [ticking])
  if (timing === undefined) return undefined
  if (timing.completedAt !== undefined)
    return Math.max(0, timing.completedAt - timing.startedAt)
  return ticking ? Math.max(0, now - timing.startedAt) : undefined
}

/** "+42 −7", read aloud as "42 lines added, 7 removed". */
export function ToolDiffStat({ stats }: { stats: AosDiffStats }) {
  const { labels } = useToolUiLocale()
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs leading-4 tabular-nums">
      <span className="sr-only">
        {labels.diff.lineStats(stats.additions, stats.deletions)}
      </span>
      <bdi dir="ltr" aria-hidden="true" className="inline-flex gap-1">
        <span className="text-success">+{stats.additions}</span>
        <span className="text-destructive">−{stats.deletions}</span>
      </bdi>
    </span>
  )
}

/** A tool row's quiet facts: extra locations, line changes, duration. */
export function ToolRowMeta({
  moreLocations,
  stats,
  elapsedMs,
}: {
  moreLocations: number
  stats?: AosDiffStats
  elapsedMs?: number
}) {
  const { labels } = useToolUiLocale()
  return (
    <>
      {moreLocations > 0 ? (
        <span className="shrink-0 text-xs leading-4 text-foreground/45 tabular-nums">
          {labels.assistant.moreLocations(moreLocations)}
        </span>
      ) : null}
      {stats && (stats.additions > 0 || stats.deletions > 0) ? (
        <ToolDiffStat stats={stats} />
      ) : null}
      {elapsedMs !== undefined ? (
        <span className="shrink-0 text-xs leading-4 text-foreground/45 tabular-nums">
          {formatToolDuration(elapsedMs, labels.assistant.duration)}
        </span>
      ) : null}
    </>
  )
}

/** Every location a tool call touched, as left-to-right path chips. */
export function ToolLocationList({
  locations,
}: {
  locations: readonly AosToolLocation[]
}) {
  const { labels } = useToolUiLocale()
  if (locations.length === 0) return null
  return (
    <ul
      aria-label={labels.assistant.toolLocations}
      className="mt-2 flex min-w-0 flex-wrap gap-1.5"
    >
      {locations.map((location, index) => {
        const text = formatToolLocation(location)
        return (
          <li
            key={`${text}:${index}`}
            className="max-w-full min-w-0 truncate rounded-md bg-foreground/[0.06] px-1 py-px font-mono text-xs leading-4 text-foreground/70"
            title={text}
          >
            <bdi dir="ltr">{text}</bdi>
          </li>
        )
      })}
    </ul>
  )
}
