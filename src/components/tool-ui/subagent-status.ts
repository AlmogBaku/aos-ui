import type { ThreadMessage, ToolCallMessagePart } from "@assistant-ui/react"

import { readAosToolArtifact, type AosSubagent } from "@/lib/tool-artifact"

import { normalizeRichToolState } from "./lifecycle"

import type { ToolUiActivityStatus, ToolUiLocaleLabels } from "./locale"
import type { RichToolPart, RichToolPhase } from "./types"
import { toolActionKind } from "./tool-call-presentation"

/** A provider's free-form subagent status, when it names one AOS shows. */
export function subagentStatus(
  status: string | undefined
): ToolUiActivityStatus | undefined {
  switch (status?.toLowerCase()) {
    case "running":
    case "in_progress":
    case "active":
      return "running"
    case "waiting":
    case "pending":
    case "queued":
      return "waiting"
    case "completed":
    case "complete":
    case "done":
    case "succeeded":
      return "completed"
    case "failed":
    case "error":
      return "failed"
    case "cancelled":
    case "canceled":
      return "stopped"
    // A child nothing follows any longer may still run, or be done.
    case "unknown":
      return "unknown"
    default:
      return undefined
  }
}

/** What the call's own result says of the child, when it says one of these. */
const RESULT_STATUSES = new Set<string>([
  "running",
  "waiting",
  "completed",
  "failed",
])

/** The child's progress as its call's own progress reads. */
function phaseStatus(phase: RichToolPhase): ToolUiActivityStatus {
  switch (phase) {
    case "running":
    case "submitting":
      return "running"
    case "pending":
      return "waiting"
    case "cancelled":
      return "stopped"
    case "failed":
    case "expired":
    case "unavailable":
      return "failed"
    default:
      return "completed"
  }
}

/** The call fields the child's status reads. */
export type ChildCall = Pick<
  RichToolPart,
  "artifact" | "approval" | "isError" | "result" | "status"
>

/**
 * How far a subagent's child has got, the one way every view reads it: what
 * its child Session reports, else what its call's result says, else the
 * call's own progress.
 */
export function childStatusOf(part: ChildCall): ToolUiActivityStatus {
  const reported = subagentStatus(
    readAosToolArtifact(part.artifact)?.subagent?.status
  )
  if (reported) return reported
  const { result } = part
  const said =
    typeof result === "object" && result !== null && "status" in result
      ? result.status
      : undefined
  if (typeof said === "string" && RESULT_STATUSES.has(said))
    return said as ToolUiActivityStatus
  return phaseStatus(normalizeRichToolState(part).phase)
}

/**
 * The status Assistant UI gives a call read straight from its turn: the
 * turn's own until the call has a result.
 */
export const callStatusIn = (
  message: Pick<ThreadMessage, "status">,
  part: Pick<ToolCallContent, "result">
): ChildCall["status"] =>
  part.result === undefined && message.status
    ? (message.status as ChildCall["status"])
    : { type: "complete" }

/** Whether the child is still at work, or waiting on the operator. */
export const isActiveStatus = (status: ToolUiActivityStatus) =>
  status === "running" || status === "waiting"

/** The fields of a child's thread message the row reads. */
type ChildMessage = {
  readonly role: string
  readonly content: readonly {
    readonly type: string
    readonly text?: string
    readonly toolName?: string
    readonly artifact?: unknown
    readonly result?: unknown
  }[]
  readonly metadata?: {
    readonly timing?: { streamStartTime?: number; totalStreamTime?: number }
  }
}

/** A sentence ends at its stop and the space after it, or at a line break. */
const SENTENCE_BREAK = /(?<=[.!?…])\s+|\n+/u

/**
 * What a running child is doing now, from the newest thing its latest turn
 * holds: the last sentence it wrote, or the kind and name of the tool it
 * called. A child that has done neither yet has no line.
 */
export function subagentLiveLine(
  messages: readonly ChildMessage[] | undefined,
  labels: ToolUiLocaleLabels
): string | undefined {
  const turn = messages?.findLast((message) => message.role === "assistant")
  const newest = turn?.content.findLast((part) =>
    part.type === "text"
      ? Boolean(part.text?.trim())
      : part.type === "tool-call"
  )
  if (newest?.type === "text")
    return newest.text?.trim().split(SENTENCE_BREAK).filter(Boolean).at(-1)
  const toolName = newest?.toolName
  if (toolName === undefined) return undefined
  const kind = toolActionKind({ toolName, artifact: newest?.artifact })
  const action = labels.assistant.toolActions[kind]
  return `${newest?.result === undefined ? action.active : action.complete} ${toolName}`
}

type Span = ToolCallMessagePart["timing"]

/**
 * How long the child has worked: the duration its runtime reported, else its
 * call's own span, else from its first timed turn, open while it works.
 */
export function subagentSpan(
  part: { readonly timing?: Span; readonly messages?: readonly ChildMessage[] },
  subagent: AosSubagent | undefined,
  active: boolean
): Span {
  if (subagent?.durationMs !== undefined)
    return { startedAt: 0, completedAt: subagent.durationMs }
  if (part.timing) return part.timing
  const timed = (part.messages ?? []).flatMap(({ metadata }) => {
    const start = metadata?.timing?.streamStartTime
    return start === undefined
      ? []
      : [{ start, total: metadata?.timing?.totalStreamTime }]
  })
  const first = timed[0]
  if (first === undefined) return undefined
  const last = timed.at(-1)!
  return active || last.total === undefined
    ? { startedAt: first.start }
    : { startedAt: first.start, completedAt: last.start + last.total }
}

/** The span that reads longest: the earliest still open, else the longest. */
export function longestSpan(spans: readonly Span[]): Span {
  const known = spans.filter((span) => span !== undefined)
  const open = known.filter((span) => span.completedAt === undefined)
  if (open.length > 0)
    return open.reduce((earliest, span) =>
      span.startedAt < earliest.startedAt ? span : earliest
    )
  const length = (span: NonNullable<Span>) =>
    (span.completedAt ?? span.startedAt) - span.startedAt
  return known.reduce<Span>(
    (longest, span) =>
      longest === undefined || length(span) > length(longest) ? span : longest,
    undefined
  )
}

export type ToolCallContent = Extract<
  ThreadMessage["content"][number],
  { type: "tool-call" }
>

/** The call `toolCallId` names and its turn, wherever transcripts nest it. */
function locateEntry(
  messages: readonly ThreadMessage[],
  toolCallId: string
): { part: ToolCallContent; message: ThreadMessage } | undefined {
  for (const message of messages)
    for (const part of message.content) {
      if (part.type !== "tool-call") continue
      if (part.toolCallId === toolCallId) return { part, message }
      const nested = part.messages && locateEntry(part.messages, toolCallId)
      if (nested) return nested
    }
  return undefined
}

/** The call `toolCallId` names, wherever the thread's transcripts nest it. */
export const findEntry = (
  messages: readonly ThreadMessage[],
  toolCallId: string
) => locateEntry(messages, toolCallId)?.part

/** How far the child of the entry `toolCallId` names has got. */
export function findEntryStatus(
  messages: readonly ThreadMessage[],
  toolCallId: string
): ToolUiActivityStatus | undefined {
  const found = locateEntry(messages, toolCallId)
  return (
    found &&
    childStatusOf({
      ...found.part,
      status: callStatusIn(found.message, found.part),
    })
  )
}
