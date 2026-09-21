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
 * therefore names no thread of its own.
 */
export const PENDING_DRAFT_AGENT_ID = `${DRAFT_PREFIX}new`

export const draftThreadId = (agentId: string) =>
  agentId.startsWith(DRAFT_PREFIX) && agentId !== PENDING_DRAFT_AGENT_ID
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
  name: string
  /** True while the operator holds a creator interview that has no Session. */
  pendingDraft?: boolean
}

const draftAgent = (id: string, name: string): AgentSummary => ({
  kind: "ready",
  id,
  name,
  icon: { kind: "symbol", symbol: "unassigned", tone: "slate" },
  visibility: "visible",
})

/**
 * Presents every unresolved creator interview as its own temporary Agent that
 * owns exactly that one Session, so the workspace never exposes the creator.
 */
export function projectDraftAgents({
  creator,
  agents,
  sessions,
  resolvedThreadIds,
  now,
  name,
  pendingDraft = false,
}: ProjectDraftAgentsInput): {
  agents: AgentSummary[]
  sessions: SessionMetadata[]
} {
  if (!creator) return { agents: [...agents], sessions: [...sessions] }

  const drafts: AgentSummary[] = []
  const projected = sessions.map((session) => {
    if (!isEligible(session, creator.id, resolvedThreadIds, now)) return session
    const id = draftAgentId(session.threadId)
    drafts.push(draftAgent(id, name))
    return { ...session, agentId: id }
  })
  // The pending interview is a row without a Session, never a Session itself.
  if (pendingDraft) drafts.push(draftAgent(PENDING_DRAFT_AGENT_ID, name))

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
