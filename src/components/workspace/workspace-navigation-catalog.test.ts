import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "@/runtime-adapters/contracts"
import { buildWorkspaceNavigationCatalog } from "./workspace-navigation-catalog"

const sessions: SessionMetadata[] = [
  {
    threadId: "a-current",
    agentId: "agent-a",
    updatedAt: "2026-09-08T09:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "a-old",
    agentId: "agent-a",
    updatedAt: "2026-09-01T09:00:00.000Z",
    status: "idle",
  },
  {
    threadId: "b-running",
    agentId: "agent-b",
    updatedAt: "2026-08-01T09:00:00.000Z",
    status: "running",
  },
]

describe("buildWorkspaceNavigationCatalog", () => {
  it("builds open and history sections for every Agent without duplicates", () => {
    const catalog = buildWorkspaceNavigationCatalog({
      agentIds: ["agent-a", "agent-b"],
      sessions,
      manuallyOpened: { "agent-a": ["a-current"] },
      dismissedTabs: {},
      lastSelected: new Map([
        ["agent-a", "a-current"],
        ["agent-b", "b-running"],
      ]),
      titles: new Map([
        ["a-current", "Current"],
        ["a-old", "History"],
        ["b-running", "Background run"],
      ]),
      now: new Date("2026-09-08T10:00:00.000Z"),
      untitledLabel: "New Session",
      visibleThreadId: "a-current",
    })

    expect(catalog.get("agent-a")).toMatchObject({
      agentId: "agent-a",
      lastSelectedThreadId: "a-current",
      openSessions: [{ threadId: "a-current", title: "Current" }],
      historySessions: [{ threadId: "a-old", title: "History" }],
    })
    expect(catalog.get("agent-b")?.openSessions).toEqual([
      expect.objectContaining({ threadId: "b-running" }),
    ])
  })

  it("keeps the visible Session open and moves dismissed Sessions to history", () => {
    const catalog = buildWorkspaceNavigationCatalog({
      agentIds: ["agent-a"],
      sessions,
      manuallyOpened: {},
      dismissedTabs: { "agent-a": ["a-current"] },
      lastSelected: new Map(),
      titles: new Map(),
      now: new Date("2026-10-08T10:00:00.000Z"),
      untitledLabel: "New Session",
      visibleThreadId: "a-current",
    })

    expect(catalog.get("agent-a")?.openSessions.map((item) => item.threadId)).toEqual([
      "a-current",
    ])
    expect(catalog.get("agent-a")?.historySessions.map((item) => item.threadId)).toEqual([
      "a-old",
    ])
  })
})
