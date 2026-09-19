import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/core"

import {
  AOS_METHODS,
  AOS_PLAN_ID,
  AOS_STOP_REASONS,
  AosArtifactNotificationSchema,
  AosPlanMetaSchema,
  AosStateMetaSchema,
  AosSteerAcceptedNotificationSchema,
  AosToolCallMetaSchema,
} from "@aos/protocol/acp"

import { ARTIFACT_DATA_PART_NAME } from "@/artifacts/artifacts"
import { STEER_ACCEPTED_DATA_NAME } from "@/components/assistant-ui/elements/message-queue"
import type { SessionStatus, TodoItem } from "@/runtime-adapters/contracts"

import {
  appendBlock,
  appendData,
  appendToolContent,
  isContentBlock,
  isRecord,
  isToolCallContent,
  latestAssistantId,
  patchToolCall,
  replaceBlocks,
  toolCallOwner,
  toThreadMessage,
  withMessage,
  withStatus,
  type MessageRole,
  type ProjectedMessage,
  type ToolCallPatch,
} from "./projector-messages"

/**
 * Folds one Session's ACP `session/update` stream and the two data-part
 * extension notifications into the state the Assistant UI store reads. Pure and
 * React-free: a replay starts from `initialProjectorState` and applies the same
 * reducer the live stream does.
 */

export type ProjectorExecution = {
  readonly status: SessionStatus
  readonly runId?: string
  readonly stopReason?: string
  readonly error?: { readonly code?: string; readonly message?: string }
}

export type ProjectorState = {
  readonly messages: readonly ProjectedMessage[]
  readonly execution: ProjectorExecution
  readonly todos: readonly TodoItem[]
  readonly usage?: { readonly used: number; readonly size: number }
  readonly title?: string
  readonly configOptions?: readonly SessionConfigOption[]
  readonly commands?: readonly AvailableCommand[]
}

export const initialProjectorState: ProjectorState = {
  messages: [],
  execution: { status: "idle" },
  todos: [],
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** Omitted or ill-typed keeps, `null` clears, a string replaces. */
const textPatch = (value: unknown) =>
  typeof value === "string" ? value : value === null ? null : undefined

const listOf = <T>(
  value: unknown,
  isItem: (item: unknown) => item is T
): readonly T[] | undefined =>
  Array.isArray(value) && value.every(isItem) ? value : undefined

const blockPatch = (value: unknown) =>
  value === null ? null : listOf(value, isContentBlock)

const isConfigOption = (value: unknown): value is SessionConfigOption =>
  isRecord(value) &&
  typeof value.type === "string" &&
  typeof value.configId === "string" &&
  typeof value.name === "string"

const isCommand = (value: unknown): value is AvailableCommand =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.description === "string"

const roleOf = (kind: string): MessageRole =>
  kind.startsWith("user_") ? "user" : "assistant"

const sourceOf = (kind: string) =>
  kind.startsWith("agent_thought") ? "thought" : "message"

function withMessages(
  state: ProjectorState,
  messages: readonly ProjectedMessage[]
): ProjectorState {
  return messages === state.messages ? state : { ...state, messages }
}

/** Upserts the addressed turn, creating it with `role` when it is new. */
function onMessage(
  state: ProjectorState,
  id: string,
  role: MessageRole,
  patch: (message: ProjectedMessage) => ProjectedMessage
): ProjectorState {
  return withMessages(state, withMessage(state.messages, id, role, patch))
}

function withLastAssistant(
  state: ProjectorState,
  patch: (message: ProjectedMessage) => ProjectedMessage
): ProjectorState {
  const id = latestAssistantId(state.messages)
  return id === undefined ? state : onMessage(state, id, "assistant", patch)
}

/** The owning message comes from `_meta.aos`; without it, the latest turn. */
function applyToolCall(
  state: ProjectorState,
  patch: ToolCallPatch | undefined,
  meta: unknown
): ProjectorState {
  if (!patch) return state
  const aos = AosToolCallMetaSchema.safeParse(meta)
  const messageId = aos.success
    ? aos.data.messageId
    : latestAssistantId(state.messages)
  if (messageId === undefined) return state
  const args = aos.success
    ? { argsText: aos.data.argsText, argsTextDelta: aos.data.argsTextDelta }
    : {}
  return onMessage(state, messageId, "assistant", (message) =>
    patchToolCall(message, patch, args)
  )
}

/** The vendor stop reasons carry the failure the run reported. */
function errorFrom(meta: unknown): Record<string, string> | undefined {
  const parsed = AosStateMetaSchema.safeParse(meta)
  if (!parsed.success) return undefined
  const error: Record<string, string> = {
    ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
    ...(parsed.data.message === undefined
      ? {}
      : { message: parsed.data.message }),
  }
  return Object.keys(error).length > 0 ? error : undefined
}

function applyIdle(
  state: ProjectorState,
  carried: { runId?: string },
  stopReason: string | undefined,
  meta: unknown
): ProjectorState {
  const failed =
    stopReason === AOS_STOP_REASONS.error ||
    stopReason === AOS_STOP_REASONS.uncertain
  const error = failed ? errorFrom(meta) : undefined
  const execution: ProjectorExecution = {
    status: failed ? "failed" : "idle",
    ...carried,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(error === undefined ? {} : { error }),
  }
  const status: MessageStatus = failed
    ? { type: "incomplete", reason: "error", ...(error && { error }) }
    : stopReason === "cancelled"
      ? { type: "incomplete", reason: "cancelled" }
      : { type: "complete", reason: "stop" }
  return withLastAssistant({ ...state, execution }, (message) =>
    withStatus(message, status)
  )
}

function applyState(
  state: ProjectorState,
  update: UpdatePayload,
  meta: unknown
): ProjectorState {
  const parsed = AosStateMetaSchema.safeParse(meta)
  const runId = parsed.success ? parsed.data.runId : state.execution.runId
  const carried = runId === undefined ? {} : { runId }
  const next = text(update.state)
  if (next === "running")
    return withLastAssistant(
      { ...state, execution: { status: "running", ...carried } },
      (message) => withStatus(message, { type: "running" })
    )
  if (next === "requires_action")
    return withLastAssistant(
      { ...state, execution: { status: "waiting-for-input", ...carried } },
      (message) =>
        withStatus(message, { type: "requires-action", reason: "interrupt" })
    )
  if (next !== "idle") return state
  return applyIdle(state, carried, text(update.stopReason), meta)
}

/** Only the Session's own plan is projected, and `_meta.aos` carries it. */
function applyPlan(
  state: ProjectorState,
  update: UpdatePayload,
  meta: unknown
): ProjectorState {
  const plan = isRecord(update.plan) ? update.plan : undefined
  if (plan?.planId !== AOS_PLAN_ID) return state
  const parsed = AosPlanMetaSchema.safeParse(meta)
  return parsed.success ? { ...state, todos: parsed.data.todos } : state
}

/**
 * ACP's update union stays open, so a kind never guarantees its payload's
 * shape: every field is read back as `unknown` and validated here.
 */
type UpdatePayload = Record<string, unknown>

function applyWhole(
  state: ProjectorState,
  kind: string,
  update: UpdatePayload
): ProjectorState {
  const messageId = text(update.messageId)
  if (messageId === undefined) return state
  return onMessage(state, messageId, roleOf(kind), (message) =>
    replaceBlocks(message, sourceOf(kind), blockPatch(update.content))
  )
}

function applyChunk(
  state: ProjectorState,
  kind: string,
  update: UpdatePayload
): ProjectorState {
  const messageId = text(update.messageId)
  const block = update.content
  if (messageId === undefined || !isContentBlock(block)) return state
  return onMessage(state, messageId, roleOf(kind), (message) =>
    appendBlock(message, sourceOf(kind), block)
  )
}

function toolPatch(update: UpdatePayload): ToolCallPatch | undefined {
  const toolCallId = text(update.toolCallId)
  if (toolCallId === undefined) return undefined
  return {
    toolCallId,
    title: textPatch(update.title),
    status: textPatch(update.status),
    content:
      update.content === null
        ? null
        : listOf(update.content, isToolCallContent),
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
  }
}

function applyToolContent(
  state: ProjectorState,
  update: UpdatePayload
): ProjectorState {
  const toolCallId = text(update.toolCallId)
  const content = update.content
  if (toolCallId === undefined || !isToolCallContent(content)) return state
  const owner = toolCallOwner(state.messages, toolCallId)
  if (!owner) return state
  return onMessage(state, owner.id, owner.role, (message) =>
    appendToolContent(message, toolCallId, content)
  )
}

function applyUsage(
  state: ProjectorState,
  update: UpdatePayload
): ProjectorState {
  const { used, size } = update
  return typeof used === "number" && typeof size === "number"
    ? { ...state, usage: { used, size } }
    : state
}

function applyTitle(
  state: ProjectorState,
  update: UpdatePayload
): ProjectorState {
  const title = textPatch(update.title)
  if (title === undefined) return state
  return title === null ? { ...state, title: undefined } : { ...state, title }
}

/** `meta` is the update's `_meta.aos`; unknown kinds and payloads are ignored. */
export function applyUpdate(
  state: ProjectorState,
  update: SessionUpdate,
  meta: unknown
): ProjectorState {
  const kind = update.sessionUpdate
  switch (kind) {
    case "user_message":
    case "agent_message":
    case "agent_thought":
      return applyWhole(state, kind, update)
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return applyChunk(state, kind, update)
    case "tool_call_update":
      return applyToolCall(state, toolPatch(update), meta)
    case "tool_call_content_chunk":
      return applyToolContent(state, update)
    case "state_update":
      return applyState(state, update, meta)
    case "plan_update":
      return applyPlan(state, update, meta)
    case "usage_update":
      return applyUsage(state, update)
    case "session_info_update":
      return applyTitle(state, update)
    case "config_option_update": {
      const configOptions = listOf(update.configOptions, isConfigOption)
      return configOptions ? { ...state, configOptions } : state
    }
    case "available_commands_update": {
      const commands = listOf(update.availableCommands, isCommand)
      return commands ? { ...state, commands } : state
    }
    default:
      return state
  }
}

/** `_aos/artifact` and `_aos/steer_accepted` land as message data parts. */
export function applyNotification(
  state: ProjectorState,
  method: string,
  params: unknown
): ProjectorState {
  if (method === AOS_METHODS.notify.artifact) {
    const parsed = AosArtifactNotificationSchema.safeParse(params)
    if (!parsed.success) return state
    const messageId = parsed.data.messageId ?? latestAssistantId(state.messages)
    if (messageId === undefined) return state
    return onMessage(state, messageId, "assistant", (message) =>
      appendData(message, ARTIFACT_DATA_PART_NAME, parsed.data.artifact)
    )
  }
  if (method !== AOS_METHODS.notify.steerAccepted) return state
  const parsed = AosSteerAcceptedNotificationSchema.safeParse(params)
  if (!parsed.success) return state
  return withLastAssistant(state, (message) =>
    appendData(message, STEER_ACCEPTED_DATA_NAME, parsed.data)
  )
}

/**
 * Re-keys the optimistic user turn onto the id the proxy assigned it. The echo
 * may arrive first, in which case the local copy is dropped instead.
 */
export function renameMessage(
  state: ProjectorState,
  fromId: string,
  toId: string
): ProjectorState {
  const current = state.messages.find((message) => message.id === fromId)
  if (!current || fromId === toId) return state
  const taken = state.messages.some((message) => message.id === toId)
  return withMessages(
    state,
    taken
      ? state.messages.filter((message) => message !== current)
      : state.messages.map((message) =>
          message === current ? { ...message, id: toId } : message
        )
  )
}

/** Keeps the listed turns in order; the runtime's removals flow back here. */
export function retainMessages(
  state: ProjectorState,
  ids: readonly string[]
): ProjectorState {
  const keep = new Set(ids)
  const messages = state.messages.filter((message) => keep.has(message.id))
  return messages.length === state.messages.length
    ? state
    : { ...state, messages }
}

/** Drops the turn a rewind replaces, and everything after it. */
export function retainBefore(
  state: ProjectorState,
  messageId: string
): ProjectorState {
  const at = state.messages.findIndex((message) => message.id === messageId)
  return at < 0 ? state : withMessages(state, state.messages.slice(0, at))
}

/** The blocks a turn was sent with, so a retry can re-send them verbatim. */
export function messageBlocks(
  state: ProjectorState,
  messageId: string
): ContentBlock[] {
  const message = state.messages.find((entry) => entry.id === messageId)
  return (message?.parts ?? []).flatMap((part) =>
    part.source === "message" ? [part.block] : []
  )
}

export function toThreadMessages(state: ProjectorState): ThreadMessageLike[] {
  return state.messages.map(toThreadMessage)
}
