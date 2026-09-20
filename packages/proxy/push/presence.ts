import { PRESENCE_HEARTBEAT_MS } from "../../protocol/push"

/**
 * What one connection last reported about the workspace it shows: the exposed
 * Session, whether its tab is in the foreground, and whether the operator has
 * stopped interacting with it.
 */
export type PresenceReport = {
  sessionId: string | null
  foreground: boolean
  idle: boolean
}

/**
 * Workspace presence per principal, as the open connections report it. Push
 * delivery reads it to tell an operator who is already watching from one who
 * is away: `present` means somebody is at the workspace, while `exposed` means
 * one Session is on screen even though its reader has gone quiet — reading a
 * long answer is not presence, but the Session is still visible.
 */
export interface PresenceRegistry {
  /** Records one connection's report, stamped with the moment it arrived. */
  set(principalId: string, connectionId: string, report: PresenceReport): void
  clear(principalId: string, connectionId: string): void
  present(principalId: string): boolean
  exposed(principalId: string, sessionId: string): boolean
  /** Unix ms of the last report that held presence; absent if none ever did. */
  lastPresentAt(principalId: string): number | undefined
}

/** A report this old belongs to a connection that stopped heart-beating. */
const STALE_AFTER_MS = 2 * PRESENCE_HEARTBEAT_MS

type Entry = PresenceReport & { reportedAt: number }

/**
 * One principal's connections, and when presence last held for any of them.
 * The instant outlives the connection that reported it so a grace window can
 * still be measured once every tab has closed.
 */
type Principal = { connections: Map<string, Entry>; lastPresentAt?: number }

const holdsPresence = (entry: Entry) => entry.foreground && !entry.idle

export function createPresenceRegistry({
  now = Date.now,
}: { now?: () => number } = {}): PresenceRegistry {
  const principals = new Map<string, Principal>()

  /** True when one fresh report of this principal matches. */
  const some = (principalId: string, matches: (entry: Entry) => boolean) => {
    const at = now()
    for (const entry of principals.get(principalId)?.connections.values() ?? [])
      if (at - entry.reportedAt <= STALE_AFTER_MS && matches(entry)) return true
    return false
  }

  return {
    set(principalId, connectionId, report) {
      const principal = principals.get(principalId) ?? {
        connections: new Map<string, Entry>(),
      }
      principals.set(principalId, principal)
      const reportedAt = now()
      const entry: Entry = { ...report, reportedAt }
      principal.connections.set(connectionId, entry)
      if (holdsPresence(entry)) principal.lastPresentAt = reportedAt
    },

    clear(principalId, connectionId) {
      principals.get(principalId)?.connections.delete(connectionId)
    },

    present(principalId) {
      return some(principalId, holdsPresence)
    },

    exposed(principalId, sessionId) {
      return some(
        principalId,
        (entry) => entry.foreground && entry.sessionId === sessionId
      )
    },

    lastPresentAt(principalId) {
      return principals.get(principalId)?.lastPresentAt
    },
  }
}
