"use client"

import type { ComponentProps } from "react"
import { Loader2Icon, PlayIcon } from "lucide-react"

import {
  codeScroll,
  codeSurface,
  ghostButton,
  mono,
  paper,
} from "@/lib/surfaces"
import { cn } from "@/lib/utils"

export type RunState = "idle" | "running" | "ok" | "error"

export function CodeRunner({
  language,
  code,
  state,
  output,
  durationMs,
  onRun,
  runLabel = "Run this snippet",
  outputLabel = "output",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "language" | "code" | "state" | "output" | "durationMs" | "onRun"
> & {
  language?: string
  code: string
  state: RunState
  output: readonly string[]
  durationMs?: number
  onRun?: () => void
  runLabel?: string
  outputLabel?: string
}) {
  return (
    <div
      data-slot="code-runner"
      className={cn(
        paper,
        "flex w-full max-w-md flex-col overflow-hidden rounded-2xl",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex items-center gap-2 px-3.5 py-2",
          !language && "justify-end"
        )}
      >
        {language ? (
          <span className={cn(mono, "min-w-0 flex-1 text-foreground/35")}>
            {language}
          </span>
        ) : null}
        {durationMs !== undefined && state !== "running" ? (
          <span
            className={cn(mono, "shrink-0 text-foreground/30 tabular-nums")}
          >
            {durationMs}ms
          </span>
        ) : null}
        <button
          type="button"
          aria-label={runLabel}
          onClick={onRun}
          disabled={!onRun || state === "running"}
          className={cn(
            ghostButton,
            "size-7 shrink-0 disabled:pointer-events-none disabled:opacity-30"
          )}
        >
          {state === "running" ? (
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <PlayIcon className="size-3.5 translate-x-px rtl:-translate-x-px" />
          )}
        </button>
      </div>

      <pre className="overflow-x-auto border-t border-foreground/[0.07] px-3.5 py-2.5 font-mono text-xs leading-relaxed">
        <code className="text-foreground/75">{code}</code>
      </pre>

      {state !== "idle" ? (
        <div className="flex animate-in flex-col border-t border-foreground/[0.07] px-3.5 py-2.5 duration-300 fade-in">
          <span className={cn(mono, "pb-1 text-foreground/30")}>
            {outputLabel}
          </span>
          <div className={codeScroll}>
            <div className={cn(codeSurface, "flex flex-col")}>
              {output.map((line, index) => (
                <span
                  key={`${index}-${line}`}
                  className={cn(
                    "animate-in font-mono text-xs leading-relaxed whitespace-pre fill-mode-both fade-in",
                    state === "error"
                      ? "text-destructive"
                      : "text-foreground/70"
                  )}
                  style={{ animationDelay: `${index * 80}ms` }}
                >
                  {line}
                </span>
              ))}
            </div>
          </div>
          {state === "running" ? (
            <span
              aria-hidden
              className="h-[1em] w-[2px] animate-pulse rounded-full bg-foreground/40 motion-reduce:animate-none"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
