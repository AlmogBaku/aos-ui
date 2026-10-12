import type { SessionMetadata } from "@/runtime-adapters/contracts"

import type { ActivityRecord } from "./activity"

export type InboxState = "waiting" | "failed" | "unread" | "ready"

/**
 * The Agent as the rail draws it, so a draft keeps its dashed tile and name.
 * It carries no status: a row's tile stays still, however many rows it leads.
 */
export type InboxAgent = {
  id: string
  name: string
  avatar?: string
  description?: string
}

/**
 * An Agent the creator just made: it owns no Session yet, so its row comes
 * from the creator's own report and names the Agent, not a Session.
 */
export type ReadyAgent = {
  agentId: string
  /** The creator Session that reported it. */
  sessionId: string
  occurredAt: string
}

export type InboxRow = {
  /** Unique across rows: a Session, or a ready Agent. */
  key: string
  agentId: string
  sessionId: string
  agent: InboxAgent
  title: string | undefined
  state: InboxState
  time: string
  /** What a waiting row is asked, and how many questions follow it. */
  request?: { text: string; more: number | undefined }
}

export type Inbox = { waiting: InboxRow[]; unread: InboxRow[] }

/** What a Session's newest record says it is, once it is not waiting. */
const recordStates: Record<ActivityRecord["type"], InboxState> = {
  "turn-finished": "unread",
  "turn-failed": "failed",
  "attention-requested": "unread",
  "agent-ready": "unread",
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
 * One row per counted Session and per ready Agent, newest first within its
 * group. A Session's newest record from this tab gives its state and time;
 * without one, which is every Session after a reload, its own status and
 * update time do. Only an Agent in `agents` gets a row.
 */
export function buildInbox({
  sessions,
  records,
  ready,
  agents,
  titles,
}: {
  sessions: readonly SessionMetadata[]
  records: readonly ActivityRecord[]
  ready: readonly ReadyAgent[]
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
    const asked =
      state === "waiting" && record?.type === "attention-requested"
        ? record
        : undefined
    return [
      {
        key: session.sessionId,
        agentId: session.agentId,
        sessionId: session.sessionId,
        agent: { id, name, avatar },
        title: titles.get(session.sessionId),
        state,
        time: record?.occurredAt ?? session.updatedAt,
        ...(asked?.requestText
          ? { request: { text: asked.requestText, more: asked.requestMore } }
          : {}),
      },
    ]
  })
  for (const { agentId, sessionId, occurredAt } of ready) {
    const agent = agents.find(({ id }) => id === agentId)
    if (!agent) continue
    const { id, name, avatar, description } = agent
    rows.push({
      key: `ready:${agentId}`,
      agentId,
      sessionId,
      agent: { id, name, avatar },
      title: description,
      state: "ready",
      time: occurredAt,
    })
  }
  rows.sort((left, right) => Date.parse(right.time) - Date.parse(left.time))
  return {
    waiting: rows.filter(({ state }) => state === "waiting"),
    unread: rows.filter(({ state }) => state !== "waiting"),
  }
}
