"use client"

import { useAui } from "@assistant-ui/react"
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiHostContext,
  type McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
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
  AVAILABLE_DISPLAY_MODES,
  appMessageText,
  createRateLimiter,
  grantDisplayMode,
  openAppLink,
  type AppDisplayMode,
} from "./host-handlers"
import {
  SANDBOX_PROXY_SANDBOX,
  prepareAppDocument,
  sandboxProxyUrl,
} from "./sandbox-proxy"

const HOST_INFO = { name: "AOS", version: "1.0.0" }
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
  target: McpAppTarget
  adapter: McpAppAdapter
  title: string
}

/**
 * Hosts one MCP App view (spec 2026-01-26) behind the sandbox proxy. The bridge
 * answers the view from this Session only: its tool calls and resource reads go
 * to the runtime's App adapter, its messages become the operator's next turn in
 * this thread, and nothing else it asks for is granted. The view mounts while
 * its call still runs and receives the input and the result as each arrives.
 */
export default function McpAppFrame({
  view,
  input,
  result,
  cancelled,
  toolName,
  target,
  adapter,
  title,
  onUnavailable,
}: McpAppFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<AppBridge | undefined>(undefined)
  const [connected, setConnected] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const sent = useRef({ input: false, result: false, cancelled: false })
  const [height, setHeight] = useState<number>()
  const [size, setSize] = useState<{ width: number; height: number }>()
  const [displayMode, setDisplayMode] = useState<AppDisplayMode>("inline")
  const displayModeRef = useRef(displayMode)
  const aui = useAui()
  const { labels, locale, direction } = useToolUiLocale()
  const { forcedTheme, resolvedTheme } = useTheme()
  const theme =
    forcedTheme === "dark" ||
    (forcedTheme !== "light" && resolvedTheme === "dark")
      ? "dark"
      : "light"
  const csp = useMemo(() => buildMcpAppCsp(view.csp), [view.csp])
  const allow = useMemo(
    () => buildAllowAttribute(view.permissions),
    [view.permissions]
  )
  const context = useRef({ aui, locale, direction, onUnavailable, toolName })
  useEffect(() => {
    context.current = { aui, locale, direction, onUnavailable, toolName }
  }, [aui, direction, locale, onUnavailable, toolName])

  const hostContext = (): McpUiHostContext => ({
    ...(toolName === undefined
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
    availableDisplayModes: [...AVAILABLE_DISPLAY_MODES],
    platform: "web",
    deviceCapabilities: {
      touch: mediaMatches("(any-pointer: coarse)"),
      hover: mediaMatches("(any-hover: hover)"),
    },
    // Inline, the view sits inside the message, clear of every device edge.
    safeAreaInsets:
      displayMode === "fullscreen" ? viewportSafeAreaInsets() : NO_INSETS,
    styles: { variables: styleVariables() },
    ...(size === undefined
      ? {}
      : {
          containerDimensions:
            displayMode === "fullscreen"
              ? size
              : {
                  width: size.width,
                  maxHeight: Math.round(window.innerHeight * MAX_HEIGHT_SHARE),
                },
        }),
  })
  const latestHostContext = useRef(hostContext)
  useEffect(() => {
    latestHostContext.current = hostContext
  })

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
    return () => observer.disconnect()
  }, [])

  const fullscreen = displayMode === "fullscreen"
  const restoreFocus = useRef(false)
  const exitFullscreen = () => {
    displayModeRef.current = "inline"
    restoreFocus.current = true
    setDisplayMode("inline")
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
      return adapter.readResource({ ...target, ...request })
    }
    bridge.onopenlink = async ({ url }) =>
      admit() ? openAppLink(url) : { isError: true }
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
      const granted = grantDisplayMode(
        mode,
        displayModeRef.current,
        bridge.getAppCapabilities()?.availableDisplayModes
      )
      displayModeRef.current = granted
      setDisplayMode(granted)
      return { mode: granted }
    }

    // A view's log lines stay in this browser's console, and go nowhere else.
    bridge.addEventListener("loggingmessage", ({ level, logger, data }) => {
      const name = context.current.toolName ?? target.toolCallId
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
    bridge.addEventListener("sizechange", ({ height: next }) => {
      if (typeof next === "number" && Number.isFinite(next) && next >= 0)
        setHeight(Math.ceil(next))
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
          : ["w-full", view.prefersBorder && "rounded-lg border border-border"]
      )}
    >
      <iframe
        ref={frame}
        title={title}
        sandbox={SANDBOX_PROXY_SANDBOX}
        allow={allow || undefined}
        referrerPolicy="no-referrer"
        src={connected ? sandboxProxyUrl(allow) : undefined}
        className={cn(
          "block w-full border-0 bg-transparent",
          fullscreen
            ? "h-full"
            : ["max-h-[80dvh]", height === undefined && "h-40"]
        )}
        // The sandbox page takes the same scheme, so neither frame paints an
        // opaque canvas behind a transparent view.
        style={{
          colorScheme: theme,
          ...(fullscreen || height === undefined ? {} : { height }),
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
