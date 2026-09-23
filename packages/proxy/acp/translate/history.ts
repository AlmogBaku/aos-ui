import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import {
  StopReason,
  type SessionHistoryResponse,
  type SessionMessage,
} from "../../../protocol"
import {
  AOS_STOP_REASONS,
  AosArtifactDescriptorSchema,
} from "../../../protocol/acp"
import type {
  AcpOutbound,
  Lane,
  PersistedCorrections,
  TranslateContext,
  TranslateHistory,
} from "../types"
import {
  ACP_STOP_REASON,
  artifactOutbound,
  chunkOutbound,
  diffContent,
  planUpdate,
  stateOutbound,
  toolOutbound,
  update,
} from "./updates"

type MessagePart = SessionMessage["content"][number]
type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>

const DATA_URL = /^data:([^;,]+);base64,(.+)$/u

/** Replayed history has no live turn; `_meta.aos` still needs a turn identity. */
const HISTORY_TURN_ID = "history"

/** The `data` part name a published artifact travels under, live and stored. */
const ARTIFACT_PART_NAME = "aos.artifact"

/**
 * The turn identity the shared builders ask for, given a replay has no live turn
 * of its own. Reusing them is what makes a stored turn and a watched turn one stream,
 * so the browser reads both through one code path.
 */
function historyContext(lane: Lane): TranslateContext {
  return { turnId: HISTORY_TURN_ID, sequence: 0, lane, stopping: false }
}

function imageBlock(image: string): ContentBlock | undefined {
  const match = DATA_URL.exec(image)
  return match
    ? { type: "image", data: match[2], mimeType: match[1] }
    : undefined
}

/** Text and inline images only; every other part replays as its own outbound. */
function contentBlocks(parts: readonly MessagePart[]): ContentBlock[] {
  return parts.flatMap((part) => {
    if (part.type === "text") return [{ type: "text", text: part.text }]
    if (part.type !== "image") return []
    const image = imageBlock(part.image)
    return image ? [image] : []
  })
}

/**
 * A stored artifact replays as the link chunk it arrived as, on the turn that
 * stored it. Any other part replays nothing here, so both roles share one
 * projection: an image the operator attached is their turn's artifact exactly as
 * a published one is the agent's.
 */
function storedArtifactOutbound(
  context: TranslateContext,
  message: SessionMessage,
  part: MessagePart
): AcpOutbound[] {
  if (part.type !== "data" || part.name !== ARTIFACT_PART_NAME) return []
  const artifact = AosArtifactDescriptorSchema.safeParse(part.data)
  if (!artifact.success) return []
  const sessionUpdate =
    message.role === "user" ? "user_message_chunk" : "agent_message_chunk"
  return [artifactOutbound(context, sessionUpdate, message.id, artifact.data)]
}

/**
 * A settled call, as the single update the live stream arrives at: the live turn
 * opens it, streams its arguments, then settles it, and a replay knows only
 * where that ended.
 */
function toolCallOutbound(
  context: TranslateContext,
  messageId: string,
  part: ToolCallPart
): AcpOutbound[] {
  const call = {
    toolCallId: part.toolCallId,
    title: part.toolName,
    name: part.toolName,
    status: part.isError ? "failed" : "completed",
  }
  // A guest sees an MCP App's card alone; the App's input and result reach it
  // through the invitation's own view route.
  if (context.lane === "guest")
    return part.app ? [toolOutbound(context, messageId, call, { app: {} })] : []
  return [
    toolOutbound(
      context,
      messageId,
      {
        ...call,
        rawInput: part.args,
        ...(part.result === undefined ? {} : { rawOutput: part.result }),
        ...(part.kind ? { kind: part.kind } : {}),
        ...(part.locations ? { locations: part.locations } : {}),
        ...(part.diffs ? { content: part.diffs.map(diffContent) } : {}),
      },
      {
        argsText: part.argsText,
        ...(part.startedAt ? { startedAt: part.startedAt } : {}),
        ...(part.completedAt ? { completedAt: part.completedAt } : {}),
        ...(part.durationMs === undefined
          ? {}
          : { durationMs: part.durationMs }),
        ...(part.app ? { app: {} } : {}),
      }
    ),
  ]
}

/**
 * How the turn ended, as the live turn reports it. The provider's own failure
 * carries the stored message; every other stored turn ended its turn, including
 * one still waiting on an answer, because the request the attachment reissues is
 * what reopens it.
 *
 * A clean end replays the stop reason the provider stored, and an ordinary end
 * of turn when it stored none.
 */
function settledOutbound(
  context: TranslateContext,
  message: SessionMessage
): AcpOutbound {
  const at = message.completedAt ?? message.createdAt
  const failure =
    message.status?.type === "incomplete" ? message.status : undefined
  return failure
    ? stateOutbound(
        context,
        { state: "idle", stopReason: AOS_STOP_REASONS.error },
        { at, message: failure.error }
      )
    : stateOutbound(
        context,
        {
          state: "idle",
          stopReason: ACP_STOP_REASON[message.stopReason ?? StopReason.EndTurn],
        },
        { at }
      )
}

/**
 * One stored turn's parts, in the order the provider produced them, which is the
 * order the turn stream sent: a whole-message upsert cannot say that this
 * paragraph came after that tool call, because it replaces one source's content
 * as one block. Execution history is the operator's; a published artifact and an
 * MCP App's card are the turn's outcome, so they replay on both lanes and the
 * guest history projection has already dropped the parts a guest may not see.
 */
function partsOutbound(
  message: SessionMessage,
  context: TranslateContext
): AcpOutbound[] {
  const outbound: AcpOutbound[] = []
  const chunk = (
    sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
    content: ContentBlock
  ) => {
    outbound.push(chunkOutbound(context, sessionUpdate, message.id, content))
  }
  for (const part of message.content) {
    if (part.type === "reasoning") {
      if (context.lane !== "guest")
        chunk("agent_thought_chunk", { type: "text", text: part.text })
    } else if (part.type === "text")
      chunk("agent_message_chunk", { type: "text", text: part.text })
    else if (part.type === "image") {
      const image = imageBlock(part.image)
      if (image) chunk("agent_message_chunk", image)
    } else if (part.type === "tool-call")
      outbound.push(...toolCallOutbound(context, message.id, part))
    else outbound.push(...storedArtifactOutbound(context, message, part))
  }
  return outbound
}

/**
 * Assistant and system turns; ACP v2 has no system role of its own. An assistant
 * turn replays between the two state updates its stream sent, because that is what
 * opens the turn, dates it, and settles it on the browser's one code path.
 */
function agentOutbound(
  message: SessionMessage,
  context: TranslateContext,
  startedAt: string
): AcpOutbound[] {
  const parts = partsOutbound(message, context)
  // A notice the provider wrote is no turn: no turn produced it, so no turn state
  // brackets it.
  if (message.role !== "assistant") return parts
  // A turn this lane shows nothing of is no turn either. Only a failure the
  // provider persisted is worth bracketing alone, because the browser shows it.
  if (parts.length === 0 && message.status === undefined) return []
  return [
    stateOutbound(context, { state: "running" }, { at: startedAt }),
    ...parts,
    settledOutbound(context, message),
  ]
}

export const translateHistory = ((history, lane) => {
  const context = historyContext(lane)
  const outbound: AcpOutbound[] = []
  // What live's TurnStarted approximates: the turn started when its prompt
  // landed. A page that opens mid-conversation has only the turn's own time.
  let promptedAt: string | undefined
  for (const message of history.messages) {
    if (message.role === "activity")
      outbound.push(update(planUpdate(message.content.todos, { sequence: 0 })))
    else if (message.role === "user") {
      promptedAt = message.createdAt
      outbound.push(
        update({
          sessionUpdate: "user_message",
          messageId: message.id,
          content: contentBlocks(message.content),
        })
      )
      // The turn exists before anything lands on it, so the attachment it
      // carried follows the message it belongs to.
      for (const part of message.content)
        outbound.push(...storedArtifactOutbound(context, message, part))
    } else
      outbound.push(
        ...agentOutbound(message, context, promptedAt ?? message.createdAt)
      )
  }
  return outbound
}) satisfies TranslateHistory

/** A user turn the provider persisted as a mid-turn correction. */
export function isCorrection(
  message: SessionHistoryResponse["messages"][number]
) {
  return message.role === "user" && message.metadata?.custom.correction === true
}

/** Where the page's last prompt sits: its last user turn that is no correction. */
export function lastPromptIndex(history: SessionHistoryResponse) {
  return history.messages.findLastIndex(
    (message) => message.role === "user" && !isCorrection(message)
  )
}

/**
 * How many of the live turn's steer acknowledgements this history already carried
 * as user turns. Only the corrections after the running turn's prompt count: the
 * provider cannot persist another prompt while a turn runs, so every flagged
 * user turn beyond the last plain one belongs to the turn the journal replays.
 */
export const persistedCorrections = ((history) =>
  // No plain prompt in the page leaves every flagged turn to count.
  history.messages
    .slice(lastPromptIndex(history) + 1)
    .filter((message) => message.role === "user")
    .length) satisfies PersistedCorrections

/** How far a provider's clock may run behind the proxy's for a stored row. */
const PROMPT_CLOCK_SKEW_MS = 5_000

/**
 * The page a view shows beside a live turn replayed from `startedAt`: the
 * stream owns every row the turn stored from then on, corrections included,
 * so they are dropped and the turn shows once. The page's last prompt stays,
 * since the provider stores no other prompt while a turn runs and the stream
 * carries none. `undefined` when a row after that prompt has no time to cut
 * it by, so only a reset can show the turn once.
 */
export function beforeLiveTurn(
  history: SessionHistoryResponse,
  startedAt: number
): SessionHistoryResponse | undefined {
  const threshold = startedAt - PROMPT_CLOCK_SKEW_MS
  const prompt = lastPromptIndex(history)
  const messages = []
  for (const [index, message] of history.messages.entries()) {
    if (index <= prompt || message.role === "activity") {
      messages.push(message)
      continue
    }
    const createdAt = Date.parse(message.createdAt)
    if (Number.isNaN(createdAt)) return undefined
    if (createdAt < threshold) messages.push(message)
  }
  return { ...history, messages }
}
