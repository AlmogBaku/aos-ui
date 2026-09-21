"use client"

import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  useAuiState,
  type AssistantState,
} from "@assistant-ui/react"
import {
  AlertCircle,
  Check,
  ChevronDown,
  Circle,
  LoaderCircle,
  RotateCw,
} from "lucide-react"
import { createContext, memo, useContext, useMemo, useState } from "react"

import {
  Thread,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui"
import { threadLabels } from "@/components/assistant-ui/thread-labels"
import { AssistantInstructions } from "@/components/assistant-instructions"
import { AosToolPresentation, ToolUiLocaleProvider } from "@/components/tool-ui"
import { Button } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import { AgentGlyph, WorkspaceShell } from "@/components/workspace"
import type { WorkspaceShellProps } from "@/components/workspace/workspace-shell"
import {
  ArtifactDataUI,
  ArtifactOutputs,
  ArtifactViewerContent,
  ArtifactWorkspaceProvider,
  createArtifactMessageStabilizer,
  useArtifactWorkspace,
} from "@/components/artifacts"
import { ManageAgents } from "@/components/workspace/manage-agents"
import { useWorkspaceNavigation } from "@/components/workspace/use-workspace-navigation"
import { useActivityCoordinator } from "@/components/workspace/use-activity-coordinator"
import type { BrowserSettingsView } from "@/components/workspace/activity"
import type { BrowserNotificationPort } from "@/lib/notifications/browser-port"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type {
  AgentSummary,
  HarnessRuntime,
  TodoItem,
} from "@/runtime-adapters/contracts"
import type { ArtifactMessage } from "@/artifacts/artifacts"
import { getWorkspaceCapabilities } from "@/runtime-adapters/workspace-state"
import { cn } from "@/lib/utils"
import { VoiceMediaProvider } from "@/components/assistant-ui/voice/voice-context"
import { PendingInteractionComposer } from "@/components/runtime-interactions/pending-composer"
import { PendingInteractionProvider } from "@/components/runtime-interactions/pending-interaction-context"

type AosUiWorkspaceProps = {
  runtime: HarnessRuntime
  locale: Locale
  dictionary: Dictionary
  now: Date
  readNow?: () => Date
  browserSettings?: BrowserSettingsView
  browserNotificationPort?: BrowserNotificationPort
}

export function AosUiWorkspace({ runtime, ...props }: AosUiWorkspaceProps) {
  const interactions = runtime.interactions
  const locale = props.locale
  const composer = useMemo<ThreadComponents["Composer"]>(
    () =>
      interactions
        ? function PendingComposer({ fallback }) {
            const threadId = useAuiState(
              (state) =>
                state.threadListItem.remoteId ?? state.threadListItem.id
            )
            return (
              <PendingInteractionComposer
                locale={locale}
                threadId={threadId}
                interactions={interactions}
                fallback={fallback}
              />
            )
          }
        : undefined,
    [interactions, locale]
  )
  const workspace = (
    <PendingInteractionProvider interactions={interactions}>
      <WorkspaceContent {...props} harness={runtime} composer={composer} />
    </PendingInteractionProvider>
  )
  return runtime.media ? (
    <VoiceMediaProvider media={runtime.media} locale={props.locale}>
      {workspace}
    </VoiceMediaProvider>
  ) : (
    workspace
  )
}

const workspaceCopy = {
  en: {
    retry: "Try again",
    loading: "Loading workspace…",
    unavailable: "The workspace could not be loaded.",
    tasks: "Session todos",
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

/**
 * The Session an artifact read is authorized against: the thread the replayed
 * messages belong to, read from the same snapshot those messages came from.
 * The workspace's own selection is tracked separately and settles on its own
 * schedule, so pairing it with this message list would let a Session switch ask
 * one Session for another's artifact, which the provider rightly refuses.
 */
function selectArtifactThreadId(state: AssistantState) {
  const { mainThreadId, threadItems } = state.threads
  const item = threadItems.find(({ id }) => id === mainThreadId)
  return item?.remoteId ?? item?.externalId ?? mainThreadId
}

function ArtifactWorkspaceBridge({
  bundle,
  locale,
  agentId,
  artifactHtmlAssetOrigins,
  artifactMessageProjector,
  children,
  ...shell
}: {
  bundle: HarnessRuntime
  locale: Locale
  agentId: string
  artifactHtmlAssetOrigins: readonly string[]
  artifactMessageProjector?: (
    messages: readonly ArtifactMessage[]
  ) => readonly ArtifactMessage[]
} & WorkspaceShellProps) {
  const selectArtifactMessages = useMemo(() => {
    const stabilize = createArtifactMessageStabilizer(artifactMessageProjector)
    return (state: AssistantState) =>
      stabilize(state.thread.messages as readonly ArtifactMessage[])
  }, [artifactMessageProjector])
  const artifactMessages = useAuiState(selectArtifactMessages)
  // Both selectors read one store, so a render cannot hold a thread id from
  // after a switch beside the messages from before it.
  const artifactThreadId = useAuiState(selectArtifactThreadId)

  return (
    <ArtifactWorkspaceProvider
      locale={locale}
      adapter={bundle.artifacts?.resolver}
      agentId={agentId}
      threadId={artifactThreadId}
      messages={artifactMessages}
      artifactHtmlAssetOrigins={artifactHtmlAssetOrigins}
    >
      <ArtifactWorkspaceContent {...shell} locale={locale}>
        {children}
      </ArtifactWorkspaceContent>
    </ArtifactWorkspaceProvider>
  )
}

const ArtifactWorkspaceContent = memo(function ArtifactWorkspaceContent({
  children,
  ...shell
}: WorkspaceShellProps) {
  const { closeArtifact, labels, selectedArtifact } = useArtifactWorkspace()

  return (
    <WorkspaceShell
      {...shell}
      artifactOutputs={<ArtifactOutputs />}
      artifactViewer={<ArtifactViewerContent />}
      artifactViewerOpen={selectedArtifact !== null}
      artifactViewerLabel={labels.viewerLabel}
      onCloseArtifactViewer={closeArtifact}
    >
      <ArtifactDataUI />
      {children}
    </WorkspaceShell>
  )
})
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
      className="group border-y border-border/60 bg-background @md:rounded-[24px] @md:border @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:w-full @min-[64rem]/workspace:max-w-(--thread-content-max-width) dark:bg-popover"
      data-slot="todo-dock"
      role="region"
      aria-label={copy.tasks}
      open={error ? true : undefined}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring @md:gap-3 @md:px-4 @md:py-2 [&::-webkit-details-marker]:hidden [@media(pointer:coarse)]:min-h-11">
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
  ToolFallback: AosToolPresentation,
}

function NoAgentEmpty({
  dictionary,
  onActionError,
  onNewAgent,
  builderAvailable,
}: {
  dictionary: Dictionary
  onActionError: (error: unknown) => void
  onNewAgent: () => Promise<void>
  builderAvailable: boolean
}) {
  return (
    <div className="h-full overflow-y-auto px-6 text-center">
      <div className="mx-auto flex max-w-sm flex-col items-center pt-16 pb-12 lg:pt-24">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            {dictionary.empty.addAgentTitle}
          </h1>
          <p className="text-sm leading-6 text-pretty text-muted-foreground">
            {dictionary.empty.addAgentDescription}
          </p>
        </div>
        {builderAvailable ? (
          <Button
            className="mt-6 h-11 min-w-32 px-4"
            onClick={() => void onNewAgent().catch(onActionError)}
          >
            {dictionary.actions.newAgent}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function WorkspaceContent({
  harness: bundle,
  locale,
  dictionary,
  now,
  readNow = readSystemClock,
  composer,
  browserSettings,
  browserNotificationPort,
}: Omit<AosUiWorkspaceProps, "runtime"> & {
  harness: HarnessRuntime
  composer?: ThreadComponents["Composer"]
}) {
  const { assistantRuntime: runtime, workspace } = bundle
  const {
    environmentLabel,
    activityCoverage,
    composer: composerFeatures,
  } = bundle
  const assistantInstructions = bundle.assistantConfig?.instructions
  const assistantToolkit = bundle.assistantConfig?.toolkit
  const artifactHtmlAssetOrigins = bundle.artifacts?.htmlAssetOrigins ?? []
  const artifactMessageProjector = bundle.artifacts?.projectMessages
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
    refreshAfterVisibilityChange,
    retryWorkspace,
  } = useWorkspaceNavigation({ bundle, locale, dictionary, now, readNow })
  const capabilities = useMemo(
    () =>
      getWorkspaceCapabilities(
        workspace,
        displayAgents,
        sessionActions ?? undefined
      ),
    [displayAgents, sessionActions, workspace]
  )
  const workspaceError = agentError ?? sessionError ?? actionError
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
      <ArtifactWorkspaceBridge
        bundle={bundle}
        locale={locale}
        agentId={selectedAgentId ?? ""}
        artifactHtmlAssetOrigins={artifactHtmlAssetOrigins}
        artifactMessageProjector={artifactMessageProjector}
        activity={activity}
        browserSettings={
          browserSettings ?? {
            ...activity.browserSettings,
            coverage: capabilities.activityEvents
              ? activityCoverage
              : "unavailable",
          }
        }
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
        onRenameSession={renameSession}
        onSetSessionPinned={setSessionPinned}
        onArchiveSession={archiveSession}
        onUnarchiveSession={unarchiveSession}
        onDeleteSession={deleteSession}
        sessionActions={sessionActions}
        onOpenAgentBuilder={openAgentBuilder}
        onManageAgents={() => setManagementOpen(true)}
        onConversationObscuredChange={setConversationObscured}
        onActionError={(reason) => setActionError(toError(reason))}
      >
        <div className="relative h-full min-h-0">
          {workspaceError ? (
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
            {agentsLoading ||
            (!conversationThreadId &&
              (sessionsLoading || Boolean(selectedAgent))) ? (
              <div
                className="grid h-full place-items-center text-sm text-muted-foreground"
                role="status"
              >
                {workspaceCopy[locale].loading}
              </div>
            ) : selectedAgent && conversationThreadId ? (
              <WorkspaceThreadChromeContext.Provider value={threadChrome}>
                <Thread
                  autoFocus={false}
                  direction={getLocaleDirection(locale)}
                  labels={threadLabels[locale]}
                  composerFeatures={composerFeatures}
                  messageRewind={bundle.messageRewind}
                  components={activeThreadComponents}
                />
              </WorkspaceThreadChromeContext.Provider>
            ) : (
              <NoAgentEmpty
                dictionary={dictionary}
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
      </ArtifactWorkspaceBridge>
    </AssistantRuntimeProvider>
  )
}
