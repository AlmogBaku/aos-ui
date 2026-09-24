import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import { StopReason, type SessionMessage } from "../../../protocol"
import {
  AOS_STOP_REASONS,
  AosArtifactDescriptorSchema,
} from "../../../protocol/acp"
import type { AcpOutbound, TranslateContext, TranslateHistory } from "../types"
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
const HISTORY_CONTEXT: TranslateContext = {
  turnId: HISTORY_TURN_ID,
  sequence: 0,
  stopping: false,
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
 * as one block. A member's middleware has already dropped the parts it may not
 * see.
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
    if (part.type === "reasoning")
      chunk("agent_thought_chunk", { type: "text", text: part.text })
    else if (part.type === "text")
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
  // A turn that shows nothing is no turn either. Only a failure the
  // provider persisted is worth bracketing alone, because the browser shows it.
  if (parts.length === 0 && message.status === undefined) return []
  return [
    stateOutbound(context, { state: "running" }, { at: startedAt }),
    ...parts,
    settledOutbound(context, message),
  ]
}

export const translateHistory = ((history) => {
  const context = HISTORY_CONTEXT
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
