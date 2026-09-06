"use client"

import { ChevronRight } from "lucide-react"

import { normalizeRichToolState } from "./lifecycle"
import { CopyButton, safeJsonStringify, ToolStateLabel } from "./common"
import { useToolUiLocale } from "./locale"
import type { RichToolPart } from "./types"

export function GenericJsonTool({
  part,
  invalidDisplayName,
}: {
  part: RichToolPart
  invalidDisplayName?: string
}) {
  const state = normalizeRichToolState(part)
  const payload = safeJsonStringify({ args: part.args, result: part.result })
  const { direction, labels, locale } = useToolUiLocale()

  return (
    <details
      className="group w-full max-w-2xl rounded-lg border border-border bg-muted/20"
      data-slot="generic-tool"
      data-state={state.phase}
      dir={direction}
      lang={locale}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {invalidDisplayName ? (
            labels.generic.malformed(invalidDisplayName)
          ) : (
            <bdi dir="ltr">{part.toolName}</bdi>
          )}
        </span>
        <ToolStateLabel state={state} />
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        {invalidDisplayName ? (
          <p className="text-sm text-muted-foreground">
            {labels.generic.malformedExplanation}
          </p>
        ) : null}
        <pre
          className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
          dir="ltr"
        >
          {payload}
        </pre>
        <div>
          <CopyButton value={payload} label={labels.generic.copyJson} />
        </div>
      </div>
    </details>
  )
}
