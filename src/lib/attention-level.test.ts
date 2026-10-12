import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "@/runtime-adapters/contracts"

import { attentionLevel, railSessions } from "./attention-level"

const session = (
  sessionId: string,
  agentId: string,
  status: SessionMetadata["status"],
  unread = false
): SessionMetadata => ({
  sessionId,
  agentId,
  status,
  unread,
  updatedAt: "2026-09-05T12:00:00.000Z",
})

describe("attentionLevel", () => {
  it.each([
    [
      "waiting outranks failed and unread",
      [
        session("w", "a", "waiting-for-input"),
        session("f", "a", "failed", true),
        session("u", "a", "idle", true),
      ],
      { count: 3, waiting: 1, failed: 1, top: "waiting" },
    ],
    [
      "failed outranks unread",
      [session("f", "a", "failed", true), session("u", "a", "idle", true)],
      { count: 2, waiting: 0, failed: 1, top: "failed" },
    ],
    [
      "a waiting Session that is unread too counts once",
      [session("w", "a", "waiting-for-input", true)],
      { count: 1, waiting: 1, failed: 0, top: "waiting" },
    ],
    [
      "a read failure is not counted, so it does not color",
      [session("f", "a", "failed"), session("u", "a", "idle", true)],
      { count: 1, waiting: 0, failed: 0, top: "unread" },
    ],
    [
      "running names a level with nothing counted",
      [session("r", "a", "running"), session("i", "a", "idle")],
      { count: 0, waiting: 0, failed: 0, top: "running" },
    ],
    [
      "running is never counted beside unread",
      [session("r", "a", "running"), session("u", "a", "idle", true)],
      { count: 1, waiting: 0, failed: 0, top: "unread" },
    ],
    [
      "nothing at all",
      [session("i", "a", "idle")],
      {
        count: 0,
        waiting: 0,
        failed: 0,
        top: null,
      },
    ],
    [
      "an Agent's own activity names a level no Session runs in",
      [session("i", "a", "idle")],
      { count: 0, waiting: 0, failed: 0, top: "running" },
      true,
    ],
    [
      "and never outranks a count",
      [session("u", "a", "idle", true)],
      { count: 1, waiting: 0, failed: 0, top: "unread" },
      true,
    ],
  ])("%s", (_rule, sessions, expected, running?: boolean) => {
    expect(attentionLevel(sessions, running)).toEqual(expected)
  })
})

describe("the counted set", () => {
  const agents = [
    { id: "a" },
    { id: "b" },
    { id: "hidden", visibility: "hidden" as const },
    { id: "creator", role: "creator" as const },
  ]
  const sessions = [
    session("a-wait", "a", "waiting-for-input"),
    session("a-unread", "a", "idle", true),
    session("b-failed", "b", "failed", true),
    session("hidden-wait", "hidden", "waiting-for-input", true),
    session("creator-unread", "creator", "idle", true),
  ]

  it("counts no Session of an Agent without a rail row", () => {
    expect(
      railSessions(agents, sessions).map(({ sessionId }) => sessionId)
    ).toEqual(["a-wait", "a-unread", "b-failed"])
  })

  it("sums the rail's tiles exactly to the bell", () => {
    const bell = attentionLevel(railSessions(agents, sessions))
    const tiles = ["a", "b"].map((agentId) =>
      attentionLevel(sessions.filter((item) => item.agentId === agentId))
    )
    expect(bell).toEqual({ count: 3, waiting: 1, failed: 1, top: "waiting" })
    expect(tiles.reduce((total, tile) => total + tile.count, 0)).toBe(
      bell.count
    )
  })
})
