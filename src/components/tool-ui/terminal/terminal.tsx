"use client"

/*
 * Tool UI registry `terminal`, customized for AOS:
 * - one ACP terminal (`AosTerminal`): a single ANSI output stream that may
 *   still be running, with an optional exit code or signal;
 * - every visible string comes from `labels`;
 * - a bounded scroll area that follows new output while running unless the
 *   reader scrolled away, replacing the registry's line-count collapse;
 * - a polite live region that announces only the start and the end.
 */

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"
import AnsiModule from "ansi-to-react"
import { Copy, Check, Terminal as TerminalIcon } from "lucide-react"

import type { ToolTerminalLabels } from "../locale"
import { useCopyToClipboard } from "../shared/use-copy-to-clipboard"
import type { AosTerminal } from "../tool-artifact"
import { stripAnsi } from "../strip-ansi"
import { terminalStatus } from "./terminal-status"
import { Button, cn } from "./_adapter"

// ansi-to-react is CommonJS with `exports.default` but no `__esModule` flag,
// so bundlers hand the default import the whole exports object.
const Ansi =
  (AnsiModule as unknown as { default?: typeof AnsiModule }).default ??
  AnsiModule

const COPY_ID = "terminal-output"
/** How close to the end, in pixels, still counts as reading the live tail. */
const STICK_THRESHOLD = 16

export type TerminalProps = {
  terminal: AosTerminal
  labels: ToolTerminalLabels
  className?: string
}

/** Follows new output while `following`, unless the reader scrolled away. */
function useStickToBottom(
  ref: RefObject<HTMLDivElement | null>,
  content: string,
  following: boolean
) {
  const stuck = useRef(true)

  // Instant, never smooth: a smooth scroll still animating when the next
  // chunk lands would read as the reader scrolling away, and reduced motion
  // asks for none.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !following || !stuck.current) return
    node.scrollTop = node.scrollHeight
  }, [ref, content, following])

  return useCallback(() => {
    const node = ref.current
    if (!node) return
    stuck.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_THRESHOLD
  }, [ref])
}

function TerminalHeader({
  terminal,
  labels,
  hasOutput,
  isCopied,
  onCopy,
}: {
  terminal: AosTerminal
  labels: ToolTerminalLabels
  hasOutput: boolean
  isCopied: boolean
  onCopy: () => void
}) {
  const { command, cwd, running, exitCode } = terminal
  const failed = !running && (!!terminal.signal || (exitCode ?? 0) !== 0)
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <TerminalIcon
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <code className="truncate font-mono text-xs text-foreground">
          {cwd && (
            <span className="text-muted-foreground">
              <span className="sr-only">{labels.cwd}: </span>
              {cwd}$
            </span>
          )}
          {command && (
            <>
              <span className="sr-only">{labels.command}: </span>
              {command}
            </>
          )}
        </code>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={cn(
            "flex items-center gap-1.5 text-sm tabular-nums",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {running && (
            <span
              className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
              aria-hidden="true"
            />
          )}
          {terminalStatus(terminal, labels)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopy}
          disabled={!hasOutput}
          className="h-7 w-7 p-0"
          aria-label={isCopied ? labels.copied : labels.copyOutput}
        >
          {hasOutput && isCopied ? (
            <Check className="h-4 w-4 text-green-700 dark:text-green-400" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      </div>
    </div>
  )
}

export function Terminal({ terminal, labels, className }: TerminalProps) {
  const { copiedId, copy } = useCopyToClipboard()
  const { output, running, truncated } = terminal
  const hasOutput = output.length > 0
  const outputRef = useRef<HTMLDivElement>(null)
  const onScroll = useStickToBottom(outputRef, output, running)

  const handleCopy = useCallback(() => {
    if (hasOutput) void copy(stripAnsi(output), COPY_ID)
  }, [hasOutput, output, copy])

  return (
    <div
      className={cn("@container flex w-full min-w-0 flex-col gap-3", className)}
      data-tool-ui-id={terminal.terminalId}
      data-slot="terminal"
      dir="ltr"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-xs">
        <TerminalHeader
          terminal={terminal}
          labels={labels}
          hasOutput={hasOutput}
          isCopied={copiedId === COPY_ID}
          onCopy={handleCopy}
        />

        {hasOutput ? (
          <div
            ref={outputRef}
            onScroll={onScroll}
            role="region"
            aria-label={labels.output}
            tabIndex={0}
            className="max-h-80 overflow-auto p-4 font-mono text-sm"
          >
            <div className="whitespace-pre text-foreground">
              <Ansi>{output}</Ansi>
            </div>
            {truncated && (
              <div className="mt-2 text-xs text-muted-foreground italic">
                {labels.truncated}
              </div>
            )}
          </div>
        ) : (
          !running && (
            <div className="px-4 py-3 font-mono text-sm text-muted-foreground italic">
              {labels.noOutput}
            </div>
          )
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {running
          ? labels.started
          : labels.ended(terminalStatus(terminal, labels))}
      </p>
    </div>
  )
}
