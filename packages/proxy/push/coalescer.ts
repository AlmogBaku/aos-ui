import type { PushCategory } from "../../protocol/push"

/** One Session an event arrived for, by the identity a browser knows it by. */
export type CoalescedSession = {
  agentId: string
  sessionId: string
  /**
   * Unix ms of the earliest event this window collapsed for this Session. The
   * gate answers "has the operator seen this?", so it needs the moment the
   * oldest thing it would be told about happened.
   */
  occurredAtMs: number
}

/**
 * Why a window closed without sending anything. The injected gate decides the
 * first two and the presence verdict the last two.
 */
export type SuppressionReason = "read" | "exposed" | "present" | "grace"

/** What the workspace looked like when a window tried to close. */
export type PresenceVerdict =
  | { state: "present" }
  | { state: "grace"; untilMs: number }
  | { state: "absent" }

export type PushCoalescerOptions = {
  now(): number
  /** Returns the canceller for one scheduled close. */
  schedule(callback: () => void, delayMs: number): () => void
  windowMs: Readonly<Record<PushCategory, number>>
  /** Longest one window may be held open waiting for presence to lapse. */
  graceMs: number
  /** Drops the Sessions this principal does not need telling about. */
  filter(
    principalId: string,
    category: PushCategory,
    sessions: CoalescedSession[]
  ): CoalescedSession[]
  presence(principalId: string): PresenceVerdict
  emit(
    principalId: string,
    category: PushCategory,
    sessions: CoalescedSession[],
    closedAt: number
  ): void
  /** A window that had candidates and sent nothing, for the deployment's log. */
  onSuppressed?(
    principalId: string,
    category: PushCategory,
    reason: Extract<SuppressionReason, "present" | "grace">,
    sessions: number
  ): void
}

export interface PushCoalescer {
  add(
    principalId: string,
    category: PushCategory,
    session: CoalescedSession
  ): void
  close(): void
}

type Window = {
  sessions: Map<string, CoalescedSession>
  cancel: () => void
  /** One window waits out one grace; a second verdict is decided, not deferred. */
  graced: boolean
}

const windowKey = (principalId: string, category: PushCategory) =>
  `${principalId}\u0000${category}`

const sessionKey = ({ agentId, sessionId }: CoalescedSession) =>
  `${agentId}\u0000${sessionId}`

/**
 * Collapses a burst of events into one push per principal and category. The
 * first event opens a window fixed from that instant, so a busy Agent can never
 * keep extending it, and the window is what a presence check is applied to:
 * somebody watching needs no push at all, and somebody who has just left holds
 * the window open for one grace, after which the next verdict settles it.
 */
export function createPushCoalescer({
  now,
  schedule,
  windowMs,
  graceMs,
  filter,
  presence,
  emit,
  onSuppressed,
}: PushCoalescerOptions): PushCoalescer {
  const windows = new Map<string, Window>()
  let closed = false

  const close = (principalId: string, category: PushCategory) => {
    const key = windowKey(principalId, category)
    const window = windows.get(key)
    if (!window || closed) return
    const candidates = [...window.sessions.values()]
    const sessions = filter(principalId, category, candidates)
    if (sessions.length === 0) {
      // The gate reports why it emptied the window; it knows which Sessions.
      windows.delete(key)
      return
    }
    const verdict = presence(principalId)
    if (verdict.state === "present") {
      // Somebody is reading this workspace: the events they were told about on
      // screen owe them nothing else.
      windows.delete(key)
      onSuppressed?.(principalId, category, "present", sessions.length)
      return
    }
    if (verdict.state === "grace" && !window.graced) {
      // The operator has only just left: hold the window until their grace ends,
      // once. Whatever the verdict is then settles it.
      window.graced = true
      const delayMs = Math.min(Math.max(0, verdict.untilMs - now()), graceMs)
      window.cancel = schedule(() => close(principalId, category), delayMs)
      onSuppressed?.(principalId, category, "grace", sessions.length)
      return
    }
    windows.delete(key)
    emit(principalId, category, sessions, now())
  }

  return {
    add(principalId, category, session) {
      if (closed) return
      const key = windowKey(principalId, category)
      const open = windows.get(key)
      if (open) {
        // The window answers for the oldest event it holds per Session.
        const previous = open.sessions.get(sessionKey(session))
        if (previous && previous.occurredAtMs <= session.occurredAtMs) return
        open.sessions.set(sessionKey(session), session)
        return
      }
      const window: Window = {
        sessions: new Map([[sessionKey(session), session]]),
        cancel: () => undefined,
        graced: false,
      }
      windows.set(key, window)
      window.cancel = schedule(
        () => close(principalId, category),
        windowMs[category]
      )
    },

    close() {
      closed = true
      for (const window of windows.values()) window.cancel()
      windows.clear()
    },
  }
}
