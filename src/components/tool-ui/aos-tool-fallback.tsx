"use client"

import { useState } from "react"

import {
  CodeRunner,
  type RunState,
} from "@/components/assistant-ui/elements/code-runner"
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block"
import { ToolCall } from "@/components/assistant-ui/elements/tool-call"
import { ToolError } from "@/components/assistant-ui/elements/tool-error"

import { normalizeRichToolState } from "./lifecycle"
import { useToolUiLocale } from "./locale"
import { safeToolDisplayValue, safeToolPresentation } from "./safe-presentation"
import {
  toolIconForName,
  toolIconKind,
  toolPrimaryArgument,
} from "./tool-call-presentation"
import type { RichToolFallbackComponent, RichToolPart } from "./types"

function parsedResult(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function resultRecord(value: unknown) {
  const parsed = parsedResult(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined
  const record = parsed as Record<string, unknown>
  const structured = record.structuredContent
  return structured &&
    typeof structured === "object" &&
    !Array.isArray(structured)
    ? (structured as Record<string, unknown>)
    : record
}

function terminalLines(value: unknown) {
  const parsed = parsedResult(value)
  if (typeof parsed === "string") return parsed.split(/\r?\n/u)
  const record = resultRecord(parsed)
  if (!record) return []
  const outputs = [record.output, record.stdout, record.stderr].filter(
    (item): item is string => typeof item === "string" && item.length > 0
  )
  return outputs.flatMap((output) => output.split(/\r?\n/u))
}

function codeRunnerDuration(value: unknown) {
  const record = resultRecord(value)
  if (!record) return undefined
  if (typeof record.durationMs === "number")
    return Math.round(record.durationMs)
  if (typeof record.duration_seconds === "number")
    return Math.round(record.duration_seconds * 1_000)
  return undefined
}

function codeRunnerState(
  phase: ReturnType<typeof normalizeRichToolState>["phase"]
): RunState {
  if (phase === "running" || phase === "submitting") return "running"
  if (phase === "complete" || phase === "answered") return "ok"
  return "idle"
}

function toolErrorMessage(part: RichToolPart) {
  const status = part.status as unknown as Record<string, unknown>
  if (typeof status.error === "string" && status.error.trim())
    return safeToolPresentation(status.error).text.replace(/^"|"$/gu, "")
  const result = parsedResult(part.result)
  if (typeof result === "string")
    return safeToolPresentation(result).text.replace(/^"|"$/gu, "")
  const record = resultRecord(result)
  if (record) {
    for (const key of ["error", "message", "stderr", "output"]) {
      const candidate = record[key]
      if (typeof candidate === "string" && candidate.trim())
        return safeToolPresentation(candidate).text.replace(/^"|"$/gu, "")
    }
  }
  return safeToolPresentation(part.result).text
}

export const AosToolError: RichToolFallbackComponent = (part) => {
  const { locale } = useToolUiLocale()
  return (
    <ToolError
      name={part.toolName}
      target={toolPrimaryArgument(part.toolName, part.args)}
      message={
        part.result === undefined
          ? locale === "he"
            ? "קריאת הכלי נכשלה."
            : "The tool call failed."
          : toolErrorMessage(part)
      }
      attempt={1}
      maxAttempts={1}
      retrying={false}
    />
  )
}

/**
 * Safe AOS presentation for tool calls without a provider-supplied rich UI.
 *
 * The assistant-ui toolkit owns known rich call UIs. This component is the
 * deliberately inspectable boundary for every remaining call, including
 * unknown, errored, interrupted, and provider-specific calls.
 */
export const AosToolFallback: RichToolFallbackComponent = (part) => {
  const [open, setOpen] = useState(false)
  const state = normalizeRichToolState(part)
  const { labels, locale } = useToolUiLocale()
  const displayState =
    state.phase === "complete" || state.phase === "answered"
      ? "complete"
      : state.phase === "running" || state.phase === "submitting"
        ? "running"
        : state.phase === "pending"
          ? "attention"
          : state.phase === "cancelled"
            ? "cancelled"
            : "failed"
  const request = safeToolPresentation(part.args).text
  const result = safeToolPresentation(part.result).text
  const kind = toolIconKind(part.toolName)
  const action = labels.assistant.toolActions[kind]
  const query =
    kind === "generic"
      ? part.toolName
      : toolPrimaryArgument(part.toolName, part.args)

  if (state.phase === "failed") return <AosToolError {...part} />

  // Any call that carries source code reads best as code, whatever the runtime
  // named it. The language is shown only when the call declares one.
  const code = safeToolDisplayValue(part.args, ["code"], "")
  const language = safeToolDisplayValue(part.args, ["language"], "")
  const useCodeRunner = Boolean(code)
  const useTerminalBlock =
    !useCodeRunner &&
    kind === "command" &&
    state.phase !== "cancelled" &&
    state.phase !== "expired"
  const lines = useTerminalBlock ? terminalLines(part.result) : []

  return (
    <ToolCall
      label={action.complete}
      activeLabel={action.active}
      requestLabel={locale === "he" ? "בקשה" : "Request"}
      resultLabel={locale === "he" ? "תוצאה" : "Result"}
      query={query}
      request={request}
      result={result}
      details={
        useCodeRunner ? (
          <CodeRunner
            {...(language ? { language } : {})}
            code={code}
            state={codeRunnerState(state.phase)}
            output={terminalLines(part.result)}
            durationMs={codeRunnerDuration(part.result)}
            runLabel={locale === "he" ? "הרצת קטע הקוד" : "Run this snippet"}
            outputLabel={locale === "he" ? "פלט" : "output"}
            className="mt-2 max-w-none"
          />
        ) : useTerminalBlock ? (
          <TerminalBlock
            command={query}
            lines={lines}
            visibleCount={lines.length}
            done={state.phase === "complete" || state.phase === "answered"}
            className="mt-2 max-w-none"
          />
        ) : undefined
      }
      running={state.phase === "running" || state.phase === "submitting"}
      state={displayState}
      open={open}
      onOpenChange={setOpen}
      icon={toolIconForName(part.toolName)}
    />
  )
}
