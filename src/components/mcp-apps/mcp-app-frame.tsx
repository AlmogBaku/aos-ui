"use client"

import { useAui } from "@assistant-ui/react"
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiHostContext,
  type McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js"
import { XIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import {
  McpAppResourceReadRequestSchema,
  McpAppToolCallRequestSchema,
  type McpAppView,
} from "@aos/protocol/mcp-apps"
import { useToolUiLocale } from "@/components/tool-ui/locale"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { McpAppAdapter, McpAppTarget } from "@/runtime-adapters/contracts"

import { appliedMcpAppCsp, buildMcpAppCsp } from "./csp"
import {
  appMessageText,
  createRateLimiter,
  createResourceCache,
  fileArgument,
  grantDisplayMode,
  offeredDisplayModes,
  openAppLink,
  saveAppFile,
  type AppDisplayMode,
  type AppPlacement,
} from "./host-handlers"
import { mcpAppTargetKey } from "./mcp-app-host"
import {
  SANDBOX_PROXY_SANDBOX,
  prepareAppDocument,
  sandboxProxyUrl,
} from "./sandbox-proxy"
import { useAppFiles, type AppConnectionStatus } from "./use-app-files"

const HOST_INFO = { name: "AOS", version: "1.0.0" }

/** Each adapter's shared resource reads, which every view it hosts reuses. */
const resourceReads = new WeakMap<
  McpAppAdapter,
  ReturnType<typeof createResourceCache<ReadResourceResult>>
>()
function sharedReads(adapter: McpAppAdapter) {
  let reads = resourceReads.get(adapter)
  if (!reads) {
    reads = createResourceCache<ReadResourceResult>()
    resourceReads.set(adapter, reads)
  }
  return reads
}

/** An App view grows with its content up to this share of the viewport. */
const MAX_HEIGHT_SHARE = 0.8
/** A sandbox that has not reported ready by then will not render the view. */
const SANDBOX_READY_TIMEOUT_MS = 10_000

const mediaMatches = (query: string) =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches

type SafeAreaInsets = NonNullable<McpUiHostContext["safeAreaInsets"]>
const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** The device's safe-area insets, read through a probe element's padding. */
function viewportSafeAreaInsets(): SafeAreaInsets {
  const probe = document.createElement("div")
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) " +
    "env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)"
  document.body.append(probe)
  const computed = getComputedStyle(probe)
  const px = (value: string) => Math.round(Number.parseFloat(value)) || 0
  const insets = {
    top: px(computed.paddingTop),
    right: px(computed.paddingRight),
    bottom: px(computed.paddingBottom),
    left: px(computed.paddingLeft),
  }
  probe.remove()
  return insets
}

/** The spec's theme variables, read from the workspace's own tokens. */
const STYLE_TOKENS: Partial<Record<keyof McpUiStyles, string>> = {
  "--color-background-primary": "--card",
  "--color-background-secondary": "--muted",
  "--color-background-tertiary": "--secondary",
  "--color-background-inverse": "--foreground",
  "--color-text-primary": "--card-foreground",
  "--color-text-secondary": "--muted-foreground",
  "--color-text-inverse": "--background",
  "--color-text-danger": "--destructive",
  "--color-text-success": "--success",
  "--color-text-info": "--info",
  "--color-text-warning": "--warning",
  "--color-border-primary": "--border",
  "--color-border-secondary": "--input",
  "--color-ring-primary": "--ring",
  "--font-sans": "--app-font-sans",
  "--font-mono": "--font-geist-mono",
  "--border-radius-lg": "--radius",
}

function styleVariables(): McpUiStyles {
  const computed = getComputedStyle(document.documentElement)
  return Object.fromEntries(
    Object.entries(STYLE_TOKENS).flatMap(([key, token]) => {
      const value = computed.getPropertyValue(token).trim()
      return value ? [[key, value]] : []
    })
  ) as McpUiStyles
}

export type McpAppFrameProps = {
  view: McpAppView
  /** When `view` arrived; its files' passes count from then. */
  openedAt: number
  /** The runtime connection's state; its recovery renews the view's files. */
  connectionStatus?: AppConnectionStatus
  /** The call's complete arguments, once known; sent to the view once. */
  input?: Record<string, unknown>
  /** The call's result, once settled; sent once, after the input. */
  result?: CallToolResult
  /**
   * Why the call ended without a result, once it has; sent once, after the
   * input when known, and never alongside a result.
   */
  cancelled?: string
  /** The tool's name, when the call reported one; names it in `toolInfo`. */
  toolName?: string
  /** The sandbox never reported ready, so the view cannot render. */
  onUnavailable?: () => void
  /** Where the frame sits: in its message (the default), or in the side panel. */
  placement?: AppPlacement
  /**
   * Moves the view to the other placement when it asks for it, which mounts
   * it afresh there. Without it, the view is not offered the side panel.
   */
  onMove?: (placement: AppPlacement) => void
  target: McpAppTarget
  adapter: McpAppAdapter
  title: string
}

/**
 * Hosts one MCP App view (spec 2026-01-26) behind the sandbox proxy. The bridge
 * answers the view from this Session only: its tool calls and resource reads go
 * to the runtime's App adapter, its messages become the operator's next turn in
 * this thread, it may open links and download its call's own files, and
 * nothing else it asks for is granted. The view mounts while its call still
 * runs and receives the input and the result as each arrives.
 */
export default function McpAppFrame({
  view,
  openedAt,
  connectionStatus,
  input,
  result,
  cancelled,
  toolName,
  target,
  adapter,
  title,
  onUnavailable,
  placement = "inline",
  onMove,
}: McpAppFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<AppBridge | undefined>(undefined)
  const [connected, setConnected] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const sent = useRef({ input: false, result: false, cancelled: false })
  const [height, setHeight] = useState<number>()
  // The width the view asks for in its message, when it fits one of its own.
  const [fitWidth, setFitWidth] = useState<number>()
  const [size, setSize] = useState<{ width: number; height: number }>()
  // The width the message gives the frame, which a view that fits its own
  // width may grow back to.
  const [room, setRoom] = useState<number>()
  const [displayMode, setDisplayMode] = useState<AppDisplayMode>(placement)
  const displayModeRef = useRef(displayMode)
  const offered = offeredDisplayModes(onMove !== undefined)
  const aui = useAui()
  const { labels, locale, direction } = useToolUiLocale()
  const { forcedTheme, resolvedTheme } = useTheme()
  const theme =
    forcedTheme === "dark" ||
    (forcedTheme !== "light" && resolvedTheme === "dark")
      ? "dark"
      : "light"
  // A renewal changes only the passes, which the policy leaves out, so the
  // view keeps running.
  const csp = useMemo(
    () => buildMcpAppCsp(view.csp, view.files),
    [view.csp, view.files]
  )
  const allow = useMemo(
    () => buildAllowAttribute(view.permissions),
    [view.permissions]
  )
  const { files, renew } = useAppFiles({
    files: view.files,
    openedAt,
    adapter,
    target,
    connectionStatus,
  })
  const context = useRef({
    aui,
    locale,
    direction,
    onUnavailable,
    toolName,
    placement,
    onMove,
    files,
    renew,
  })
  useEffect(() => {
    context.current = {
      aui,
      locale,
      direction,
      onUnavailable,
      toolName,
      placement,
      onMove,
      files,
      renew,
    }
  }, [
    aui,
    direction,
    files,
    locale,
    onMove,
    onUnavailable,
    placement,
    renew,
    toolName,
  ])

  const hostContext = (): McpUiHostContext => ({
    ...(toolName === undefined || !("toolCallId" in target)
      ? {}
      : {
          toolInfo: {
            id: target.toolCallId,
            tool: { name: toolName, inputSchema: { type: "object" } },
          },
        }),
    theme,
    locale: locale === "he" ? "he-IL" : "en-US",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: `${HOST_INFO.name}/${HOST_INFO.version}`,
    displayMode,
    availableDisplayModes: [...offered],
    platform: "web",
    deviceCapabilities: {
      touch: mediaMatches("(any-pointer: coarse)"),
      hover: mediaMatches("(any-hover: hover)"),
    },
    // In its message or the side panel, the view sits clear of every device
    // edge.
    safeAreaInsets:
      displayMode === "fullscreen" ? viewportSafeAreaInsets() : NO_INSETS,
    styles: { variables: styleVariables() },
    // Where the view fetches each file its call names, by argument.
    ...(files ? { "aos/files": files.addresses } : {}),
    // Inline, the view grows with its content; elsewhere it fills its space.
    ...(size === undefined
      ? {}
      : {
          containerDimensions:
            displayMode === "inline"
              ? {
                  width: room ?? size.width,
                  maxHeight: Math.round(window.innerHeight * MAX_HEIGHT_SHARE),
                }
              : size,
        }),
  })
  const latestHostContext = useRef(hostContext)
  useEffect(() => {
    latestHostContext.current = hostContext
  })
  // Renewed addresses reach the view at once, before their old passes lapse.
  useEffect(() => {
    if (initialized)
      bridgeRef.current?.setHostContext(latestHostContext.current())
  }, [files, initialized])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      setSize((current) =>
        current?.width === width && current.height === height
          ? current
          : { width, height }
      )
    })
    observer.observe(element)
    const parent = element.parentElement
    const roomObserver = new ResizeObserver(([entry]) => {
      if (entry) setRoom(Math.round(entry.contentRect.width))
    })
    if (parent) roomObserver.observe(parent)
    return () => {
      observer.disconnect()
      roomObserver.disconnect()
    }
  }, [])

  const fullscreen = displayMode === "fullscreen"
  const inline = displayMode === "inline"
  // Inline, the frame hugs a width the view asks for below the message's own;
  // a view that asks for the width it already fills fills the message.
  const hugged =
    inline && fitWidth !== undefined && room !== undefined && fitWidth < room
      ? fitWidth
      : undefined
  const restoreFocus = useRef(false)
  const exitFullscreen = () => {
    displayModeRef.current = placement
    restoreFocus.current = true
    setDisplayMode(placement)
  }
  const latestExit = useRef(exitFullscreen)
  useEffect(() => {
    latestExit.current = exitFullscreen
  })

  // The view grows in place, since moving its frame would reload the App. The
  // conversation's container queries make it a containing block for fixed
  // content, so the view is raised into the top layer instead.
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    if (!fullscreen) {
      if (restoreFocus.current) element.focus()
      restoreFocus.current = false
      return
    }
    if (typeof element.showPopover !== "function") return
    element.popover = "manual"
    element.showPopover()
    return () => {
      element.hidePopover()
      element.removeAttribute("popover")
    }
  }, [fullscreen])

  // Esc with the host focused returns the view to the message; inside the
  // view's own frame the key belongs to the App.
  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      latestExit.current()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [fullscreen])

  useEffect(() => {
    const proxy = frame.current?.contentWindow
    if (!proxy) return
    const admit = createRateLimiter()
    const appliedCsp = appliedMcpAppCsp(view.csp)
    const bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        message: { text: {} },
        logging: {},
        ...(view.files ? { downloadFile: {} } : {}),
        sandbox: {
          ...(appliedCsp ? { csp: appliedCsp } : {}),
          ...(view.permissions ? { permissions: view.permissions } : {}),
        },
      },
      { hostContext: latestHostContext.current() }
    )
    const refuse = () => {
      throw new Error("The App made too many requests")
    }
    bridge.oncalltool = async (params) => {
      if (!admit()) refuse()
      const request = McpAppToolCallRequestSchema.parse({
        name: params.name,
        arguments: params.arguments ?? {},
      })
      return adapter.callTool({ ...target, ...request })
    }
    bridge.onreadresource = async (params) => {
      if (!admit()) refuse()
      const request = McpAppResourceReadRequestSchema.parse({ uri: params.uri })
      const { agentId } = target
      return sharedReads(adapter)(
        { agentId, toolName: context.current.toolName, uri: request.uri },
        () => adapter.readResource({ ...target, ...request })
      )
    }
    // The view's own files open and download by a fresh pass, never by the
    // address it names.
    bridge.onopenlink = async ({ url }) => {
      if (!admit()) return { isError: true }
      const { files, renew } = context.current
      const argument = fileArgument(url, files)
      if (argument === undefined) return openAppLink(url)
      const fresh = await renew().catch(() => undefined)
      const address = fresh?.addresses[argument]
      return address === undefined
        ? { isError: true }
        : openAppLink(address, { ownFile: true })
    }
    bridge.ondownloadfile = async ({ contents }) => {
      if (!admit()) return { isError: true }
      const { files, renew } = context.current
      const links = contents.flatMap((item) => {
        if (item.type !== "resource_link") return []
        const argument = fileArgument(item.uri, files)
        return argument === undefined ? [] : [{ argument, name: item.name }]
      })
      if (links.length === 0 || links.length !== contents.length)
        return { isError: true }
      const fresh = await renew().catch(() => undefined)
      const saved = links.every(({ argument, name }) => {
        const address = fresh?.addresses[argument]
        return address !== undefined && saveAppFile(address, name)
      })
      return saved ? {} : { isError: true }
    }
    bridge.onmessage = async (params) => {
      const text = admit() ? appMessageText(params) : undefined
      if (text === undefined) return { isError: true }
      context.current.aui
        .thread()
        .append({ role: "user", content: [{ type: "text", text }] })
      return {}
    }
    bridge.onupdatemodelcontext = async () => {
      throw new Error("Model context updates are not supported")
    }
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const { onMove, placement: home } = context.current
      const granted = grantDisplayMode(
        mode,
        displayModeRef.current,
        offeredDisplayModes(onMove !== undefined),
        bridge.getAppCapabilities()?.availableDisplayModes
      )
      // Full screen grows the frame in place; the other placement is a fresh
      // frame there, since moving this one would reload the view anyway.
      if (granted !== "fullscreen" && granted !== home) onMove?.(granted)
      else {
        displayModeRef.current = granted
        setDisplayMode(granted)
      }
      return { mode: granted }
    }

    // A view's log lines stay in this browser's console, and go nowhere else.
    bridge.addEventListener("loggingmessage", ({ level, logger, data }) => {
      const name = context.current.toolName ?? mcpAppTargetKey(target)
      console.debug(`[${name}]`, level, ...(logger ? [logger] : []), data)
    })

    let active = true
    let handedOff = false
    let viewInitialized = false
    const readyTimeout = setTimeout(() => {
      if (active && !handedOff) context.current.onUnavailable?.()
    }, SANDBOX_READY_TIMEOUT_MS)
    bridge.addEventListener("sandboxready", () => {
      if (handedOff) return
      handedOff = true
      clearTimeout(readyTimeout)
      const { locale: lang, direction: dir } = context.current
      void bridge.sendSandboxResourceReady({
        html: prepareAppDocument(view.html, { csp, lang, dir }),
      })
    })
    // Nothing reaches the view before it reports `initialized`; the context
    // it initialized with may be stale by then, so the latest follows at once.
    bridge.addEventListener("initialized", () => {
      viewInitialized = true
      if (!active) return
      bridge.setHostContext(latestHostContext.current())
      setInitialized(true)
    })
    bridge.addEventListener("sizechange", ({ height: next, width: across }) => {
      if (typeof next === "number" && Number.isFinite(next) && next >= 0)
        setHeight(Math.ceil(next))
      setFitWidth(
        typeof across === "number" && Number.isFinite(across) && across > 0
          ? Math.ceil(across)
          : undefined
      )
    })

    bridgeRef.current = bridge
    sent.current = { input: false, result: false, cancelled: false }
    void bridge
      .connect(new PostMessageTransport(proxy, proxy))
      .then(() => {
        if (active) setConnected(true)
      })
      .catch(() => {})
    return () => {
      active = false
      clearTimeout(readyTimeout)
      bridgeRef.current = undefined
      setConnected(false)
      setInitialized(false)
      // Unmount removes the frame this very commit, so there is nothing left
      // to keep alive while the view answers: teardown is sent, not awaited.
      if (viewInitialized) bridge.teardownResource({}).catch(() => {})
      void bridge.close()
    }
  }, [adapter, csp, target, view])

  useEffect(() => {
    const bridge = bridgeRef.current
    if (!initialized || !bridge) return
    // A settled call whose arguments never reached this client still sends an
    // empty input first, so the view can fall back to what the result carries.
    const toolInput = input ?? (result === undefined ? undefined : {})
    if (toolInput !== undefined && !sent.current.input) {
      sent.current.input = true
      void bridge.sendToolInput({ arguments: toolInput })
    }
    const settled = sent.current.result || sent.current.cancelled
    if (result !== undefined && sent.current.input && !settled) {
      sent.current.result = true
      void bridge.sendToolResult(result)
    } else if (cancelled !== undefined && result === undefined && !settled) {
      sent.current.cancelled = true
      void bridge.sendToolCancelled({ reason: cancelled })
    }
  }, [cancelled, initialized, input, result])

  // Theme tokens settle after the class flips, so they are read a frame later.
  useEffect(() => {
    if (!initialized) return
    const frameId = requestAnimationFrame(() =>
      bridgeRef.current?.setHostContext(latestHostContext.current())
    )
    return () => cancelAnimationFrame(frameId)
  }, [initialized, displayMode, locale, size, theme, toolName])

  return (
    <div
      ref={container}
      tabIndex={-1}
      className={cn(
        "overflow-hidden outline-none",
        fullscreen
          ? "fixed inset-0 z-50 m-0 size-auto max-h-none max-w-none border-0 bg-background p-0"
          : inline
            ? [
                hugged === undefined ? "w-full" : "w-fit max-w-full",
                view.prefersBorder && "rounded-lg border border-border",
              ]
            : "size-full"
      )}
    >
      <iframe
        ref={frame}
        // Named for assistive technology without a hover tooltip.
        aria-label={title}
        sandbox={SANDBOX_PROXY_SANDBOX}
        allow={allow || undefined}
        referrerPolicy="no-referrer"
        src={connected ? sandboxProxyUrl(allow) : undefined}
        className={cn(
          "block w-full max-w-full border-0 bg-transparent",
          inline ? ["max-h-[80dvh]", height === undefined && "h-40"] : "h-full"
        )}
        // The sandbox page takes the same scheme, so neither frame paints an
        // opaque canvas behind a transparent view.
        style={{
          colorScheme: theme,
          ...(inline && height !== undefined ? { height } : {}),
          ...(hugged === undefined ? {} : { width: hugged }),
        }}
      />
      {fullscreen ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={exitFullscreen}
          aria-label={labels.mcpApp.exitFullscreen}
          className="absolute end-3 top-3 shadow-sm [@media(pointer:coarse)]:size-11"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  )
}
