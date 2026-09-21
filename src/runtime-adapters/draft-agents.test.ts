import { describe, expect, it } from "vitest"

import type { AgentSummary, SessionMetadata } from "./contracts"
import {
  DRAFT_AGENT_WINDOW_MS,
  draftAgentId,
  draftThreadId,
  isDraftAgentId,
  nextDraftExpiry,
  PENDING_DRAFT_AGENT_ID,
  projectDraftAgents,
  readResolvedDrafts,
  writeResolvedDrafts,
} from "./draft-agents"

const now = Date.parse("2026-09-20T12:00:00.000Z")

const creator: AgentSummary = {
  kind: "ready",
  id: "aos-creator",
  name: "Agent Creator",
  role: "creator",
}

const roster: AgentSummary[] = [
  { kind: "ready", id: "aster", name: "Aster" },
  { kind: "ready", id: "bram", name: "Bram" },
]

function session(
  threadId: string,
  agentId: string,
  ageMs: number
): SessionMetadata {
  return {
    threadId,
    agentId,
    updatedAt: new Date(now - ageMs).toISOString(),
    status: "idle",
  }
}

describe("draft Agent identifiers", () => {
  it("round-trips a thread id and rejects ordinary Agent ids", () => {
    expect(draftThreadId(draftAgentId("thread-1"))).toBe("thread-1")
    expect(isDraftAgentId(draftAgentId("thread-1"))).toBe(true)
    expect(draftThreadId("aster")).toBeUndefined()
    expect(isDraftAgentId("aster")).toBe(false)
  })

  it("names the pending draft without naming any thread", () => {
    expect(isDraftAgentId(PENDING_DRAFT_AGENT_ID)).toBe(true)
    expect(draftThreadId(PENDING_DRAFT_AGENT_ID)).toBeUndefined()
  })
})

describe("projectDraftAgents", () => {
  const project = (
    sessions: SessionMetadata[],
    resolvedThreadIds: ReadonlySet<string> = new Set<string>(),
    creatorAgent: AgentSummary | undefined = creator,
    pendingDraft = false
  ) =>
    projectDraftAgents({
      creator: creatorAgent,
      agents: [...roster, ...(creatorAgent ? [creatorAgent] : [])],
      sessions,
      resolvedThreadIds,
      now,
      name: "New Agent",
      pendingDraft,
    })

  it("keeps a creator Session a draft until it is exactly 48 hours old", () => {
    const sessions = [
      session("fresh", creator.id, DRAFT_AGENT_WINDOW_MS - 1),
      session("expired", creator.id, DRAFT_AGENT_WINDOW_MS),
    ]

    const projected = project(sessions)

    expect(projected.agents.map(({ id }) => id)).toEqual([
      "aster",
      "bram",
      creator.id,
      draftAgentId("fresh"),
    ])
    expect(
      projected.sessions.map(({ threadId, agentId }) => ({
        threadId,
        agentId,
      }))
    ).toEqual([
      { threadId: "fresh", agentId: draftAgentId("fresh") },
      { threadId: "expired", agentId: creator.id },
    ])
  })

  it("describes a draft as a visible Agent under the supplied name", () => {
    const projected = project([session("fresh", creator.id, 0)])

    expect(projected.agents.at(-1)).toEqual({
      kind: "ready",
      id: draftAgentId("fresh"),
      name: "New Agent",
      icon: { kind: "symbol", symbol: "unassigned", tone: "slate" },
      visibility: "visible",
    })
  })

  it("excludes resolved interviews and leaves other Sessions untouched", () => {
    const sessions = [
      session("resolved", creator.id, 0),
      session("unresolved", creator.id, 0),
      session("work", "aster", 0),
    ]

    const projected = project(sessions, new Set(["resolved"]))

    expect(projected.agents.map(({ id }) => id)).toEqual([
      "aster",
      "bram",
      creator.id,
      draftAgentId("unresolved"),
    ])
    expect(projected.sessions[0]).toEqual(sessions[0])
    expect(projected.sessions[2]).toEqual(sessions[2])
  })

  it("appends drafts after the provider roster in Session order", () => {
    const projected = project([
      session("second", creator.id, 1_000),
      session("work", "aster", 0),
      session("first", creator.id, 0),
    ])

    expect(projected.agents.map(({ id }) => id)).toEqual([
      "aster",
      "bram",
      creator.id,
      draftAgentId("second"),
      draftAgentId("first"),
    ])
  })

  it("adds the pending draft after the roster and the listed drafts", () => {
    const sessions = [
      session("work", "aster", 0),
      session("interview", creator.id, 0),
    ]

    const projected = project(sessions, new Set<string>(), creator, true)

    expect(projected.agents.map(({ id }) => id)).toEqual([
      "aster",
      "bram",
      creator.id,
      draftAgentId("interview"),
      PENDING_DRAFT_AGENT_ID,
    ])
    expect(projected.agents.at(-1)).toEqual({
      ...projected.agents.at(-2),
      id: PENDING_DRAFT_AGENT_ID,
    })
    // The pending draft precedes its Session, so it invents none.
    expect(projected.sessions.map(({ threadId }) => threadId)).toEqual([
      "work",
      "interview",
    ])
  })

  it("omits the pending draft when the provider has no creator", () => {
    const projected = projectDraftAgents({
      creator: undefined,
      agents: roster,
      sessions: [],
      resolvedThreadIds: new Set(),
      now,
      name: "New Agent",
      pendingDraft: true,
    })

    expect(projected.agents).toEqual(roster)
    expect(projected.sessions).toEqual([])
  })

  it("passes the catalog through unchanged without a creator", () => {
    const sessions = [session("orphan", "aos-creator", 0)]

    const projected = projectDraftAgents({
      creator: undefined,
      agents: roster,
      sessions,
      resolvedThreadIds: new Set(),
      now,
      name: "New Agent",
    })

    expect(projected.agents).toEqual(roster)
    expect(projected.sessions).toEqual(sessions)
  })
})

describe("nextDraftExpiry", () => {
  it("returns the earliest future draft boundary", () => {
    const sessions = [
      session("older", creator.id, DRAFT_AGENT_WINDOW_MS - 5_000),
      session("newer", creator.id, 1_000),
      session("expired", creator.id, DRAFT_AGENT_WINDOW_MS + 1),
      session("work", "aster", 1),
    ]

    expect(nextDraftExpiry(sessions, creator.id, now)).toBe(now + 5_000)
  })

  it("returns nothing without a creator or without pending drafts", () => {
    expect(
      nextDraftExpiry([session("fresh", creator.id, 0)], undefined, now)
    ).toBeUndefined()
    expect(
      nextDraftExpiry(
        [session("expired", creator.id, DRAFT_AGENT_WINDOW_MS)],
        creator.id,
        now
      )
    ).toBeUndefined()
  })
})

describe("resolved draft storage", () => {
  function memoryStorage(): Storage {
    const entries = new Map<string, string>()
    return {
      get length() {
        return entries.size
      },
      clear: () => entries.clear(),
      getItem: (key) => entries.get(key) ?? null,
      key: (index) => [...entries.keys()][index] ?? null,
      removeItem: (key) => entries.delete(key),
      setItem: (key, value) => void entries.set(key, value),
    }
  }

  it("round-trips thread ids", () => {
    const storage = memoryStorage()

    writeResolvedDrafts(storage, new Set(["one", "two"]))

    expect([...readResolvedDrafts(storage)]).toEqual(["one", "two"])
  })

  it("reads an empty set from missing content", () => {
    expect(readResolvedDrafts(memoryStorage()).size).toBe(0)
  })

  it("survives unusable content and an unavailable store", () => {
    const corrupt: Storage = { ...memoryStorage(), getItem: () => "{oops" }
    expect(readResolvedDrafts(corrupt).size).toBe(0)

    const blocked: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(readResolvedDrafts(blocked).size).toBe(0)
    expect(() => writeResolvedDrafts(blocked, new Set(["one"]))).not.toThrow()
  })
})
