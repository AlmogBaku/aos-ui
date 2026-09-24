import {
  SessionUpdate,
  StateUpdate,
  type SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2"

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
import { onAosNotification } from "./aos-notification"
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
  /** A live turn of an attached Session just stopped, however it ended. */
  onTurnFinished?: (threadId: string) => void
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
    "turnId" in notification
      ? notification.turnId
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
  return { ...base, type, turnId: notification.turnId }
}

function sameRow(left: SessionMetadata | undefined, right: SessionMetadata) {
  return (
    left !== undefined &&
    left.agentId === right.agentId &&
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.archived === right.archived &&
    left.unread === right.unread &&
    left.pinned === right.pinned &&
    left.createdAt === right.createdAt
  )
}

export function createAcpSessionStore({
  connection,
  now = Date.now,
  onTurnFinished,
}: AcpSessionStoreOptions) {
  const rows = new Map<string, SessionMetadata>()
  const titles = new Map<string, string>()
  const todos = new Map<string, TodoItem[]>()
  const observed = new Map<string, () => void>()
  /** Sessions mid-replay, with the newest status that replay has sent. */
  const replaying = new Map<string, SessionStatus | undefined>()
  const subscriptions = new Set<MetadataSubscription>()
  const todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  const activityListeners = new Set<(event: WorkspaceActivityEvent) => void>()
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

  /**
   * `unread`, `pinned`, and `createdAt` are absent when unknowable on this
   * read and never overwrite; `archived` is on every provider read of a Session.
   */
  function put(
    threadId: string,
    info: AosSessionInfoMeta,
    updatedAt?: string | null
  ) {
    const previous = rows.get(threadId)
    const unread = info.unread ?? previous?.unread
    const pinned = info.pinned ?? previous?.pinned
    const createdAt = info.createdAt ?? previous?.createdAt
    write(threadId, {
      threadId,
      agentId: info.agentId,
      updatedAt:
        updatedAt ?? previous?.updatedAt ?? new Date(now()).toISOString(),
      status: info.status,
      archived: info.archived,
      ...(unread === undefined ? {} : { unread }),
      ...(pinned === undefined ? {} : { pinned }),
      ...(createdAt === undefined ? {} : { createdAt }),
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

  /** Tells a Session's observers to re-read what the provider now holds. */
  function invalidate(threadId: string) {
    for (const listener of invalidationListeners.get(threadId) ?? []) listener()
  }

  /** An update whose `_meta.aos` does not parse carries nothing to publish. */
  function acceptUpdate(
    threadId: string,
    update: SessionUpdate,
    meta: Record<string, unknown> | undefined
  ) {
    if (SessionUpdate.isStateUpdate(update)) {
      const status = statusFromState(update)
      if (replaying.has(threadId)) return void replaying.set(threadId, status)
      const previous = rows.get(threadId)?.status
      patch(threadId, { status })
      if (
        (previous === "running" || previous === "waiting-for-input") &&
        (status === "idle" || status === "failed")
      )
        onTurnFinished?.(threadId)
      return
    }
    if (SessionUpdate.isSessionInfoUpdate(update)) {
      if (update.title && update.title !== titles.get(threadId)) {
        titles.set(threadId, update.title)
        invalidate(threadId)
      }
      const info = AosSessionInfoMetaSchema.safeParse(meta)
      if (info.success) put(threadId, info.data, update.updatedAt)
      return
    }
    if (!SessionUpdate.isPlanUpdate(update)) return
    const plan = AosPlanMetaSchema.safeParse(meta)
    if (plan.success) setTodos(threadId, plan.data.todos)
  }

  /**
   * A replay resends every stored turn's running and idle, and a row that
   * followed each one would repaint every surface showing it per turn. It
   * takes only the status the replay ends on.
   */
  function holdReplayedStatus(threadId: string) {
    replaying.set(threadId, undefined)
    return () => {
      const status = replaying.get(threadId)
      replaying.delete(threadId)
      if (status) patch(threadId, { status })
    }
  }

  /** Attached Sessions stream their own status, Todos, and row changes. */
  function observe(threadId: string) {
    if (observed.has(threadId)) return
    const offUpdates = connection.onSessionUpdate(threadId, (update, meta) =>
      acceptUpdate(threadId, update, meta)
    )
    const offReplays = connection.onSessionReplay(threadId, () =>
      holdReplayedStatus(threadId)
    )
    observed.set(threadId, () => {
      offUpdates()
      offReplays()
    })
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
    ({ sessionId }) => invalidate(sessionId)
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
    /** The operator's own optimistic pin; `undefined` restores a refused one. */
    setPinned: (threadId: string, pinned: boolean | undefined) =>
      patch(threadId, { pinned }),
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

    emitActivity,

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
