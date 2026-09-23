import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ToolUiLocaleProvider } from "@/components/tool-ui"
import type { McpAppAdapter } from "@/runtime-adapters/contracts"

import McpAppFrame from "./mcp-app-frame"

type DisplayModeHandler = (params: {
  mode: string
}) => Promise<{ mode: string }>

const { FakeBridge, bridges } = vi.hoisted(() => {
  const bridges: InstanceType<typeof FakeBridge>[] = []
  class FakeBridge {
    onrequestdisplaymode?: DisplayModeHandler
    readonly contexts: McpUiHostContext[] = []
    constructor(
      _client: unknown,
      _info: unknown,
      _capabilities: unknown,
      options: { hostContext: McpUiHostContext }
    ) {
      this.contexts.push(options.hostContext)
      bridges.push(this)
    }
    readonly listeners = new Map<string, () => void>()
    readonly sent: Array<[string, unknown]> = []
    appCapabilities?: { availableDisplayModes?: string[] }
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener)
    }
    getAppCapabilities() {
      return this.appCapabilities
    }
    initialize() {
      this.listeners.get("initialized")?.()
    }
    sendToolInput = async (params: unknown) => {
      this.sent.push(["tool-input", params])
    }
    sendToolResult = async (params: unknown) => {
      this.sent.push(["tool-result", params])
    }
    sendSandboxResourceReady = async () => {}
    sendToolCancelled = async (params: unknown) => {
      this.sent.push(["tool-cancelled", params])
    }
    connect = async () => {}
    close = async () => {}
    teardownResource = async () => {
      this.sent.push(["teardown", {}])
      return {}
    }
    setHostContext(context: McpUiHostContext) {
      this.contexts.push(context)
    }
  }
  return { FakeBridge, bridges }
})
type FakeBridge = InstanceType<typeof FakeBridge>

vi.mock("@assistant-ui/react", () => ({ useAui: () => ({}) }))
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: FakeBridge,
  PostMessageTransport: class {},
  buildAllowAttribute: () => "",
}))

afterEach(() => {
  cleanup()
  bridges.length = 0
})

const adapter: McpAppAdapter = {
  open: vi.fn(),
  callTool: vi.fn(),
  readResource: vi.fn(),
}
const target = {
  agentId: "researcher",
  threadId: "session-1",
  toolCallId: "t1",
}

function renderFrame(locale: "en" | "he" = "en") {
  render(
    <ToolUiLocaleProvider locale={locale}>
      <McpAppFrame
        view={{ html: "<p>app</p>" }}
        target={target}
        adapter={adapter}
        title="show_board app"
      />
    </ToolUiLocaleProvider>
  )
  const bridge = bridges.at(-1)
  if (!bridge?.onrequestdisplaymode) throw new Error("No bridge")
  act(() => bridge.initialize())
  return { bridge, requestDisplayMode: bridge.onrequestdisplaymode }
}

const latestMode = (bridge: FakeBridge) => bridge.contexts.at(-1)?.displayMode

describe("MCP App display modes", () => {
  it("offers inline and fullscreen and grants what it offers", async () => {
    const { bridge, requestDisplayMode } = renderFrame()
    expect(bridge.contexts[0]).toMatchObject({
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
    })

    let granted: { mode: string } | undefined
    await act(async () => {
      granted = await requestDisplayMode({ mode: "fullscreen" })
    })
    expect(granted).toEqual({ mode: "fullscreen" })
    expect(
      screen.getByRole("button", { name: "Exit full screen" })
    ).toBeVisible()

    await act(async () => {
      granted = await requestDisplayMode({ mode: "pip" })
    })
    expect(granted).toEqual({ mode: "fullscreen" })

    await act(async () => {
      granted = await requestDisplayMode({ mode: "inline" })
    })
    expect(granted).toEqual({ mode: "inline" })
    expect(
      screen.queryByRole("button", { name: "Exit full screen" })
    ).toBeNull()
  })

  it("grants only a mode the view declared", async () => {
    const { bridge, requestDisplayMode } = renderFrame()
    bridge.appCapabilities = { availableDisplayModes: ["inline"] }
    let granted: { mode: string } | undefined
    await act(async () => {
      granted = await requestDisplayMode({ mode: "fullscreen" })
    })
    expect(granted).toEqual({ mode: "inline" })
    expect(
      screen.queryByRole("button", { name: "Exit full screen" })
    ).toBeNull()
  })

  it("returns to inline from the close control and tells the App", async () => {
    const user = userEvent.setup()
    const { bridge, requestDisplayMode } = renderFrame()
    await act(async () => {
      await requestDisplayMode({ mode: "fullscreen" })
    })
    await waitFor(() => expect(latestMode(bridge)).toBe("fullscreen"))

    await user.click(screen.getByRole("button", { name: "Exit full screen" }))

    expect(
      screen.queryByRole("button", { name: "Exit full screen" })
    ).toBeNull()
    expect(screen.getByTitle("show_board app").parentElement).toHaveFocus()
    await waitFor(() => expect(latestMode(bridge)).toBe("inline"))
  })

  it("returns to inline on Escape and names the control in Hebrew", async () => {
    const user = userEvent.setup()
    const { requestDisplayMode } = renderFrame("he")
    await act(async () => {
      await requestDisplayMode({ mode: "fullscreen" })
    })
    expect(screen.getByRole("button", { name: "יציאה ממסך מלא" })).toBeVisible()

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("button", { name: "יציאה ממסך מלא" })).toBeNull()
  })
})

describe("MCP App tool data", () => {
  const result = { content: [{ type: "text" as const, text: "done" }] }

  function frame(props: {
    input?: Record<string, unknown>
    result?: typeof result
    cancelled?: string
  }) {
    return (
      <ToolUiLocaleProvider locale="en">
        <McpAppFrame
          view={view}
          target={target}
          adapter={adapter}
          title="show_board app"
          {...props}
        />
      </ToolUiLocaleProvider>
    )
  }
  const view = { html: "<p>app</p>" }

  it("sends the input once it is known and the result once the call settles", async () => {
    const { rerender } = render(frame({}))
    const bridge = bridges.at(-1)!
    act(() => bridge.listeners.get("initialized")?.())
    expect(bridge.sent).toEqual([])

    rerender(frame({ input: { board: "launch" } }))
    rerender(frame({ input: { board: "launch" } }))
    await waitFor(() =>
      expect(bridge.sent).toEqual([
        ["tool-input", { arguments: { board: "launch" } }],
      ])
    )

    rerender(frame({ input: { board: "launch" }, result }))
    await waitFor(() =>
      expect(bridge.sent).toEqual([
        ["tool-input", { arguments: { board: "launch" } }],
        ["tool-result", result],
      ])
    )
    expect(bridges).toHaveLength(1)
  })

  it("sends an empty input before a result that arrived without one", async () => {
    render(frame({ result }))
    const bridge = bridges.at(-1)!
    act(() => bridge.listeners.get("initialized")?.())
    await waitFor(() =>
      expect(bridge.sent).toEqual([
        ["tool-input", { arguments: {} }],
        ["tool-result", result],
      ])
    )
  })

  it("tells the view a call ended without a result, and never sends one", async () => {
    const { rerender } = render(frame({ input: { board: "launch" } }))
    const bridge = bridges.at(-1)!
    act(() => bridge.initialize())

    rerender(frame({ input: { board: "launch" }, cancelled: "failed" }))
    rerender(frame({ input: { board: "launch" }, cancelled: "failed" }))
    rerender(frame({ input: { board: "launch" }, cancelled: "failed", result }))
    await waitFor(() =>
      expect(bridge.sent).toEqual([
        ["tool-input", { arguments: { board: "launch" } }],
        ["tool-cancelled", { reason: "failed" }],
      ])
    )
  })

  it("sends a cancellation that arrived before the view initialized", async () => {
    render(frame({ cancelled: "The tool call failed" }))
    const bridge = bridges.at(-1)!
    expect(bridge.sent).toEqual([])
    act(() => bridge.initialize())
    await waitFor(() =>
      expect(bridge.sent).toEqual([
        ["tool-cancelled", { reason: "The tool call failed" }],
      ])
    )
  })
})

describe("MCP App lifecycle", () => {
  const view = { html: "<p>app</p>" }
  const frame = (
    <ToolUiLocaleProvider locale="en">
      <McpAppFrame
        view={view}
        target={target}
        adapter={adapter}
        title="show_board app"
        toolName="show_board"
      />
    </ToolUiLocaleProvider>
  )
  const nextFrame = () =>
    act(() => new Promise((done) => requestAnimationFrame(() => done(null))))

  it("sends no host context before the view initializes", async () => {
    render(frame)
    const bridge = bridges.at(-1)!
    await nextFrame()
    expect(bridge.contexts).toHaveLength(1)
    expect(bridge.contexts[0]).toMatchObject({
      toolInfo: { id: "t1", tool: { name: "show_board" } },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    })

    act(() => bridge.initialize())
    expect(bridge.contexts.length).toBeGreaterThan(1)
  })

  it("tears down only a view that initialized", () => {
    const { unmount } = render(frame)
    const bridge = bridges.at(-1)!
    unmount()
    expect(bridge.sent).toEqual([])

    const second = render(frame)
    const initialized = bridges.at(-1)!
    act(() => initialized.initialize())
    second.unmount()
    expect(initialized.sent).toEqual([["teardown", {}]])
  })

  it("reports the view unavailable when the sandbox never gets ready", () => {
    vi.useFakeTimers()
    try {
      const onUnavailable = vi.fn()
      render(
        <ToolUiLocaleProvider locale="en">
          <McpAppFrame
            view={view}
            target={target}
            adapter={adapter}
            title="show_board app"
            onUnavailable={onUnavailable}
          />
        </ToolUiLocaleProvider>
      )
      act(() => vi.advanceTimersByTime(9_999))
      expect(onUnavailable).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(onUnavailable).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the view once the sandbox reports ready", () => {
    vi.useFakeTimers()
    try {
      const onUnavailable = vi.fn()
      render(
        <ToolUiLocaleProvider locale="en">
          <McpAppFrame
            view={view}
            target={target}
            adapter={adapter}
            title="show_board app"
            onUnavailable={onUnavailable}
          />
        </ToolUiLocaleProvider>
      )
      act(() => bridges.at(-1)!.listeners.get("sandboxready")?.())
      act(() => vi.advanceTimersByTime(10_000))
      expect(onUnavailable).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
