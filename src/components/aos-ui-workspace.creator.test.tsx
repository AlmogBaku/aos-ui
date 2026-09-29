import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import {
  draftAgentId,
  PENDING_DRAFT_AGENT_ID,
} from "@/runtime-adapters/draft-agents"

import {
  deferred,
  draftAgents,
  FIXTURE_NOW,
  FixtureAosUiApp,
  type FixtureWorkspace,
  interviewSession,
  interviewWorkspace,
  renderNavigation,
  renderWorkspace,
  resetWorkspaceBetweenTests,
  type TestRuntime,
  useBuilderSignalRuntime,
  useCreatedAgentRuntime,
  useFixtureBundle,
  useGatedMetadataRuntime,
  usePendingInterviewRuntime,
  type WorkspaceNavigation,
} from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => import("./test-utils/window-router"))

resetWorkspaceBetweenTests()

const fixtureClock = { readNow: () => FIXTURE_NOW }

/** The fixture with its creator, over `workspace` when one is given. */
const creatorFixture =
  (workspace?: FixtureWorkspace, initialThreadId?: string) => () =>
    useFixtureBundle({
      enableAgentCreator: true,
      initialThreadId,
      ...(workspace ? { testOnly: { workspace } } : {}),
    })

const sora = { kind: "ready", id: "agent-sora", name: "Sora" } as const

const agentIds = (nav: WorkspaceNavigation) =>
  nav.displayAgents.map(({ id }) => id)

/** The texts of the messages on the runtime's main thread. */
const threadTexts = (runtime: TestRuntime) =>
  runtime.assistantRuntime.thread
    .getState()
    .messages.flatMap(({ content }) =>
      content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    )

const workspaceError = (nav: WorkspaceNavigation) =>
  (nav.agentError ?? nav.sessionError ?? nav.actionError)?.message

/** Opens the builder and waits until its interview Session exists. */
async function openInterview(
  view: { nav: WorkspaceNavigation },
  provider: () => FixtureWorkspace
) {
  await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
  await act(() => view.nav.openAgentBuilder())
  const interview = interviewSession(provider())!
  await waitFor(() =>
    expect(view.nav.selectedAgentId).toBe(draftAgentId(interview.sessionId))
  )
  return interview
}

describe("AosUiApp fixture composition", () => {
  // Full mount: the Commands palette builds its Agent list inside the
  // workspace, from the same roster the rail shows.
  it("does not expose Agent creation in the public fixture demo, nor the creator in Agent navigation or Commands", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("button", { name: /^Aster,/ })
    expect(screen.getByRole("button", { name: "Manage Agents" })).toBeVisible()
    expect(screen.queryByText("Agent Creator")).toBeNull()
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Agent Creator,/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.queryByRole("button", { name: "Select Agent: Agent Creator" })
    ).toBeNull()
  })

  // Full mount: the rail's New Agent button, the thread, the draft row, and
  // the Commands palette only meet in the workspace.
  it("opens the interview as its own New Agent draft", async () => {
    const user = userEvent.setup()
    const view = renderWorkspace(creatorFixture(), fixtureClock)

    await user.click(await screen.findByRole("button", { name: "New Agent" }))

    expect(await screen.findByText(en.creator.kickoff)).toBeVisible()
    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(draftRow).toHaveAttribute("aria-current", "true")
    const interview = interviewSession(
      view.runtime.workspace as FixtureWorkspace
    )!
    expect(window.location.pathname).toBe(
      `/draft%3A${interview.sessionId}/${interview.sessionId}`
    )
    expect(screen.queryByRole("button", { name: /^Agent Creator/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.getByRole("button", { name: "Select Agent: New Agent" })
    ).toBeVisible()
  })

  it("opens New Agent as a pending draft before its Session exists", async () => {
    const firstTurn = deferred<void>()
    const view = renderNavigation(
      () => usePendingInterviewRuntime(firstTurn.promise),
      fixtureClock
    )
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))

    await act(() => view.nav.openAgentBuilder())

    expect(view.nav.selectedAgentId).toBe(PENDING_DRAFT_AGENT_ID)
    expect(view.nav.selectedAgentIsDraft).toBe(true)
    expect(window.location.pathname).toBe("/draft-pending")
    expect(threadTexts(view.runtime)).toContain(en.creator.kickoff)
    expect(
      view.runtime.workspace
        .listAllSessionMetadata()
        .map(({ agentId }) => agentId)
    ).toEqual(["agent-aster"])

    // Reselecting the pending draft keeps its interview.
    await act(() => view.nav.selectAgent(PENDING_DRAFT_AGENT_ID))
    expect(threadTexts(view.runtime)).toContain(en.creator.kickoff)
    expect(window.location.pathname).toBe("/draft-pending")

    await act(async () => firstTurn.resolve())

    const interview = await waitFor(() =>
      interviewSession(view.runtime.workspace)!
    )
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/draft%3A${interview.sessionId}/${interview.sessionId}`
      )
    )
    expect(view.nav.selectedAgentId).toBe(draftAgentId(interview.sessionId))
  })

  it("the pending interview's Session is renamed New Agent once", async () => {
    const firstTurn = deferred<void>()
    const view = renderNavigation(
      () => usePendingInterviewRuntime(firstTurn.promise),
      fixtureClock
    )
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
    const rename = vi.spyOn(view.runtime.workspace, "setSessionTitle")

    await act(() => view.nav.openAgentBuilder())
    expect(rename).not.toHaveBeenCalled()

    await act(async () => firstTurn.resolve())
    const interview = await waitFor(() =>
      interviewSession(view.runtime.workspace)!
    )
    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith(interview.sessionId, "New Agent")
    )
    await act(() => view.nav.selectAgent(draftAgentId(interview.sessionId)))
    expect(rename).toHaveBeenCalledOnce()
  })

  it("discards a pending draft deleting no Session, and a started draft by deleting its interview Session", async () => {
    const expectDraftRetired = async (nav: () => WorkspaceNavigation) => {
      await waitFor(() => expect(draftAgents(nav())).toEqual([]))
      await waitFor(() => expect(nav().selectedAgentId).toBe("agent-aster"))
    }
    const firstTurn = deferred<void>()
    const pending = renderNavigation(
      () => usePendingInterviewRuntime(firstTurn.promise),
      fixtureClock
    )
    await waitFor(() => expect(pending.nav.selectedAgentId).toBe("agent-aster"))
    await act(() => pending.nav.openAgentBuilder())
    const before = pending.runtime.workspace.listAllSessionMetadata()

    await act(() => pending.nav.discardDraft(PENDING_DRAFT_AGENT_ID))

    await expectDraftRetired(() => pending.nav)
    expect(pending.runtime.workspace.listAllSessionMetadata()).toEqual(before)
    expect(workspaceError(pending.nav)).toBeUndefined()

    cleanup()
    const started = renderNavigation(creatorFixture(), fixtureClock)
    const provider = () => started.runtime.workspace as FixtureWorkspace
    const interview = await openInterview(started, provider)

    await act(() => started.nav.discardDraft(draftAgentId(interview.sessionId)))

    await expectDraftRetired(() => started.nav)
    const threads = started.runtime.assistantRuntime.threads.getState()
    expect(
      threads.threadIds.map((id) => threads.threadItems[id]?.remoteId)
    ).not.toContain(interview.sessionId)
  })

  // Full mount: the Todo dock's and the draft row's Hebrew copy render from
  // separate parts of the workspace.
  it("localizes Session-scoped Todo copy, the interview draft, and its prompt in Hebrew", async () => {
    const user = userEvent.setup()
    renderWorkspace(creatorFixture(), { locale: "he", ...fixtureClock })

    const dock = await screen.findByRole("region", {
      name: "משימות השיחה",
    })
    expect(within(dock).getByText("משימות השיחה")).toBeInTheDocument()
    expect(
      within(dock).getByText("3 מתוך 5 משימות בשיחה הושלמו")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "סוכן חדש" }))

    expect(await screen.findByText("בוא ניצור סוכן חדש.")).toBeVisible()
    expect(
      await screen.findByRole("button", { name: /^סוכן חדש, טיוטה/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("rebuilds an unresolved draft from provider Sessions after a reload", async () => {
    const workspace = interviewWorkspace(0)
    const first = renderNavigation(creatorFixture(workspace), fixtureClock)
    await waitFor(() => expect(draftAgents(first.nav)).toHaveLength(1))

    cleanup()
    const reloaded = renderNavigation(creatorFixture(workspace), fixtureClock)

    await waitFor(() =>
      expect(draftAgents(reloaded.nav)).toEqual([
        expect.objectContaining({ id: draftAgentId("interview-thread") }),
      ])
    )
  })

  it("hides an interview older than the draft window", async () => {
    const view = renderNavigation(
      creatorFixture(interviewWorkspace(48 * 60 * 60 * 1000)),
      fixtureClock
    )

    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
    expect(draftAgents(view.nav)).toEqual([])
  })

  it("never treats a draft as the default Agent", async () => {
    const view = renderNavigation(
      creatorFixture(interviewWorkspace(0)),
      fixtureClock
    )

    await waitFor(() => expect(draftAgents(view.nav)).toHaveLength(1))
    expect(view.nav.selectedAgentId).toBe("agent-aster")
  })

  it("keeps a selected draft selected while Session metadata refreshes", async () => {
    const workspace = interviewWorkspace(0)
    const draftId = draftAgentId("interview-thread")
    const refresh = deferred<void>()
    let holding = false
    const hold = async () => {
      if (holding) await refresh.promise
    }
    const view = renderNavigation(
      () => useGatedMetadataRuntime(workspace, hold),
      fixtureClock
    )
    await waitFor(() => expect(draftAgents(view.nav)).toHaveLength(1))
    await act(() => view.nav.selectAgent(draftId))
    await waitFor(() => expect(view.nav.selectedAgentId).toBe(draftId))

    holding = true
    await act(async () => {
      await workspace.createSession("agent-mica", { title: "Later" })
      await view.runtime.assistantRuntime.threads.reload()
    })

    expect(view.nav.selectedAgentId).toBe(draftId)

    holding = false
    await act(async () => refresh.resolve())
    await waitFor(() => expect(view.nav.selectedAgentId).toBe(draftId))
  })

  it("replaces a resolved draft with the created Agent and creates it no Session", async () => {
    const view = renderNavigation(creatorFixture(), fixtureClock)
    const provider = () => view.runtime.workspace as FixtureWorkspace
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
    const createSession = vi.spyOn(provider(), "createSession")
    const interview = await openInterview(view, provider)

    await act(async () =>
      provider().completeAgentCreation(interview.sessionId, sora)
    )

    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-sora"))
    expect(view.nav.selectedAgentIsDraft).toBe(false)
    expect(draftAgents(view.nav)).toEqual([])
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(
      provider()
        .listAllSessionMetadata()
        .filter(({ agentId }) => agentId === "agent-sora")
    ).toHaveLength(0)
  })

  it("never steals selection from the Agent in the foreground", async () => {
    const view = renderNavigation(creatorFixture(), fixtureClock)
    const provider = () => view.runtime.workspace as FixtureWorkspace
    const interview = await openInterview(view, provider)
    await act(() => view.nav.selectAgent("agent-aster"))
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))

    await act(async () =>
      provider().completeAgentCreation(interview.sessionId, sora)
    )

    await waitFor(() => expect(agentIds(view.nav)).toContain("agent-sora"))
    expect(view.nav.selectedAgentId).toBe("agent-aster")
    expect(draftAgents(view.nav)).toEqual([])
  })

  it("waits for the catalog to list the created Agent before resolving the draft", async () => {
    const view = renderNavigation(
      () => useCreatedAgentRuntime({ hideFor: 1 }),
      fixtureClock
    )
    const interview = await openInterview(view, () => view.runtime.provider)

    await act(async () =>
      view.runtime.provider.completeAgentCreation(interview.sessionId, sora)
    )

    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-sora"))
    expect(draftAgents(view.nav)).toEqual([])
    expect(view.nav.creatorNotice).not.toBe(en.creator.createdPending)
  })

  it("keeps the draft and reports the created Agent as pending when the catalog never lists it", async () => {
    const view = renderNavigation(
      () => useCreatedAgentRuntime({ hideFor: Number.MAX_SAFE_INTEGER }),
      fixtureClock
    )
    const interview = await openInterview(view, () => view.runtime.provider)

    await act(async () =>
      view.runtime.provider.completeAgentCreation(interview.sessionId, sora)
    )

    await waitFor(() =>
      expect(view.nav.creatorNotice).toBe(en.creator.createdPending)
    )
    expect(view.nav.selectedAgentId).toBe(draftAgentId(interview.sessionId))
    expect(agentIds(view.nav)).not.toContain("agent-sora")
  })

  it("reports a failed catalog refresh and keeps the draft it cannot resolve", async () => {
    const view = renderNavigation(() => useCreatedAgentRuntime(), fixtureClock)
    const interview = await openInterview(view, () => view.runtime.provider)
    view.runtime.handle.failNextRefresh()

    await act(async () =>
      view.runtime.handle.emitActivity({
        id: "created-2",
        type: "agent-ready",
        agentId: "agent-sora",
        sessionId: interview.sessionId,
        occurredAt: FIXTURE_NOW.toISOString(),
      })
    )

    await waitFor(() =>
      expect(workspaceError(view.nav)).toBe("Agent catalog refresh failed")
    )
    expect(view.nav.selectedAgentId).toBe(draftAgentId(interview.sessionId))
  })

  it("retires the draft and explains an Agent that still needs operator setup", async () => {
    const view = renderNavigation(creatorFixture(), fixtureClock)
    const provider = () => view.runtime.workspace as FixtureWorkspace
    const interview = await openInterview(view, provider)

    await act(async () =>
      provider().failAgentSetup(interview.sessionId, "agent-sora", "Sora")
    )

    await waitFor(() =>
      expect(view.nav.creatorNotice).toBe(en.creator.createdHidden)
    )
    await waitFor(() => expect(draftAgents(view.nav)).toEqual([]))
    // The rail leaves hidden Agents out.
    expect(
      view.nav.displayAgents.find(({ id }) => id === "agent-sora")
    ).toMatchObject({ visibility: "hidden" })
    expect(view.nav.selectedAgentId).not.toBe("agent-sora")
    await waitFor(() =>
      expect(window.location.pathname).not.toContain("draft%3A")
    )
  })

  it("ignores a created Agent reported from a Session the creator does not own", async () => {
    const view = renderNavigation(() => useCreatedAgentRuntime(), fixtureClock)
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
    const before = view.runtime.handle.refreshCalls()

    await act(async () =>
      view.runtime.handle.emitActivity({
        id: "created-1",
        type: "agent-ready",
        agentId: "agent-sora",
        sessionId: "thread-aster-market",
        occurredAt: FIXTURE_NOW.toISOString(),
      })
    )

    expect(view.runtime.handle.refreshCalls()).toBe(before)
    expect(view.nav.creatorNotice).toBeUndefined()
    expect(view.nav.selectedAgentId).toBe("agent-aster")
  })

  it("shows no draft after a reload of an interview that already created its Agent", async () => {
    const view = renderNavigation(creatorFixture(), fixtureClock)
    const workspace = view.runtime.workspace as FixtureWorkspace
    const interview = await openInterview(view, () => workspace)
    await act(async () =>
      workspace.completeAgentCreation(interview.sessionId, sora)
    )
    await waitFor(() => expect(draftAgents(view.nav)).toEqual([]))

    cleanup()
    window.history.replaceState({}, "", "/")
    const reloaded = renderNavigation(
      creatorFixture(workspace, interview.sessionId),
      fixtureClock
    )

    await waitFor(() => expect(agentIds(reloaded.nav)).toContain("agent-sora"))
    expect(draftAgents(reloaded.nav)).toEqual([])
  })

  it("refreshes the Agent catalog only after provider-signaled Builder completion", async () => {
    const view = renderNavigation(useBuilderSignalRuntime, fixtureClock)
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
    await act(() => view.nav.openAgentBuilder())
    await waitFor(() => expect(draftAgents(view.nav)).toHaveLength(1))
    expect(agentIds(view.nav)).not.toContain("agent-sora")

    await act(async () => view.runtime.provider.signal!.complete())

    await waitFor(() => expect(agentIds(view.nav)).toContain("agent-sora"))
  })

  it("surfaces provider errors from Agent catalog completion signals", async () => {
    const view = renderNavigation(useBuilderSignalRuntime, fixtureClock)
    await waitFor(() => expect(view.runtime.provider.signal).toBeDefined())

    act(() =>
      view.runtime.provider.signal!.fail(
        new Error("Agent catalog signal failed")
      )
    )

    await waitFor(() =>
      expect(workspaceError(view.nav)).toBe("Agent catalog signal failed")
    )
  })
})
