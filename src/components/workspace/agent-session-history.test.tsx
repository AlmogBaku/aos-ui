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
  unread: (count) => `${count} unread`,
  needsAttention: "Needs attention",
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
