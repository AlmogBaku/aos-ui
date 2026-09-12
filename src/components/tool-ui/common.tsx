"use client"

import { useCallback, useState, type ReactNode } from "react"
import {
  Check,
  CircleAlert,
  CircleDashed,
  Clock3,
  Copy,
  LoaderCircle,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { useToolUiLocale } from "./locale"
import { safeToolPresentation } from "./safe-presentation"
import type { RichToolState } from "./types"

const stateIcons = {
  pending: Clock3,
  submitting: LoaderCircle,
  answered: Check,
  running: LoaderCircle,
  complete: Check,
  failed: CircleAlert,
  unavailable: CircleDashed,
  expired: Clock3,
  cancelled: X,
} as const

export function ToolStateLabel({ state }: { state: RichToolState }) {
  const Icon = stateIcons[state.phase] ?? CircleDashed
  const { labels } = useToolUiLocale()

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground",
        state.phase === "failed" && "text-destructive",
        (state.phase === "answered" || state.phase === "complete") &&
          "text-primary"
      )}
      role="status"
      aria-live="polite"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          (state.phase === "running" || state.phase === "submitting") &&
            "motion-safe:animate-spin"
        )}
      />
      {labels.states[state.phase]}
    </span>
  )
}

export function ToolChrome({
  title,
  description,
  state,
  children,
  actions,
  showHeader = true,
  headingLevel = 2,
}: {
  title: string
  description?: string
  state: RichToolState
  children?: ReactNode
  actions?: ReactNode
  showHeader?: boolean
  headingLevel?: 2 | 3
}) {
  const { direction, locale } = useToolUiLocale()
  const Heading = headingLevel === 2 ? "h2" : "h3"

  return (
    <section
      className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground"
      data-slot="tool-chrome"
      data-state={state.phase}
      dir={direction}
      lang={locale}
    >
      {showHeader ? (
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Heading className="text-sm font-semibold text-balance" dir="auto">
              {title}
            </Heading>
            {description ? (
              <p
                className="max-w-[70ch] text-sm text-pretty text-muted-foreground"
                dir="auto"
              >
                {description}
              </p>
            ) : null}
          </div>
          <ToolStateLabel state={state} />
        </header>
      ) : null}
      {children}
      {actions ? (
        <footer className="flex flex-wrap items-center gap-2">{actions}</footer>
      ) : null}
    </section>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  )
  const { labels } = useToolUiLocale()

  const copy = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(value)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }, [value])

  return (
    <Button type="button" variant="ghost" size="xs" onClick={copy}>
      <Copy data-icon="inline-start" aria-hidden="true" />
      {copyState === "copied"
        ? labels.common.copied
        : copyState === "failed"
          ? labels.common.copyFailed
          : label}
    </Button>
  )
}

export function safeJsonStringify(value: unknown) {
  return safeToolPresentation(value).text
}
