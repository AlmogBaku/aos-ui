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
  /**
   * Whether this principal still holds any open connection, however it last
   * reported. It separates an operator who left from one who is merely away:
   * a closed workspace may be a reload, so it waits a much shorter grace.
   */
  connected(principalId: string): boolean
  present(principalId: string): boolean
  exposed(principalId: string, sessionId: string): boolean
  /**
   * Unix ms of the moment presence last held for this principal: the last report
   * that held it, or the moment it stopped holding. Absent if it never held.
   */
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

const isFresh = (entry: Entry, at: number) =>
  at - entry.reportedAt <= STALE_AFTER_MS

/** True when this connection was holding presence right up to `at`. */
const wasPresent = (entry: Entry | undefined, at: number) =>
  entry !== undefined && holdsPresence(entry) && isFresh(entry, at)

export function createPresenceRegistry({
  now = Date.now,
}: { now?: () => number } = {}): PresenceRegistry {
  const principals = new Map<string, Principal>()

  /** True when one fresh report of this principal matches. */
  const some = (principalId: string, matches: (entry: Entry) => boolean) => {
    const at = now()
    for (const entry of principals.get(principalId)?.connections.values() ?? [])
      if (isFresh(entry, at) && matches(entry)) return true
    return false
  }

  return {
    set(principalId, connectionId, report) {
      const principal = principals.get(principalId) ?? {
        connections: new Map<string, Entry>(),
      }
      principals.set(principalId, principal)
      const reportedAt = now()
      const previous = principal.connections.get(connectionId)
      const entry: Entry = { ...report, reportedAt }
      principal.connections.set(connectionId, entry)
      // Presence lapses the moment it stops holding, not one heartbeat earlier:
      // a connection that goes to the background or idle has been present until
      // exactly now, and a grace window is measured from here.
      if (holdsPresence(entry) || wasPresent(previous, reportedAt))
        principal.lastPresentAt = reportedAt
    },

    clear(principalId, connectionId) {
      const principal = principals.get(principalId)
      const removed = principal?.connections.get(connectionId)
      if (!principal || !removed) return
      principal.connections.delete(connectionId)
      const at = now()
      if (wasPresent(removed, at)) principal.lastPresentAt = at
    },

    connected(principalId) {
      // A registered entry is an open socket, whether or not it still reports.
      return (principals.get(principalId)?.connections.size ?? 0) > 0
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
