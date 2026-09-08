import { ChevronRight } from "lucide-react"
import type { MontyPayload } from "./payloads/monty"

import { CopyButton, safeJsonStringify, ToolChrome } from "./common"
import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import type { RichToolPart } from "./types"

export function MontyTool({
  part,
  payload,
}: {
  part: RichToolPart
  payload: MontyPayload
}) {
  const state = normalizeRichToolState(part)
  const resultText = safeJsonStringify(payload.result)
  const providerError = getMontyProviderError(part)
  const { labels } = useToolUiLocale()

  return (
    <ToolChrome
      title={labels.monty.title}
      description={labels.monty.description}
      state={state}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {labels.monty.code}
          </p>
          <CopyButton value={payload.args.code} label={labels.monty.copyCode} />
        </div>
        <details className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
            />
            {labels.monty.inspectCode}
          </summary>
          <pre
            className="overflow-auto border-t border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
            dir="ltr"
          >
            {payload.args.code}
          </pre>
        </details>
      </div>
      {payload.result === undefined && providerError ? (
        <pre
          className="max-h-64 overflow-auto rounded-lg border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-destructive"
          dir="auto"
          role="alert"
        >
          {providerError}
        </pre>
      ) : null}
      {payload.result !== undefined ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              {labels.monty.result}
            </p>
            <CopyButton value={resultText} label={labels.monty.copyResult} />
          </div>
          <pre
            className="max-h-64 overflow-auto rounded-lg border border-border p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
            dir="auto"
            role={state.phase === "failed" ? "alert" : undefined}
          >
            {formatMontyResult(payload.result, resultText)}
          </pre>
          <details className="group rounded-lg border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
              {labels.monty.inspectResult}
            </summary>
            <pre
              className="max-h-64 overflow-auto border-t border-border p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
              dir="ltr"
            >
              {resultText}
            </pre>
          </details>
        </div>
      ) : null}
    </ToolChrome>
  )
}

function getMontyProviderError(part: RichToolPart) {
  if (part.status.type !== "incomplete" || part.status.error === undefined) {
    return undefined
  }

  if (typeof part.status.error === "string") return part.status.error
  if (part.status.error && typeof part.status.error === "object") {
    const message = Reflect.get(part.status.error, "message")
    if (typeof message === "string") return message
  }
  return safeJsonStringify(part.status.error)
}

function formatMontyResult(result: unknown, fallback: string) {
  if (!result || typeof result !== "object") return fallback
  const stdout = Reflect.get(result, "stdout")
  if (typeof stdout === "string") return stdout
  const error = Reflect.get(result, "error")
  if (typeof error === "string") return error
  return fallback
}
