"use client"

import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  type AssistantRuntime,
  type Toolkit,
} from "@assistant-ui/react"
import {
  AlertCircle,
  Check,
  ChevronDown,
  Circle,
  LoaderCircle,
  RotateCw,
} from "lucide-react"
import { usePathname } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  Thread,
  type ThreadComponents,
  type ThreadLabels,
} from "@/components/assistant-ui/elements/thread.aui"
import { AssistantInstructions } from "@/components/assistant-instructions"
import { ToolUiLocaleProvider, RichToolRenderer } from "@/components/tool-ui"
import { Button } from "@/components/ui/button"
import { AgentGlyph, WorkspaceShell } from "@/components/workspace"
import { ManageAgents } from "@/components/workspace/manage-agents"
import {
  neighborAfterClose,
  useSessionTabUndo,
} from "@/components/workspace/session-tab-undo"
import { useActivityCoordinator } from "@/components/workspace/use-activity-coordinator"
import type { BrowserSettingsView } from "@/components/workspace/activity"
import type { BrowserNotificationPort } from "@/lib/notifications/browser-port"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type {
  AgentSummary,
  RuntimeBundle,
  SessionMetadata,
  TodoItem,
} from "@/lib/runtime-adapters/contracts"
import {
  nextSessionEligibilityBoundary,
  resolveSessionSelection,
} from "@/lib/runtime-adapters/session-policy"
import { getWorkspaceCapabilities } from "@/lib/runtime-adapters/workspace-state"
import { buildAgentSessionView } from "@/lib/workspace-view-model"
import {
  buildWorkspacePathname,
  parseWorkspacePathname,
  workspaceHref,
  type WorkspaceSelection,
} from "@/lib/workspace-routing"
import { cn } from "@/lib/utils"

const threadLabels: Record<Locale, ThreadLabels> = {
  en: {
    loadingConversation: "Loading conversation",
    scrollToBottom: "Scroll to bottom",
    welcome: "What would you like to work on?",
    composerPlaceholder: "Message your Agent…",
    messageInput: "Message input",
    voiceInput: "Voice input",
    startVoiceInput: "Start voice input",
    stopDictation: "Stop dictation",
    stopVoiceInput: "Stop voice input",
    sendMessage: "Send message",
    stopGenerating: "Stop generating",
    assistantWorking: "Agent is working",
    copy: "Copy",
    refresh: "Retry response",
    more: "More actions",
    exportMarkdown: "Export as Markdown",
    edit: "Edit message",
    cancel: "Cancel",
    update: "Update",
    historySearch: "Search conversation history",
    historySearchPlaceholder: "Filter sent messages…",
    historyCancel: "Cancel history search",
    resumeQueued: "Resume queued message",
    queuedMessages: "Queued messages",
    previous: "Previous branch",
    next: "Next branch",
    conversationHeading: "Conversation",
    attachments: {
      add: "Add attachment",
      remove: "Remove attachment",
      preview: "Attachment preview",
      image: "Image attachment",
      document: "Document attachment",
      file: "File attachment",
      uploading: "Uploading",
      uploadFailed: "Upload failed",
    },
  },
  he: {
    loadingConversation: "השיחה נטענת",
    scrollToBottom: "גלילה לתחתית",
    welcome: "על מה תרצו לעבוד?",
    composerPlaceholder: "שליחת הודעה לסוכן…",
    messageInput: "שדה הודעה",
    voiceInput: "קלט קולי",
    startVoiceInput: "התחלת קלט קולי",
    stopDictation: "עצירת הכתבה",
    stopVoiceInput: "עצירת קלט קולי",
    sendMessage: "שליחת הודעה",
    stopGenerating: "עצירת התשובה",
    assistantWorking: "הסוכן עובד",
    copy: "העתקה",
    refresh: "ניסיון חוזר",
    more: "פעולות נוספות",
    exportMarkdown: "ייצוא כ-Markdown",
    edit: "עריכת ההודעה",
    cancel: "ביטול",
    update: "עדכון",
    historySearch: "חיפוש בהיסטוריית השיחה",
    historySearchPlaceholder: "סינון הודעות שנשלחו…",
    historyCancel: "ביטול חיפוש בהיסטוריה",
    resumeQueued: "המשך הודעה בתור",
    queuedMessages: "הודעות בתור",
    previous: "הסתעפות קודמת",
    next: "הסתעפות הבאה",
    conversationHeading: "שיחה",
    attachments: {
      add: "הוספת קובץ מצורף",
      remove: "הסרת קובץ מצורף",
      preview: "תצוגה מקדימה של קובץ מצורף",
      image: "תמונה מצורפת",
      document: "מסמך מצורף",
      file: "קובץ מצורף",
      uploading: "בהעלאה",
      uploadFailed: "ההעלאה נכשלה",
    },
  },
}

const workspaceCopy = {
  en: {
    retry: "Try again",
    loading: "Loading workspace…",
    unavailable: "The workspace could not be loaded.",
    tasks: "Session todos.",
    tasksUnavailable: "Execution tasks are not available from this provider.",
    tasksFailed: "Todos could not be loaded.",
    taskSummary: (done: number, total: number) =>
      `${done} of ${total} session tasks complete`,
    active: "In progress",
    pending: "Pending",
    completed: "Completed",
    failed: "Failed",
  },
  he: {
    retry: "ניסיון חוזר",
    loading: "סביבת העבודה נטענת…",
    unavailable: "לא ניתן לטעון את סביבת העבודה.",
    tasks: "משימות השיחה",
    tasksUnavailable: "ספק זה אינו מציע משימות ביצוע.",
    tasksFailed: "לא ניתן לטעון את המשימות.",
    taskSummary: (done: number, total: number) =>
      `${done} מתוך ${total} משימות בשיחה הושלמו`,
    active: "בתהליך",
    pending: "ממתינה",
    completed: "הושלמה",
    failed: "נכשלה",
  },
} satisfies Record<Locale, Record<string, unknown>>

const emptySessions: SessionMetadata[] = []
const emptyTodos: TodoItem[] = []
const MAX_TIMEOUT_MS = 2_147_483_647

function readSystemClock() {
  return new Date()
}

function subscribeToHistory(listener: () => void) {
  window.addEventListener("popstate", listener)
  return () => window.removeEventListener("popstate", listener)
}

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

function TodoDock({
  locale,
  todos,
  supported,
  error,
  onRetry,
}: {
  locale: Locale
  todos: readonly TodoItem[]
  supported: boolean
  error: Error | null
  onRetry: () => void
}) {
  const copy = workspaceCopy[locale]
  const completed = todos.filter((todo) => todo.status === "completed").length
  const iconByStatus = {
    active: LoaderCircle,
    completed: Check,
    failed: AlertCircle,
    pending: Circle,
  } as const

  return (
    <details
      className="group rounded-2xl border border-border/80 bg-card/90 shadow-sm"
      data-slot="todo-dock"
      open={error ? true : undefined}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        <span className="font-medium">{copy.tasks}</span>
        {supported && todos.length > 0 ? (
          <span className="ms-auto text-xs text-muted-foreground">
            {copy.taskSummary(completed, todos.length)}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-border/70 px-4 py-3">
        {error ? (
          <div className="flex items-center justify-between gap-3" role="alert">
            <p className="text-sm text-muted-foreground">{copy.tasksFailed}</p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              <RotateCw data-icon="inline-start" />
              {copy.retry}
            </Button>
          </div>
        ) : !supported ? (
          <p className="text-sm text-muted-foreground">
            {copy.tasksUnavailable}
          </p>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {todos.map((todo) => {
              const Icon = iconByStatus[todo.status]
              const statusLabel = copy[todo.status]

              return (
                <li className="flex items-start gap-2.5 text-sm" key={todo.id}>
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-muted-foreground",
                      todo.status === "active" &&
                        "text-primary motion-safe:animate-spin",
                      todo.status === "completed" && "text-primary",
                      todo.status === "failed" && "text-destructive"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1" dir="auto">
                    {todo.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {statusLabel}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </details>
  )
}

function WorkspaceError({
  locale,
  error,
  onRetry,
}: {
  locale: Locale
  error: Error
  onRetry: () => void
}) {
  const copy = workspaceCopy[locale]
  return (
    <div
      className="absolute inset-x-4 top-4 z-20 mx-auto flex max-w-2xl items-start gap-3 rounded-2xl border border-destructive/40 bg-card p-4 shadow-lg"
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{copy.unavailable}</p>
        <p
          className="mt-1 line-clamp-2 text-xs text-muted-foreground"
          dir="auto"
        >
          {error.message}
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        <RotateCw data-icon="inline-start" />
        {copy.retry}
      </Button>
    </div>
  )
}

function AgentIdentity({ agent }: { agent: AgentSummary | null }) {
  if (!agent) return null

  return (
    <div className="mb-3 flex items-center gap-2 px-2 text-sm">
      <AgentGlyph
        agent={agent}
        className="!size-7 !rounded-lg [&_svg]:!size-3.5"
      />
      <bdi className="font-medium">{agent.name}</bdi>
    </div>
  )
}

type WorkspaceThreadChrome = {
  locale: Locale
  todos: readonly TodoItem[]
  todosSupported: boolean
  todoError: Error | null
  onRetryTodos: () => void
  selectedAgent: AgentSummary | null
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

const WorkspaceThreadChromeContext =
  createContext<WorkspaceThreadChrome | null>(null)

function SessionTodoDock() {
  const chrome = useContext(WorkspaceThreadChromeContext)
  if (
    !chrome ||
    (chrome.todosSupported && !chrome.todoError && chrome.todos.length === 0)
  ) {
    return null
  }

  return (
    <TodoDock
      locale={chrome.locale}
      todos={chrome.todos}
      supported={chrome.todosSupported}
      error={chrome.todoError}
      onRetry={chrome.onRetryTodos}
    />
  )
}

function SelectedAgentIdentity() {
  const chrome = useContext(WorkspaceThreadChromeContext)
  return <AgentIdentity agent={chrome?.selectedAgent ?? null} />
}

const threadComponents = {
  AssistantIdentity: SelectedAgentIdentity,
  BeforeComposer: SessionTodoDock,
  ToolFallback: RichToolRenderer,
}

function ConversationEmpty({
  dictionary,
  agent,
  onCreateSession,
  onActionError,
  onNewAgent,
  builderAvailable,
}: {
  dictionary: Dictionary
  agent: AgentSummary | null
  onCreateSession: (agentId: string) => Promise<void>
  onActionError: (error: unknown) => void
  onNewAgent: () => Promise<void>
  builderAvailable: boolean
}) {
  return (
    <div className="h-full overflow-y-auto px-6 text-center">
      <div className="mx-auto flex max-w-sm flex-col items-center pt-16 pb-12 lg:pt-24">
        {agent ? (
          <div className="flex flex-col items-center gap-3">
            <AgentGlyph
              agent={agent}
              className="!size-14 !rounded-xl [&_svg]:!size-6"
            />
            <bdi className="text-sm font-medium">{agent.name}</bdi>
          </div>
        ) : null}
        <div
          className={cn("flex flex-col items-center gap-2", agent && "mt-7")}
        >
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            {agent
              ? dictionary.empty.conversationTitle
              : dictionary.empty.addAgentTitle}
          </h1>
          <p className="text-sm leading-6 text-pretty text-muted-foreground">
            {agent
              ? dictionary.empty.conversationDescription
              : dictionary.empty.addAgentDescription}
          </p>
        </div>
        {!agent ? (
          <>
            <Button
              className="mt-6 h-11 min-w-32 px-4"
              disabled={!builderAvailable}
              onClick={() => void onNewAgent().catch(onActionError)}
            >
              {dictionary.actions.newAgent}
            </Button>
            {!builderAvailable ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {dictionary.empty.agentBuilderUnavailable}
              </p>
            ) : null}
          </>
        ) : null}
        {agent?.kind === "ready" ? (
          <Button
            className="mt-6 h-10 min-w-32 px-4"
            type="button"
            onClick={() => {
              void onCreateSession(agent.id).catch(onActionError)
            }}
          >
            {dictionary.actions.newSession}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function AosUiWorkspace({
  bundle,
  locale,
  dictionary,
  now,
  readNow = readSystemClock,
  environmentLabel,
  assistantInstructions,
  assistantToolkit,
  composer,
  activityCoverage = "workspace",
  browserSettings,
  browserNotificationPort,
}: {
  bundle: RuntimeBundle
  locale: Locale
  dictionary: Dictionary
  now: Date
  readNow?: () => Date
  environmentLabel?: string
  assistantInstructions?: string
  assistantToolkit?: Toolkit
  composer?: ThreadComponents["Composer"]
  activityCoverage?: "workspace" | "active-session"
  browserSettings?: BrowserSettingsView
  browserNotificationPort?: BrowserNotificationPort
}) {
  const { assistantRuntime: runtime, workspace } = bundle
  const nextPathname = usePathname() ?? "/"
  const historyPathname = useSyncExternalStore(
    subscribeToHistory,
    readBrowserPathname,
    () => nextPathname
  )
  const pathname = historyPathname || nextPathname
  const assistantConfig = useMemo(
    () =>
      assistantToolkit
        ? AuiConfig({ tools: Tools({ toolkit: assistantToolkit }) })
        : undefined,
    [assistantToolkit]
  )
  const activeThreadComponents = useMemo<ThreadComponents>(
    () => ({ ...threadComponents, Composer: composer }),
    [composer]
  )
  const capabilities = useMemo(
    () => getWorkspaceCapabilities(workspace),
    [workspace]
  )
  const threadState = useThreadListState(runtime)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [managementOpen, setManagementOpen] = useState(false)
  const [agentsLoading, setAgentsLoading] = useState(true)
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
  const [agentError, setAgentError] = useState<Error | null>(null)
  const [actionError, setActionError] = useState<Error | null>(null)
  const [agentFocusRequest, setAgentFocusRequest] = useState<{
    agentId: string
    nonce: number
  } | null>(null)
  const [todoSnapshot, setTodoSnapshot] = useState<TodoSnapshot>({
    key: "",
    todos: [],
    error: null,
  })
  const [todoSubscriptionKey, setTodoSubscriptionKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
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
  const appliedPathname = useRef<string | null>(null)
  const routeTransitionPathname = useRef<string | null>(null)
  const lifecycleRevisionsByWorkspace = useRef(
    new WeakMap<object, Map<string, number>>()
  )
  const selectedAgentId = agents.some(({ id }) => id === preferredAgentId)
    ? preferredAgentId
    : (agents[0]?.id ?? null)

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
      window.history[mode === "push" ? "pushState" : "replaceState"](
        null,
        "",
        href
      )
    },
    []
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
      desiredThread.current = threadId
      await runtime.threads.switchToThread(threadId)
      const latestDesired = desiredThread.current
      if (latestDesired && latestDesired !== threadId) {
        await runtime.threads.switchToThread(latestDesired)
      }
    },
    [runtime]
  )

  useEffect(() => {
    let cancelled = false
    void workspace
      .listAgents()
      .then((nextAgents) => {
        if (!cancelled) {
          setAgents(nextAgents)
          setAgentError(null)
          setAgentsLoading(false)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setAgentError(toError(reason))
          setAgentsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, workspace])

  useEffect(() => {
    if (!workspace.subscribeAgentCatalog) return

    let active = true
    let refreshGeneration = 0
    const refreshCatalog = () => {
      if (!active) return
      const generation = ++refreshGeneration
      void workspace
        .refreshAgents()
        .then((nextAgents) => {
          if (!active || generation !== refreshGeneration) return
          setAgents(nextAgents)
          setAgentError(null)
        })
        .catch((reason: unknown) => {
          if (!active || generation !== refreshGeneration) return
          setAgentError(toError(reason))
        })
    }
    const handleSignalError = (reason: Error) => {
      if (active) setAgentError(toError(reason))
    }

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = workspace.subscribeAgentCatalog(
        refreshCatalog,
        handleSignalError
      )
    } catch (reason) {
      queueMicrotask(() => {
        if (active) setAgentError(toError(reason))
      })
    }

    return () => {
      active = false
      refreshGeneration += 1
      unsubscribe?.()
    }
  }, [workspace])

  useEffect(() => {
    if (!workspace.subscribeAgentLifecycle) return
    let active = true
    let lifecycleRevisions =
      lifecycleRevisionsByWorkspace.current.get(workspace)
    if (!lifecycleRevisions) {
      lifecycleRevisions = new Map()
      lifecycleRevisionsByWorkspace.current.set(workspace, lifecycleRevisions)
    }
    const unsubscribe = workspace.subscribeAgentLifecycle(
      (event) => {
        if (!active) return
        const highestRevision = lifecycleRevisions.get(event.draftAgentId)
        if (
          highestRevision !== undefined &&
          event.revision <= highestRevision
        ) {
          return
        }
        lifecycleRevisions.set(event.draftAgentId, event.revision)

        if (event.type === "draft-promoted") {
          const shouldFollow = preferredAgentId === event.draftAgentId
          setManuallyOpened((current) => {
            const rest = { ...current }
            delete rest[event.draftAgentId]
            return shouldFollow
              ? {
                  ...rest,
                  [event.agentId]: [
                    ...new Set([
                      ...(rest[event.agentId] ?? []),
                      event.threadId,
                    ]),
                  ],
                }
              : rest
          })
          setDismissedTabs((current) => {
            const rest = { ...current }
            delete rest[event.draftAgentId]
            return rest
          })
          lastSelected.current.delete(event.draftAgentId)
          if (shouldFollow) {
            setPreferredAgentId(event.agentId)
            lastSelected.current.set(event.agentId, event.threadId)
          }
          void Promise.all([
            workspace.refreshAgents(),
            runtime.threads.reload(),
          ])
            .then(([nextAgents]) => {
              if (!active) return
              setAgents(nextAgents)
              if (shouldFollow) return selectRuntimeThread(event.threadId)
            })
            .catch((reason: unknown) => {
              if (active) setActionError(toError(reason))
            })
          return
        }

        if (event.type === "draft-deleted") {
          const shouldLeave = preferredAgentId === event.draftAgentId
          void Promise.all([
            workspace.refreshAgents(),
            runtime.threads.reload(),
          ])
            .then(([nextAgents]) => {
              if (!active) return
              setAgents(nextAgents)
              if (shouldLeave) setPreferredAgentId(nextAgents[0]?.id ?? null)
            })
            .catch((reason: unknown) => {
              if (active) setActionError(toError(reason))
            })
          return
        }

        void workspace
          .refreshAgents()
          .then((nextAgents) => {
            if (active) setAgents(nextAgents)
          })
          .catch((reason: unknown) => {
            if (active) setActionError(toError(reason))
          })
      },
      (reason) => {
        if (active) setActionError(reason)
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [preferredAgentId, runtime, selectRuntimeThread, workspace])

  useEffect(() => {
    if (threadState.isLoading || runtimeThreadIds.length === 0) return
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
    if (!selectedAgentId || threadState.isLoading || sessionsLoading) return
    if (appliedPathname.current !== pathname) {
      if (routeTransitionPathname.current === pathname) return
      routeTransitionPathname.current = pathname
      const requested = parseWorkspacePathname(pathname)
      const requestedAgent = requested?.agentId
        ? agents.find(({ id }) => id === requested.agentId)
        : undefined
      const agentId = requestedAgent?.id ?? agents[0]?.id ?? null
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
        : runtime.threads.switchToNewThread()
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
    const selectedSession = activeThreadId
      ? sessions.find(({ threadId }) => threadId === activeThreadId)
      : undefined
    const selectedCatalogAgent = agents.find(
      (agent) => agent.id === selectedAgentId
    )
    const manual = new Set([
      ...(manuallyOpened[selectedAgentId] ?? []),
      ...(selectedCatalogAgent?.kind === "provisional"
        ? [selectedCatalogAgent.builderThreadId]
        : []),
    ])
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
      void runtime.threads.switchToNewThread().catch(setActionError)
    }
  }, [
    activeThreadId,
    agents,
    dictionary.actions.newSession,
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

  const displayAgents = agents.map((agent) => {
    const ownedSessions = sessions.filter(
      (session) => session.agentId === agent.id
    )
    const catalogStatus: AgentSummary["status"] =
      agent.kind === "provisional"
        ? agent.phase === "activating"
          ? "running"
          : agent.phase === "start-failed" ||
              agent.phase === "activation-failed"
            ? "attention"
            : agent.status
        : agent.status
    const status: AgentSummary["status"] =
      catalogStatus === "attention" ||
      ownedSessions.some((session) => session.status === "waiting-for-input")
        ? "attention"
        : catalogStatus === "running" ||
            ownedSessions.some((session) => session.status === "running")
          ? "running"
          : "idle"

    return { ...agent, status }
  })
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
          ...(selectedAgent?.kind === "provisional"
            ? [selectedAgent.builderThreadId]
            : []),
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
    canClose: selectedAgent?.kind !== "provisional",
  }))

  async function selectAgent(agentId: string) {
    setPreferredAgentId(agentId)
    const catalogAgent = agents.find((agent) => agent.id === agentId)
    const manual = new Set([
      ...(manuallyOpened[agentId] ?? []),
      ...(catalogAgent?.kind === "provisional"
        ? [catalogAgent.builderThreadId]
        : []),
    ])
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
      await runtime.threads.switchToNewThread()
      updateRoute({ agentId, sessionId: null }, "push")
      return
    }
    if (!view.openSessions.some((session) => session.threadId === threadId)) {
      setManuallyOpened((current) => ({
        ...current,
        [agentId]: [...new Set([...(current[agentId] ?? []), threadId])],
      }))
    }
    await selectRuntimeThread(threadId)
    updateRoute({ agentId, sessionId: threadId }, "push")
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
    await selectRuntimeThread(threadId)
    updateRoute({ agentId: session.agentId, sessionId: threadId }, "push")
  }

  async function closeSession(threadId: string) {
    const closed = shellOpenSessions.find(
      (session) => session.threadId === threadId
    )
    if (!selectedAgentId || !closed?.canClose) return
    tabUndo.remember({
      agentId: selectedAgentId,
      threadId,
      title: closed.title,
      selectedThreadId: activeThreadId,
    })
    setDismissedTabs((current) => ({
      ...current,
      [selectedAgentId]: [
        ...new Set([...(current[selectedAgentId] ?? []), threadId]),
      ],
    }))
    setManuallyOpened((current) => ({
      ...current,
      [selectedAgentId]: (current[selectedAgentId] ?? []).filter(
        (candidate) => candidate !== threadId
      ),
    }))
    if (lastSelected.current.get(selectedAgentId) === threadId) {
      lastSelected.current.delete(selectedAgentId)
    }
    if (threadId !== activeThreadId) return
    const next = neighborAfterClose(
      sessionView.openSessions.map((session) => session.threadId),
      threadId,
      activeThreadId
    )
    if (next) {
      lastSelected.current.set(selectedAgentId, next)
      await selectRuntimeThread(next)
      updateRoute({ agentId: selectedAgentId, sessionId: next }, "replace")
    } else {
      lastSelected.current.set(selectedAgentId, null)
      desiredThread.current = null
      await runtime.threads.switchToNewThread()
      updateRoute({ agentId: selectedAgentId, sessionId: null }, "replace")
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
    setPreferredAgentId(closed.agentId)
    if (closed.selectedThreadId) {
      lastSelected.current.set(closed.agentId, closed.selectedThreadId)
      await selectRuntimeThread(closed.selectedThreadId)
      updateRoute(
        { agentId: closed.agentId, sessionId: closed.selectedThreadId },
        "push"
      )
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
    await selectRuntimeThread(created.threadId)
    updateRoute({ agentId, sessionId: created.threadId }, "push")
  }

  async function openAgentBuilder() {
    if (!workspace.openAgentBuilder) {
      throw new Error("Agent Builder is unavailable from this provider")
    }
    const { threadId, draftAgentId } = await workspace.openAgentBuilder({
      draftTitle: dictionary.actions.newAgent,
      draftDescription: dictionary.agentDraft.interview,
      firstSessionTitle: dictionary.actions.newSession,
    })
    await runtime.threads.reload()
    const [nextAgents, metadata] = await Promise.all([
      workspace.refreshAgents(),
      workspace.getSessionMetadata([threadId]),
    ])
    if (metadata[0]?.agentId !== draftAgentId) {
      throw new Error("Agent Builder did not confirm draft ownership")
    }
    setAgents(nextAgents)
    setPreferredAgentId(draftAgentId)
    setManuallyOpened((current) => ({
      ...current,
      [draftAgentId]: [
        ...new Set([...(current[draftAgentId] ?? []), threadId]),
      ],
    }))
    lastSelected.current.set(draftAgentId, threadId)
    await selectRuntimeThread(threadId)
    updateRoute({ agentId: draftAgentId, sessionId: threadId }, "push")
  }

  async function refreshAfterVisibilityChange() {
    const nextAgents = await workspace.refreshAgents()
    setAgents(nextAgents)
    setPreferredAgentId((current) =>
      nextAgents.some((agent) => agent.id === current)
        ? current
        : (nextAgents[0]?.id ?? null)
    )
    if (nextAgents.length === 0) {
      desiredThread.current = null
      await runtime.threads.switchToNewThread()
    }
  }

  async function retryAgentDraft(agentId: string) {
    if (!workspace.retryAgentDraft) {
      throw new Error("Agent draft recovery is unavailable from this provider")
    }
    await workspace.retryAgentDraft(agentId)
    const [nextAgents] = await Promise.all([
      workspace.refreshAgents(),
      runtime.threads.reload(),
    ])
    setAgents(nextAgents)
  }

  async function deleteAgentDraft(agentId: string) {
    if (!workspace.deleteAgentDraft) {
      throw new Error("Agent draft deletion is unavailable from this provider")
    }
    await workspace.deleteAgentDraft(agentId)
    const [nextAgents] = await Promise.all([
      workspace.refreshAgents(),
      runtime.threads.reload(),
    ])
    setAgents(nextAgents)
    if (preferredAgentId === agentId) {
      const nextAgentId = nextAgents[0]?.id ?? null
      setPreferredAgentId(nextAgentId)
      if (nextAgentId) {
        setAgentFocusRequest({ agentId: nextAgentId, nonce: Date.now() })
      }
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
  const threadChrome = useMemo<WorkspaceThreadChrome>(
    () => ({
      locale,
      todos,
      todosSupported: capabilities.todos,
      todoError,
      onRetryTodos: retryTodos,
      selectedAgent,
    }),
    [capabilities.todos, locale, retryTodos, selectedAgent, todoError, todos]
  )

  const activity = useActivityCoordinator({
    workspace,
    browser: {
      port: browserNotificationPort,
      copy: {
        completion: dictionary.activity.runFinished,
        failure: dictionary.activity.runFailed,
        input: dictionary.activity.inputRequested,
      },
    },
    agents: displayAgents,
    sessions,
    titles,
    selection:
      selectedAgentId && visibleThreadId
        ? { agentId: selectedAgentId, threadId: visibleThreadId }
        : null,
    readNow,
    onOpenTarget: async (agentId, threadId) => {
      setPreferredAgentId(agentId)
      await openSession(threadId, agentId)
    },
  })

  return (
    <WorkspaceShell
      activity={activity}
      browserSettings={
        browserSettings ?? {
          ...activity.browserSettings,
          coverage: capabilities.activityEvents
            ? activityCoverage
            : "unavailable",
        }
      }
      locale={locale}
      dictionary={dictionary}
      agents={displayAgents}
      openSessions={shellOpenSessions}
      olderSessions={sessionView.allSessions}
      selectedAgentId={selectedAgentId}
      activeThreadId={visibleThreadId}
      environmentLabel={environmentLabel}
      agentBuilderAvailable={capabilities.builderChat}
      onSelectAgent={selectAgent}
      onOpenSession={openSession}
      onCloseSession={closeSession}
      tabUndo={
        tabUndo.pending
          ? { title: tabUndo.pending.title, onUndo: undoCloseSession }
          : null
      }
      onCreateSession={createSession}
      onOpenAgentBuilder={openAgentBuilder}
      onManageAgents={() => setManagementOpen(true)}
      onRetryAgentDraft={
        capabilities.agentDraftRetry ? retryAgentDraft : undefined
      }
      onDeleteAgentDraft={
        capabilities.agentDraftDeletion ? deleteAgentDraft : undefined
      }
      agentFocusRequest={agentFocusRequest}
      onActionError={(reason) => setActionError(toError(reason))}
    >
      <div className="relative h-full min-h-0">
        {(agentError ?? sessionError ?? actionError) ? (
          <WorkspaceError
            locale={locale}
            error={(agentError ?? sessionError ?? actionError)!}
            onRetry={retryWorkspace}
          />
        ) : null}
        <AssistantRuntimeProvider runtime={runtime} config={assistantConfig}>
          {assistantInstructions ? (
            <AssistantInstructions instructions={assistantInstructions} />
          ) : null}
          <ToolUiLocaleProvider locale={locale}>
            {agentsLoading || sessionsLoading ? (
              <div
                className="grid h-full place-items-center text-sm text-muted-foreground"
                role="status"
              >
                {workspaceCopy[locale].loading}
              </div>
            ) : selectedAgent && visibleThreadId ? (
              <WorkspaceThreadChromeContext.Provider value={threadChrome}>
                <Thread
                  autoFocus={false}
                  labels={threadLabels[locale]}
                  components={activeThreadComponents}
                />
              </WorkspaceThreadChromeContext.Provider>
            ) : (
              <ConversationEmpty
                dictionary={dictionary}
                agent={selectedAgent}
                onCreateSession={createSession}
                onNewAgent={openAgentBuilder}
                builderAvailable={capabilities.builderChat}
                onActionError={(reason) => setActionError(toError(reason))}
              />
            )}
          </ToolUiLocaleProvider>
        </AssistantRuntimeProvider>
      </div>
      <ManageAgents
        open={managementOpen}
        onOpenChange={setManagementOpen}
        workspace={workspace}
        locale={locale}
        dictionary={dictionary}
        onVisibilityChanged={refreshAfterVisibilityChange}
        onNewAgent={openAgentBuilder}
        onActionError={(reason) => setActionError(toError(reason))}
      />
    </WorkspaceShell>
  )
}
