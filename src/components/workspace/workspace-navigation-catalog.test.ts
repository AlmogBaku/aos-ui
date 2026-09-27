import { describe, expect, it } from "vitest"

import type { SessionMetadata } from "@/runtime-adapters/contracts"
import { buildWorkspaceNavigationCatalog } from "./workspace-navigation-catalog"

const sessions: SessionMetadata[] = [
  {
    sessionId: "a-current",
    agentId: "agent-a",
    updatedAt: "2026-09-08T09:00:00.000Z",
    status: "idle",
  },
  {
    sessionId: "a-old",
    agentId: "agent-a",
    updatedAt: "2026-09-01T09:00:00.000Z",
    status: "idle",
  },
  {
    sessionId: "b-running",
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
      openSessions: [{ sessionId: "a-current", title: "Current" }],
      historySessions: [{ sessionId: "a-old", title: "History" }],
    })
    expect(catalog.get("agent-b")?.openSessions).toEqual([
      expect.objectContaining({ sessionId: "b-running" }),
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

    expect(
      catalog.get("agent-a")?.openSessions.map((item) => item.sessionId)
    ).toEqual(["a-current"])
    expect(
      catalog.get("agent-a")?.historySessions.map((item) => item.sessionId)
    ).toEqual(["a-old"])
  })

  const pinNow = new Date("2026-09-08T10:00:00.000Z")
  const pinned: SessionMetadata[] = [
    {
      sessionId: "open-new",
      agentId: "agent-p",
      updatedAt: "2026-09-08T09:30:00.000Z",
      status: "idle",
    },
    {
      sessionId: "open-pinned",
      agentId: "agent-p",
      updatedAt: "2026-09-08T09:00:00.000Z",
      status: "idle",
      pinned: true,
    },
    {
      sessionId: "open-old",
      agentId: "agent-p",
      updatedAt: "2026-09-08T08:30:00.000Z",
      status: "idle",
    },
    {
      sessionId: "open-pinned-old",
      agentId: "agent-p",
      updatedAt: "2026-09-08T08:00:00.000Z",
      status: "idle",
      pinned: true,
    },
    {
      sessionId: "history-new",
      agentId: "agent-p",
      updatedAt: "2026-09-01T09:30:00.000Z",
      status: "idle",
    },
    {
      sessionId: "history-pinned",
      agentId: "agent-p",
      updatedAt: "2026-09-01T09:00:00.000Z",
      status: "idle",
      pinned: true,
    },
    {
      sessionId: "history-old",
      agentId: "agent-p",
      updatedAt: "2026-09-01T08:30:00.000Z",
      status: "idle",
    },
    {
      sessionId: "archived-pinned",
      agentId: "agent-p",
      updatedAt: "2026-09-08T09:15:00.000Z",
      status: "idle",
      archived: true,
      pinned: true,
    },
  ]

  it("leads Open sessions with every pinned Session and lists none in History", () => {
    const navigation = buildWorkspaceNavigationCatalog({
      agentIds: ["agent-p"],
      sessions: pinned,
      manuallyOpened: {},
      dismissedTabs: {},
      lastSelected: new Map(),
      titles: new Map(),
      now: pinNow,
      untitledLabel: "New Session",
      visibleThreadId: null,
    }).get("agent-p")

    // A pin outranks age, so even a week-old pinned Session is open.
    expect(navigation?.openSessions.map((item) => item.sessionId)).toEqual([
      "open-pinned",
      "open-pinned-old",
      "history-pinned",
      "open-new",
      "open-old",
    ])
    expect(navigation?.historySessions.map((item) => item.sessionId)).toEqual([
      "history-new",
      "history-old",
    ])
  })

  it("keeps a closed pinned tab listed under Open sessions", () => {
    const navigation = buildWorkspaceNavigationCatalog({
      agentIds: ["agent-p"],
      sessions: pinned,
      manuallyOpened: {},
      dismissedTabs: { "agent-p": ["open-pinned", "open-new"] },
      lastSelected: new Map(),
      titles: new Map(),
      now: pinNow,
      untitledLabel: "New Session",
      visibleThreadId: null,
    }).get("agent-p")

    expect(navigation?.openSessions.map((item) => item.sessionId)).toEqual([
      "open-pinned",
      "open-pinned-old",
      "history-pinned",
      "open-old",
    ])
    // Dismissing an ordinary tab sends its Session to History; a pinned one has
    // nowhere else to be listed.
    expect(navigation?.historySessions.map((item) => item.sessionId)).toEqual([
      "open-new",
      "history-new",
      "history-old",
    ])
  })

  it("lists archived Sessions on their own and never offers to close them", () => {
    const navigation = buildWorkspaceNavigationCatalog({
      agentIds: ["agent-p"],
      sessions: pinned,
      manuallyOpened: { "agent-p": ["archived-pinned"] },
      dismissedTabs: {},
      lastSelected: new Map(),
      titles: new Map([["archived-pinned", "Campaign retrospective"]]),
      now: pinNow,
      untitledLabel: "New Session",
      visibleThreadId: null,
    }).get("agent-p")

    expect(
      navigation?.archivedSessions.map(({ sessionId, title }) => ({
        sessionId,
        title,
      }))
    ).toEqual([
      { sessionId: "archived-pinned", title: "Campaign retrospective" },
    ])
    expect(
      navigation?.archivedSessions.every((item) => item.canClose === undefined)
    ).toBe(true)
    expect(
      navigation?.openSessions.some(
        (item) => item.sessionId === "archived-pinned"
      )
    ).toBe(false)
    expect(
      navigation?.historySessions.some(
        (item) => item.sessionId === "archived-pinned"
      )
    ).toBe(false)
  })
})
