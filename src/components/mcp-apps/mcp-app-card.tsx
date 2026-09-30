"use client"

import { Loader2Icon, XIcon } from "lucide-react"
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
import {
  enToolUiLabels,
  heToolUiLabels,
  ToolUiLocaleProvider,
  useToolUiLocale,
  type ToolUiLocale,
  type ToolUiLocaleLabels,
} from "@/components/tool-ui/locale"
import type { RichToolPart } from "@/components/tool-ui/types"
import { Button } from "@/components/ui/button"
import { SystemNotice } from "@/components/ui/system-notice"

import type { AppPlacement } from "./host-handlers"
import type { McpAppFrameProps } from "./mcp-app-frame"
import { useMcpAppHost, type McpAppHost, type McpAppPip } from "./mcp-app-host"
import {
  isSettledMcpAppToolPart,
  mcpAppToolCancellation,
  mcpAppToolInput,
} from "./tool-part"

const McpAppFrame = lazy(() => import("./mcp-app-frame"))

type ViewState =
  | { status: "loading" }
  | {
      status: "ready"
      view: McpAppView
      openedSettled: boolean
      openedAt: number
    }
  | { status: "failed" }

function AppLoading() {
  const { labels } = useToolUiLocale()
  return (
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
}

function AppUnavailable() {
  const { labels, locale } = useToolUiLocale()
  return (
    <SystemNotice
      tone="warning"
      title={labels.mcpApp.unavailable}
      locale={locale}
    />
  )
}

/** The sandboxed frame, loaded on first use; one that cannot load says so. */
function AppFrame(props: McpAppFrameProps) {
  const { labels } = useToolUiLocale()
  return (
    <LazyVisualBoundary
      fallbackLabel={labels.mcpApp.unavailable}
      fallback={<AppUnavailable />}
    >
      <Suspense fallback={<AppLoading />}>
        <McpAppFrame {...props} />
      </Suspense>
    </LazyVisualBoundary>
  )
}

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
  const { adapter, agentId, sessionId, showInPip, leavePip, updatePip } = host
  const { toolCallId } = part
  const target = useMemo(
    () => ({ agentId, sessionId, toolCallId }),
    [agentId, sessionId, toolCallId]
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
      (view) =>
        setState({
          status: "ready",
          view,
          openedSettled,
          openedAt: Date.now(),
        }),
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
  // A view given files takes the arguments the proxy handed it, which hold
  // none of the host paths the call's own arguments name.
  const input = opened?.view.files
    ? (opened.view.toolInput ?? settledView?.toolInput)
    : (mcpAppToolInput(part) ??
      settledView?.toolInput ??
      opened?.view.toolInput)
  const result = opened?.view.toolResult ?? settledView?.toolResult
  const cancelled =
    result === undefined ? mcpAppToolCancellation(part) : undefined
  const unavailable = useCallback(() => setState({ status: "failed" }), [])
  const toolName = part.toolName === toolCallId ? undefined : part.toolName

  // While the view shows in the side panel, its message holds its place and
  // passes on what the call reports.
  const pipped = host.pip?.target.toolCallId === toolCallId
  useEffect(() => {
    if (pipped) updatePip(target, { input, result, cancelled })
  }, [cancelled, input, pipped, result, target, updatePip])
  const move = (placement: AppPlacement) => {
    if (placement === "pip" && opened)
      showInPip({
        target,
        view: opened.view,
        openedAt: opened.openedAt,
        toolName,
        input,
        result,
        cancelled,
      })
  }
  // Back from the side panel, the view takes the focus its panel held; one
  // another view replaced leaves focus where that request put it.
  const wrapper = useRef<HTMLDivElement>(null)
  const wasPipped = useRef(pipped)
  const panelEmpty = host.pip === undefined
  useEffect(() => {
    if (wasPipped.current && !pipped && panelEmpty) wrapper.current?.focus()
    wasPipped.current = pipped
  }, [panelEmpty, pipped])

  return (
    <div
      ref={wrapper}
      tabIndex={-1}
      className="flex w-full max-w-2xl flex-col gap-2 outline-none"
      dir={direction}
      lang={locale}
    >
      {pipped ? (
        <p className="flex flex-wrap items-center gap-x-2 py-2 text-sm text-muted-foreground">
          {labels.mcpApp.inSidePanel}
          <Button
            type="button"
            variant="link"
            onClick={leavePip}
            className="h-auto p-0 [@media(pointer:coarse)]:min-h-11"
          >
            {labels.mcpApp.returnToMessage}
          </Button>
        </p>
      ) : state.status === "failed" ? (
        <AppUnavailable />
      ) : state.status === "loading" ? (
        <AppLoading />
      ) : (
        <AppFrame
          view={state.view}
          openedAt={state.openedAt}
          connectionStatus={host.connectionStatus}
          input={input}
          result={result}
          cancelled={cancelled}
          toolName={toolName}
          target={target}
          adapter={adapter}
          title={labels.mcpApp.frameTitle(part.toolName)}
          onUnavailable={unavailable}
          onMove={move}
        />
      )}
      {part.result !== undefined || Object.keys(part.args).length > 0 ? (
        <AosToolFallback {...part} />
      ) : null}
    </div>
  )
}

const pipTitle = (labels: ToolUiLocaleLabels, pip: McpAppPip) =>
  labels.mcpApp.frameTitle(pip.toolName ?? pip.target.toolCallId)

/** The side panel's view, named in `locale`, while one is there. */
export function useMcpAppPip(locale: ToolUiLocale) {
  const host = useMcpAppHost()
  if (!host?.pip) return undefined
  const labels = locale === "he" ? heToolUiLabels : enToolUiLabels
  return { title: pipTitle(labels, host.pip), leave: host.leavePip }
}

/**
 * The side panel's view, for the workspace's Artifact viewer slot. The view
 * mounts afresh here with `displayMode: "pip"`, since moving a frame reloads
 * it, and needs nothing from its message, so it stays while newer messages
 * push that one out of the rendered window.
 */
export function McpAppPipPanel({ locale }: { locale: ToolUiLocale }) {
  const host = useMcpAppHost()
  if (!host?.pip) return null
  return (
    <ToolUiLocaleProvider locale={locale}>
      <PipPanel key={host.pip.target.toolCallId} host={host} pip={host.pip} />
    </ToolUiLocaleProvider>
  )
}

function PipPanel({ host, pip }: { host: McpAppHost; pip: McpAppPip }) {
  const { labels, locale, direction } = useToolUiLocale()
  const { adapter, leavePip } = host
  const [failed, setFailed] = useState(false)
  const unavailable = useCallback(() => setFailed(true), [])
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeButton.current?.focus()
  }, [])
  const title = pipTitle(labels, pip)

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      dir={direction}
      lang={locale}
      aria-label={title}
      // Only a key pressed in the panel, outside the view's own frame, leaves
      // it; one a menu elsewhere handled never reaches here.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        leavePip()
      }}
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2
          className="min-w-0 flex-1 truncate text-base font-medium"
          dir="auto"
        >
          {title}
        </h2>
        <Button
          ref={closeButton}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.mcpApp.returnToMessage}
          onClick={leavePip}
          className="[@media(pointer:coarse)]:size-11"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {failed ? (
          <div className="p-4">
            <AppUnavailable />
          </div>
        ) : (
          <AppFrame
            view={pip.view}
            openedAt={pip.openedAt}
            connectionStatus={host.connectionStatus}
            input={pip.input}
            result={pip.result}
            cancelled={pip.cancelled}
            toolName={pip.toolName}
            target={pip.target}
            adapter={adapter}
            title={title}
            onUnavailable={unavailable}
            placement="pip"
            onMove={leavePip}
          />
        )}
      </div>
    </section>
  )
}
