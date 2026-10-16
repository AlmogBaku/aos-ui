import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useMemo } from "react"
import { describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { AcpConnectionClosedError } from "@/runtime-adapters/contracts"
import type {
  HarnessRuntime,
  SessionMetadata,
  WorkspaceAdapter,
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
  type TestRuntime,
} from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => import("./test-utils/window-router"))

resetWorkspaceBetweenTests()

/** Collapses the desktop inspector so the Session tab strip becomes reachable. */
async function collapseInspector(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: en.actions.hideAgentDetails })
  )
}

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
      await collapseInspector(user)
      await screen.findByRole("tab", { name: "Market brief" })
      // The focused Session's turn is seen, so the bell still counts only the
      // fixture's two unread Sessions.
      act(() => provider().publishActivityScenario("turn-completed"))
      const everyUnread = "Activity, 2 unread, 1 waiting for you, 1 failed"
      const bell = (
        await screen.findAllByRole("button", { name: everyUnread })
      )[0]!
      await user.click(bell)
      let dialog = screen.getByRole("dialog", { name: "Activity" })
      expect(
        within(dialog).getByRole("button", { name: /^Lumen, Roadmap review,/ })
      ).toBeVisible()
      expect(
        within(dialog).queryByRole("button", { name: /^Aster, Market brief,/ })
      ).toBeNull()
      await user.keyboard("{Escape}")

      // Another Agent's finished turn joins the bell and the inbox.
      act(() => provider().publishActivityScenario("delayed-non-selected"))
      expect(
        await screen.findAllByRole("button", {
          name: "Activity, 3 unread, 1 waiting for you, 1 failed",
        })
      ).toHaveLength(2)
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
      await user.click(bell)
      dialog = screen.getByRole("dialog", { name: "Activity" })
      // Its row opens its own Agent's Session, which acknowledges it.
      await user.click(
        within(dialog).getByRole("button", {
          name: /^Mica, Quarterly synthesis,/,
        })
      )
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expect(
        screen.getByRole("button", { name: /Mica.*Selected Agent/ })
      ).toBeVisible()
      expect(
        screen.getByRole("tab", { name: "Quarterly synthesis" })
      ).toHaveAttribute("aria-selected", "true")
      expect(
        await screen.findAllByRole("button", { name: everyUnread })
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
    const user = userEvent.setup()
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

    await collapseInspector(user)
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
    await user.click(screen.getByRole("button", { name: /^Empty,/ }))

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

    await user.click(screen.getByRole("button", { name: /^Aster,/ }))
    await user.click(
      await screen.findByRole("button", {
        name: "Open session: Pricing analysis",
      })
    )
    await collapseInspector(user)
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

    await user.click(screen.getByRole("button", { name: /^Empty,/ }))
    const emptyInput = await screen.findByRole("textbox", {
      name: "Message input",
    })
    await user.type(emptyInput, "/ne")
    expect(screen.queryByText(en.actions.newSessionCommand)).toBeNull()
  })

  describe("forking a Session", () => {
    const FORKED_TITLE = "Market brief, forked"

    /**
     * The public fixture with a runtime that forks: the fork is a new Session
     * of the source's Agent, which the catalog then lists.
     */
    function forkingRuntime(forked: (sessionId: string) => void) {
      return function useForkingRuntime(): ReturnType<typeof usePublicFixture> &
        Pick<TestRuntime, "forkSession"> {
        const fixture = usePublicFixture()
        return useMemo(
          () => ({
            ...fixture,
            forkSession: async (sessionId: string) => {
              forked(sessionId)
              const [source] = await fixture.workspace.getSessionMetadata([
                sessionId,
              ])
              return fixture.workspace.createSession(source!.agentId, {
                title: FORKED_TITLE,
              })
            },
          }),
          [fixture]
        )
      }
    }

    type User = ReturnType<typeof userEvent.setup>
    /** The fork, typed: Enter takes the command from the menu, then sends it. */
    const typed = (command: string) => async (user: User) => {
      await user.click(screen.getByRole("textbox", { name: "Message input" }))
      await user.paste(command)
      await user.keyboard("{Enter}{Enter}")
    }

    // Full mount: the row menu, `/branch` and `/fork` are the workspace's to
    // define over one fork, and no lower seam joins them.
    it.each<readonly [string, (user: User) => Promise<void>]>([
      [
        "the Session's row menu",
        async (user) => {
          await user.click(
            screen.getByRole("button", {
              name: `${en.actions.sessionActions}: Market brief`,
            })
          )
          await user.click(
            await screen.findByRole("menuitem", {
              name: en.actions.branchSession,
            })
          )
        },
      ],
      ["a typed /branch", typed("/branch")],
    ])(
      "forks the Session from %s and opens the fork, sending nothing",
      async (_, fork) => {
        const user = userEvent.setup()
        const forked = vi.fn()
        renderWorkspace(forkingRuntime(forked), fixtureClock)
        await collapseInspector(user)
        await screen.findByRole("tab", { name: "Market brief" })

        await fork(user)

        await waitFor(() =>
          expect(
            screen.getByRole("tab", { name: FORKED_TITLE })
          ).toHaveAttribute("aria-selected", "true")
        )
        expect(forked).toHaveBeenCalledExactlyOnceWith("thread-aster-market")
        expect(
          screen.getByRole("textbox", { name: "Message input" })
        ).toHaveValue("")
        expect(screen.queryByText(/^\/(fork|branch)$/u)).toBeNull()
      }
    )

    it("forks the Session from a typed /fork and stays on it", async () => {
      const user = userEvent.setup()
      const forked = vi.fn()
      renderWorkspace(forkingRuntime(forked), fixtureClock)
      await collapseInspector(user)
      await screen.findByRole("tab", { name: "Market brief" })

      await typed("/fork")(user)

      expect(await screen.findByText(en.commands.notices.forked)).toBeVisible()
      expect(forked).toHaveBeenCalledExactlyOnceWith("thread-aster-market")
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
      expect(
        screen.getByRole("textbox", { name: "Message input" })
      ).toHaveValue("")
    })

    it("offers no fork where the runtime cannot fork", async () => {
      const user = userEvent.setup()
      renderWorkspace(usePublicFixture, fixtureClock)
      await collapseInspector(user)
      await screen.findByRole("tab", { name: "Market brief" })

      await user.click(
        screen.getByRole("button", {
          name: `${en.actions.sessionActions}: Market brief`,
        })
      )
      expect(
        await screen.findByRole("menuitem", { name: en.actions.closeTab })
      ).toBeVisible()
      expect(
        screen.queryByRole("menuitem", { name: en.actions.branchSession })
      ).toBeNull()
      await user.keyboard("{Escape}")

      await user.click(screen.getByRole("textbox", { name: "Message input" }))
      await user.paste("/")
      const commands = await screen.findByRole("listbox", {
        name: "Slash commands",
      })
      expect(commands).toHaveTextContent(en.actions.newSessionCommand)
      expect(commands).not.toHaveTextContent(en.commands.branch.description)
      expect(commands).not.toHaveTextContent(en.commands.fork.description)
    })
  })

  // Full mount: the details panel's New Session failure reaches the
  // workspace's error surface as that action's own failure.
  it("surfaces new-Session failures from the empty state, even past a dismissed workspace error", async () => {
    const user = userEvent.setup()
    let failCatalog: (error: Error) => void = () => {}
    const overrides: Partial<WorkspaceAdapter> = {
      createSession: async () => {
        throw new Error("Provider rejected the Session")
      },
      subscribeAgentCatalog: (_listener, onError) => {
        failCatalog = (error) => onError?.(error)
        return () => {}
      },
    }
    renderWorkspace(() => useEmptyAgentRuntime(overrides))
    const createSession = () =>
      user.click(
        within(
          screen.getByRole("complementary", {
            name: en.workspace.agentDetails,
          })
        ).getByRole("button", { name: en.actions.newSession })
      )

    await screen.findByText(/Applied AI is accelerating fastest/)
    await user.click(screen.getByRole("button", { name: /^Empty,/ }))
    await createSession()

    let alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Provider rejected the Session")
    // The action failed, not the workspace, so there is nothing to reload.
    expect(alert).not.toHaveTextContent("The workspace could not be loaded.")
    expect(
      within(alert).queryByRole("button", { name: "Try again" })
    ).toBeNull()

    await user.click(
      within(alert).getByRole("button", { name: "Dismiss notification" })
    )
    expect(screen.queryByRole("alert")).toBeNull()

    // A workspace error the operator dismissed no longer hides the next one.
    act(() => failCatalog(new Error("Agent catalog signal failed")))
    alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("The workspace could not be loaded.")
    await user.click(
      within(alert).getByRole("button", { name: "Dismiss notification" })
    )
    await createSession()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider rejected the Session"
    )
    // A different workspace error is a new one, so it shows again.
    act(() => failCatalog(new Error("Agent catalog stream failed")))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The workspace could not be loaded."
      )
    )
  })

  // Full mount: a request the gone connection could not carry fails with the
  // client's one class, whose own reason is a socket's DOM Event, not words.
  it("words a lost connection in the workspace and action toasts, never as its own message", async () => {
    const user = userEvent.setup()
    const lost = () =>
      new AcpConnectionClosedError(undefined, { cause: new Event("error") })
    let failCatalog: (error: Error) => void = () => {}
    renderWorkspace(() =>
      useEmptyAgentRuntime({
        createSession: async () => {
          throw lost()
        },
        subscribeAgentCatalog: (_listener, onError) => {
          failCatalog = (error) => onError?.(error)
          return () => {}
        },
      })
    )
    const wording =
      "The connection was interrupted. Check your connection, then try again."
    await screen.findByText(/Applied AI is accelerating fastest/)

    act(() => failCatalog(lost()))
    let alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("The workspace could not be loaded.")
    expect(alert).toHaveTextContent(wording)
    expect(alert).not.toHaveTextContent(lost().message)
    await user.click(
      within(alert).getByRole("button", { name: "Dismiss notification" })
    )

    await user.click(screen.getByRole("button", { name: /^Empty,/ }))
    await user.click(
      within(
        screen.getByRole("complementary", { name: en.workspace.agentDetails })
      ).getByRole("button", { name: en.actions.newSession })
    )
    alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("That action could not be completed.")
    expect(alert).toHaveTextContent(wording)
    expect(alert).not.toHaveTextContent(lost().message)
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
