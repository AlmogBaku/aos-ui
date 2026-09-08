import {
  act,
  cleanup,
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

  it("focuses the conversation when the final tab is removed", async () => {
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
      document.getElementById("workspace-conversation-panel")
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
      screen.getByRole("button", { name: "New session" })
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

  it("distinguishes unread Activity from run status in Agent and Session navigation", () => {
    renderShell({
      activity: {
        items: [
          {
            id: "entry",
            type: "agent-ready",
            agentId: "agent-aster",
            threadId: "thread-launch",
            occurredAt: "2026-09-05T12:00:00Z",
            read: false,
            resolved: false,
            browserDeliveredAt: null,
            available: true,
          },
        ],
        notice: null,
        error: false,
        supported: true,
        openActivity: async () => true,
        markAllRead: () => {},
        dismissNotice: () => {},
      },
    })
    expect(
      screen.getByRole("button", { name: /Aster, Status: Running.*1 unread/ })
    ).toBeVisible()
    expect(
      screen.getByRole("tab", { name: /Launch review.*1 unread/ })
    ).toBeVisible()
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
    const newSession = screen.getByRole("button", { name: "New session" })

    expect(newSession.closest("[data-session-actions]")).not.toBeNull()
    expect(newSession.closest("[data-tab-viewport]")).toBeNull()
    expect(tablist.closest("[data-tab-viewport]")).not.toBeNull()
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
    renderShell({
      olderSessions: [
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
      ],
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
    const icons = [...container.querySelectorAll("[data-agent-symbol]")]
    expect(icons.length).toBeGreaterThanOrEqual(2)
    expect(
      icons.map(
        (icon) =>
          `${icon.getAttribute("data-agent-symbol")}:${icon.getAttribute("data-tone")}`
      )
    ).toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]))
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

  it("mirrors the direction-sensitive inspector icon in RTL", () => {
    renderShell({ locale: "he", dictionary: he })

    const icon = screen
      .getByRole("button", { name: he.actions.hideAgentDetails })
      .querySelector("svg")
    expect(icon).toHaveStyle({ transform: "scaleX(-1)" })
  })

  it("routes rejected action promises to the optional error callback", async () => {
    const user = userEvent.setup()
    const error = new Error("provider unavailable")
    const onActionError = vi.fn()
    renderShell({
      onCreateSession: () => Promise.reject(error),
      onActionError,
    })

    await user.click(screen.getByRole("button", { name: "New session" }))

    await waitFor(() => expect(onActionError).toHaveBeenCalledWith(error))
  })
})
