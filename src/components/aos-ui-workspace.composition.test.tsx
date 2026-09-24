import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useEffect, useState } from "react"

import { en } from "@/lib/i18n/dictionaries/en"
import type { WorkspaceAdapter } from "@/runtime-adapters/contracts"

import { ControlledWorkspaceFixture } from "./test-utils/controlled-workspace-fixture"
import { AosUiWorkspace } from "./aos-ui-workspace"
import {
  asHarnessRuntime,
  deferred,
  EmptyAgentFixture,
  StaleTodoFixture,
  SessionMetadataSignalFixture,
  ClockBoundaryFixture,
  FIXTURE_NOW,
  fixtureSessions,
  useFixtureRuntimeBundle,
  FixtureAosUiApp,
  type FixtureWorkspace,
} from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: window.location.pathname }),
  useNavigate: () => (href: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](
      null,
      "",
      href
    )
  },
}))

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
})
afterEach(cleanup)

describe("AosUiApp fixture composition", () => {
  it("routes Activity to its owning Agent and Session while suppressing exact focused selection", async () => {
    const user = userEvent.setup()
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    let provider: FixtureWorkspace | undefined
    function ActivityFixture() {
      const [threadId, setThreadId] = useState<string | undefined>(
        "thread-aster-market"
      )
      const bundle = useFixtureRuntimeBundle({
        threadId,
        onThreadIdChange: setThreadId,
      })
      useEffect(() => {
        provider = bundle.workspace
      }, [bundle.workspace])
      return (
        <AosUiWorkspace
          runtime={asHarnessRuntime(bundle)}
          locale="en"
          dictionary={en}
          now={FIXTURE_NOW}
          readNow={() => FIXTURE_NOW}
        />
      )
    }
    try {
      render(<ActivityFixture />)
      await screen.findByRole("tab", { name: "Market brief" })
      act(() => provider!.publishActivityScenario("turn-completed"))
      // The bell counts the two unread fixture Sessions, not arrivals.
      const bell = (
        await screen.findAllByRole("button", { name: "Activity, 2 unread" })
      )[0]!
      await user.click(bell)
      expect(await screen.findByText("A turn finished")).toBeVisible()
      await user.keyboard("{Escape}")
      act(() => provider!.publishActivityScenario("delayed-non-selected"))
      expect(
        await screen.findAllByRole("button", { name: "Activity, 2 unread" })
      ).toHaveLength(2)
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
      await user.click(bell)
      await user.click(screen.getByRole("button", { name: /Open: Mica,/ }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expect(
        screen.getByRole("button", { name: /Mica.*Selected Agent/ })
      ).toBeVisible()
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")

      // Opening an unread Session's Activity acknowledges it with the provider.
      act(() => provider!.publishActivityScenario("turn-failed"))
      await user.click(
        screen.getAllByRole("button", { name: "Activity, 2 unread" })[0]!
      )
      await user.click(screen.getByRole("button", { name: /Open: Nori,/ }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expect(
        await screen.findAllByRole("button", { name: "Activity, 1 unread" })
      ).toHaveLength(2)
    } finally {
      focus.mockRestore()
    }
  })

  it("removes an idle Session tab when it reaches the exact 12-hour boundary", async () => {
    vi.useFakeTimers()
    let clock = new Date("2026-09-03T18:59:59.000Z")

    try {
      render(<ClockBoundaryFixture readNow={() => clock} />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(
        screen.getByRole("tab", { name: "Launch review" })
      ).toBeInTheDocument()

      clock = new Date("2026-09-03T19:00:00.000Z")
      await act(() => vi.advanceTimersByTimeAsync(1_000))

      expect(
        screen.queryByRole("tab", { name: "Launch review" })
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole("tab", { name: "Market brief" })
      ).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("joins provider Agents, Session tabs, the thread, and explicit todos", async () => {
    render(
      <ControlledWorkspaceFixture
        initialThreadId="session-primary"
        workspace={{
          agents: [
            {
              kind: "ready",
              id: "agent-primary",
              name: "Primary",
              status: "idle",
              icon: { kind: "symbol", symbol: "spark", tone: "indigo" },
            },
            {
              kind: "ready",
              id: "agent-secondary",
              name: "Secondary",
              status: "idle",
              icon: { kind: "symbol", symbol: "layers", tone: "purple" },
            },
          ],
          sessions: [
            {
              threadId: "session-primary",
              agentId: "agent-primary",
              updatedAt: FIXTURE_NOW.toISOString(),
              status: "running",
            },
            {
              threadId: "session-secondary",
              agentId: "agent-secondary",
              updatedAt: FIXTURE_NOW.toISOString(),
              status: "idle",
            },
          ],
          sessionTitles: {
            "session-primary": "Selected session",
            "session-secondary": "Other session",
          },
          todos: {
            "session-primary": [
              { id: "todo-finished", label: "Finished", status: "completed" },
              { id: "todo-active", label: "Active", status: "active" },
            ],
          },
        }}
        messagesByThread={{
          "session-primary": [
            {
              id: "controlled-user",
              role: "user",
              content: "Prepare a summary",
            },
            {
              id: "controlled-assistant",
              role: "assistant",
              content: [
                { type: "text", text: "The requested summary is ready." },
              ],
            },
          ],
        }}
      >
        {(bundle) => (
          <AosUiWorkspace
            runtime={asHarnessRuntime(bundle)}
            locale="en"
            dictionary={en}
            now={FIXTURE_NOW}
          />
        )}
      </ControlledWorkspaceFixture>
    )

    const tablist = await screen.findByRole("tablist", { name: "Sessions" })
    expect(
      await within(tablist).findByRole("tab", { name: "Selected session" })
    ).toHaveAttribute("aria-selected", "true")
    const conversation = screen.getByRole("main", { name: "Conversation" })
    expect(
      within(conversation).queryByRole("button", { name: /tool call/i })
    ).toBeNull()
    expect(
      await within(conversation).findByText("The requested summary is ready.")
    ).toBeVisible()
    const todos = screen.getByRole("region", { name: "Session todos" })
    expect(within(todos).getAllByRole("listitem")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: /^Secondary,/ })).toBeNull()
  })

  it("restores the last valid Session when switching Agents", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("tab", { name: "Market brief" })
    await user.click(screen.getByRole("button", { name: "Mica" }))
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")
    )

    await user.click(
      screen.getByRole("button", { name: "Aster, Status: Running" })
    )
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
  })

  it("opens an older Session from Agent history as a closable tab, and reopens a closed recent tab from its row", async () => {
    const user = userEvent.setup()
    const pushState = vi.spyOn(window.history, "pushState")
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    const historySession = await screen.findByRole("button", {
      name: "Open session: Pricing analysis",
    })
    await user.click(historySession)

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Pricing analysis" })
      ).toHaveAttribute("aria-selected", "true")
    )
    expect(pushState).toHaveBeenCalledWith(
      null,
      "",
      "/agent-aster/thread-aster-pricing"
    )
    expect(
      screen.getByRole("button", { name: "Close session: Market brief" })
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Close session: Pricing analysis" })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Pricing analysis" })
      ).not.toBeInTheDocument()
    )

    await user.click(
      screen.getByRole("button", { name: "Close session: Market brief" })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Market brief" })
      ).not.toBeInTheDocument()
    )
    await user.click(
      screen.getByRole("button", {
        name: "Open session: Market brief, Status: Running",
      })
    )
    expect(
      await screen.findByRole("tab", { name: "Market brief" })
    ).toHaveAttribute("aria-selected", "true")
  })

  // Nori owns one stale Session that is neither live nor pinned, so only the
  // history fallback can put it in the tab strip.

  it("shows the fallback history Session as a tab for an Agent with only old history, and lets that sole tab close", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "Nori" }))

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Launch copy, Unread" })
      ).toHaveAttribute("aria-selected", "true")
    )

    await user.click(
      screen.getByRole("button", {
        name: "Close session: Launch copy",
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Launch copy, Unread" })
      ).not.toBeInTheDocument()
    )
  })

  it("never exposes another Agent's conversation when the selected Agent has no Session, names that Agent in its details, and hides the Todo dock for a Session without Todos", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    await screen.findByText(/Applied AI is accelerating fastest/)
    await user.click(screen.getByRole("button", { name: "Empty" }))

    await waitFor(() =>
      expect(
        screen.queryByText(/Applied AI is accelerating fastest/)
      ).not.toBeInTheDocument()
    )
    expect(
      await screen.findByRole("heading", {
        name: "What would you like to work on?",
      })
    ).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Message input" })).toBeVisible()
    expect(screen.queryByText("Start your first session")).toBeNull()
    expect(screen.queryByRole("region", { name: "Session todos" })).toBeNull()
    expect(
      within(
        screen.getByRole("complementary", {
          name: en.workspace.agentDetails,
        })
      ).getByText("Empty")
    ).toBeVisible()

    await user.click(
      screen.getByRole("button", { name: "Aster, Status: Running" })
    )
    await user.click(
      await screen.findByRole("button", {
        name: "Open session: Pricing analysis",
      })
    )
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Pricing analysis" })
      ).toHaveAttribute("aria-selected", "true")
    )
    expect(screen.queryByRole("region", { name: "Session todos" })).toBeNull()
  })

  it("offers /new only once the Session has a conversation", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    const input = await screen.findByRole("textbox", { name: "Message input" })
    await user.type(input, "/ne")
    expect(await screen.findByText(en.actions.newSessionCommand)).toBeVisible()
    await user.keyboard("{Escape}")
    await user.clear(input)

    await user.click(screen.getByRole("button", { name: "Empty" }))
    const emptyInput = await screen.findByRole("textbox", {
      name: "Message input",
    })
    await user.type(emptyInput, "/ne")
    expect(screen.queryByText(en.actions.newSessionCommand)).toBeNull()
  })

  it("surfaces new-Session failures from the empty state", async () => {
    const user = userEvent.setup()
    render(
      <EmptyAgentFixture
        createSession={async () => {
          throw new Error("Provider rejected the Session")
        }}
      />
    )

    await screen.findByText(/Applied AI is accelerating fastest/)
    await user.click(screen.getByRole("button", { name: "Empty" }))
    await user.click(
      within(
        screen.getByRole("complementary", {
          name: en.workspace.agentDetails,
        })
      ).getByRole("button", { name: en.actions.newSession })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider rejected the Session"
    )
  })

  it("ignores delayed todo events from the previously visible Session", async () => {
    const user = userEvent.setup()
    let emitStale: () => void = () => undefined
    const captureStaleEmission = (emit: () => void) => {
      emitStale = emit
    }
    render(<StaleTodoFixture captureStaleEmission={captureStaleEmission} />)

    await user.click(await screen.findByText("Session todos"))
    expect(await screen.findByText("Old Agent task")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Mica" }))
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")
    )
    emitStale()

    expect(screen.queryByText("Old Agent task")).not.toBeInTheDocument()
    expect(screen.queryByText("Leaked delayed task")).not.toBeInTheDocument()
  })

  it("updates old Session tab eligibility from authoritative metadata signals", async () => {
    let publishMetadata: (
      metadata: Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
    ) => void = () => undefined
    const captureSignal = (signal: {
      publish: typeof publishMetadata
      fail: (error: Error) => void
    }) => {
      publishMetadata = signal.publish
    }
    render(<SessionMetadataSignalFixture captureSignal={captureSignal} />)

    await screen.findByRole("tab", { name: "Market brief" })
    expect(
      screen.queryByRole("tab", { name: "Pricing analysis" })
    ).not.toBeInTheDocument()

    const waiting = fixtureSessions.map((session) =>
      session.threadId === "thread-aster-pricing"
        ? { ...session, status: "waiting-for-input" as const }
        : session
    )
    act(() => publishMetadata(waiting))
    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toBeInTheDocument()

    act(() => publishMetadata(fixtureSessions))
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Pricing analysis" })
      ).not.toBeInTheDocument()
    )
  })

  it("does not let an initial metadata fetch overwrite a newer signal", async () => {
    const initial =
      deferred<Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>>()
    let subscribed = false
    let publishMetadata: (
      metadata: Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
    ) => void = () => undefined
    render(
      <SessionMetadataSignalFixture
        initialMetadata={initial.promise}
        captureSignal={(signal) => {
          subscribed = true
          publishMetadata = signal.publish
        }}
      />
    )
    await waitFor(() => expect(subscribed).toBe(true))

    const waiting = fixtureSessions.map((session) =>
      session.threadId === "thread-aster-pricing"
        ? { ...session, status: "waiting-for-input" as const }
        : session
    )
    act(() => publishMetadata(waiting))
    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toBeInTheDocument()

    await act(async () => initial.resolve(fixtureSessions))
    expect(
      screen.getByRole("tab", { name: "Pricing analysis" })
    ).toBeInTheDocument()
  })
})
