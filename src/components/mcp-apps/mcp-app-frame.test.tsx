import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { McpUiCsp } from "@harness-gw/sdk/protocol"
import { ToolUiLocaleProvider } from "@/components/tool-ui"
import {
  McpAppFilesRefusedError,
  type McpAppAdapter,
} from "@/runtime-adapters/contracts"

import {
  sandboxAt,
  sandboxPagePolicy,
  sandboxPageUrl,
  sandboxPolicyOrigins,
} from "@shared/mcp-app-sandbox"

import { useFakeClock } from "../../../test/support/fake-clock"
import McpAppFrame, { type McpAppFrameProps } from "./mcp-app-frame"
import type { AppConnectionStatus } from "./use-app-files"

type DisplayModeHandler = (params: {
  mode: string
}) => Promise<{ mode: string }>
type Answer = { isError?: boolean }

const { FakeBridge, bridges } = vi.hoisted(() => {
  const bridges: InstanceType<typeof FakeBridge>[] = []
  class FakeBridge {
    onrequestdisplaymode?: DisplayModeHandler
    onopenlink?: (params: { url: string }) => Promise<Answer>
    ondownloadfile?: (params: { contents: unknown[] }) => Promise<Answer>
    onreadresource?: (params: { uri: string }) => Promise<unknown>
    readonly contexts: McpUiHostContext[] = []
    constructor(
      _client: unknown,
      _info: unknown,
      readonly capabilities: { sandbox?: { csp?: McpUiCsp } },
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
  renewFiles: vi.fn(),
}
const target = {
  agentId: "researcher",
  sessionId: "session-1",
  toolCallId: "t1",
}
const SANDBOX = "http://sandbox.localhost:3000"
/** The origins the test page is opened at. */
const LANE = {
  origins: {
    publicOrigins: [window.location.origin],
    mcpAppSandboxOrigin: SANDBOX,
    mcpAppFrameAncestors: [window.location.origin],
  },
} as const satisfies Pick<McpAppFrameProps, "origins">

function renderFrame(
  locale: "en" | "he" = "en",
  placed: Pick<McpAppFrameProps, "placement" | "onMove"> = {}
) {
  render(
    <ToolUiLocaleProvider locale={locale}>
      <McpAppFrame
        {...LANE}
        view={{ html: "<p>app</p>" }}
        openedAt={0}
        target={target}
        adapter={adapter}
        title="show_board app"
        {...placed}
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

  it("heads full screen with the view's name, focuses its close control, and returns to inline from it", async () => {
    const user = userEvent.setup()
    const { bridge, requestDisplayMode } = renderFrame()
    expect(screen.queryByRole("heading", { name: "show_board app" })).toBeNull()
    await act(async () => {
      await requestDisplayMode({ mode: "fullscreen" })
    })
    await waitFor(() => expect(latestMode(bridge)).toBe("fullscreen"))
    expect(
      screen.getByRole("heading", { name: "show_board app" })
    ).toBeVisible()
    const exit = screen.getByRole("button", { name: "Exit full screen" })
    expect(exit).toHaveFocus()

    await user.click(exit)

    expect(
      screen.queryByRole("button", { name: "Exit full screen" })
    ).toBeNull()
    expect(screen.getByLabelText("show_board app").parentElement).toHaveFocus()
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

  it("hands a side-panel request to its host and stays in its message", async () => {
    const onMove = vi.fn()
    const { bridge, requestDisplayMode } = renderFrame("en", { onMove })
    expect(bridge.contexts[0]).toMatchObject({
      availableDisplayModes: ["inline", "fullscreen", "pip"],
    })

    let granted: { mode: string } | undefined
    await act(async () => {
      granted = await requestDisplayMode({ mode: "pip" })
    })
    await act(() => new Promise((frame) => requestAnimationFrame(frame)))

    expect(granted).toEqual({ mode: "pip" })
    expect(onMove.mock.calls).toEqual([["pip"]])
    expect(bridge.contexts.map((context) => context.displayMode)).not.toContain(
      "pip"
    )
  })

  it("in the side panel, grows in place, returns there, and hands back inline", async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const { bridge, requestDisplayMode } = renderFrame("en", {
      placement: "pip",
      onMove,
    })
    expect(bridge.contexts[0]).toMatchObject({ displayMode: "pip" })

    await act(async () => {
      await requestDisplayMode({ mode: "fullscreen" })
    })
    await waitFor(() => expect(latestMode(bridge)).toBe("fullscreen"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(latestMode(bridge)).toBe("pip"))

    let granted: { mode: string } | undefined
    await act(async () => {
      granted = await requestDisplayMode({ mode: "inline" })
    })
    expect(granted).toEqual({ mode: "inline" })
    expect(onMove.mock.calls).toEqual([["inline"]])
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
          {...LANE}
          view={view}
          openedAt={0}
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
        {...LANE}
        view={view}
        openedAt={0}
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
            {...LANE}
            view={view}
            openedAt={0}
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
            {...LANE}
            view={view}
            openedAt={0}
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

describe("MCP App sandbox", () => {
  const frame = (
    props: Partial<McpAppFrameProps> = {},
    locale: "en" | "he" = "en"
  ) => (
    <ToolUiLocaleProvider locale={locale}>
      <McpAppFrame
        {...LANE}
        view={{ html: "<p>app</p>" }}
        openedAt={0}
        target={target}
        adapter={adapter}
        title="show_board app"
        {...props}
      />
    </ToolUiLocaleProvider>
  )

  it("loads the sandbox page from the sandbox origin, with the view's declared lists and no pass", async () => {
    render(
      frame({
        view: {
          html: "<p>app</p>",
          csp: { connectDomains: ["https://api.example.test"] },
          files: {
            addresses: {
              path: `${window.location.origin}/files/report.pdf?pass=secret`,
            },
          },
        },
      })
    )
    const sandbox = screen.getByLabelText("show_board app", {
      selector: "iframe",
    })
    expect(sandbox).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin"
    )
    await waitFor(() =>
      expect(sandbox).toHaveAttribute(
        "src",
        `${SANDBOX}/mcp-app-sandbox.html?${new URLSearchParams([
          ["connectDomains", "https://api.example.test"],
          ["file", `${window.location.origin}/files/report.pdf`],
        ])}`
      )
    )
  })

  it.each([
    [
      "an address AOS_UI_PUBLIC_ORIGIN does not list",
      {
        publicOrigins: ["https://aos.example.test"],
        mcpAppSandboxOrigin: SANDBOX,
        mcpAppFrameAncestors: ["https://aos.example.test"],
      },
    ],
    [
      "the sandbox origin",
      {
        publicOrigins: [window.location.origin],
        mcpAppSandboxOrigin: window.location.origin,
        mcpAppFrameAncestors: [window.location.origin],
      },
    ],
    ["any address, with no origins", undefined],
  ] as const)(
    "loads no frame on a page at %s, and names the setting",
    (_label, origins) => {
      render(frame({ origins }))
      expect(screen.queryByLabelText("show_board app")).toBeNull()
      expect(bridges).toEqual([])
      expect(screen.getByText("The app could not be shown.")).toBeVisible()
      expect(
        screen.getByText(
          `Apps show only at an address AOS_UI_PUBLIC_ORIGIN lists, and this page is at ${window.location.origin}.`
        )
      ).toBeVisible()
    }
  )

  it("reports the domains its sandbox page's policy applies, without one naming another lane's page", () => {
    const origins = {
      publicOrigins: [window.location.origin],
      mcpAppSandboxOrigin: SANDBOX,
      mcpAppFrameAncestors: [
        window.location.origin,
        "https://aos.example.test",
      ],
    }
    const csp = {
      connectDomains: ["https://aos.example.test", "https://api.example.test"],
    }
    render(frame({ origins, view: { html: "<p>app</p>", csp } }))

    const reported = bridges.at(-1)?.capabilities.sandbox?.csp
    expect(reported).toEqual({ connectDomains: ["https://api.example.test"] })
    // The server's header for the same view connects to exactly those.
    const query = new URL(
      sandboxPageUrl(SANDBOX, { allow: "", csp, fileLocations: [] }) ?? ""
    ).searchParams
    const policy = sandboxPagePolicy(sandboxPolicyOrigins(origins), query)
    expect(policy).toContain(
      `connect-src ${reported?.connectDomains?.join(" ")};`
    )
  })

  /** A stable host's key label, and the wildcard the lane frames them by. */
  const KEY = "0123456789abcdef0123456789abcdef"
  const STABLE_ORIGINS = "http://*.mcp-apps.localhost:3000"
  const stableLane = (mcpAppStableOrigins?: string) => ({
    ...LANE.origins,
    ...(mcpAppStableOrigins ? { mcpAppStableOrigins } : {}),
  })

  it.each([
    [
      "from its stable origin, by the wildcard's scheme and port, when its domain names one",
      STABLE_ORIGINS,
      `${KEY}.mcp-apps.localhost`,
      `http://${KEY}.mcp-apps.localhost:3000`,
    ],
    [
      "from the shared sandbox while the stable origins are unset",
      undefined,
      `${KEY}.mcp-apps.localhost`,
      SANDBOX,
    ],
  ] as const)(
    "loads a view %s",
    async (_label, stableOrigins, domain, origin) => {
      render(
        frame({
          origins: stableLane(stableOrigins),
          view: { html: "<p>app</p>", domain },
        })
      )
      const sandbox = screen.getByLabelText("show_board app", {
        selector: "iframe",
      })
      await waitFor(() =>
        expect(sandbox).toHaveAttribute("src", `${origin}/mcp-app-sandbox.html`)
      )
    }
  )

  it("reports the domains its stable page's policy applies, as the server serves that page by its host", async () => {
    const origins = stableLane(STABLE_ORIGINS)
    const stable = `http://${KEY}.mcp-apps.localhost:3000`
    const csp = {
      connectDomains: [stable, SANDBOX, "https://api.example.test"],
    }
    render(
      frame({
        origins,
        view: { html: "<p>app</p>", csp, domain: `${KEY}.mcp-apps.localhost` },
      })
    )
    const sandbox = screen.getByLabelText("show_board app", {
      selector: "iframe",
    })
    await waitFor(() => expect(sandbox).toHaveAttribute("src"))

    // The view may not reach its own origin; the shared sandbox is another.
    const reported = bridges.at(-1)?.capabilities.sandbox?.csp
    expect(reported).toEqual({
      connectDomains: [SANDBOX, "https://api.example.test"],
    })
    const page = new URL(sandbox.getAttribute("src") ?? "")
    const served = sandboxAt(origins, page.host)
    if (served === undefined || served === "refused")
      throw new Error(`${page.host} is no sandbox`)
    expect(sandboxPagePolicy(served, page.searchParams)).toContain(
      `connect-src ${reported?.connectDomains?.join(" ")};`
    )
  })

  it("names the setting in Hebrew", () => {
    render(frame({ origins: undefined }, "he"))
    expect(
      screen.getByText(
        `יישומונים מוצגים רק בכתובת שמופיעה ב־AOS_UI_PUBLIC_ORIGIN, והדף הזה נמצא ב־${window.location.origin}.`
      )
    ).toBeVisible()
  })

  it("loads no frame for a view whose lists outgrow the sandbox page's address", () => {
    render(
      frame({
        view: {
          html: "<p>app</p>",
          csp: {
            connectDomains: Array.from(
              { length: 400 },
              (_, index) => `https://api-${index}.example.test`
            ),
          },
        },
      })
    )
    expect(screen.queryByLabelText("show_board app")).toBeNull()
    expect(screen.getByText("The app could not be shown.")).toBeVisible()
  })

  it("drops the view once its sandbox frame loads a second time", async () => {
    const onUnavailable = vi.fn()
    render(frame({ onUnavailable }))
    const sandbox = screen.getByLabelText("show_board app", {
      selector: "iframe",
    })
    // The blank document before the address is set is not the sandbox page.
    fireEvent.load(sandbox)
    await waitFor(() => expect(sandbox).toHaveAttribute("src"))
    fireEvent.load(sandbox)
    expect(onUnavailable).not.toHaveBeenCalled()

    fireEvent.load(sandbox)
    expect(onUnavailable).toHaveBeenCalledOnce()
  })
})

describe("MCP App files", () => {
  const address = (toolCallId: string, pass: string) =>
    `${window.location.origin}/api/v1/agents/researcher/sessions/session-1/tool-calls/${toolCallId}/app/files/path?pass=${pass}`
  const files = (pass: string, expiresAt: number) => ({
    addresses: { path: address("t1", pass) },
    expiresAt: new Date(expiresAt).toISOString(),
  })
  let clock: ReturnType<typeof useFakeClock>
  beforeEach(() => {
    clock = useFakeClock()
  })

  /** A view whose ten-minute passes arrived at 0, mounted at `mountedAt`. */
  function mountFiles({
    renewFiles = async () => files("fresh", 1_200_000),
    connectionStatus,
    mountedAt = 0,
  }: {
    renewFiles?: McpAppAdapter["renewFiles"]
    connectionStatus?: AppConnectionStatus
    mountedAt?: number
  } = {}) {
    vi.setSystemTime(mountedAt)
    const apps = { ...adapter, renewFiles: vi.fn(renewFiles) }
    const view = { html: "<p>app</p>", files: files("first", 600_000) }
    const frame = (status?: AppConnectionStatus) => (
      <ToolUiLocaleProvider locale="en">
        <McpAppFrame
          {...LANE}
          view={view}
          openedAt={0}
          connectionStatus={status}
          target={target}
          adapter={apps}
          title="report app"
        />
      </ToolUiLocaleProvider>
    )
    const { rerender, unmount } = render(frame(connectionStatus))
    const bridge = bridges.at(-1)!
    act(() => bridge.initialize())
    return {
      bridge,
      renewFiles: apps.renewFiles,
      unmount,
      setStatus: (status: AppConnectionStatus) =>
        act(async () => rerender(frame(status))),
    }
  }
  const viewFiles = (bridge: FakeBridge) =>
    bridge.contexts.at(-1)?.["aos/files"]

  it("hands the view its file's revision, and a new one at once without remounting it", () => {
    const view = { html: "<p>app</p>" }
    const frame = (revision: string) => (
      <ToolUiLocaleProvider locale="en">
        <McpAppFrame
          {...LANE}
          view={view}
          openedAt={0}
          target={target}
          adapter={adapter}
          title="report.pdf"
          filesRevision={revision}
        />
      </ToolUiLocaleProvider>
    )
    const { rerender } = render(frame("t1"))
    const bridge = bridges.at(-1)!
    act(() => bridge.initialize())
    expect(bridge.contexts.at(-1)?.["aos/filesRevision"]).toBe("t1")

    rerender(frame("t2"))
    expect(bridge.contexts.at(-1)?.["aos/filesRevision"]).toBe("t2")
    expect(bridges).toHaveLength(1)
  })

  it("renews the passes at half their life and hands the view the fresh addresses", async () => {
    const { bridge, renewFiles } = mountFiles()
    expect(viewFiles(bridge)).toEqual({ path: address("t1", "first") })

    await act(() => clock.advance(299_999))
    expect(renewFiles).not.toHaveBeenCalled()
    await act(() => clock.advance(1))
    expect(renewFiles.mock.calls).toEqual([[target]])
    expect(viewFiles(bridge)).toEqual({ path: address("t1", "fresh") })
    expect(bridges).toHaveLength(1)
  })

  it("renews at once a view that mounts past its passes' half-life", async () => {
    const { renewFiles } = mountFiles({ mountedAt: 400_000 })
    await act(() => clock.advance(0))
    expect(renewFiles.mock.calls).toEqual([[target]])
  })

  it("stops renewing once the view is gone", async () => {
    const { renewFiles, unmount } = mountFiles()
    unmount()
    await clock.advance(600_000)
    expect(renewFiles).not.toHaveBeenCalled()
  })

  it.each([
    [
      "shows again",
      () => document.dispatchEvent(new Event("visibilitychange")),
    ],
    ["comes back online", () => window.dispatchEvent(new Event("online"))],
  ])(
    "renews past half-life when the page %s, since its timer may have stalled",
    async (_label, wake) => {
      const { renewFiles } = mountFiles()
      await act(async () => wake())
      expect(renewFiles).not.toHaveBeenCalled()

      vi.setSystemTime(300_000)
      await act(async () => wake())
      expect(renewFiles.mock.calls).toEqual([[target]])
    }
  )

  it("renews when the connection comes back, but not on mounting after it did", async () => {
    const { renewFiles, setStatus } = mountFiles({
      connectionStatus: "reconnected",
    })
    await setStatus("reconnecting")
    expect(renewFiles).not.toHaveBeenCalled()
    await setStatus("reconnected")
    expect(renewFiles.mock.calls).toEqual([[target]])
  })

  it("retries a failed renewal with backoff until the gateway refuses it", async () => {
    const { renewFiles, setStatus } = mountFiles({
      renewFiles: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockRejectedValueOnce(new McpAppFilesRefusedError("gone")),
    })
    await act(() => clock.advance(300_000))
    expect(renewFiles).toHaveBeenCalledTimes(1)
    await act(() => clock.advance(1_000))
    expect(renewFiles).toHaveBeenCalledTimes(2)

    await act(() => clock.advance(600_000))
    await setStatus("reconnecting")
    await setStatus("reconnected")
    expect(renewFiles).toHaveBeenCalledTimes(2)
  })

  function recordDownloads() {
    const downloads: Array<{ href: string; name: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function record(this: HTMLAnchorElement) {
        downloads.push({ href: this.href, name: this.download })
      }
    )
    return downloads
  }
  const link = (uri: string, name = "report.pdf") => ({
    type: "resource_link",
    uri,
    name,
  })

  it("downloads the view's own file by a fresh pass, under a safe name", async () => {
    const downloads = recordDownloads()
    const { bridge, renewFiles } = mountFiles()
    let answer: Answer | undefined
    await act(async () => {
      answer = await bridge.ondownloadfile?.({
        contents: [link(address("t1", "first"), "../Q3: final.pdf")],
      })
    })
    expect(answer).toEqual({})
    expect(renewFiles).toHaveBeenCalledOnce()
    expect(downloads).toEqual([
      { href: address("t1", "fresh"), name: "Q3_ final.pdf" },
    ])
  })

  it.each([
    ["another call's file", link(address("t2", "first"))],
    ["an outside address", link("https://example.com/report.pdf")],
    ["a data URL", link("data:text/plain,hi")],
    ["a script URL", link("javascript:alert(1)")],
    [
      "contents the view embedded",
      {
        type: "resource",
        resource: { uri: address("t1", "first"), text: "hi" },
      },
    ],
  ])("refuses to download %s", async (_label, contents) => {
    const downloads = recordDownloads()
    const { bridge, renewFiles } = mountFiles()
    let answer: Answer | undefined
    await act(async () => {
      answer = await bridge.ondownloadfile?.({ contents: [contents] })
    })
    expect(answer).toEqual({ isError: true })
    expect(renewFiles).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it("counts downloads against the view's request limit", async () => {
    const downloads = recordDownloads()
    const { bridge, renewFiles } = mountFiles()
    const download = (uri: string) =>
      bridge.ondownloadfile?.({ contents: [link(uri)] })
    let answer: Answer | undefined
    await act(async () => {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          download("https://example.com/report.pdf")
        )
      )
      answer = await download(address("t1", "first"))
    })
    expect(answer).toEqual({ isError: true })
    expect(renewFiles).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it("opens the view's own file by a fresh pass", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const { bridge } = mountFiles()
    let answer: Answer | undefined
    await act(async () => {
      answer = await bridge.onopenlink?.({ url: address("t1", "stale") })
    })
    expect(answer).toEqual({})
    expect(open.mock.calls).toEqual([
      [address("t1", "fresh"), "_blank", "noopener,noreferrer"],
    ])
  })

  it("reads a server's view resource once for all the views it hosts", async () => {
    const uri = "ui://aos-ui/pdfjs/viewer.mjs"
    const read = { contents: [{ uri, text: "export {}" }] }
    let finish: ((value: typeof read) => void) | undefined
    const readResource = vi.fn(
      () =>
        new Promise<typeof read>((resolve) => {
          finish = resolve
        })
    )
    const apps = { ...adapter, readResource }
    for (const toolCallId of ["t1", "t2"])
      render(
        <ToolUiLocaleProvider locale="en">
          <McpAppFrame
            {...LANE}
            view={{ html: "<p>app</p>" }}
            openedAt={0}
            target={{ ...target, toolCallId }}
            adapter={apps}
            title={`${toolCallId} app`}
            toolName="present_artifact"
          />
        </ToolUiLocaleProvider>
      )

    const reads = bridges.map((bridge) => bridge.onreadresource?.({ uri }))
    finish?.(read)
    expect(await Promise.all(reads)).toEqual([read, read])
    expect(readResource).toHaveBeenCalledOnce()
  })
})
