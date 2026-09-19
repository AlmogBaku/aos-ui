import type {
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import {
  AOS_META_KEY,
  AOS_PLAN_ID,
  AosPlanMetaSchema,
} from "../../../protocol/acp"
import type { AcpOutbound, TranslateContext } from "../types"

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

export function runMeta(context: TranslateContext) {
  return { sequence: context.sequence, runId: context.runId }
}

export function update(value: SessionUpdate): AcpOutbound {
  return { kind: "update", update: value }
}

export function stateOutbound(
  context: TranslateContext,
  state:
    | { state: "running" }
    | { state: "requires_action" }
    | { state: "idle"; stopReason: string },
  extra?: { code?: string; message?: string }
): AcpOutbound {
  return update({
    sessionUpdate: "state_update",
    ...state,
    _meta: { [AOS_META_KEY]: { ...runMeta(context), ...extra } },
  })
}

export function chunkOutbound(
  context: TranslateContext,
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  messageId: string,
  text: string
): AcpOutbound {
  return update({
    sessionUpdate,
    messageId,
    content: { type: "text", text },
    _meta: { [AOS_META_KEY]: runMeta(context) },
  })
}

export function toolOutbound(
  context: TranslateContext,
  messageId: string,
  call: Omit<ToolCallUpdate, "_meta">,
  args?: { argsTextDelta: string } | { argsText: string }
): AcpOutbound {
  return update({
    sessionUpdate: "tool_call_update",
    ...call,
    _meta: { [AOS_META_KEY]: { ...runMeta(context), messageId, ...args } },
  })
}

/** The one plan a Session carries: its Todos, kept losslessly in `_meta.aos`. */
export function planUpdate(
  todos: SessionTodos,
  meta: { sequence: number; runId?: string }
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
