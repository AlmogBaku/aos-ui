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
import type {
  RemoteThreadListAdapter,
  ThreadMessageLike,
} from "@assistant-ui/react"

import { en } from "@/lib/i18n/dictionaries/en"
import type {
  ArtifactAdapter,
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"

import {
  ControlledWorkspaceFixture,
  useControlledWorkspace,
} from "./test-utils/controlled-workspace-fixture"
import { AosUiWorkspace } from "./aos-ui-workspace"
import {
  asHarnessRuntime,
  registeredDraftRuntime,
  deferred,
  FIXTURE_NOW,
  FixtureThreadListAdapter,
  openTabIds,
  renderedConversation,
  renderNavigation,
  renderWorkspace,
  resetWorkspaceBetweenTests,
  useDraftPromotionRaceRuntime,
  useFixtureBundle,
} from "./aos-ui-workspace.test-helpers"

vi.mock("react-router", () => import("./test-utils/window-router"))

resetWorkspaceBetweenTests()

const useMarketWorkspace = () =>
  useControlledWorkspace({ initialThreadId: "thread-aster-market" })
/** The public fixture demo's runtime, which lists no creator. */
const usePublicFixture = () => useFixtureBundle({ enableAgentCreator: false })
const fixtureClock = { readNow: () => FIXTURE_NOW }

// Full mount: a pending interaction replaces the composer through the
// workspace's interaction provider, scoped to the thread on screen.
it("renders pending provider interactions through the unified runtime and submits to their owning Session", async () => {
  const user = userEvent.setup()
  const request: RuntimeQuestionRequest = {
    kind: "question",
    requestId: "pending-choice",
    sessionId: "thread-aster-market",
    questions: [
      {
        header: "Direction",
        prompt: "Choose the direction",
        options: [{ label: "Proceed", value: "continue" }],
      },
    ],
  }
  const respond = vi.fn(async () => {})
  const interactions: RuntimeInteractionAdapter = {
    getPending: (sessionId) =>
      sessionId === request.sessionId ? request : undefined,
    subscribe: () => () => {},
    respond,
    reject: async () => {},
  }
  render(
    <ControlledWorkspaceFixture initialThreadId="thread-aster-market">
      {(bundle) => (
        <AosUiWorkspace
          runtime={{ ...asHarnessRuntime(bundle), interactions }}
          locale="en"
          dictionary={en}
          now={FIXTURE_NOW}
        />
      )}
    </ControlledWorkspaceFixture>
  )
  expect(await screen.findByText("Choose the direction")).toBeVisible()
  await user.click(screen.getByText("Proceed"))
  await user.click(screen.getByRole("button", { name: "Send answer" }))
  expect(respond).toHaveBeenCalledWith(request, {
    kind: "question",
    answers: [["continue"]],
  })
})

describe("reversible local Session tabs", () => {
  it("keeps a provider-neutral local draft selected without creating a remote Session", async () => {
    const view = renderNavigation(() =>
      registeredDraftRuntime(useMarketWorkspace())
    )
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    const { assistantRuntime, workspace } = view.runtime
    const create = vi.spyOn(workspace, "createSession")
    const threads = assistantRuntime.threads
    const originalSwitchToThread = threads.switchToThread.bind(threads)
    let clickStarted = false
    const switchesAfterClick: string[] = []
    vi.spyOn(threads, "switchToThread").mockImplementation(async (id) => {
      if (clickStarted) switchesAfterClick.push(id)
      await originalSwitchToThread(id)
    })
    const switchToNew = vi.spyOn(threads, "switchToNewThread")

    clickStarted = true
    await act(() => view.nav.createSession("agent-aster"))

    await waitFor(() => expect(switchToNew).toHaveBeenCalledOnce())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(switchesAfterClick).toEqual([])
    await waitFor(() => {
      const state = threads.getState()
      expect(state.mainThreadId).not.toBe("thread-aster-market")
      expect(state.threadItems[state.mainThreadId]).toMatchObject({
        remoteId: undefined,
        externalId: undefined,
      })
    })
    const draftId = threads.getState().mainThreadId
    // The workspace renders the empty draft's own thread, not a placeholder.
    await waitFor(() => expect(renderedConversation(view.nav)).toBe(draftId))
    expect(view.nav.selectedAgentId).toBe("agent-aster")
    expect(create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe("/agent-aster")
  })

  it("keeps a promoted draft selected until provider metadata confirms it", async () => {
    const view = renderNavigation(useDraftPromotionRaceRuntime)
    await waitFor(() => expect(view.nav.selectedAgentId).toBe("agent-aster"))
    await act(() => view.nav.createSession("agent-aster"))
    const threads = view.runtime.assistantRuntime.threads
    const draftId = threads.getState().mainThreadId
    await waitFor(() => expect(renderedConversation(view.nav)).toBe(draftId))

    await act(async () => {
      await threads.mainItem.initialize()
    })
    const promotedId = threads.getState().threadItems[draftId]?.remoteId
    expect(promotedId).toMatch(/^fixture-session-/u)

    await act(
      async () => await new Promise((resolve) => window.setTimeout(resolve, 50))
    )
    expect(threads.getState().mainThreadId).toBe(draftId)
    expect(window.location.pathname).toBe(`/agent-aster/${promotedId}`)
    expect(renderedConversation(view.nav)).toBe(draftId)
  })

  // Full mount: only the workspace's render branch proves the previous
  // conversation leaves the screen while draft selection is pending.
  it("hides the previous conversation while local draft selection is pending", async () => {
    const user = userEvent.setup()
    const draftGate = deferred<void>()
    renderWorkspace(() =>
      registeredDraftRuntime(useMarketWorkspace(), () => draftGate.promise)
    )

    await screen.findByText("Test response")
    await user.click(
      within(
        screen.getByRole("complementary", { name: en.workspace.agentDetails })
      ).getByRole("button", { name: en.actions.newSession })
    )

    expect(await screen.findByText("Loading workspace…")).toBeVisible()
    expect(screen.queryByText("Test response")).toBeNull()

    await act(async () => draftGate.resolve())
    expect(
      await screen.findByRole("textbox", { name: "Message input" })
    ).toBeVisible()
  })

  it("applies browser navigation while a previous Session switch is finishing", async () => {
    const view = renderNavigation(useMarketWorkspace)
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    const threads = view.runtime.assistantRuntime.threads
    const switchToThread = threads.switchToThread.bind(threads)
    const pending = deferred<void>()
    vi.spyOn(threads, "switchToThread").mockImplementation(async (id) => {
      await switchToThread(id)
      if (id === "thread-mica-quarterly") await pending.promise
    })

    try {
      act(() => void view.nav.selectAgent("agent-mica"))
      await waitFor(() =>
        expect(openTabIds(view.nav)).toContain("thread-mica-quarterly")
      )
      // The router exposes Back before the previous adapter promise settles.
      window.history.replaceState({}, "", "/agent-aster/thread-aster-market")
      view.rerender()
      await waitFor(() =>
        expect(view.nav.visibleThreadId).toBe("thread-aster-market")
      )
    } finally {
      await act(async () => pending.resolve())
    }
    expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    expect(window.location.pathname).toBe("/agent-aster/thread-aster-market")
  })

  it("keeps the resolved conversation mounted during a background Session reload", async () => {
    const view = renderNavigation(useMarketWorkspace)
    await waitFor(() =>
      expect(renderedConversation(view.nav)).toBe("thread-aster-market")
    )

    const pendingList =
      deferred<Awaited<ReturnType<FixtureThreadListAdapter["list"]>>>()
    const list = vi
      .spyOn(FixtureThreadListAdapter.prototype, "list")
      .mockReturnValueOnce(pendingList.promise)

    let reload!: Promise<void>
    act(() => {
      reload = view.runtime.assistantRuntime.threads.reload()
    })
    await waitFor(() => expect(list).toHaveBeenCalledOnce())

    expect(renderedConversation(view.nav)).toBe("thread-aster-market")

    // A reload that lists fewer Sessions, the open one among those dropped,
    // still leaves the conversation on screen.
    pendingList.resolve({ threads: [] })
    await act(() => reload)
    list.mockRestore()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(renderedConversation(view.nav)).toBe("thread-aster-market")
  })

  it("reloads the thread list only when the catalog names a Session it lacks", async () => {
    let hearCatalog: (sessionIds: readonly string[]) => void = () => {}
    const view = renderNavigation(() => {
      const bundle = useMarketWorkspace()
      // The fixture has no catalog feed, so the test plays one, in place
      // before navigation subscribes to it.
      bundle.workspace.subscribeSessionCatalog ??= (listener) => {
        hearCatalog = listener
        return () => {}
      }
      return bundle
    })
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    const list = vi.spyOn(FixtureThreadListAdapter.prototype, "list")

    act(() => hearCatalog(["thread-aster-market", "thread-aster-launch"]))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(list).not.toHaveBeenCalled()

    // Another tab creates a Session this one has never listed.
    const { sessionId } = await view.runtime.workspace.createSession(
      "agent-aster",
      { title: "Created elsewhere" }
    )
    act(() => hearCatalog(["thread-aster-market", sessionId]))

    await waitFor(() =>
      expect([
        ...view.nav.sessionView.openSessions,
        ...view.nav.sessionView.allSessions,
      ]).toContainEqual(
        expect.objectContaining({ sessionId, title: "Created elsewhere" })
      )
    )
    expect(list).toHaveBeenCalledOnce()
    list.mockRestore()
  })

  it("opens an older Session encoded in a direct URL", async () => {
    window.history.replaceState({}, "", "/agent-aster/thread-aster-pricing")

    const view = renderNavigation(usePublicFixture, fixtureClock)

    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-pricing")
    )
    expect(openTabIds(view.nav)).toContain("thread-aster-pricing")
    expect(window.location.pathname).toBe("/agent-aster/thread-aster-pricing")
  })

  it("normalizes a stale route to an available Agent and Session", async () => {
    window.history.replaceState({}, "", "/missing-agent/missing-session")
    const replaceState = vi.spyOn(window.history, "replaceState")

    const view = renderNavigation(usePublicFixture, fixtureClock)

    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/agent-aster/thread-aster-market"
      )
    )
  })

  it("leaves no selected Session after the last open tab closes, even with older history", async () => {
    const view = renderNavigation(usePublicFixture, fixtureClock)
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    for (const sessionId of [
      "thread-aster-market",
      "thread-aster-launch",
      "thread-aster-scan",
    ]) {
      await act(() => view.nav.closeSession(sessionId))
      await waitFor(() => expect(openTabIds(view.nav)).not.toContain(sessionId))
    }
    await waitFor(() => expect(openTabIds(view.nav)).toEqual([]))
    expect(view.nav.visibleThreadId).toBeNull()
    expect(view.nav.tabUndo.pending?.title).toBe("Competitive scan")
    await act(() => view.nav.undoCloseSession())
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-scan")
    )
  })

  // Full mount: navigation focuses the restored tab by the shell's tab id once
  // it renders, so only the two together prove focus lands on it.
  it("returns focus to the restored tab after Undo", async () => {
    const user = userEvent.setup()
    renderWorkspace(useMarketWorkspace)
    await user.click(
      await screen.findByRole("button", { name: "Close session: Market brief" })
    )
    expect(screen.queryByRole("tab", { name: "Market brief" })).toBeNull()

    await user.click(await screen.findByRole("button", { name: "Undo" }))

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveFocus()
    )
  })

  it("restores the exact closed tab and selection without provider lifecycle mutations, and a background tab without selecting it", async () => {
    const view = renderNavigation(useMarketWorkspace)
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    const { assistantRuntime: runtime, workspace } = view.runtime
    const item = runtime.threads.getItemById("thread-aster-market")
    const archive = vi.spyOn(item, "archive")
    const remove = vi.spyOn(item, "delete")
    const stop = vi.spyOn(runtime.thread, "cancelRun")
    const create = vi.spyOn(workspace, "createSession")
    const before = await workspace.getSessionMetadata(["thread-aster-market"])
    await act(() => view.nav.closeSession("thread-aster-market"))
    expect(openTabIds(view.nav)).not.toContain("thread-aster-market")
    expect(view.nav.tabUndo.pending?.title).toBe("Market brief")
    await act(() => view.nav.undoCloseSession())
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    expect(openTabIds(view.nav)).toContain("thread-aster-market")
    expect(await workspace.getSessionMetadata(["thread-aster-market"])).toEqual(
      before
    )
    for (const mutation of [archive, remove, stop, create])
      expect(mutation).not.toHaveBeenCalled()

    // History opens a second tab; closing it once Market brief leads again
    // closes a background tab.
    await act(() => view.nav.openSession("thread-aster-pricing"))
    await act(() => view.nav.openSession("thread-aster-market"))
    await waitFor(() =>
      expect(view.nav.visibleThreadId).toBe("thread-aster-market")
    )
    await act(() => view.nav.closeSession("thread-aster-pricing"))
    await act(() => view.nav.undoCloseSession())
    await waitFor(() =>
      expect(openTabIds(view.nav)).toContain("thread-aster-pricing")
    )
    expect(view.nav.visibleThreadId).toBe("thread-aster-market")
  })
})

describe("artifact Session scope", () => {
  // Full mount: the artifact bridge pairs the rendered messages with their
  // Session inside the workspace; nothing lower renders both.
  it("never reads an artifact against a Session that does not own it", async () => {
    // The provider authorizes an artifact read against the Session that
    // published it, so a read carrying another Session's id is refused
    // outright. Switching Sessions must not be able to pair one Session's id
    // with the artifacts still on screen from the one before it.
    const reads: { artifact: string; sessionId: string }[] = []
    const artifacts: ArtifactAdapter = {
      resolve: ({ artifact, sessionId }) => {
        reads.push({ artifact: artifact.id, sessionId })
        return Promise.resolve(new Blob(["bytes"], { type: "image/png" }))
      },
    }
    const messagesByThread: Record<string, ThreadMessageLike[]> = {
      "thread-aster-market": [
        { id: "market-user", role: "user", content: "Chart it" },
        {
          id: "market-assistant",
          role: "assistant",
          content: [
            {
              type: "data",
              name: "aos.artifact",
              data: {
                id: "market-chart",
                filename: "market-chart.png",
                mimeType: "image/png",
                source: { type: "provider", reference: "market-chart" },
              },
            },
          ],
        },
      ],
      "thread-aster-launch": [
        { id: "launch-user", role: "user", content: "Status?" },
        { id: "launch-assistant", role: "assistant", content: "On track." },
      ],
    }
    const view = renderWorkspace(() => ({
      ...useControlledWorkspace({
        initialThreadId: "thread-aster-market",
        messagesByThread,
      }),
      artifacts,
    }))

    await screen.findByRole("tab", { name: "Market brief" })
    await waitFor(() => expect(reads.length).toBeGreaterThan(0))

    // The switch a tab performs, driven through the runtime that owns it.
    const threads = view.runtime.assistantRuntime.threads
    for (const sessionId of ["thread-aster-launch", "thread-aster-market"]) {
      await act(async () => {
        await threads.switchToThread(sessionId)
      })
      await waitFor(() =>
        expect(threads.getState().mainThreadId).toBe(sessionId)
      )
    }

    expect(
      reads.filter(({ sessionId }) => sessionId !== "thread-aster-market")
    ).toEqual([])
  })
})

describe("paged Session History", () => {
  const pinnedId = "thread-aster-pinned"
  // Ten Aster Sessions, newest first, and an old pinned one.
  const pagedSessions = [
    ...Array.from({ length: 10 }, (_, index) => ({
      sessionId: `thread-aster-${index}`,
      agentId: "agent-aster",
      updatedAt: new Date(Date.UTC(2026, 8, 3, 11 - index)).toISOString(),
      status: "idle" as const,
    })),
    {
      sessionId: pinnedId,
      agentId: "agent-aster",
      updatedAt: "2026-08-01T12:00:00.000Z",
      status: "idle" as const,
      pinned: true,
    },
  ]
  const sessionTitles = Object.fromEntries([
    ...pagedSessions.map(({ sessionId }) => [
      sessionId,
      `Session ${sessionId}`,
    ]),
    [pinnedId, "Pinned plan"],
  ])
  let observed: IntersectionObserverCallback[] = []

  beforeEach(() => {
    observed = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          observed.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    const list = FixtureThreadListAdapter.prototype.list
    // The provider pages the catalog and back-fills the pinned Session onto
    // every page, the way Hermes does.
    // The fixture lists everything at once, so the spy widens it to the paged
    // adapter signature.
    const pagedList: Pick<RemoteThreadListAdapter, "list"> =
      FixtureThreadListAdapter.prototype
    vi.spyOn(pagedList, "list").mockImplementation(async function (
      this: FixtureThreadListAdapter,
      params
    ) {
      const { threads } = await list.call(this)
      const pinned = threads.filter(({ remoteId }) => remoteId === pinnedId)
      const natural = threads.filter(({ remoteId }) => remoteId !== pinnedId)
      return params?.after
        ? { threads: [...natural.slice(5), ...pinned] }
        : { threads: [...natural.slice(0, 5), ...pinned], nextCursor: "5" }
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const usePagedWorkspace = () =>
    useControlledWorkspace({
      initialThreadId: "thread-aster-0",
      workspace: { sessions: pagedSessions, sessionTitles },
    })

  const rowsIn = (section: string, title: string) =>
    screen
      .queryAllByRole("region", { name: section })
      .flatMap((region) => within(region).queryAllByRole("button"))
      .filter((button) => button.textContent?.includes(title)).length
  const loadMoreButton = () =>
    screen.queryByRole("button", {
      name: en.mobileNavigation.loadMoreSessions,
    })

  // Full mount: the History list's sentinel and button drive the thread list's
  // paging through navigation's merged catalog.
  it("appends the next page when the end of History scrolls into view, or from the keyboard-reachable button", async () => {
    const user = userEvent.setup()
    renderWorkspace(usePagedWorkspace)
    await waitFor(() => expect(loadMoreButton()).not.toBeNull())
    expect(rowsIn(en.mobileNavigation.history, "thread-aster-9")).toBe(0)

    act(() => {
      for (const callback of observed)
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
    })

    await waitFor(() =>
      expect(rowsIn(en.mobileNavigation.history, "thread-aster-9")).toBe(1)
    )
    expect(loadMoreButton()).toBeNull()
    for (let index = 1; index < 10; index += 1)
      expect(rowsIn(en.mobileNavigation.history, `thread-aster-${index}`)).toBe(
        1
      )
    expect(rowsIn(en.mobileNavigation.history, "Pinned plan")).toBe(0)
    expect(rowsIn(en.mobileNavigation.openSessions, "Pinned plan")).toBe(1)

    cleanup()
    renderWorkspace(usePagedWorkspace)
    await waitFor(() => expect(loadMoreButton()).not.toBeNull())

    await user.click(loadMoreButton()!)

    await waitFor(() =>
      expect(rowsIn(en.mobileNavigation.history, "thread-aster-9")).toBe(1)
    )
    expect(loadMoreButton()).toBeNull()
  })
})
