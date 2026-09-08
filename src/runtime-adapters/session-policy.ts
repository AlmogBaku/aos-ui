import type { AgentSummary, SessionMetadata } from "./contracts"

export const ACTIVE_SESSION_WINDOW_MS = 12 * 60 * 60 * 1000

export function nextSessionEligibilityBoundary(
  sessions: readonly SessionMetadata[],
  now: Date
) {
  const nowMs = now.getTime()
  let nextBoundary = Number.POSITIVE_INFINITY

  for (const session of sessions) {
    if (
      session.status === "running" ||
      session.status === "waiting-for-input"
    ) {
      continue
    }

    const updatedAt = Date.parse(session.updatedAt)
    const boundary = updatedAt + ACTIVE_SESSION_WINDOW_MS
    if (
      Number.isFinite(updatedAt) &&
      updatedAt <= nowMs &&
      boundary > nowMs &&
      boundary < nextBoundary
    ) {
      nextBoundary = boundary
    }
  }

  return Number.isFinite(nextBoundary) ? nextBoundary : null
}

function newestFirst(a: SessionMetadata, b: SessionMetadata) {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
}

function deduplicateNewest(sessions: SessionMetadata[]) {
  const byThread = new Map<string, SessionMetadata>()

  for (const session of sessions) {
    const existing = byThread.get(session.threadId)
    if (!existing || newestFirst(session, existing) < 0) {
      byThread.set(session.threadId, session)
    }
  }

  return [...byThread.values()].sort(newestFirst)
}

export function activeSessionsForAgent(
  sessions: SessionMetadata[],
  agentId: string,
  now: Date,
  manuallyOpenedThreadIds: ReadonlySet<string>
) {
  const nowMs = now.getTime()

  return deduplicateNewest(
    sessions.filter((session) => {
      if (session.agentId !== agentId) return false

      const age = nowMs - Date.parse(session.updatedAt)
      const isRecent =
        Number.isFinite(age) && age >= 0 && age < ACTIVE_SESSION_WINDOW_MS
      const isLive =
        session.status === "running" || session.status === "waiting-for-input"

      return isRecent || isLive || manuallyOpenedThreadIds.has(session.threadId)
    })
  )
}

export function joinSessionsToAgents(
  agents: AgentSummary[],
  sessions: SessionMetadata[]
) {
  const knownAgents = new Set(agents.map(({ id }) => id))
  const joined = new Map<string, SessionMetadata[]>(
    agents.map(({ id }) => [id, []] as const)
  )

  for (const session of deduplicateNewest(sessions)) {
    if (!knownAgents.has(session.agentId)) continue
    joined.get(session.agentId)?.push(session)
  }

  return joined
}

type ResolveSessionSelectionOptions = {
  agentId: string
  sessions: SessionMetadata[]
  activeSessions: SessionMetadata[]
  lastSelectedThreadId?: string | null
}

export function resolveSessionSelection({
  agentId,
  sessions,
  activeSessions,
  lastSelectedThreadId,
}: ResolveSessionSelectionOptions) {
  const history = deduplicateNewest(
    sessions.filter((session) => session.agentId === agentId)
  )

  if (
    lastSelectedThreadId &&
    history.some(({ threadId }) => threadId === lastSelectedThreadId)
  ) {
    return lastSelectedThreadId
  }

  return activeSessions[0]?.threadId ?? history[0]?.threadId ?? null
}
