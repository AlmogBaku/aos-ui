import type { Logger } from "../../lifecycle"
import type { Catalog } from "../core/catalog"
import {
  PendingRequestKind,
  type ExecutionEvent,
  type PendingRequest,
} from "../core/events"
import type { Activity } from "../core/member"
import type { SessionCoordinator } from "../core/session-coordinator"
import type { SessionRow } from "../core/session-rows"
import type { ActivityFeed } from "./types"

/** One catalog page is the provider maximum and all a badge needs. */
const HYDRATION_PAGE_SIZE = 100

export type ActivityFeedOptions = {
  catalog: Pick<Catalog, "list" | "rows" | "scope">
  coordinator: Pick<SessionCoordinator, "snapshot" | "subscribeExecutions">
  now?: () => number
  logger?: Logger
}

/** The one place the attention kind is decided; every non-permission is a question. */
export function attentionKindOf(
  request: PendingRequest
): "permission" | "question" {
  return request.kind === PendingRequestKind.Permission
    ? "permission"
    : "question"
}

function activityOf(event: ExecutionEvent): Activity {
  const base = {
    agentId: event.agentId,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
  }
  switch (event.kind) {
    case "turn-started":
    case "turn-finished":
    case "turn-failed":
      return { ...base, type: event.kind, turnId: event.turnId }
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

const rowKey = (row: SessionRow) => `${row.agentId}\u0000${row.id}`

export function createActivityFeed({
  catalog,
  coordinator,
  now = Date.now,
  logger,
}: ActivityFeedOptions): ActivityFeed {
  const stamp = () => new Date(now()).toISOString()

  /** One connection's feed, which observes nothing once stopped. */
  function open(listener: (activity: Activity) => void) {
    const lastUnread = new Map<string, boolean>()
    let unsubscribeRows: (() => void) | undefined
    let closed = false

    const push = (activity: Activity) => {
      if (!closed) listener(activity)
    }

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
      const scope = catalog.scope(row.agentId, row.id)
      const execution = scope ? coordinator.snapshot(scope) : undefined
      const base = {
        agentId: row.agentId,
        sessionId: row.id,
        occurredAt: stamp(),
      }
      if (row.status === "failed") {
        const turnId =
          execution && "turnId" in execution ? execution.turnId : undefined
        push({ ...base, type: "turn-failed", turnId: turnId ?? row.id })
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
        const { rows } = await catalog.list(undefined, 0, HYDRATION_PAGE_SIZE)
        if (closed) return
        for (const row of rows) {
          // Seeding read first keeps hydration to the Sessions that need a badge.
          lastUnread.set(rowKey(row), false)
          noteUnread(row)
          noteExecution(row)
        }
      } catch {
        // A catalog the provider cannot serve leaves the feed to live events.
      } finally {
        if (!closed) unsubscribeRows = catalog.rows.subscribe(noteUnread)
      }
    }

    const unsubscribe = coordinator.subscribeExecutions((event) =>
      push(activityOf(event))
    )
    hydrate().catch((err: unknown) =>
      logger?.warn({ err }, "activity.feed.hydrate_failed")
    )

    return () => {
      closed = true
      unsubscribe()
      unsubscribeRows?.()
    }
  }

  return { open }
}
