import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import type {
  HarnessRuntime,
  SessionMetadata,
} from "@/runtime-adapters/contracts"

import { ControlledWorkspaceFixture } from "./test-utils/controlled-workspace-fixture"
import { AosUiWorkspace } from "./aos-ui-workspace"
import {
  asHarnessRuntime,
  deferred,
  FIXTURE_NOW,
  fixtureSessions,
  openTabIds,
  renderNavigation,
  renderWorkspace,
  resetWorkspaceBetweenTests,
  useEmptyAgentRuntime,
  useFixtureBundle,
  useSessionMetadataSignalRuntime,
  useStaleTodoRuntime,
} from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => import("./test-utils/window-router"))

resetWorkspaceBetweenTests()

/** The public fixture demo's runtime, which lists no creator. */
const usePublicFixture = () => useFixtureBundle({ enableAgentCreator: false })
const fixtureClock = { readNow: () => FIXTURE_NOW }

/** Fixture metadata with Pricing analysis waiting on the operator. */
const pricingWaiting = fixtureSessions.map((session) =>
  session.sessionId === "thread-aster-pricing"
    ? { ...session, status: "waiting-for-input" as const }
    : session
)

describe("AosUiApp fixture composition", () => {
  // Full mount: Activity reaches selection through the coordinator, the shell's
  // bell, and navigation together.
  it("routes Activity to its owning Agent and Session while suppressing exact focused selection", async () => {
    const user = userEvent.setup()
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    try {
      const view = renderWorkspace(useFixtureBundle, fixtureClock)
      const provider = () => view.runtime.workspace
      await screen.findByRole("tab", { name: "Market brief" })
      act(() => provider().publishActivityScenario("turn-completed"))
      // The bell counts the two unread fixture Sessions, not arrivals.
      const bell = (
        await screen.findAllByRole("button", { name: "Activity, 2 unread" })
      )[0]!
      await user.click(bell)
      expect(await screen.findByText("A turn finished")).toBeVisible()
      await user.keyboard("{Escape}")
      act(() => provider().publishActivityScenario("delayed-non-selected"))
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
      act(() => provider().publishActivityScenario("turn-failed"))
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

  // Full mount: the harness's connection and Session status reach the notice
  // through the workspace; the notice's copy is its own component's test.
  it("passes the runtime's connection and Session status to the notice", async () => {
    function StatusFixture(
      props: Pick<HarnessRuntime, "connectionStatus" | "sessionStatus">
    ) {
      const bundle = useFixtureBundle()
      return (
        <AosUiWorkspace
          runtime={{ ...asHarnessRuntime(bundle), ...props }}
          locale="en"
          dictionary={en}
          now={FIXTURE_NOW}
        />
      )
    }
    const statusTexts = () =>
      screen.getAllByRole("status").map(({ textContent }) => textContent)
    const { rerender } = render(
      <StatusFixture connectionStatus="reconnecting" />
    )
    await waitFor(() => expect(statusTexts()).toContain("Reconnecting to AOS…"))
    rerender(<StatusFixture sessionStatus="unavailable" />)
    expect(statusTexts()).toContain("This Session is no longer available.")
    rerender(<StatusFixture />)
    expect(
      screen.queryByText("This Session is no longer available.")
    ).toBeNull()
  })

  it("removes an idle Session tab when it reaches the exact 12-hour boundary", async () => {
    vi.useFakeTimers()
    const start = new Date("2026-09-03T18:59:59.000Z")
    let clock = start
    try {
      const view = renderNavigation(useFixtureBundle, {
        now: start,
        readNow: () => clock,
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(openTabIds(view.nav)).toContain("thread-aster-launch")

      clock = new Date("2026-09-03T19:00:00.000Z")
      await act(() => vi.advanceTimersByTimeAsync(1_000))

      expect(openTabIds(view.nav)).not.toContain("thread-aster-launch")
      expect(openTabIds(view.nav)).toContain("thread-aster-market")
    } finally {
      vi.useRealTimers()
    }
  })

  // Full mount: Agents, tabs, the thread's messages, and the Todo dock are
  // separate parts that only the workspace joins.
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
            },
            {
              kind: "ready",
              id: "agent-secondary",
              name: "Secondary",
              status: "idle",
            },
          ],
          sessions: [
            {
              sessionId: "session-primary",
              agentId: "agent-primary",
              updatedAt: FIXTURE_NOW.toISOString(),
              status: "running",
            },
            {
              sessionId: "session-secondary",
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
    const view = renderNavigation(usePublicFixture, fixtureClock)
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )

    await act(() => view.nav.selectAgent("agent-mica"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-mica-quarterly")
    )

    await act(() => view.nav.selectAgent("agent-aster"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
  })

  it("opens an older Session from Agent history as a closable tab, and reopens a closed recent tab from its row", async () => {
    const pushState = vi.spyOn(window.history, "pushState")
    const view = renderNavigation(usePublicFixture, fixtureClock)
    await waitFor(() =>
      expect(openTabIds(view.nav)).toContain("thread-aster-market")
    )
    expect(openTabIds(view.nav)).not.toContain("thread-aster-pricing")

    await act(() => view.nav.openSession("thread-aster-pricing"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-pricing")
    )
    expect(pushState).toHaveBeenCalledWith(
      null,
      "",
      "/agent-aster/thread-aster-pricing"
    )
    expect(openTabIds(view.nav)).toEqual(
      expect.arrayContaining(["thread-aster-market", "thread-aster-pricing"])
    )

    await act(() => view.nav.closeSession("thread-aster-pricing"))
    await waitFor(() =>
      expect(openTabIds(view.nav)).not.toContain("thread-aster-pricing")
    )
    await act(() => view.nav.closeSession("thread-aster-market"))
    await waitFor(() =>
      expect(openTabIds(view.nav)).not.toContain("thread-aster-market")
    )

    await act(() => view.nav.openSession("thread-aster-market"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    expect(openTabIds(view.nav)).toContain("thread-aster-market")
  })

  // Nori owns one stale Session that is neither live nor pinned, so only the
  // history fallback can put it in the tab strip.
  it("shows the fallback history Session as a tab for an Agent with only old history, and lets that sole tab close", async () => {
    const view = renderNavigation(usePublicFixture, fixtureClock)
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )

    await act(() => view.nav.selectAgent("agent-nori"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-nori-copy")
    )
    expect(view.nav.shellOpenSessions).toEqual([
      expect.objectContaining({
        sessionId: "thread-nori-copy",
        title: "Launch copy",
        unread: true,
      }),
    ])

    await act(() => view.nav.closeSession("thread-nori-copy"))
    await waitFor(() => expect(openTabIds(view.nav)).toEqual([]))
  })

  // Full mount: which of the conversation, the empty-Session welcome, and the
  // Todo dock shows is the workspace's render branch, not navigation's.
  it("never exposes another Agent's conversation when the selected Agent has no Session, names that Agent in its details, and hides the Todo dock for a Session without Todos", async () => {
    const user = userEvent.setup()
    renderWorkspace(() => useEmptyAgentRuntime())

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

  // Full mount: `/new` is a composer command the workspace defines from the
  // thread's own emptiness; no lower seam exposes it.
  it("offers /new only once the Session has a conversation", async () => {
    const user = userEvent.setup()
    renderWorkspace(() => useEmptyAgentRuntime())

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

  // Full mount: the details panel's New Session failure reaches the
  // workspace's error surface.
  it("surfaces new-Session failures from the empty state", async () => {
    const user = userEvent.setup()
    const rejectSession = async (): Promise<never> => {
      throw new Error("Provider rejected the Session")
    }
    renderWorkspace(() => useEmptyAgentRuntime(rejectSession))

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
    const view = renderNavigation(useStaleTodoRuntime)
    await waitFor(() =>
      expect(view.nav.todos.map(({ label }) => label)).toEqual([
        "Old Agent task",
      ])
    )

    await act(() => view.nav.selectAgent("agent-mica"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-mica-quarterly")
    )
    act(() => view.runtime.stale.emit())

    expect(view.nav.todos.map(({ label }) => label)).not.toContain(
      "Old Agent task"
    )
    expect(view.nav.todos.map(({ label }) => label)).not.toContain(
      "Leaked delayed task"
    )
  })

  it("updates old Session tab eligibility from authoritative metadata signals", async () => {
    const view = renderNavigation(() => useSessionMetadataSignalRuntime())
    await waitFor(() =>
      expect(openTabIds(view.nav)).toContain("thread-aster-market")
    )
    expect(openTabIds(view.nav)).not.toContain("thread-aster-pricing")

    act(() => view.runtime.feed.signal!.publish(pricingWaiting))
    await waitFor(() =>
      expect(openTabIds(view.nav)).toContain("thread-aster-pricing")
    )

    act(() => view.runtime.feed.signal!.publish(fixtureSessions))
    await waitFor(() =>
      expect(openTabIds(view.nav)).not.toContain("thread-aster-pricing")
    )
  })

  it("does not let an initial metadata fetch overwrite a newer signal", async () => {
    const initial = deferred<SessionMetadata[]>()
    const view = renderNavigation(() =>
      useSessionMetadataSignalRuntime(initial.promise)
    )
    await waitFor(() => expect(view.runtime.feed.signal).toBeDefined())

    act(() => view.runtime.feed.signal!.publish(pricingWaiting))
    await waitFor(() =>
      expect(openTabIds(view.nav)).toContain("thread-aster-pricing")
    )

    await act(async () => initial.resolve(fixtureSessions))
    expect(openTabIds(view.nav)).toContain("thread-aster-pricing")
  })
})
