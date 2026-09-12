"use client"

import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react"
import { useId, type ReactNode } from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { collapsePanel, ShimmerLabel, SwapLabel } from "@/lib/surfaces"
import { take } from "../utils/range"
import { DisclosureChevron } from "./disclosure-chevron"

export interface TimelineStep {
  verb: string
  chip: string
  icon: LucideIcon
}
export interface TimelineStat {
  file: string
  added?: number
  removed?: number
}
export type ToolTimelineState = "complete" | "running" | "attention" | "failed"

export interface ToolTimelineProps {
  steps: readonly TimelineStep[]
  visibleSteps: number
  streaming: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  restingLabel: string
  activeLabel: string
  state: ToolTimelineState
  statusLabel: string
  stats: TimelineStat[]
  className?: string
  collapsible?: boolean
  details?: ReactNode
}

export function ToolTimeline({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  state,
  statusLabel,
  stats,
  className,
  collapsible = true,
  details,
}: ToolTimelineProps) {
  const statusDescriptionId = useId()
  const label = (
    <SwapLabel active={streaming ? 0 : 1} className="text-start tabular-nums">
      <ShimmerLabel
        active={streaming}
        className="relative inline-block leading-none"
      >
        {activeLabel}
      </ShimmerLabel>
      <>{restingLabel}</>
    </SwapLabel>
  )
  const StatusIcon =
    state === "complete"
      ? CheckIcon
      : state === "attention"
        ? CircleAlertIcon
        : state === "failed"
          ? CircleXIcon
          : LoaderCircleIcon
  const statusIcon = (
    <StatusIcon
      aria-hidden="true"
      data-slot="tool-timeline-status"
      data-status={state}
      className={cn(
        "size-3.5 shrink-0",
        state === "complete" && "text-emerald-500",
        state === "attention" && "text-amber-500",
        state === "failed" && "text-destructive",
        state === "running" &&
          "text-foreground/35 motion-safe:animate-spin motion-reduce:animate-none"
      )}
    />
  )
  const stepContent = (
    <>
      {take(steps, visibleSteps).map((step, index, shown) => {
        const Icon = step.icon
        return (
          <div
            key={`${step.chip}-${index}`}
            className="flex animate-in items-center gap-1.5 text-xs text-foreground/55 duration-300 fill-mode-both fade-in slide-in-from-bottom-1"
          >
            <Icon className="size-3.5 shrink-0 text-foreground/35" />
            <ShimmerLabel
              active={streaming && index === shown.length - 1}
              className="relative inline-block leading-none"
            >
              {step.verb}
            </ShimmerLabel>
            <span className="rounded-md bg-foreground/[0.06] px-1 py-px font-mono text-xs leading-4 text-foreground/70">
              {step.chip}
            </span>
          </div>
        )
      })}
      {stats.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {stats.map((stat) => (
            <span
              key={stat.file}
              className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.06] px-1 py-px font-mono text-xs leading-4 text-foreground/70"
            >
              <span>{stat.file}</span>
              {stat.added !== undefined && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{stat.added}
                </span>
              )}
              {stat.removed !== undefined && (
                <span className="text-red-600 dark:text-red-400">
                  −{stat.removed}
                </span>
              )}
            </span>
          ))}
        </div>
      )}
    </>
  )
  const content = (
    <div className="flex min-w-0 flex-col gap-0.5 ps-2 pt-0.5">
      {details ?? stepContent}
    </div>
  )
  if (!collapsible)
    return (
      <div
        data-slot="tool-timeline"
        data-status={state}
        className={cn("w-full max-w-none min-w-0", className)}
      >
        <div className="flex items-center gap-1 rounded-md py-0 text-sm leading-4 text-foreground/55">
          {label}
          {statusIcon}
        </div>
        <span id={statusDescriptionId} className="sr-only">
          {statusLabel}
        </span>
        {content}
      </div>
    )
  return (
    <Collapsible
      data-slot="tool-timeline"
      data-status={state}
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-none min-w-0", className)}
    >
      <CollapsibleTrigger
        aria-describedby={statusDescriptionId}
        className="group/trigger flex items-center gap-1 rounded-md py-0 text-sm leading-4 text-foreground/55 transition-colors hover:text-foreground/90"
      >
        {label}
        {statusIcon}
        <DisclosureChevron
          data-slot="tool-timeline-chevron"
          className="ms-1 opacity-60"
        />
      </CollapsibleTrigger>
      <span id={statusDescriptionId} className="sr-only">
        {statusLabel}
      </span>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {content}
      </CollapsibleContent>
    </Collapsible>
  )
}
