import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"

import type { AgentSummary, SessionMetadata } from "./contracts"

/**
 * A creator interview stays visible as a draft Agent for two days; after that
 * the abandoned Session drops out of the roster without being deleted.
 */
export const DRAFT_AGENT_WINDOW_MS = 48 * 60 * 60 * 1000

const DRAFT_PREFIX = "draft:"

export const draftAgentId = (sessionId: string) => `${DRAFT_PREFIX}${sessionId}`

/**
 * The one interview that is still a local thread. A provider creates the
 * creator Session on the first turn, so this row precedes any Session and
 * therefore names no thread of its own. It sits outside the `draft:<sessionId>`
 * space so that a Session whose id happens to read like this can never be
 * mistaken for it.
 */
export const PENDING_DRAFT_AGENT_ID = "draft-pending"

export const draftSessionId = (agentId: string) =>
  agentId.startsWith(DRAFT_PREFIX)
    ? agentId.slice(DRAFT_PREFIX.length)
    : undefined

export const isDraftAgentId = (agentId: string) =>
  agentId === PENDING_DRAFT_AGENT_ID || draftSessionId(agentId) !== undefined

/** The Agent a creator Session made, once the catalog lists it stamped. */
export function agentCreatedBy(
  agents: readonly AgentSummary[],
  sessionId: string
) {
  return agents.find(({ creatorSessionId }) => creatorSessionId === sessionId)
}

function isEligible(
  session: SessionMetadata,
  creatorId: string,
  agents: readonly AgentSummary[],
  now: number
) {
  if (session.agentId !== creatorId) return false
  // An interview is done once the Agent it made is listed, but a turn still
  // running or a question still open keeps its row until that settles.
  if (
    session.status !== "running" &&
    session.status !== "waiting-for-input" &&
    agentCreatedBy(agents, session.sessionId)
  )
    return false
  return now - Date.parse(session.updatedAt) < DRAFT_AGENT_WINDOW_MS
}

type ProjectDraftAgentsInput = {
  creator: AgentSummary | undefined
  agents: readonly AgentSummary[]
  sessions: readonly SessionMetadata[]
  now: number
  /** The generic name of a draft whose Session has no title of its own. */
  name: string
  /** Leads every draft description, with the Session's start time after it. */
  draftLabel: string
  /** Formats the start time for the active locale. */
  locale: string
  /** Session titles by Session id, as the thread list reports them. */
  titles: ReadonlyMap<string, string | undefined>
  /**
   * Row id for a creator interview the provider has not listed yet: the
   * sentinel while the thread is local, then its Session id once it has one,
   * so the row never disappears between those two facts.
   */
  pendingDraftAgentId?: string
}

/**
 * Titles that say nothing about the Agent being made. Both locales' names
 * count, since a Session titled in one locale can be read in the other.
 */
const genericTitles = new Set(["", en.actions.newAgent, he.actions.newAgent])

function draftName(title: string | undefined, name: string) {
  const trimmed = title?.trim() ?? ""
  return genericTitles.has(trimmed) ? name : trimmed
}

function draftDescription(
  createdAt: string | undefined,
  { draftLabel, locale }: Pick<ProjectDraftAgentsInput, "draftLabel" | "locale">
) {
  const started = createdAt ? new Date(createdAt) : undefined
  if (!started || Number.isNaN(started.getTime())) return draftLabel
  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(started)
  return `${draftLabel} · ${time}`
}

/**
 * Presents every creator interview whose Agent is not made yet as its own
 * temporary Agent that owns exactly that one Session, so the workspace never
 * exposes the creator.
 */
export function projectDraftAgents(input: ProjectDraftAgentsInput): {
  agents: AgentSummary[]
  sessions: SessionMetadata[]
} {
  const { creator, agents, sessions, now, name, titles, pendingDraftAgentId } =
    input
  if (!creator) return { agents: [...agents], sessions: [...sessions] }

  const draftAgent = (id: string, createdAt?: string): AgentSummary => {
    const sessionId = draftSessionId(id)
    return {
      kind: "ready",
      id,
      name: draftName(sessionId && titles.get(sessionId), name),
      description: draftDescription(createdAt, input),
      visibility: "visible",
    }
  }
  const drafts: AgentSummary[] = []
  const projected = sessions.map((session) => {
    if (!isEligible(session, creator.id, agents, now)) return session
    const id = draftAgentId(session.sessionId)
    drafts.push(draftAgent(id, session.createdAt))
    return { ...session, agentId: id }
  })
  // The pending interview is a row without a Session, never a Session itself:
  // once its Session is listed, that Session alone decides whether it has a row.
  const pendingSessionId =
    pendingDraftAgentId && draftSessionId(pendingDraftAgentId)
  if (
    pendingDraftAgentId &&
    !sessions.some(({ sessionId }) => sessionId === pendingSessionId)
  )
    drafts.push(draftAgent(pendingDraftAgentId))

  return { agents: [...agents, ...drafts], sessions: projected }
}

/** When the oldest still-visible draft ages out, so the rail can re-render. */
export function nextDraftExpiry(
  sessions: readonly SessionMetadata[],
  creatorId: string | undefined,
  now: number
): number | undefined {
  if (!creatorId) return undefined
  let next: number | undefined
  for (const session of sessions) {
    if (session.agentId !== creatorId) continue
    const expiry = Date.parse(session.updatedAt) + DRAFT_AGENT_WINDOW_MS
    if (!Number.isFinite(expiry) || expiry <= now) continue
    if (next === undefined || expiry < next) next = expiry
  }
  return next
}
