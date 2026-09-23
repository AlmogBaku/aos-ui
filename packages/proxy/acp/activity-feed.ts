import type { AosActivityNotification } from "../../protocol/acp"
import {
  PendingRequestKind,
  type ExecutionEvent,
  type PendingRequest,
} from "../core/events"
import type { RuntimeInstance } from "../core/runtime"
import type { SessionRow, SessionRows } from "../core/session-rows"
import type { ActivityFeed } from "./types"

const DEFAULT_LIMIT = 200
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
/** One catalog page is the provider maximum and all a badge needs. */
const HYDRATION_PAGE_SIZE = 100

export type ActivityFeedOptions = {
  runtimeInstance: RuntimeInstance
  sessionRows: SessionRows
  /** Agents this connection may observe; every Agent when absent. */
  agentIds?: () => Promise<string[]>
  now?: () => number
  limit?: number
  maxAgeMs?: number
}

/** The one place the attention kind is decided; every non-permission is a question. */
export function attentionKindOf(
  request: PendingRequest
): "permission" | "question" {
  return request.kind === PendingRequestKind.Permission
    ? "permission"
    : "question"
}

const ACTIVITY_TYPES = {
  "turn-started": "run-started",
  "turn-finished": "run-finished",
  "turn-failed": "run-failed",
  "attention-requested": "attention-requested",
  "attention-resolved": "attention-resolved",
} as const satisfies Record<
  ExecutionEvent["kind"],
  AosActivityNotification["type"]
>

/** The activity type an execution event is spelled as on the wire. */
export function activityTypeOf<Kind extends ExecutionEvent["kind"]>(
  kind: Kind
): (typeof ACTIVITY_TYPES)[Kind] {
  return ACTIVITY_TYPES[kind]
}

function notificationOf(event: ExecutionEvent): AosActivityNotification {
  const base = {
    agentId: event.agentId,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
  }
  switch (event.kind) {
    case "turn-started":
    case "turn-finished":
    case "turn-failed":
      return {
        ...base,
        type: activityTypeOf(event.kind),
        lifecycleId: event.turnId,
      }
    case "attention-requested":
      return {
        ...base,
        type: "attention-requested",
        requestId: event.request.requestId,
        attentionKind: attentionKindOf(event.request),
      }
    case "attention-resolved":
      return { ...base, type: "attention-resolved", requestId: event.requestId }
  }
}

export function createActivityFeed({
  runtimeInstance,
  sessionRows,
  agentIds,
  now = Date.now,
  limit = DEFAULT_LIMIT,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
}: ActivityFeedOptions): ActivityFeed {
  const { runtime, sessions: coordinator } = runtimeInstance
  const buffer: AosActivityNotification[] = []
  const listeners = new Set<(event: AosActivityNotification) => void>()
  const lastUnread = new Map<string, boolean>()
  // Deny until the allowlist resolves, so a guest connection never observes
  // another Agent while its own list is still in flight.
  let observable: Set<string> | undefined = agentIds
    ? new Set<string>()
    : undefined
  let unsubscribeRows: (() => void) | undefined
  let closed = false

  const stamp = () => new Date(now()).toISOString()

  const trim = () => {
    const cutoff = now() - maxAgeMs
    while (buffer.length > 0 && Date.parse(buffer[0]!.occurredAt) < cutoff)
      buffer.shift()
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit)
  }

  const push = (event: AosActivityNotification) => {
    if (closed || (observable && !observable.has(event.agentId))) return
    buffer.push(event)
    trim()
    for (const listener of [...listeners]) listener(event)
  }

  const rowKey = (row: SessionRow) => `${row.agentId}\u0000${row.id}`

  const noteUnread = (row: SessionRow) => {
    const unread = row.unread === true
    if (lastUnread.get(rowKey(row)) === unread) return
    lastUnread.set(rowKey(row), unread)
    push({
      agentId: row.agentId,
      sessionId: row.id,
      occurredAt: stamp(),
      type: "unread-changed",
      unread,
    })
  }

  /** Republishes what the provider already reports about a Session. */
  const noteExecution = (row: SessionRow) => {
    if (row.status !== "waiting-for-input" && row.status !== "failed") return
    const providerId = runtime.resolveSessionId(row.agentId, row.id)
    const execution = providerId
      ? coordinator.snapshot({ agentId: row.agentId, sessionId: providerId })
      : undefined
    const base = {
      agentId: row.agentId,
      sessionId: row.id,
      occurredAt: stamp(),
    }
    if (row.status === "failed") {
      const runId =
        execution && "runId" in execution ? execution.runId : undefined
      push({ ...base, type: "run-failed", lifecycleId: runId ?? row.id })
      return
    }
    for (const request of execution?.requests ?? [])
      push({
        ...base,
        type: "attention-requested",
        requestId: request.requestId,
        attentionKind: attentionKindOf(request),
      })
  }

  const hydrate = async () => {
    try {
      if (agentIds) observable = new Set(await agentIds())
      const catalog = await runtime.listAllSessions(HYDRATION_PAGE_SIZE, 0)
      if (closed) return
      sessionRows.rememberList(catalog.sessions)
      for (const listed of catalog.sessions) {
        const row = sessionRows.get(listed.agentId, listed.id) ?? listed
        // Seeding read first keeps hydration to the Sessions that need a badge.
        lastUnread.set(rowKey(row), false)
        noteUnread(row)
        noteExecution(row)
      }
    } catch {
      // A catalog the provider cannot serve leaves the feed to live events.
    } finally {
      if (!closed) unsubscribeRows = sessionRows.subscribe(noteUnread)
    }
  }

  const unobserve = coordinator.observe((event) => push(notificationOf(event)))
  void hydrate()

  return {
    snapshot() {
      return [...buffer]
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    close() {
      closed = true
      unobserve()
      unsubscribeRows?.()
      listeners.clear()
    },
  }
}
