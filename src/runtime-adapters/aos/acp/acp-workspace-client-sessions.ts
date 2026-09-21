import {
  SessionUpdate,
  StateUpdate,
  type SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2"
import { z } from "zod"

import {
  AOS_METHODS,
  AOS_STOP_REASONS,
  AosActivityNotificationSchema,
  AosPlanMetaSchema,
  AosSessionInfoMetaSchema,
  AosSessionInvalidatedNotificationSchema,
  type AosActivityNotification,
  type AosSessionInfoMeta,
} from "@aos/protocol/acp"

import type {
  SessionMetadata,
  SessionStatus,
  TodoItem,
  WorkspaceActivityEvent,
} from "../../contracts"
import type { AcpConnection } from "./types"

/**
 * Everything the workspace learns by observing the connection: the Session row
 * cache, execution status, Session Todos, workspace activity, and read state.
 * Writes live in the client facade; this module only reads and publishes.
 */

type MetadataListener = (metadata: SessionMetadata[]) => void
type MetadataSubscription = {
  threadIds: ReadonlySet<string>
  listener: MetadataListener
}

export type AcpSessionStoreOptions = {
  connection: AcpConnection
  now?: () => number
}

/** Runs `handler` for every notification of `method` the proxy sends. */
function onAosNotification<Value>(
  connection: AcpConnection,
  method: string,
  schema: Pick<z.ZodType<Value>, "safeParse">,
  handler: (value: Value) => void
) {
  return connection.onNotification(method, (params) => {
    const parsed = schema.safeParse(params)
    if (parsed.success) handler(parsed.data)
  })
}

/** The one place a `state_update` becomes a Session status. */
function statusFromState(update: StateUpdate): SessionStatus {
  if (StateUpdate.isRunning(update)) return "running"
  if (StateUpdate.isRequiresAction(update)) return "waiting-for-input"
  if (!StateUpdate.isIdle(update)) return "unknown"
  const stopReason = update.stopReason
  return stopReason === AOS_STOP_REASONS.error ||
    stopReason === AOS_STOP_REASONS.uncertain
    ? "failed"
    : "idle"
}

/** Content-free workspace events; read state travels as a row change instead. */
function activityEventOf(
  notification: AosActivityNotification
): WorkspaceActivityEvent | undefined {
  const { agentId, sessionId, occurredAt, type } = notification
  if (type === "unread-changed") return undefined
  const key =
    "lifecycleId" in notification
      ? notification.lifecycleId
      : "requestId" in notification
        ? notification.requestId
        : occurredAt
  const base = {
    id: `${sessionId}:${key}:${type}`,
    agentId,
    threadId: sessionId,
    occurredAt,
  }
  if (type === "attention-requested")
    return {
      ...base,
      type,
      requestId: notification.requestId,
      attentionKind: notification.attentionKind,
    }
  if (type === "attention-resolved")
    return { ...base, type, requestId: notification.requestId }
  return { ...base, type, lifecycleId: notification.lifecycleId }
}

/** The creator's own tool, named identically over Hermes and OpenCode. */
const AGENT_CREATION_TOOLS = new Set(["aos_create_agent", "create_agent"])

const AgentCreationReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    status: z.literal("ready"),
    agentId: z.string().min(1).max(128),
  }),
  z.object({
    ok: z.literal(false),
    status: z.literal("setup-needed"),
    agentId: z.string().min(1).max(128),
    error: z.string().optional(),
  }),
])

/** The proxy usually parses tool output; a provider may still send raw text. */
function agentCreationReceiptOf(rawOutput: unknown) {
  let value = rawOutput
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const parsed = AgentCreationReceiptSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function toolCallKey(threadId: string, toolCallId: string) {
  return `${threadId}\u0000${toolCallId}`
}

function sameRow(left: SessionMetadata | undefined, right: SessionMetadata) {
  return (
    left !== undefined &&
    left.agentId === right.agentId &&
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.unread === right.unread
  )
}

export function createAcpSessionStore({
  connection,
  now = Date.now,
}: AcpSessionStoreOptions) {
  const rows = new Map<string, SessionMetadata>()
  const titles = new Map<string, string>()
  const todos = new Map<string, TodoItem[]>()
  const observed = new Map<string, () => void>()
  const subscriptions = new Set<MetadataSubscription>()
  const todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  const activityListeners = new Set<(event: WorkspaceActivityEvent) => void>()
  // A settled tool update carries no title, so the creator's tool is only
  // recognizable from the title its first update reported. Remembering that
  // one tool keeps calls the workspace never sees settle from accumulating.
  const creatorCalls = new Set<string>()
  const invalidationListeners = new Map<string, Set<() => void>>()

  function rowsFor(threadIds: Iterable<string>) {
    return [...threadIds].flatMap((threadId) => {
      const row = rows.get(threadId)
      return row ? [{ ...row }] : []
    })
  }

  /**
   * A snapshot answers for every Session it was asked about. One that omits a
   * Session the catalog has not reached yet — a reloaded deep link naming a
   * Session past page one — would read as a Session the workspace does not
   * have, so the read that resolves it publishes instead.
   */
  function notify(subscription: MetadataSubscription) {
    for (const threadId of subscription.threadIds)
      if (!rows.has(threadId)) return
    subscription.listener(rowsFor(subscription.threadIds))
  }

  function publish(threadId: string) {
    for (const subscription of subscriptions)
      if (subscription.threadIds.has(threadId)) notify(subscription)
  }

  function write(threadId: string, next: SessionMetadata) {
    if (sameRow(rows.get(threadId), next)) return
    rows.set(threadId, next)
    publish(threadId)
  }

  /** `unread` is absent when unknowable on this read and never overwrites. */
  function put(
    threadId: string,
    info: AosSessionInfoMeta,
    updatedAt?: string | null
  ) {
    const previous = rows.get(threadId)
    const unread = info.unread ?? previous?.unread
    write(threadId, {
      threadId,
      agentId: info.agentId,
      updatedAt:
        updatedAt ?? previous?.updatedAt ?? new Date(now()).toISOString(),
      status: info.status,
      ...(unread === undefined ? {} : { unread }),
    })
  }

  function patch(threadId: string, change: Partial<SessionMetadata>) {
    const previous = rows.get(threadId)
    if (previous) write(threadId, { ...previous, ...change })
  }

  function setTodos(threadId: string, next: TodoItem[]) {
    todos.set(threadId, next)
    for (const listener of todoListeners.get(threadId) ?? [])
      listener(next.map((todo) => ({ ...todo })))
  }

  function emitActivity(event: WorkspaceActivityEvent) {
    for (const listener of activityListeners) listener(event)
  }

  /**
   * Agent creation is observable only as the creator tool's own result, which
   * the workspace reads as one content-free receipt per settled call.
   */
  function acceptToolCall(
    threadId: string,
    update: {
      toolCallId: string
      title?: string | null
      status?: string | null
      rawOutput?: unknown
    }
  ) {
    const key = toolCallKey(threadId, update.toolCallId)
    if (typeof update.title === "string") {
      if (AGENT_CREATION_TOOLS.has(update.title)) creatorCalls.add(key)
      else creatorCalls.delete(key)
    }
    const status = update.status
    if (status !== "completed" && status !== "failed" && status !== "cancelled")
      return
    // Any settled status releases the call; only a completed one reports.
    const creatorCall = creatorCalls.delete(key)
    if (!creatorCall || status !== "completed") return
    const receipt = agentCreationReceiptOf(update.rawOutput)
    if (!receipt) return
    emitActivity({
      id: `${threadId}:${update.toolCallId}`,
      type: receipt.ok ? "agent-ready" : "agent-activation-failed",
      agentId: receipt.agentId,
      threadId,
      occurredAt: new Date(now()).toISOString(),
    })
  }

  /** An update whose `_meta.aos` does not parse carries nothing to publish. */
  function acceptUpdate(
    threadId: string,
    update: SessionUpdate,
    meta: Record<string, unknown> | undefined
  ) {
    if (SessionUpdate.isStateUpdate(update))
      return patch(threadId, { status: statusFromState(update) })
    if (SessionUpdate.isSessionInfoUpdate(update)) {
      if (update.title) titles.set(threadId, update.title)
      const info = AosSessionInfoMetaSchema.safeParse(meta)
      if (info.success) put(threadId, info.data, update.updatedAt)
      return
    }
    if (SessionUpdate.isToolCallUpdate(update))
      return acceptToolCall(threadId, update)
    if (!SessionUpdate.isPlanUpdate(update)) return
    const plan = AosPlanMetaSchema.safeParse(meta)
    if (plan.success) setTodos(threadId, plan.data.todos)
  }

  /** Attached Sessions stream their own status, Todos, and row changes. */
  function observe(threadId: string) {
    if (observed.has(threadId)) return
    observed.set(
      threadId,
      connection.onSessionUpdate(threadId, (update, meta) =>
        acceptUpdate(threadId, update, meta)
      )
    )
  }

  onAosNotification(
    connection,
    AOS_METHODS.notify.activity,
    AosActivityNotificationSchema,
    (notification) => {
      if (notification.type === "unread-changed")
        return patch(notification.sessionId, { unread: notification.unread })
      const event = activityEventOf(notification)
      if (event) emitActivity(event)
    }
  )

  onAosNotification(
    connection,
    AOS_METHODS.notify.sessionInvalidated,
    AosSessionInvalidatedNotificationSchema,
    ({ sessionId }) => {
      for (const listener of invalidationListeners.get(sessionId) ?? [])
        listener()
    }
  )

  return {
    observe,
    put,
    rowsFor,
    /** The provider's title, as a list page or an attached Session reports it. */
    setTitle: (threadId: string, title: string) => titles.set(threadId, title),
    /** The proxy's read state, or the operator's own optimistic ack. */
    setUnread: (threadId: string, unread: boolean) =>
      patch(threadId, { unread }),
    setStatus: (threadId: string, status: SessionStatus) =>
      patch(threadId, { status }),
    knows: (threadId: string) => rows.has(threadId),
    agentIdOf: (threadId: string) => rows.get(threadId)?.agentId,
    /** The newest title the provider reported, for the thread list to stream. */
    title: (threadId: string) => titles.get(threadId),
    status: (threadId: string): SessionStatus =>
      rows.get(threadId)?.status ?? "unknown",

    subscribeMetadata(
      threadIds: readonly string[],
      listener: MetadataListener
    ) {
      const subscription = { threadIds: new Set(threadIds), listener }
      subscriptions.add(subscription)
      queueMicrotask(() => {
        if (subscriptions.has(subscription)) notify(subscription)
      })
      return () => subscriptions.delete(subscription)
    },

    subscribeStatus(threadId: string, listener: () => void) {
      const subscription = {
        threadIds: new Set([threadId]),
        listener: () => listener(),
      }
      subscriptions.add(subscription)
      return () => subscriptions.delete(subscription)
    },

    subscribeTodos(threadId: string, listener: (todos: TodoItem[]) => void) {
      const listeners = todoListeners.get(threadId) ?? new Set()
      listeners.add(listener)
      todoListeners.set(threadId, listeners)
      queueMicrotask(() => {
        if (listeners.has(listener))
          listener((todos.get(threadId) ?? []).map((todo) => ({ ...todo })))
      })
      return () => {
        listeners.delete(listener)
        if (!listeners.size) todoListeners.delete(threadId)
      }
    },

    subscribeActivity(listener: (event: WorkspaceActivityEvent) => void) {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },

    subscribeInvalidation(threadId: string, listener: () => void) {
      const listeners = invalidationListeners.get(threadId) ?? new Set()
      listeners.add(listener)
      invalidationListeners.set(threadId, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) invalidationListeners.delete(threadId)
      }
    },
  }
}

/** One `session/list` entry as a workspace row. */
export function rowOf(session: SessionInfo) {
  return {
    threadId: session.sessionId,
    info: AosSessionInfoMetaSchema.parse(session._meta?.aos),
    updatedAt: session.updatedAt,
    title: session.title,
  }
}
