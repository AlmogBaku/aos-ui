"use client"

import type { ComponentProps } from "react"
import { AlertCircleIcon, Loader2Icon, RotateCwIcon } from "lucide-react"

import { field, mono, paper } from "@/lib/surfaces"
import { cn } from "@/lib/utils"

export function ToolError({
  name,
  target,
  message,
  attempt,
  maxAttempts,
  retrying,
  onRetry,
  onSkip,
  retryLabel = "Retry",
  retryingLabel = "Retrying",
  skipLabel = "Skip",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "name"
  | "target"
  | "message"
  | "attempt"
  | "maxAttempts"
  | "retrying"
  | "onRetry"
  | "onSkip"
> & {
  name: string
  target: string
  message: string
  attempt: number
  maxAttempts: number
  retrying: boolean
  onRetry?: () => void
  onSkip?: () => void
  retryLabel?: string
  retryingLabel?: string
  skipLabel?: string
}) {
  return (
    <div
      data-slot="tool-error"
      className={cn(
        paper,
        "flex w-full max-w-none min-w-0 flex-col gap-3 rounded-2xl p-3.5",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5">
        <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" />
        <span className={cn(mono, "shrink-0 text-destructive")}>{name}</span>
        <bdi className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
          {target}
        </bdi>
        <span className={cn(mono, "shrink-0 text-foreground/30 tabular-nums")}>
          {attempt}/{maxAttempts}
        </span>
      </div>

      <div
        dir="auto"
        className={cn(
          field,
          "max-h-80 overflow-auto rounded-xl px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground/80"
        )}
      >
        {message}
      </div>

      {onRetry || onSkip ? (
        <div className="flex items-center justify-end gap-2">
          {onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              className="h-7 rounded-full px-2.5 text-xs font-medium text-foreground/45 transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96]"
            >
              {skipLabel}
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-foreground/70 transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/95 active:scale-[0.96] disabled:pointer-events-none"
            >
              {retrying ? (
                <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />
              ) : (
                <RotateCwIcon className="size-3" />
              )}
              {retrying ? retryingLabel : retryLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
