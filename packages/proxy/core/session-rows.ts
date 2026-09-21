import type { Session } from "../../protocol"

/**
 * One cached Session row. `unread` is present only when a list read reported
 * it or a mark-read write settled it; detail reads never carry it and never
 * clear a known value.
 *
 * `readAt` is Unix ms of the moment *we* acknowledged a read for the operator,
 * which is what answers "has the operator seen what happened before this?" — a
 * boolean cannot, because it says nothing about when. Only `markRead` knows that
 * moment: a provider reports read as a boolean with no time behind it, so a list
 * page never writes this stamp and can only clear it by reporting the Session
 * unread again. It is proxy-local bookkeeping: no read reports it and nothing
 * projects it to a browser.
 *
 * The cost is deliberate. A Session read on another device keeps no stamp and
 * stays notifiable, so that device may get one push for something already seen.
 * That is the same principle as a row nobody has seen counting as unseen, and it
 * is the only way to keep the gate from silencing an event nobody ever saw.
 */
export type SessionRow = Session & { unread?: boolean; readAt?: number }

export type SessionRowListener = (row: SessionRow) => void

/**
 * Proxy-owned cache of Session rows for one deployment. It is the single
 * source the ACP layer projects `session_info_update` from, and the place the
 * read-state write guard lives: after `markRead`, list rows that still report
 * unread for that Session are ignored for `READ_GUARD_MS`.
 */
export interface SessionRows {
  get(agentId: string, sessionId: string): SessionRow | undefined
  /**
   * Merges list rows (which may carry `unread`); returns the rows that changed.
   * A row the provider reports unread clears `readAt`, because the provider re-lit
   * the Session; no list row ever writes one.
   */
  rememberList(rows: readonly SessionRow[]): SessionRow[]
  /** Merges a detail read; `unread` on the argument is ignored. */
  rememberDetail(row: Session): SessionRow
  /** Optimistically settles `unread: false`, stamps `readAt`, and arms the guard. */
  markRead(agentId: string, sessionId: string): SessionRow | undefined
  forget(agentId: string, sessionId: string): void
  subscribe(listener: SessionRowListener): () => void
}

export const READ_GUARD_MS = 10_000

/**
 * Fields a merge compares, which is also everything a projection reads.
 * `unread` is the only one a read may legitimately omit, so it is resolved
 * before the comparison rather than inside it, and `readAt` is deliberately
 * absent: moving a private stamp is not a change any subscriber needs to see.
 */
const COMPARED: readonly (keyof SessionRow)[] = [
  "id",
  "agentId",
  "title",
  "archived",
  "updatedAt",
  "status",
  "unread",
]

function rowKey(agentId: string, sessionId: string) {
  return `${agentId}\u0000${sessionId}`
}

function changed(previous: SessionRow | undefined, next: SessionRow) {
  return (
    previous === undefined ||
    COMPARED.some((field) => previous[field] !== next[field])
  )
}

/**
 * Settles the read state of a merged row: `unread` as a read reported it, and
 * `readAt` as the moment it was settled read. An unknown value leaves the field
 * absent rather than writing one a read never reported.
 */
function withReadState(
  row: SessionRow,
  unread: boolean | undefined,
  readAt: number | undefined
): SessionRow {
  const next: SessionRow = { ...row }
  if (unread === undefined) delete next.unread
  else next.unread = unread
  if (readAt === undefined) delete next.readAt
  else next.readAt = readAt
  return next
}

export function createSessionRows({
  now = Date.now,
}: { now?: () => number } = {}): SessionRows {
  const rows = new Map<string, SessionRow>()
  const guardedUntil = new Map<string, number>()
  const listeners = new Set<SessionRowListener>()

  /** True while our own mark-read outranks what a list page may still report. */
  const guarded = (key: string) => {
    const until = guardedUntil.get(key)
    if (until === undefined) return false
    if (until > now()) return true
    guardedUntil.delete(key)
    return false
  }

  const publish = (row: SessionRow) => {
    for (const listener of [...listeners]) listener(row)
  }

  return {
    get(agentId, sessionId) {
      return rows.get(rowKey(agentId, sessionId))
    },

    rememberList(incoming) {
      const updated: SessionRow[] = []
      for (const row of incoming) {
        const key = rowKey(row.agentId, row.id)
        const previous = rows.get(key)
        const stale = guarded(key) && row.unread === true
        const unread = stale ? false : row.unread
        // The provider is the authority on *whether* this Session is read, and
        // nobody but our own acknowledgement knows *when*: a page reporting it
        // read carries no time, so it leaves the stamp alone. One reporting it
        // unread re-lit the Session, so nothing in it is read any more.
        const readAt = unread === true ? undefined : previous?.readAt
        const merged = withReadState({ ...previous, ...row }, unread, readAt)
        rows.set(key, merged)
        if (changed(previous, merged)) updated.push(merged)
      }
      for (const row of updated) publish(row)
      return updated
    },

    rememberDetail(row) {
      const key = rowKey(row.agentId, row.id)
      const previous = rows.get(key)
      const merged = withReadState(
        { ...previous, ...row },
        previous?.unread,
        previous?.readAt
      )
      rows.set(key, merged)
      if (changed(previous, merged)) publish(merged)
      return merged
    },

    markRead(agentId, sessionId) {
      const key = rowKey(agentId, sessionId)
      const previous = rows.get(key)
      // With no cached row there is no value to defend, and the first list
      // page that reports one is the only truth we have.
      if (!previous) return undefined
      guardedUntil.set(key, now() + READ_GUARD_MS)
      const merged = withReadState(previous, false, now())
      rows.set(key, merged)
      publish(merged)
      return merged
    },

    forget(agentId, sessionId) {
      const key = rowKey(agentId, sessionId)
      rows.delete(key)
      guardedUntil.delete(key)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
