import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionHistoryResponse, SessionMessage } from "../../../protocol"
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
  chunkOutbound,
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
 * A stored artifact replays as the `_aos/artifact` notification it arrived as.
 * Any other part replays nothing here, so both roles share one projection: an
 * image the operator attached is their turn's artifact exactly as a published one
 * is the agent's.
 */
function artifactOutbound(messageId: string, part: MessagePart): AcpOutbound[] {
  if (part.type !== "data" || part.name !== ARTIFACT_PART_NAME) return []
  const artifact = AosArtifactDescriptorSchema.safeParse(part.data)
  return artifact.success
    ? [
        {
          kind: "artifact",
          turnId: HISTORY_TURN_ID,
          messageId,
          artifact: artifact.data,
        },
      ]
    : []
}

/**
 * A settled call, as the single update the live stream arrives at: the live run
 * opens it, streams its arguments, then settles it, and a replay knows only
 * where that ended.
 */
function toolCallOutbound(
  context: TranslateContext,
  messageId: string,
  part: ToolCallPart
): AcpOutbound {
  return toolOutbound(
    context,
    messageId,
    {
      toolCallId: part.toolCallId,
      title: part.toolName,
      status: part.isError ? "failed" : "completed",
      rawInput: part.args,
      ...(part.result === undefined ? {} : { rawOutput: part.result }),
    },
    { argsText: part.argsText }
  )
}

/**
 * How the turn ended, as the live run reports it. The provider's own failure
 * carries the stored message; every other stored turn ended its turn, including
 * one still waiting on an answer, because the request the attachment reissues is
 * what reopens it.
 *
 * A durable status has no cancelled reason (`SessionMessageErrorStatusSchema`),
 * so a stopped turn replays as the failure or the end of turn the provider
 * persisted for it.
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
    : stateOutbound(context, { state: "idle", stopReason: "end_turn" }, { at })
}

/**
 * One stored turn's parts, in the order the provider produced them, which is the
 * order the run stream sent: a whole-message upsert cannot say that this
 * paragraph came after that tool call, because it replaces one source's content
 * as one block. Execution history is the operator's; a published artifact is the
 * turn's outcome, so it replays on both lanes and the guest history projection
 * has already dropped the parts a guest may not see.
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
    } else if (part.type === "tool-call") {
      if (context.lane !== "guest")
        outbound.push(toolCallOutbound(context, message.id, part))
    } else outbound.push(...artifactOutbound(message.id, part))
  }
  return outbound
}

/**
 * Assistant and system turns; ACP v2 has no system role of its own. An assistant
 * turn replays between the two state updates its run sent, because that is what
 * opens the turn, dates it, and settles it on the browser's one code path.
 */
function agentOutbound(
  message: SessionMessage,
  context: TranslateContext,
  startedAt: string
): AcpOutbound[] {
  const parts = partsOutbound(message, context)
  // A notice the provider wrote is no turn: no run produced it, so no run state
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
        outbound.push(...artifactOutbound(message.id, part))
    } else
      outbound.push(
        ...agentOutbound(message, context, promptedAt ?? message.createdAt)
      )
  }
  return outbound
}) satisfies TranslateHistory

/** A user turn the provider persisted as a mid-turn correction. */
function isCorrection(message: SessionHistoryResponse["messages"][number]) {
  return message.role === "user" && message.metadata?.custom.correction === true
}

/**
 * How many of the live run's steer acknowledgements this history already carried
 * as user turns. Only the corrections after the running turn's prompt count: the
 * provider cannot persist another prompt while a turn runs, so every flagged
 * user turn beyond the last plain one belongs to the run the journal replays.
 */
export const persistedCorrections = ((history) => {
  const users = history.messages.filter((message) => message.role === "user")
  // No plain prompt in the page leaves every flagged turn to count.
  const prompt = users.findLastIndex((message) => !isCorrection(message))
  return users.length - prompt - 1
}) satisfies PersistedCorrections
