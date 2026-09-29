import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AgentSessionHistory,
  type AgentSessionHistoryCopy,
} from "./agent-session-history"
import type { AgentSessionNavigation } from "./workspace-navigation-catalog"

afterEach(cleanup)

const copy: AgentSessionHistoryCopy = {
  searchSessions: "Search Sessions",
  newSession: "New session",
  openSessions: "Open sessions",
  history: "History",
  clearSearch: "Clear search",
  loadMoreSessions: "Load more sessions",
  loadingMoreSessions: "Loading more Sessions…",
  noSessions: "No Sessions yet",
  noSearchResults: "No matching Sessions",
  openSession: "Open Session",
  sessionActions: "Session actions",
  removeOpenSession: "Remove from open sessions",
  selected: "Selected",
  lastSelected: "Last selected",
  statusLabel: "Status",
  status: {
    idle: "Idle",
    running: "Running",
    unknown: "Unknown",
    waitingForInput: "Waiting for input",
    failed: "Failed",
  },
  unread: "Unread",
  archivedSessions: "Archived",
  noArchivedSessions: "No archived Sessions",
  pinned: "Pinned",
  archived: "In archive",
  platform: {
    buzz: "From Buzz",
    whatsapp: "From WhatsApp",
    slack: "From Slack",
    telegram: "From Telegram",
    discord: "From Discord",
    email: "From email",
  },
  sessionMenu: {
    sessionActions: "Session actions",
    rename: "Rename",
    pin: "Pin",
    unpin: "Unpin",
    archive: "Archive",
    unarchive: "Unarchive",
    delete: "Delete",
    closeTab: "Close tab",
    removeOpenSession: "Remove from open sessions",
    unavailable: "Unavailable for this runtime",
  },
}

const allActions = {
  rename: true,
  archive: true,
  delete: true,
  pin: true,
}

const navigation: AgentSessionNavigation = {
  agentId: "agent-a",
  openSessions: [
    {
      sessionId: "open-match",
      title: "Shared research",
      status: "running",
      updatedAt: "2026-09-08T09:00:00.000Z",
      canClose: true,
    },
  ],
  historySessions: [
    {
      sessionId: "history-match",
      title: "Shared findings",
      status: "idle",
      updatedAt: "2026-09-07T09:00:00.000Z",
    },
    {
      sessionId: "open-match",
      title: "Duplicate research",
      status: "running",
      updatedAt: "2026-09-08T09:00:00.000Z",
    },
  ],
  archivedSessions: [],
  lastSelectedThreadId: "history-match",
}

type HistoryProps = ComponentProps<typeof AgentSessionHistory>

/** Renders the history over `navigation` with no query and inert callbacks. */
function renderHistory(props: Partial<HistoryProps> = {}) {
  const element = (next: Partial<HistoryProps>) => (
    <AgentSessionHistory
      navigation={navigation}
      activeThreadId={null}
      locale="en"
      copy={copy}
      query=""
      onQueryChange={vi.fn()}
      onOpenSession={vi.fn()}
      {...props}
      {...next}
    />
  )
  const view = render(element({}))
  return {
    rerender: (next: Partial<HistoryProps>) => view.rerender(element(next)),
  }
}

describe("AgentSessionHistory", () => {
  it("offers Session creation beside search, including empty results", async () => {
    const user = userEvent.setup()
    const onCreateSession = vi.fn()
    renderHistory({
      query: "missing",
      onCreateSession,
    })

    const controls = screen.getByRole("group", { name: "Session actions" })
    expect(
      within(controls).getByRole("searchbox", { name: "Search Sessions" })
    ).toBeVisible()
    await user.click(
      within(controls).getByRole("button", { name: "New session" })
    )
    expect(onCreateSession).toHaveBeenCalledWith("agent-a")
  })

  it("renders unique open and history rows and opens the chosen owner pair", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    renderHistory({
      activeThreadId: "open-match",
      onOpenSession,
    })

    const open = screen.getByRole("region", { name: "Open sessions" })
    const history = screen.getByRole("region", { name: "History" })
    expect(within(open).getByText("Shared research")).toBeVisible()
    expect(within(history).getByText("Shared findings")).toBeVisible()
    expect(screen.getAllByText(/research/i)).toHaveLength(1)

    await user.click(
      within(history).getByRole("button", {
        name: /Open Session: Shared findings.*Last selected/i,
      })
    )
    expect(onOpenSession).toHaveBeenCalledWith("agent-a", "history-match")
  })

  it("names an unread Session last and shows its row indicator", () => {
    renderHistory({
      navigation: {
        ...navigation,
        openSessions: [
          {
            ...navigation.openSessions[0]!,
            status: "waiting-for-input",
            unread: true,
          },
        ],
        historySessions: [],
      },
      activeThreadId: "open-match",
    })

    const row = screen.getByRole("button", {
      name: "Open Session: Shared research, Status: Waiting for input, Selected, Unread",
    })
    expect(within(row).getByTitle("Waiting for input")).toBeVisible()
  })

  it("searches both sections and offers a clear action for an empty result", async () => {
    const user = userEvent.setup()
    const onQueryChange = vi.fn()
    const view = renderHistory({
      query: "research",
      onQueryChange,
    })

    expect(screen.getByRole("region", { name: "Open sessions" })).toBeVisible()
    expect(screen.queryByRole("region", { name: "History" })).toBeNull()

    view.rerender({ query: "missing" })
    expect(screen.getByText("No matching Sessions")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Clear search" }))
    expect(onQueryChange).toHaveBeenCalledWith("")
  })

  it("offers the same row menu on every listed Session", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    renderHistory({
      activeThreadId: "open-match",
      availability: allActions,
      sessionMenu: { onRename },
    })

    expect(
      screen.getByRole("button", { name: "Session actions: Shared research" })
    ).toBeVisible()
    await user.click(
      screen.getByRole("button", { name: "Session actions: Shared findings" })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }))
    expect(onRename).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "history-match" })
    )
  })

  it("names a pinned Session and keeps it at the head of its list", () => {
    renderHistory({
      navigation: {
        ...navigation,
        openSessions: [
          { ...navigation.openSessions[0]!, pinned: true },
          {
            sessionId: "open-other",
            title: "Quarterly plan",
            status: "idle",
            updatedAt: "2026-09-09T09:00:00.000Z",
          },
        ],
        historySessions: [],
      },
    })

    const names = within(screen.getByRole("region", { name: "Open sessions" }))
      .getAllByRole("button", { name: /^Open Session:/ })
      .map((row) => row.getAttribute("aria-label"))
    expect(names).toEqual([
      "Open Session: Shared research, Status: Running, Pinned",
      "Open Session: Quarterly plan",
    ])
  })

  it("keeps archived Sessions behind a collapsed disclosure that can restore them", async () => {
    const user = userEvent.setup()
    const onToggleArchive = vi.fn()
    renderHistory({
      navigation: {
        ...navigation,
        archivedSessions: [
          {
            sessionId: "archived-one",
            title: "Campaign retrospective",
            status: "idle",
            updatedAt: "2026-09-01T09:00:00.000Z",
            archived: true,
          },
        ],
      },
      availability: allActions,
      sessionMenu: { onToggleArchive },
    })

    const archived = screen.getByRole("region", { name: "Archived" })
    expect(
      within(archived).getByText("Campaign retrospective")
    ).not.toBeVisible()

    await user.click(
      within(archived).getByRole("heading", { name: "Archived" })
    )
    expect(within(archived).getByText("Campaign retrospective")).toBeVisible()

    await user.click(
      within(archived).getByRole("button", {
        name: "Session actions: Campaign retrospective",
      })
    )
    await user.click(await screen.findByRole("menuitem", { name: "Unarchive" }))
    expect(onToggleArchive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "archived-one" })
    )
  })

  it("hides the archived disclosure for an Agent without archived Sessions", () => {
    renderHistory({
      availability: allActions,
      sessionMenu: { onToggleArchive: vi.fn() },
    })

    expect(screen.queryByRole("region", { name: "Archived" })).toBeNull()
  })

  it("opens the row menu from a right click on the row", async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    renderHistory({
      navigation: { ...navigation, historySessions: [] },
      activeThreadId: "open-match",
      availability: allActions,
      sessionMenu: { onDelete },
    })

    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Open Session: Shared research/ }),
      { clientX: 20, clientY: 30 }
    )
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "open-match" })
    )
  })

  it("disables an action the runtime does not declare and says so", async () => {
    const user = userEvent.setup()
    renderHistory({
      navigation: { ...navigation, historySessions: [] },
      activeThreadId: "open-match",
      availability: { ...allActions, pin: false },
      sessionMenu: { onRename: vi.fn(), onTogglePin: vi.fn() },
    })

    await user.click(
      screen.getByRole("button", { name: "Session actions: Shared research" })
    )
    expect(
      await screen.findByRole("menuitem", { name: "Rename" })
    ).not.toHaveAttribute("aria-disabled")
    expect(
      screen.getByRole("menuitem", {
        name: "Pin, Unavailable for this runtime",
      })
    ).toHaveAttribute("aria-disabled", "true")
  })

  it("hides runtime-owned actions until the runtime answers", async () => {
    const user = userEvent.setup()
    renderHistory({
      navigation: { ...navigation, historySessions: [] },
      activeThreadId: "open-match",
      onRemoveOpenSession: vi.fn(),
      availability: null,
      sessionMenu: { onRename: vi.fn(), onDelete: vi.fn() },
    })

    await user.click(
      screen.getByRole("button", { name: "Session actions: Shared research" })
    )
    expect(
      await screen.findByRole("menuitem", {
        name: "Remove from open sessions",
      })
    ).toBeVisible()
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull()
  })
})
