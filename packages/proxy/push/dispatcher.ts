import {
  categoryOf,
  COALESCE_WINDOW_MS,
  PRESENCE_CLOSED_GRACE_MS,
  PRESENCE_GRACE_MS,
  PushMessageSchema,
  type PushCategory,
} from "../../protocol/push"
import { activityTypeOf } from "../acp/activity-feed"
import type { RuntimeInstance } from "../core/runtime"
import type { SessionRows } from "../core/session-rows"
import { redactForLog } from "../redaction"
import {
  createPushCoalescer,
  type CoalescedSession,
  type PresenceVerdict,
  type SuppressionReason,
} from "./coalescer"
import type { PresenceRegistry } from "./presence"
import type { PushRegistrations, StoredRegistration } from "./registrations"
import type { PushSender, PushUrgency } from "./sender"

/** Input and failures interrupt; a finished run can wait for the next look. */
const URGENCY: Readonly<Record<PushCategory, PushUrgency>> = {
  input: "high",
  failure: "high",
  completion: "normal",
}

type DispatcherLogger = { info(value: unknown): void }

export type PushDispatcherOptions = {
  runtimeInstance: RuntimeInstance
  /** The same rows the ACP lane maintains, so read state gates delivery. */
  sessionRows: SessionRows
  registrations: PushRegistrations
  presence: PresenceRegistry
  sender: PushSender
  /** Which principal one Agent's events notify. */
  principalOf(agentId: string): string
  logger?: DispatcherLogger
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

export interface PushDispatcher {
  close(): void
}

const defaultSchedule = (callback: () => void, delayMs: number) => {
  const handle = setTimeout(callback, delayMs)
  return () => clearTimeout(handle)
}

/**
 * Turns the coordinator's execution events into device pushes: one window per
 * principal and category, gated by what the workspace already shows, and sent
 * to every device that asked for that category. The message stays content-free,
 * and so does the line this writes about it.
 */
export function createPushDispatcher({
  runtimeInstance,
  sessionRows,
  registrations,
  presence,
  sender,
  principalOf,
  logger,
  now = Date.now,
  schedule = defaultSchedule,
}: PushDispatcherOptions): PushDispatcher {
  /**
   * One line for a window that had candidates and sent nothing: a count, the
   * reason, and for a read decision the two moments it turned on. Timestamps
   * identify nothing, and they are the only way to tell a read that really came
   * after the event from a stamp that merely looks newer than one.
   */
  const suppressed = (
    category: PushCategory,
    reason: SuppressionReason,
    sessions: number,
    decision?: { readAtMs: number; occurredAtMs: number }
  ) => {
    logger?.info(
      redactForLog({
        event: "push.suppressed",
        category,
        reason,
        sessions,
        ...decision,
      })
    )
  }

  /**
   * Whether the operator has already seen *this event*. A Session read after the
   * event happened owes nothing, and neither does one on screen right now. Read
   * state is compared by time, not as a boolean: the cache learns "read" while
   * the operator is looking, and only a browser that is still connected can ever
   * report it unread again — so a boolean would silence every event that arrives
   * once the workspace is closed, which is exactly when a push is owed.
   */
  const filter = (
    principalId: string,
    category: PushCategory,
    sessions: CoalescedSession[]
  ) => {
    /** The read decision worth reporting: the one that held back the oldest event. */
    let read: { readAtMs: number; occurredAtMs: number } | undefined
    let exposed = false
    const kept = sessions.filter(({ agentId, sessionId, occurredAtMs }) => {
      const readAtMs = sessionRows.get(agentId, sessionId)?.readAt
      if (readAtMs !== undefined && readAtMs >= occurredAtMs) {
        if (!read || occurredAtMs < read.occurredAtMs)
          read = { readAtMs, occurredAtMs }
        return false
      }
      if (presence.exposed(principalId, sessionId)) {
        exposed = true
        return false
      }
      return true
    })
    if (kept.length === 0 && sessions.length > 0) {
      // A Session on screen is the stronger reason to stay quiet, so it is the
      // one reported when a window was emptied by both.
      if (exposed) suppressed(category, "exposed", sessions.length)
      else suppressed(category, "read", sessions.length, read)
    }
    return kept
  }

  /**
   * Presence, or the grace an operator who has just left still holds. An
   * operator who is away — backgrounded, hidden or idle — keeps the full window;
   * one whose last connection closed gets only long enough for a reload to
   * reconnect and say so.
   */
  const verdict = (principalId: string): PresenceVerdict => {
    if (presence.present(principalId)) return { state: "present" }
    const lastPresentAt = presence.lastPresentAt(principalId)
    if (lastPresentAt === undefined) return { state: "absent" }
    const untilMs =
      lastPresentAt +
      (presence.connected(principalId)
        ? PRESENCE_GRACE_MS
        : PRESENCE_CLOSED_GRACE_MS)
    return untilMs > now() ? { state: "grace", untilMs } : { state: "absent" }
  }

  const deliver = async (
    principalId: string,
    category: PushCategory,
    sessions: CoalescedSession[],
    closedAt: number
  ) => {
    const devices = registrations
      .list(principalId)
      .filter((device) => device.categories[category])
    if (devices.length === 0) return
    // Ids travel only when exactly one Session is meant; a count carries none.
    const only = sessions.length === 1 ? sessions[0] : undefined
    const message = {
      v: 1 as const,
      category,
      count: sessions.length,
      occurredAt: new Date(closedAt).toISOString(),
      ...(only ? { agentId: only.agentId, sessionId: only.sessionId } : {}),
    }
    const settled = await Promise.allSettled(
      devices.map(async (device) => ({
        device,
        outcome: await sender.send(
          device,
          PushMessageSchema.parse({ ...message, locale: device.locale }),
          URGENCY[category]
        ),
      }))
    )

    const statuses: Record<string, number> = {}
    const departed: StoredRegistration[] = []
    let sent = 0
    let gone = 0
    let failed = 0
    for (const entry of settled) {
      if (entry.status === "rejected") {
        failed += 1
        continue
      }
      const { device, outcome } = entry.value
      if (outcome.status !== undefined) {
        const key = String(outcome.status)
        statuses[key] = (statuses[key] ?? 0) + 1
      }
      if (outcome.result === "sent") sent += 1
      else if (outcome.result === "gone") {
        gone += 1
        departed.push(device)
      } else failed += 1
    }
    // A push service that reports a device gone has unsubscribed it for good.
    for (const device of departed)
      await registrations
        .remove(principalId, device.subscription.endpoint)
        .catch(() => undefined)

    logger?.info(
      redactForLog({
        event: "push.dispatched",
        category,
        count: sessions.length,
        devices: devices.length,
        sent,
        gone,
        failed,
        statuses,
      })
    )
  }

  const coalescer = createPushCoalescer({
    now,
    schedule,
    windowMs: COALESCE_WINDOW_MS,
    graceMs: PRESENCE_GRACE_MS,
    filter,
    presence: verdict,
    emit: (principalId, category, sessions, closedAt) => {
      void deliver(principalId, category, sessions, closedAt).catch(
        () => undefined
      )
    },
    onSuppressed: (_principalId, category, reason, sessions) => {
      suppressed(category, reason, sessions)
    },
  })

  const unobserve = runtimeInstance.sessions.observe((event) => {
    const category = categoryOf(activityTypeOf(event.kind))
    if (!category) return
    // A timestamp the provider left unreadable must not silence a notification.
    const occurredAtMs = Date.parse(event.occurredAt)
    coalescer.add(principalOf(event.agentId), category, {
      agentId: event.agentId,
      sessionId: event.sessionId,
      occurredAtMs: Number.isNaN(occurredAtMs) ? now() : occurredAtMs,
    })
  })

  return {
    close() {
      unobserve()
      coalescer.close()
    },
  }
}
