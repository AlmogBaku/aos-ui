"use client"

import type { ComponentProps } from "react"
import { CheckIcon, Loader2Icon } from "lucide-react"

import { take } from "@/components/assistant-ui/utils/range"
import { mono, paper } from "@/lib/surfaces"
import { cn } from "@/lib/utils"

export function TerminalBlock({
  command,
  lines,
  visibleCount,
  done,
  variant = "paper",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "command" | "lines" | "visibleCount" | "done" | "variant"
> & {
  command: string
  lines: readonly string[]
  visibleCount: number
  done: boolean
  variant?: "paper" | "ink"
}) {
  const ink = variant === "ink"

  return (
    <div
      data-slot="terminal-block"
      className={cn(
        ink ? "bg-foreground dark:bg-popover" : paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5">
        <span
          className={cn(
            "min-w-0 truncate",
            ink
              ? "text-background/90 dark:text-foreground/90"
              : "text-foreground/90"
          )}
        >
          {command}
        </span>
        {done ? (
          <div className="flex shrink-0 items-center gap-1">
            <CheckIcon className="size-3 text-success" />
            <span
              className={cn(
                mono,
                ink
                  ? "text-background/40 dark:text-foreground/40"
                  : "text-foreground/40"
              )}
            >
              exit 0
            </span>
          </div>
        ) : (
          <Loader2Icon
            className={cn(
              "size-3 shrink-0 animate-spin motion-reduce:animate-none",
              ink
                ? "text-background/35 dark:text-foreground/35"
                : "text-foreground/35"
            )}
          />
        )}
      </div>
      <div
        className={cn(
          "flex min-h-[8.5rem] flex-col gap-1 overflow-x-auto px-4 pt-1 pb-3.5",
          ink
            ? "text-background/55 dark:text-foreground/50"
            : "text-foreground/50"
        )}
      >
        {take(lines, visibleCount).map((line, index) => {
          const isLast = index === lines.length - 1
          return (
            <div
              key={`${index}-${line}`}
              className={cn(
                "animate-in whitespace-pre duration-300 fill-mode-both fade-in",
                isLast &&
                  (ink
                    ? "text-background/90 dark:text-foreground/90"
                    : "text-foreground/90")
              )}
            >
              {line}
            </div>
          )
        })}
        {!done ? (
          <span
            aria-hidden
            className="inline-block h-3 w-1.5 animate-pulse bg-primary/70 motion-reduce:animate-none"
          />
        ) : null}
      </div>
    </div>
  )
}
