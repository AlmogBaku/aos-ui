import type { SessionMetadata } from "@/runtime-adapters/contracts"

import type { ActivityRecord } from "./activity"

export type InboxState = "waiting" | "failed" | "unread" | "ready"

/**
 * The Agent as the rail draws it, so a draft keeps its dashed tile and name.
 * It carries no status: a row's tile stays still, however many rows it leads.
 */
export type InboxAgent = { id: string; name: string; avatar?: string }

export type InboxRow = {
  agentId: string
  sessionId: string
  agent: InboxAgent
  title: string | undefined
  state: InboxState
  time: string
}

export type Inbox = { waiting: InboxRow[]; unread: InboxRow[] }

/** What a Session's newest record says it is, once it is not waiting. */
const recordStates: Record<ActivityRecord["type"], InboxState> = {
  "turn-finished": "unread",
  "turn-failed": "failed",
  "attention-requested": "unread",
  "agent-ready": "ready",
  "agent-activation-failed": "failed",
}

const scope = ({
  agentId,
  sessionId,
}: {
  agentId: string
  sessionId: string
}) => JSON.stringify([agentId, sessionId])

/**
 * One row per counted Session, newest first within its group. A Session's
 * newest record from this tab gives its state and time; without one, which is
 * every Session after a reload, its own status and update time do.
 */
export function buildInbox({
  sessions,
  records,
  agents,
  titles,
}: {
  sessions: readonly SessionMetadata[]
  records: readonly ActivityRecord[]
  agents: readonly InboxAgent[]
  titles: ReadonlyMap<string, string>
}): Inbox {
  const newest = new Map<string, ActivityRecord>()
  for (const record of records) {
    const known = newest.get(scope(record))
    if (!known || Date.parse(record.occurredAt) > Date.parse(known.occurredAt))
      newest.set(scope(record), record)
  }
  const rows = sessions.flatMap((session): InboxRow[] => {
    const agent = agents.find(({ id }) => id === session.agentId)
    if (!agent) return []
    const record = newest.get(scope(session))
    const state =
      session.status === "waiting-for-input"
        ? "waiting"
        : record
          ? recordStates[record.type]
          : session.status === "failed"
            ? "failed"
            : "unread"
    const { id, name, avatar } = agent
    return [
      {
        agentId: session.agentId,
        sessionId: session.sessionId,
        agent: { id, name, avatar },
        title: titles.get(session.sessionId),
        state,
        time: record?.occurredAt ?? session.updatedAt,
      },
    ]
  })
  rows.sort((left, right) => Date.parse(right.time) - Date.parse(left.time))
  return {
    waiting: rows.filter(({ state }) => state === "waiting"),
    unread: rows.filter(({ state }) => state !== "waiting"),
  }
}
