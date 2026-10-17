"use client"

import {
  useAuiState,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react"
import { useMemo, type ReactNode } from "react"

import { DisclosureChevron } from "@/components/assistant-ui/elements/disclosure-chevron"
import { useRememberedDisclosure } from "@/components/assistant-ui/elements/disclosure-memory"
import { createToolPartSelector } from "@/components/assistant-ui/elements/message-tool-experience"
import { partsAt } from "@/components/assistant-ui/elements/turn-fold"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { readAosToolArtifact } from "@/lib/tool-artifact"
import { collapsePanel } from "@/lib/surfaces"
import { cn } from "@/lib/utils"

import { activityStatusOf } from "./activity"
import {
  useToolUiLocale,
  type ToolUiActivityStatus,
  type ToolUiLocaleLabels,
} from "./locale"
import { isActiveStatus, longestSpan, subagentSpan } from "./subagent-status"
import { formatToolDuration } from "./tool-call-presentation"
import { useToolElapsedMs } from "./tool-row-meta"

const COUNT_ORDER: readonly ToolUiActivityStatus[] = [
  "running",
  "waiting",
  "completed",
  "failed",
  "unknown",
]

/** How many of `statuses` are in each state, in reading order, none for zero. */
export function subagentCounts(
  statuses: readonly ToolUiActivityStatus[],
  labels: ToolUiLocaleLabels
) {
  return COUNT_ORDER.flatMap((status) => {
    const count = statuses.filter((each) => each === status).length
    return count === 0
      ? []
      : [{ status, text: labels.subagentGroup.counts[status](count) }]
  })
}

/** The counts as one quiet line, a failure keeping its color. */
export function SubagentCounts({
  counts,
}: {
  counts: ReturnType<typeof subagentCounts>
}) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-1.5">
      {counts.map(({ status, text }, index) => (
        <span
          key={status}
          className={cn(status === "failed" && "text-destructive")}
        >
          {index > 0 ? <span aria-hidden="true">· </span> : null}
          {text}
        </span>
      ))}
    </span>
  )
}

/** Subagent rows in one bordered list. */
export function SubagentList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {children}
    </ul>
  )
}

/**
 * A run of consecutive subagent rows. A batch reads under one header that
 * counts each child by its own state and says how long the batch has worked;
 * it stays open while a child runs or waits, and the reader's own open or
 * close wins. A run of one is its row alone.
 */
export function SubagentGroup({
  renderTool,
  indices,
}: {
  renderTool: ToolCallMessagePartComponent
  /** Source-part positions of the run, in order. */
  indices: readonly number[]
}) {
  const selectParts = useMemo(() => createToolPartSelector(() => true), [])
  const parts = useAuiState((state) =>
    selectParts(partsAt(state.message.parts, indices))
  )
  const { direction, labels, locale } = useToolUiLocale()
  const statuses = parts.map(activityStatusOf)
  const counts = subagentCounts(statuses, labels)
  const active = statuses.some(isActiveStatus)
  const [chosenOpen, setOpen] = useRememberedDisclosure(
    `subagents:${parts[0]?.toolCallId ?? indices[0] ?? 0}`
  )
  const elapsedMs = useToolElapsedMs(
    longestSpan(
      parts.map((part, index) =>
        subagentSpan(
          part,
          readAosToolArtifact(part.artifact)?.subagent,
          isActiveStatus(statuses[index]!)
        )
      )
    ),
    active
  )
  const RenderTool = renderTool
  const rows = (
    <SubagentList>
      {parts.map((part) => (
        <li key={part.toolCallId}>
          <RenderTool {...part} />
        </li>
      ))}
    </SubagentList>
  )
  if (parts.length === 0) return null
  if (parts.length === 1) return <div className="-mx-2 py-2">{rows}</div>
  return (
    <Collapsible
      className="-mx-2 py-2"
      open={chosenOpen ?? active}
      onOpenChange={setOpen}
      dir={direction}
      lang={locale}
    >
      <CollapsibleTrigger className="group/trigger flex w-full min-w-0 items-center gap-2 rounded-xl px-1 pb-2 text-start text-sm text-muted-foreground outline-none not-data-panel-open:border not-data-panel-open:border-border not-data-panel-open:bg-card not-data-panel-open:px-3.5 not-data-panel-open:py-2 focus-visible:ring-2 focus-visible:ring-ring">
        <DisclosureChevron />
        <span className="font-medium whitespace-nowrap text-foreground">
          {labels.subagentGroup.title(parts.length)}
        </span>
        <SubagentCounts counts={counts} />
        {elapsedMs === undefined ? null : (
          <span className="ms-auto shrink-0 text-xs tabular-nums">
            {formatToolDuration(elapsedMs, labels.assistant.duration)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={collapsePanel}>{rows}</CollapsibleContent>
    </Collapsible>
  )
}
