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
  type ReactNode,
} from "react"

import type { McpAppView } from "@aos/protocol/mcp-apps"
import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"
import { shownFileOf } from "@/artifacts/artifacts"
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
import {
  mcpAppTargetKey,
  sameMcpAppTarget,
  useMcpAppHost,
  type McpAppHost,
  type McpAppPip,
} from "./mcp-app-host"
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
  const { adapter, agentId, sessionId, showInPip, updatePip } = host
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

  // While the view shows in the side panel, which mounts it afresh, its message
  // keeps its own and passes on what the call reports.
  const pipped =
    host.pip !== undefined && sameMcpAppTarget(host.pip.target, target)
  useEffect(() => {
    if (pipped) updatePip(target, { input, result, cancelled })
  }, [cancelled, input, pipped, result, target, updatePip])
  const move = (placement: AppPlacement) => {
    if (placement === "pip" && opened)
      showInPip({
        target,
        opened: { view: opened.view, openedAt: opened.openedAt },
        toolName,
        file: shownFileOf(result),
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
      {state.status === "failed" ? (
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

const pipTitle = (
  labels: ToolUiLocaleLabels,
  { file, toolName, target }: McpAppPip
) =>
  file?.filename ??
  labels.mcpApp.frameTitle(
    toolName ?? ("toolCallId" in target ? target.toolCallId : target.artifactId)
  )

/** The side panel's view, named in `locale`, while one is there. */
export function useMcpAppPip(locale: ToolUiLocale) {
  const host = useMcpAppHost()
  if (!host?.pip) return undefined
  const labels = locale === "he" ? heToolUiLabels : enToolUiLabels
  return { title: pipTitle(labels, host.pip), leave: host.leavePip }
}

/** Why the side panel shows no view: its file is gone, or no view opens. */
export type McpAppPipFailure = "missing" | "unavailable"

type McpAppPipPanelProps = {
  locale: ToolUiLocale
  /**
   * What the panel says in place of a view it could not open, when the
   * workspace has more to say than that the view is unavailable.
   */
  failureNotice?: (pip: McpAppPip, reason: McpAppPipFailure) => ReactNode
}

/**
 * The side panel's view, for the workspace's side-panel slot. The view
 * mounts afresh here with `displayMode: "pip"`, since moving a frame reloads
 * it, and needs nothing from its message, so it stays while newer messages
 * push that one out of the rendered window. A target no message opened, such
 * as an attachment, the panel opens itself.
 */
export function McpAppPipPanel({ locale, failureNotice }: McpAppPipPanelProps) {
  const host = useMcpAppHost()
  if (!host?.pip) return null
  return (
    <ToolUiLocaleProvider locale={locale}>
      <PipPanel
        key={mcpAppTargetKey(host.pip.target)}
        host={host}
        pip={host.pip}
        failureNotice={failureNotice}
      />
    </ToolUiLocaleProvider>
  )
}

type PipViewState =
  | { status: "loading" }
  | { status: "ready"; view: McpAppView; openedAt: number }
  | { status: "failed"; reason: McpAppPipFailure }

/** The view its message handed over, or the one the panel opens for `pip`. */
function usePipView(adapter: McpAppHost["adapter"], pip: McpAppPip) {
  const handed = pip.opened
  const [opened, setOpened] = useState<PipViewState>(
    handed ? { status: "ready", ...handed } : { status: "loading" }
  )
  const { target } = pip
  useEffect(() => {
    if (handed) return
    const controller = new AbortController()
    adapter.open(target, controller.signal).then(
      (view) => setOpened({ status: "ready", view, openedAt: Date.now() }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setOpened({
          status: "failed",
          reason:
            error instanceof ArtifactMissingError ? "missing" : "unavailable",
        })
      }
    )
    return () => controller.abort()
  }, [adapter, handed, target])
  const unavailable = useCallback(
    () => setOpened({ status: "failed", reason: "unavailable" }),
    []
  )
  return { state: opened, unavailable }
}

function PipPanel({
  host,
  pip,
  failureNotice,
}: {
  host: McpAppHost
  pip: McpAppPip
  failureNotice: McpAppPipPanelProps["failureNotice"]
}) {
  const { labels, locale, direction } = useToolUiLocale()
  const { adapter, leavePip } = host
  const { state, unavailable } = usePipView(adapter, pip)
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
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-medium" dir="auto">
            {title}
          </h2>
          {pip.file?.mimeType ? (
            <p className="truncate text-sm text-muted-foreground">
              {pip.file.mimeType}
            </p>
          ) : null}
        </div>
        <Button
          ref={closeButton}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={
            "artifactId" in pip.target
              ? labels.mcpApp.closePreview
              : labels.mcpApp.returnToMessage
          }
          onClick={leavePip}
          className="[@media(pointer:coarse)]:size-11"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {state.status === "failed" ? (
          <div className="p-4">
            {failureNotice?.(pip, state.reason) ?? <AppUnavailable />}
          </div>
        ) : state.status === "loading" ? (
          <div className="p-4">
            <AppLoading />
          </div>
        ) : (
          <AppFrame
            view={state.view}
            openedAt={state.openedAt}
            connectionStatus={host.connectionStatus}
            input={pip.input ?? state.view.toolInput}
            result={pip.result ?? state.view.toolResult}
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
