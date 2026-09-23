"use client"

import type { ComponentProps } from "react"
import { CheckIcon, CircleXIcon, Loader2Icon, SquareIcon } from "lucide-react"

import { mono, paper } from "@/lib/surfaces"
import { cn } from "@/lib/utils"

export type TerminalBlockStatus = "running" | "ok" | "failed" | "stopped"

/**
 * One command and the output it printed. A provider that cannot stream a
 * running command's output shows only the command until it ends: the output
 * area appears with the first line, never as an empty screen.
 */
export function TerminalBlock({
  command,
  lines,
  status,
  exitCode,
  hint,
  variant = "paper",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "command" | "lines" | "status" | "exitCode" | "hint" | "variant"
> & {
  command: string
  lines: readonly string[]
  status: TerminalBlockStatus
  exitCode?: number
  /** Provider guidance for a failed command, shown as written. */
  hint?: string
  variant?: "paper" | "ink"
}) {
  const ink = variant === "ink"
  const failed = status === "failed"
  const hasOutput = lines.length > 0
  const showHint = failed && Boolean(hint)
  const quiet = ink
    ? "text-background/40 dark:text-foreground/40"
    : "text-foreground/40"

  return (
    <div
      data-slot="terminal-block"
      className={cn(
        ink ? "bg-foreground dark:bg-popover" : paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className
      )}
      {...props}
      dir="ltr"
    >
      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 pt-3",
          hasOutput || showHint ? "pb-1.5" : "pb-3"
        )}
      >
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
        {status === "running" ? (
          <Loader2Icon
            className={cn(
              "size-3 shrink-0 animate-spin motion-reduce:animate-none",
              ink
                ? "text-background/35 dark:text-foreground/35"
                : "text-foreground/35"
            )}
          />
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            {status === "ok" ? (
              <CheckIcon className="size-3 text-success" />
            ) : failed ? (
              <CircleXIcon className="size-3 text-destructive" />
            ) : (
              <SquareIcon className={cn("size-3", quiet)} />
            )}
            {exitCode === undefined ? null : (
              <span className={cn(mono, failed ? "text-destructive" : quiet)}>
                exit {exitCode}
              </span>
            )}
          </div>
        )}
      </div>
      {showHint ? (
        <p className={cn("px-4", hasOutput ? "pb-1.5" : "pb-3", quiet)}>
          {hint}
        </p>
      ) : null}
      {hasOutput ? (
        <div
          className={cn(
            "flex max-h-80 flex-col gap-1 overflow-auto px-4 pt-1 pb-3.5",
            ink
              ? "text-background/55 dark:text-foreground/50"
              : "text-foreground/50"
          )}
        >
          {lines.map((line, index) => {
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
          {status === "running" ? (
            <span
              aria-hidden
              className="inline-block h-3 w-1.5 animate-pulse bg-primary/70 motion-reduce:animate-none"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
