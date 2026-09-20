import type { Session } from "../../protocol"

/**
 * One cached Session row. `unread` is present only when a list read reported
 * it or a mark-read write settled it; detail reads never carry it and never
 * clear a known value. `pinned` comes from whichever read reports it, and a
 * read that omits it likewise never clears a known value.
 */
export type SessionRow = Session & { unread?: boolean }

export type SessionRowListener = (row: SessionRow) => void

/**
 * Proxy-owned cache of Session rows for one deployment. It is the single
 * source the ACP layer projects `session_info_update` from, and the place the
 * read-state write guard lives: after `markRead`, list rows that still report
 * unread for that Session are ignored for `READ_GUARD_MS`.
 */
export interface SessionRows {
  get(agentId: string, sessionId: string): SessionRow | undefined
  /** Merges list rows (which may carry `unread`); returns the rows that changed. */
  rememberList(rows: readonly SessionRow[]): SessionRow[]
  /** Merges a detail read; `unread` on the argument is ignored. */
  rememberDetail(row: Session): SessionRow
  /** Optimistically settles `unread: false` and arms the write guard. */
  markRead(agentId: string, sessionId: string): SessionRow | undefined
  forget(agentId: string, sessionId: string): void
  subscribe(listener: SessionRowListener): () => void
}

export const READ_GUARD_MS = 10_000

/**
 * Fields a merge compares. `unread` and `pinned` are the ones a read may
 * legitimately omit; the merging spread already carries a known `pinned`
 * forward, while `unread` is resolved before the comparison rather than inside
 * it, because our own mark-read outranks a stale page.
 */
const COMPARED: readonly (keyof SessionRow)[] = [
  "id",
  "agentId",
  "title",
  "archived",
  "updatedAt",
  "status",
  "unread",
  "pinned",
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

/** Settles `unread` on a merged row; an unknown value leaves it absent. */
function withUnread(row: SessionRow, unread: boolean | undefined): SessionRow {
  const next: SessionRow = { ...row }
  if (unread === undefined) delete next.unread
  else next.unread = unread
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
        const unread = guarded(key) && row.unread === true ? false : row.unread
        const merged = withUnread({ ...previous, ...row }, unread)
        rows.set(key, merged)
        if (changed(previous, merged)) updated.push(merged)
      }
      for (const row of updated) publish(row)
      return updated
    },

    rememberDetail(row) {
      const key = rowKey(row.agentId, row.id)
      const previous = rows.get(key)
      const merged = withUnread({ ...previous, ...row }, previous?.unread)
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
      const merged = withUnread(previous, false)
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
