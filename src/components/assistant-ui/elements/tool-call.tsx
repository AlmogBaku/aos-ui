"use client"

import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  type LucideIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { DisclosureChevron } from "./disclosure-chevron"
import {
  collapsePanel,
  field,
  mono,
  ShimmerLabel,
  SwapLabel,
} from "@/lib/surfaces"

export interface ToolCallProps {
  label: string
  activeLabel: string
  requestLabel?: string
  resultLabel?: string
  query: string
  /** A path or other machine text reads left to right in either locale. */
  queryDir?: "ltr" | "auto"
  /** Quiet facts after the subject: diff stats, extra locations, duration. */
  meta?: ReactNode
  request: string
  result: string
  details?: ReactNode
  running: boolean
  state: "complete" | "attention" | "failed" | "cancelled" | "running"
  collapsible?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  icon?: LucideIcon
  className?: string
}

export function ToolCall({
  label,
  activeLabel,
  requestLabel = "Request",
  resultLabel = "Result",
  query,
  queryDir = "auto",
  meta,
  request,
  result,
  details,
  running,
  state,
  collapsible = true,
  open,
  onOpenChange,
  icon: Icon,
  className,
}: ToolCallProps) {
  const header = (
    <>
      {Icon ? <Icon className="size-3.5 shrink-0 text-foreground/35" /> : null}
      <SwapLabel active={running ? 0 : 1} className="text-start">
        <ShimmerLabel
          active={running}
          className="relative inline-block leading-none"
        >
          {activeLabel}
        </ShimmerLabel>
        <>{label}</>
      </SwapLabel>
      <bdi
        dir={queryDir}
        title={query}
        className={cn(
          mono,
          "max-w-[min(18rem,55vw)] min-w-0 truncate rounded-md bg-foreground/[0.06] px-1 py-px text-xs leading-4 text-foreground/70"
        )}
      >
        {query}
      </bdi>
      {meta}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {state === "complete" ? (
          <CheckIcon className="size-3.5 animate-in text-emerald-500 duration-200 zoom-in-90 fade-in" />
        ) : null}
        {state === "attention" ? (
          <CircleAlertIcon className="size-3.5 text-amber-500" />
        ) : null}
        {state === "failed" || state === "cancelled" ? (
          <CircleXIcon className="size-3.5 text-destructive" />
        ) : null}
      </span>
      {collapsible ? (
        <DisclosureChevron data-slot="tool-call-chevron" className="ms-1" />
      ) : null}
    </>
  )
  const defaultDetails = (
    <ToolCallPayload
      requestLabel={requestLabel}
      resultLabel={resultLabel}
      request={request}
      result={result}
    />
  )

  if (!collapsible)
    return (
      <div
        data-slot="tool-call"
        data-tool-state={state}
        className={cn("w-full max-w-none min-w-0", className)}
      >
        <div className="flex min-w-0 items-center gap-1 rounded-md py-0 text-xs leading-4 text-foreground/55">
          {header}
        </div>
      </div>
    )

  return (
    <Collapsible
      data-slot="tool-call"
      data-tool-state={state}
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-none min-w-0", className)}
    >
      <CollapsibleTrigger className="group/trigger flex w-full min-w-0 items-center gap-1 rounded-md py-0 text-xs leading-4 text-foreground/55 transition-colors hover:text-foreground/90">
        {header}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {details ?? defaultDetails}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The call's request and result as inspectable text. */
export function ToolCallPayload({
  requestLabel,
  resultLabel,
  request,
  result,
}: {
  requestLabel: string
  resultLabel: string
  request: string
  result: string
}) {
  return (
    <div
      className={cn(
        field,
        "mt-2 max-w-full min-w-0 overflow-hidden rounded-2xl text-xs"
      )}
    >
      <div className="px-3.5 pt-2.5 pb-2">
        <p className={cn(mono, "mb-1 text-foreground/35")}>{requestLabel}</p>
        <p className="max-w-full overflow-x-auto font-mono [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-foreground/55">
          {request}
        </p>
      </div>
      <div className="mx-3.5 h-px bg-foreground/[0.06]" />
      <div className="px-3.5 pt-2 pb-2.5">
        <p className={cn(mono, "mb-1 text-foreground/35")}>{resultLabel}</p>
        <p className="max-w-full overflow-x-auto [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-foreground/90">
          {result}
        </p>
      </div>
    </div>
  )
}
