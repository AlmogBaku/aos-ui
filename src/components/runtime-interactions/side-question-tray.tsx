"use client"

import { TextMessagePartProvider, useAuiState } from "@assistant-ui/react"
import { AlertCircle, Check, CircleHelp, LoaderCircle, X } from "lucide-react"
import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react"

import { markdownPlainText } from "@/components/assistant-ui/elements/conversation-search"
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text"
import { useToolUiLocale } from "@/components/tool-ui/locale"
import { formatDuration } from "@/components/tool-ui/tool-call-presentation"
import { useToolElapsedMs } from "@/components/tool-ui/tool-row-meta"
import { Button } from "@/components/ui/button"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { ShimmerLabel } from "@/lib/surfaces"
import { cn } from "@/lib/utils"
import type { SideQuestionSnapshot } from "@/runtime-adapters/contracts"

import {
  useSideQuestions,
  type SideQuestionEntry,
  type SideQuestionWorkspace,
} from "./side-question-store"

const statusIcons = {
  asking: LoaderCircle,
  answered: Check,
  "needs-input": CircleHelp,
  failed: AlertCircle,
} satisfies Record<SideQuestionSnapshot["state"], unknown>

/** Escape closes what holds focus, and goes no further. */
function closeOnEscape(event: KeyboardEvent, close: () => void) {
  if (event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  close()
}

/**
 * Focuses the composer's message input, found the way its attachments find
 * it: the composer shares the thread's viewport with the tray. While a message
 * is being edited, the composer on show is that edit's.
 */
function focusMessageInput(from: Element | null) {
  from
    ?.closest('[data-slot="aui_thread-viewport"]')
    ?.querySelector<HTMLTextAreaElement>(
      '[data-slot="aui_composer-shell"]:not([hidden]) textarea:not([aria-hidden=true])'
    )
    ?.focus({ preventScroll: true })
}

function SideQuestionRow({
  entry,
  workspace,
  onDismiss,
}: {
  entry: SideQuestionEntry
  workspace: SideQuestionWorkspace
  onDismiss: () => void
}) {
  const { handle } = entry
  const subscribe = useCallback(
    (listener: () => void) => handle.subscribe(listener),
    [handle]
  )
  const read = useCallback(() => handle.snapshot(), [handle])
  const { state, answer, error } = useSyncExternalStore(subscribe, read, read)
  const copy = workspace.dictionary.sideQuestions
  const { labels } = useToolUiLocale()
  const elapsedMs = useToolElapsedMs(
    {
      startedAt: entry.askedAt,
      ...(entry.endedAt === undefined ? {} : { completedAt: entry.endedAt }),
    },
    entry.endedAt === undefined
  )
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const [keeping, setKeeping] = useState(false)
  const Icon = statusIcons[state]
  // Announced once the question settles, as the words it renders, never its
  // markdown; the streaming text stays quiet.
  const announcement =
    state === "answered" && answer !== undefined
      ? markdownPlainText(answer)
      : state === "failed"
        ? copy.failed
        : state === "needs-input"
          ? copy.needsInput
          : undefined
  const keep = () => {
    setKeeping(true)
    void workspace.store.keep(entry.id).then(
      ({ agentId, sessionId }) =>
        workspace.openSession(sessionId, agentId).catch(workspace.reportError),
      (reason: unknown) => {
        setKeeping(false)
        workspace.reportError(reason)
      }
    )
  }

  return (
    <li
      className="flex gap-2.5 px-3.5 pt-2.5 pb-3 not-first:border-t not-first:border-border/60"
      // A row Continue is keeping takes Escape and does nothing with it.
      onKeyDown={(event) =>
        closeOnEscape(event, keeping ? () => undefined : onDismiss)
      }
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground",
          state === "asking" && "motion-safe:animate-spin",
          state === "answered" && "text-success",
          state === "needs-input" && "text-warning",
          state === "failed" && "text-destructive"
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium" dir="auto">
            <span className="sr-only">{copy.status[state]}: </span>
            {entry.question}
          </p>
          {elapsedMs === undefined ? null : (
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {formatDuration(
                Math.floor(elapsedMs / 1000),
                labels.assistant.duration
              )}
            </span>
          )}
        </div>
        {answer ? (
          // The answer is the Agent's markdown, rendered as a message's text is.
          <div className="mt-1" dir="auto">
            <TextMessagePartProvider
              text={answer}
              isRunning={state === "asking"}
            >
              <MarkdownText smooth={false} />
            </TextMessagePartProvider>
          </div>
        ) : null}
        {state === "asking" && !answer ? (
          <p className="mt-1 text-xs text-muted-foreground">
            <ShimmerLabel>{copy.asking}</ShimmerLabel>
          </p>
        ) : state === "needs-input" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {copy.needsInput}
          </p>
        ) : state === "failed" ? (
          <p className="mt-1 text-xs text-destructive" dir="auto">
            {error ? `${copy.failed} ${error}` : copy.failed}
          </p>
        ) : null}
        <span role="status" className="sr-only">
          {announcement}
        </span>
        <div className="-ms-2.5 mt-1.5 flex flex-wrap gap-1">
          {state === "answered" && answer ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(answer)}
            >
              {isCopied ? copy.copied : copy.copy}
            </Button>
          ) : null}
          {state === "answered" || state === "needs-input" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={keeping}
              onClick={keep}
            >
              {copy.continue}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={keeping}
            onClick={onDismiss}
          >
            {copy.dismiss}
          </Button>
        </div>
      </div>
    </li>
  )
}

/** The side questions asked about one Session, newest first. */
export function SessionSideQuestions({
  workspace,
  sessionId,
}: {
  workspace: SideQuestionWorkspace
  sessionId: string
}) {
  const { store, dictionary } = workspace
  const entries = useSyncExternalStore(
    store.subscribe,
    store.entries,
    store.entries
  )
  const trayRef = useRef<HTMLElement>(null)
  const headerDismissRef = useRef<HTMLButtonElement>(null)
  const shown = entries.filter((entry) => entry.sessionId === sessionId)
  if (shown.length === 0) return null
  const copy = dictionary.sideQuestions
  const several = shown.length > 1
  const title = several
    ? copy.several.replace("{count}", String(shown.length))
    : copy.one
  // Focus inside the tray never falls to the page: it stays in the tray while
  // a row remains, and goes to the message input once none does.
  const dismiss = (ids: readonly string[]) => {
    const tray = trayRef.current
    const focused = tray?.contains(document.activeElement) ?? false
    for (const id of ids) void store.dismiss(id).catch(workspace.reportError)
    if (!focused) return
    if (ids.length < shown.length) headerDismissRef.current?.focus()
    else focusMessageInput(tray)
  }
  const dismissAll = () => dismiss(shown.map(({ id }) => id))

  return (
    <section
      ref={trayRef}
      aria-label={title}
      className="overflow-hidden border-y border-border/60 bg-background @md:rounded-2xl @md:border @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:w-full @min-[64rem]/workspace:max-w-(--thread-content-max-width) dark:bg-popover"
      onKeyDown={(event) => closeOnEscape(event, dismissAll)}
    >
      <div className="flex items-center gap-2 border-b border-border/60 py-1.5 ps-3.5 pe-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span>
        <span className="min-w-0 flex-1 truncate">· {copy.notSaved}</span>
        <Button
          ref={headerDismissRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={several ? copy.dismissAll : copy.dismiss}
          onClick={dismissAll}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <ul>
        {shown.map((entry) => (
          <SideQuestionRow
            key={entry.id}
            entry={entry}
            workspace={workspace}
            onDismiss={() => dismiss([entry.id])}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * The tray above the composer: what `/btw` asked about the Session in view,
 * answered from a hidden fork and never saved to the Session itself.
 */
export function SideQuestionTray() {
  const workspace = useSideQuestions()
  const sessionId = useAuiState((state) => state.threadListItem.remoteId)
  return workspace && sessionId ? (
    <SessionSideQuestions workspace={workspace} sessionId={sessionId} />
  ) : null
}
