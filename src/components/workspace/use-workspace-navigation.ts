import { useWorkspaceCatalog } from "./use-workspace-catalog"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useLocation, useNavigate } from "react-router"
import type { AssistantRuntime } from "@assistant-ui/react"
import type {
  HarnessRuntime,
  SessionMetadata,
  TodoItem,
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
import { switchToAosDraft } from "@/runtime-adapters/aos"

const emptySessions: SessionMetadata[] = []
const emptyTodos: TodoItem[] = []
const MAX_TIMEOUT_MS = 2_147_483_647

function readBrowserPathname() {
  return window.location.pathname
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

/** Coordinates URL selection and provider-owned Session metadata, never messages. */
export function useWorkspaceNavigation({
  bundle,
  locale,
  dictionary,
  now,
  readNow,
}: {
  bundle: Pick<HarnessRuntime, "assistantRuntime" | "workspace">
  locale: Locale
  dictionary: Dictionary
  now: Date
  readNow: () => Date
}) {
  const { assistantRuntime: runtime, workspace } = bundle
  const location = useLocation()
  const navigate = useNavigate()
  const pathname = location.pathname || "/"
  const threadState = useThreadListState(runtime)
  const [sessionSnapshot, setSessionSnapshot] = useState<SessionSnapshot>({
    key: "",
    sessions: [],
    error: null,
  })
  const [preferredAgentId, setPreferredAgentId] = useState<string | null>(null)
  const [manuallyOpened, setManuallyOpened] = useState<
    Record<string, string[]>
  >({})
  const [dismissedTabs, setDismissedTabs] = useState<Record<string, string[]>>(
    {}
  )
  const tabUndo = useSessionTabUndo()
  const [actionError, setActionError] = useState<Error | null>(null)
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
  const lastSelected = useRef(new Map<string, string | null>())
  const desiredThread = useRef<string | null>(null)
  const localDraftAgent = useRef<string | null>(null)
  const localDraftId = useRef<string | null>(null)
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
  const defaultAgentId = agents.find(isRosterAgent)?.id ?? null
  const selectedAgentId = agents.some(({ id }) => id === preferredAgentId)
    ? preferredAgentId
    : defaultAgentId

  const runtimeThreads = useMemo(() => {
    return threadState.threadIds.map((threadId) => {
      const item = threadState.threadItems[threadId]
      return {
        threadId: item?.remoteId ?? item?.externalId ?? threadId,
        title: item?.title?.trim() || dictionary.actions.newSession,
      }
    })
  }, [
    dictionary.actions.newSession,
    threadState.threadIds,
    threadState.threadItems,
  ])
  const runtimeThreadIds = useMemo(
    () => runtimeThreads.map(({ threadId }) => threadId),
    [runtimeThreads]
  )
  const sessionQueryKey = `${refreshKey}:${runtimeThreadIds.join("\u001f")}`
  const sessionSnapshotIsCurrent = sessionSnapshot.key === sessionQueryKey
  const sessions = sessionSnapshotIsCurrent
    ? sessionSnapshot.sessions
    : emptySessions
  const sessionError = sessionSnapshotIsCurrent ? sessionSnapshot.error : null
  const sessionsLoading =
    threadState.isLoading ||
    (runtimeThreadIds.length > 0 && !sessionSnapshotIsCurrent)
  const titles = useMemo(
    () =>
      new Map(runtimeThreads.map(({ threadId, title }) => [threadId, title])),
    [runtimeThreads]
  )
  const mainItem = threadState.threadItems[threadState.mainThreadId]
  const mainItemId = mainItem?.id
  const activeThreadId =
    mainItem?.remoteId ??
    mainItem?.externalId ??
    (sessions.some(({ threadId }) => threadId === threadState.mainThreadId)
      ? threadState.mainThreadId
      : null)
  const visibleThreadId =
    activeThreadId &&
    sessions.some(
      (session) =>
        session.threadId === activeThreadId &&
        session.agentId === selectedAgentId
    )
      ? activeThreadId
      : null

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
    const boundary = nextSessionEligibilityBoundary(sessions, eligibilityNow)
    if (boundary === null) return

    const delay = Math.min(
      Math.max(0, boundary - readNow().getTime()),
      MAX_TIMEOUT_MS
    )
    const timeout = window.setTimeout(() => {
      setClockSnapshot({ seedMs: initialNowMs, current: readNow() })
    }, delay)

    return () => window.clearTimeout(timeout)
  }, [eligibilityNow, initialNowMs, readNow, sessions])

  const selectRuntimeThread = useCallback(
    async (threadId: string) => {
      localDraftAgent.current = null
      localDraftId.current = null
      const operation = Symbol("selection")
      pendingSelection.current = operation
      desiredThread.current = threadId
      try {
        await runtime.threads.switchToThread(threadId)
        const latestDesired = desiredThread.current
        if (latestDesired && latestDesired !== threadId) {
          await runtime.threads.switchToThread(latestDesired)
        }
      } finally {
        if (pendingSelection.current === operation)
          pendingSelection.current = null
      }
    },
    [runtime]
  )
  const switchToNewThread = useCallback(
    async (agentId: string) => {
      localDraftAgent.current = agentId
      try {
        const draftId = await switchToAosDraft(runtime, agentId)
        if (draftId) {
          localDraftId.current = draftId
          return true
        }
        await runtime.threads.switchToNewThread()
        localDraftId.current = runtime.threads.getState().mainThreadId
        return false
      } catch (error) {
        if (localDraftAgent.current === agentId) {
          localDraftAgent.current = null
          localDraftId.current = null
        }
        throw error
      }
    },
    [runtime]
  )

  useEffect(() => {
    const agentId = localDraftAgent.current
    if (
      !agentId ||
      !activeThreadId ||
      mainItemId !== localDraftId.current
    )
      return
    localDraftAgent.current = null
    localDraftId.current = null
    setPreferredAgentId(agentId)
    setManuallyOpened((current) => ({
      ...current,
      [agentId]: [...new Set([...(current[agentId] ?? []), activeThreadId])],
    }))
    lastSelected.current.set(agentId, activeThreadId)
    updateRoute({ agentId, sessionId: activeThreadId }, "replace")
  }, [activeThreadId, mainItemId, updateRoute])

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
          runtimeThreadIds,
          publish,
          publishError
        )
      } catch (reason) {
        queueMicrotask(() => publishError(reason))
      }
    }

    const loadGeneration = ++generation
    void workspace
      .getSessionMetadata(runtimeThreadIds)
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
  }, [runtimeThreadIds, sessionQueryKey, threadState.isLoading, workspace])

  useEffect(() => {
    if (readBrowserPathname() !== pathname) return
    if (agentsLoading || threadState.isLoading || sessionsLoading) return
    const draftAgentId = localDraftAgent.current
    if (draftAgentId && !activeThreadId) {
      if (selectedAgentId !== draftAgentId)
        setPreferredAgentId(draftAgentId)
      lastSelected.current.set(draftAgentId, null)
      const selection = { agentId: draftAgentId, sessionId: null }
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
        ? agents.find(({ id }) => id === requested.agentId)
        : undefined
      const agentId = requestedAgent?.id ?? defaultAgentId
      if (!agentId) {
        routeTransitionPathname.current = null
        appliedPathname.current = pathname
        return
      }

      const exactSession = requested?.sessionId
        ? sessions.find(
            ({ agentId: ownerId, threadId }) =>
              ownerId === agentId && threadId === requested.sessionId
          )
        : undefined
      const threadId =
        exactSession?.threadId ??
        resolveSessionSelection({
          agentId,
          sessions,
          activeSessions: [],
        })
      setPreferredAgentId(agentId)
      if (threadId) {
        setDismissedTabs((current) => ({
          ...current,
          [agentId]: (current[agentId] ?? []).filter(
            (candidate) => candidate !== threadId
          ),
        }))
        setManuallyOpened((current) => ({
          ...current,
          [agentId]: [...new Set([...(current[agentId] ?? []), threadId])],
        }))
      }
      lastSelected.current.set(agentId, threadId)
      const selection = { agentId, sessionId: threadId }
      const canonicalPathname = buildWorkspacePathname(selection)
      const select = threadId
        ? selectRuntimeThread(threadId)
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
      ? sessions.find(({ threadId }) => threadId === activeThreadId)
      : undefined
    const manual = new Set([...(manuallyOpened[selectedAgentId] ?? [])])
    const dismissed = new Set(dismissedTabs[selectedAgentId] ?? [])
    const openSessions = buildAgentSessionView({
      agentId: selectedAgentId,
      sessions,
      manuallyOpenedThreadIds: manual,
      titles,
      now: eligibilityNow,
      untitledLabel: dictionary.actions.newSession,
    }).openSessions.filter(({ threadId }) => !dismissed.has(threadId))
    if (
      selectedSession?.agentId === selectedAgentId &&
      !dismissed.has(selectedSession.threadId)
    ) {
      if (
        !openSessions.some(
          ({ threadId }) => threadId === selectedSession.threadId
        ) &&
        !lastSelected.current.has(selectedAgentId)
      ) {
        setManuallyOpened((current) => ({
          ...current,
          [selectedAgentId]: [
            ...new Set([
              ...(current[selectedAgentId] ?? []),
              selectedSession.threadId,
            ]),
          ],
        }))
      }
      lastSelected.current.set(selectedAgentId, selectedSession.threadId)
      return
    }

    const nextThread =
      openSessions.length === 0 &&
      lastSelected.current.get(selectedAgentId) === null
        ? null
        : resolveSessionSelection({
            agentId: selectedAgentId,
            sessions: sessions.filter(
              ({ threadId }) => !dismissed.has(threadId)
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
    agents,
    agentsLoading,
    dictionary.actions.newSession,
    defaultAgentId,
    dismissedTabs,
    manuallyOpened,
    eligibilityNow,
    selectRuntimeThread,
    selectedAgentId,
    sessions,
    sessionsLoading,
    threadState.isLoading,
    titles,
    runtime,
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
      queueMicrotask(() => {
        if (active) {
          setTodoSnapshot({
            key: subscriptionKey,
            todos: [],
            error: toError(reason),
          })
        }
      })
      return () => {
        active = false
      }
    }
  }, [todoSubscriptionKey, visibleThreadId, workspace])

  const todoQueryKey = `${visibleThreadId ?? ""}:${todoSubscriptionKey}`
  const todoSnapshotIsCurrent = todoSnapshot.key === todoQueryKey
  const todos = todoSnapshotIsCurrent ? todoSnapshot.todos : emptyTodos
  const todoError = todoSnapshotIsCurrent ? todoSnapshot.error : null

  const displayAgents = agents.map((agent) => ({
    ...agent,
    status: agentStatusFromSessions(agent, sessions),
  }))
  const selectedAgent =
    displayAgents.find((agent) => agent.id === selectedAgentId) ?? null
  const selectedDismissedTabs = new Set(
    selectedAgentId ? (dismissedTabs[selectedAgentId] ?? []) : []
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
      })
    : { openSessions: [], allSessions: [] }
  const sessionView = {
    ...rawSessionView,
    openSessions: rawSessionView.openSessions.filter(
      ({ threadId }) => !selectedDismissedTabs.has(threadId)
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
    dismissedTabs,
    lastSelected: lastSelected.current,
    titles,
    now: eligibilityNow,
    untitledLabel: dictionary.actions.newSession,
    visibleThreadId,
  })

  async function selectAgent(agentId: string) {
    setPreferredAgentId(agentId)
    const manual = new Set([...(manuallyOpened[agentId] ?? [])])
    const dismissed = new Set(dismissedTabs[agentId] ?? [])
    const rawView = buildAgentSessionView({
      agentId,
      sessions,
      manuallyOpenedThreadIds: manual,
      titles,
      now: eligibilityNow,
      untitledLabel: dictionary.actions.newSession,
    })
    const view = {
      ...rawView,
      openSessions: rawView.openSessions.filter(
        ({ threadId }) => !dismissed.has(threadId)
      ),
    }
    const threadId =
      view.openSessions.length === 0 &&
      lastSelected.current.get(agentId) === null
        ? null
        : resolveSessionSelection({
            agentId,
            sessions: sessions.filter(
              (session) =>
                session.agentId === agentId && !dismissed.has(session.threadId)
            ),
            activeSessions: view.openSessions,
            lastSelectedThreadId: dismissed.has(
              lastSelected.current.get(agentId) ?? ""
            )
              ? undefined
              : lastSelected.current.get(agentId),
          })
    if (!threadId) {
      desiredThread.current = null
      updateRoute({ agentId, sessionId: null }, "push")
      await switchToNewThread(agentId)
      return
    }
    if (!view.openSessions.some((session) => session.threadId === threadId)) {
      setManuallyOpened((current) => ({
        ...current,
        [agentId]: [...new Set([...(current[agentId] ?? []), threadId])],
      }))
    }
    updateRoute({ agentId, sessionId: threadId }, "push")
    await selectRuntimeThread(threadId)
  }

  async function openSession(threadId: string, verifiedAgentId?: string) {
    const session =
      sessions.find((item) => item.threadId === threadId) ??
      (verifiedAgentId ? { threadId, agentId: verifiedAgentId } : undefined)
    if (!session) throw new Error(`Session not found: ${threadId}`)
    if (session.agentId !== selectedAgentId)
      setPreferredAgentId(session.agentId)
    setDismissedTabs((current) => ({
      ...current,
      [session.agentId]: (current[session.agentId] ?? []).filter(
        (candidate) => candidate !== threadId
      ),
    }))
    setManuallyOpened((current) => ({
      ...current,
      [session.agentId]: [
        ...new Set([...(current[session.agentId] ?? []), threadId]),
      ],
    }))
    lastSelected.current.set(session.agentId, threadId)
    updateRoute({ agentId: session.agentId, sessionId: threadId }, "push")
    await selectRuntimeThread(threadId)
  }

  async function closeSession(threadId: string, verifiedAgentId?: string) {
    const metadata = sessions.find((session) => session.threadId === threadId)
    const agentId = metadata?.agentId ?? verifiedAgentId
    const closed = agentId
      ? navigationCatalog
          .get(agentId)
          ?.openSessions.find((session) => session.threadId === threadId)
      : undefined
    if (!agentId || !closed?.canClose) return
    const selectionChanged =
      agentId === selectedAgentId && threadId === activeThreadId
    const previousLastSelectedThreadId = lastSelected.current.get(agentId)
    const clearedLastSelected = previousLastSelectedThreadId === threadId
    tabUndo.remember({
      agentId,
      threadId,
      title: closed.title,
      selectedThreadId: selectionChanged ? activeThreadId : null,
      selectionChanged,
      previousLastSelectedThreadId,
      clearedLastSelected,
    })
    setDismissedTabs((current) => ({
      ...current,
      [agentId]: [...new Set([...(current[agentId] ?? []), threadId])],
    }))
    setManuallyOpened((current) => ({
      ...current,
      [agentId]: (current[agentId] ?? []).filter(
        (candidate) => candidate !== threadId
      ),
    }))
    if (clearedLastSelected) {
      lastSelected.current.delete(agentId)
    }
    if (!selectionChanged) return
    const next = neighborAfterClose(
      sessionView.openSessions.map((session) => session.threadId),
      threadId,
      activeThreadId
    )
    if (next) {
      lastSelected.current.set(agentId, next)
      updateRoute({ agentId, sessionId: next }, "replace")
      await selectRuntimeThread(next)
    } else {
      lastSelected.current.set(agentId, null)
      desiredThread.current = null
      updateRoute({ agentId, sessionId: null }, "replace")
      await switchToNewThread(agentId)
    }
  }

  async function undoCloseSession() {
    const closed = tabUndo.take()
    if (!closed || !agents.some(({ id }) => id === closed.agentId)) return
    setDismissedTabs((current) => ({
      ...current,
      [closed.agentId]: (current[closed.agentId] ?? []).filter(
        (id) => id !== closed.threadId
      ),
    }))
    setManuallyOpened((current) => ({
      ...current,
      [closed.agentId]: [
        ...new Set([...(current[closed.agentId] ?? []), closed.threadId]),
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
    await workspace.getSessionMetadata([created.threadId])
    setManuallyOpened((current) => ({
      ...current,
      [agentId]: [...new Set([...(current[agentId] ?? []), created.threadId])],
    }))
    lastSelected.current.set(agentId, created.threadId)
    await runtime.threads.reload()
    updateRoute({ agentId, sessionId: created.threadId }, "push")
    await selectRuntimeThread(created.threadId)
  }

  async function openAgentBuilder() {
    const creator = getAgentCreator(agents)
    if (!creator)
      throw new Error("Agent creation is unavailable from this provider")
    const { threadId } = await workspace.createSession(creator.id, {
      title: dictionary.actions.newAgent,
    })
    await runtime.threads.reload()
    const [nextAgents, metadata] = await Promise.all([
      workspace.refreshAgents(),
      workspace.getSessionMetadata([threadId]),
    ])
    if (metadata[0]?.agentId !== creator.id) {
      throw new Error(
        "Agent creation did not confirm creator Session ownership"
      )
    }
    setAgents(nextAgents)
    setPreferredAgentId(creator.id)
    setManuallyOpened((current) => ({
      ...current,
      [creator.id]: [...new Set([...(current[creator.id] ?? []), threadId])],
    }))
    lastSelected.current.set(creator.id, threadId)
    updateRoute({ agentId: creator.id, sessionId: threadId }, "push")
    await selectRuntimeThread(threadId)
    // A newer navigation may have won while the asynchronous switch completed.
    // Never submit the interview to whichever unrelated Session is now selected.
    const selected = runtime.threads.getState()
    const item = selected.threadItems[selected.mainThreadId]
    if (
      (item?.remoteId ?? item?.externalId ?? selected.mainThreadId) !== threadId
    ) {
      throw new Error(
        "Creator Session selection changed before the interview started"
      )
    }
    runtime.thread.append({
      role: "user",
      content: [
        {
          type: "text",
          text:
            locale === "he"
              ? "בוא ניצור סוכן חדש."
              : "Let's create a new Agent.",
        },
      ],
    })
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
      desiredThread.current = null
      await runtime.threads.switchToNewThread()
    }
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
    displayAgents,
    shellOpenSessions,
    sessionView,
    navigationCatalog,
    selectedAgentId,
    visibleThreadId,
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
    setPreferredAgentId,
    selectAgent,
    openSession,
    closeSession,
    undoCloseSession,
    createSession,
    openAgentBuilder,
    refreshAfterVisibilityChange,
    retryWorkspace,
  }
}
