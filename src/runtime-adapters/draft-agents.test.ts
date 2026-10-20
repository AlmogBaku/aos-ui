import { describe, expect, it } from "vitest"

import type { AgentSummary, SessionMetadata } from "./contracts"
import {
  DRAFT_AGENT_WINDOW_MS,
  draftAgentId,
  draftSessionId,
  isDraftAgentId,
  nextDraftExpiry,
  PENDING_DRAFT_AGENT_ID,
  projectDraftAgents,
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
  sessionId: string,
  agentId: string,
  ageMs: number,
  createdAt?: string,
  status: SessionMetadata["status"] = "idle"
): SessionMetadata {
  return {
    sessionId,
    agentId,
    updatedAt: new Date(now - ageMs).toISOString(),
    status,
    ...(createdAt ? { createdAt } : {}),
  }
}

/** An Agent the creator made in `sessionId`, as the catalog lists it. */
const madeIn = (sessionId: string): AgentSummary => ({
  kind: "ready",
  id: "sora",
  name: "Sora",
  creatorSessionId: sessionId,
})

const copy = { name: "New Agent", draftLabel: "Draft", locale: "en" }

describe("draft Agent identifiers", () => {
  it("round-trips a Session id and rejects ordinary Agent ids", () => {
    expect(draftSessionId(draftAgentId("thread-1"))).toBe("thread-1")
    expect(isDraftAgentId(draftAgentId("thread-1"))).toBe(true)
    expect(draftSessionId("aster")).toBeUndefined()
    expect(isDraftAgentId("aster")).toBe(false)
  })

  it("names the pending draft without naming any thread", () => {
    expect(isDraftAgentId(PENDING_DRAFT_AGENT_ID)).toBe(true)
    expect(draftSessionId(PENDING_DRAFT_AGENT_ID)).toBeUndefined()
  })
})

describe("projectDraftAgents", () => {
  const project = (
    sessions: SessionMetadata[],
    made: readonly AgentSummary[] = [],
    creatorAgent: AgentSummary | undefined = creator,
    pendingDraftAgentId: string | undefined = undefined,
    titles: ReadonlyMap<string, string> = new Map()
  ) =>
    projectDraftAgents({
      creator: creatorAgent,
      agents: [...roster, ...(creatorAgent ? [creatorAgent] : []), ...made],
      sessions,
      now,
      ...copy,
      titles,
      pendingDraftAgentId,
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
      projected.sessions.map(({ sessionId, agentId }) => ({
        sessionId,
        agentId,
      }))
    ).toEqual([
      { sessionId: "fresh", agentId: draftAgentId("fresh") },
      { sessionId: "expired", agentId: creator.id },
    ])
  })

  it("describes a draft as a visible Agent under the supplied name", () => {
    const projected = project([session("fresh", creator.id, 0)])

    expect(projected.agents.at(-1)).toEqual({
      kind: "ready",
      id: draftAgentId("fresh"),
      name: "New Agent",
      description: "Draft",
      visibility: "visible",
    })
  })

  it("a draft is named by its Session title unless generic, with its start time", () => {
    const startedAt = "2026-09-20T09:30:00.000Z"
    const projected = project(
      [
        session("titled", creator.id, 0, startedAt),
        session("english", creator.id, 0, startedAt),
        session("hebrew", creator.id, 0, startedAt),
        session("blank", creator.id, 0),
      ],
      [],
      creator,
      undefined,
      new Map([
        ["titled", "Travel planner"],
        ["english", "New Agent"],
        ["hebrew", "סוכן חדש"],
        ["blank", "  "],
      ])
    )
    const started = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(startedAt))

    expect(
      projected.agents
        .slice(-4)
        .map(({ name, description }) => ({ name, description }))
    ).toEqual([
      { name: "Travel planner", description: `Draft · ${started}` },
      { name: "New Agent", description: `Draft · ${started}` },
      { name: "New Agent", description: `Draft · ${started}` },
      { name: "New Agent", description: "Draft" },
    ])
  })

  it.each([
    { status: "idle", kept: false },
    { status: "failed", kept: false },
    { status: "running", kept: true },
    { status: "waiting-for-input", kept: true },
  ] as const)(
    "retires an $status interview whose Agent is listed only once nothing in it is open, and leaves other Sessions untouched",
    ({ status, kept }) => {
      const sessions = [
        session("made", creator.id, 0, undefined, status),
        session("unmade", creator.id, 0),
        session("work", "aster", 0),
      ]

      const projected = project(sessions, [madeIn("made")])

      expect(projected.agents.map(({ id }) => id)).toEqual([
        "aster",
        "bram",
        creator.id,
        "sora",
        ...(kept ? [draftAgentId("made")] : []),
        draftAgentId("unmade"),
      ])
      expect(projected.sessions[0]?.agentId).toBe(
        kept ? draftAgentId("made") : creator.id
      )
      expect(projected.sessions[2]).toEqual(sessions[2])
    }
  )

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

    const projected = project(sessions, [], creator, PENDING_DRAFT_AGENT_ID)

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
      description: "Draft",
    })
    // The pending draft precedes its Session, so it invents none.
    expect(projected.sessions.map(({ sessionId }) => sessionId)).toEqual([
      "work",
      "interview",
    ])
  })

  it.each([
    { case: "its one row", made: [], drafts: [draftAgentId("interview")] },
    {
      case: "no row once it made its Agent",
      made: [madeIn("interview")],
      drafts: [],
    },
  ])(
    "gives a pending interview that names its own listed Session $case",
    ({ made, drafts }) => {
      const sessions = [session("interview", creator.id, 0)]

      const projected = project(
        sessions,
        made,
        creator,
        draftAgentId("interview")
      )

      expect(
        projected.agents
          .filter(({ id }) => isDraftAgentId(id))
          .map(({ id }) => id)
      ).toEqual(drafts)
    }
  )

  it("carries a promoted interview that metadata has not listed yet", () => {
    const projected = project([], [], creator, draftAgentId("interview"))

    expect(projected.agents.map(({ id }) => id)).toEqual([
      "aster",
      "bram",
      creator.id,
      draftAgentId("interview"),
    ])
    expect(projected.sessions).toEqual([])
  })

  it.each([
    ["", undefined],
    [", omitting the pending draft", PENDING_DRAFT_AGENT_ID],
  ])(
    "passes the catalog through unchanged without a creator%s",
    (_, pendingDraftAgentId) => {
      const sessions = [session("orphan", "aos-creator", 0)]

      const projected = projectDraftAgents({
        creator: undefined,
        agents: roster,
        sessions,
        now,
        ...copy,
        titles: new Map(),
        pendingDraftAgentId,
      })

      expect(projected.agents).toEqual(roster)
      expect(projected.sessions).toEqual(sessions)
    }
  )
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
