import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "@/runtime-adapters/contracts"
import {
  buildAgentSessionView,
  agentStatusFromSessions,
  agentUnreadFromSessions,
  workspaceUnreadCount,
} from "./workspace-view-model"

it("does not call an Agent idle when owned execution status is unknown", () => {
  expect(
    agentStatusFromSessions({ kind: "ready", id: "a", name: "A" }, [
      {
        agentId: "a",
        threadId: "t",
        updatedAt: "2026-09-07T00:00:00.000Z",
        status: "unknown",
      },
    ])
  ).toBe("unknown")
})

it("aggregates provider unread state per owning Agent only", () => {
  const agent = { kind: "ready", id: "a", name: "A" } as const
  const owned = {
    agentId: "a",
    threadId: "t",
    updatedAt: "2026-09-07T00:00:00.000Z",
    status: "idle",
  } as const
  expect(agentUnreadFromSessions(agent, [owned])).toBe(false)
  expect(agentUnreadFromSessions(agent, [{ ...owned, unread: true }])).toBe(
    true
  )
  expect(
    agentUnreadFromSessions(agent, [
      { ...owned, agentId: "other", unread: true },
    ])
  ).toBe(false)
  // Waiting for input is a status a row shows on its own, not unread state.
  expect(
    agentUnreadFromSessions(agent, [{ ...owned, status: "waiting-for-input" }])
  ).toBe(false)
})

it("counts unread and awaiting Sessions once each for the Activity bell", () => {
  const base = {
    agentId: "a",
    updatedAt: "2026-09-07T00:00:00.000Z",
    status: "idle",
  } as const
  expect(
    workspaceUnreadCount([
      { ...base, threadId: "read" },
      { ...base, threadId: "unread", unread: true },
      { ...base, threadId: "waiting", status: "waiting-for-input" },
      {
        ...base,
        threadId: "both",
        status: "waiting-for-input",
        unread: true,
      },
    ])
  ).toBe(3)
})

const now = new Date("2026-09-03T12:00:00.000Z")

it("keeps native activity separate from execution and preserves attention priority", () => {
  const agent = { kind: "ready", id: "a", name: "A", activity: "idle" } as const
  const session = { agentId: "a", threadId: "t", updatedAt: now.toISOString() }
  expect(
    agentStatusFromSessions(agent, [{ ...session, status: "running" }])
  ).toBe("active")
  expect(
    agentStatusFromSessions(agent, [
      { ...session, status: "waiting-for-input" },
    ])
  ).toBe("attention")
  expect(
    agentStatusFromSessions(agent, [
      { ...session, agentId: "other", status: "running" },
    ])
  ).toBe("idle")
  expect(agentStatusFromSessions({ ...agent, activity: "unknown" }, [])).toBe(
    "unknown"
  )
})

const sessions: SessionMetadata[] = [
  {
    threadId: "recent",
    agentId: "aster",
    updatedAt: "2026-09-03T11:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "boundary",
    agentId: "aster",
    updatedAt: "2026-09-03T00:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "other-agent",
    agentId: "mica",
    updatedAt: "2026-09-03T11:30:00.000Z",
    status: "running",
  },
]

describe("buildAgentSessionView", () => {
  it("keeps automatic tabs and manually opened history separate", () => {
    const result = buildAgentSessionView({
      agentId: "aster",
      sessions,
      manuallyOpenedThreadIds: new Set(["boundary"]),
      titles: new Map([
        ["recent", "Market brief"],
        ["boundary", "Pricing analysis"],
      ]),
      now,
    })

    expect(result.openSessions.map(({ threadId }) => threadId)).toEqual([
      "recent",
      "boundary",
    ])
    expect(result.allSessions.map(({ threadId }) => threadId)).toEqual([
      "recent",
      "boundary",
    ])
  })

  it("opens pinned Sessions whatever their age and keeps them out of history", () => {
    const pinned: SessionMetadata[] = [
      ...sessions,
      {
        threadId: "pinned-stale",
        agentId: "aster",
        updatedAt: "2026-08-20T09:00:00.000Z",
        status: "idle",
        pinned: true,
      },
      {
        threadId: "pinned-staler",
        agentId: "aster",
        updatedAt: "2026-08-10T09:00:00.000Z",
        status: "idle",
        pinned: true,
      },
    ]

    const result = buildAgentSessionView({
      agentId: "aster",
      sessions: pinned,
      manuallyOpenedThreadIds: new Set(["boundary"]),
      titles: new Map(),
      now,
    })

    // Pinned rows lead; recency still orders within either group.
    expect(result.openSessions.map(({ threadId }) => threadId)).toEqual([
      "pinned-stale",
      "pinned-staler",
      "recent",
      "boundary",
    ])
    expect(result.allSessions.map(({ threadId }) => threadId)).toEqual([
      "recent",
      "boundary",
    ])
  })

  it("uses a readable fallback without changing provider metadata", () => {
    const result = buildAgentSessionView({
      agentId: "aster",
      sessions: [sessions[0]!],
      manuallyOpenedThreadIds: new Set(),
      titles: new Map(),
      now,
      untitledLabel: "New session",
    })

    expect(result.openSessions[0]?.title).toBe("New session")
    expect(sessions[0]).not.toHaveProperty("title")
  })

  const archived: SessionMetadata[] = [
    ...sessions,
    {
      threadId: "archived-new",
      agentId: "aster",
      updatedAt: "2026-09-03T11:45:00.000Z",
      status: "idle",
      archived: true,
    },
    {
      threadId: "archived-old",
      agentId: "aster",
      updatedAt: "2026-09-01T09:00:00.000Z",
      status: "idle",
      archived: true,
    },
  ]

  it("moves archived Sessions out of the open and history lists", () => {
    const result = buildAgentSessionView({
      agentId: "aster",
      sessions: archived,
      manuallyOpenedThreadIds: new Set(["archived-old"]),
      titles: new Map([["archived-new", "Campaign retrospective"]]),
      now,
    })

    expect(result.openSessions.map(({ threadId }) => threadId)).toEqual([
      "recent",
    ])
    expect(result.allSessions.map(({ threadId }) => threadId)).toEqual([
      "recent",
      "boundary",
    ])
    expect(result.archivedSessions.map(({ threadId }) => threadId)).toEqual([
      "archived-new",
      "archived-old",
    ])
    expect(result.archivedSessions[0]?.title).toBe("Campaign retrospective")
  })

  it("keeps the archived Session on screen listed until selection moves", () => {
    const result = buildAgentSessionView({
      agentId: "aster",
      sessions: archived,
      manuallyOpenedThreadIds: new Set(),
      titles: new Map(),
      now,
      visibleThreadId: "archived-new",
    })

    expect(result.openSessions.map(({ threadId }) => threadId)).toEqual([
      "archived-new",
      "recent",
    ])
    expect(result.allSessions.map(({ threadId }) => threadId)).toEqual([
      "archived-new",
      "recent",
      "boundary",
    ])
    expect(result.archivedSessions.map(({ threadId }) => threadId)).toEqual([
      "archived-new",
      "archived-old",
    ])
  })
})
