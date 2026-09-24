import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"

import type { AgentSummary, SessionMetadata } from "./contracts"

/**
 * A creator interview stays visible as a draft Agent for two days; after that
 * the abandoned Session drops out of the roster without being deleted.
 */
export const DRAFT_AGENT_WINDOW_MS = 48 * 60 * 60 * 1000

const DRAFT_PREFIX = "draft:"

/** Resolved drafts are content-free thread ids, safe to keep in the browser. */
const RESOLVED_DRAFTS_KEY = "aos-ui.resolved-drafts"

export const draftAgentId = (threadId: string) => `${DRAFT_PREFIX}${threadId}`

/**
 * The one interview that is still a local thread. A provider creates the
 * creator Session on the first turn, so this row precedes any Session and
 * therefore names no thread of its own. It sits outside the `draft:<threadId>`
 * space so that a Session whose id happens to read like this can never be
 * mistaken for it.
 */
export const PENDING_DRAFT_AGENT_ID = "draft-pending"

export const draftThreadId = (agentId: string) =>
  agentId.startsWith(DRAFT_PREFIX)
    ? agentId.slice(DRAFT_PREFIX.length)
    : undefined

export const isDraftAgentId = (agentId: string) =>
  agentId === PENDING_DRAFT_AGENT_ID || draftThreadId(agentId) !== undefined

function isEligible(
  session: SessionMetadata,
  creatorId: string,
  resolvedThreadIds: ReadonlySet<string>,
  now: number
) {
  if (session.agentId !== creatorId) return false
  if (resolvedThreadIds.has(session.threadId)) return false
  return now - Date.parse(session.updatedAt) < DRAFT_AGENT_WINDOW_MS
}

type ProjectDraftAgentsInput = {
  creator: AgentSummary | undefined
  agents: readonly AgentSummary[]
  sessions: readonly SessionMetadata[]
  resolvedThreadIds: ReadonlySet<string>
  now: number
  /** The generic name of a draft whose Session has no title of its own. */
  name: string
  /** Leads every draft description, with the Session's start time after it. */
  draftLabel: string
  /** Formats the start time for the active locale. */
  locale: string
  /** Session titles by thread id, as the thread list reports them. */
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
 * Presents every unresolved creator interview as its own temporary Agent that
 * owns exactly that one Session, so the workspace never exposes the creator.
 */
export function projectDraftAgents(input: ProjectDraftAgentsInput): {
  agents: AgentSummary[]
  sessions: SessionMetadata[]
} {
  const {
    creator,
    agents,
    sessions,
    resolvedThreadIds,
    now,
    name,
    titles,
    pendingDraftAgentId,
  } = input
  if (!creator) return { agents: [...agents], sessions: [...sessions] }

  const draftAgent = (id: string, createdAt?: string): AgentSummary => {
    const threadId = draftThreadId(id)
    return {
      kind: "ready",
      id,
      name: draftName(threadId && titles.get(threadId), name),
      description: draftDescription(createdAt, input),
      visibility: "visible",
    }
  }
  const drafts: AgentSummary[] = []
  const projected = sessions.map((session) => {
    if (!isEligible(session, creator.id, resolvedThreadIds, now)) return session
    const id = draftAgentId(session.threadId)
    drafts.push(draftAgent(id, session.createdAt))
    return { ...session, agentId: id }
  })
  // The pending interview is a row without a Session, never a Session itself,
  // and never a second row once its Session is listed.
  if (
    pendingDraftAgentId &&
    !drafts.some(({ id }) => id === pendingDraftAgentId)
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

export function readResolvedDrafts(storage: Storage): Set<string> {
  let raw: string | null
  try {
    raw = storage.getItem(RESOLVED_DRAFTS_KEY)
  } catch {
    return new Set()
  }
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

export function writeResolvedDrafts(
  storage: Storage,
  ids: ReadonlySet<string>
): void {
  try {
    storage.setItem(RESOLVED_DRAFTS_KEY, JSON.stringify([...ids]))
  } catch {
    // A full or blocked store only costs draft cleanup after a reload.
  }
}
