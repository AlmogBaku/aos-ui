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
import type { RemoteThreadListAdapter } from "@assistant-ui/react"

import { en } from "@/lib/i18n/dictionaries/en"
import type {
  ArtifactAdapter,
  HarnessRuntime,
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"

import {
  ControlledWorkspaceFixture,
  type WorkspaceFixtureRuntime,
} from "./test-utils/controlled-workspace-fixture"
import { AosUiWorkspace } from "./aos-ui-workspace"
import {
  asHarnessRuntime,
  RegisteredDraftWorkspace,
  DraftPromotionRaceWorkspace,
  TabFixture,
  deferred,
  ScopedArtifactWorkspace,
  FIXTURE_NOW,
  FixtureThreadListAdapter,
  FixtureAosUiApp,
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
    getPending: (threadId) =>
      threadId === request.sessionId ? request : undefined,
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
    const user = userEvent.setup()
    let bundle: WorkspaceFixtureRuntime | undefined
    const capture = (value: WorkspaceFixtureRuntime) => {
      bundle = value
    }
    render(
      <ControlledWorkspaceFixture initialThreadId="thread-aster-market">
        {(value) => (
          <RegisteredDraftWorkspace bundle={value} capture={capture} />
        )}
      </ControlledWorkspaceFixture>
    )
    await screen.findByRole("tab", { name: "Market brief" })
    const create = vi.spyOn(bundle!.workspace, "createSession")
    const threads = bundle!.assistantRuntime.threads
    const originalSwitchToThread = threads.switchToThread.bind(threads)
    let clickStarted = false
    const switchesAfterClick: string[] = []
    vi.spyOn(threads, "switchToThread").mockImplementation(async (id) => {
      if (clickStarted) switchesAfterClick.push(id)
      await originalSwitchToThread(id)
    })
    const switchToNew = vi.spyOn(threads, "switchToNewThread")
    const button = await within(
      await screen.findByRole("complementary", {
        name: en.workspace.agentDetails,
      })
    ).findByRole("button", { name: en.actions.newSession })

    clickStarted = true
    await user.click(button)

    await waitFor(() => expect(switchToNew).toHaveBeenCalledOnce())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(switchesAfterClick).toEqual([])
    await waitFor(() => {
      const state = bundle!.assistantRuntime.threads.getState()
      expect(state.mainThreadId).not.toBe("thread-aster-market")
      expect(state.threadItems[state.mainThreadId]).toMatchObject({
        remoteId: undefined,
        externalId: undefined,
      })
    })
    const draftId = bundle!.assistantRuntime.threads.getState().mainThreadId
    expect(bundle!.assistantRuntime.threads.getState().mainThreadId).toBe(
      draftId
    )
    expect(
      await screen.findByRole("heading", {
        name: "What would you like to work on?",
      })
    ).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Message input" })).toBeVisible()
    expect(screen.queryByText("Start your first session")).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe("/agent-aster")
  })

  it("keeps a promoted draft selected until provider metadata confirms it", async () => {
    const user = userEvent.setup()
    let runtime: HarnessRuntime | undefined
    render(
      <DraftPromotionRaceWorkspace
        capture={(value) => {
          runtime = value
        }}
      />
    )
    await user.click(
      await within(
        await screen.findByRole("complementary", {
          name: en.workspace.agentDetails,
        })
      ).findByRole("button", { name: en.actions.newSession })
    )
    await screen.findByRole("textbox", { name: "Message input" })
    const draftId = runtime!.assistantRuntime.threads.getState().mainThreadId

    await act(async () => {
      await runtime!.assistantRuntime.threads.mainItem.initialize()
    })
    const promotedId =
      runtime!.assistantRuntime.threads.getState().threadItems[draftId]
        ?.remoteId
    expect(promotedId).toMatch(/^fixture-session-/u)

    await act(
      async () => await new Promise((resolve) => window.setTimeout(resolve, 50))
    )
    expect(runtime!.assistantRuntime.threads.getState().mainThreadId).toBe(
      draftId
    )
    expect(window.location.pathname).toBe(`/agent-aster/${promotedId}`)
    expect(screen.getByRole("textbox", { name: "Message input" })).toBeVisible()
  })

  it("hides the previous conversation while local draft selection is pending", async () => {
    const user = userEvent.setup()
    const draftGate = deferred<void>()
    render(
      <ControlledWorkspaceFixture initialThreadId="thread-aster-market">
        {(bundle) => (
          <RegisteredDraftWorkspace
            bundle={bundle}
            capture={() => undefined}
            beforeDraftSelection={() => draftGate.promise}
          />
        )}
      </ControlledWorkspaceFixture>
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
    const user = userEvent.setup()
    let bundle: WorkspaceFixtureRuntime | undefined
    const capture = (value: WorkspaceFixtureRuntime) => {
      bundle = value
    }
    const view = render(<TabFixture capture={capture} />)
    await screen.findByRole("tab", { name: "Market brief" })
    const threads = bundle!.assistantRuntime.threads
    const switchToThread = threads.switchToThread.bind(threads)
    const pending = deferred<void>()
    vi.spyOn(threads, "switchToThread").mockImplementation(async (id) => {
      await switchToThread(id)
      if (id === "thread-mica-quarterly") await pending.promise
    })

    try {
      await user.click(screen.getByRole("button", { name: "Mica" }))
      await screen.findByRole("tab", { name: "Quarterly synthesis" })
      // The router exposes Back before the previous adapter promise settles.
      window.history.replaceState({}, "", "/agent-aster/thread-aster-market")
      view.rerender(<TabFixture capture={capture} />)
      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "Market brief" })
        ).toHaveAttribute("aria-selected", "true")
      )
    } finally {
      await act(async () => pending.resolve())
    }
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(window.location.pathname).toBe("/agent-aster/thread-aster-market")
  })

  it("keeps the resolved conversation mounted during a background Session reload", async () => {
    let bundle: WorkspaceFixtureRuntime | undefined
    render(
      <TabFixture
        capture={(value) => {
          bundle = value
        }}
      />
    )
    await screen.findByText("Test response")

    const pendingList =
      deferred<Awaited<ReturnType<FixtureThreadListAdapter["list"]>>>()
    const list = vi
      .spyOn(FixtureThreadListAdapter.prototype, "list")
      .mockReturnValueOnce(pendingList.promise)

    let reload!: Promise<void>
    act(() => {
      reload = bundle!.assistantRuntime.threads.reload()
    })
    await waitFor(() => expect(list).toHaveBeenCalledOnce())

    expect(screen.queryByText("Loading workspace…")).toBeNull()
    expect(screen.getByText("Test response")).toBeVisible()

    pendingList.resolve({ threads: [] })
    await act(() => reload)
    list.mockRestore()
  })

  it("opens an older Session encoded in a direct URL", async () => {
    window.history.replaceState({}, "", "/agent-aster/thread-aster-pricing")

    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toHaveAttribute("aria-selected", "true")
    expect(window.location.pathname).toBe("/agent-aster/thread-aster-pricing")
  })

  it("normalizes a stale route to an available Agent and Session", async () => {
    window.history.replaceState({}, "", "/missing-agent/missing-session")
    const replaceState = vi.spyOn(window.history, "replaceState")

    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("tab", { name: "Market brief" })
    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/agent-aster/thread-aster-market"
      )
    )
  })

  it("leaves no selected Session after the last open tab closes, even with older history", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)
    await screen.findByRole("tab", { name: "Market brief" })
    for (const title of ["Market brief", "Launch review", "Competitive scan"]) {
      await user.click(
        screen.getByRole("button", { name: `Close session: ${title}` })
      )
      await waitFor(() =>
        expect(screen.queryByRole("tab", { name: title })).toBeNull()
      )
    }
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0))
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Competitive scan" })
      ).toHaveAttribute("aria-selected", "true")
    )
  })
  it("restores the exact closed tab and selection without provider lifecycle mutations, and a background tab without selecting it", async () => {
    const user = userEvent.setup()
    let bundle: WorkspaceFixtureRuntime | undefined
    render(
      <TabFixture
        capture={(value) => {
          bundle = value
        }}
      />
    )
    await screen.findByRole("tab", { name: "Market brief" })
    const runtime = bundle!.assistantRuntime
    const item = runtime.threads.getItemById("thread-aster-market")
    const archive = vi.spyOn(item, "archive")
    const remove = vi.spyOn(item, "delete")
    const stop = vi.spyOn(runtime.thread, "cancelRun")
    const create = vi.spyOn(bundle!.workspace, "createSession")
    const before = await bundle!.workspace.getSessionMetadata([
      "thread-aster-market",
    ])
    await user.click(
      screen.getByRole("button", { name: "Close session: Market brief" })
    )
    expect(screen.queryByRole("tab", { name: "Market brief" })).toBeNull()
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
    expect(
      await bundle!.workspace.getSessionMetadata(["thread-aster-market"])
    ).toEqual(before)
    for (const mutation of [archive, remove, stop, create])
      expect(mutation).not.toHaveBeenCalled()

    // History opens a second tab; closing it once Market brief leads again
    // closes a background tab.
    await user.click(
      screen.getByRole("button", { name: "Open session: Pricing analysis" })
    )
    await user.click(await screen.findByRole("tab", { name: "Market brief" }))
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
    await user.click(
      screen.getByRole("button", { name: "Close session: Pricing analysis" })
    )
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    expect(
      await screen.findByRole("tab", { name: "Pricing analysis" })
    ).toHaveAttribute("aria-selected", "false")
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })
})

describe("artifact Session scope", () => {
  it("never reads an artifact against a Session that does not own it", async () => {
    // The provider authorizes an artifact read against the Session that
    // published it, so a read carrying another Session's id is refused
    // outright. Switching Sessions must not be able to pair one Session's id
    // with the artifacts still on screen from the one before it.
    const reads: { artifact: string; threadId: string }[] = []
    const artifacts: ArtifactAdapter = {
      resolve: ({ artifact, threadId }) => {
        reads.push({ artifact: artifact.id, threadId })
        return Promise.resolve(new Blob(["bytes"], { type: "image/png" }))
      },
    }
    let bundle: WorkspaceFixtureRuntime | undefined
    const capture = (value: WorkspaceFixtureRuntime) => {
      bundle = value
    }
    render(
      <ControlledWorkspaceFixture
        initialThreadId="thread-aster-market"
        messagesByThread={{
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
        }}
      >
        {(value) => (
          <ScopedArtifactWorkspace
            bundle={{ ...value, artifacts }}
            capture={capture}
          />
        )}
      </ControlledWorkspaceFixture>
    )

    await screen.findByRole("tab", { name: "Market brief" })
    await waitFor(() => expect(reads.length).toBeGreaterThan(0))

    // The switch a tab performs, driven through the runtime that owns it.
    const threads = bundle!.assistantRuntime.threads
    for (const threadId of ["thread-aster-launch", "thread-aster-market"]) {
      await act(async () => {
        await threads.switchToThread(threadId)
      })
      await waitFor(() =>
        expect(threads.getState().mainThreadId).toBe(threadId)
      )
    }

    expect(
      reads.filter(({ threadId }) => threadId !== "thread-aster-market")
    ).toEqual([])
  })
})

describe("paged Session History", () => {
  const pinnedId = "thread-aster-pinned"
  // Ten Aster Sessions, newest first, and an old pinned one.
  const pagedSessions = [
    ...Array.from({ length: 10 }, (_, index) => ({
      threadId: `thread-aster-${index}`,
      agentId: "agent-aster",
      updatedAt: new Date(Date.UTC(2026, 8, 3, 11 - index)).toISOString(),
      status: "idle" as const,
    })),
    {
      threadId: pinnedId,
      agentId: "agent-aster",
      updatedAt: "2026-08-01T12:00:00.000Z",
      status: "idle" as const,
      pinned: true,
    },
  ]
  const sessionTitles = Object.fromEntries([
    ...pagedSessions.map(({ threadId }) => [threadId, `Session ${threadId}`]),
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

  function PagedWorkspace() {
    return (
      <ControlledWorkspaceFixture
        initialThreadId="thread-aster-0"
        workspace={{ sessions: pagedSessions, sessionTitles }}
      >
        {(bundle) => (
          <AosUiWorkspace
            locale="en"
            dictionary={en}
            runtime={asHarnessRuntime(bundle)}
            now={FIXTURE_NOW}
          />
        )}
      </ControlledWorkspaceFixture>
    )
  }

  const rowsIn = (section: string, title: string) =>
    screen
      .queryAllByRole("region", { name: section })
      .flatMap((region) => within(region).queryAllByRole("button"))
      .filter((button) => button.textContent?.includes(title)).length
  const loadMoreButton = () =>
    screen.queryByRole("button", {
      name: en.mobileNavigation.loadMoreSessions,
    })

  it("appends the next page when the end of History scrolls into view, or from the keyboard-reachable button", async () => {
    const user = userEvent.setup()
    render(<PagedWorkspace />)
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
    render(<PagedWorkspace />)
    await waitFor(() => expect(loadMoreButton()).not.toBeNull())

    await user.click(loadMoreButton()!)

    await waitFor(() =>
      expect(rowsIn(en.mobileNavigation.history, "thread-aster-9")).toBe(1)
    )
    expect(loadMoreButton()).toBeNull()
  })
})
