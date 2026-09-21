import type {
  AgentSummary,
  AgentStatus,
  SessionMetadata,
} from "@/runtime-adapters/contracts"
import { activeSessionsForAgent } from "@/runtime-adapters/session-policy"

export type WorkspaceSessionView = SessionMetadata & { title: string }

export function agentStatusFromSessions(
  agent: AgentSummary,
  sessions: readonly SessionMetadata[]
): AgentStatus {
  if (agent.activity === "unknown") return "unknown"
  const owned = sessions.filter(({ agentId }) => agentId === agent.id)
  if (
    agent.status === "attention" ||
    owned.some(({ status }) => status === "waiting-for-input")
  )
    return "attention"
  if (
    agent.status === "running" ||
    owned.some(({ status }) => status === "running")
  )
    return agent.activity === undefined ? "running" : "active"
  // Native roster activity is not an aggregate of every historical execution.
  if (agent.activity !== undefined) return agent.activity
  if (agent.status === "active") return "active"
  if (
    agent.status === "unknown" ||
    owned.some(({ status }) => status === "unknown")
  )
    return "unknown"
  return "idle"
}

/** Navigation rows show provider unread state on its own, beside the status. */
export function agentUnreadFromSessions(
  agent: AgentSummary,
  sessions: readonly SessionMetadata[]
) {
  return sessions.some(
    (session) => session.agentId === agent.id && session.unread === true
  )
}

/**
 * Activity treats an open attention request as unread too, so the bell count and
 * a drawer item's derived read state always agree.
 */
export function isSessionUnread(session: SessionMetadata) {
  return session.unread === true || session.status === "waiting-for-input"
}

export function workspaceUnreadCount(sessions: readonly SessionMetadata[]) {
  return sessions.filter(isSessionUnread).length
}

type BuildAgentSessionViewOptions = {
  agentId: string
  sessions: readonly SessionMetadata[]
  manuallyOpenedThreadIds: ReadonlySet<string>
  titles: ReadonlyMap<string, string>
  now: Date
  untitledLabel?: string
  /** The Session on screen stays listed even once the provider archives it. */
  visibleThreadId?: string | null
}

function newestUniqueSessions(sessions: readonly SessionMetadata[]) {
  const byThread = new Map<string, SessionMetadata>()

  for (const session of sessions) {
    const existing = byThread.get(session.threadId)
    if (
      !existing ||
      Date.parse(session.updatedAt) > Date.parse(existing.updatedAt)
    ) {
      byThread.set(session.threadId, session)
    }
  }

  return [...byThread.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  )
}

/** Pinned rows lead the open list; recency still orders within either group. */
export function pinnedFirst<Session extends { pinned?: boolean }>(
  sessions: readonly Session[]
) {
  return [
    ...sessions.filter((session) => session.pinned === true),
    ...sessions.filter((session) => session.pinned !== true),
  ]
}

export function buildAgentSessionView({
  agentId,
  sessions,
  manuallyOpenedThreadIds,
  titles,
  now,
  untitledLabel = "Untitled session",
  visibleThreadId = null,
}: BuildAgentSessionViewOptions) {
  const toView = (session: SessionMetadata): WorkspaceSessionView => ({
    ...session,
    title: titles.get(session.threadId)?.trim() || untitledLabel,
  })
  // Archived Sessions leave the open and history lists for their own list.
  const listed = sessions.filter(
    (session) =>
      session.archived !== true || session.threadId === visibleThreadId
  )

  return {
    openSessions: pinnedFirst(
      activeSessionsForAgent(listed, agentId, now, manuallyOpenedThreadIds)
    ).map(toView),
    // A pinned Session is always open, so history never repeats it — not even
    // while its tab is dismissed.
    allSessions: newestUniqueSessions(
      listed.filter(
        (session) => session.agentId === agentId && session.pinned !== true
      )
    ).map(toView),
    archivedSessions: newestUniqueSessions(
      sessions.filter(
        (session) => session.agentId === agentId && session.archived === true
      )
    ).map(toView),
  }
}
