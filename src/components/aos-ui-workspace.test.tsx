import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useEffect, useMemo, useState } from "react"
import {
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type {
  ArtifactAdapter,
  HarnessRuntime,
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import {
  createFixtureChatModel,
  FixtureThreadListAdapter,
  useFixtureRuntimeBundle,
} from "@/runtime-adapters/fixture/fixture-runtime"
import {
  FIXTURE_NOW,
  createFixtureWorkspace,
  type FixtureWorkspace,
  fixtureSessions,
} from "@/runtime-adapters/fixture/fixture-workspace"

import { FixtureAosUiApp } from "@/runtime-adapters/fixture/composition"
import {
  ControlledWorkspaceFixture,
  type WorkspaceFixtureRuntime,
} from "./test-utils/controlled-workspace-fixture"
import { AosUiWorkspace } from "./aos-ui-workspace"

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

const fixtureClock = () => FIXTURE_NOW

function asHarnessRuntime(bundle: WorkspaceFixtureRuntime): HarnessRuntime {
  return {
    assistantRuntime: bundle.assistantRuntime,
    workspace: bundle.workspace,
    artifacts: bundle.artifacts ? { resolver: bundle.artifacts } : undefined,
    activityCoverage: "workspace",
  }
}

function RegisteredDraftWorkspace({
  bundle,
  capture,
  beforeDraftSelection,
}: {
  bundle: WorkspaceFixtureRuntime
  capture: (bundle: WorkspaceFixtureRuntime) => void
  beforeDraftSelection?: () => Promise<void>
}) {
  useEffect(() => capture(bundle), [bundle, capture])
  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={{
        ...asHarnessRuntime(bundle),
        createSessionDraft: async () => {
          await beforeDraftSelection?.()
          await bundle.assistantRuntime.threads.switchToNewThread()
          return bundle.assistantRuntime.threads.getState().mainThreadId
        },
      }}
      now={FIXTURE_NOW}
    />
  )
}

class DraftPromotingThreadListAdapter extends FixtureThreadListAdapter {
  promotedThreadId: string | null = null

  override async initialize(threadId: string) {
    const [existing] = await this.workspace.getSessionMetadata([threadId])
    if (existing) return super.initialize(threadId)
    const created = await this.workspace.createSession("agent-aster", {
      title: "New Session",
    })
    this.promotedThreadId = created.threadId
    return { remoteId: created.threadId, externalId: created.threadId }
  }
}

function DraftPromotionRaceWorkspace({
  capture,
}: {
  capture: (runtime: HarnessRuntime) => void
}) {
  const [workspace] = useState(() => createFixtureWorkspace())
  const [threadList] = useState(
    () => new DraftPromotingThreadListAdapter(workspace)
  )
  const chatModel = useMemo(
    () => createFixtureChatModel(workspace, { streamDelayMs: 0 }),
    [workspace]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadList,
    runtimeHook: function useFixtureThreadRuntime() {
      return useLocalRuntime(chatModel)
    },
  })
  const filteredWorkspace = useMemo(() => {
    const getSessionMetadata = async (threadIds: string[]) =>
      (await workspace.getSessionMetadata(threadIds)).filter(
        ({ threadId }) => threadId !== threadList.promotedThreadId
      )
    return {
      listAgents: () => workspace.listAgents(),
      refreshAgents: () => workspace.refreshAgents(),
      createSession: (
        agentId: string,
        options?: Parameters<WorkspaceAdapter["createSession"]>[1]
      ) => workspace.createSession(agentId, options),
      getSessionMetadata,
      subscribeSessionMetadata(
        threadIds: readonly string[],
        listener: Parameters<
          NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
        >[1]
      ) {
        let active = true
        queueMicrotask(() => {
          void getSessionMetadata([...threadIds]).then((metadata) => {
            if (active) listener(metadata)
          })
        })
        return () => {
          active = false
        }
      },
    } satisfies WorkspaceAdapter
  }, [threadList, workspace])
  const runtime = useMemo<HarnessRuntime>(
    () => ({
      assistantRuntime,
      workspace: filteredWorkspace,
      activityCoverage: "workspace",
      createSessionDraft: async () => {
        await assistantRuntime.threads.switchToNewThread()
        return assistantRuntime.threads.getState().mainThreadId
      },
    }),
    [assistantRuntime, filteredWorkspace]
  )
  useEffect(() => capture(runtime), [capture, runtime])
  return (
    <AosUiWorkspace
      runtime={runtime}
      locale="en"
      dictionary={en}
      now={FIXTURE_NOW}
    />
  )
}

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

function TabFixture({
  capture,
}: {
  capture: (bundle: WorkspaceFixtureRuntime) => void
}) {
  return (
    <ControlledWorkspaceFixture
      initialThreadId="thread-aster-market"
      messagesByThread={{
        "thread-aster-market": [
          {
            id: "test-market-user",
            role: "user",
            content: "Test request",
          },
          {
            id: "test-market-assistant",
            role: "assistant",
            content: "Test response",
          },
        ],
      }}
    >
      {(bundle) => <TabWorkspace bundle={bundle} capture={capture} />}
    </ControlledWorkspaceFixture>
  )
}

function TabWorkspace({
  bundle,
  capture,
}: {
  bundle: WorkspaceFixtureRuntime
  capture: (bundle: WorkspaceFixtureRuntime) => void
}) {
  useEffect(() => capture(bundle), [bundle, capture])
  return (
    <AosUiWorkspace
      runtime={asHarnessRuntime(bundle)}
      locale="en"
      dictionary={en}
      now={FIXTURE_NOW}
    />
  )
}

function CreatorFixtureAosUiApp({
  locale,
  workspace,
  initialThreadId = "thread-aster-market",
  capture,
}: {
  locale: "en" | "he"
  workspace?: FixtureWorkspace
  initialThreadId?: string
  capture?: (bundle: {
    workspace: FixtureWorkspace
    assistantRuntime: WorkspaceFixtureRuntime["assistantRuntime"]
  }) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId)
  const bundle = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
    enableAgentCreator: true,
    ...(workspace ? { testOnly: { workspace } } : {}),
  })
  useEffect(() => capture?.(bundle), [bundle, capture])
  return (
    <AosUiWorkspace
      runtime={asHarnessRuntime(bundle)}
      locale={locale}
      dictionary={locale === "he" ? he : en}
      now={FIXTURE_NOW}
      readNow={fixtureClock}
    />
  )
}

/** One Agent, one of its Sessions, and one creator interview of a chosen age. */
function interviewWorkspace(interviewAgeMs: number) {
  return createFixtureWorkspace({
    clock: () => FIXTURE_NOW,
    agents: [
      { kind: "ready", id: "agent-aster", name: "Aster" },
      { kind: "ready", id: "agent-mica", name: "Mica" },
    ],
    sessions: [
      {
        threadId: "thread-aster-market",
        agentId: "agent-aster",
        updatedAt: FIXTURE_NOW.toISOString(),
        status: "idle",
      },
      {
        threadId: "interview-thread",
        agentId: "agent-builder",
        updatedAt: new Date(
          FIXTURE_NOW.getTime() - interviewAgeMs
        ).toISOString(),
        status: "idle",
      },
    ],
    todos: {},
    sessionTitles: {
      "thread-aster-market": "Market brief",
      "interview-thread": "New Agent",
    },
  })
}

/**
 * Mirrors a provider that owns Session creation: the interview stays a local
 * thread until its first turn persists it, gated so the pending draft the
 * operator sees before any Session exists is observable.
 */
class PendingInterviewThreadListAdapter extends FixtureThreadListAdapter {
  readonly #owners = new Map<string, string>()

  constructor(
    workspace: FixtureWorkspace,
    private readonly firstTurn: Promise<void>
  ) {
    super(workspace)
  }

  record(localThreadId: string, agentId: string) {
    this.#owners.set(localThreadId, agentId)
  }

  override async initialize(threadId: string) {
    const owner = this.#owners.get(threadId)
    if (!owner) return super.initialize(threadId)
    await this.firstTurn
    const { threadId: remoteId } = await this.workspace.createSession(owner)
    return { remoteId, externalId: remoteId }
  }
}

function PendingInterviewFixture({
  firstTurn,
  capture,
}: {
  firstTurn: Promise<void>
  capture: (workspace: FixtureWorkspace) => void
}) {
  const [workspace] = useState(() =>
    createFixtureWorkspace({
      clock: () => FIXTURE_NOW,
      agents: [{ kind: "ready", id: "agent-aster", name: "Aster" }],
      sessions: [
        {
          threadId: "thread-aster-market",
          agentId: "agent-aster",
          updatedAt: FIXTURE_NOW.toISOString(),
          status: "idle",
        },
      ],
      todos: {},
      sessionTitles: { "thread-aster-market": "Market brief" },
    })
  )
  const [threadList] = useState(
    () => new PendingInterviewThreadListAdapter(workspace, firstTurn)
  )
  const chatModel = useMemo(
    () => createFixtureChatModel(workspace, { streamDelayMs: 0 }),
    [workspace]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadList,
    runtimeHook: function usePendingInterviewThreadRuntime() {
      return useLocalRuntime(chatModel)
    },
  })
  const runtime = useMemo<HarnessRuntime>(
    () => ({
      assistantRuntime,
      workspace,
      activityCoverage: "workspace",
      createSessionDraft: async (agentId) => {
        await assistantRuntime.threads.switchToNewThread()
        const draftId = assistantRuntime.threads.getState().mainThreadId
        threadList.record(draftId, agentId)
        return draftId
      },
    }),
    [assistantRuntime, threadList, workspace]
  )
  useEffect(() => capture(workspace), [capture, workspace])

  return (
    <AosUiWorkspace
      runtime={runtime}
      locale="en"
      dictionary={en}
      now={FIXTURE_NOW}
      readNow={fixtureClock}
    />
  )
}

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
    const button = (
      await screen.findAllByRole("button", {
        name: en.actions.newSession,
      })
    ).find((candidate) => candidate.closest("[data-session-actions]"))
    expect(button).toBeDefined()

    clickStarted = true
    await user.click(button!)

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
    const newSession = (
      await screen.findAllByRole("button", { name: en.actions.newSession })
    ).find((candidate) => candidate.closest("[data-session-actions]"))
    expect(newSession).toBeDefined()
    await user.click(newSession!)
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
    const sessionActions = document.querySelector("[data-session-actions]")
    expect(sessionActions).not.toBeNull()
    await user.click(
      within(sessionActions as HTMLElement).getByRole("button", {
        name: en.actions.newSession,
      })
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
  it("restores the exact closed tab and selection without provider lifecycle mutations", async () => {
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
  })

  it("Undo restores a background tab without selecting it", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)
    await screen.findByRole("tab", { name: "Market brief" })
    await user.click(
      screen.getByRole("button", { name: "Close session: Launch review" })
    )
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    expect(screen.getByRole("tab", { name: "Launch review" })).toHaveAttribute(
      "aria-selected",
      "false"
    )
    expect(screen.getByRole("tab", { name: "Market brief" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })
})

function CatalogFixture({
  empty = false,
  readOnly = false,
  creatorInCatalog = false,
  creatorFirst = false,
  creatorOnly = false,
  agentGate,
  locale = "en",
}: {
  empty?: boolean
  readOnly?: boolean
  creatorInCatalog?: boolean
  creatorFirst?: boolean
  creatorOnly?: boolean
  agentGate?: Promise<void>
  locale?: "en" | "he"
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const agentCreator = fixture.workspace.agentCreator!
  const workspace = useMemo(
    () =>
      workspaceFacade(fixture.workspace, {
        listAgents: async () => {
          await agentGate
          if (empty) return []
          const agents = (await fixture.workspace.listAgents()).filter(
            (agent) => !readOnly || agent.role !== "creator"
          )
          if (creatorOnly) {
            return agents.filter(({ id }) => id === agentCreator.id)
          }
          return creatorFirst
            ? [
                ...agents.filter(({ id }) => id === agentCreator.id),
                ...agents.filter(({ id }) => id !== agentCreator.id),
              ]
            : agents
        },
        listAgentCatalog: async () => {
          if (empty) return []
          const entries = (await fixture.workspace.listAgentCatalog!()).map(
            (entry) => ({ ...entry, editable: !readOnly })
          )
          return creatorInCatalog
            ? [
                ...entries,
                {
                  summary: agentCreator,
                  visibility: "visible" as const,
                  selectable: true,
                  editable: !readOnly,
                },
              ]
            : entries
        },
        updateAgentVisibility: (id, visibility) =>
          fixture.workspace.updateAgentVisibility!(id, visibility),
      }),
    [
      creatorFirst,
      creatorInCatalog,
      creatorOnly,
      agentGate,
      agentCreator,
      empty,
      fixture.workspace,
      readOnly,
    ]
  )
  return (
    <AosUiWorkspace
      runtime={asHarnessRuntime({
        assistantRuntime: fixture.assistantRuntime,
        workspace,
      })}
      locale={locale}
      dictionary={locale === "he" ? he : en}
      now={FIXTURE_NOW}
    />
  )
}

describe("Agent management", () => {
  it("defaults to an ordinary Agent when the creator is listed first", async () => {
    render(<CatalogFixture creatorFirst />)

    expect(
      await screen.findByRole("button", { name: /^Aster,/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("resolves an explicit creator route when no ordinary Agents exist", async () => {
    window.history.replaceState({}, "", "/agent-builder")
    render(<CatalogFixture creatorOnly />)

    expect(
      within(
        await screen.findByRole("main", { name: "Conversation" })
      ).getByRole("heading", { name: "What would you like to work on?" })
    ).toBeVisible()
    expect(
      within(
        screen.getByRole("complementary", { name: "Agent details" })
      ).getByText("Agent Creator")
    ).toBeVisible()
  })

  it("waits for a delayed catalog before resolving a creator route", async () => {
    const agentGate = deferred<void>()
    window.history.replaceState({}, "", "/agent-builder")
    render(<CatalogFixture creatorOnly agentGate={agentGate.promise} />)

    await act(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    )
    await act(async () => agentGate.resolve())

    expect(
      await within(
        screen.getByRole("complementary", { name: "Agent details" })
      ).findByText("Agent Creator")
    ).toBeVisible()
  })

  it("keeps the creator out of Agent management catalogs", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture creatorInCatalog />)

    await user.click(
      await screen.findByRole("button", { name: "Manage Agents" })
    )
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(within(dialog).queryByText("Agent Creator")).toBeNull()
  })

  it("shows hidden Agents and reconciles hiding the selected and last visible Agent", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture />)
    await screen.findByRole("button", { name: /^Aster,/ })
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    const switches = await within(dialog).findAllByRole("switch")
    expect(
      switches.some((item) => item.getAttribute("aria-checked") === "false")
    ).toBe(true)
    await user.click(
      within(dialog).getByRole("switch", { name: "Show in workspace: Aster" })
    )
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Mica,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
    expect(screen.queryByRole("button", { name: /^Aster,/ })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const reopened = await screen.findByRole("dialog", {
      name: "Manage Agents",
    })
    for (const toggle of await within(reopened).findAllByRole("switch", {
      checked: true,
    })) {
      await user.click(toggle)
      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-checked", "false")
      )
    }
    await user.keyboard("{Escape}")
    const main = screen.getByRole("main", { name: "Conversation" })
    expect(
      within(main).getByRole("heading", {
        name: "Add an Agent to your workspace.",
      })
    ).toBeVisible()
    expect(within(main).queryByText("Agent Creator")).toBeNull()
    expect(
      within(main).getByRole("button", { name: "New Agent" })
    ).toBeVisible()
  })

  it("keeps provider-managed entries read-only and omits unavailable creation", async () => {
    const user = userEvent.setup()
    render(<CatalogFixture readOnly />)
    await user.click(screen.getByRole("button", { name: "Manage Agents" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage Agents" })
    expect(
      (await within(dialog).findAllByText("Managed by provider")).length
    ).toBeGreaterThan(0)
    expect(within(dialog).queryByRole("switch")).toBeNull()
    expect(
      within(dialog).queryByRole("button", { name: "New Agent" })
    ).toBeNull()
  })

  it.each(["en", "he"] as const)(
    "renders a truly empty roster in %s and retains management",
    async (locale) => {
      const user = userEvent.setup()
      const dictionary = locale === "he" ? he : en
      render(<CatalogFixture empty readOnly locale={locale} />)
      const heading =
        locale === "en"
          ? "Add an Agent to your workspace."
          : "הוסיפו סוכן לסביבת העבודה."
      await screen.findByRole("heading", { name: heading })
      const main = screen.getByRole("main", {
        name: dictionary.workspace.conversation,
      })
      expect(
        within(main).queryByRole("button", {
          name: dictionary.actions.newAgent,
        })
      ).toBeNull()
      await user.click(
        screen.getByRole("button", { name: dictionary.workspace.manageAgents })
      )
      const dialog = await screen.findByRole("dialog", {
        name: dictionary.workspace.manageAgents,
      })
      expect(dialog).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr")
      await user.keyboard("{Escape}")
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: dictionary.workspace.manageAgents,
          })
        ).toHaveFocus()
      )
    }
  )
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function workspaceFacade(
  workspace: WorkspaceAdapter,
  overrides: Partial<WorkspaceAdapter> = {}
): WorkspaceAdapter {
  return {
    listAgents: () => workspace.listAgents(),
    refreshAgents: () => workspace.refreshAgents(),
    getSessionMetadata: (threadIds) => workspace.getSessionMetadata(threadIds),
    createSession: (agentId, options) =>
      workspace.createSession(agentId, options),
    ...(workspace.subscribeTodos
      ? {
          subscribeTodos: (
            threadId: string,
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeTodos"]>
            >[1],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeTodos"]>
            >[2]
          ) => workspace.subscribeTodos!(threadId, listener, onError),
        }
      : {}),
    ...(workspace.subscribeAgentCatalog
      ? {
          subscribeAgentCatalog: (
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeAgentCatalog"]>
            >[0],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeAgentCatalog"]>
            >[1]
          ) => workspace.subscribeAgentCatalog!(listener, onError),
        }
      : {}),
    ...(workspace.subscribeSessionMetadata
      ? {
          subscribeSessionMetadata: (
            threadIds: readonly string[],
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
            >[1],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
            >[2]
          ) =>
            workspace.subscribeSessionMetadata!(threadIds, listener, onError),
        }
      : {}),
    ...overrides,
  }
}

function GatedMetadataCreatorFixture({
  workspace: seed,
  hold,
  capture,
}: {
  workspace: FixtureWorkspace
  hold: () => Promise<void>
  capture: (runtime: WorkspaceFixtureRuntime["assistantRuntime"]) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
    testOnly: { workspace: seed },
  })
  const bundle = useMemo<WorkspaceFixtureRuntime>(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: workspaceFacade(fixture.workspace, {
        getSessionMetadata: async (threadIds) => {
          await hold()
          return fixture.workspace.getSessionMetadata(threadIds)
        },
      }),
    }),
    [fixture.assistantRuntime, fixture.workspace, hold]
  )
  useEffect(
    () => capture(fixture.assistantRuntime),
    [capture, fixture.assistantRuntime]
  )

  return (
    <AosUiWorkspace
      runtime={asHarnessRuntime(bundle)}
      locale="en"
      dictionary={en}
      now={FIXTURE_NOW}
      readNow={fixtureClock}
    />
  )
}

function BuilderSignalFixture({
  captureCatalogEvent,
}: {
  captureCatalogEvent: (event: {
    complete: () => void
    fail: (error: Error) => void
  }) => void
}) {
  const [providerState] = useState(() => ({ completed: false }))
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<WorkspaceFixtureRuntime>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      refreshAgents: async () => [
        ...(await fixture.workspace.listAgents()),
        ...(providerState.completed
          ? [
              {
                kind: "ready" as const,
                id: "agent-sora",
                name: "Sora",
                description: "Customer insight",
                status: "idle" as const,
                icon: {
                  kind: "symbol" as const,
                  symbol: "spark" as const,
                  tone: "teal" as const,
                },
              },
            ]
          : []),
      ],
      subscribeAgentCatalog: (listener, onError) => {
        captureCatalogEvent({
          complete: () => {
            providerState.completed = true
            listener()
          },
          fail: (error) => onError?.(error),
        })
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [
    captureCatalogEvent,
    fixture.assistantRuntime,
    fixture.workspace,
    providerState,
  ])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(bundle)}
      now={FIXTURE_NOW}
      readNow={fixtureClock}
    />
  )
}

type CreatorReceiptHandle = {
  workspace: FixtureWorkspace
  emitActivity: (event: WorkspaceActivityEvent) => void
  refreshCalls: () => number
  /** Makes the next catalog refresh fail the way a transport failure does. */
  failNextRefresh: () => void
}

type CreatorReceiptState = {
  refreshCalls: number
  failNextRefresh: boolean
  listeners: Set<(event: WorkspaceActivityEvent) => void>
}

/** Hides the created Agent from the first `hideFor` catalog refreshes. */
function receiptWorkspace(
  workspace: FixtureWorkspace,
  state: CreatorReceiptState,
  hideFor: number,
  hiddenAgentId: string
) {
  return workspaceFacade(workspace, {
    refreshAgents: async () => {
      state.refreshCalls += 1
      if (state.failNextRefresh) {
        state.failNextRefresh = false
        throw new Error("Agent catalog refresh failed")
      }
      const agents = await workspace.listAgents()
      return state.refreshCalls <= hideFor
        ? agents.filter(({ id }) => id !== hiddenAgentId)
        : agents
    },
    subscribeActivity: (listener, onError) => {
      state.listeners.add(listener)
      const unsubscribe = workspace.subscribeActivity(listener, onError)
      return () => {
        state.listeners.delete(listener)
        unsubscribe()
      }
    },
  })
}

function CreatorReceiptFixture({
  capture,
  hideFor = 0,
  hiddenAgentId = "agent-sora",
}: {
  capture: (handle: CreatorReceiptHandle) => void
  hideFor?: number
  hiddenAgentId?: string
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const [state] = useState<CreatorReceiptState>(() => ({
    refreshCalls: 0,
    failNextRefresh: false,
    listeners: new Set(),
  }))
  const bundle = useMemo<WorkspaceFixtureRuntime>(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: receiptWorkspace(
        fixture.workspace,
        state,
        hideFor,
        hiddenAgentId
      ),
    }),
    [fixture.assistantRuntime, fixture.workspace, hiddenAgentId, hideFor, state]
  )
  useEffect(
    () =>
      capture({
        workspace: fixture.workspace,
        emitActivity: (event) => {
          for (const listener of state.listeners) listener(event)
        },
        refreshCalls: () => state.refreshCalls,
        failNextRefresh: () => {
          state.failNextRefresh = true
        },
      }),
    [capture, fixture.workspace, state]
  )

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(bundle)}
      now={FIXTURE_NOW}
      readNow={fixtureClock}
    />
  )
}

function BuilderLifecycleFixture({
  captureWorkspace,
}: {
  captureWorkspace: (workspace: FixtureWorkspace) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })

  useEffect(() => {
    captureWorkspace(fixture.workspace)
  }, [captureWorkspace, fixture.workspace])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(fixture)}
      now={FIXTURE_NOW}
      readNow={fixtureClock}
    />
  )
}

function EmptyAgentFixture({
  createSession,
}: {
  createSession?: WorkspaceAdapter["createSession"]
} = {}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<WorkspaceFixtureRuntime>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      listAgents: async () => [
        ...(await fixture.workspace.listAgents()).filter(
          (agent) => agent.role !== "creator"
        ),
        {
          kind: "ready" as const,
          id: "agent-empty",
          name: "Empty",
          description: "A new Agent without Sessions",
          status: "idle",
        },
      ],
      ...(createSession ? { createSession } : {}),
    })
    workspace.refreshAgents = workspace.listAgents
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [createSession, fixture.assistantRuntime, fixture.workspace])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(bundle)}
      now={FIXTURE_NOW}
    />
  )
}

function StaleTodoFixture({
  captureStaleEmission,
}: {
  captureStaleEmission: (emit: () => void) => void
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<WorkspaceFixtureRuntime>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      subscribeTodos: (subscribedThreadId, listener) => {
        if (subscribedThreadId === "thread-aster-market") {
          listener([{ id: "old", label: "Old Agent task", status: "active" }])
          captureStaleEmission(() =>
            listener([
              { id: "late", label: "Leaked delayed task", status: "failed" },
            ])
          )
        } else {
          listener([])
        }
        // Deliberately misbehave like a provider that delivers a queued event
        // after unsubscription. The surface must still isolate the old Session.
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [captureStaleEmission, fixture.assistantRuntime, fixture.workspace])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(bundle)}
      now={FIXTURE_NOW}
    />
  )
}

function SessionMetadataSignalFixture({
  captureSignal,
  initialMetadata,
}: {
  captureSignal: (signal: {
    publish: (
      metadata: Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
    ) => void
    fail: (error: Error) => void
  }) => void
  initialMetadata?: Promise<
    Awaited<ReturnType<WorkspaceAdapter["getSessionMetadata"]>>
  >
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })
  const bundle = useMemo<WorkspaceFixtureRuntime>(() => {
    const workspace = workspaceFacade(fixture.workspace, {
      ...(initialMetadata ? { getSessionMetadata: () => initialMetadata } : {}),
      subscribeSessionMetadata: (_threadIds, listener, onError) => {
        captureSignal({
          publish: listener,
          fail: (error) => onError?.(error),
        })
        return () => undefined
      },
    })
    return { assistantRuntime: fixture.assistantRuntime, workspace }
  }, [
    captureSignal,
    fixture.assistantRuntime,
    fixture.workspace,
    initialMetadata,
  ])

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(bundle)}
      now={FIXTURE_NOW}
    />
  )
}

function ClockBoundaryFixture({ readNow }: { readNow: () => Date }) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const fixture = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
  })

  return (
    <AosUiWorkspace
      locale="en"
      dictionary={en}
      runtime={asHarnessRuntime(fixture)}
      now={readNow()}
      readNow={readNow}
    />
  )
}

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
      act(() => provider!.publishActivityScenario("run-completed"))
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
      act(() => provider!.publishActivityScenario("run-failed"))
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
                {
                  type: "tool-call",
                  toolCallId: "controlled-plan",
                  toolName: "present_plan",
                  args: { title: "Selected plan" },
                  argsText: '{"title":"Selected plan"}',
                  result: {
                    id: "selected-plan",
                    title: "Selected plan",
                    steps: [{ id: "step", label: "Review", status: "active" }],
                  },
                },
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
      await within(conversation).findByRole("heading", {
        name: "Selected plan",
      })
    ).toBeVisible()
    const todos = screen.getByRole("region", { name: "Session todos" })
    expect(within(todos).getAllByRole("listitem")).toHaveLength(2)
    expect(todos).not.toContainElement(
      screen.getByRole("heading", { name: "Selected plan" })
    )
    expect(screen.queryByRole("button", { name: /^Secondary,/ })).toBeNull()
  })

  it("hides the Todo dock for a Session with no provider Todos", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("tab", { name: "Launch review" }))

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Launch review" })
      ).toHaveAttribute("aria-selected", "true")
    )

    expect(screen.queryByRole("region", { name: "Session todos" })).toBeNull()
  })

  it("localizes Session-scoped Todo copy in Hebrew", async () => {
    render(<FixtureAosUiApp locale="he" dictionary={he} />)

    const dock = await screen.findByRole("region", {
      name: "משימות השיחה",
    })

    expect(within(dock).getByText("משימות השיחה")).toBeInTheDocument()
    expect(
      within(dock).getByText("3 מתוך 5 משימות בשיחה הושלמו")
    ).toBeInTheDocument()
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

  it("opens an older Session from Agent history and keeps it as a tab", async () => {
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
  })

  it("closes an automatically recent Session tab until history reopens it", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("tab", { name: "Market brief" })
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
  it("shows the fallback history Session as a tab for an Agent with only old history", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "Nori" }))

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Launch copy, Unread" })
      ).toHaveAttribute("aria-selected", "true")
    )
  })

  it("allows the sole fallback history tab to be closed", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await user.click(await screen.findByRole("button", { name: "Nori" }))
    await screen.findByRole("tab", { name: "Launch copy, Unread" })

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

  it("never exposes another Agent's conversation when the selected Agent has no Session", async () => {
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
  })

  it("exposes tab-bar and inspector creation actions with no Sessions", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    await user.click(await screen.findByRole("button", { name: "Empty" }))

    const actions = await screen.findAllByRole("button", {
      name: en.actions.newSession,
    })
    expect(actions).toHaveLength(2)
    expect(
      actions.some((button) => button.closest("[data-session-actions]"))
    ).toBe(true)
    expect(
      within(
        screen.getByRole("complementary", {
          name: en.workspace.agentDetails,
        })
      ).getByRole("button", { name: en.actions.newSession })
    ).toBeVisible()
  })

  it("identifies the selected Agent beside the shared empty conversation", async () => {
    const user = userEvent.setup()
    render(<EmptyAgentFixture />)

    await user.click(await screen.findByRole("button", { name: "Empty" }))

    expect(
      within(
        screen.getByRole("complementary", {
          name: en.workspace.agentDetails,
        })
      ).getByText("Empty")
    ).toBeVisible()
  })

  it("omits Agent Builder controls when creation is unavailable", async () => {
    render(<EmptyAgentFixture />)

    await screen.findByRole("button", { name: "Manage Agents" })
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull()
  })

  it("does not expose Agent creation in the public fixture demo", async () => {
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("button", { name: /^Aster,/ })
    expect(screen.queryByText("Agent Creator")).toBeNull()
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull()
  })

  it("keeps the creator out of ordinary Agent navigation", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)

    await screen.findByRole("button", { name: /^Aster,/ })
    expect(screen.queryByRole("button", { name: /^Agent Creator,/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.queryByRole("button", { name: "Select Agent: Agent Creator" })
    ).toBeNull()
  })

  it("opens the interview as its own New Agent draft", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        capture={(bundle) => {
          workspace = bundle.workspace
        }}
      />
    )

    await user.click(await screen.findByRole("button", { name: "New Agent" }))

    expect(await screen.findByText("Let's create a new Agent.")).toBeVisible()
    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(draftRow).toHaveAttribute("aria-current", "true")
    const interview = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    expect(window.location.pathname).toBe(
      `/draft%3A${interview.threadId}/${interview.threadId}`
    )
    expect(screen.queryByRole("button", { name: /^Agent Creator/ })).toBeNull()

    await user.click(screen.getByRole("button", { name: /^Commands \(/ }))
    expect(
      screen.getByRole("button", { name: "Select Agent: New Agent" })
    ).toBeVisible()
  })

  it("opens New Agent as a pending draft before its Session exists", async () => {
    const user = userEvent.setup()
    const firstTurn = deferred<void>()
    let workspace: FixtureWorkspace | undefined
    render(
      <PendingInterviewFixture
        firstTurn={firstTurn.promise}
        capture={(value) => {
          workspace = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })

    await user.click(screen.getByRole("button", { name: "New Agent" }))

    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(draftRow).toHaveAttribute("aria-current", "true")
    expect(window.location.pathname).toBe("/draft-pending")
    expect(await screen.findByText(en.creator.kickoff)).toBeVisible()
    expect(screen.queryByRole("tablist", { name: "Sessions" })).toBeNull()
    expect(
      screen.queryByRole("complementary", { name: en.workspace.agentDetails })
    ).toBeNull()
    expect(
      workspace!.listAllSessionMetadata().map(({ agentId }) => agentId)
    ).toEqual(["agent-aster"])

    await user.click(draftRow)

    expect(screen.getByText(en.creator.kickoff)).toBeVisible()
    expect(window.location.pathname).toBe("/draft-pending")

    await act(async () => firstTurn.resolve())

    const interview = await waitFor(() => {
      const created = workspace!
        .listAllSessionMetadata()
        .find(({ agentId }) => agentId === "agent-builder")
      expect(created).toBeDefined()
      return created!
    })
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/draft%3A${interview.threadId}/${interview.threadId}`
      )
    )
    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("discards a pending draft from its row menu, deleting no Session", async () => {
    const user = userEvent.setup()
    const firstTurn = deferred<void>()
    let workspace: FixtureWorkspace | undefined
    render(
      <PendingInterviewFixture
        firstTurn={firstTurn.promise}
        capture={(value) => {
          workspace = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })
    await user.click(screen.getByRole("button", { name: "New Agent" }))
    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    const before = workspace!.listAllSessionMetadata()
    // An interview with no Session has no Session menu; the row menu retires it.
    expect(
      screen.queryByRole("button", {
        name: new RegExp(`^${en.actions.sessionActions}: `),
      })
    ).toBeNull()

    fireEvent.contextMenu(draftRow, { clientX: 16, clientY: 24 })
    await user.click(
      await screen.findByRole("menuitem", { name: en.actions.discardDraft })
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^New Agent, draft/ })
      ).toBeNull()
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
    expect(workspace!.listAllSessionMetadata()).toEqual(before)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("uses the active locale for the interview draft and its prompt", async () => {
    const user = userEvent.setup()
    render(<CreatorFixtureAosUiApp locale="he" />)

    await user.click(await screen.findByRole("button", { name: "סוכן חדש" }))

    expect(await screen.findByText("בוא ניצור סוכן חדש.")).toBeVisible()
    expect(
      await screen.findByRole("button", { name: /^סוכן חדש, טיוטה/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("rebuilds an unresolved draft from provider Sessions after a reload", async () => {
    const workspace = interviewWorkspace(0)
    render(<CreatorFixtureAosUiApp locale="en" workspace={workspace} />)
    await screen.findByRole("button", { name: /^New Agent, draft/ })

    cleanup()
    render(<CreatorFixtureAosUiApp locale="en" workspace={workspace} />)

    expect(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    ).toBeVisible()
  })

  it("hides an interview older than the draft window", async () => {
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        workspace={interviewWorkspace(48 * 60 * 60 * 1000)}
      />
    )

    await screen.findByRole("button", { name: /^Aster/ })
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
  })

  it("never treats a draft as the default Agent", async () => {
    render(
      <CreatorFixtureAosUiApp locale="en" workspace={interviewWorkspace(0)} />
    )

    expect(
      await screen.findByRole("button", { name: /^Aster/ })
    ).toHaveAttribute("aria-current", "true")
    expect(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    ).not.toHaveAttribute("aria-current", "true")
  })

  it("keeps a selected draft selected while Session metadata refreshes", async () => {
    const user = userEvent.setup()
    const workspace = interviewWorkspace(0)
    const refresh = deferred<void>()
    let holding = false
    const hold = async () => {
      if (holding) await refresh.promise
    }
    let runtime: WorkspaceFixtureRuntime["assistantRuntime"] | undefined
    render(
      <GatedMetadataCreatorFixture
        workspace={workspace}
        hold={hold}
        capture={(value) => {
          runtime = value
        }}
      />
    )
    await user.click(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^New Agent, draft/ })
      ).toHaveAttribute("aria-current", "true")
    )

    holding = true
    await act(async () => {
      await workspace.createSession("agent-mica", { title: "Later" })
      await runtime!.threads.reload()
    })

    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /^Aster/ })).not.toHaveAttribute(
      "aria-current",
      "true"
    )

    holding = false
    await act(async () => refresh.resolve())
    expect(
      await screen.findByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("discards a draft by deleting its interview Session", async () => {
    const user = userEvent.setup()
    let bundle:
      | {
          workspace: FixtureWorkspace
          assistantRuntime: WorkspaceFixtureRuntime["assistantRuntime"]
        }
      | undefined
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        capture={(value) => {
          bundle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    const draftRow = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    const interview = bundle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    fireEvent.contextMenu(draftRow, { clientX: 16, clientY: 24 })
    await user.click(
      await screen.findByRole("menuitem", { name: en.actions.discardDraft })
    )
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: en.actions.discardDraft,
      })
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^New Agent, draft/ })
      ).toBeNull()
    )
    const threads = bundle!.assistantRuntime.threads.getState()
    expect(
      threads.threadIds.map((id) => threads.threadItems[id]?.remoteId)
    ).not.toContain(interview.threadId)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
  })

  it("replaces a resolved draft with the created Agent and creates it no Session", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })
    const createSession = vi.spyOn(workspace!, "createSession")
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    const interview = await screen.findByRole("button", {
      name: /^New Agent, draft/,
    })
    expect(interview).toHaveAttribute("aria-current", "true")
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Sora/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(
      workspace!
        .listAllSessionMetadata()
        .filter(({ agentId }) => agentId === "agent-sora")
    ).toHaveLength(0)
    expect(screen.getByRole("tablist", { name: "Sessions" })).toBeVisible()
    expect(
      screen.getByRole("button", { name: en.actions.hideAgentDetails })
    ).toBeVisible()
  })

  it("never steals selection from the Agent in the foreground", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    await user.click(screen.getByRole("button", { name: /^Aster,/ }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
        "aria-current",
        "true"
      )
    )

    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    expect(
      await screen.findByRole("button", { name: /^Sora/ })
    ).not.toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
  })

  it("waits for the catalog to list the created Agent before resolving the draft", async () => {
    const user = userEvent.setup()
    let handle: CreatorReceiptHandle | undefined
    render(
      <CreatorReceiptFixture
        hideFor={1}
        capture={(value) => {
          handle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = handle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      handle!.workspace.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    expect(
      await screen.findByRole("button", { name: /^Sora/ })
    ).toHaveAttribute("aria-current", "true")
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
    expect(screen.queryByText(en.creator.createdPending)).toBeNull()
  })

  it("keeps the draft and reports the created Agent as pending when the catalog never lists it", async () => {
    const user = userEvent.setup()
    let handle: CreatorReceiptHandle | undefined
    render(
      <CreatorReceiptFixture
        hideFor={Number.MAX_SAFE_INTEGER}
        capture={(value) => {
          handle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = handle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      handle!.workspace.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )

    expect(await screen.findByText(en.creator.createdPending)).toBeVisible()
    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()
  })

  it("reports a failed catalog refresh and keeps the draft it cannot resolve", async () => {
    const user = userEvent.setup()
    let handle: CreatorReceiptHandle | undefined
    render(
      <CreatorReceiptFixture
        capture={(value) => {
          handle = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = handle!.workspace
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    handle!.failNextRefresh()

    await act(async () =>
      handle!.emitActivity({
        id: "receipt-2",
        type: "agent-ready",
        agentId: "agent-sora",
        threadId: creatorSession.threadId,
        occurredAt: FIXTURE_NOW.toISOString(),
      })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent catalog refresh failed"
    )
    expect(
      screen.getByRole("button", { name: /^New Agent, draft/ })
    ).toHaveAttribute("aria-current", "true")
  })

  it("retires the draft and explains an Agent that still needs operator setup", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!

    await act(async () =>
      workspace!.failAgentSetup(creatorSession.threadId, "agent-sora", "Sora")
    )

    expect(await screen.findByText(en.creator.createdHidden)).toBeVisible()
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^New Agent, draft/ })
      ).toBeNull()
    )
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()
    await waitFor(() =>
      expect(window.location.pathname).not.toContain("draft%3A")
    )
  })

  it("ignores a creation receipt from a Session the creator does not own", async () => {
    let handle: CreatorReceiptHandle | undefined
    render(
      <CreatorReceiptFixture
        capture={(value) => {
          handle = value
        }}
      />
    )
    await screen.findByRole("button", { name: /^Aster,/ })
    const before = handle!.refreshCalls()

    await act(async () =>
      handle!.emitActivity({
        id: "receipt-1",
        type: "agent-ready",
        agentId: "agent-sora",
        threadId: "thread-aster-market",
        occurredAt: FIXTURE_NOW.toISOString(),
      })
    )

    expect(handle!.refreshCalls()).toBe(before)
    expect(screen.queryByText(en.creator.createdPending)).toBeNull()
    expect(screen.getByRole("button", { name: /^Aster,/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
  })

  it("shows no draft after a reload of an interview that already created its Agent", async () => {
    const user = userEvent.setup()
    let workspace: FixtureWorkspace | undefined
    render(
      <BuilderLifecycleFixture
        captureWorkspace={(value) => {
          workspace = value
        }}
      />
    )
    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    const creatorSession = workspace!
      .listAllSessionMetadata()
      .find(({ agentId }) => agentId === "agent-builder")!
    await act(async () =>
      workspace!.completeAgentCreation(creatorSession.threadId, {
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^New Agent, draft/ })
      ).toBeNull()
    )

    cleanup()
    window.history.replaceState({}, "", "/")
    render(
      <CreatorFixtureAosUiApp
        locale="en"
        workspace={workspace}
        initialThreadId={creatorSession.threadId}
      />
    )

    await screen.findByRole("button", { name: /^Sora/ })
    expect(
      screen.queryByRole("button", { name: /^New Agent, draft/ })
    ).toBeNull()
  })

  it("refreshes the Agent catalog only after provider-signaled Builder completion", async () => {
    const user = userEvent.setup()
    let completeBuilder: () => void = () => undefined
    render(
      <BuilderSignalFixture
        captureCatalogEvent={(event) => {
          completeBuilder = event.complete
        }}
      />
    )

    await user.click(await screen.findByRole("button", { name: "New Agent" }))
    await screen.findByRole("button", { name: /^New Agent, draft/ })
    expect(screen.queryByRole("button", { name: "Sora" })).toBeNull()

    await act(async () => completeBuilder())

    expect(
      await screen.findByRole("button", { name: /^Sora/ })
    ).toBeInTheDocument()
  })

  it("surfaces provider errors from Agent catalog completion signals", async () => {
    let failCatalog: (error: Error) => void = () => undefined
    render(
      <BuilderSignalFixture
        captureCatalogEvent={(event) => {
          failCatalog = event.fail
        }}
      />
    )

    await screen.findAllByText("Aster")
    act(() => failCatalog(new Error("Agent catalog signal failed")))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent catalog signal failed"
    )
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

  it("hides the selected Agent from its row and moves on", async () => {
    const user = userEvent.setup()
    render(<FixtureAosUiApp locale="en" dictionary={en} />)
    const selected = await screen.findByRole("button", {
      name: /Selected Agent/,
    })
    const name = (selected.getAttribute("aria-label") ?? "").split(",")[0]

    fireEvent.contextMenu(selected, { clientX: 16, clientY: 24 })
    await user.click(
      await screen.findByRole("menuitem", { name: en.actions.hideAgent })
    )

    // Hiding deletes nothing, so the row simply leaves and another Agent leads.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: new RegExp(`^${name}\\b`) })
      ).toBeNull()
    )
    const next = await screen.findByRole("button", { name: /Selected Agent/ })
    expect(next.getAttribute("aria-label")).not.toContain(name)
    expect(screen.queryByRole("alert")).toBeNull()
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

function ScopedArtifactWorkspace({
  bundle,
  capture,
}: {
  bundle: WorkspaceFixtureRuntime
  capture: (bundle: WorkspaceFixtureRuntime) => void
}) {
  useEffect(() => capture(bundle), [bundle, capture])
  return (
    <AosUiWorkspace
      runtime={asHarnessRuntime(bundle)}
      locale="en"
      dictionary={en}
      now={FIXTURE_NOW}
    />
  )
}

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
