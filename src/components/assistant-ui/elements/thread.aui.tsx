"use client"

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui"
import {
  AttachmentLabelsContext,
  DEFAULT_ATTACHMENT_LABELS,
  type AttachmentLabels,
} from "@/components/assistant-ui/elements/attachment-labels"
import { File } from "@/components/assistant-ui/elements/file"
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui"
import { Image as MessageImage } from "@/components/assistant-ui/elements/image"
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text"
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui"
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui"
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import {
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
} from "@/components/assistant-ui/elements/model-selector"
import { ComposerContext } from "@/components/assistant-ui/elements/composer-context"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  isCollapsedCaretAtVisualLineBoundary,
  measureTextareaVisualLineBoundary,
  resolveComposerEnterAction,
  type ComposerEnterEvent,
} from "@/components/assistant-ui/elements/composer-keyboard"
import { keyboardEventSafetyReason } from "@/lib/keyboard"
import type { LocaleDirection } from "@/lib/i18n/config"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { useThreadReadingPosition } from "./thread-reading-position"
import {
  VoiceComposerControl,
  VoiceComposerField,
  VoiceComposerNotice,
} from "../voice/voice-composer"
import { useVoiceCaptureActive, useVoiceContext } from "../voice/voice-context"
import {
  InlineReadAloud,
  VoiceMessageActions,
  VoiceReplyReader,
  useVoiceMessageReading,
} from "../voice/voice-read-aloud"
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type Attachment,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  QueueItemPrimitive,
  type ThreadMessage,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiEvent,
  useAuiState,
  unstable_useTriggerPopoverRootContextOptional,
} from "@assistant-ui/react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react"
import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react"

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined
  AssistantIdentity?: ComponentType | undefined
  BeforeComposer?: ComponentType | undefined
  Composer?: ComponentType<ThreadComposerOverrideProps> | undefined
  Welcome?: ComponentType | undefined
  ToolFallback?: ToolCallMessagePartComponent | undefined
  ToolGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined
  ReasoningGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined
}

export type ThreadComposerOverrideProps = {
  fallback: ReactNode
}

export type ThreadProps = {
  /** Explicit user Stop only. Cleanup must never invoke this native control. */
  onStopRun?: () => void
  components?: ThreadComponents | undefined
  autoFocus?: boolean | undefined
  labels?: Partial<ThreadLabels> | undefined
  direction?: LocaleDirection | undefined
  composerFeatures?: ComposerFeatureViewModel | undefined
}

export type ThreadLabels = {
  loadingConversation: string
  scrollToBottom: string
  welcome: string
  composerPlaceholder: string
  messageInput: string
  voiceInput: string
  startVoiceInput: string
  stopDictation: string
  stopVoiceInput: string
  sendMessage: string
  stopGenerating: string
  assistantWorking: string
  copy: string
  refresh: string
  more: string
  exportMarkdown: string
  edit: string
  cancel: string
  update: string
  historySearch?: string | undefined
  historySearchPlaceholder?: string | undefined
  historyCancel?: string | undefined
  queuedMessages?: string | undefined
  previous: string
  next: string
  conversationHeading?: string | undefined
  modelSelector: string
  contextUsage: string
  contextTitle: string
  contextSystem: string
  contextTools: string
  contextMessages: string
  contextTotal: string
  attachments?: Partial<AttachmentLabels> | undefined
}

const DEFAULT_LABELS: ThreadLabels = {
  loadingConversation: "Loading conversation",
  scrollToBottom: "Scroll to bottom",
  welcome: "How can I help you today?",
  composerPlaceholder: "Send a message…",
  messageInput: "Message input",
  voiceInput: "Voice input",
  startVoiceInput: "Start voice input",
  stopDictation: "Stop dictation",
  stopVoiceInput: "Stop voice input",
  sendMessage: "Send message",
  stopGenerating: "Stop generating",
  assistantWorking: "Assistant is working",
  copy: "Copy",
  refresh: "Refresh",
  more: "More",
  exportMarkdown: "Export as Markdown",
  edit: "Edit",
  cancel: "Cancel",
  update: "Update",
  historySearch: "Search conversation history",
  historySearchPlaceholder: "Filter sent messages…",
  historyCancel: "Cancel history search",
  queuedMessages: "Queued messages",
  previous: "Previous",
  next: "Next",
  conversationHeading: "Conversation",
  modelSelector: "Choose model",
  contextUsage: "Context usage",
  contextTitle: "Context",
  contextSystem: "System",
  contextTools: "Tools",
  contextMessages: "Messages",
  contextTotal: "Total",
  attachments: DEFAULT_ATTACHMENT_LABELS,
}

const EMPTY_COMPONENTS: ThreadComponents = {}

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS)
const ThreadStopContext = createContext<(() => void) | undefined>(undefined)
const ThreadLabelsContext = createContext<ThreadLabels>(DEFAULT_LABELS)
const ThreadComposerFeaturesContext = createContext<ComposerFeatureViewModel>(
  {}
)

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading)

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading

const hasMessages = (s: AssistantState) => s.thread.messages.length > 0

const ASSISTANT_MESSAGE_GROUPER = groupPartByType<
  "group-chainOfThought" | "group-reasoning" | "group-tool"
>({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought"],
  "standalone-tool-call": [],
})

const ThreadHistorySkeleton: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <div
      data-slot="aui_thread-history-skeleton"
      role="status"
      className="flex animate-in flex-col gap-y-6 fill-mode-both [animation-delay:150ms] [animation-duration:200ms] fade-in motion-reduce:animate-none"
    >
      <span className="sr-only">{labels.loadingConversation}</span>
      <Skeleton className="ms-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
      <div className="flex flex-col gap-y-2">
        <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
      </div>
      <Skeleton className="ms-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
      <div className="flex flex-col gap-y-2">
        <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
      </div>
    </div>
  )
}

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  labels,
  direction = "ltr",
  onStopRun,
  composerFeatures = {},
}) => {
  const isEmpty = useAuiState(isNewChatView)
  const localizedLabels = useMemo(
    () => ({ ...DEFAULT_LABELS, ...labels }),
    [labels]
  )
  const localizedAttachmentLabels = useMemo(
    () => ({ ...DEFAULT_ATTACHMENT_LABELS, ...labels?.attachments }),
    [labels?.attachments]
  )

  return (
    <ThreadLabelsContext.Provider value={localizedLabels}>
      <AttachmentLabelsContext.Provider value={localizedAttachmentLabels}>
        <ThreadComposerFeaturesContext.Provider value={composerFeatures}>
          <ThreadComponentsContext.Provider value={components}>
            <ThreadStopContext.Provider value={onStopRun}>
              <ThreadRoot
                isEmpty={isEmpty}
                autoFocus={autoFocus}
                direction={direction}
              />
            </ThreadStopContext.Provider>
          </ThreadComponentsContext.Provider>
        </ThreadComposerFeaturesContext.Provider>
      </AttachmentLabelsContext.Provider>
    </ThreadLabelsContext.Provider>
  )
}

const ThreadRoot: FC<{
  isEmpty: boolean
  autoFocus: boolean
  direction: LocaleDirection
}> = ({ isEmpty, autoFocus, direction }) => {
  const {
    BeforeComposer,
    Composer: ComposerOverride,
    Welcome = ThreadWelcome,
  } = useContext(ThreadComponentsContext)
  const labels = useContext(ThreadLabelsContext)
  const aui = useAui()
  const onStopRun = useContext(ThreadStopContext)
  const viewportRef = useRef<HTMLDivElement>(null)
  const threadId = useAuiState((state) => state.threadListItem.id)
  const contentReady = useAuiState((state) => !state.thread.isLoading)
  useThreadReadingPosition({
    threadId,
    contentReady,
    viewportRef,
  })

  const handleThreadKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || keyboardEventSafetyReason(event)) {
        return
      }
      if (!aui.thread.getState().isRunning) return
      event.preventDefault()
      if (onStopRun) onStopRun()
      else aui.thread.cancelRun()
    },
    [aui, onStopRun]
  )

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background [--composer-padding:0.25rem] [--composer-radius:0.75rem] @md:[--composer-padding:0.5rem] @md:[--composer-radius:1.5rem]"
      style={{
        ["--thread-max-width" as string]: "56rem",
        ["--composer-bg" as string]: "var(--color-card)",
      }}
    >
      <VoiceReplyReader />
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <AuiIf condition={(s) => s.thread.isRunning}>
          {labels.assistantWorking}
        </AuiIf>
      </span>
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        turnAnchor="top"
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth motion-reduce:scroll-auto"
        onKeyDown={handleThreadKeyDown}
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-3 pt-4 @md:px-8 @md:pt-10",
            isEmpty && "justify-center"
          )}
        >
          <AuiIf condition={hasMessages}>
            <h1 className="sr-only">{labels.conversationHeading}</h1>
          </AuiIf>
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mx-auto mb-8 flex w-full max-w-[45rem] flex-col gap-y-6 empty:hidden @md:mb-16 @md:gap-y-8"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer flex flex-col gap-2 overflow-visible bg-background pb-[max(0.5rem,env(safe-area-inset-bottom))] @md:gap-4 @md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)"
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {BeforeComposer ? <BeforeComposer /> : null}
            <ComposerPrimitive.Unstable_TriggerPopoverRoot>
              {ComposerOverride ? (
                <ComposerOverride
                  fallback={
                    <Composer autoFocus={autoFocus} direction={direction} />
                  }
                />
              ) : (
                <Composer autoFocus={autoFocus} direction={direction} />
              )}
            </ComposerPrimitive.Unstable_TriggerPopoverRoot>
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext)
  const role = useAuiState((s) => s.message.role)
  const isEditing = useAuiState((s) => s.message.composer.isEditing)

  if (isEditing) return <EditComposer />
  if (role === "user") return <UserMessage />
  return <AssistantMessageComponent />
}

const ThreadScrollToBottom: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip={labels.scrollToBottom}
          variant="outline"
          className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
        />
      }
    >
      <ArrowDownIcon />
    </ThreadPrimitive.ScrollToBottom>
  )
}

const ThreadWelcome: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner animate-in text-2xl font-medium tracking-tight duration-200 fill-mode-both fade-in slide-in-from-bottom-1 motion-reduce:animate-none">
        {labels.welcome}
      </h1>
    </div>
  )
}

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  )
}

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display animate-in duration-200 fill-mode-both fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
      <SuggestionPrimitive.Trigger
        send
        render={
          <Button
            variant="ghost"
            className="aui-thread-welcome-suggestion h-auto gap-1.5 rounded-full border border-border/60 px-3.5 py-1.5 text-sm font-normal whitespace-nowrap text-foreground transition-colors hover:bg-muted"
          />
        }
      >
        <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
        <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
      </SuggestionPrimitive.Trigger>
    </div>
  )
}

type RecoverableDraft = {
  readonly text: string
  readonly attachments: readonly Attachment[]
  readonly selectionStart: number
  readonly selectionEnd: number
}

type HistoryBrowse = {
  readonly cursor: number
  readonly draftSnapshot: RecoverableDraft
  readonly lastRecalledText: string
}

type ComposerHistoryMessage = Pick<ThreadMessage, "id" | "role" | "content">

const getMessageText = (message: ComposerHistoryMessage) =>
  message.content
    .filter(
      (
        part
      ): part is Extract<ThreadMessage["content"][number], { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("")

type ComposerHistoryEntry = { id: string; text: string }

export function createComposerHistorySelector() {
  let previous: readonly ComposerHistoryEntry[] = []
  return (messages: readonly ComposerHistoryMessage[]) => {
    const next = messages
      .filter((message) => message.role === "user")
      .map((message) => ({ id: message.id, text: getMessageText(message) }))
      .filter((entry) => entry.text.trim().length > 0)
      .reverse()
    if (
      previous.length === next.length &&
      previous.every(
        (entry, index) =>
          entry.id === next[index]?.id && entry.text === next[index]?.text
      )
    )
      return previous
    previous = next
    return next
  }
}

const Composer: FC<{
  autoFocus: boolean
  direction: LocaleDirection
}> = ({ autoFocus, direction }) => {
  const voice = useVoiceContext()
  const voiceActive = useVoiceCaptureActive()
  const labels = useContext(ThreadLabelsContext)
  const historySearchLabel =
    labels.historySearch ?? "Search conversation history"
  const historySearchPlaceholder =
    labels.historySearchPlaceholder ?? "Filter sent messages…"
  const historyCancelLabel = labels.historyCancel ?? "Cancel history search"
  const queuedMessagesLabel = labels.queuedMessages ?? "Queued messages"
  const aui = useAui()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submissionLockRef = useRef(false)
  const escapeRef = useRef<number | null>(null)
  const clearUndoRef = useRef<RecoverableDraft | null>(null)
  const searchSnapshotRef = useRef<RecoverableDraft | null>(null)
  const historyBrowseRef = useRef<HistoryBrowse | null>(null)
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [historySearchQuery, setHistorySearchQuery] = useState("")
  const [historySearchIndex, setHistorySearchIndex] = useState(0)
  const selectHistoryEntries = useMemo(
    () => createComposerHistorySelector(),
    []
  )
  const historyEntries = useAuiState((s) =>
    selectHistoryEntries(s.thread.messages)
  )
  const triggerPopover = unstable_useTriggerPopoverRootContextOptional()

  useAuiEvent("threads.selectionChanged", () => {
    clearUndoRef.current = null
    searchSnapshotRef.current = null
    historyBrowseRef.current = null
    setHistorySearchOpen(false)
    setHistorySearchQuery("")
    setHistorySearchIndex(0)
  })

  const filteredHistory = useMemo(() => {
    const query = historySearchQuery.trim().toLocaleLowerCase()
    if (!query) return historyEntries
    return historyEntries.filter((entry) =>
      entry.text.toLocaleLowerCase().includes(query)
    )
  }, [historyEntries, historySearchQuery])

  const focusInput = useCallback((snapshot?: RecoverableDraft | null) => {
    queueMicrotask(() => {
      const input = inputRef.current
      if (!input) return
      input.focus({ preventScroll: true })
      const start = snapshot?.selectionStart ?? input.value.length
      const end = snapshot?.selectionEnd ?? start
      input.setSelectionRange(start, end)
    })
  }, [])

  const restoreDraft = useCallback(
    (snapshot: RecoverableDraft) => {
      aui.composer.setText(snapshot.text)
      const currentAttachmentIds = new Set(
        aui.composer.getState().attachments.map((attachment) => attachment.id)
      )
      for (const attachment of snapshot.attachments) {
        if (currentAttachmentIds.has(attachment.id)) continue
        if (attachment.status.type === "complete" && attachment.content) {
          void aui.composer.addAttachment({
            id: attachment.id,
            type: attachment.type,
            name: attachment.name,
            contentType: attachment.contentType,
            content: attachment.content,
          })
        } else if (attachment.status.type !== "complete" && attachment.file) {
          void aui.composer.addAttachment(attachment.file)
        }
      }
      focusInput(snapshot)
    },
    [aui, focusInput]
  )

  const openHistorySearch = useCallback(
    (input: HTMLTextAreaElement) => {
      const state = aui.composer.getState()
      searchSnapshotRef.current = {
        text: state.text,
        attachments: state.attachments,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      }
      clearUndoRef.current = null
      historyBrowseRef.current = null
      setHistorySearchQuery("")
      setHistorySearchIndex(0)
      setHistorySearchOpen(true)
    },
    [aui]
  )

  const loadHistoryEntry = useCallback(
    (index: number) => {
      const entry = filteredHistory[index]
      if (!entry) return
      aui.composer.setText(entry.text)
      setHistorySearchOpen(false)
      setHistorySearchQuery("")
      setHistorySearchIndex(0)
      searchSnapshotRef.current = null
      historyBrowseRef.current = null
      focusInput()
    },
    [aui, filteredHistory, focusInput]
  )

  const cancelHistorySearch = useCallback(() => {
    const snapshot = searchSnapshotRef.current
    setHistorySearchOpen(false)
    setHistorySearchQuery("")
    searchSnapshotRef.current = null
    historyBrowseRef.current = null
    if (snapshot) restoreDraft(snapshot)
    else focusInput()
  }, [focusInput, restoreDraft])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (keyboardEventSafetyReason(event)) {
        if (event.key === "Escape") escapeRef.current = null
        return
      }
      if (event.key !== "Escape") escapeRef.current = null

      if (
        event.key.toLowerCase() === "r" &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault()
        openHistorySearch(event.currentTarget)
        return
      }

      if (
        event.key === "ArrowUp" ||
        (event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey))
      ) {
        const snapshot = clearUndoRef.current
        const state = aui.composer.getState()
        if (
          snapshot &&
          !state.text &&
          state.attachments.length === 0 &&
          isCollapsedCaretAtVisualLineBoundary({
            value: event.currentTarget.value,
            selectionStart: event.currentTarget.selectionStart,
            selectionEnd: event.currentTarget.selectionEnd,
            boundary: "first",
          })
        ) {
          event.preventDefault()
          clearUndoRef.current = null
          restoreDraft(snapshot)
          return
        }
      }

      if (clearUndoRef.current) clearUndoRef.current = null

      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !(triggerPopover && triggerPopover.getActiveAria() !== null)
      ) {
        const input = event.currentTarget
        let browse = historyBrowseRef.current
        if (browse && input.value !== browse.lastRecalledText) {
          historyBrowseRef.current = null
          browse = null
        }

        const boundary = event.key === "ArrowUp" ? "first" : "last"
        if (
          isCollapsedCaretAtVisualLineBoundary({
            value: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            boundary,
            measure: (request) =>
              measureTextareaVisualLineBoundary(input, request),
          })
        ) {
          if (event.key === "ArrowUp") {
            const nextCursor = browse ? browse.cursor + 1 : 0
            const entry = historyEntries[nextCursor]
            if (entry) {
              const draftSnapshot = browse?.draftSnapshot ?? {
                text: aui.composer.getState().text,
                attachments: aui.composer.getState().attachments,
                selectionStart: input.selectionStart,
                selectionEnd: input.selectionEnd,
              }
              event.preventDefault()
              aui.composer.setText(entry.text)
              historyBrowseRef.current = {
                cursor: nextCursor,
                draftSnapshot,
                lastRecalledText: entry.text,
              }
              focusInput()
              return
            }
          } else if (browse) {
            event.preventDefault()
            if (browse.cursor === 0) {
              historyBrowseRef.current = null
              restoreDraft(browse.draftSnapshot)
            } else {
              const nextCursor = browse.cursor - 1
              const entry = historyEntries[nextCursor]
              if (!entry) {
                historyBrowseRef.current = null
                restoreDraft(browse.draftSnapshot)
              } else {
                aui.composer.setText(entry.text)
                historyBrowseRef.current = {
                  ...browse,
                  cursor: nextCursor,
                  lastRecalledText: entry.text,
                }
                focusInput()
              }
            }
            return
          }
        }
      }

      if (event.key === "Escape") {
        if (triggerPopover && triggerPopover.getActiveAria() !== null) {
          escapeRef.current = null
          return
        }
        const now = Date.now()
        const previous = escapeRef.current
        if (previous !== null && now - previous <= 500) {
          event.preventDefault()
          escapeRef.current = null
          const state = aui.composer.getState()
          if (state.isEmpty) {
            if (historyEntries.length > 0) {
              openHistorySearch(event.currentTarget)
            }
            return
          }
          const canRecoverAttachments = state.attachments.every((attachment) =>
            attachment.status.type === "complete"
              ? Boolean(attachment.content)
              : Boolean(attachment.file)
          )
          if (!canRecoverAttachments) {
            // Do not destroy an attachment that cannot be reconstructed after
            // reset (for example, a provider omitted its pending File).
            return
          }
          clearUndoRef.current = {
            text: state.text,
            attachments: state.attachments,
            selectionStart: event.currentTarget.selectionStart,
            selectionEnd: event.currentTarget.selectionEnd,
          }
          void aui.composer.reset()
        } else {
          escapeRef.current = now
        }
        return
      }

      const action = resolveComposerEnterAction(
        event as unknown as ComposerEnterEvent,
        {
          isRunning: aui.thread.getState().isRunning,
          hasQueue: aui.thread.getState().capabilities.queue === true,
          isEmpty: aui.composer.getState().isEmpty,
        }
      )
      if (action !== "send") {
        return
      }

      event.preventDefault()
      if (submissionLockRef.current) return
      submissionLockRef.current = true
      event.currentTarget.closest("form")?.requestSubmit()
      queueMicrotask(() => {
        submissionLockRef.current = false
      })
    },
    [
      aui,
      focusInput,
      historyEntries,
      openHistorySearch,
      restoreDraft,
      triggerPopover,
    ]
  )

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative -mx-2 flex w-[calc(100%+1rem)] flex-col @md:-mx-7 @md:w-[calc(100%+3.5rem)] @min-[64rem]/workspace:mx-0 @min-[64rem]/workspace:w-full"
      onSubmit={(event) => {
        if (voice?.media.captureActive || voiceActive) event.preventDefault()
      }}
    >
      {historySearchOpen ? (
        <div
          role="dialog"
          aria-label={historySearchLabel}
          className="mb-2 rounded-xl border border-border/60 bg-(--composer-bg) p-2 shadow-sm"
        >
          <div className="flex items-center gap-2">
            <input
              autoFocus
              aria-label={historySearchPlaceholder}
              aria-activedescendant={
                filteredHistory[historySearchIndex]
                  ? `history-entry-${filteredHistory[historySearchIndex].id}`
                  : undefined
              }
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none"
              placeholder={historySearchPlaceholder}
              value={historySearchQuery}
              onChange={(event) => {
                setHistorySearchQuery(event.target.value)
                setHistorySearchIndex(0)
              }}
              onKeyDown={(event) => {
                if (keyboardEventSafetyReason(event)) return
                if (event.key === "Escape") {
                  event.preventDefault()
                  cancelHistorySearch()
                  return
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setHistorySearchIndex((index) =>
                    Math.min(index + 1, filteredHistory.length - 1)
                  )
                  return
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setHistorySearchIndex((index) => Math.max(index - 1, 0))
                  return
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault()
                  loadHistoryEntry(historySearchIndex)
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={historyCancelLabel}
              onClick={cancelHistorySearch}
            >
              {labels.cancel}
            </Button>
          </div>
          <div
            role="listbox"
            aria-label={historySearchLabel}
            className="mt-1 max-h-40 overflow-y-auto"
          >
            {filteredHistory.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                id={`history-entry-${entry.id}`}
                aria-selected={index === historySearchIndex}
                className="block w-full rounded-lg px-2 py-1.5 text-start text-sm hover:bg-muted"
                onClick={() => loadHistoryEntry(index)}
              >
                {entry.text}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <AuiIf
        condition={(s) =>
          s.thread.capabilities.queue && s.composer.queue.length > 0
        }
      >
        <div
          role="region"
          aria-label={queuedMessagesLabel}
          className="mb-2 flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/30 p-2"
        >
          <ComposerPrimitive.Queue>
            {() => (
              <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm">
                <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
                <QueueItemPrimitive.Remove
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={labels.cancel}
                    />
                  }
                >
                  {labels.cancel}
                </QueueItemPrimitive.Remove>
              </div>
            )}
          </ComposerPrimitive.Queue>
        </div>
      </AuiIf>
      <ComposerPrimitive.AttachmentDropzone
        render={
          <div
            data-slot="aui_composer-shell"
            className={cn(
              "relative flex w-full cursor-text flex-col gap-2 rounded-[24px] border border-border/60 bg-background p-2.5 transition-colors focus-within:border-border data-[dragging=true]:border-dashed data-[dragging=true]:border-ring data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:bg-popover @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:max-w-[45rem]"
            )}
          />
        }
      >
        <div className="contents" inert={voiceActive}>
          <ComposerAttachments />
        </div>
        <div
          data-slot="aui_composer-field"
          className="flex min-w-0 items-center px-3"
        >
          <VoiceComposerField>
            <ComposerPrimitive.Input
              placeholder={labels.composerPlaceholder}
              className="aui-composer-input max-h-36 min-w-0 flex-1 resize-none bg-transparent text-base leading-5 text-foreground/85 caret-primary outline-none placeholder:text-muted-foreground @min-[64rem]/workspace:max-h-48 @min-[64rem]/workspace:min-h-11 @min-[64rem]/workspace:w-full @min-[64rem]/workspace:px-3 @min-[64rem]/workspace:text-[15px] @min-[64rem]/workspace:leading-6"
              rows={1}
              autoFocus={autoFocus}
              enterKeyHint="send"
              submitMode="none"
              ref={inputRef}
              cancelOnEscape={false}
              onChange={() => {
                escapeRef.current = null
              }}
              onFocus={() => {
                escapeRef.current = null
              }}
              onBlur={() => {
                escapeRef.current = null
              }}
              onKeyDown={handleKeyDown}
              aria-label={labels.messageInput}
            />
          </VoiceComposerField>
        </div>
        <ComposerToolbar>
          <ComposerFeatureBar direction={direction} />
        </ComposerToolbar>
      </ComposerPrimitive.AttachmentDropzone>
      <VoiceComposerNotice />
    </ComposerPrimitive.Root>
  )
}

const ComposerFeatureBar: FC<{ direction: LocaleDirection }> = ({
  direction,
}) => {
  const features = useContext(ThreadComposerFeaturesContext)
  const labels = useContext(ThreadLabelsContext)
  if (!features.model && !features.context) return null

  return (
    <div
      data-slot="aui_composer-features"
      className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground"
    >
      {features.model ? (
        <ModelSelectorRoot
          direction={direction}
          models={features.model.options.map((option) => ({
            id: option.id,
            name: option.label,
            group: option.group,
          }))}
          value={features.model.selectedId}
          onValueChange={(value) => {
            void features.model?.select(value)
          }}
        >
          <ModelSelectorTrigger
            aria-label={labels.modelSelector}
            className="max-w-36 @min-[64rem]/workspace:max-w-56"
          />
          <ModelSelectorContent />
        </ModelSelectorRoot>
      ) : (
        <span />
      )}
      {features.context ? (
        <ComposerContext
          className="ms-auto"
          usage={features.context.usage}
          visibleSegments={features.context.segments}
          labels={{
            trigger: labels.contextUsage,
            title: labels.contextTitle,
            system: labels.contextSystem,
            tools: labels.contextTools,
            messages: labels.contextMessages,
            total: labels.contextTotal,
          }}
        />
      ) : null}
    </div>
  )
}

const ComposerToolbar: FC<PropsWithChildren> = ({ children }) => {
  const labels = useContext(ThreadLabelsContext)
  const onStopRun = useContext(ThreadStopContext)
  const voice = useVoiceContext()
  const voiceActive = useVoiceCaptureActive()
  return (
    <div
      data-slot="aui_composer-toolbar"
      className="aui-composer-action-wrapper flex w-full min-w-0 items-center gap-1"
    >
      <ComposerAddAttachment />
      {children}
      <div className="relative ms-auto flex shrink-0 items-center gap-1.5">
        <VoiceComposerControl />
        {!voiceActive ? (
          <>
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send
                render={
                  <button
                    type="button"
                    className="aui-composer-send grid size-11 shrink-0 place-items-center rounded-full bg-transparent disabled:pointer-events-none disabled:opacity-25 @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:bg-primary @min-[64rem]/workspace:text-primary-foreground"
                    aria-label={labels.sendMessage}
                  />
                }
              >
                <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground @min-[64rem]/workspace:contents">
                  <ArrowUpIcon className="aui-composer-send-icon size-4" />
                </span>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              {onStopRun ? (
                <Button
                  type="button"
                  className="aui-composer-cancel grid size-11 shrink-0 place-items-center rounded-full bg-transparent text-primary-foreground @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:bg-primary"
                  aria-label={labels.stopGenerating}
                  onClick={() => {
                    voice?.media.disarm()
                    onStopRun()
                  }}
                >
                  <span className="grid size-9 place-items-center rounded-full bg-primary @min-[64rem]/workspace:contents">
                    <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
                  </span>
                </Button>
              ) : (
                <ComposerPrimitive.Cancel
                  render={
                    <Button
                      type="button"
                      className="aui-composer-cancel grid size-11 shrink-0 place-items-center rounded-full bg-transparent text-primary-foreground @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:bg-primary"
                      aria-label={labels.stopGenerating}
                      onClick={() => voice?.media.disarm()}
                    />
                  }
                >
                  <span className="grid size-9 place-items-center rounded-full bg-primary @min-[64rem]/workspace:contents">
                    <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
                  </span>
                </ComposerPrimitive.Cancel>
              )}
            </AuiIf>
          </>
        ) : null}
      </div>
    </div>
  )
}

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive dark:bg-destructive/5 dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  )
}

const AssistantMessage: FC = () => {
  const reading = useVoiceMessageReading()
  const {
    AssistantIdentity,
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext)

  const ACTION_BAR_PT = "pt-1.5"
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative -mb-7.5 animate-in pb-7.5 duration-150 [contain-intrinsic-size:var(--workspace-message-contain-intrinsic-size,none)] [content-visibility:var(--workspace-message-content-visibility,visible)] fade-in slide-in-from-bottom-1 motion-reduce:transform-none motion-reduce:animate-none"
    >
      {AssistantIdentity ? <AssistantIdentity /> : null}
      <div
        data-slot="aui_assistant-message-content"
        className="px-2 leading-7 wrap-break-word text-foreground"
        dir="auto"
      >
        <InlineReadAloud />
        <MessagePrimitive.GroupedParts groupBy={ASSISTANT_MESSAGE_GROUPER}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                )
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  )
                }
                const running = part.status.type === "running"
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                )
              }
              case "text":
                return reading ? <></> : <MarkdownText />
              case "reasoning":
                return <Reasoning {...part} />
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />
              case "data":
                return part.dataRendererUI
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                )
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <MessageImage {...part} />
                  </div>
                )
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans motion-reduce:animate-none"
                    aria-hidden="true"
                  >
                    {"●"}
                  </span>
                )
              default:
                return null
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  )
}

const AssistantActionBar: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  const voice = useVoiceContext()
  const reading = useVoiceMessageReading()
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning={!reading}
      autohide="not-last"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ms-1 flex animate-in gap-1 text-muted-foreground duration-200 fade-in motion-reduce:animate-none"
    >
      <ActionBarPrimitive.Copy
        render={<TooltipIconButton tooltip={labels.copy} />}
      >
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="animate-in duration-200 ease-out zoom-in-50 fade-in motion-reduce:animate-none" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className="animate-in duration-150 zoom-in-75 fade-in motion-reduce:animate-none" />
        </AuiIf>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload
        onClick={() => {
          voice?.media.stopSpeech()
          voice?.media.disarm()
        }}
        render={<TooltipIconButton tooltip={labels.refresh} />}
      >
        <RefreshCwIcon />
      </ActionBarPrimitive.Reload>
      <VoiceMessageActions />
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger
          render={
            <TooltipIconButton
              tooltip={labels.more}
              className="data-[state=open]:bg-accent"
            />
          }
        >
          <MoreHorizontalIcon />
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content z-50 min-w-[8rem] overflow-hidden rounded-xl border bg-popover p-1.5 text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none"
        >
          <ActionBarPrimitive.ExportMarkdown
            render={
              <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground" />
            }
          >
            <DownloadIcon className="size-4" />
            {labels.exportMarkdown}
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  )
}

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
)

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <MessageImage {...part} />
  </div>
)

const USER_MESSAGE_PART_COMPONENTS = {
  File: UserFilePart,
  Image: UserImagePart,
}

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:var(--workspace-message-contain-intrinsic-size,none)] [content-visibility:var(--workspace-message-content-visibility,visible)] fade-in slide-in-from-bottom-1 motion-reduce:transform-none motion-reduce:animate-none [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div
          className="aui-user-message-content peer max-w-[30rem] rounded-xl bg-muted px-4 py-2 wrap-break-word text-foreground empty:hidden"
          dir="auto"
        >
          <MessagePrimitive.Parts components={USER_MESSAGE_PART_COMPONENTS} />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  )
}

const UserActionBar: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit
        render={
          <TooltipIconButton
            tooltip={labels.edit}
            className="aui-user-action-edit"
          />
        }
      >
        <PencilIcon />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  )
}

const EditComposer: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border border-border/60 bg-(--composer-bg) dark:border-muted-foreground/15">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base text-foreground outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3.5"
              />
            }
          >
            {labels.cancel}
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send
            render={<Button size="sm" className="h-8 rounded-full px-3.5" />}
          >
            {labels.update}
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root -ms-2 me-2 inline-flex items-center text-xs text-muted-foreground",
        className
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous
        render={<TooltipIconButton tooltip={labels.previous} />}
      >
        <ChevronLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next
        render={<TooltipIconButton tooltip={labels.next} />}
      >
        <ChevronRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  )
}
