"use client"

import { useAuiState, useMessageTiming } from "@assistant-ui/react"
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

import { useToolUiLocale } from "@/components/tool-ui/locale"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { collapsePanel, ShimmerLabel } from "@/lib/surfaces"
import { cn } from "@/lib/utils"
import { DisclosureChevron } from "./disclosure-chevron"
import {
  describeToolRun,
  formatTurnDuration,
  isFoldablePart,
  partsAt,
  turnOutcome,
} from "./turn-fold"

/**
 * Whether the surrounding surface is a settled turn's fold. A fold is one
 * disclosure over the whole run, so the groups inside it render their rows
 * already open and its prose renders as trace rather than as an answer.
 */
const InsideTurnFoldContext = createContext(false)

export function useInsideTurnFold() {
  return useContext(InsideTurnFoldContext)
}

const TRACE_ROW =
  "flex items-center gap-1 rounded-md py-0 text-start text-sm leading-4 text-foreground/55"

/**
 * The single disclosure a settled turn collapses its work into. Its contents
 * stay in provider order, and the header says how long the turn took — or, for
 * a run a first-class part split off, what that run did.
 */
export function TurnWorkingFold({
  indices,
  children,
}: {
  /** Source-part positions this fold covers, in order. */
  indices: readonly number[]
  children: ReactNode
}) {
  const { labels, locale } = useToolUiLocale()
  const [open, setOpen] = useState(false)
  const timing = useMessageTiming()
  const outcome = useAuiState((state) => turnOutcome(state.message.status))
  const start = indices[0] ?? 0
  // Only the run that opens the turn's work reports the turn's duration; a run
  // a first-class part split off continues it and names what it ran instead.
  const continues = useAuiState((state) =>
    state.message.parts
      .slice(0, start)
      .some((part) => isFoldablePart(part, { toolUIs: state.tools.toolUIs }))
  )
  const ran = useAuiState((state) =>
    continues
      ? describeToolRun(
          partsAt(state.message.parts, indices).filter(
            (part) => part.type === "tool-call"
          ),
          labels.assistant.toolRun,
          locale
        )
      : ""
  )
  const duration =
    timing?.totalStreamTime === undefined
      ? undefined
      : formatTurnDuration(timing.totalStreamTime, labels.assistant.duration)

  return (
    <Collapsible
      data-slot="turn-working-fold"
      open={open}
      onOpenChange={setOpen}
      className="my-1.5 w-full max-w-none min-w-0"
    >
      <CollapsibleTrigger
        className={cn(
          TRACE_ROW,
          "group/trigger transition-colors hover:text-foreground/90"
        )}
      >
        <span className="tabular-nums">
          {ran || labels.assistant.fold[outcome](duration)}
        </span>
        <DisclosureChevron className="ms-1 opacity-60" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div className="flex min-w-0 flex-col gap-0.5 ps-2 pt-0.5">
          <InsideTurnFoldContext.Provider value={true}>
            {children}
          </InsideTurnFoldContext.Provider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The live counterpart of the fold: while the turn runs nothing collapses, so
 * the elapsed time is all the header can offer. The second-by-second count is a
 * progress hint rather than an announcement, so it stays out of the live region.
 */
export function TurnWorkingStatus() {
  const { labels } = useToolUiLocale()
  const running = useAuiState(
    (state) => state.message.status?.type === "running"
  )
  const working = useAuiState((state) =>
    state.message.parts.some(
      (part) => part.type === "reasoning" || part.type === "tool-call"
    )
  )
  const startedAt = useMessageTiming()?.streamStartTime
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!running || startedAt === undefined) return
    const tick = () => setElapsed(Date.now() - startedAt)
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [running, startedAt])

  if (!running || !working) return null
  return (
    <div data-slot="turn-working-status" className={cn(TRACE_ROW, "mb-1.5")}>
      <ShimmerLabel
        aria-live="off"
        className="inline-block leading-none tabular-nums"
      >
        {labels.assistant.fold.working(
          startedAt === undefined
            ? undefined
            : formatTurnDuration(elapsed, labels.assistant.duration)
        )}
      </ShimmerLabel>
    </div>
  )
}
