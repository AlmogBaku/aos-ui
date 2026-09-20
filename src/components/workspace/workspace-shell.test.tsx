import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { useSessionTabUndo } from "./session-tab-undo"

import {
  WorkspaceConversationShell,
  WorkspaceShell,
  type WorkspaceAgent,
  type WorkspaceSession,
} from "./workspace-shell"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const agents: WorkspaceAgent[] = [
  {
    id: "agent-aster",
    name: "Aster",
    description: "General analysis and synthesis",
    status: "running",
    icon: { kind: "symbol", symbol: "spark", tone: "indigo" },
  },
  {
    id: "agent-mica",
    name: "Mica",
    description: "Long-form synthesis",
    status: "idle",
    icon: { kind: "symbol", symbol: "layers", tone: "purple" },
  },
]

const openSessions: WorkspaceSession[] = [
  {
    threadId: "thread-market",
    title: "Market brief",
    status: "running",
    updatedAt: "2026-09-03T11:00:00.000Z",
  },
  {
    threadId: "thread-launch",
    title: "Launch review",
    status: "idle",
    updatedAt: "2026-09-03T07:00:00.000Z",
  },
  {
    threadId: "thread-scan",
    title: "Competitive scan",
    status: "waiting-for-input",
    updatedAt: "2026-09-03T01:00:00.000Z",
  },
]

const olderSessions: WorkspaceSession[] = [
  {
    threadId: "thread-pricing",
    title: "Pricing analysis",
    status: "idle",
    updatedAt: "2026-09-01T11:00:00.000Z",
  },
]

function renderShell(
  overrides: Partial<React.ComponentProps<typeof WorkspaceShell>> = {}
) {
  const props: React.ComponentProps<typeof WorkspaceShell> = {
    locale: "en",
    dictionary: en,
    agents,
    openSessions,
    olderSessions,
    navigationCatalog: new Map([
      [
        "agent-aster",
        {
          agentId: "agent-aster",
          openSessions,
          historySessions: olderSessions,
          lastSelectedThreadId: "thread-market",
        },
      ],
      [
        "agent-mica",
        {
          agentId: "agent-mica",
          openSessions: [
            {
              threadId: "thread-mica-draft",
              title: "Mica draft",
              status: "idle" as const,
              updatedAt: "2026-09-02T11:00:00.000Z",
              canClose: true,
            },
          ],
          historySessions: [],
          lastSelectedThreadId: "thread-mica-draft",
        },
      ],
    ]),
    selectedAgentId: "agent-aster",
    activeThreadId: "thread-market",
    onSelectAgent: vi.fn(),
    onOpenSession: vi.fn(),
    onCloseSession: vi.fn(),
    onCreateSession: vi.fn(),
    onOpenAgentBuilder: vi.fn(),
    children: <div>Assistant UI conversation</div>,
    ...overrides,
  }

  return { ...render(<WorkspaceShell {...props} />), props }
}

describe("WorkspaceShell", () => {
  it("reuses the workspace conversation and artifact pane without navigation chrome", () => {
    const ResizeObserverBefore = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 1024 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      }
      unobserve() {}
      disconnect() {}
    }

    render(
      <WorkspaceConversationShell
        locale="en"
        dictionary={en}
        header={<header>Invited by Northwind</header>}
        artifactViewer={<div>Artifact preview body</div>}
        artifactViewerOpen
        artifactViewerLabel="Output preview"
      >
        <div>Assistant UI conversation</div>
      </WorkspaceConversationShell>
    )

    expect(screen.getByText("Invited by Northwind")).toBeVisible()
    expect(screen.getByText("Assistant UI conversation")).toBeVisible()
    expect(
      within(
        screen.getByRole("complementary", { name: "Output preview" })
      ).getByText("Artifact preview body")
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: "Open Agents" })).toBeNull()
    expect(screen.queryByRole("tab")).toBeNull()
    expect(
      screen.getByRole("separator", { name: "Resize output preview" })
    ).toBeVisible()
    globalThis.ResizeObserver = ResizeObserverBefore
  })

  it("keeps the regular workspace artifact default independent", () => {
    renderShell({
      artifactViewer: <div>Artifact</div>,
      artifactViewerOpen: true,
      artifactViewerLabel: "Output preview",
    })

    expect(screen.getByRole("dialog", { name: "Output preview" })).toBeVisible()
  })

  it("resizes the shared desktop artifact pane with the keyboard and persists its width", () => {
    const ResizeObserverBefore = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 1024 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      }
      unobserve() {}
      disconnect() {}
    }

    const view = render(
      <WorkspaceConversationShell
        locale="en"
        dictionary={en}
        header={<header>Guest</header>}
        artifactViewer={<div>Artifact</div>}
        artifactViewerOpen
        artifactViewerLabel="Output preview"
      >
        <div>Conversation</div>
      </WorkspaceConversationShell>
    )
    const separator = screen.getByRole("separator", {
      name: "Resize output preview",
    })
    const initialWidth = Number(separator.getAttribute("aria-valuenow"))
    vi.spyOn(
      screen.getByRole("complementary", { name: "Output preview" }),
      "getBoundingClientRect"
    ).mockReturnValue({ width: 480 } as DOMRect)

    fireEvent.keyDown(separator, { key: "ArrowLeft" })

    const resizedWidth = Number(separator.getAttribute("aria-valuenow"))
    expect(resizedWidth).toBeGreaterThan(initialWidth)

    view.unmount()
    renderShell({
      artifactViewer: <div>Artifact</div>,
      artifactViewerOpen: true,
      artifactViewerLabel: "Output preview",
    })
    expect(
      Number(
        screen
          .getByRole("separator", { name: "Resize output preview" })
          .getAttribute("aria-valuenow")
      )
    ).toBe(resizedWidth)
    globalThis.ResizeObserver = ResizeObserverBefore
  })

  it("uses physical arrow direction for the RTL artifact separator", () => {
    const ResizeObserverBefore = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 1024 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      }
      unobserve() {}
      disconnect() {}
    }
    renderShell({
      locale: "he",
      dictionary: he,
      artifactViewer: <div>Artifact</div>,
      artifactViewerOpen: true,
      artifactViewerLabel: "תצוגה מקדימה של התוצר",
    })
    const separator = screen.getByRole("separator", {
      name: "שינוי רוחב תצוגה מקדימה של התוצר",
    })
    const initialWidth = Number(separator.getAttribute("aria-valuenow"))

    fireEvent.keyDown(separator, { key: "ArrowRight" })

    const afterRight = Number(separator.getAttribute("aria-valuenow"))
    expect(afterRight).not.toBe(initialWidth)
    globalThis.ResizeObserver = ResizeObserverBefore
  })

  it("shows Session Outputs in the inspector and replaces them with an open artifact", () => {
    const ResizeObserverBefore = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 1024 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      }
      unobserve() {}
      disconnect() {}
    }
    const { rerender, props } = renderShell({
      artifactOutputs: <div>Published outputs</div>,
    })
    let inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })
    expect(within(inspector).getByText("Published outputs")).toBeVisible()

    rerender(
      <WorkspaceShell
        {...props}
        artifactOutputs={<div>Published outputs</div>}
        artifactViewer={<div>Artifact preview body</div>}
        artifactViewerOpen
        artifactViewerLabel="Output preview"
        onCloseArtifactViewer={vi.fn()}
      />
    )
    inspector = screen.getByRole("complementary", { name: "Output preview" })
    expect(within(inspector).getByText("Artifact preview body")).toBeVisible()
    expect(within(inspector).queryByText("Published outputs")).toBeNull()
    globalThis.ResizeObserver = ResizeObserverBefore
  })

  it("searches the selected Agent's open Sessions and history in the desktop inspector", () => {
    renderShell()

    const inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })
    expect(
      within(inspector).getByRole("region", { name: "Open sessions" })
    ).toBeVisible()
    expect(
      within(inspector).getByRole("region", { name: "History" })
    ).toBeVisible()

    fireEvent.change(
      within(inspector).getByRole("searchbox", { name: "Search Sessions" }),
      { target: { value: "pricing" } }
    )
    expect(within(inspector).getByText("Pricing analysis")).toBeVisible()
    expect(within(inspector).queryByText("Market brief")).toBeNull()
  })

  it.each([
    ["en", en, "Active"],
    ["he", he, "פעיל לאחרונה"],
  ] as const)(
    "labels Agent activity separately from execution in %s",
    (locale, dictionary, label) => {
      renderShell({
        locale,
        dictionary,
        agents: [{ ...agents[0], status: "active" }],
        selectedAgentId: agents[0].id,
      })
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  )
  it.each([true, false])(
    "returns focused Undo to a safe target at exactly 8 seconds (active tab: %s)",
    (hasActiveTab) => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useSessionTabUndo())
      act(() =>
        result.current.remember({
          agentId: "agent-aster",
          threadId: "closed",
          title: "Closed Session",
          selectedThreadId: "thread-market",
        })
      )
      const { props, rerender } = renderShell({
        openSessions: hasActiveTab ? openSessions : [],
        activeThreadId: hasActiveTab ? "thread-market" : null,
        tabUndo: { title: result.current.pending!.title, onUndo: vi.fn() },
      })
      screen.getByRole("button", { name: "Undo" }).focus()
      act(() => vi.advanceTimersByTime(7999))
      expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus()
      expect(result.current.pending).not.toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(result.current.pending).toBeNull()
      rerender(<WorkspaceShell {...props} tabUndo={null} />)
      expect(
        hasActiveTab
          ? screen.getByRole("tab", { name: "Market brief" })
          : document.getElementById("workspace-conversation-panel")
      ).toHaveFocus()
    }
  )

  it("focuses new Session when the final tab is removed", async () => {
    const user = userEvent.setup()
    const { props, rerender } = renderShell({
      openSessions: [{ ...openSessions[0], canClose: true }],
    })
    await user.click(
      screen.getByRole("button", { name: "Close session: Market brief" })
    )
    rerender(
      <WorkspaceShell {...props} openSessions={[]} activeThreadId={null} />
    )
    expect(
      within(
        document.querySelector("[data-session-actions]") as HTMLElement
      ).getByRole("button", { name: "New session" })
    ).toHaveFocus()
  })
  it("retains the neighbor focus handoff while provider selection is deferred", async () => {
    const user = userEvent.setup()
    let publishSelection!: () => void
    const switched = new Promise<void>((resolve) => {
      publishSelection = resolve
    })
    const { props, rerender } = renderShell({
      openSessions: openSessions.map((session) => ({
        ...session,
        canClose: true,
      })),
      onCloseSession: () => switched,
    })
    await user.click(
      screen.getByRole("button", { name: "Close session: Market brief" })
    )
    rerender(<WorkspaceShell {...props} openSessions={openSessions.slice(1)} />)
    expect(
      within(
        document.querySelector("[data-session-actions]") as HTMLElement
      ).getByRole("button", { name: "New session" })
    ).not.toHaveFocus()
    await act(async () => {
      publishSelection()
      await switched
    })
    rerender(
      <WorkspaceShell
        {...props}
        openSessions={openSessions.slice(1)}
        activeThreadId="thread-launch"
      />
    )
    expect(screen.getByRole("tab", { name: "Launch review" })).toHaveFocus()
  })

  it("shows provider unread state beside run status in Agent and Session navigation", () => {
    renderShell({
      agents: [{ ...agents[0]!, unread: true }, agents[1]!],
      openSessions: [
        { ...openSessions[0]!, unread: true },
        ...openSessions.slice(1),
      ],
    })

    const agentButton = screen.getByRole("button", {
      name: "Aster, Status: Running, Selected Agent, Unread",
    })
    expect(within(agentButton).getByTitle("Unread")).toBeVisible()
    expect(within(agentButton).queryByTitle("Running")).toBeNull()

    const tab = screen.getByRole("tab", { name: "Market brief, Unread" })
    expect(within(tab).getByTitle("Unread")).toBeVisible()
    expect(screen.getByRole("tab", { name: "Launch review" })).toBeVisible()
    // Navigation rows no longer carry Activity-derived counts.
    expect(screen.queryByText(/unread/i)).toBeNull()
  })

  it("lets a Session that needs the operator outrank its unread dot", () => {
    const scan: WorkspaceSession = { ...openSessions[2]!, unread: true }
    const sessions = [...openSessions.slice(0, 2), scan]
    renderShell({
      agents: [
        { ...agents[0]!, status: "attention", unread: true },
        agents[1]!,
      ],
      openSessions: sessions,
      navigationCatalog: new Map([
        [
          "agent-aster",
          {
            agentId: "agent-aster",
            openSessions: sessions,
            historySessions: olderSessions,
            lastSelectedThreadId: "thread-market",
          },
        ],
      ]),
    })

    const agentButton = screen.getByRole("button", {
      name: "Aster, Status: Needs attention, Selected Agent, Unread",
    })
    expect(within(agentButton).getByTitle("Needs attention")).toBeVisible()
    expect(within(agentButton).queryByTitle("Unread")).toBeNull()

    const inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })
    const sessionButton = within(inspector).getByRole("button", {
      name: "Open session: Competitive scan, Status: Waiting for input, Unread",
    })
    expect(within(sessionButton).getByTitle("Waiting for input")).toBeVisible()
    expect(within(sessionButton).queryByTitle("Unread")).toBeNull()

    const tab = screen.getByRole("tab", { name: "Competitive scan, Unread" })
    expect(within(tab).getByTitle("Waiting for input")).toBeVisible()
    expect(within(tab).queryByTitle("Unread")).toBeNull()
  })

  it("localizes the unread indicator in Hebrew", () => {
    renderShell({
      locale: "he",
      dictionary: he,
      agents: [{ ...agents[0]!, unread: true }, agents[1]!],
    })

    const agentButton = screen.getByRole("button", { name: /Aster.*לא נקרא/ })
    expect(within(agentButton).getByTitle("לא נקרא")).toBeVisible()
  })

  it("localizes the Activity drawer in Hebrew and inherits RTL", async () => {
    const user = userEvent.setup()
    renderShell({ locale: "he", dictionary: he })
    await user.click(
      screen.getAllByRole("button", { name: "פעילות, 0 לא נקראו" })[0]!
    )
    const drawer = screen.getByRole("dialog", { name: "פעילות" })
    expect(drawer.closest('[dir="rtl"]')).not.toBeNull()
    expect(
      within(drawer).getByRole("heading", { name: "קודם לכן" })
    ).toBeVisible()
  })

  it("opens Activity from either header and restores keyboard focus", async () => {
    const user = userEvent.setup()
    renderShell()
    const triggers = screen.getAllByRole("button", {
      name: "Activity, 0 unread",
    })
    expect(triggers).toHaveLength(2)
    await user.click(triggers[0]!)
    const drawer = screen.getByRole("dialog", { name: "Activity" })
    const close = within(drawer).getByRole("button", { name: "Close panel" })
    expect(close).toHaveFocus()
    expect(
      screen.getByText("Assistant UI conversation").closest("[inert]")
    ).not.toBeNull()
    expect(
      within(drawer).getByRole("heading", { name: "Needs attention" })
    ).toBeVisible()
    expect(
      within(drawer).getByRole("heading", { name: "Earlier" })
    ).toBeVisible()
    await user.tab({ shift: true })
    expect(within(drawer).getByText("Notification settings")).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(triggers[0]).toHaveFocus()
  })

  it("shows an optional environment label in both responsive headers", () => {
    renderShell({ environmentLabel: "Demo workspace" })

    expect(screen.getAllByText("Demo workspace")).toHaveLength(2)
  })

  it("renders tabs inside the Assistant UI thread item roots", () => {
    renderShell()

    const tablist = screen.getByRole("tablist", { name: "Sessions" })
    const activeTab = within(tablist).getByRole("tab", {
      name: "Market brief",
    })

    expect(activeTab).toHaveAttribute("aria-selected", "true")
    expect(activeTab).toHaveAttribute("tabindex", "0")
    expect(within(tablist).getAllByRole("tab")).toHaveLength(3)
    expect([...tablist.children]).toHaveLength(3)
  })

  it("places the new-session control beside the session tabs", () => {
    renderShell()

    const tablist = screen.getByRole("tablist", { name: "Sessions" })
    const sessionActions = document.querySelector("[data-session-actions]")
    expect(sessionActions).not.toBeNull()
    const newSession = within(sessionActions as HTMLElement).getByRole(
      "button",
      { name: "New session" }
    )
    const inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })

    expect(newSession.closest("[data-session-actions]")).not.toBeNull()
    expect(newSession.closest("[data-tab-viewport]")).toBeNull()
    expect(tablist.closest("[data-tab-viewport]")).not.toBeNull()
    expect(
      within(inspector).getByRole("button", { name: "New session" })
    ).toBeVisible()
  })

  it("keeps new-session actions available with no provider Sessions", () => {
    const onCreateSession = vi.fn()
    renderShell({
      openSessions: [],
      olderSessions: [],
      navigationCatalog: new Map([
        [
          "agent-aster",
          {
            agentId: "agent-aster",
            openSessions: [],
            historySessions: [],
            lastSelectedThreadId: null,
          },
        ],
      ]),
      activeThreadId: null,
      onCreateSession,
    })

    const sessionActions = document.querySelector("[data-session-actions]")
    expect(sessionActions).not.toBeNull()
    const tabBarAction = within(sessionActions as HTMLElement).getByRole(
      "button",
      { name: "New session" }
    )
    const inspectorAction = within(
      screen.getByRole("complementary", { name: "Agent details" })
    ).getByRole("button", { name: "New session" })

    fireEvent.click(tabBarAction)
    fireEvent.click(inspectorAction)
    expect(onCreateSession).toHaveBeenNthCalledWith(1, "agent-aster")
    expect(onCreateSession).toHaveBeenNthCalledWith(2, "agent-aster")
  })

  it.each(["en", "he"] as const)(
    "shows the selected Agent identity and status in the %s mobile header",
    async (locale) => {
      const dictionary = locale === "he" ? he : en
      renderShell({ locale, dictionary })
      const identity = screen.getByRole("group", {
        name: new RegExp(
          `Aster, Market brief, ${dictionary.status.label}: ${dictionary.status.running}`
        ),
      })
      expect(identity).toHaveTextContent("Aster")
      expect(identity).toHaveTextContent("Market brief")
      expect(
        identity.querySelector('[data-agent-symbol="spark"]')
      ).not.toBeNull()
    }
  )

  it("has no details action when no Agent is selected", () => {
    renderShell({
      agents: [],
      selectedAgentId: null,
      openSessions: [],
      activeThreadId: null,
    })
    expect(
      screen.queryByRole("button", { name: "Open Agent details" })
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "Open Agents" })
    ).toBeInTheDocument()
  })

  it("closes only the active tab from the pinned Session overflow", async () => {
    const user = userEvent.setup()
    const onCloseSession = vi.fn()
    renderShell({
      openSessions: openSessions.map((session) => ({
        ...session,
        canClose: true,
      })),
      onCloseSession,
    })
    await user.click(
      screen.getByRole("button", { name: "Session actions: Market brief" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Close tab" }))
    expect(onCloseSession).toHaveBeenCalledExactlyOnceWith(
      "thread-market",
      "agent-aster"
    )
  })

  it("only exposes close controls for manually closable sessions", () => {
    renderShell({
      openSessions: [
        openSessions[0],
        { ...openSessions[1], canClose: true },
        openSessions[2],
      ],
    })

    expect(
      screen.queryByRole("button", {
        name: "Close session: Market brief",
      })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "Close session: Launch review",
      })
    ).toBeInTheDocument()
  })

  it("reveals a session close control when its whole tab is hovered", async () => {
    const user = userEvent.setup()
    renderShell({
      openSessions: openSessions.map((session) => ({
        ...session,
        canClose: true,
      })),
    })

    const marketTab = screen.getByRole("tab", { name: "Market brief" })
    const marketClose = screen.getByRole("button", {
      name: "Close session: Market brief",
    })
    const launchClose = screen.getByRole("button", {
      name: "Close session: Launch review",
    })

    expect(marketClose).not.toHaveAttribute("data-visible")
    await user.hover(marketTab)
    expect(marketClose).toHaveAttribute("data-visible", "true")
    expect(launchClose).not.toHaveAttribute("data-visible")
  })

  it("moves and activates the roving tab with horizontal arrow keys", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    renderShell({ onOpenSession })

    const market = screen.getByRole("tab", { name: "Market brief" })
    const launch = screen.getByRole("tab", { name: "Launch review" })
    market.focus()
    await user.keyboard("{ArrowRight}")

    expect(launch).toHaveFocus()
    expect(onOpenSession).toHaveBeenCalledWith("thread-launch")
  })

  it("keeps the first session keyboard-reachable when no open tab is active", () => {
    renderShell({ activeThreadId: null })

    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "tabindex",
      "0"
    )
  })

  it("reverses horizontal tab movement for a Hebrew RTL workspace", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    renderShell({ locale: "he", dictionary: he, onOpenSession })

    const market = screen.getByRole("tab", { name: "Market brief" })
    const scan = screen.getByRole("tab", { name: "Competitive scan" })
    market.focus()
    await user.keyboard("{ArrowRight}")

    expect(scan).toHaveFocus()
    expect(onOpenSession).toHaveBeenCalledWith("thread-scan")
  })

  it("closes a tab without also opening it", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    const onCloseSession = vi.fn()
    renderShell({
      openSessions: openSessions.map((session) =>
        session.threadId === "thread-launch"
          ? { ...session, canClose: true }
          : session
      ),
      onOpenSession,
      onCloseSession,
    })

    await user.click(
      screen.getByRole("button", {
        name: "Close session: Launch review",
      })
    )

    expect(onCloseSession).toHaveBeenCalledWith("thread-launch", "agent-aster")
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it("contains only Agent identity, status, description, and sessions in the inspector", () => {
    renderShell()

    const inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })

    expect(within(inspector).getByText("Aster")).toBeInTheDocument()
    expect(within(inspector).getByText("Running")).toBeInTheDocument()
    expect(
      within(inspector).getByText("General analysis and synthesis")
    ).toBeInTheDocument()
    expect(within(inspector).getByText("Pricing analysis")).toBeInTheDocument()
    expect(within(inspector).queryByText(/skills/i)).not.toBeInTheDocument()
    expect(within(inspector).queryByText(/tools/i)).not.toBeInTheDocument()
  })

  it("collapses and restores the desktop Agent inspector with a persisted preference", async () => {
    const user = userEvent.setup()
    const firstRender = renderShell()
    const inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })
    const hideInspector = screen.getByRole("button", {
      name: "Hide Agent details",
    })

    expect(hideInspector).toHaveAttribute("aria-expanded", "true")
    expect(inspector).not.toHaveAttribute("hidden")

    await user.click(hideInspector)

    expect(inspector).toHaveAttribute("hidden")
    expect(window.localStorage.getItem("aos_ui:workspace:inspector-open")).toBe(
      "false"
    )
    expect(
      screen.getByRole("button", { name: "Show Agent details" })
    ).toHaveAttribute("aria-expanded", "false")

    firstRender.unmount()
    renderShell()

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show Agent details" })
      ).toHaveAttribute("aria-expanded", "false")
    )
    expect(
      document.getElementById("workspace-agent-inspector")
    ).toHaveAttribute("hidden")
  })

  it("does not overwrite a stored collapsed preference during hydration", async () => {
    window.localStorage.setItem("aos_ui:workspace:inspector-open", "false")

    renderShell()

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show Agent details" })
      ).toHaveAttribute("aria-expanded", "false")
    )
    expect(window.localStorage.getItem("aos_ui:workspace:inspector-open")).toBe(
      "false"
    )
  })

  it("defaults the desktop inspector open for a corrupt stored preference", () => {
    window.localStorage.setItem("aos_ui:inspector-open", "false")
    window.localStorage.setItem("aos_ui:workspace:inspector-open", " false ")

    renderShell()

    expect(
      screen.getByRole("button", { name: "Hide Agent details" })
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      document.getElementById("workspace-agent-inspector")
    ).not.toHaveAttribute("hidden")
  })

  it("defaults the desktop inspector open when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable")
    })

    renderShell()

    expect(
      screen.getByRole("button", { name: "Hide Agent details" })
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      document.getElementById("workspace-agent-inspector")
    ).not.toHaveAttribute("hidden")
  })

  it("keeps mobile Agent identity compact when the desktop inspector is collapsed", () => {
    window.localStorage.setItem("aos_ui:workspace:inspector-open", "false")
    renderShell()

    expect(
      screen.getByRole("group", {
        name: /Aster, Market brief, Status: Running/,
      })
    ).toBeVisible()
  })

  it("includes meaningful status in Agent and history button names", () => {
    const statusHistory: WorkspaceSession[] = [
      olderSessions[0],
      {
        threadId: "thread-running-history",
        title: "Running history",
        status: "running",
        updatedAt: "2026-08-31T11:00:00.000Z",
      },
      {
        threadId: "thread-waiting-history",
        title: "Waiting history",
        status: "waiting-for-input",
        updatedAt: "2026-08-30T11:00:00.000Z",
      },
      {
        threadId: "thread-failed-history",
        title: "Failed history",
        status: "failed",
        updatedAt: "2026-08-29T11:00:00.000Z",
      },
    ]
    renderShell({
      olderSessions: statusHistory,
      navigationCatalog: new Map([
        [
          "agent-aster",
          {
            agentId: "agent-aster",
            openSessions,
            historySessions: statusHistory,
            lastSelectedThreadId: "thread-market",
          },
        ],
      ]),
    })

    const agentsNavigation = screen.getByRole("navigation", { name: "Agents" })
    expect(
      within(agentsNavigation).getByRole("button", {
        name: "Aster, Status: Running, Selected Agent",
      })
    ).toBeInTheDocument()
    expect(
      within(agentsNavigation).getByRole("button", {
        name: "Mica",
      })
    ).toBeInTheDocument()
    expect(within(agentsNavigation).queryByRole("img")).not.toBeInTheDocument()

    const inspector = screen.getByRole("complementary", {
      name: "Agent details",
    })
    expect(
      within(inspector).getByRole("button", {
        name: "Open session: Pricing analysis",
      })
    ).toBeInTheDocument()
    expect(
      within(inspector).getByRole("button", {
        name: "Open session: Running history, Status: Running",
      })
    ).toBeInTheDocument()
    expect(
      within(inspector).getByRole("button", {
        name: "Open session: Waiting history, Status: Waiting for input",
      })
    ).toBeInTheDocument()
    expect(
      within(inspector).getByRole("button", {
        name: "Open session: Failed history, Status: Failed",
      })
    ).toBeInTheDocument()
    expect(within(inspector).queryByRole("img")).not.toBeInTheDocument()
  })

  it("uses deterministic icon fallbacks and refuses remote provider image URLs", () => {
    const { container } = renderShell({
      agents: [
        { id: "agent-alpha", name: "Alpha", status: "idle" },
        {
          id: "agent-beta",
          name: "Beta",
          status: "idle",
          icon: {
            kind: "image",
            src: "https://tracking.example/agent.png",
          },
        },
      ],
      selectedAgentId: "agent-alpha",
    })

    expect(
      container.querySelector('img[src^="https://tracking.example"]')
    ).toBeNull()
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Beta/ })).toBeInTheDocument()
  })

  it("traps focus in a narrow-screen drawer and restores it on Escape", async () => {
    const user = userEvent.setup()
    renderShell()

    const trigger = screen.getByRole("button", { name: "Open Agents" })
    await user.click(trigger)

    const drawer = screen.getByRole("dialog", { name: "Sessions" })
    expect(within(drawer).getByRole("heading", { name: "Aster" })).toHaveFocus()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("makes background workspace regions inert while a modal drawer is open", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole("button", { name: "Open Agents" }))

    const conversation = document.querySelector("main")
    const inertRegion = conversation?.closest("[inert]")
    expect(inertRegion).not.toBeNull()
    expect(inertRegion).toHaveAttribute("aria-hidden", "true")
  })

  it("browses an Agent without switching, then closes after choosing its Session", async () => {
    const user = userEvent.setup()
    const onSelectAgent = vi.fn()
    const onOpenSession = vi.fn()
    renderShell({ onSelectAgent, onOpenSession })

    const trigger = screen.getByRole("button", { name: "Open Agents" })
    await user.click(trigger)
    let drawer = screen.getByRole("dialog", { name: "Sessions" })
    await user.click(
      within(drawer).getByRole("button", { name: "Back to Agents" })
    )
    drawer = screen.getByRole("dialog", { name: "Agents" })
    await user.click(within(drawer).getByRole("button", { name: "Mica" }))

    expect(onSelectAgent).not.toHaveBeenCalled()
    drawer = screen.getByRole("dialog", { name: "Sessions" })
    expect(within(drawer).getByRole("heading", { name: "Mica" })).toBeVisible()
    await user.click(
      within(drawer).getByRole("button", {
        name: /Open Session: Mica draft/i,
      })
    )

    expect(onSelectAgent).not.toHaveBeenCalled()
    expect(onOpenSession).toHaveBeenCalledWith("thread-mica-draft")
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("exposes the inspector action in RTL", () => {
    renderShell({ locale: "he", dictionary: he })

    expect(
      screen.getByRole("button", { name: he.actions.hideAgentDetails })
    ).toBeVisible()
    expect(
      within(
        screen.getByRole("complementary", {
          name: he.workspace.agentDetails,
        })
      ).getByRole("button", { name: he.actions.newSession })
    ).toBeVisible()
  })

  it("routes rejected action promises to the optional error callback", async () => {
    const user = userEvent.setup()
    const error = new Error("provider unavailable")
    const onActionError = vi.fn()
    renderShell({
      onCreateSession: () => Promise.reject(error),
      onActionError,
    })

    await user.click(
      within(
        screen.getByRole("complementary", { name: "Agent details" })
      ).getByRole("button", { name: "New session" })
    )

    await waitFor(() => expect(onActionError).toHaveBeenCalledWith(error))
  })
})
