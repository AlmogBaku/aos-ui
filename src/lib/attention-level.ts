import { isRosterAgent } from "@/runtime-adapters/agent-identity"
import type {
  AgentSummary,
  SessionMetadata,
} from "@/runtime-adapters/contracts"
import { isSessionUnread } from "@/lib/workspace-view-model"

/** The state that colors a count, in the status dots' priority. */
export type AttentionTop = "waiting" | "failed" | "unread" | "running"

/**
 * What a set of Sessions holds for the operator: how many need them, and the
 * most urgent of their states. A running Session is never counted; it only
 * names an Agent that has nothing counted.
 */
export type AttentionLevel = {
  count: number
  waiting: number
  failed: number
  top: AttentionTop | null
}

export function attentionLevel(
  sessions: readonly Pick<SessionMetadata, "status" | "unread">[]
): AttentionLevel {
  const counted = sessions.filter(isSessionUnread)
  const waiting = counted.filter(
    ({ status }) => status === "waiting-for-input"
  ).length
  const failed = counted.filter(({ status }) => status === "failed").length
  const running = sessions.some(({ status }) => status === "running")
  const top = waiting
    ? "waiting"
    : failed
      ? "failed"
      : counted.length
        ? "unread"
        : running
          ? "running"
          : null
  return { count: counted.length, waiting, failed, top }
}

/** Only a Session the rail can open counts, so a hidden Agent's count nowhere. */
export function railSessions<Session extends Pick<SessionMetadata, "agentId">>(
  agents: readonly Pick<AgentSummary, "id" | "role" | "visibility">[],
  sessions: readonly Session[]
) {
  const rail = new Set(agents.filter(isRosterAgent).map(({ id }) => id))
  return sessions.filter(({ agentId }) => rail.has(agentId))
}

/** "4 unread, 1 waiting for you, 1 failed": a level as a name reads it. */
export function attentionLabels(
  level: AttentionLevel,
  copy: { unreadCount: string; waitingCount: string; failedCount: string }
) {
  const parts: [string, number][] = [
    [copy.unreadCount, level.count],
    [copy.waitingCount, level.waiting],
    [copy.failedCount, level.failed],
  ]
  // The total is always stated; its breakdown only when there is one.
  return parts
    .filter(([, value], index) => index === 0 || value > 0)
    .map(([template, value]) => template.replace("{count}", String(value)))
}

/** The number a badge can fit; the accessible name keeps the real one. */
export const badgeCount = (count: number) => (count > 9 ? "9+" : String(count))
