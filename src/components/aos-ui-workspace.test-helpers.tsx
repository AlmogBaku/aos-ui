import { useEffect, useMemo, useState } from "react"
import {
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type {
  HarnessRuntime,
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
} from "@/runtime-adapters/fixture/fixture-workspace"

import {
  ControlledWorkspaceFixture,
  type WorkspaceFixtureRuntime,
} from "./test-utils/controlled-workspace-fixture"
import { AosUiWorkspace } from "./aos-ui-workspace"

// The one module the split AosUiWorkspace suites reach fixture internals
// through; the runtime-boundary rule exempts exactly this file.

const fixtureClock = () => FIXTURE_NOW

export function asHarnessRuntime(
  bundle: WorkspaceFixtureRuntime
): HarnessRuntime {
  return {
    assistantRuntime: bundle.assistantRuntime,
    workspace: bundle.workspace,
    artifacts: bundle.artifacts ? { resolver: bundle.artifacts } : undefined,
    activityCoverage: "workspace",
  }
}

export function RegisteredDraftWorkspace({
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

export function DraftPromotionRaceWorkspace({
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

export function TabFixture({
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

export function CreatorFixtureAosUiApp({
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
export function interviewWorkspace(interviewAgeMs: number) {
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

export function PendingInterviewFixture({
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

export function CatalogFixture({
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
                  avatarEditable: !readOnly,
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

export function deferred<T>() {
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

export function GatedMetadataCreatorFixture({
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

export function BuilderSignalFixture({
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

export type CreatedAgentHandle = {
  workspace: FixtureWorkspace
  emitActivity: (event: WorkspaceActivityEvent) => void
  refreshCalls: () => number
  /** Makes the next catalog refresh fail the way a transport failure does. */
  failNextRefresh: () => void
}

type CreatedAgentState = {
  refreshCalls: number
  failNextRefresh: boolean
  listeners: Set<(event: WorkspaceActivityEvent) => void>
}

/** Hides the created Agent from the first `hideFor` catalog refreshes. */
function createdAgentWorkspace(
  workspace: FixtureWorkspace,
  state: CreatedAgentState,
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

export function CreatedAgentFixture({
  capture,
  hideFor = 0,
  hiddenAgentId = "agent-sora",
}: {
  capture: (handle: CreatedAgentHandle) => void
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
  const [state] = useState<CreatedAgentState>(() => ({
    refreshCalls: 0,
    failNextRefresh: false,
    listeners: new Set(),
  }))
  const bundle = useMemo<WorkspaceFixtureRuntime>(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: createdAgentWorkspace(
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

export function BuilderLifecycleFixture({
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

export function EmptyAgentFixture({
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

export function StaleTodoFixture({
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

export function SessionMetadataSignalFixture({
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

export function ClockBoundaryFixture({ readNow }: { readNow: () => Date }) {
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

export function ScopedArtifactWorkspace({
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

export { FixtureAosUiApp } from "@/runtime-adapters/fixture/composition"
export {
  FixtureThreadListAdapter,
  useFixtureRuntimeBundle,
} from "@/runtime-adapters/fixture/fixture-runtime"
export {
  FIXTURE_NOW,
  type FixtureWorkspace,
  fixtureSessions,
} from "@/runtime-adapters/fixture/fixture-workspace"
