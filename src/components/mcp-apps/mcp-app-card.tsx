"use client"

import { Loader2Icon } from "lucide-react"
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type { McpAppView } from "@aos/protocol/mcp-apps"
import { AosToolFallback } from "@/components/tool-ui/aos-tool-fallback"
import { LazyVisualBoundary } from "@/components/tool-ui/lazy-boundary"
import { useToolUiLocale } from "@/components/tool-ui/locale"
import type { RichToolPart } from "@/components/tool-ui/types"
import { SystemNotice } from "@/components/ui/system-notice"

import { useMcpAppHost, type McpAppHost } from "./mcp-app-host"
import {
  isSettledMcpAppToolPart,
  mcpAppToolCancellation,
  mcpAppToolInput,
} from "./tool-part"

const McpAppFrame = lazy(() => import("./mcp-app-frame"))

type ViewState =
  | { status: "loading" }
  | { status: "ready"; view: McpAppView; openedSettled: boolean }
  | { status: "failed" }

/**
 * A tool call that declares an MCP App view. The view mounts as soon as the
 * call is flagged, above the call's own inspectable request and result, and
 * draws once its input arrives; where the runtime hosts no App views, the call
 * keeps its ordinary presentation. A call that reached this client with
 * neither input nor result (a guest's) shows the view alone.
 *
 * The view is the outcome, so it carries no card, title, or status of its own:
 * the call's execution row below it already names the tool and its state.
 */
export function McpAppCard(part: RichToolPart) {
  const host = useMcpAppHost()
  if (!host) return <AosToolFallback {...part} />
  return <HostedMcpApp part={part} host={host} />
}

function HostedMcpApp({
  part,
  host,
}: {
  part: RichToolPart
  host: McpAppHost
}) {
  const { labels, locale, direction } = useToolUiLocale()
  const { adapter, agentId, threadId } = host
  const { toolCallId } = part
  const target = useMemo(
    () => ({ agentId, threadId, toolCallId }),
    [agentId, threadId, toolCallId]
  )
  // A view opened while its call ran asks again at settle for what the
  // provider recorded, without reloading the view itself.
  const settled = isSettledMcpAppToolPart(part)
  const settledNow = useRef(settled)
  useEffect(() => {
    settledNow.current = settled
  }, [settled])
  const [state, setState] = useState<ViewState>({ status: "loading" })
  useEffect(() => {
    const controller = new AbortController()
    const openedSettled = settledNow.current
    adapter.open(target, controller.signal).then(
      (view) => setState({ status: "ready", view, openedSettled }),
      () => {
        if (!controller.signal.aborted) setState({ status: "failed" })
      }
    )
    return () => controller.abort()
  }, [adapter, target])

  const opened = state.status === "ready" ? state : undefined
  const awaitingResult = settled && opened?.openedSettled === false
  const [settledView, setSettledView] = useState<McpAppView>()
  useEffect(() => {
    if (!awaitingResult) return
    const controller = new AbortController()
    adapter.open(target, controller.signal).then(setSettledView, () => {})
    return () => controller.abort()
  }, [adapter, awaitingResult, target])
  const input =
    mcpAppToolInput(part) ?? settledView?.toolInput ?? opened?.view.toolInput
  const result = opened?.view.toolResult ?? settledView?.toolResult
  const cancelled =
    result === undefined ? mcpAppToolCancellation(part) : undefined
  const unavailable = useCallback(() => setState({ status: "failed" }), [])

  const failed = (
    <SystemNotice
      tone="warning"
      title={labels.mcpApp.unavailable}
      locale={locale}
    />
  )
  const loading = (
    <p
      className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2Icon
        aria-hidden="true"
        className="size-4 shrink-0 motion-safe:animate-spin"
      />
      {labels.mcpApp.loading}
    </p>
  )
  return (
    <div
      className="flex w-full max-w-2xl flex-col gap-2"
      dir={direction}
      lang={locale}
    >
      {state.status === "failed" ? (
        failed
      ) : state.status === "loading" ? (
        loading
      ) : (
        <LazyVisualBoundary
          fallbackLabel={labels.mcpApp.unavailable}
          fallback={failed}
        >
          <Suspense fallback={loading}>
            <McpAppFrame
              view={state.view}
              input={input}
              result={result}
              cancelled={cancelled}
              toolName={
                part.toolName === toolCallId ? undefined : part.toolName
              }
              target={target}
              adapter={adapter}
              title={labels.mcpApp.frameTitle(part.toolName)}
              onUnavailable={unavailable}
            />
          </Suspense>
        </LazyVisualBoundary>
      )}
      {part.result !== undefined || Object.keys(part.args).length > 0 ? (
        <AosToolFallback {...part} />
      ) : null}
    </div>
  )
}
