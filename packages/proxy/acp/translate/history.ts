import type {
  ContentBlock,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionMessage } from "../../../protocol"
import { AOS_META_KEY } from "../../../protocol/acp"
import type { Lane, TranslateHistory } from "../types"
import { planUpdate } from "./updates"

type MessagePart = SessionMessage["content"][number]
type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>

const DATA_URL = /^data:([^;,]+);base64,(.+)$/u

/** Replayed history has no run; `_meta.aos` still needs a run identity. */
const HISTORY_RUN_ID = "history"

function imageBlock(image: string): ContentBlock | undefined {
  const match = DATA_URL.exec(image)
  return match
    ? { type: "image", data: match[2], mimeType: match[1] }
    : undefined
}

/**
 * Text and inline images only. A `data` part named `aos.artifact` is skipped:
 * the attachment re-grants artifacts through `_aos/artifact` on replay.
 */
function contentBlocks(parts: readonly MessagePart[]): ContentBlock[] {
  return parts.flatMap((part) => {
    if (part.type === "text") return [{ type: "text", text: part.text }]
    if (part.type !== "image") return []
    const image = imageBlock(part.image)
    return image ? [image] : []
  })
}

function toolCallUpdate(messageId: string, part: ToolCallPart): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: part.toolCallId,
    title: part.toolName,
    status: part.isError ? "failed" : "completed",
    rawInput: part.args,
    ...(part.result === undefined ? {} : { rawOutput: part.result }),
    _meta: {
      [AOS_META_KEY]: {
        sequence: 0,
        runId: HISTORY_RUN_ID,
        messageId,
        argsText: part.argsText,
      },
    },
  }
}

/** Assistant and system turns; ACP v2 has no system role of its own. */
function agentUpdates(message: SessionMessage, lane: Lane): SessionUpdate[] {
  const updates: SessionUpdate[] = []
  const reasoning: ContentBlock[] = message.content.flatMap((part) =>
    part.type === "reasoning" ? [{ type: "text", text: part.text }] : []
  )
  // The run stream gives reasoning its own message id and streams it before the
  // prose; replay keeps that identity and order.
  if (lane !== "guest" && reasoning.length > 0)
    updates.push({
      sessionUpdate: "agent_thought",
      messageId: `${message.id}:reasoning`,
      content: reasoning,
    })
  const content = contentBlocks(message.content)
  if (content.length > 0)
    updates.push({
      sessionUpdate: "agent_message",
      messageId: message.id,
      content,
    })
  if (lane === "guest") return updates
  for (const part of message.content)
    if (part.type === "tool-call")
      updates.push(toolCallUpdate(message.id, part))
  return updates
}

export const translateHistory = ((history, lane) => {
  const updates: SessionUpdate[] = []
  for (const message of history.messages) {
    if (message.role === "activity")
      updates.push(planUpdate(message.content.todos, { sequence: 0 }))
    else if (message.role === "user")
      updates.push({
        sessionUpdate: "user_message",
        messageId: message.id,
        content: contentBlocks(message.content),
      })
    else updates.push(...agentUpdates(message, lane))
  }
  return updates
}) satisfies TranslateHistory
