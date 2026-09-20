import type {
  ContentBlock,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionMessage } from "../../../protocol"
import {
  AOS_META_KEY,
  AosArtifactDescriptorSchema,
} from "../../../protocol/acp"
import type { AcpOutbound, Lane, TranslateHistory } from "../types"
import { planUpdate } from "./updates"

type MessagePart = SessionMessage["content"][number]
type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>

const DATA_URL = /^data:([^;,]+);base64,(.+)$/u

/** Replayed history has no run; `_meta.aos` still needs a run identity. */
const HISTORY_RUN_ID = "history"

/** The `data` part name a published artifact travels under, live and stored. */
const ARTIFACT_PART_NAME = "aos.artifact"

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
          runId: HISTORY_RUN_ID,
          messageId,
          artifact: artifact.data,
        },
      ]
    : []
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
function agentOutbound(message: SessionMessage, lane: Lane): AcpOutbound[] {
  const outbound: AcpOutbound[] = []
  const reasoning: ContentBlock[] = message.content.flatMap((part) =>
    part.type === "reasoning" ? [{ type: "text", text: part.text }] : []
  )
  // One message carries the turn, as the run stream sends it: the thought
  // upsert sets its reasoning, the message upsert its prose, and reasoning
  // replays first because that is the order the provider produced it in.
  if (lane !== "guest" && reasoning.length > 0)
    outbound.push({
      kind: "update",
      update: {
        sessionUpdate: "agent_thought",
        messageId: message.id,
        content: reasoning,
      },
    })
  const content = contentBlocks(message.content)
  // A turn the provider failed is replayed even when it streamed no prose: its
  // durable failure rides on the message it belongs to, because a replay settles
  // no run of its own.
  const failure =
    message.status?.type === "incomplete" ? message.status : undefined
  if (content.length > 0 || failure)
    outbound.push({
      kind: "update",
      update: {
        sessionUpdate: "agent_message",
        messageId: message.id,
        content,
        ...(failure
          ? {
              _meta: {
                [AOS_META_KEY]: {
                  sequence: 0,
                  runId: HISTORY_RUN_ID,
                  status: failure,
                },
              },
            }
          : {}),
      },
    })
  // Execution history is the operator's. A published artifact is the turn's
  // outcome, so it replays on both lanes; the guest history projection already
  // dropped the parts a guest may not see.
  for (const part of message.content) {
    outbound.push(...artifactOutbound(message.id, part))
    if (lane !== "guest" && part.type === "tool-call")
      outbound.push({
        kind: "update",
        update: toolCallUpdate(message.id, part),
      })
  }
  return outbound
}

export const translateHistory = ((history, lane) => {
  const outbound: AcpOutbound[] = []
  for (const message of history.messages) {
    if (message.role === "activity")
      outbound.push({
        kind: "update",
        update: planUpdate(message.content.todos, { sequence: 0 }),
      })
    else if (message.role === "user") {
      outbound.push({
        kind: "update",
        update: {
          sessionUpdate: "user_message",
          messageId: message.id,
          content: contentBlocks(message.content),
        },
      })
      // The turn exists before anything lands on it, so the attachment it
      // carried follows the message it belongs to.
      for (const part of message.content)
        outbound.push(...artifactOutbound(message.id, part))
    } else outbound.push(...agentOutbound(message, lane))
  }
  return outbound
}) satisfies TranslateHistory
