import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "@/runtime-adapters/contracts"
import {
  buildAgentSessionView,
  agentStatusFromSessions,
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

const now = new Date("2026-09-03T12:00:00.000Z")

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
})
