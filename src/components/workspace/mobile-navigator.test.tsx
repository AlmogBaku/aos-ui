import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MobileNavigator,
  mobileNavigatorReducer,
  type MobileNavigatorCopy,
  type MobileNavigatorProps,
  type MobileNavigatorState,
} from "./mobile-navigator"
import type { WorkspaceAgent, WorkspaceSession } from "./workspace-shell"

afterEach(cleanup)

const agents: WorkspaceAgent[] = [
  {
    id: "agent-a",
    name: "Researcher",
    description: "Finds primary sources",
    status: "running",
  },
  {
    id: "agent-b",
    name: "Writer",
    description: "Shapes the final answer",
    status: "attention",
  },
]

const session = (
  threadId: string,
  title: string,
  status: WorkspaceSession["status"] = "idle"
): WorkspaceSession => ({
  threadId,
  title,
  status,
  updatedAt: "2026-09-08T09:00:00.000Z",
  canClose: true,
})

const copy: MobileNavigatorCopy = {
  agents: "Agents",
  sessions: "Sessions",
  backToAgents: "Back to Agents",
  close: "Close navigation",
  searchAgents: "Search Agents",
  searchSessions: "Search Sessions",
  openSessions: "Open sessions",
  history: "History",
  newAgent: "New Agent",
  newSession: "New Session",
  manageAgents: "Manage Agents",
  preferences: "Preferences",
  agentDetails: "Agent details",
  clearSearch: "Clear search",
  noAgents: "No Agents found",
  noSessions: "No Sessions yet",
  noSearchResults: "No matching Sessions",
  openSession: "Open Session",
  sessionActions: "Session actions",
  removeOpenSession: "Remove from open sessions",
  selected: "Selected",
  lastSelected: "Last selected",
  statusLabel: "Status",
  status: {
    active: "Active",
    idle: "Idle",
    running: "Running",
    attention: "Needs attention",
    unknown: "Unknown",
    waitingForInput: "Waiting for input",
    failed: "Failed",
  },
  unread: (count) => `${count} unread`,
  needsAttention: "Needs attention",
}

const defaultProps = (): MobileNavigatorProps => ({
  state: { view: "agents" },
  agents,
  selectedAgentId: "agent-a",
  activeThreadId: "a-1",
  sessionsByAgentId: [
    {
      agentId: "agent-a",
      openSessions: [
        session("a-1", "Current investigation", "running"),
        session("a-2", "Secondary investigation"),
      ],
      historySessions: [session("a-old", "Earlier findings")],
      lastSelectedThreadId: "a-1",
    },
    {
      agentId: "agent-b",
      openSessions: [session("b-1", "Draft release", "waiting-for-input")],
      historySessions: [],
      lastSelectedThreadId: "b-1",
    },
  ],
  agentActivity: {
    "agent-b": { unreadCount: 3, needsAttention: true },
  },
  otherAgentsActivity: { unreadCount: 3, needsAttention: true },
  sessionActivity: {
    "b-1": { unreadCount: 2, needsAttention: true },
  },
  locale: "en",
  copy,
  onStateChange: vi.fn(),
  onOpenSession: vi.fn(),
  onCreateSession: vi.fn(),
  onRemoveOpenSession: vi.fn(),
  onNewAgent: vi.fn(),
  onManageAgents: vi.fn(),
  onPreferences: vi.fn(),
  onAgentDetails: vi.fn(),
  renderAgentIcon: (agent) => <span aria-hidden="true">{agent.name[0]}</span>,
})

describe("mobileNavigatorReducer", () => {
  it("opens at the selected Agent's Sessions and otherwise at Agents", () => {
    expect(
      mobileNavigatorReducer(
        { view: "closed" },
        { type: "OPEN", selectedAgentId: "agent-a" }
      )
    ).toEqual({ view: "sessions", agentId: "agent-a" })
    expect(
      mobileNavigatorReducer(
        { view: "closed" },
        { type: "OPEN", selectedAgentId: null }
      )
    ).toEqual({ view: "agents" })
  })

  it("browses Agents, goes back, dismisses, and recovers unavailable Agents", () => {
    const agentsState: MobileNavigatorState = { view: "agents" }
    expect(
      mobileNavigatorReducer(agentsState, {
        type: "BROWSE_AGENT",
        agentId: "agent-b",
      })
    ).toEqual({ view: "sessions", agentId: "agent-b" })
    expect(
      mobileNavigatorReducer(
        { view: "sessions", agentId: "agent-b" },
        { type: "BACK_TO_AGENTS" }
      )
    ).toEqual({ view: "agents" })
    expect(mobileNavigatorReducer(agentsState, { type: "DISMISS" })).toEqual({
      view: "closed",
    })
    expect(
      mobileNavigatorReducer(
        { view: "sessions", agentId: "missing" },
        { type: "BROWSED_AGENT_UNAVAILABLE" }
      )
    ).toEqual({ view: "agents" })
  })
})

describe("MobileNavigator", () => {
  it("drills into an Agent without selecting a conversation", () => {
    const props = defaultProps()
    render(<MobileNavigator {...props} />)

    fireEvent.click(screen.getByRole("button", { name: /Writer/ }))

    expect(props.onStateChange).toHaveBeenCalledWith({
      type: "BROWSE_AGENT",
      agentId: "agent-b",
    })
    expect(props.onOpenSession).not.toHaveBeenCalled()
  })

  it("shows aggregate activity and filters Agents by name or description", () => {
    const props = defaultProps()
    render(<MobileNavigator {...props} />)

    expect(
      screen.getByRole("button", { name: /Writer.*3 unread/i })
    ).toBeVisible()
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Agents" }), {
      target: { value: "primary sources" },
    })
    expect(screen.getByRole("button", { name: /Researcher/ })).toBeVisible()
    expect(
      screen.queryByRole("button", { name: /Writer/ })
    ).not.toBeInTheDocument()
  })

  it("renders a browsed Agent's open and historical Sessions and opens the chosen owner pair", () => {
    const props = defaultProps()
    props.state = { view: "sessions", agentId: "agent-b" }
    render(<MobileNavigator {...props} />)

    expect(screen.getByRole("heading", { name: "Writer" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Open sessions" })).toBeVisible()
    expect(
      screen.queryByRole("heading", { name: "History" })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: /Open Session: Draft release/i })
    )
    expect(props.onOpenSession).toHaveBeenCalledWith("agent-b", "b-1")
    expect(props.onStateChange).toHaveBeenCalledWith({ type: "DISMISS" })
  })

  it("dismisses when choosing the current Session without switching it again", () => {
    const props = defaultProps()
    props.state = { view: "sessions", agentId: "agent-a" }
    render(<MobileNavigator {...props} />)

    fireEvent.click(
      screen.getByRole("button", {
        name: /Open Session: Current investigation/i,
      })
    )

    expect(props.onStateChange).toHaveBeenCalledWith({ type: "DISMISS" })
    expect(props.onOpenSession).not.toHaveBeenCalled()
  })

  it("keeps the Session row and its overflow action as separate controls", () => {
    const props = defaultProps()
    props.state = { view: "sessions", agentId: "agent-a" }
    render(<MobileNavigator {...props} />)

    const row = document.querySelector<HTMLElement>('[data-session-id="a-2"]')
    expect(row).not.toBeNull()
    const openButton = within(row!).getByRole("button", {
      name: /Open Session: Secondary investigation/i,
    })
    const actionsButton = within(row!).getByRole("button", {
      name: /Session actions: Secondary investigation/i,
    })
    expect(openButton.contains(actionsButton)).toBe(false)

    fireEvent.click(actionsButton)
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from open sessions" })
    )
    expect(props.onRemoveOpenSession).toHaveBeenCalledWith("agent-a", "a-2")
    expect(props.onStateChange).toHaveBeenCalledWith({ type: "DISMISS" })
  })

  it("preserves visible Session ordering while open, removes missing rows, and appends discoveries", () => {
    const props = defaultProps()
    props.state = { view: "sessions", agentId: "agent-a" }
    const view = render(<MobileNavigator {...props} />)

    const updated = defaultProps()
    updated.state = props.state
    updated.sessionsByAgentId = [
      {
        agentId: "agent-a",
        openSessions: [
          session("a-3", "New discovery"),
          session("a-2", "Secondary investigation updated"),
        ],
        historySessions: [session("a-old", "Earlier findings")],
        lastSelectedThreadId: "a-2",
      },
    ]
    view.rerender(<MobileNavigator {...updated} />)

    const names = within(screen.getByLabelText("Open sessions"))
      .getAllByRole("button", { name: /^Open Session:/i })
      .map((button) => button.getAttribute("aria-label"))
    expect(names).toEqual([
      expect.stringContaining("Secondary investigation updated"),
      expect.stringContaining("New discovery"),
    ])
  })

  it("filters Sessions, clears an empty search, and creates for the browsed Agent", () => {
    const props = defaultProps()
    props.state = { view: "sessions", agentId: "agent-a" }
    render(<MobileNavigator {...props} />)

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search Sessions" }),
      {
        target: { value: "missing" },
      }
    )
    expect(screen.getByText("No matching Sessions")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getByText("Current investigation")).toBeVisible()

    expect(screen.getAllByRole("button", { name: "New Session" })).toHaveLength(
      1
    )
    fireEvent.click(screen.getByRole("button", { name: "New Session" }))
    expect(props.onCreateSession).toHaveBeenCalledWith("agent-a")
    expect(props.onStateChange).toHaveBeenCalledWith({ type: "DISMISS" })
  })

  it("uses RTL direction and exposes the navigation actions", () => {
    const props = defaultProps()
    props.locale = "he"
    props.state = { view: "sessions", agentId: "agent-a" }
    const { container } = render(<MobileNavigator {...props} />)

    expect(container.firstElementChild).toHaveAttribute("dir", "rtl")
    fireEvent.click(
      screen.getByRole("button", {
        name: "Back to Agents, 3 unread, Needs attention",
      })
    )
    expect(props.onStateChange).toHaveBeenCalledWith({ type: "BACK_TO_AGENTS" })
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }))
    expect(props.onStateChange).toHaveBeenCalledWith({ type: "DISMISS" })
  })
})
