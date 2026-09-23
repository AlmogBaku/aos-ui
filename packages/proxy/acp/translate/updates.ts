import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import {
  AOS_META_KEY,
  AOS_PLAN_ID,
  AosPlanMetaSchema,
  type AosArtifactDescriptor,
  type AosChunkMetaSchema,
  type AosStateMetaSchema,
  type AosToolCallMetaSchema,
  formatArtifactUri,
} from "../../../protocol/acp"
import type { AcpOutbound, TranslateContext } from "../types"
import { StopReason, type ToolDiff } from "../../core/events"

/**
 * The `session/update` values the proxy emits, each carrying the `_meta.aos`
 * its schema in `protocol/acp.ts` defines. Run translation and history replay
 * share these builders so one Session speaks one vocabulary.
 */

/** Session Todo status → plan entry status; `failed` has no ACP spec peer. */
const PLAN_STATUS = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "_failed",
} as const

export const TodosSchema = AosPlanMetaSchema.shape.todos
type SessionTodos = z.infer<typeof TodosSchema>

export function turnMeta(context: TranslateContext) {
  return { sequence: context.sequence, turnId: context.turnId }
}

export function update(value: SessionUpdate): AcpOutbound {
  return { kind: "update", update: value }
}

/** What a builder adds to the turn meta every update carries. */
type ExtraMeta<Schema extends z.ZodObject> = Omit<
  z.input<Schema>,
  "sequence" | "turnId"
>

/**
 * `at` says when the state took effect: a live run reads the clock, and a replay
 * passes the time the transcript recorded, so a turn's span is the same whether
 * the browser watched it or reloaded onto it.
 */
export function stateOutbound(
  context: TranslateContext,
  state:
    | { state: "running" }
    | { state: "requires_action" }
    | { state: "idle"; stopReason: string; usage?: Usage },
  extra?: ExtraMeta<typeof AosStateMetaSchema>
): AcpOutbound {
  const at = extra?.at ?? new Date(context.now?.() ?? Date.now()).toISOString()
  return update({
    sessionUpdate: "state_update",
    ...state,
    _meta: { [AOS_META_KEY]: { ...turnMeta(context), ...extra, at } },
  })
}

/** A streamed delta, or the whole block a stored part replays as. */
export function chunkOutbound(
  context: TranslateContext,
  sessionUpdate:
    "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
  messageId: string,
  content: string | ContentBlock,
  extra?: ExtraMeta<typeof AosChunkMetaSchema>
): AcpOutbound {
  return update({
    sessionUpdate,
    messageId,
    content:
      typeof content === "string" ? { type: "text", text: content } : content,
    _meta: { [AOS_META_KEY]: { ...turnMeta(context), ...extra } },
  })
}

/**
 * A published artifact as a `resource_link` chunk on the turn it belongs to.
 * The link names only the artifact; the reader fetches it through the Session
 * and lane it already reads.
 */
export function artifactOutbound(
  context: TranslateContext,
  sessionUpdate: "agent_message_chunk" | "user_message_chunk",
  messageId: string,
  artifact: AosArtifactDescriptor
): AcpOutbound {
  return chunkOutbound(context, sessionUpdate, messageId, {
    type: "resource_link",
    uri: formatArtifactUri(artifact.id),
    name: artifact.filename,
    ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
    ...(artifact.sizeBytes === undefined ? {} : { size: artifact.sizeBytes }),
  })
}

type ToolMeta = Omit<ExtraMeta<typeof AosToolCallMetaSchema>, "messageId">

export function toolOutbound(
  context: TranslateContext,
  messageId: string,
  call: Omit<ToolCallUpdate, "_meta">,
  extra?: ToolMeta
): AcpOutbound {
  return update({
    sessionUpdate: "tool_call_update",
    ...call,
    _meta: { [AOS_META_KEY]: { ...turnMeta(context), messageId, ...extra } },
  })
}

/** Appends one item to a call's content; `tool_call_update` replaces it all. */
export function toolContentOutbound(
  context: TranslateContext,
  messageId: string,
  toolCallId: string,
  content: ToolCallContent
): AcpOutbound {
  return update({
    sessionUpdate: "tool_call_content_chunk",
    toolCallId,
    content,
    _meta: { [AOS_META_KEY]: { ...turnMeta(context), messageId } },
  })
}

/** The one plan a Session carries: its Todos, kept losslessly in `_meta.aos`. */
export function planUpdate(
  todos: SessionTodos,
  meta: { sequence: number; turnId?: string }
): SessionUpdate {
  return {
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId: AOS_PLAN_ID,
      entries: todos.map((todo) => ({
        content: todo.label,
        priority: "medium",
        status: PLAN_STATUS[todo.status],
      })),
    },
    _meta: { [AOS_META_KEY]: { ...meta, todos } },
  }
}

/** The ACP stop reason for each domain one. */
export const ACP_STOP_REASON = {
  [StopReason.EndTurn]: "end_turn",
  [StopReason.MaxTokens]: "max_tokens",
  [StopReason.MaxTurnRequests]: "max_turn_requests",
  [StopReason.Refusal]: "refusal",
  [StopReason.Cancelled]: "cancelled",
} as const satisfies Record<StopReason, string>

/** A call's changed files and patch as ACP diff content. */
export function diffContent({ changes, patch }: ToolDiff): ToolCallContent {
  return {
    type: "diff",
    changes,
    ...(patch === undefined
      ? {}
      : { patch: { format: "git_patch", text: patch } }),
  }
}
