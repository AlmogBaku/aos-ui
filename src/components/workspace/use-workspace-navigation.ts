import { useWorkspaceCatalog } from "./use-workspace-catalog"
import { useAvatarAllocation } from "./use-avatar-allocation"
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useLocation, useNavigate } from "react-router"
import type { AssistantRuntime } from "@assistant-ui/react"
import {
  resolveAgentIcons,
  visibilityPatch,
} from "@/components/agent-icons/allocation"
import type {
  HarnessRuntime,
  SessionActionCapabilities,
  SessionMetadata,
  TodoItem,
  WorkspaceActivityEvent,
} from "@/runtime-adapters/contracts"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { Locale } from "@/lib/i18n/config"
import {
  nextSessionEligibilityBoundary,
  resolveSessionSelection,
} from "@/runtime-adapters/session-policy"
import {
  buildAgentSessionView,
  agentStatusFromSessions,
  agentUnreadFromSessions,
} from "@/lib/workspace-view-model"
import {
  buildWorkspacePathname,
  parseWorkspacePathname,
  workspaceHref,
  type WorkspaceSelection,
} from "@/lib/workspace-routing"
import {
  neighborAfterClose,
  restoreBackgroundLastSelected,
  useSessionTabUndo,
} from "./session-tab-undo"
import { buildWorkspaceNavigationCatalog } from "./workspace-navigation-catalog"
import {
  getAgentCreator,
  isRosterAgent,
} from "@/runtime-adapters/agent-identity"
import {
  draftAgentId,
  draftSessionId,
  isDraftAgentId,
  nextDraftExpiry,
  PENDING_DRAFT_AGENT_ID,
  projectDraftAgents,
  readResolvedDrafts,
  writeResolvedDrafts,
} from "@/runtime-adapters/draft-agents"

const emptySessions: SessionMetadata[] = []
const emptyTodos: TodoItem[] = []
const MAX_TIMEOUT_MS = 2_147_483_647
/** A created Agent can reach the native catalog a moment after its receipt. */
const CREATED_AGENT_CATALOG_RETRY_MS = 1_000

const noSessionActions: SessionActionCapabilities = {
  rename: false,
  archive: false,
  delete: false,
  pin: false,
}

/**
 * Assistant UI refuses to archive or unarchive a thread whose local status
 * already disagrees with the request. Reloading the list settles which side is
 * stale, so that one error is worth a single retry.
 */
function isThreadStatusError(reason: unknown) {
  return reason instanceof Error && reason.message.includes("has status")
}

function readBrowserPathname() {
  return window.location.pathname
}

function readStoredResolvedDrafts(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set()
  try {
    return readResolvedDrafts(window.localStorage)
  } catch {
    return new Set()
  }
}

function storeResolvedDraft(sessionId: string) {
  if (typeof window === "undefined") return
  try {
    const stored = readResolvedDrafts(window.localStorage)
    stored.add(sessionId)
    writeResolvedDrafts(window.localStorage, stored)
  } catch {
    // Without storage a reload rebuilds the draft; the roster still wins.
  }
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
}

function useThreadListState(runtime: AssistantRuntime) {
  const subscribe = useCallback(
    (listener: () => void) => runtime.threads.subscribe(listener),
    [runtime]
  )
  const getSnapshot = useCallback(() => runtime.threads.getState(), [runtime])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * A Map that reports each real change, so render can read a copy while
 * handlers and effects keep reading and writing the live Map synchronously.
 */
class ReportingMap<K, V> extends Map<K, V> {
  constructor(private readonly onChange: (current: ReadonlyMap<K, V>) => void) {
    super()
  }

  override set(key: K, value: V) {
    if (this.has(key) && this.get(key) === value) return this
    super.set(key, value)
    this.onChange(new Map(this))
    return this
  }

  override delete(key: K) {
    if (!super.delete(key)) return false
    this.onChange(new Map(this))
    return true
  }
}

type SessionSnapshot = {
  key: string
  sessions: SessionMetadata[]
  error: Error | null
}

type TodoSnapshot = {
  key: string
  todos: TodoItem[]
  error: Error | null
}

type ConversationDraftSelection = {
  agentId: string
  sessionId: string | null
}

/** Coordinates URL selection and provider-owned Session metadata, never messages. */
export function useWorkspaceNavigation({
  bundle,
  locale,
  dictionary,
  now,
  readNow,
}: {
  bundle: Pick<
    HarnessRuntime,
    "assistantRuntime" | "workspace" | "createSessionDraft"
  >
  locale: Locale
  dictionary: Dictionary
  now: Date
  readNow: () => Date
}) {
  const { assistantRuntime: runtime, workspace, createSessionDraft } = bundle
  const location = useLocation()
  const navigate = useNavigate()
  const pathname = location.pathname || "/"
  const threadState = useThreadListState(runtime)
  const [sessionSnapshot, setSessionSnapshot] = useState<SessionSnapshot>({
    key: "",
    sessions: [],
    error: null,
  })
  // A deep link names its Agent before the route applies, so History scopes
  // that Agent's catalog first instead of the default Agent's.
  const [preferredAgentId, setPreferredAgentId] = useState<string | null>(
    () => parseWorkspacePathname(pathname)?.agentId ?? null
  )
  const [resolvedDrafts, setResolvedDrafts] = useState<ReadonlySet<string>>(
    readStoredResolvedDrafts
  )
  const [creatorNotice, setCreatorNotice] = useState<string | undefined>(
    undefined
  )
  const noticeOutlivesRoute = useRef(false)
  const [manuallyOpened, setManuallyOpened] = useState<
    Record<string, string[]>
  >({})
  const [dismissedTabs, setDismissedTabs] = useState<Record<string, string[]>>(
    {}
  )
  // A pinned tab can still be closed, but only until its Session is next
  // active. Remembering the `updatedAt` each dismissal saw is what dates it.
  const [pinnedDismissedAt, setPinnedDismissedAt] = useState<
    Readonly<Record<string, string>>
  >({})
  const tabUndo = useSessionTabUndo()
  const [actionError, setActionError] = useState<Error | null>(null)
  // null until the runtime has answered; every action stays hidden meanwhile.
  const [sessionActions, setSessionActions] =
    useState<SessionActionCapabilities | null>(null)
  const reconciledDisagreement = useRef<string | null>(null)
  const [catalogSessionIds, setCatalogSessionIds] = useState<readonly string[]>(
    []
  )
  const [todoSnapshot, setTodoSnapshot] = useState<TodoSnapshot>({
    key: "",
    todos: [],
    error: null,
  })
  const [todoSubscriptionKey, setTodoSubscriptionKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const {
    agents,
    setAgents,
    avatarEditableIds,
    reloadCatalog,
    agentsLoading,
    setAgentsLoading,
    agentError: catalogError,
    setAgentError,
  } = useWorkspaceCatalog(workspace, refreshKey)
  const initialNowMs = now.getTime()
  const [clockSnapshot, setClockSnapshot] = useState(() => ({
    seedMs: initialNowMs,
    current: now,
  }))
  const eligibilityNow =
    clockSnapshot.seedMs === initialNowMs ? clockSnapshot.current : now
  // null remembers an intentionally empty tab strip; undefined permits initial history fallback.
  // Render reads `lastSelectedView`, the copy the Map reports on each change.
  const [lastSelectedView, setLastSelectedView] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map())
  const lastSelected = useRef(
    new ReportingMap<string, string | null>(setLastSelectedView)
  )
  const desiredThread = useRef<string | null>(null)
  const localDraftAgent = useRef<string | null>(null)
  const localDraftId = useRef<string | null>(null)
  const localDraftRemoteId = useRef<string | null>(null)
  const localDraftOperation = useRef<symbol | null>(null)
  const [conversationDraft, setConversationDraft] =
    useState<ConversationDraftSelection | null>(null)
  const pendingSelection = useRef<symbol | null>(null)
  const appliedPathname = useRef<string | null>(null)
  const routeTransitionPathname = useRef<string | null>(null)
  const creators = agents.filter((agent) => agent.role === "creator")
  const agentCreator = creators.length === 1 ? creators[0] : undefined
  const agentError =
    catalogError ??
    (creators.length > 1
      ? new Error(
          locale === "he"
            ? "מוגדר יותר מסוכן יוצר אחד"
            : "Multiple creator Agents are configured"
        )
      : null)
  /**
   * The pending draft is the creator's own local thread while the operator is
   * on its row. An explicit creator route stays the creator's own Session.
   */
  // While the operator holds a creator interview, the preference already names
  // the row it wants: the sentinel until the interview has a Session, then that
  // Session's draft id. Projecting exactly that id keeps the row present across
  // promotion, so selection never falls back while Session metadata catches up.
  const pendingDraftAgentId =
    agentCreator &&
    conversationDraft?.agentId === agentCreator.id &&
    preferredAgentId !== null &&
    isDraftAgentId(preferredAgentId)
      ? preferredAgentId
      : undefined
  // Drafts are derived from the last published metadata rather than the current
  // query, so a selected draft survives a Session metadata refresh.
  const publishedSessions = sessionSnapshot.sessions
  // A draft is named by its interview's own title, so this keeps the title a
  // thread has, never the untitled fallback the Session lists show.
  const threadTitles = useMemo(
    () =>
      new Map(
        Object.values(threadState.threadItems).map((item) => [
          item.remoteId ?? item.externalId ?? item.id,
          item.title,
        ])
      ),
    [threadState.threadItems]
  )
  const draftProjection = useMemo(
    () =>
      projectDraftAgents({
        creator: agentCreator,
        agents,
        sessions: publishedSessions,
        resolvedThreadIds: resolvedDrafts,
        now: eligibilityNow.getTime(),
        name: dictionary.actions.newAgent,
        draftLabel: dictionary.creator.draftDescription,
        locale,
        titles: threadTitles,
        pendingDraftAgentId,
      }),
    [
      agentCreator,
      agents,
      pendingDraftAgentId,
      dictionary.actions.newAgent,
      dictionary.creator.draftDescription,
      eligibilityNow,
      locale,
      publishedSessions,
      resolvedDrafts,
      threadTitles,
    ]
  )
  // Icons resolve once per catalog, over the Agents the roster shows; every
  // place that draws an Agent reads the same resolution.
  const avatarInputs = useMemo(() => {
    const editable = new Set(avatarEditableIds)
    return agents.filter(isRosterAgent).map(({ id, avatar }) => ({
      id,
      avatar,
      avatarEditable: editable.has(id),
    }))
  }, [agents, avatarEditableIds])
  const agentIcons = useMemo(
    () => resolveAgentIcons(avatarInputs),
    [avatarInputs]
  )
  useAvatarAllocation({
    workspace,
    agents: avatarInputs,
    ready: !agentsLoading && !catalogError,
    onConflict: reloadCatalog,
  })
  const navigableAgents = draftProjection.agents
  const defaultAgentId = agents.find(isRosterAgent)?.id ?? null
  const selectedAgentId = navigableAgents.some(
    ({ id }) => id === preferredAgentId
  )
    ? preferredAgentId
    : defaultAgentId
  const selectedAgentIsDraft = selectedAgentId
    ? isDraftAgentId(selectedAgentId)
    : false
  // A draft row is only ever a projection of the creator, so the creator owns
  // everything the provider must answer for while such a row is selected.
  const selectedProviderAgentId = selectedAgentIsDraft
    ? agentCreator?.id
    : selectedAgentId

  const runtimeThreads = useMemo(() => {
    // Archived threads carry Session metadata and titles too, so the archived
    // list can name them.
    const ids = [
      ...new Set([...threadState.threadIds, ...threadState.archivedThreadIds]),
    ]
    return ids.map((sessionId) => {
      const item = threadState.threadItems[sessionId]
      return {
        sessionId: item?.remoteId ?? item?.externalId ?? sessionId,
        title: item?.title?.trim() || dictionary.actions.newSession,
        status: item?.status,
      }
    })
  }, [
    dictionary.actions.newSession,
    threadState.archivedThreadIds,
    threadState.threadIds,
    threadState.threadItems,
  ])
  const runtimeThreadIds = useMemo(
    () => runtimeThreads.map(({ sessionId }) => sessionId),
    [runtimeThreads]
  )
  const mainItem = threadState.threadItems[threadState.mainThreadId]
  const mainItemId = mainItem?.id
  const openSessionId = mainItem?.remoteId ?? mainItem?.externalId
  // A reload lists page one only, so a shown Session can drop out of the
  // thread list; its metadata is still read, so the conversation stays up.
  // One not shown yet waits for the list: mounting it sooner races its replay.
  const keepsOpenSession =
    openSessionId !== undefined &&
    !runtimeThreadIds.includes(openSessionId) &&
    sessionSnapshot.sessions.some(
      ({ sessionId }) => sessionId === openSessionId
    )
  const sessionQueryIds = useMemo(
    () =>
      keepsOpenSession && openSessionId
        ? [...runtimeThreadIds, openSessionId]
        : runtimeThreadIds,
    [keepsOpenSession, openSessionId, runtimeThreadIds]
  )
  const sessionQueryKey = `${refreshKey}:${sessionQueryIds.join("\u001f")}`
  const sessionSnapshotIsCurrent = sessionSnapshot.key === sessionQueryKey
  // While a changed list's metadata loads, the previous snapshot keeps the
  // rows still queried, so neither History nor the open conversation blanks.
  const sessions = useMemo(() => {
    if (sessionSnapshotIsCurrent) return draftProjection.sessions
    if (!sessionSnapshot.key.startsWith(`${refreshKey}:`)) return emptySessions
    const queried = new Set(sessionQueryIds)
    return draftProjection.sessions.filter(({ sessionId }) =>
      queried.has(sessionId)
    )
  }, [
    draftProjection.sessions,
    refreshKey,
    sessionQueryIds,
    sessionSnapshot.key,
    sessionSnapshotIsCurrent,
  ])
  const sessionError = sessionSnapshotIsCurrent ? sessionSnapshot.error : null
  const sessionsLoading =
    threadState.isLoading ||
    (sessionQueryIds.length > 0 && !sessionSnapshotIsCurrent)
  const titles = useMemo(
    () =>
      new Map(runtimeThreads.map(({ sessionId, title }) => [sessionId, title])),
    [runtimeThreads]
  )
  const activeThreadId =
    mainItem?.remoteId ??
    mainItem?.externalId ??
    (sessions.some(({ sessionId }) => sessionId === threadState.mainThreadId)
      ? threadState.mainThreadId
      : null)
  const visibleThreadId =
    activeThreadId &&
    sessions.some(
      (session) =>
        session.sessionId === activeThreadId &&
        session.agentId === selectedAgentId
    )
      ? activeThreadId
      : null
  const conversationThreadId = conversationDraft
    ? conversationDraft.agentId === selectedProviderAgentId &&
      conversationDraft.sessionId !== null &&
      mainItemId === conversationDraft.sessionId
      ? conversationDraft.sessionId
      : null
    : visibleThreadId
  // Automatic selection never lands on an archived Session, but the operator
  // may still be reading the one on screen.
  const listedSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.archived !== true || session.sessionId === visibleThreadId
      ),
    [sessions, visibleThreadId]
  )

  /**
   * Dismissals as the lists should read them now: a pinned Session's dismissal
   * expires as soon as the Session moves on, so its tab comes back when it is
   * next active. A dismissal nobody dated stays in force.
   */
  const liveDismissedTabs = useMemo(() => {
    const byThread = new Map(
      sessions.map((session) => [session.sessionId, session] as const)
    )
    return Object.fromEntries(
      Object.entries(dismissedTabs).map(([agentId, sessionIds]) => [
        agentId,
        sessionIds.filter((sessionId) => {
          const session = byThread.get(sessionId)
          if (session?.pinned !== true) return true
          const dismissedAt = pinnedDismissedAt[sessionId] ?? ""
          return !(Date.parse(session.updatedAt) > Date.parse(dismissedAt))
        }),
      ])
    )
  }, [dismissedTabs, pinnedDismissedAt, sessions])

  const updateRoute = useCallback(
    (selection: WorkspaceSelection, mode: "push" | "replace") => {
      const targetPathname = buildWorkspacePathname(selection)
      routeTransitionPathname.current = null
      appliedPathname.current = targetPathname
      const href = workspaceHref(window.location.href, selection)
      void navigate(href, { replace: mode === "replace" })
    },
    [navigate]
  )

  useEffect(() => {
    const boundary = Math.min(
      nextSessionEligibilityBoundary(sessions, eligibilityNow) ??
        Number.POSITIVE_INFINITY,
      nextDraftExpiry(
        publishedSessions,
        agentCreator?.id,
        eligibilityNow.getTime()
      ) ?? Number.POSITIVE_INFINITY
    )
    if (!Number.isFinite(boundary)) return

    const delay = Math.min(
      Math.max(0, boundary - readNow().getTime()),
      MAX_TIMEOUT_MS
    )
    const timeout = window.setTimeout(() => {
      setClockSnapshot({ seedMs: initialNowMs, current: readNow() })
    }, delay)

    return () => window.clearTimeout(timeout)
  }, [
    agentCreator?.id,
    eligibilityNow,
    initialNowMs,
    publishedSessions,
    readNow,
    sessions,
  ])

  // A notice belongs to the place it was raised, except when retiring a draft
  // moves the route itself: that explanation outlives its own navigation.
  useEffect(() => {
    if (noticeOutlivesRoute.current) noticeOutlivesRoute.current = false
    else setCreatorNotice(undefined)
  }, [pathname])

  const refreshAgentCatalog = useCallback(async () => {
    const next = await workspace.refreshAgents()
    setAgents(next)
    return next
  }, [setAgents, workspace])

  /** Forgets the open local draft, leaving provider-owned selection alone. */
  const clearLocalDraft = useCallback(() => {
    localDraftOperation.current = null
    localDraftAgent.current = null
    localDraftId.current = null
    localDraftRemoteId.current = null
    setConversationDraft(null)
  }, [])

  const selectRuntimeThread = useCallback(
    async (sessionId: string) => {
      clearLocalDraft()
      const operation = Symbol("selection")
      pendingSelection.current = operation
      desiredThread.current = sessionId
      const settle = () => {
        if (pendingSelection.current === operation)
          pendingSelection.current = null
      }
      const supersededBy = () => {
        const latestDesired = desiredThread.current
        return latestDesired && latestDesired !== sessionId
          ? latestDesired
          : null
      }
      // A catch-and-rethrow rather than `finally`, and no conditional
      // expression inside `try`: React Compiler cannot compile either yet.
      try {
        await runtime.threads.switchToThread(sessionId)
        const latestDesired = supersededBy()
        if (latestDesired) {
          await runtime.threads.switchToThread(latestDesired)
        }
      } catch (error) {
        settle()
        throw error
      }
      settle()
    },
    [clearLocalDraft, runtime]
  )
  const switchToNewThread = useCallback(
    async (agentId: string) => {
      const operation = Symbol("local-draft")
      localDraftOperation.current = operation
      localDraftAgent.current = agentId
      localDraftId.current = null
      localDraftRemoteId.current = null
      setConversationDraft({ agentId, sessionId: null })

      const publishDraft = (draftId: string) => {
        const state = runtime.threads.getState()
        const selectedItem = state.threadItems[state.mainThreadId]
        if (
          localDraftOperation.current !== operation ||
          localDraftAgent.current !== agentId ||
          (state.mainThreadId !== draftId && selectedItem?.id !== draftId)
        ) {
          return
        }
        localDraftId.current = draftId
        setConversationDraft({ agentId, sessionId: draftId })
      }

      // Outside `try`: React Compiler cannot compile optional chaining there.
      const createDraft = () => createSessionDraft?.(agentId)
      try {
        const draftId = await createDraft()
        if (draftId) {
          publishDraft(draftId)
          return true
        }
        await runtime.threads.switchToNewThread()
        publishDraft(runtime.threads.getState().mainThreadId)
        return false
      } catch (error) {
        if (localDraftOperation.current === operation) clearLocalDraft()
        throw error
      }
    },
    [clearLocalDraft, createSessionDraft, runtime]
  )

  useEffect(() => {
    const agentId = localDraftAgent.current
    if (!agentId || !activeThreadId || mainItemId !== localDraftId.current)
      return
    if (localDraftRemoteId.current === activeThreadId) return
    localDraftRemoteId.current = activeThreadId
    localDraftOperation.current = null
    // A promoted interview becomes the draft row that owns its new Session;
    // the creator itself is never a place the operator can be.
    const isInterview = agentId === agentCreator?.id
    const rowAgentId = isInterview ? draftAgentId(activeThreadId) : agentId
    // An interview started without a title would take its kickoff as one, so
    // its Session is named New Agent once, as soon as it exists.
    if (isInterview && mainItemId)
      void runtime.threads
        .getItemById(mainItemId)
        .rename(dictionary.actions.newAgent)
        .catch(() => undefined)
    setPreferredAgentId(rowAgentId)
    setManuallyOpened((current) => ({
      ...current,
      [rowAgentId]: [
        ...new Set([...(current[rowAgentId] ?? []), activeThreadId]),
      ],
    }))
    lastSelected.current.set(rowAgentId, activeThreadId)
    updateRoute({ agentId: rowAgentId, sessionId: activeThreadId }, "replace")
  }, [
    activeThreadId,
    agentCreator?.id,
    dictionary.actions.newAgent,
    mainItemId,
    runtime,
    updateRoute,
  ])

  useEffect(() => {
    if (
      !visibleThreadId ||
      activeThreadId !== visibleThreadId ||
      !localDraftId.current ||
      mainItemId !== localDraftId.current
    )
      return
    clearLocalDraft()
  }, [activeThreadId, clearLocalDraft, mainItemId, visibleThreadId])

  useEffect(() => {
    if (threadState.isLoading) return
    let active = true
    let generation = 0

    const publish = (metadata: SessionMetadata[]) => {
      if (!active) return
      generation += 1
      setSessionSnapshot({
        key: sessionQueryKey,
        sessions: metadata,
        error: null,
      })
    }
    const publishError = (reason: unknown) => {
      if (!active) return
      generation += 1
      setSessionSnapshot({
        key: sessionQueryKey,
        sessions: [],
        error: toError(reason),
      })
    }

    let unsubscribe: (() => void) | undefined
    if (workspace.subscribeSessionMetadata) {
      try {
        unsubscribe = workspace.subscribeSessionMetadata(
          sessionQueryIds,
          publish,
          publishError
        )
      } catch (reason) {
        // Bound outside the closure: React Compiler cannot capture a catch
        // parameter yet.
        const error = reason
        queueMicrotask(() => publishError(error))
      }
    }

    generation += 1
    const loadGeneration = generation
    void workspace
      .getSessionMetadata(sessionQueryIds)
      .then((metadata) => {
        if (active && generation === loadGeneration) {
          setSessionSnapshot({
            key: sessionQueryKey,
            sessions: metadata,
            error: null,
          })
        }
      })
      .catch((reason: unknown) => {
        if (active && generation === loadGeneration) {
          setSessionSnapshot({
            key: sessionQueryKey,
            sessions: [],
            error: toError(reason),
          })
        }
      })
    return () => {
      active = false
      generation += 1
      unsubscribe?.()
    }
  }, [sessionQueryIds, sessionQueryKey, threadState.isLoading, workspace])

  const scopedCatalogAgent = useRef<string | null>(null)
  /**
   * History pages one Agent's Sessions. Naming a different Agent reloads the
   * thread list, so its cursor, and "Load more" with it, is that Agent's.
   */
  const scopeSessionCatalog = useCallback(
    (agentId: string) => {
      if (!workspace.scopeSessionCatalog) return
      if (scopedCatalogAgent.current === agentId) return
      scopedCatalogAgent.current = agentId
      workspace.scopeSessionCatalog(agentId)
      void runtime.threads.reload().catch((reason: unknown) => {
        setActionError(toError(reason))
      })
    },
    [runtime, workspace]
  )

  useEffect(() => {
    if (selectedProviderAgentId) scopeSessionCatalog(selectedProviderAgentId)
  }, [scopeSessionCatalog, selectedProviderAgentId])

  useEffect(() => {
    if (readBrowserPathname() !== pathname) return
    if (agentsLoading || threadState.isLoading || sessionsLoading) return
    const localDraftAgentId = localDraftAgent.current
    if (localDraftAgentId && !activeThreadId) {
      // A pending draft keeps its own row; others keep their own Agent.
      const rowAgentId =
        preferredAgentId === PENDING_DRAFT_AGENT_ID
          ? PENDING_DRAFT_AGENT_ID
          : localDraftAgentId
      if (selectedAgentId !== rowAgentId) setPreferredAgentId(rowAgentId)
      lastSelected.current.set(localDraftAgentId, null)
      const selection = { agentId: rowAgentId, sessionId: null }
      const canonicalPathname = buildWorkspacePathname(selection)
      if (pathname !== canonicalPathname) updateRoute(selection, "replace")
      else appliedPathname.current = canonicalPathname
      return
    }
    if (appliedPathname.current !== pathname) {
      if (routeTransitionPathname.current === pathname) return
      routeTransitionPathname.current = pathname
      const requested = parseWorkspacePathname(pathname)
      const requestedAgent = requested?.agentId
        ? navigableAgents.find(({ id }) => id === requested.agentId)
        : undefined
      const agentId = requestedAgent?.id ?? defaultAgentId
      if (!agentId) {
        routeTransitionPathname.current = null
        appliedPathname.current = pathname
        return
      }

      const knownSession = requested?.sessionId
        ? sessions.find(({ sessionId }) => sessionId === requested.sessionId)
        : undefined
      // A Session the browser has not listed is known only to the URL: the
      // runtime resolves it from the provider's catalog, and one the catalog
      // cannot answer for normalizes below like any stale route.
      const unlistedSession =
        requested?.sessionId && !knownSession ? requested.sessionId : undefined
      const fallbackThreadId = resolveSessionSelection({
        agentId,
        sessions: listedSessions,
        activeSessions: [],
      })
      const sessionId =
        (knownSession?.agentId === agentId
          ? knownSession.sessionId
          : undefined) ??
        unlistedSession ??
        fallbackThreadId
      setPreferredAgentId(agentId)
      if (sessionId) {
        setDismissedTabs((current) => ({
          ...current,
          [agentId]: (current[agentId] ?? []).filter(
            (candidate) => candidate !== sessionId
          ),
        }))
        setManuallyOpened((current) => ({
          ...current,
          [agentId]: [...new Set([...(current[agentId] ?? []), sessionId])],
        }))
      }
      lastSelected.current.set(agentId, sessionId)
      // The runtime looks for an unlisted Session in its Agent's own catalog.
      if (unlistedSession) scopeSessionCatalog(agentId)
      const selection = { agentId, sessionId }
      const canonicalPathname = buildWorkspacePathname(selection)
      const select = sessionId
        ? selectRuntimeThread(sessionId)
        : switchToNewThread(agentId)
      void select
        .then(() => {
          if (routeTransitionPathname.current !== pathname) return
          routeTransitionPathname.current = null
          if (readBrowserPathname() !== pathname) return
          if (canonicalPathname !== pathname) {
            updateRoute(selection, "replace")
          } else {
            appliedPathname.current = canonicalPathname
          }
        })
        .catch((reason: unknown) => {
          if (routeTransitionPathname.current !== pathname) return
          routeTransitionPathname.current = null
          // A URL can name a Session the provider no longer has. Normalize to
          // what the Agent does have instead of stranding the operator.
          if (sessionId === unlistedSession) {
            updateRoute({ agentId, sessionId: fallbackThreadId }, "replace")
            return
          }
          setActionError(toError(reason))
        })
      return
    }
    if (!selectedAgentId) return
    if (localDraftAgent.current) return
    // Browser navigation can supersede an in-flight adapter switch. Only
    // automatic selection repair waits for that switch to settle.
    if (pendingSelection.current) return
    const selectedSession = activeThreadId
      ? sessions.find(({ sessionId }) => sessionId === activeThreadId)
      : undefined
    const manual = new Set([...(manuallyOpened[selectedAgentId] ?? [])])
    const dismissed = new Set(liveDismissedTabs[selectedAgentId] ?? [])
    const openSessions = buildAgentSessionView({
      agentId: selectedAgentId,
      sessions,
      manuallyOpenedThreadIds: manual,
      titles,
      now: eligibilityNow,
      untitledLabel: dictionary.actions.newSession,
      visibleThreadId,
    }).openSessions.filter(({ sessionId }) => !dismissed.has(sessionId))
    if (
      selectedSession?.agentId === selectedAgentId &&
      !dismissed.has(selectedSession.sessionId)
    ) {
      if (
        !openSessions.some(
          ({ sessionId }) => sessionId === selectedSession.sessionId
        ) &&
        !lastSelected.current.has(selectedAgentId)
      ) {
        setManuallyOpened((current) => ({
          ...current,
          [selectedAgentId]: [
            ...new Set([
              ...(current[selectedAgentId] ?? []),
              selectedSession.sessionId,
            ]),
          ],
        }))
      }
      lastSelected.current.set(selectedAgentId, selectedSession.sessionId)
      return
    }

    const nextThread =
      openSessions.length === 0 &&
      lastSelected.current.get(selectedAgentId) === null
        ? null
        : resolveSessionSelection({
            agentId: selectedAgentId,
            sessions: listedSessions.filter(
              ({ sessionId }) => !dismissed.has(sessionId)
            ),
            activeSessions: openSessions,
            lastSelectedThreadId: dismissed.has(
              lastSelected.current.get(selectedAgentId) ?? ""
            )
              ? undefined
              : lastSelected.current.get(selectedAgentId),
          })
    if (nextThread) {
      void selectRuntimeThread(nextThread).catch(setActionError)
    } else if (activeThreadId) {
      desiredThread.current = null
      void switchToNewThread(selectedAgentId).catch(setActionError)
    }
  }, [
    activeThreadId,
    preferredAgentId,
    navigableAgents,
    agentsLoading,
    dictionary.actions.newSession,
    defaultAgentId,
    liveDismissedTabs,
    listedSessions,
    manuallyOpened,
    eligibilityNow,
    visibleThreadId,
    selectRuntimeThread,
    selectedAgentId,
    sessions,
    sessionsLoading,
    threadState.isLoading,
    titles,
    runtime,
    scopeSessionCatalog,
    switchToNewThread,
    pathname,
    updateRoute,
  ])

  useEffect(() => {
    let active = true
    if (!visibleThreadId || !workspace.subscribeTodos) return

    const subscriptionKey = `${visibleThreadId}:${todoSubscriptionKey}`

    try {
      const unsubscribe = workspace.subscribeTodos(
        visibleThreadId,
        (nextTodos) => {
          if (active) {
            setTodoSnapshot({
              key: subscriptionKey,
              todos: nextTodos,
              error: null,
            })
          }
        },
        (reason) => {
          if (active) {
            setTodoSnapshot({
              key: subscriptionKey,
              todos: [],
              error: toError(reason),
            })
          }
        }
      )
      return () => {
        active = false
        unsubscribe()
      }
    } catch (reason) {
      // Bound outside the closure: React Compiler cannot capture a catch
      // parameter yet.
      const error = toError(reason)
      queueMicrotask(() => {
        if (active) {
          setTodoSnapshot({
            key: subscriptionKey,
            todos: [],
            error,
          })
        }
      })
      return () => {
        active = false
      }
    }
  }, [todoSubscriptionKey, visibleThreadId, workspace])

  // A runtime that declares nothing, or cannot answer, offers no Session
  // actions; the workspace itself stays usable either way.
  useEffect(() => {
    const read = workspace.sessionActionCapabilities
    if (!read) {
      setSessionActions(noSessionActions)
      return
    }
    let active = true
    setSessionActions(null)
    void read
      .call(workspace)
      .then((next) => {
        if (active) setSessionActions(next)
      })
      .catch(() => {
        if (active) setSessionActions(noSessionActions)
      })
    return () => {
      active = false
    }
  }, [refreshKey, workspace])

  useEffect(() => {
    if (!workspace.subscribeSessionCatalog) return
    return workspace.subscribeSessionCatalog(setCatalogSessionIds)
  }, [workspace])

  // Archival can change, and Sessions can appear, outside this browser. When
  // provider metadata or its catalog page disagrees with the loaded thread
  // list, one reload settles which of them is stale.
  useEffect(() => {
    if (threadState.isLoading) return
    const disagreeing = [
      ...runtimeThreads
        .filter(({ sessionId, status }) => {
          if (status !== "regular" && status !== "archived") return false
          const archived = sessions.find(
            (session) => session.sessionId === sessionId
          )?.archived
          return archived !== undefined && archived !== (status === "archived")
        })
        .map(({ sessionId }) => sessionId),
      ...catalogSessionIds.filter(
        (sessionId) => !runtimeThreadIds.includes(sessionId)
      ),
    ]
    if (disagreeing.length === 0) {
      reconciledDisagreement.current = null
      return
    }
    const key = disagreeing.join("\u001f")
    if (reconciledDisagreement.current === key) return
    reconciledDisagreement.current = key
    void runtime.threads.reload().catch((reason: unknown) => {
      setActionError(toError(reason))
    })
  }, [
    catalogSessionIds,
    runtime,
    runtimeThreadIds,
    runtimeThreads,
    sessions,
    threadState.isLoading,
  ])

  const todoQueryKey = `${visibleThreadId ?? ""}:${todoSubscriptionKey}`
  const todoSnapshotIsCurrent = todoSnapshot.key === todoQueryKey
  const todos = todoSnapshotIsCurrent ? todoSnapshot.todos : emptyTodos
  const todoError = todoSnapshotIsCurrent ? todoSnapshot.error : null

  const displayAgents = navigableAgents.map((agent) => ({
    ...agent,
    avatar: agentIcons.get(agent.id)?.token,
    status: agentStatusFromSessions(agent, sessions),
    unread: agentUnreadFromSessions(agent, sessions),
  }))
  const selectedAgent =
    displayAgents.find((agent) => agent.id === selectedAgentId) ?? null
  const selectedDismissedTabs = new Set(
    selectedAgentId ? (liveDismissedTabs[selectedAgentId] ?? []) : []
  )
  const rawSessionView = selectedAgentId
    ? buildAgentSessionView({
        agentId: selectedAgentId,
        sessions,
        manuallyOpenedThreadIds: new Set([
          ...(manuallyOpened[selectedAgentId] ?? []),
        ]),
        titles,
        now: eligibilityNow,
        untitledLabel: dictionary.actions.newSession,
        visibleThreadId,
      })
    : { openSessions: [], allSessions: [], archivedSessions: [] }
  const sessionView = {
    ...rawSessionView,
    openSessions: rawSessionView.openSessions.filter(
      ({ sessionId }) => !selectedDismissedTabs.has(sessionId)
    ),
  }
  const shellOpenSessions = sessionView.openSessions.map((session) => ({
    ...session,
    canClose: true,
  }))
  const navigationCatalog = buildWorkspaceNavigationCatalog({
    agentIds: displayAgents.map(({ id }) => id),
    sessions,
    manuallyOpened,
    dismissedTabs: liveDismissedTabs,
    lastSelected: lastSelectedView,
    titles,
    now: eligibilityNow,
    untitledLabel: dictionary.actions.newSession,
    visibleThreadId,
  })

  async function selectAgent(agentId: string) {
    // The pending draft owns no Session: reselecting it would replace the
    // interview it is showing with a second empty one.
    if (agentId === PENDING_DRAFT_AGENT_ID) return
    setPreferredAgentId(agentId)
    const manual = new Set([...(manuallyOpened[agentId] ?? [])])
    const dismissed = new Set(liveDismissedTabs[agentId] ?? [])
    const rawView = buildAgentSessionView({
      agentId,
      sessions,
      manuallyOpenedThreadIds: manual,
      titles,
      now: eligibilityNow,
      untitledLabel: dictionary.actions.newSession,
      visibleThreadId,
    })
    const view = {
      ...rawView,
      openSessions: rawView.openSessions.filter(
        ({ sessionId }) => !dismissed.has(sessionId)
      ),
    }
    const sessionId =
      view.openSessions.length === 0 &&
      lastSelected.current.get(agentId) === null
        ? null
        : resolveSessionSelection({
            agentId,
            sessions: listedSessions.filter(
              (session) =>
                session.agentId === agentId && !dismissed.has(session.sessionId)
            ),
            activeSessions: view.openSessions,
            lastSelectedThreadId: dismissed.has(
              lastSelected.current.get(agentId) ?? ""
            )
              ? undefined
              : lastSelected.current.get(agentId),
          })
    if (!sessionId) {
      desiredThread.current = null
      updateRoute({ agentId, sessionId: null }, "push")
      await switchToNewThread(agentId)
      return
    }
    if (!view.openSessions.some((session) => session.sessionId === sessionId)) {
      setManuallyOpened((current) => ({
        ...current,
        [agentId]: [...new Set([...(current[agentId] ?? []), sessionId])],
      }))
    }
    updateRoute({ agentId, sessionId }, "push")
    await selectRuntimeThread(sessionId)
  }

  /**
   * A created Agent is one the provider owns. The catalog decides when the
   * draft is done: until the created Agent is listed, the interview stays
   * exactly where the operator left it.
   */
  const acceptCreatedAgent = useEffectEvent(
    async (event: WorkspaceActivityEvent) => {
      const owner = publishedSessions.find(
        ({ sessionId }) => sessionId === event.sessionId
      )?.agentId
      if (!agentCreator || owner !== agentCreator.id) return
      let catalog = await refreshAgentCatalog()
      if (!catalog.some(({ id }) => id === event.agentId)) {
        await wait(CREATED_AGENT_CATALOG_RETRY_MS)
        catalog = await refreshAgentCatalog()
      }
      if (!catalog.some(({ id }) => id === event.agentId)) {
        setCreatorNotice(dictionary.creator.createdPending)
        return
      }
      setResolvedDrafts((current) =>
        current.has(event.sessionId)
          ? current
          : new Set(current).add(event.sessionId)
      )
      storeResolvedDraft(event.sessionId)
      if (event.type === "agent-activation-failed") {
        setCreatorNotice(dictionary.creator.createdHidden)
        // A retired draft keeps neither the selection nor the route it owned.
        if (
          selectedAgentId === draftAgentId(event.sessionId) &&
          defaultAgentId
        ) {
          noticeOutlivesRoute.current = true
          await selectAgent(defaultAgentId)
        }
        return
      }
      if (selectedAgentId !== draftAgentId(event.sessionId)) return
      // The created Agent owns no Session yet, and creation never invents one.
      lastSelected.current.set(event.agentId, null)
      setPreferredAgentId(event.agentId)
      updateRoute({ agentId: event.agentId, sessionId: null }, "replace")
    }
  )

  useEffect(() => {
    if (!workspace.subscribeActivity) return
    return workspace.subscribeActivity((event) => {
      if (
        event.type === "agent-ready" ||
        event.type === "agent-activation-failed"
      )
        void acceptCreatedAgent(event).catch((reason: unknown) =>
          setActionError(toError(reason))
        )
    })
  }, [workspace])

  async function openSession(sessionId: string, verifiedAgentId?: string) {
    const session =
      sessions.find((item) => item.sessionId === sessionId) ??
      (verifiedAgentId ? { sessionId, agentId: verifiedAgentId } : undefined)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.agentId !== selectedAgentId)
      setPreferredAgentId(session.agentId)
    setDismissedTabs((current) => ({
      ...current,
      [session.agentId]: (current[session.agentId] ?? []).filter(
        (candidate) => candidate !== sessionId
      ),
    }))
    setManuallyOpened((current) => ({
      ...current,
      [session.agentId]: [
        ...new Set([...(current[session.agentId] ?? []), sessionId]),
      ],
    }))
    lastSelected.current.set(session.agentId, sessionId)
    updateRoute({ agentId: session.agentId, sessionId }, "push")
    await selectRuntimeThread(sessionId)
  }

  /**
   * Moves selection off a Session the operator is leaving behind. Archival and
   * deletion run this before mutating, because Assistant UI would otherwise
   * strand the operator on an unrouted draft of its own choosing.
   */
  async function leaveSession(sessionId: string, agentId: string) {
    if (agentId !== selectedAgentId || sessionId !== activeThreadId) return
    const next = neighborAfterClose(
      sessionView.openSessions.map((session) => session.sessionId),
      sessionId,
      activeThreadId
    )
    if (next) {
      lastSelected.current.set(agentId, next)
      updateRoute({ agentId, sessionId: next }, "replace")
      await selectRuntimeThread(next)
      return
    }
    lastSelected.current.set(agentId, null)
    desiredThread.current = null
    updateRoute({ agentId, sessionId: null }, "replace")
    await switchToNewThread(agentId)
  }

  async function closeSession(sessionId: string, verifiedAgentId?: string) {
    const metadata = sessions.find((session) => session.sessionId === sessionId)
    const agentId = metadata?.agentId ?? verifiedAgentId
    const closed = agentId
      ? navigationCatalog
          .get(agentId)
          ?.openSessions.find((session) => session.sessionId === sessionId)
      : undefined
    if (!agentId || !closed?.canClose) return
    const selectionChanged =
      agentId === selectedAgentId && sessionId === activeThreadId
    const previousLastSelectedThreadId = lastSelected.current.get(agentId)
    const clearedLastSelected = previousLastSelectedThreadId === sessionId
    tabUndo.remember({
      agentId,
      sessionId,
      title: closed.title,
      selectedThreadId: selectionChanged ? activeThreadId : null,
      selectionChanged,
      previousLastSelectedThreadId,
      clearedLastSelected,
    })
    if (closed.pinned === true) {
      setPinnedDismissedAt((current) => ({
        ...current,
        [sessionId]: closed.updatedAt,
      }))
    }
    setDismissedTabs((current) => ({
      ...current,
      [agentId]: [...new Set([...(current[agentId] ?? []), sessionId])],
    }))
    setManuallyOpened((current) => ({
      ...current,
      [agentId]: (current[agentId] ?? []).filter(
        (candidate) => candidate !== sessionId
      ),
    }))
    if (clearedLastSelected) {
      lastSelected.current.delete(agentId)
    }
    await leaveSession(sessionId, agentId)
  }

  function owningAgentId(sessionId: string, verifiedAgentId?: string) {
    const agentId =
      sessions.find((session) => session.sessionId === sessionId)?.agentId ??
      verifiedAgentId
    if (!agentId) throw new Error(`Session not found: ${sessionId}`)
    return agentId
  }

  /**
   * Keeps tab bookkeeping in step with a Session that left the strip. `dismiss`
   * hides it while provider metadata catches up; `forget` drops every reference
   * to one that is gone or restored, so a stale id never holds a tab open.
   */
  function forgetTab(
    agentId: string,
    sessionId: string,
    mode: "dismiss" | "forget"
  ) {
    setDismissedTabs((current) => {
      const remaining = (current[agentId] ?? []).filter(
        (candidate) => candidate !== sessionId
      )
      return {
        ...current,
        [agentId]: mode === "dismiss" ? [...remaining, sessionId] : remaining,
      }
    })
    setManuallyOpened((current) => ({
      ...current,
      [agentId]: (current[agentId] ?? []).filter(
        (candidate) => candidate !== sessionId
      ),
    }))
    if (lastSelected.current.get(agentId) === sessionId) {
      lastSelected.current.delete(agentId)
    }
  }

  async function renameSession(sessionId: string, title: string) {
    await runtime.threads.getItemById(sessionId).rename(title)
  }

  async function setSessionPinned(sessionId: string, pinned: boolean) {
    if (!workspace.setSessionPinned)
      throw new Error("Pinning Sessions is unavailable from this provider")
    await workspace.setSessionPinned(sessionId, pinned)
  }

  async function archiveSession(sessionId: string, verifiedAgentId?: string) {
    const agentId = owningAgentId(sessionId, verifiedAgentId)
    await leaveSession(sessionId, agentId)
    forgetTab(agentId, sessionId, "dismiss")
    await runtime.threads.getItemById(sessionId).archive()
  }

  async function unarchiveSession(sessionId: string, verifiedAgentId?: string) {
    const agentId = owningAgentId(sessionId, verifiedAgentId)
    try {
      await runtime.threads.getItemById(sessionId).unarchive()
    } catch (reason) {
      if (!isThreadStatusError(reason)) throw reason
      await runtime.threads.reload()
      await runtime.threads.getItemById(sessionId).unarchive()
    }
    // Archiving dismissed the tab; restoring the Session lets it list again.
    forgetTab(agentId, sessionId, "forget")
  }

  async function deleteSession(sessionId: string, verifiedAgentId?: string) {
    const agentId = owningAgentId(sessionId, verifiedAgentId)
    await leaveSession(sessionId, agentId)
    await runtime.threads.getItemById(sessionId).delete()
    forgetTab(agentId, sessionId, "forget")
  }

  async function undoCloseSession() {
    const closed = tabUndo.take()
    if (!closed || !agents.some(({ id }) => id === closed.agentId)) return
    setDismissedTabs((current) => ({
      ...current,
      [closed.agentId]: (current[closed.agentId] ?? []).filter(
        (id) => id !== closed.sessionId
      ),
    }))
    setManuallyOpened((current) => ({
      ...current,
      [closed.agentId]: [
        ...new Set([...(current[closed.agentId] ?? []), closed.sessionId]),
      ],
    }))
    if (closed.selectionChanged === false) {
      restoreBackgroundLastSelected(lastSelected.current, closed)
      return
    }
    setPreferredAgentId(closed.agentId)
    if (closed.selectedThreadId) {
      lastSelected.current.set(closed.agentId, closed.selectedThreadId)
      updateRoute(
        { agentId: closed.agentId, sessionId: closed.selectedThreadId },
        "push"
      )
      await selectRuntimeThread(closed.selectedThreadId)
      requestAnimationFrame(() =>
        document
          .getElementById(
            `workspace-tab-${encodeURIComponent(closed.selectedThreadId!)}`
          )
          ?.focus()
      )
    }
  }

  async function createSession(agentId: string) {
    // A draft row is a projection of the creator, never an Agent a Session can
    // belong to, and its interview is the one Session it is allowed to own.
    if (isDraftAgentId(agentId)) return
    setPreferredAgentId(agentId)
    lastSelected.current.set(agentId, null)
    desiredThread.current = null
    updateRoute({ agentId, sessionId: null }, "push")
    if (await switchToNewThread(agentId)) {
      return
    }
    const created = await workspace.createSession(agentId, {
      title: dictionary.actions.newSession,
    })
    await workspace.getSessionMetadata([created.sessionId])
    setManuallyOpened((current) => ({
      ...current,
      [agentId]: [...new Set([...(current[agentId] ?? []), created.sessionId])],
    }))
    lastSelected.current.set(agentId, created.sessionId)
    await runtime.threads.reload()
    updateRoute({ agentId, sessionId: created.sessionId }, "push")
    await selectRuntimeThread(created.sessionId)
  }

  async function openAgentBuilder() {
    const creator = getAgentCreator(agents)
    if (!creator)
      throw new Error("Agent creation is unavailable from this provider")
    // A provider that owns Session creation only lists the interview once its
    // first turn persists it, so the interview opens as a creator-owned local
    // draft and the operator sees it as the pending draft Agent.
    setPreferredAgentId(PENDING_DRAFT_AGENT_ID)
    desiredThread.current = null
    updateRoute({ agentId: PENDING_DRAFT_AGENT_ID, sessionId: null }, "push")
    if (await switchToNewThread(creator.id)) {
      // Never submit the interview to whichever Session a newer navigation won.
      if (!localDraftId.current || localDraftAgent.current !== creator.id) {
        if (defaultAgentId) await selectAgent(defaultAgentId)
        throw new Error(
          "Creator Session selection changed before the interview started"
        )
      }
      runtime.thread.append({
        role: "user",
        content: [{ type: "text", text: dictionary.creator.kickoff }],
      })
      return
    }
    const { sessionId } = await workspace.createSession(creator.id, {
      title: dictionary.actions.newAgent,
    })
    await runtime.threads.reload()
    const [nextAgents, metadata] = await Promise.all([
      workspace.refreshAgents(),
      workspace.getSessionMetadata([sessionId]),
    ])
    if (metadata[0]?.agentId !== creator.id) {
      throw new Error(
        "Agent creation did not confirm creator Session ownership"
      )
    }
    setAgents(nextAgents)
    // The operator only ever sees the interview as its own draft Agent.
    const draftId = draftAgentId(sessionId)
    setPreferredAgentId(draftId)
    setManuallyOpened((current) => ({
      ...current,
      [draftId]: [...new Set([...(current[draftId] ?? []), sessionId])],
    }))
    lastSelected.current.set(draftId, sessionId)
    updateRoute({ agentId: draftId, sessionId }, "push")
    await selectRuntimeThread(sessionId)
    // A newer navigation may have won while the asynchronous switch completed.
    // Never submit the interview to whichever unrelated Session is now selected.
    const selected = runtime.threads.getState()
    const item = selected.threadItems[selected.mainThreadId]
    if (
      (item?.remoteId ?? item?.externalId ?? selected.mainThreadId) !==
      sessionId
    ) {
      throw new Error(
        "Creator Session selection changed before the interview started"
      )
    }
    runtime.thread.append({
      role: "user",
      content: [{ type: "text", text: dictionary.creator.kickoff }],
    })
  }

  /**
   * Deleting the interview Session is the only way to retire a draft that has
   * one; a pending draft has nothing to delete but its own local thread. The
   * row names itself, so any draft row can be discarded, not just the selected.
   */
  async function discardDraft(agentId: string) {
    if (!isDraftAgentId(agentId)) return
    const sessionId = draftSessionId(agentId)
    if (!sessionId) {
      clearLocalDraft()
      if (defaultAgentId) await selectAgent(defaultAgentId)
      return
    }
    // Leave the interview before deleting it. Deleting the open thread strands
    // Assistant UI on a draft of its own choosing, which locks the page up, so
    // this follows the same order archival and Session deletion already use.
    if (defaultAgentId) await selectAgent(defaultAgentId)
    else await runtime.threads.switchToNewThread()
    await runtime.threads.getItemById(sessionId).delete()
    forgetTab(agentId, sessionId, "forget")
  }

  async function refreshAfterVisibilityChange() {
    const nextAgents = await workspace.refreshAgents()
    setAgents(nextAgents)
    setPreferredAgentId((current) =>
      nextAgents.some((agent) => agent.id === current && isRosterAgent(agent))
        ? current
        : (nextAgents.find(isRosterAgent)?.id ?? null)
    )
    if (!nextAgents.some(isRosterAgent)) {
      clearLocalDraft()
      desiredThread.current = null
      await runtime.threads.switchToNewThread()
    }
  }

  /** The rail's way into the visibility rule Agent management already owns. */
  async function hideAgent(agentId: string) {
    if (!workspace.updateAgent)
      throw new Error("Agent visibility is unavailable from this provider")
    const editable = avatarInputs.some(
      (agent) => agent.id === agentId && agent.avatarEditable
    )
    await workspace.updateAgent(
      agentId,
      editable
        ? visibilityPatch("hidden", avatarInputs)
        : { visibility: "hidden" }
    )
    await refreshAfterVisibilityChange()
  }

  function retryWorkspace() {
    setAgentError(null)
    setActionError(null)
    setAgentsLoading(true)
    setRefreshKey((key) => key + 1)
    void runtime.threads.reload().catch((reason: unknown) => {
      setActionError(toError(reason))
    })
  }

  const retryTodos = useCallback(
    () => setTodoSubscriptionKey((key) => key + 1),
    []
  )

  return {
    agentCreator,
    creatorNotice,
    selectedAgentIsDraft,
    displayAgents,
    shellOpenSessions,
    sessionView,
    navigationCatalog,
    selectedAgentId,
    visibleThreadId,
    conversationThreadId,
    selectedAgent,
    agentsLoading,
    sessionsLoading,
    agentError,
    sessionError,
    actionError,
    setActionError,
    tabUndo,
    todos,
    todoError,
    retryTodos,
    sessions,
    titles,
    sessionActions,
    setPreferredAgentId,
    selectAgent,
    openSession,
    closeSession,
    undoCloseSession,
    renameSession,
    setSessionPinned,
    archiveSession,
    unarchiveSession,
    deleteSession,
    createSession,
    openAgentBuilder,
    discardDraft,
    hideAgent,
    refreshAfterVisibilityChange,
    retryWorkspace,
  }
}
