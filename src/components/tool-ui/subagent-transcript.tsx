"use client"

import {
  MessagePrimitive,
  ReadonlyThreadProvider,
  ThreadPrimitive,
  useAuiState,
  type ThreadMessage,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react"
import { Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import {
  AssistantMessageBody,
  ThreadScope,
} from "@/components/assistant-ui/elements/thread.aui"
import { threadLabels } from "@/components/assistant-ui/thread-labels"
import { useMcpAppHost } from "@/components/mcp-apps/mcp-app-host"
import { ViewHeader } from "@/components/mcp-apps/view-header"
import { Button } from "@/components/ui/button"
import { getLocaleDirection } from "@/lib/i18n/config"
import { readAosToolArtifact, type AosSubagent } from "@/lib/tool-artifact"
import { useChildSessionExtras } from "@/runtime-adapters/child-sessions"

import {
  ActivityTool,
  activityTitle,
  readActivityPayload,
  subagentActivityPayload,
} from "./activity"
import { AosToolFallback } from "./aos-tool-fallback"
import {
  enToolUiLabels,
  heToolUiLabels,
  ToolUiLocaleProvider,
  useToolUiLocale,
  type ToolUiLocale,
  type ToolUiLocaleLabels,
} from "./locale"
import {
  findEntry,
  isActiveStatus,
  subagentSpan,
  subagentStatus,
  type ToolCallContent,
} from "./subagent-status"
import { formatToolDuration } from "./tool-call-presentation"
import { useToolElapsedMs } from "./tool-row-meta"

/** The entry's subagent facts, its payload, and how far it has got. */
function entryFacts(entry: ToolCallContent, labels: ToolUiLocaleLabels) {
  const subagent = readAosToolArtifact(entry.artifact)?.subagent
  const payload = readActivityPayload(entry)
  const status =
    subagentStatus(subagent?.status) ??
    subagentStatus(payload?.result?.status) ??
    (entry.result === undefined ? "running" : "completed")
  const title = activityTitle(payload, subagent) ?? labels.activities.subagent
  return { subagent, payload, status, title }
}

/** The side panel's subagent transcript, named in `locale`, while one is there. */
export function useSubagentTranscriptPip(locale: ToolUiLocale) {
  const host = useMcpAppHost()
  const toolCallId =
    host?.pip?.kind === "transcript" ? host.pip.target.toolCallId : undefined
  const entry = useAuiState((state) =>
    toolCallId === undefined
      ? undefined
      : findEntry(state.thread.messages, toolCallId)
  )
  if (!host || toolCallId === undefined) return undefined
  const labels = locale === "he" ? heToolUiLabels : enToolUiLabels
  const title = entry
    ? entryFacts(entry, labels).title
    : labels.activities.subagent
  return { title, leave: host.leavePip }
}

/** A child's call, to inspect only: never an App view, never an answer to give. */
const ChildToolFallback: ToolCallMessagePartComponent = (part) => {
  const subagent = readAosToolArtifact(part.artifact)?.subagent
  return subagent ? (
    <ActivityTool
      part={part}
      payload={subagentActivityPayload(part, subagent)}
      kind="subagent"
      subagent={subagent}
      requests={false}
    />
  ) : (
    <AosToolFallback {...part} />
  )
}

const CHILD_COMPONENTS = { ToolFallback: ChildToolFallback }

const ChildAssistantMessage = () => (
  <MessagePrimitive.Root>
    <AssistantMessageBody />
  </MessagePrimitive.Root>
)

const ChildUserMessage = () => (
  <MessagePrimitive.Root className="ms-auto max-w-[85%] rounded-xl bg-muted px-4 py-2 text-sm wrap-break-word">
    <div dir="auto">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
)

const messageText = (message: ThreadMessage | undefined) =>
  message?.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

/**
 * The side panel's view of one subagent: what it is and how far it has got,
 * its brief, and its own transcript, live and to read only. Nothing in it
 * answers the child or loads it as a Session of its own; a nested subagent
 * opens in its place.
 */
export function SubagentTranscript({ locale }: { locale: ToolUiLocale }) {
  const host = useMcpAppHost()
  if (host?.pip?.kind !== "transcript") return null
  return (
    <ToolUiLocaleProvider locale={locale}>
      <TranscriptPanel
        key={host.pip.target.toolCallId}
        toolCallId={host.pip.target.toolCallId}
        onClose={host.leavePip}
      />
    </ToolUiLocaleProvider>
  )
}

function TranscriptPanel({
  toolCallId,
  onClose,
}: {
  toolCallId: string
  onClose: () => void
}) {
  const { direction, labels, locale } = useToolUiLocale()
  const entry = useAuiState((state) =>
    findEntry(state.thread.messages, toolCallId)
  )
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeButton.current?.focus()
  }, [])
  const facts = entry ? entryFacts(entry, labels) : undefined
  const title = facts?.title ?? labels.activities.subagent
  const messages = entry?.messages ?? []
  const [first, ...rest] = messages
  const opensWithBrief = first?.role === "user"
  const brief =
    facts?.subagent?.brief ?? (opensWithBrief ? messageText(first) : undefined)
  const transcript = opensWithBrief ? rest : messages

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      dir={direction}
      lang={locale}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <ViewHeader
        title={title}
        detail={facts ? labels.activityStatuses[facts.status] : undefined}
        closeLabel={labels.subagent.closeTranscript}
        closeRef={closeButton}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {entry && facts ? (
          <>
            <TranscriptFacts
              entry={entry}
              subagent={facts.subagent}
              active={isActiveStatus(facts.status)}
            />
            {brief ? <Brief text={brief} /> : null}
            {transcript.length > 0 ? (
              <ReadonlyThreadProvider messages={transcript}>
                <ThreadScope
                  labels={threadLabels[locale]}
                  direction={getLocaleDirection(locale)}
                  components={CHILD_COMPONENTS}
                >
                  <div className="flex flex-col gap-4">
                    <ThreadPrimitive.Messages>
                      {({ message }) =>
                        message.role === "user" ? (
                          <ChildUserMessage />
                        ) : (
                          <ChildAssistantMessage />
                        )
                      }
                    </ThreadPrimitive.Messages>
                  </div>
                </ThreadScope>
              </ReadonlyThreadProvider>
            ) : facts.payload?.result?.transcript ? (
              <p className="text-sm whitespace-pre-wrap" dir="auto">
                {facts.payload.result.transcript}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {labels.subagent.transcriptUnavailable}
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * What the child Session reports of itself, and Stop where the child can be
 * stopped alone. The controls come from the Session's own runtime, so this
 * renders outside the child's read-only thread.
 */
function TranscriptFacts({
  entry,
  subagent,
  active,
}: {
  entry: ToolCallContent
  subagent: AosSubagent | undefined
  active: boolean
}) {
  const { labels, locale } = useToolUiLocale()
  const controls = useChildSessionExtras(
    (extras) => extras.childSessions,
    undefined
  )
  const elapsedMs = useToolElapsedMs(
    subagentSpan(entry, subagent, active),
    active
  )
  const childSessionId = subagent?.childSessionId
  const stop =
    controls && childSessionId && subagent?.cancellable && active
      ? () => controls.cancel(childSessionId)
      : undefined
  const facts = [
    subagent?.model === undefined
      ? undefined
      : labels.subagent.model(subagent.model),
    subagent?.tokens === undefined
      ? undefined
      : labels.subagent.tokens(
          new Intl.NumberFormat(locale, { notation: "compact" }).format(
            subagent.tokens
          )
        ),
    elapsedMs === undefined
      ? undefined
      : formatToolDuration(elapsedMs, labels.assistant.duration),
    subagent?.filesRead?.length
      ? labels.subagent.filesRead(subagent.filesRead.length)
      : undefined,
    subagent?.filesWritten?.length
      ? labels.subagent.filesWritten(subagent.filesWritten.length)
      : undefined,
  ].filter((fact) => fact !== undefined)
  if (facts.length === 0 && !stop) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <p className="flex min-w-0 flex-1 flex-wrap gap-x-3.5 gap-y-0.5">
        {facts.map((fact) => (
          <span key={fact} className="tabular-nums">
            {fact}
          </span>
        ))}
      </p>
      {stop ? (
        <Button type="button" size="xs" variant="ghost" onClick={stop}>
          <Square data-icon="inline-start" aria-hidden="true" />
          {labels.subagent.stop}
        </Button>
      ) : null}
    </div>
  )
}

/** A brief this long or with more than one line folds to its first two lines. */
const LONG_BRIEF = 120

function Brief({ text }: { text: string }) {
  const { labels } = useToolUiLocale()
  const [expanded, setExpanded] = useState(false)
  const folds = text.length > LONG_BRIEF || text.includes("\n")
  return (
    <div className="border-s-2 border-border ps-3 text-xs text-muted-foreground">
      <p
        className={folds && !expanded ? "line-clamp-2" : "whitespace-pre-wrap"}
      >
        <span className="me-1.5 font-medium text-foreground">
          {labels.subagent.brief}
        </span>
        <bdi>{text}</bdi>
      </p>
      {folds ? (
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-4"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? labels.subagent.showLess : labels.subagent.showMore}
        </button>
      ) : null}
    </div>
  )
}
