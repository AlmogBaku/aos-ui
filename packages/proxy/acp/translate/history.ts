import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionMessage } from "../../../protocol"
import {
  AOS_STOP_REASONS,
  AosArtifactDescriptorSchema,
} from "../../../protocol/acp"
import type { AcpOutbound, TranslateContext, TranslateHistory } from "../types"
import {
  artifactOutbound,
  chunkOutbound,
  diffContent,
  outputContent,
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
  // The content the live call settles with: its output, then its diffs.
  const content = [
    ...(part.result === undefined ? [] : [outputContent(part.result)]),
    ...(part.diffs ?? []).map(diffContent),
  ]
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
        ...(content.length ? { content } : {}),
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
 * The failure a provider stored on an assistant message, as the live turn
 * reports it. Only a failure replays a state: the browser shows it, and no
 * other stored turn has a state that still stands.
 */
function failureOutbound(
  context: TranslateContext,
  message: SessionMessage
): AcpOutbound[] {
  if (message.status?.type !== "incomplete") return []
  return [
    stateOutbound(
      context,
      { state: "idle", stopReason: AOS_STOP_REASONS.error },
      {
        at: message.completedAt ?? message.createdAt,
        message: message.status.error,
      }
    ),
  ]
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

/** The upsert an agent chunk's message starts from. */
const MESSAGE_START = {
  agent_message_chunk: "agent_message",
  agent_thought_chunk: "agent_thought",
} as const

/**
 * Starts each agent message from empty content before its first chunk, so a
 * view that already holds the message, as one rebuilt in place does, shows it
 * once.
 */
function fromEmpty(outbound: readonly AcpOutbound[]): AcpOutbound[] {
  const started = new Set<string>()
  return outbound.flatMap((item) => {
    if (item.kind !== "update") return [item]
    const { update: value } = item
    if (
      value.sessionUpdate !== "agent_message_chunk" &&
      value.sessionUpdate !== "agent_thought_chunk"
    )
      return [item]
    const sessionUpdate = MESSAGE_START[value.sessionUpdate]
    const key = `${sessionUpdate}\u0000${value.messageId}`
    if (value.messageId == null || started.has(key)) return [item]
    started.add(key)
    return [
      update({
        sessionUpdate,
        messageId: value.messageId,
        content: [],
        ...(value._meta ? { _meta: value._meta } : {}),
      }),
      item,
    ]
  })
}

/**
 * The Session's stored conversation as standard updates: each message once,
 * and no turn state but a stored failure's, since no past state still stands.
 * The live turn's state follows the replay on its own.
 */
export const translateHistory = ((history) => {
  const context = HISTORY_CONTEXT
  const outbound: AcpOutbound[] = []
  for (const message of history.messages) {
    if (message.role === "activity")
      outbound.push(update(planUpdate(message.content.todos, { sequence: 0 })))
    else if (message.role === "assistant")
      outbound.push(
        ...partsOutbound(message, context),
        ...failureOutbound(context, message)
      )
    else if (message.role === "system")
      outbound.push(...partsOutbound(message, context))
    else {
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
    }
  }
  return fromEmpty(outbound)
}) satisfies TranslateHistory
