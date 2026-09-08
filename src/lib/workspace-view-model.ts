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
    return "running"
  if (
    agent.status === "unknown" ||
    owned.some(({ status }) => status === "unknown")
  )
    return "unknown"
  return "idle"
}

type BuildAgentSessionViewOptions = {
  agentId: string
  sessions: readonly SessionMetadata[]
  manuallyOpenedThreadIds: ReadonlySet<string>
  titles: ReadonlyMap<string, string>
  now: Date
  untitledLabel?: string
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

export function buildAgentSessionView({
  agentId,
  sessions,
  manuallyOpenedThreadIds,
  titles,
  now,
  untitledLabel = "Untitled session",
}: BuildAgentSessionViewOptions) {
  const toView = (session: SessionMetadata): WorkspaceSessionView => ({
    ...session,
    title: titles.get(session.threadId)?.trim() || untitledLabel,
  })
  const allSessions = newestUniqueSessions(
    sessions.filter((session) => session.agentId === agentId)
  )

  return {
    openSessions: activeSessionsForAgent(
      [...sessions],
      agentId,
      now,
      manuallyOpenedThreadIds
    ).map(toView),
    allSessions: allSessions.map(toView),
  }
}
