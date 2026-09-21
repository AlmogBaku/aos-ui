import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "./contracts"
import {
  activeSessionsForAgent,
  joinSessionsToAgents,
  nextSessionEligibilityBoundary,
  resolveSessionSelection,
} from "./session-policy"

const now = new Date("2026-09-03T12:00:00.000Z")

function session(
  threadId: string,
  agentId: string,
  updatedAt: string,
  status: SessionMetadata["status"] = "idle"
): SessionMetadata {
  return { threadId, agentId, updatedAt, status }
}

describe("activeSessionsForAgent", () => {
  it("includes sessions younger than 12 hours and excludes the exact boundary", () => {
    const sessions = [
      session("recent", "aster", "2026-09-03T00:00:00.001Z"),
      session("boundary", "aster", "2026-09-03T00:00:00.000Z"),
      session("older", "aster", "2026-09-02T23:59:59.999Z"),
    ]

    expect(activeSessionsForAgent(sessions, "aster", now, new Set())).toEqual([
      sessions[0],
    ])
  })

  it("keeps running, waiting, and manually opened history sessions", () => {
    const sessions = [
      session("idle-old", "aster", "2026-08-01T12:00:00.000Z"),
      session("running-old", "aster", "2026-08-02T12:00:00.000Z", "running"),
      session(
        "waiting-old",
        "aster",
        "2026-08-03T12:00:00.000Z",
        "waiting-for-input"
      ),
    ]

    expect(
      activeSessionsForAgent(sessions, "aster", now, new Set(["idle-old"])).map(
        ({ threadId }) => threadId
      )
    ).toEqual(["waiting-old", "running-old", "idle-old"])
  })

  it("keeps a pinned Session open however old it is", () => {
    const sessions: SessionMetadata[] = [
      {
        ...session("pinned-old", "aster", "2026-08-01T12:00:00.000Z"),
        pinned: true,
      },
      session("idle-old", "aster", "2026-08-02T12:00:00.000Z"),
    ]

    expect(
      activeSessionsForAgent(sessions, "aster", now, new Set()).map(
        ({ threadId }) => threadId
      )
    ).toEqual(["pinned-old"])
  })

  it("filters by authoritative Agent ownership, deduplicates, and orders newest first", () => {
    const sessions = [
      session("same", "aster", "2026-09-03T08:00:00.000Z"),
      session("mica-thread", "mica", "2026-09-03T11:00:00.000Z"),
      session("same", "aster", "2026-09-03T10:00:00.000Z"),
      session("second", "aster", "2026-09-03T09:00:00.000Z"),
    ]

    expect(
      activeSessionsForAgent(sessions, "aster", now, new Set()).map(
        ({ threadId, updatedAt }) => [threadId, updatedAt]
      )
    ).toEqual([
      ["same", "2026-09-03T10:00:00.000Z"],
      ["second", "2026-09-03T09:00:00.000Z"],
    ])
  })
})

describe("nextSessionEligibilityBoundary", () => {
  it("returns the first exact 12-hour boundary for a currently recent idle Session", () => {
    const sessions = [
      session("later", "aster", "2026-09-03T11:00:00.000Z"),
      session("first", "aster", "2026-09-03T00:00:00.001Z"),
      session("running", "aster", "2026-09-02T00:00:00.000Z", "running"),
      session("already-old", "aster", "2026-09-02T23:00:00.000Z"),
    ]

    expect(nextSessionEligibilityBoundary(sessions, now)).toBe(
      Date.parse("2026-09-03T12:00:00.001Z")
    )
  })

  it("ignores live, invalid, future, and already ineligible Sessions", () => {
    expect(
      nextSessionEligibilityBoundary(
        [
          session(
            "waiting",
            "aster",
            "2026-08-01T00:00:00.000Z",
            "waiting-for-input"
          ),
          session("invalid", "aster", "not-a-date"),
          session("future", "aster", "2026-09-03T13:00:00.000Z"),
          session("old", "aster", "2026-08-01T00:00:00.000Z"),
        ],
        now
      )
    ).toBeNull()
  })
})

describe("joinSessionsToAgents", () => {
  it("uses workspace metadata as the ownership authority", () => {
    const result = joinSessionsToAgents(
      [
        { kind: "ready", id: "aster", name: "Aster" },
        { kind: "ready", id: "mica", name: "Mica" },
      ],
      [
        session("one", "aster", "2026-09-03T10:00:00.000Z"),
        session("two", "missing", "2026-09-03T11:00:00.000Z"),
      ]
    )

    expect(result.get("aster")?.map(({ threadId }) => threadId)).toEqual([
      "one",
    ])
    expect(result.get("mica")).toEqual([])
    expect(result.has("missing")).toBe(false)
  })
})

describe("resolveSessionSelection", () => {
  const sessions = [
    session("oldest", "aster", "2026-08-01T00:00:00.000Z"),
    session("newest-history", "aster", "2026-08-20T00:00:00.000Z"),
    session("active", "aster", "2026-09-03T11:00:00.000Z"),
  ]

  it("restores the last selected valid Session for the Agent", () => {
    expect(
      resolveSessionSelection({
        agentId: "aster",
        sessions,
        activeSessions: [sessions[2]],
        lastSelectedThreadId: "oldest",
      })
    ).toBe("oldest")
  })

  it("falls back to newest active, then newest history, then the empty state", () => {
    expect(
      resolveSessionSelection({
        agentId: "aster",
        sessions,
        activeSessions: [sessions[2]],
        lastSelectedThreadId: "deleted",
      })
    ).toBe("active")
    expect(
      resolveSessionSelection({
        agentId: "aster",
        sessions: sessions.slice(0, 2),
        activeSessions: [],
      })
    ).toBe("newest-history")
    expect(
      resolveSessionSelection({
        agentId: "mica",
        sessions,
        activeSessions: [],
      })
    ).toBeNull()
  })
})
