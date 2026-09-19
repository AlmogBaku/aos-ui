import type { Session } from "../../protocol"

/**
 * One cached Session row. `unread` is present only when a list read reported
 * it or a mark-read write settled it; detail reads never carry it and never
 * clear a known value.
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
