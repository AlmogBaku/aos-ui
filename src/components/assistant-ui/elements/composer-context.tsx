"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function ComposerContext({
  usedTokens,
  maxTokens,
  estimated = false,
  label,
  className,
}: {
  usedTokens: number
  maxTokens: number
  estimated?: boolean | undefined
  label: string
  className?: string | undefined
}) {
  const percentage = Math.min(100, Math.max(0, (usedTokens / maxTokens) * 100))
  const nearLimit = percentage >= 85

  return (
    <div
      data-slot="composer-context"
      className={cn("shrink-0", className)}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-slot="composer-context-trigger"
                aria-label={label}
                className={cn(
                  "grid size-11 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none @min-[64rem]/workspace:hidden",
                  nearLimit && "text-destructive hover:text-destructive"
                )}
              />
            }
          >
            <svg
              data-slot="composer-context-ring"
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-5 -rotate-90"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="opacity-20"
              />
              <circle
                cx="12"
                cy="12"
                r="9"
                pathLength="100"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray="100"
                strokeDashoffset={100 - percentage}
              />
            </svg>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span
        aria-hidden="true"
        className="hidden tabular-nums @min-[64rem]/workspace:inline"
        dir="ltr"
      >
        {estimated ? "~" : ""}
        {usedTokens.toLocaleString("en-US")} /{" "}
        {maxTokens.toLocaleString("en-US")}
      </span>
    </div>
  )
}
