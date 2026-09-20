import type { PushCategory } from "../../protocol/push"

/** One Session an event arrived for, by the identity a browser knows it by. */
export type CoalescedSession = { agentId: string; sessionId: string }

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
}

export interface PushCoalescer {
  add(
    principalId: string,
    category: PushCategory,
    session: CoalescedSession
  ): void
  close(): void
}

type Window = { sessions: Map<string, CoalescedSession>; cancel: () => void }

const windowKey = (principalId: string, category: PushCategory) =>
  `${principalId}\u0000${category}`

const sessionKey = ({ agentId, sessionId }: CoalescedSession) =>
  `${agentId}\u0000${sessionId}`

/**
 * Collapses a burst of events into one push per principal and category. The
 * first event opens a window fixed from that instant, so a busy Agent can never
 * keep extending it, and the window is what a presence check is applied to:
 * somebody watching needs no push at all, and somebody who has just left keeps
 * the window open until their grace runs out.
 */
export function createPushCoalescer({
  now,
  schedule,
  windowMs,
  graceMs,
  filter,
  presence,
  emit,
}: PushCoalescerOptions): PushCoalescer {
  const windows = new Map<string, Window>()
  let closed = false

  const close = (principalId: string, category: PushCategory) => {
    const key = windowKey(principalId, category)
    const window = windows.get(key)
    if (!window || closed) return
    const sessions = filter(principalId, category, [
      ...window.sessions.values(),
    ])
    if (sessions.length === 0) {
      windows.delete(key)
      return
    }
    const verdict = presence(principalId)
    if (verdict.state === "present") {
      // Somebody is reading this workspace: the events they were told about on
      // screen owe them nothing else.
      windows.delete(key)
      return
    }
    if (verdict.state === "grace") {
      const delayMs = Math.min(Math.max(0, verdict.untilMs - now()), graceMs)
      window.cancel = schedule(() => close(principalId, category), delayMs)
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
        open.sessions.set(sessionKey(session), session)
        return
      }
      const window: Window = {
        sessions: new Map([[sessionKey(session), session]]),
        cancel: () => undefined,
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
