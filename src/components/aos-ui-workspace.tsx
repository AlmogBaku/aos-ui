"use client"

import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
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
import { createContext, useContext, useEffect, useMemo, useState } from "react"

import {
  Thread,
  type ThreadComponents,
  type ThreadLabels,
} from "@/components/assistant-ui/elements/thread.aui"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { AssistantInstructions } from "@/components/assistant-instructions"
import { ToolUiLocaleProvider, RichToolRenderer } from "@/components/tool-ui"
import { Button } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import { AgentGlyph, WorkspaceShell } from "@/components/workspace"
import { ManageAgents } from "@/components/workspace/manage-agents"
import { useWorkspaceNavigation } from "@/components/workspace/use-workspace-navigation"
import { useActivityCoordinator } from "@/components/workspace/use-activity-coordinator"
import type { BrowserSettingsView } from "@/components/workspace/activity"
import type { BrowserNotificationPort } from "@/lib/notifications/browser-port"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type {
  AgentSummary,
  RuntimeBundle,
  TodoItem,
} from "@/runtime-adapters/contracts"
import { getWorkspaceCapabilities } from "@/runtime-adapters/workspace-state"
import { cn } from "@/lib/utils"

const threadLabels: Record<Locale, ThreadLabels> = {
  en: {
    loadingConversation: "Loading conversation",
    scrollToBottom: "Scroll to bottom",
    welcome: "What would you like to work on?",
    composerPlaceholder: "Message",
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
    queuedMessages: "Queued messages",
    previous: "Previous branch",
    next: "Next branch",
    conversationHeading: "Conversation",
    modelSelector: "Choose model",
    contextUsage: "Context usage",
    contextTitle: "Context",
    contextSystem: "System",
    contextTools: "Tools",
    contextMessages: "Messages",
    contextTotal: "Total",
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
    composerPlaceholder: "הודעה",
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
    queuedMessages: "הודעות בתור",
    previous: "הסתעפות קודמת",
    next: "הסתעפות הבאה",
    conversationHeading: "שיחה",
    modelSelector: "בחירת מודל",
    contextUsage: "שימוש בהקשר",
    contextTitle: "הקשר",
    contextSystem: "מערכת",
    contextTools: "כלים",
    contextMessages: "הודעות",
    contextTotal: "סה״כ",
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

function readSystemClock() {
  return new Date()
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
      className="group border-y border-border/70 bg-background @md:rounded-2xl @md:border @md:bg-card/90 @md:shadow-sm"
      data-slot="todo-dock"
      open={error ? true : undefined}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring @md:gap-3 @md:px-4 @md:py-3 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        <span className="font-medium">{copy.tasks}</span>
        {supported && todos.length > 0 ? (
          <span className="ms-auto text-xs text-muted-foreground">
            {copy.taskSummary(completed, todos.length)}
          </span>
        ) : null}
      </summary>
      <div className="max-h-[min(12rem,30dvh)] overflow-y-auto border-t border-border/70 px-3 py-2 @md:max-h-none @md:overflow-visible @md:px-4 @md:py-3">
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
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <ErrorToast
      locale={locale}
      title={copy.unavailable}
      message={error.message}
      onDismiss={() => setDismissed(true)}
      actions={
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          <RotateCw data-icon="inline-start" />
          {copy.retry}
        </Button>
      }
    />
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
        {!agent && builderAvailable ? (
          <Button
            className="mt-6 h-11 min-w-32 px-4"
            onClick={() => void onNewAgent().catch(onActionError)}
          >
            {dictionary.actions.newAgent}
          </Button>
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
  composerFeatures,
  onStopRun,
  onWorkspaceError,
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
  composerFeatures?: ComposerFeatureViewModel
  onStopRun?: () => void | Promise<void>
  onWorkspaceError?: (error: Error) => void
  activityCoverage?: "workspace" | "active-session"
  browserSettings?: BrowserSettingsView
  browserNotificationPort?: BrowserNotificationPort
}) {
  const { assistantRuntime: runtime, workspace } = bundle
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
  const [managementOpen, setManagementOpen] = useState(false)
  const [conversationObscured, setConversationObscured] = useState(false)
  const {
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
  } = useWorkspaceNavigation({ bundle, locale, dictionary, now, readNow })
  const workspaceError = agentError ?? sessionError ?? actionError
  useEffect(() => {
    if (workspaceError) onWorkspaceError?.(workspaceError)
  }, [onWorkspaceError, workspaceError])
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
    conversationExposed: !managementOpen && !conversationObscured,
    readNow,
    onOpenTarget: async (agentId, threadId) => {
      setPreferredAgentId(agentId)
      await openSession(threadId, agentId)
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime} config={assistantConfig}>
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
        agentCreatorId={agentCreator?.id}
        openSessions={shellOpenSessions}
        olderSessions={sessionView.allSessions}
        navigationCatalog={navigationCatalog}
        threadListRuntime={runtime.threads}
        selectedAgentId={selectedAgentId}
        activeThreadId={visibleThreadId}
        environmentLabel={environmentLabel}
        agentBuilderAvailable={Boolean(agentCreator)}
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
        onConversationObscuredChange={setConversationObscured}
        onActionError={(reason) => setActionError(toError(reason))}
      >
        <div className="relative h-full min-h-0">
          {workspaceError && !onWorkspaceError ? (
            <WorkspaceError
              key={workspaceError.message}
              locale={locale}
              error={workspaceError}
              onRetry={retryWorkspace}
            />
          ) : null}
          {assistantInstructions ? (
            <AssistantInstructions instructions={assistantInstructions} />
          ) : null}
          <ToolUiLocaleProvider locale={locale}>
            {agentsLoading || (sessionsLoading && !visibleThreadId) ? (
              <div
                className="grid h-full place-items-center text-sm text-muted-foreground"
                role="status"
              >
                {workspaceCopy[locale].loading}
              </div>
            ) : selectedAgent && visibleThreadId ? (
              <WorkspaceThreadChromeContext.Provider value={threadChrome}>
                <Thread
                  onStopRun={
                    onStopRun
                      ? () => {
                          void Promise.resolve()
                            .then(onStopRun)
                            .catch((reason: unknown) =>
                              setActionError(toError(reason))
                            )
                        }
                      : undefined
                  }
                  autoFocus={false}
                  direction={getLocaleDirection(locale)}
                  labels={threadLabels[locale]}
                  composerFeatures={composerFeatures}
                  components={activeThreadComponents}
                />
              </WorkspaceThreadChromeContext.Provider>
            ) : (
              <ConversationEmpty
                dictionary={dictionary}
                agent={selectedAgent}
                onCreateSession={createSession}
                onNewAgent={openAgentBuilder}
                builderAvailable={Boolean(agentCreator)}
                onActionError={(reason) => setActionError(toError(reason))}
              />
            )}
          </ToolUiLocaleProvider>
        </div>
        <ManageAgents
          creatorAvailable={Boolean(agentCreator)}
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
    </AssistantRuntimeProvider>
  )
}
