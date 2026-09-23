"use client"

import { lazy, Suspense, type ReactNode } from "react"

import { LazyVisualBoundary } from "./lazy-boundary"
import type { ToolTerminalLabels } from "./locale"
import { stripAnsi } from "./strip-ansi"
import { terminalStatus } from "./terminal/terminal-status"
import type { TerminalProps } from "./terminal/terminal"
import { DiffTextFallback, type ToolDiffProps } from "./tool-diff-text"
import type { AosTerminal } from "./tool-artifact"

const ToolDiff = lazy(() =>
  import("./tool-diff").then((module) => ({ default: module.ToolDiff }))
)
const Terminal = lazy(() =>
  import("./terminal/terminal").then((module) => ({
    default: module.Terminal,
  }))
)

function LazyView({
  loading,
  fallback,
  children,
}: {
  loading: string
  fallback: ReactNode
  children: ReactNode
}) {
  return (
    <LazyVisualBoundary fallbackLabel={loading} fallback={fallback}>
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground" role="status">
            {loading}
          </p>
        }
      >
        {children}
      </Suspense>
    </LazyVisualBoundary>
  )
}

function UnavailableNotice({ children }: { children: string }) {
  return (
    <p className="text-sm text-muted-foreground" role="alert">
      {children}
    </p>
  )
}

/** The rich diff, loaded on demand; the changes list and raw patch if not. */
export function LazyToolDiff({ diffs, labels }: ToolDiffProps) {
  return (
    <LazyView
      loading={labels.loading}
      fallback={
        <div className="flex flex-col gap-2">
          <UnavailableNotice>{labels.unavailable}</UnavailableNotice>
          <DiffTextFallback diffs={diffs} labels={labels} />
        </div>
      }
    >
      <ToolDiff diffs={diffs} labels={labels} />
    </LazyView>
  )
}

/** The command, its status, and its output as plain text. */
export function TerminalTextFallback({
  terminal,
  labels,
}: {
  terminal: AosTerminal
  labels: ToolTerminalLabels
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      {terminal.command && (
        <p className="font-mono text-xs">
          <span className="sr-only">{labels.command}: </span>
          <bdi dir="ltr">{terminal.command}</bdi>
        </p>
      )}
      <p className="text-muted-foreground">
        {terminalStatus(terminal, labels)}
      </p>
      <pre
        dir="ltr"
        aria-label={labels.output}
        className="max-h-80 overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs"
      >
        {stripAnsi(terminal.output) || labels.noOutput}
      </pre>
      {terminal.truncated && (
        <p className="text-xs text-muted-foreground">{labels.truncated}</p>
      )}
    </div>
  )
}

/** The ANSI terminal, loaded on demand; plain output if it cannot load. */
export function LazyToolTerminal({ terminal, labels }: TerminalProps) {
  return (
    <LazyView
      loading={labels.loading}
      fallback={
        <div className="flex flex-col gap-2">
          <UnavailableNotice>{labels.unavailable}</UnavailableNotice>
          <TerminalTextFallback terminal={terminal} labels={labels} />
        </div>
      }
    >
      <Terminal terminal={terminal} labels={labels} />
    </LazyView>
  )
}
