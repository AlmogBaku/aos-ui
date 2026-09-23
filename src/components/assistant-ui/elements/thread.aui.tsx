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
import { usePendingInteractionGate } from "@/components/runtime-interactions/pending-interaction-context"
import { File } from "@/components/assistant-ui/elements/file"
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui"
import { Image as MessageImage } from "@/components/assistant-ui/elements/image"
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text"
import { Source } from "@/components/assistant-ui/elements/sources"
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui"
import { ToolRunGroup } from "@/components/assistant-ui/elements/message-tool-experience"
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui"
import {
  createTurnGroupBy,
  turnLayout,
} from "@/components/assistant-ui/elements/turn-fold"
import {
  TurnWorkingFold,
  TurnWorkingStatus,
  useInsideTurnFold,
} from "@/components/assistant-ui/elements/turn-working-fold"
import { isAosRichTool, useToolUiLocale } from "@/components/tool-ui"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import {
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
} from "@/components/assistant-ui/elements/model-selector"
import { ComposerContext } from "@/components/assistant-ui/elements/composer-context"
import { CompactionDataUI } from "@/components/assistant-ui/elements/compaction-divider"
import { ComposerSlashCommands } from "@/components/assistant-ui/elements/composer-slash-commands"
import {
  ConversationSearch,
  DEFAULT_CONVERSATION_SEARCH_LABELS,
  type ConversationSearchLabels,
} from "@/components/assistant-ui/elements/conversation-search"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SystemNotice } from "@/components/ui/system-notice"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { runErrorMessage } from "@/lib/i18n/run-errors"
import { cn } from "@/lib/utils"
import {
  isCollapsedCaretAtVisualLineBoundary,
  measureTextareaVisualLineBoundary,
  resolveComposerEnterAction,
  type ComposerEnterEvent,
} from "@/components/assistant-ui/elements/composer-keyboard"
import { keyboardEventSafetyReason } from "@/lib/keyboard"
import type { Locale, LocaleDirection } from "@/lib/i18n/config"
import {
  matchLocalCommand,
  menuSlashCommands,
  type ComposerFeatureViewModel,
  type ComposerModelEffort,
} from "@/components/assistant-ui/composer-features"
import {
  isUncertainDelivery,
  MessageQueue,
  type UnconfirmedDelivery,
} from "@/components/assistant-ui/elements/message-queue"
import {
  useMessageCopy,
  useMessageEdit,
  useMessageRetry,
} from "./message-actions"
import { MessageContextMenu } from "./message-context-menu"
import { useThreadReadingPosition } from "./thread-reading-position"
import {
  ThreadMessageList,
  type ThreadMessageListHandle,
} from "./thread-message-list"
import { useTouchPrimaryInput } from "./touch-primary"
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
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ThreadMessage,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type PartState,
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
  useEffect,
  useContext,
  useMemo,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type FC,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
} from "react"

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; `ToolFallback` overrides how the assistant
 * message renders a tool call. Tool UIs registered by name (toolkit `render`,
 * `useAssistantDataUI`) take precedence over `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined
  AssistantIdentity?: ComponentType | undefined
  BeforeComposer?: ComponentType | undefined
  Composer?: ComponentType<ThreadComposerOverrideProps> | undefined
  Welcome?: ComponentType | undefined
  ToolFallback?: ToolCallMessagePartComponent | undefined
}

export type ThreadComposerOverrideProps = {
  fallback: ReactNode
}

/**
 * How a retry or an edit replays a turn: `false` when the provider cannot
 * rewind at all, otherwise the run configuration that names the user turn to
 * replay from.
 */
export type MessageRewind =
  | false
  | {
      runConfig(sourceUserId: string): {
        custom: Record<string, unknown>
      }
    }

export type ThreadProps = {
  components?: ThreadComponents | undefined
  autoFocus?: boolean | undefined
  labels?: Partial<ThreadLabels> | undefined
  direction?: LocaleDirection | undefined
  composerFeatures?: ComposerFeatureViewModel | undefined
  messageRewind?: MessageRewind | undefined
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
  queueMessage: string
  stopGenerating: string
  assistantWorking: string
  copy: string
  refresh: string
  more: string
  exportMarkdown: string
  edit: string
  selectText: string
  pendingInteractionAction: string
  cancel: string
  update: string
  historySearch?: string | undefined
  historySearchPlaceholder?: string | undefined
  historyCancel?: string | undefined
  queuedMessages?: string | undefined
  steerQueuedMessage?: string | undefined
  steerQueuedMessageLabel?: string | undefined
  removeQueuedMessage?: string | undefined
  steeringQueuedMessage?: string | undefined
  steeringFailed?: string | undefined
  deliveryUnconfirmed?: string | undefined
  previous: string
  next: string
  conversationHeading?: string | undefined
  modelSelector: string
  modelSearch: string
  modelSearchPlaceholder: string
  modelEmpty: string
  modelSwitching: string
  modelRetry: string
  effortSelector: string
  effortLevels: Record<string, string>
  effortUnset: string
  slashCommands?: string | undefined
  contextUsage: string
  contextTitle: string
  contextSystem: string
  contextTools: string
  contextMessages: string
  contextTotal: string
  contextLastTurn: string
  contextSessionCost: string
  /** Each receives an already locale-formatted token count. */
  contextInputTokens: (count: string) => string
  contextOutputTokens: (count: string) => string
  contextCachedTokens: (count: string) => string
  openSource: string
  documentSource: string
  conversationSearch?: Partial<ConversationSearchLabels> | undefined
  attachments?: Partial<AttachmentLabels> | undefined
}

/** Effort ids are provider-reported; unknown ids fall back to the raw id. */
const DEFAULT_EFFORT_LEVEL_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}

/**
 * A ladder id keeps its localized name; an effort outside the ladder shows the
 * name its provider gave, and failing that its raw id.
 */
function effortLevelNames(
  localized: Record<string, string>,
  efforts: readonly ComposerModelEffort[]
): Record<string, string> {
  return Object.fromEntries(
    efforts.map(({ id, name }) => [
      id,
      (Object.hasOwn(localized, id) ? localized[id] : name) ?? id,
    ])
  )
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
  queueMessage: "Queue message",
  stopGenerating: "Stop generating",
  assistantWorking: "Assistant is working",
  copy: "Copy",
  refresh: "Refresh",
  more: "More",
  exportMarkdown: "Export as Markdown",
  edit: "Edit",
  selectText: "Select text",
  pendingInteractionAction:
    "Answer the pending question before changing this conversation",
  cancel: "Cancel",
  update: "Update",
  historySearch: "Search conversation history",
  historySearchPlaceholder: "Filter sent messages…",
  historyCancel: "Cancel history search",
  queuedMessages: "Queued messages",
  steerQueuedMessage: "Steer",
  steerQueuedMessageLabel: "Steer queued message",
  removeQueuedMessage: "Remove queued message",
  steeringQueuedMessage: "Steering queued message",
  steeringFailed: "Could not steer",
  deliveryUnconfirmed: "Delivery unconfirmed",
  previous: "Previous",
  next: "Next",
  conversationHeading: "Conversation",
  modelSelector: "Choose model",
  modelSearch: "Search models",
  modelSearchPlaceholder: "Search models…",
  modelEmpty: "No models found.",
  modelSwitching: "Switching model…",
  modelRetry: "Retry model selection",
  effortSelector: "Thinking",
  effortLevels: DEFAULT_EFFORT_LEVEL_LABELS,
  effortUnset: "Default",
  slashCommands: "Slash commands",
  contextUsage: "Context usage",
  contextTitle: "Context",
  contextSystem: "System",
  contextTools: "Tools",
  contextMessages: "Messages",
  contextTotal: "Total",
  contextLastTurn: "Last turn",
  contextSessionCost: "Session cost",
  contextInputTokens: (count) => `${count} in`,
  contextOutputTokens: (count) => `${count} out`,
  contextCachedTokens: (count) => `${count} cached`,
  openSource: "Open source",
  documentSource: "Source document",
  conversationSearch: DEFAULT_CONVERSATION_SEARCH_LABELS,
  attachments: DEFAULT_ATTACHMENT_LABELS,
}

export const THREAD_VIEWPORT_SCROLL_BEHAVIOR = {
  autoScroll: false,
  scrollToBottomOnInitialize: false,
  scrollToBottomOnThreadSwitch: false,
  turnAnchor: "bottom",
} as const

const EMPTY_COMPONENTS: ThreadComponents = {}

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS)
const ThreadLabelsContext = createContext<ThreadLabels>(DEFAULT_LABELS)
/** Messages take no props, and a portalled surface has to set `dir` itself. */
const ThreadDirectionContext = createContext<LocaleDirection>("ltr")
const MessageRewindContext = createContext<MessageRewind | undefined>(undefined)
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

const NO_PARTS: readonly PartState[] = []

/**
 * Nothing folds while a turn runs, so the running case needs no part positions
 * and this selector holds one value across every streaming update; a settled
 * turn's parts no longer change, so its array identity is stable too.
 */
const selectTurnParts = (state: AssistantState) =>
  state.message.status?.type === "running" ? NO_PARTS : state.message.parts

const selectTurnStatus = (state: AssistantState) => state.message.status?.type

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
  composerFeatures = {},
  messageRewind,
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
      <ThreadDirectionContext.Provider value={direction}>
        <AttachmentLabelsContext.Provider value={localizedAttachmentLabels}>
          <MessageRewindContext.Provider value={messageRewind}>
            <ThreadComposerFeaturesContext.Provider value={composerFeatures}>
              <ThreadComponentsContext.Provider value={components}>
                <CompactionDataUI />
                <ThreadRoot
                  isEmpty={isEmpty}
                  autoFocus={autoFocus}
                  direction={direction}
                />
              </ThreadComponentsContext.Provider>
            </ThreadComposerFeaturesContext.Provider>
          </MessageRewindContext.Provider>
        </AttachmentLabelsContext.Provider>
      </ThreadDirectionContext.Provider>
    </ThreadLabelsContext.Provider>
  )
}

/**
 * Overlay surfaces that own Escape themselves. Each entry is the role the
 * surface publishes, so the guard never depends on a library's private markup.
 */
const OVERLAY_SURFACE_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="combobox"][aria-expanded="true"]',
].join(", ")

/**
 * Whether an Escape keydown was aimed at the conversation rather than at an
 * overlay: the key has to land on the Thread's own DOM (a portaled popover or
 * dialog fails this even though its React events still bubble here) and not
 * inside an overlay surface that dismisses itself on the same keypress.
 */
function escapeAimsAtConversation(event: KeyboardEvent<HTMLDivElement>) {
  const root = event.currentTarget
  const target = event.target
  if (!(target instanceof Element) || !root.contains(target)) return false
  for (
    let node: Element | null = target;
    node !== null && node !== root;
    node = node.parentElement
  ) {
    if (node.matches(OVERLAY_SURFACE_SELECTOR)) return false
  }
  return true
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
  const viewportRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<ThreadMessageListHandle>(null)
  const threadId = useAuiState((state) => state.threadListItem.id)
  const contentReady = useAuiState((state) => !state.thread.isLoading)
  const readingPosition = useThreadReadingPosition({
    threadId,
    contentReady,
    viewportRef,
  })
  // A virtualized thread only knows its full height once the newest messages
  // are measured, so a jump to the latest content follows it rather than
  // aiming at a height that is still an estimate.
  const followLatest = useCallback(() => {
    if (threadId) readingPosition.follow(threadId)
  }, [readingPosition, threadId])
  useAuiEvent("thread.runStart", followLatest)
  const revealMessage = useCallback(
    (messageId: string) =>
      messageListRef.current?.revealMessage(messageId) ?? true,
    []
  )

  const handleThreadKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        keyboardEventSafetyReason(event) ||
        !escapeAimsAtConversation(event)
      ) {
        return
      }
      if (!aui.thread.getState().isRunning) return
      event.preventDefault()
      aui.thread.cancelRun()
    },
    [aui]
  )

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background [--composer-padding:0.25rem] [--composer-radius:0.75rem] @md:[--composer-padding:0.5rem] @md:[--composer-radius:1.5rem]"
      style={{
        ["--thread-max-width" as string]: "96rem",
        ["--thread-content-max-width" as string]: "clamp(52rem, 80cqi, 96rem)",
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
        {...THREAD_VIEWPORT_SCROLL_BEHAVIOR}
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth motion-reduce:scroll-auto"
        onKeyDown={handleThreadKeyDown}
      >
        <ThreadConversationSearch
          direction={direction}
          revealMessage={revealMessage}
          viewportRef={viewportRef}
          labels={labels.conversationSearch}
        />
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-3 pt-4 @md:px-8 @md:pt-6",
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

          <ThreadMessageList
            ref={messageListRef}
            viewportRef={viewportRef}
            components={THREAD_MESSAGE_COMPONENTS}
            className="mx-auto mb-8 w-full max-w-(--thread-content-max-width) empty:hidden @md:mb-10"
          />

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer flex flex-col gap-2 overflow-visible bg-background pb-[max(0.5rem,env(safe-area-inset-bottom))] @md:gap-3 @md:pb-4",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)"
            )}
          >
            <ThreadScrollToBottom onClick={followLatest} />
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

/** `ThreadMessage` picks the role and the edit composer itself. */
const THREAD_MESSAGE_COMPONENTS = { Message: ThreadMessage }

/**
 * Search reads the loaded messages; subscribing here keeps a streaming token
 * from re-rendering the whole Thread root.
 */
const ThreadConversationSearch: FC<{
  direction: LocaleDirection
  revealMessage: (messageId: string) => boolean
  viewportRef: RefObject<HTMLElement | null>
  labels: Partial<ConversationSearchLabels> | undefined
}> = ({ direction, revealMessage, viewportRef, labels }) => {
  const messages = useAuiState((state) => state.thread.messages)
  return (
    <ConversationSearch
      messages={messages}
      direction={direction}
      revealMessage={revealMessage}
      viewportRef={viewportRef}
      labels={{ ...DEFAULT_CONVERSATION_SEARCH_LABELS, ...labels }}
    />
  )
}

const ThreadScrollToBottom: FC<{ onClick: () => void }> = ({ onClick }) => {
  const labels = useContext(ThreadLabelsContext)
  return (
    <ThreadPrimitive.ScrollToBottom
      onClick={onClick}
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

type UnconfirmedDeliveryReceipt = UnconfirmedDelivery & {
  readonly knownUserMessageIds: readonly string[]
}

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
  const features = useContext(ThreadComposerFeaturesContext)
  const hasPendingInteraction = usePendingInteractionGate()
  const isTouchPrimaryInput = useTouchPrimaryInput()
  const aui = useAui()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const submissionLockRef = useRef(false)
  const escapeRef = useRef<number | null>(null)
  const clearUndoRef = useRef<RecoverableDraft | null>(null)
  const searchSnapshotRef = useRef<RecoverableDraft | null>(null)
  const historyBrowseRef = useRef<HistoryBrowse | null>(null)
  const [inputFocused, setInputFocused] = useState(false)
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [historySearchQuery, setHistorySearchQuery] = useState("")
  const [historySearchIndex, setHistorySearchIndex] = useState(0)
  const [steeringError, setSteeringError] = useState<string>()
  const [unconfirmedDeliveries, setUnconfirmedDeliveries] = useState<
    UnconfirmedDeliveryReceipt[]
  >([])
  const selectHistoryEntries = useMemo(
    () => createComposerHistorySelector(),
    []
  )
  const historyEntries = useAuiState((s) =>
    selectHistoryEntries(s.thread.messages)
  )
  const triggerPopover = unstable_useTriggerPopoverRootContextOptional()

  useAuiEvent("threads.selectionChanged", () => {
    submissionLockRef.current = false
    clearUndoRef.current = null
    searchSnapshotRef.current = null
    historyBrowseRef.current = null
    setHistorySearchOpen(false)
    setHistorySearchQuery("")
    setHistorySearchIndex(0)
    setSteeringError(undefined)
    setUnconfirmedDeliveries([])
  })

  const submitOrdinary = useCallback(() => {
    if (voice?.media.captureActive || voiceActive) return
    setSteeringError(undefined)
    const draft = aui.composer.getState()
    // A local command is the workspace's to run, so the draft that invoked it
    // is consumed here and never becomes a turn. An attachment is content the
    // command has no place for, so that draft is sent as written.
    const local =
      draft.attachments.length === 0
        ? matchLocalCommand(draft.text, features.localCommands)
        : undefined
    if (local) {
      void aui.composer.reset()
      void local.command.run(local.args)
      return
    }
    aui.composer.send({ steer: false })
  }, [aui, features.localCommands, voice?.media.captureActive, voiceActive])

  const rememberUnconfirmed = useCallback(
    (delivery: UnconfirmedDelivery) => {
      const knownUserMessageIds = aui.thread
        .getState()
        .messages.filter((message) => message.role === "user")
        .map((message) => message.id)
      setUnconfirmedDeliveries((current) =>
        current.some(({ requestId }) => requestId === delivery.requestId)
          ? current
          : [...current, { ...delivery, knownUserMessageIds }]
      )
    },
    [aui]
  )

  const visibleUnconfirmedDeliveries = useMemo(
    () =>
      unconfirmedDeliveries.filter(
        (delivery) =>
          !historyEntries.some(
            (entry) =>
              !delivery.knownUserMessageIds.includes(entry.id) &&
              entry.text === delivery.text
          )
      ),
    [historyEntries, unconfirmedDeliveries]
  )

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

      // Let Assistant UI select completion before the custom Send shortcut.
      if (event.key === "Enter" && triggerPopover?.getActiveAria() != null)
        return

      const action = resolveComposerEnterAction(
        event as unknown as ComposerEnterEvent,
        {
          isRunning: aui.thread.getState().isRunning,
          hasQueue: aui.thread.getState().capabilities.queue === true,
          isEmpty: aui.composer.getState().isEmpty,
          plainEnterSends: !isTouchPrimaryInput,
          canSteer: features.steer !== undefined && !hasPendingInteraction,
          hasAttachments: aui.composer.getState().attachments.length > 0,
        }
      )
      if (action === "noop" || action === "newline") return

      event.preventDefault()
      if (submissionLockRef.current) return
      submissionLockRef.current = true
      if (action === "send" || action === "queue") {
        submitOrdinary()
        queueMicrotask(() => {
          submissionLockRef.current = false
        })
        return
      }

      const snapshot = aui.composer.getState()
      const text = snapshot.text
      const requestId = crypto.randomUUID()
      const originThreadId = aui.threads.getState().mainThreadId
      setSteeringError(undefined)
      void features.steer!({ requestId, text })
        .then(() => {
          if (aui.threads.getState().mainThreadId !== originThreadId) return
          const current = aui.composer.getState()
          if (current.text === text && current.attachments.length === 0)
            void aui.composer.reset()
        })
        .catch((error: unknown) => {
          if (aui.threads.getState().mainThreadId !== originThreadId) return
          if (
            error &&
            typeof error === "object" &&
            (error as { code?: unknown }).code === "turn_conflict"
          ) {
            submitOrdinary()
            return
          }
          if (isUncertainDelivery(error)) {
            const current = aui.composer.getState()
            if (current.text === text && current.attachments.length === 0)
              void aui.composer.reset()
            rememberUnconfirmed({ requestId, text })
            return
          }
          setSteeringError(labels.steeringFailed ?? "Could not steer")
        })
        .finally(() => {
          if (aui.threads.getState().mainThreadId === originThreadId)
            submissionLockRef.current = false
        })
    },
    [
      aui,
      focusInput,
      historyEntries,
      isTouchPrimaryInput,
      openHistorySearch,
      features,
      hasPendingInteraction,
      labels.steeringFailed,
      rememberUnconfirmed,
      restoreDraft,
      submitOrdinary,
      triggerPopover,
    ]
  )

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative -mx-2 flex w-[calc(100%+1rem)] flex-col @md:-mx-7 @md:w-[calc(100%+3.5rem)] @min-[64rem]/workspace:mx-0 @min-[64rem]/workspace:w-full"
      onSubmit={(event) => {
        event.preventDefault()
        submitOrdinary()
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
        <MessageQueue
          labels={{
            region: queuedMessagesLabel,
            steer: labels.steerQueuedMessage ?? "Steer",
            steerLabel:
              labels.steerQueuedMessageLabel ?? "Steer queued message",
            removeLabel: labels.removeQueuedMessage ?? "Remove queued message",
            steering: labels.steeringQueuedMessage ?? "Steering queued message",
            failed: labels.steeringFailed ?? "Could not steer",
          }}
          steer={hasPendingInteraction ? undefined : features.steer}
          onUnconfirmed={rememberUnconfirmed}
        />
      </AuiIf>
      {visibleUnconfirmedDeliveries.map((delivery) => (
        <div
          key={delivery.requestId}
          data-slot="aui_delivery-unconfirmed"
          role="status"
          aria-live="polite"
          className="mb-1.5 flex min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          <span className="shrink-0 font-medium">
            {labels.deliveryUnconfirmed ?? "Delivery unconfirmed"}
          </span>
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {delivery.text}
          </span>
        </div>
      ))}
      {steeringError ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-1.5 px-3 text-sm text-destructive"
        >
          {steeringError}
        </div>
      ) : null}
      <ComposerPrimitive.AttachmentDropzone
        render={
          <div
            data-slot="aui_composer-shell"
            className={cn(
              "relative flex w-full cursor-text flex-col gap-2 rounded-[24px] border border-border/60 bg-background p-2.5 transition-colors focus-within:border-border data-[dragging=true]:border-dashed data-[dragging=true]:border-ring data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:max-w-(--thread-content-max-width) dark:bg-popover"
            )}
          />
        }
      >
        <div className="contents" inert={voiceActive}>
          <ThreadSlashCommands />
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
              enterKeyHint="enter"
              submitMode="none"
              ref={inputRef}
              cancelOnEscape={false}
              onChange={() => {
                escapeRef.current = null
              }}
              onFocus={() => {
                escapeRef.current = null
                setInputFocused(true)
              }}
              onBlur={() => {
                escapeRef.current = null
                setInputFocused(false)
              }}
              onKeyDown={handleKeyDown}
              aria-label={labels.messageInput}
            />
          </VoiceComposerField>
        </div>
        <ComposerToolbar onSend={submitOrdinary} inputFocused={inputFocused}>
          <ComposerFeatureBar direction={direction} />
        </ComposerToolbar>
      </ComposerPrimitive.AttachmentDropzone>
      <VoiceComposerNotice />
    </ComposerPrimitive.Root>
  )
}

const ThreadSlashCommands: FC = () => {
  const features = useContext(ThreadComposerFeaturesContext)
  const labels = useContext(ThreadLabelsContext)
  const commands = useMemo(() => menuSlashCommands(features), [features])
  return (
    <ComposerSlashCommands
      commands={commands}
      label={labels.slashCommands ?? "Slash commands"}
    />
  )
}

const NO_MODEL_FEED = () => () => undefined
const NO_MODEL_READING = () => undefined

/**
 * The provider's newest report of the Session's model, which the selector
 * follows unless a pick of the operator's own is still being written.
 */
function useFollowedModel(model: ComposerFeatureViewModel["model"]) {
  const follow = model?.follow
  const current = useSyncExternalStore(
    follow?.subscribe ?? NO_MODEL_FEED,
    follow?.current ?? NO_MODEL_READING,
    follow?.current ?? NO_MODEL_READING
  )
  return model?.selection?.status === "pending" ? undefined : current
}

const ComposerFeatureBar: FC<{ direction: LocaleDirection }> = ({
  direction,
}) => {
  const features = useContext(ThreadComposerFeaturesContext)
  const labels = useContext(ThreadLabelsContext)
  const modelOptions = features.model?.options
  const models = useMemo(
    () =>
      (modelOptions ?? []).map((option) => ({
        id: option.id,
        name: option.label,
        description: option.description,
        group: option.group,
      })),
    [modelOptions]
  )
  const { locale } = useToolUiLocale()
  const followed = useFollowedModel(features.model)
  if (!features.model && !features.context) return null

  const selectedId = followed?.selectedId ?? features.model?.selectedId
  const effortId = followed ? followed.effortId : features.model?.effortId
  const selectedModel = modelOptions?.find((option) => option.id === selectedId)
  const efforts = selectedModel?.efforts
  const update = features.model?.update

  return (
    <div
      data-slot="aui_composer-features"
      className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground"
    >
      {features.model ? (
        <ModelSelectorRoot
          direction={direction}
          labels={{
            placeholder: labels.modelSelector,
            search: labels.modelSearch,
            searchPlaceholder: labels.modelSearchPlaceholder,
            empty: labels.modelEmpty,
            switching: labels.modelSwitching,
            retry: labels.modelRetry,
            effort: labels.effortSelector,
            effortLevels: effortLevelNames(labels.effortLevels, efforts ?? []),
            effortUnset: labels.effortUnset,
          }}
          models={models}
          value={selectedId ?? features.model.selectedId}
          selection={
            features.model.selection?.status === "error"
              ? {
                  status: "error",
                  error: features.model.selection.error,
                  retry: features.model.retry,
                }
              : features.model.selection
          }
          onValueChange={(selectedId) => {
            void update?.({ selectedId })
          }}
          {...(update && efforts?.length
            ? {
                efforts: efforts.map(({ id }) => id),
                effortValue: effortId,
                onEffortChange: (effortId: string) => {
                  void update({ effortId })
                },
              }
            : {})}
        >
          <ModelSelectorTrigger aria-label={labels.modelSelector} />
          <ModelSelectorContent />
        </ModelSelectorRoot>
      ) : (
        <span />
      )}
      {features.context ? (
        <ComposerContext
          className="ms-auto shrink-0"
          usage={features.context.usage}
          visibleSegments={features.context.segments}
          lastTurn={features.context.lastTurn}
          cost={features.context.cost}
          locale={locale}
          labels={{
            trigger: labels.contextUsage,
            title: labels.contextTitle,
            system: labels.contextSystem,
            tools: labels.contextTools,
            messages: labels.contextMessages,
            total: labels.contextTotal,
            lastTurn: labels.contextLastTurn,
            sessionCost: labels.contextSessionCost,
            inputTokens: labels.contextInputTokens,
            outputTokens: labels.contextOutputTokens,
            cachedTokens: labels.contextCachedTokens,
          }}
        />
      ) : null}
    </div>
  )
}

const ComposerToolbar: FC<
  PropsWithChildren<{ onSend(): void; inputFocused: boolean }>
> = ({ children, onSend, inputFocused }) => {
  const labels = useContext(ThreadLabelsContext)
  const voice = useVoiceContext()
  const voiceActive = useVoiceCaptureActive()
  const isRunning = useAuiState((state) => state.thread.isRunning)
  const canQueue = useAuiState(
    (state) =>
      state.thread.capabilities.queue === true &&
      state.composer.text.trim().length > 0
  )
  const canSend = useAuiState((state) => state.composer.canSend)
  const showQueue = isRunning && inputFocused && canQueue
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
            {!isRunning ? (
              <button
                type="button"
                className="aui-composer-send grid size-11 shrink-0 place-items-center rounded-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-25 @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:bg-primary @min-[64rem]/workspace:text-primary-foreground"
                aria-label={labels.sendMessage}
                disabled={!canSend}
                onClick={onSend}
              >
                <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground @min-[64rem]/workspace:contents">
                  <ArrowUpIcon className="aui-composer-send-icon size-4" />
                </span>
              </button>
            ) : showQueue ? (
              <button
                type="button"
                className="aui-composer-send grid size-11 shrink-0 place-items-center rounded-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-25 @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:bg-primary @min-[64rem]/workspace:text-primary-foreground"
                aria-label={labels.queueMessage}
                disabled={!canSend}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onSend}
              >
                <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground @min-[64rem]/workspace:contents">
                  <ArrowUpIcon className="aui-composer-send-icon size-4" />
                </span>
              </button>
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
          </>
        ) : null}
      </div>
    </div>
  )
}

const RUN_FAILURE_DICTIONARIES: Record<Locale, Dictionary> = { en, he }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The failure a turn carries, read into one shape. A live run reports the
 * normalized `AOS_*` code beside the provider's own description; a turn replayed
 * from durable history carries only that description, as a plain string.
 */
function turnFailure(state: AssistantState): {
  code?: string
  message?: string
  attribution?: string
} {
  const status = state.message.status
  if (status?.type !== "incomplete" || status.reason !== "error") return {}
  const error: unknown = status.error
  if (typeof error === "string") return { message: error }
  if (!isRecord(error)) return {}
  const attribution = [error.provider, error.model]
    .filter((value): value is string => typeof value === "string" && !!value)
    .join(" · ")
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(attribution ? { attribution } : {}),
  }
}

const turnFailureCode = (state: AssistantState) => turnFailure(state).code
const turnFailureMessage = (state: AssistantState) => turnFailure(state).message
const turnFailureAttribution = (state: AssistantState) =>
  turnFailure(state).attribution

/**
 * A failed turn is AOS reporting on the run, never the Agent's own words, so it
 * renders as a System Notice: the normalized code carries the localized
 * headline, and the provider's description stays beside it as detail.
 */
const MessageErrorNotice: FC = () => {
  const { locale } = useToolUiLocale()
  const code = useAuiState(turnFailureCode)
  const message = useAuiState(turnFailureMessage)
  const attribution = useAuiState(turnFailureAttribution)
  const dictionary = RUN_FAILURE_DICTIONARIES[locale]
  const title = runErrorMessage(
    dictionary,
    code,
    message ?? dictionary.turnFailed
  )
  return (
    <SystemNotice
      tone="error"
      title={title}
      {...(message !== undefined && message !== title
        ? { detail: message }
        : {})}
      {...(attribution ? { attribution } : {})}
      locale={locale}
      className="mt-2"
    />
  )
}

/** The incomplete reasons where the model, not the run, ended the answer. */
const turnStopKind = (
  state: AssistantState
): keyof Dictionary["turnStopped"] | undefined => {
  const status = state.message.status
  if (status?.type !== "incomplete") return undefined
  if (status.reason === "length") return "length"
  return status.reason === "content-filter" ? "contentFilter" : undefined
}

/**
 * An answer the model cut short or declined is still the Agent's, so its text
 * stays; AOS only says, under it, why it ends where it does.
 */
const MessageStopNotice: FC = () => {
  const { locale } = useToolUiLocale()
  const kind = useAuiState(turnStopKind)
  if (!kind) return null
  return (
    <SystemNotice
      tone="warning"
      title={RUN_FAILURE_DICTIONARIES[locale].turnStopped[kind]}
      locale={locale}
      className="mt-2"
    />
  )
}

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <MessageErrorNotice />
    </MessagePrimitive.Error>
  )
}

/**
 * Reasoning as its own disclosure, whether it sits inside the turn's fold or
 * trails the answer. It holds itself open while its own parts stream.
 */
const TurnReasoning: FC<PropsWithChildren<{ indices: readonly number[] }>> = ({
  indices,
  children,
}) => {
  const streaming = useAuiState(
    (state) =>
      state.message.status?.type === "running" &&
      indices.some(
        (index) => state.message.parts[index]?.status.type === "running"
      )
  )
  return (
    <ReasoningRoot variant="ghost" className="mb-0" streaming={streaming}>
      <ReasoningTrigger active={streaming} />
      <ReasoningContent aria-busy={streaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  )
}

/** Mid-turn prose is trace; the turn's final answer is its answer. */
const TurnText: FC = () => {
  const inFold = useInsideTurnFold()
  return (
    <div
      className={cn("contents", inFold && "text-muted-foreground")}
      data-searchable-message-text
    >
      <MarkdownText />
    </div>
  )
}

const AssistantMessage: FC = () => {
  const reading = useVoiceMessageReading()
  const completedWithoutContent = useAuiState(
    (state) =>
      state.message.status?.type === "complete" &&
      state.message.content.length === 0
  )
  const turnParts = useAuiState(selectTurnParts)
  const turnStatus = useAuiState(selectTurnStatus)
  const groupBy = useMemo(
    () => createTurnGroupBy(turnParts, turnLayout(turnParts, turnStatus)),
    [turnParts, turnStatus]
  )
  const labels = useContext(ThreadLabelsContext)
  const direction = useContext(ThreadDirectionContext)
  const messageRewind = useContext(MessageRewindContext)
  const {
    AssistantIdentity,
    ToolFallback: ToolFallbackComponent = ToolFallback,
  } = useContext(ThreadComponentsContext)
  const entrance = useMessageEntrance()

  const ACTION_BAR_PT = "pt-1.5"
  // Keep the action bar inside the root's box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`

  if (completedWithoutContent) return null

  return (
    <MessageContextMenu
      role="assistant"
      labels={labels}
      messageRewind={messageRewind}
      dir={direction}
    >
      <MessagePrimitive.Root
        data-slot="aui_assistant-message-root"
        data-role="assistant"
        className={cn("relative -mb-7.5 pb-7.5", entrance)}
      >
        {AssistantIdentity ? <AssistantIdentity /> : null}
        <div
          data-slot="aui_assistant-message-content"
          className="px-2 leading-7 wrap-break-word text-foreground"
          dir="auto"
        >
          <div
            className="contents"
            data-searchable-message-text={reading ? "" : undefined}
          >
            <InlineReadAloud />
          </div>
          <TurnWorkingStatus />
          <MessagePrimitive.GroupedParts groupBy={groupBy}>
            {({ part, children }) => {
              switch (part.type) {
                case "group-working":
                  return (
                    <TurnWorkingFold indices={part.indices}>
                      {children}
                    </TurnWorkingFold>
                  )
                case "group-tool":
                  return (
                    <ToolRunGroup
                      renderTool={ToolFallbackComponent}
                      indices={part.indices}
                    />
                  )
                case "group-reasoning":
                  return (
                    <TurnReasoning indices={part.indices}>
                      {children}
                    </TurnReasoning>
                  )
                case "text":
                  return reading ? <></> : <TurnText />
                case "reasoning":
                  return <MarkdownText />
                case "tool-call":
                  return (part.toolUI ?? isAosRichTool(part)) ? (
                    <div className="-mx-2 py-2">
                      {part.toolUI ?? <ToolFallbackComponent {...part} />}
                    </div>
                  ) : null
                case "data":
                  return <div className="-mx-2">{part.dataRendererUI}</div>
                case "file":
                  return (
                    <div
                      data-slot="aui_assistant-message-file"
                      className="py-1"
                    >
                      <File {...part} />
                    </div>
                  )
                case "image":
                  return (
                    <div
                      data-slot="aui_assistant-message-image"
                      className="py-1"
                    >
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
          <MessagePrimitive.Parts>
            {({ part }) => {
              // MessagePrimitive.Parts falls back to its default renderer for
              // null. Return false so non-source parts are not rendered twice.
              if (part.type !== "source") return false
              return (
                <div data-slot="aui_assistant-message-source" className="py-1">
                  <Source
                    {...part}
                    labels={{
                      openSource: labels.openSource,
                      documentSource: labels.documentSource,
                    }}
                  />
                </div>
              )
            }}
          </MessagePrimitive.Parts>
          <MessageError />
          <MessageStopNotice />
        </div>

        <div
          data-slot="aui_assistant-message-footer"
          className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
        >
          <BranchPicker />
          <AssistantActionBar />
        </div>
      </MessagePrimitive.Root>
    </MessageContextMenu>
  )
}

const AssistantActionBar: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  const messageRewind = useContext(MessageRewindContext)
  const hasPendingInteraction = usePendingInteractionGate()
  const reading = useVoiceMessageReading()
  const copy = useMessageCopy()
  const retry = useMessageRetry(messageRewind)
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning={!reading}
      autohide="not-last"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ms-1 flex animate-in items-center gap-1 text-muted-foreground duration-200 fade-in motion-reduce:animate-none"
    >
      <ActionBarPrimitive.Copy
        onClick={(event) => {
          // The shared action owns the clipboard, so the menu copies the same
          // text through the same fallback.
          event.preventDefault()
          copy.copy()
        }}
        render={<TooltipIconButton tooltip={labels.copy} />}
      >
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="animate-in duration-200 ease-out zoom-in-50 fade-in motion-reduce:animate-none" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className="animate-in duration-150 zoom-in-75 fade-in motion-reduce:animate-none" />
        </AuiIf>
      </ActionBarPrimitive.Copy>
      {messageRewind !== false ? (
        <ActionBarPrimitive.Reload
          disabled={retry.disabled}
          onClick={(event) => {
            event.preventDefault()
            retry.retry()
          }}
          render={
            <TooltipIconButton
              tooltip={
                hasPendingInteraction
                  ? labels.pendingInteractionAction
                  : labels.refresh
              }
            />
          }
        >
          <RefreshCwIcon />
        </ActionBarPrimitive.Reload>
      ) : null}
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

/**
 * Only the newest message slides in. A virtualized thread mounts older
 * messages as the reader scrolls to them, and those must simply be there.
 */
function useMessageEntrance() {
  const isLast = useAuiState((state) => state.message.isLast)
  return isLast
    ? "animate-in duration-150 fade-in slide-in-from-bottom-1 motion-reduce:transform-none motion-reduce:animate-none"
    : undefined
}

const USER_MESSAGE_PART_COMPONENTS = {
  // The user's own words render through the same Markdown mechanism and the
  // same body type scale as the assistant's, so neither role carries its own
  // typography or a second text renderer.
  Text: MarkdownText,
  File: UserFilePart,
  Image: UserImagePart,
}

const UserMessage: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  const direction = useContext(ThreadDirectionContext)
  const messageRewind = useContext(MessageRewindContext)
  const entrance = useMessageEntrance()
  return (
    <MessageContextMenu
      role="user"
      labels={labels}
      messageRewind={messageRewind}
      dir={direction}
    >
      <MessagePrimitive.Root
        data-slot="aui_user-message-root"
        className={cn(
          "grid auto-rows-auto grid-cols-[minmax(72px,1fr)_minmax(0,auto)] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2",
          entrance
        )}
        data-role="user"
      >
        <UserMessageAttachments />

        <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
          <div
            data-searchable-message-text
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
    </MessageContextMenu>
  )
}

const UserActionBar: FC = () => {
  const labels = useContext(ThreadLabelsContext)
  const messageRewind = useContext(MessageRewindContext)
  const hasPendingInteraction = usePendingInteractionGate()
  const edit = useMessageEdit()
  if (messageRewind === false) return null
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit
        disabled={edit.disabled}
        onClick={(event) => {
          event.preventDefault()
          edit.edit()
        }}
        render={
          <TooltipIconButton
            tooltip={
              hasPendingInteraction
                ? labels.pendingInteractionAction
                : labels.edit
            }
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
  const messageRewind = useContext(MessageRewindContext)
  const isTouchPrimaryInput = useTouchPrimaryInput()
  const sourceId = useAuiState((state) => state.message.id)
  const aui = useAui()
  useEffect(() => {
    if (!messageRewind) return
    aui.composer.setRunConfig(messageRewind.runConfig(sourceId))
  }, [aui, messageRewind, sourceId])
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border border-border/60 bg-(--composer-bg) dark:border-muted-foreground/15">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base text-foreground outline-none"
          autoFocus
          enterKeyHint="enter"
          submitMode={isTouchPrimaryInput ? "ctrlEnter" : "enter"}
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
