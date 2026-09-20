import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
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
}

const navigation: AgentSessionNavigation = {
  agentId: "agent-a",
  openSessions: [
    {
      threadId: "open-match",
      title: "Shared research",
      status: "running",
      updatedAt: "2026-09-08T09:00:00.000Z",
      canClose: true,
    },
  ],
  historySessions: [
    {
      threadId: "history-match",
      title: "Shared findings",
      status: "idle",
      updatedAt: "2026-09-07T09:00:00.000Z",
    },
    {
      threadId: "open-match",
      title: "Duplicate research",
      status: "running",
      updatedAt: "2026-09-08T09:00:00.000Z",
    },
  ],
  lastSelectedThreadId: "history-match",
}

describe("AgentSessionHistory", () => {
  it("offers Session creation beside search, including empty results", () => {
    const onCreateSession = vi.fn()
    render(
      <AgentSessionHistory
        navigation={navigation}
        activeThreadId={null}
        locale="en"
        copy={copy}
        query="missing"
        onQueryChange={vi.fn()}
        onOpenSession={vi.fn()}
        onCreateSession={onCreateSession}
      />
    )

    const controls = screen.getByRole("group", { name: "Session actions" })
    expect(
      within(controls).getByRole("searchbox", { name: "Search Sessions" })
    ).toBeVisible()
    fireEvent.click(
      within(controls).getByRole("button", { name: "New session" })
    )
    expect(onCreateSession).toHaveBeenCalledWith("agent-a")
  })

  it("renders unique open and history rows and opens the chosen owner pair", () => {
    const onOpenSession = vi.fn()
    render(
      <AgentSessionHistory
        navigation={navigation}
        activeThreadId="open-match"
        locale="en"
        copy={copy}
        query=""
        onQueryChange={vi.fn()}
        onOpenSession={onOpenSession}
      />
    )

    const open = screen.getByRole("region", { name: "Open sessions" })
    const history = screen.getByRole("region", { name: "History" })
    expect(within(open).getByText("Shared research")).toBeVisible()
    expect(within(history).getByText("Shared findings")).toBeVisible()
    expect(screen.getAllByText(/research/i)).toHaveLength(1)

    fireEvent.click(
      within(history).getByRole("button", {
        name: /Open Session: Shared findings.*Last selected/i,
      })
    )
    expect(onOpenSession).toHaveBeenCalledWith("agent-a", "history-match")
  })

  it("names an unread Session last and shows both of its indicators", () => {
    render(
      <AgentSessionHistory
        navigation={{
          ...navigation,
          openSessions: [
            {
              ...navigation.openSessions[0]!,
              status: "waiting-for-input",
              unread: true,
            },
          ],
          historySessions: [],
        }}
        activeThreadId="open-match"
        locale="en"
        copy={copy}
        query=""
        onQueryChange={vi.fn()}
        onOpenSession={vi.fn()}
      />
    )

    const row = screen.getByRole("button", {
      name: "Open Session: Shared research, Status: Waiting for input, Selected, Unread",
    })
    expect(within(row).getByTitle("Waiting for input")).toBeVisible()
    expect(within(row).queryByTitle("Unread")).toBeNull()
  })

  it("searches both sections and offers a clear action for an empty result", () => {
    const onQueryChange = vi.fn()
    const view = render(
      <AgentSessionHistory
        navigation={navigation}
        activeThreadId={null}
        locale="en"
        copy={copy}
        query="research"
        onQueryChange={onQueryChange}
        onOpenSession={vi.fn()}
      />
    )

    expect(screen.getByRole("region", { name: "Open sessions" })).toBeVisible()
    expect(screen.queryByRole("region", { name: "History" })).toBeNull()

    view.rerender(
      <AgentSessionHistory
        navigation={navigation}
        activeThreadId={null}
        locale="en"
        copy={copy}
        query="missing"
        onQueryChange={onQueryChange}
        onOpenSession={vi.fn()}
      />
    )
    expect(screen.getByText("No matching Sessions")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(onQueryChange).toHaveBeenCalledWith("")
  })
})
