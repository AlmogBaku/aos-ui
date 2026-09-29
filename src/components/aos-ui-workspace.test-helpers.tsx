import { useLayoutEffect, useMemo, useState, type ReactNode } from "react"
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type {
  HarnessRuntime,
  SessionMetadata,
  WorkspaceActivityEvent,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import { isDraftAgentId } from "@/runtime-adapters/draft-agents"
import {
  createFixtureChatModel,
  FixtureThreadListAdapter,
  useFixtureRuntimeBundle,
  type FixtureRuntimeBundleOptions,
} from "@/runtime-adapters/fixture/fixture-runtime"
import {
  FIXTURE_NOW,
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "@/runtime-adapters/fixture/fixture-workspace"

import { type WorkspaceFixtureRuntime } from "./test-utils/controlled-workspace-fixture"
import { useWorkspaceNavigation } from "./workspace/use-workspace-navigation"
import { AosUiWorkspace } from "./aos-ui-workspace"

// The one module the split AosUiWorkspace suites reach fixture internals
// through; the runtime-boundary rule exempts exactly this file.

/** What a test hands both the workspace and its navigation hook. */
export type TestRuntime = WorkspaceFixtureRuntime &
  Pick<HarnessRuntime, "createSessionDraft">

export type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>

type Locale = "en" | "he"

type ClockOptions = {
  locale?: Locale
  now?: Date
  /** Defaults to the system clock, as the workspace itself does. */
  readNow?: () => Date
}

export function asHarnessRuntime(runtime: TestRuntime): HarnessRuntime {
  return {
    assistantRuntime: runtime.assistantRuntime,
    workspace: runtime.workspace,
    createSessionDraft: runtime.createSessionDraft,
    artifacts: runtime.artifacts ? { resolver: runtime.artifacts } : undefined,
    activityCoverage: "workspace",
  }
}

/** Resets the route and local preferences around every test in a suite. */
export function resetWorkspaceBetweenTests() {
  beforeEach(() => {
    window.history.replaceState({}, "", "/")
    window.localStorage.clear()
  })
  afterEach(cleanup)
}

/**
 * Renders `useRuntime` once as the root, so a re-render below it never re-runs
 * the runtime hook, the way the app owns its runtime above the workspace.
 */
function renderRuntime<Runtime>(
  useRuntime: () => Runtime,
  View: (props: { runtime: Runtime }) => ReactNode
) {
  const latest: { runtime?: Runtime } = {}
  function Root() {
    const runtime = useRuntime()
    useLayoutEffect(() => {
      latest.runtime = runtime
    })
    return <View runtime={runtime} />
  }
  const view = render(<Root />)
  return {
    get runtime() {
      return latest.runtime!
    },
    rerender: () => view.rerender(<Root />),
  }
}

/** Mounts the full workspace over the runtime `useRuntime` builds. */
export function renderWorkspace<Runtime extends TestRuntime>(
  useRuntime: () => Runtime,
  { locale = "en", now = FIXTURE_NOW, readNow }: ClockOptions = {}
) {
  return renderRuntime(useRuntime, ({ runtime }) => (
    <AosUiWorkspace
      runtime={asHarnessRuntime(runtime)}
      locale={locale}
      dictionary={locale === "he" ? he : en}
      now={now}
      readNow={readNow}
    />
  ))
}

/**
 * Runs only the workspace's navigation hook over the runtime `useRuntime`
 * builds, with the thread runtime mounted but no workspace UI.
 */
export function renderNavigation<Runtime extends TestRuntime>(
  useRuntime: () => Runtime,
  {
    locale = "en",
    now = FIXTURE_NOW,
    readNow = () => new Date(),
  }: ClockOptions = {}
) {
  const latest: { nav?: WorkspaceNavigation } = {}
  function Navigation({ runtime }: { runtime: Runtime }) {
    const nav = useWorkspaceNavigation({
      bundle: runtime,
      locale,
      dictionary: locale === "he" ? he : en,
      now,
      readNow,
    })
    useLayoutEffect(() => {
      latest.nav = nav
    })
    return (
      <AssistantRuntimeProvider runtime={runtime.assistantRuntime}>
        {null}
      </AssistantRuntimeProvider>
    )
  }
  const rendered = renderRuntime(useRuntime, Navigation)
  return {
    get nav() {
      return latest.nav!
    },
    get runtime() {
      return rendered.runtime
    },
    rerender: rendered.rerender,
  }
}

/** The ids of the Session tabs navigation shows. */
export const openTabIds = (nav: WorkspaceNavigation) =>
  nav.shellOpenSessions.map(({ sessionId }) => sessionId)

/**
 * The thread the workspace would render from this navigation state, or null
 * while it shows its loading state or the empty roster instead.
 */
export const renderedConversation = (nav: WorkspaceNavigation) =>
  !nav.agentsLoading && nav.selectedAgent ? nav.conversationThreadId : null

/** The creator-interview rows navigation adds to the Agent roster. */
export const draftAgents = (nav: WorkspaceNavigation) =>
  nav.displayAgents.filter(({ id }) => isDraftAgentId(id))

/** The public fixture runtime, starting on Aster's running Session. */
export function useFixtureBundle({
  initialThreadId = "thread-aster-market",
  ...options
}: Omit<FixtureRuntimeBundleOptions, "sessionId" | "onThreadIdChange"> & {
  initialThreadId?: string
} = {}) {
  const [sessionId, setThreadId] = useState<string | undefined>(initialThreadId)
  return useFixtureRuntimeBundle({
    ...options,
    sessionId,
    onThreadIdChange: setThreadId,
  })
}

/** Opens a New Session as a local draft thread, after an optional gate. */
export function registeredDraftRuntime(
  bundle: WorkspaceFixtureRuntime,
  beforeDraftSelection?: () => Promise<void>
): TestRuntime {
  return {
    ...bundle,
    createSessionDraft: async () => {
      await beforeDraftSelection?.()
      await bundle.assistantRuntime.threads.switchToNewThread()
      return bundle.assistantRuntime.threads.getState().mainThreadId
    },
  }
}

class DraftPromotingThreadListAdapter extends FixtureThreadListAdapter {
  promotedThreadId: string | null = null

  override async initialize(sessionId: string) {
    const [existing] = await this.workspace.getSessionMetadata([sessionId])
    if (existing) return super.initialize(sessionId)
    const created = await this.workspace.createSession("agent-aster", {
      title: "New Session",
    })
    this.promotedThreadId = created.sessionId
    return { remoteId: created.sessionId, externalId: created.sessionId }
  }
}

/** Promotes a draft to a Session its metadata does not list yet. */
export function useDraftPromotionRaceRuntime(): TestRuntime {
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
    const getSessionMetadata = async (sessionIds: string[]) =>
      (await workspace.getSessionMetadata(sessionIds)).filter(
        ({ sessionId }) => sessionId !== threadList.promotedThreadId
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
        sessionIds: readonly string[],
        listener: Parameters<
          NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
        >[1]
      ) {
        let active = true
        queueMicrotask(() => {
          void getSessionMetadata([...sessionIds]).then((metadata) => {
            if (active) listener(metadata)
          })
        })
        return () => {
          active = false
        }
      },
    } satisfies WorkspaceAdapter
  }, [threadList, workspace])
  return useMemo(
    () => ({
      assistantRuntime,
      workspace: filteredWorkspace,
      createSessionDraft: async () => {
        await assistantRuntime.threads.switchToNewThread()
        return assistantRuntime.threads.getState().mainThreadId
      },
    }),
    [assistantRuntime, filteredWorkspace]
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
        sessionId: "thread-aster-market",
        agentId: "agent-aster",
        updatedAt: FIXTURE_NOW.toISOString(),
        status: "idle",
      },
      {
        sessionId: "interview-thread",
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

/** The Session the creator interview runs in, once the provider has one. */
export const interviewSession = (workspace: FixtureWorkspace) =>
  workspace
    .listAllSessionMetadata()
    .find(({ agentId }) => agentId === "agent-builder")

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

  override async initialize(sessionId: string) {
    const owner = this.#owners.get(sessionId)
    if (!owner) return super.initialize(sessionId)
    await this.firstTurn
    const { sessionId: remoteId } = await this.workspace.createSession(owner)
    return { remoteId, externalId: remoteId }
  }
}

export function usePendingInterviewRuntime(firstTurn: Promise<void>) {
  const [workspace] = useState(() =>
    createFixtureWorkspace({
      clock: () => FIXTURE_NOW,
      agents: [{ kind: "ready", id: "agent-aster", name: "Aster" }],
      sessions: [
        {
          sessionId: "thread-aster-market",
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
  return useMemo(
    () => ({
      assistantRuntime,
      workspace,
      createSessionDraft: async (agentId: string) => {
        await assistantRuntime.threads.switchToNewThread()
        const draftId = assistantRuntime.threads.getState().mainThreadId
        threadList.record(draftId, agentId)
        return draftId
      },
    }),
    [assistantRuntime, threadList, workspace]
  )
}

type CatalogOptions = {
  empty?: boolean
  readOnly?: boolean
  creatorFirst?: boolean
  creatorOnly?: boolean
  agentGate?: Promise<void>
}

/** The public fixture's catalog, shaped the way a real runtime could list it. */
export function useCatalogRuntime({
  empty = false,
  readOnly = false,
  creatorFirst = false,
  creatorOnly = false,
  agentGate,
}: CatalogOptions = {}): TestRuntime {
  const fixture = useFixtureBundle()
  const agentCreator = fixture.workspace.agentCreator!
  const workspace = useMemo(() => {
    // The roster and the management catalog are one read, as on a real
    // runtime; each option shapes that read.
    const catalog = async () => {
      await agentGate
      if (empty) return []
      const entries = (await fixture.workspace.listAgentCatalog())
        .filter(({ summary }) => !readOnly || summary.role !== "creator")
        .map((entry) =>
          entry.summary.role === "creator"
            ? entry
            : { ...entry, editable: !readOnly }
        )
      const isCreator = ({ summary }: (typeof entries)[number]) =>
        summary.id === agentCreator.id
      if (creatorOnly) return entries.filter(isCreator)
      return creatorFirst
        ? [
            ...entries.filter(isCreator),
            ...entries.filter((e) => !isCreator(e)),
          ]
        : entries
    }
    return workspaceFacade(fixture.workspace, {
      listAgents: async () =>
        (await catalog()).map(({ summary, visibility }) => ({
          ...summary,
          visibility,
        })),
      listAgentCatalog: catalog,
      updateAgent: (id, patch) => fixture.workspace.updateAgent(id, patch),
    })
  }, [
    creatorFirst,
    creatorOnly,
    agentGate,
    agentCreator,
    empty,
    fixture.workspace,
    readOnly,
  ])
  return { assistantRuntime: fixture.assistantRuntime, workspace }
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
    getSessionMetadata: (sessionIds) =>
      workspace.getSessionMetadata(sessionIds),
    createSession: (agentId, options) =>
      workspace.createSession(agentId, options),
    ...(workspace.subscribeTodos
      ? {
          subscribeTodos: (
            sessionId: string,
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeTodos"]>
            >[1],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeTodos"]>
            >[2]
          ) => workspace.subscribeTodos!(sessionId, listener, onError),
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
            sessionIds: readonly string[],
            listener: Parameters<
              NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
            >[1],
            onError?: Parameters<
              NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
            >[2]
          ) =>
            workspace.subscribeSessionMetadata!(sessionIds, listener, onError),
        }
      : {}),
    ...overrides,
  }
}

/** Holds Session metadata reads while `hold` is pending. */
export function useGatedMetadataRuntime(
  seed: FixtureWorkspace,
  hold: () => Promise<void>
): TestRuntime {
  const fixture = useFixtureBundle({ testOnly: { workspace: seed } })
  return useMemo(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: workspaceFacade(fixture.workspace, {
        getSessionMetadata: async (sessionIds) => {
          await hold()
          return fixture.workspace.getSessionMetadata(sessionIds)
        },
      }),
    }),
    [fixture.assistantRuntime, fixture.workspace, hold]
  )
}

// Each provider below keeps its test-driven state in a holder from `useState`
// and wraps the fixture in a module function, since only callbacks, never
// render, touch that state.

type CatalogSignal = { complete: () => void; fail: (error: Error) => void }
type BuilderSignalProvider = { completed: boolean; signal?: CatalogSignal }

/**
 * A provider whose catalog lists Sora only after its catalog signal reports
 * Builder completion; `signal` is live once navigation subscribes.
 */
export function useBuilderSignalRuntime() {
  const [provider] = useState<BuilderSignalProvider>(() => ({
    completed: false,
  }))
  const fixture = useFixtureBundle()
  return useMemo(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: builderSignalWorkspace(fixture.workspace, provider),
      provider,
    }),
    [fixture.assistantRuntime, fixture.workspace, provider]
  )
}

function builderSignalWorkspace(
  base: FixtureWorkspace,
  provider: BuilderSignalProvider
) {
  return workspaceFacade(base, {
    refreshAgents: async () => [
      ...(await base.listAgents()),
      ...(provider.completed
        ? [
            {
              kind: "ready" as const,
              id: "agent-sora",
              name: "Sora",
              description: "Customer insight",
              status: "idle" as const,
            },
          ]
        : []),
    ],
    subscribeAgentCatalog: (listener, onError) => {
      provider.signal = {
        complete: () => {
          provider.completed = true
          listener()
        },
        fail: (error) => onError?.(error),
      }
      return () => undefined
    },
  })
}

export type CreatedAgentHandle = {
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

/**
 * The public fixture with a catalog that hides Sora from the first `hideFor`
 * refreshes, and a handle to its Activity feed and refresh count.
 */
export function useCreatedAgentRuntime({ hideFor = 0 } = {}) {
  const fixture = useFixtureBundle()
  const [state] = useState<CreatedAgentState>(() => ({
    refreshCalls: 0,
    failNextRefresh: false,
    listeners: new Set(),
  }))
  return useMemo(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: createdAgentWorkspace(fixture.workspace, state, hideFor),
      provider: fixture.workspace,
      handle: createdAgentHandle(state),
    }),
    [fixture.assistantRuntime, fixture.workspace, hideFor, state]
  )
}

function createdAgentWorkspace(
  provider: FixtureWorkspace,
  state: CreatedAgentState,
  hideFor: number
) {
  return workspaceFacade(provider, {
    refreshAgents: async () => {
      state.refreshCalls += 1
      if (state.failNextRefresh) {
        state.failNextRefresh = false
        throw new Error("Agent catalog refresh failed")
      }
      const agents = await provider.listAgents()
      return state.refreshCalls <= hideFor
        ? agents.filter(({ id }) => id !== "agent-sora")
        : agents
    },
    subscribeActivity: (listener, onError) => {
      state.listeners.add(listener)
      const unsubscribe = provider.subscribeActivity(listener, onError)
      return () => {
        state.listeners.delete(listener)
        unsubscribe()
      }
    },
  })
}

function createdAgentHandle(state: CreatedAgentState): CreatedAgentHandle {
  return {
    emitActivity: (event) => {
      for (const listener of state.listeners) listener(event)
    },
    refreshCalls: () => state.refreshCalls,
    failNextRefresh: () => {
      state.failNextRefresh = true
    },
  }
}

/** The public fixture plus an Agent with no Sessions, and no creator. */
export function useEmptyAgentRuntime(
  createSession?: WorkspaceAdapter["createSession"]
): TestRuntime {
  const fixture = useFixtureBundle()
  return useMemo(() => {
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
}

type StaleTodos = { emit: () => void }

/**
 * Todos from a provider that keeps delivering to Market brief after
 * unsubscription; `stale.emit` sends that delayed event.
 */
export function useStaleTodoRuntime() {
  const [stale] = useState<StaleTodos>(() => ({ emit: () => {} }))
  const fixture = useFixtureBundle()
  return useMemo(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: staleTodoWorkspace(fixture.workspace, stale),
      stale,
    }),
    [fixture.assistantRuntime, fixture.workspace, stale]
  )
}

function staleTodoWorkspace(base: FixtureWorkspace, stale: StaleTodos) {
  return workspaceFacade(base, {
    subscribeTodos: (subscribedThreadId, listener) => {
      if (subscribedThreadId === "thread-aster-market") {
        listener([{ id: "old", label: "Old Agent task", status: "active" }])
        stale.emit = () =>
          listener([
            { id: "late", label: "Leaked delayed task", status: "failed" },
          ])
      } else {
        listener([])
      }
      // Deliberately misbehave like a provider that delivers a queued event
      // after unsubscription. The surface must still isolate the old Session.
      return () => undefined
    },
  })
}

type MetadataSignal = {
  publish: (metadata: SessionMetadata[]) => void
  fail: (error: Error) => void
}
type MetadataFeed = { signal?: MetadataSignal }

/**
 * Session metadata driven by the test: `signal` is live once navigation
 * subscribes, and `initialMetadata` replaces the first fetch when given.
 */
export function useSessionMetadataSignalRuntime(
  initialMetadata?: Promise<SessionMetadata[]>
) {
  const [feed] = useState<MetadataFeed>(() => ({}))
  const fixture = useFixtureBundle()
  return useMemo(
    () => ({
      assistantRuntime: fixture.assistantRuntime,
      workspace: metadataSignalWorkspace(
        fixture.workspace,
        feed,
        initialMetadata
      ),
      feed,
    }),
    [feed, fixture.assistantRuntime, fixture.workspace, initialMetadata]
  )
}

function metadataSignalWorkspace(
  base: FixtureWorkspace,
  feed: MetadataFeed,
  initialMetadata?: Promise<SessionMetadata[]>
) {
  return workspaceFacade(base, {
    ...(initialMetadata ? { getSessionMetadata: () => initialMetadata } : {}),
    subscribeSessionMetadata: (_sessionIds, listener, onError) => {
      feed.signal = {
        publish: listener,
        fail: (error) => onError?.(error),
      }
      return () => undefined
    },
  })
}

export { FixtureAosUiApp } from "@/runtime-adapters/fixture/composition"
export { FixtureThreadListAdapter } from "@/runtime-adapters/fixture/fixture-runtime"
export {
  FIXTURE_NOW,
  type FixtureWorkspace,
  fixtureSessions,
} from "@/runtime-adapters/fixture/fixture-workspace"
