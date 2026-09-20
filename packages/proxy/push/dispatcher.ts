import {
  categoryOf,
  COALESCE_WINDOW_MS,
  PRESENCE_GRACE_MS,
  PushMessageSchema,
  type PushCategory,
} from "../../protocol/push"
import type { RuntimeInstance } from "../core/runtime"
import type { SessionRows } from "../core/session-rows"
import { redactForLog } from "../redaction"
import {
  createPushCoalescer,
  type CoalescedSession,
  type PresenceVerdict,
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
   * A Session the workspace has already shown as read owes nothing, and neither
   * does one on screen right now. A row the proxy has never seen counts as
   * unread: silence is not an acknowledgement.
   */
  const filter = (
    principalId: string,
    _category: PushCategory,
    sessions: CoalescedSession[]
  ) =>
    sessions.filter(
      ({ agentId, sessionId }) =>
        sessionRows.get(agentId, sessionId)?.unread !== false &&
        !presence.exposed(principalId, sessionId)
    )

  /** Presence, or the grace an operator who has just left still holds. */
  const verdict = (principalId: string): PresenceVerdict => {
    if (presence.present(principalId)) return { state: "present" }
    const lastPresentAt = presence.lastPresentAt(principalId)
    if (lastPresentAt === undefined) return { state: "absent" }
    const untilMs = lastPresentAt + PRESENCE_GRACE_MS
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
  })

  const unobserve = runtimeInstance.sessions.observe((event) => {
    const category = categoryOf(event.type)
    if (!category) return
    coalescer.add(principalOf(event.agentId), category, {
      agentId: event.agentId,
      sessionId: event.sessionId,
    })
  })

  return {
    close() {
      unobserve()
      coalescer.close()
    },
  }
}
