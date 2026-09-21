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

    expect(
      catalog.get("agent-a")?.openSessions.map((item) => item.threadId)
    ).toEqual(["a-current"])
    expect(
      catalog.get("agent-a")?.historySessions.map((item) => item.threadId)
    ).toEqual(["a-old"])
  })

  const pinNow = new Date("2026-09-08T10:00:00.000Z")
  const pinned: SessionMetadata[] = [
    {
      threadId: "open-new",
      agentId: "agent-p",
      updatedAt: "2026-09-08T09:30:00.000Z",
      status: "idle",
    },
    {
      threadId: "open-pinned",
      agentId: "agent-p",
      updatedAt: "2026-09-08T09:00:00.000Z",
      status: "idle",
      pinned: true,
    },
    {
      threadId: "open-old",
      agentId: "agent-p",
      updatedAt: "2026-09-08T08:30:00.000Z",
      status: "idle",
    },
    {
      threadId: "open-pinned-old",
      agentId: "agent-p",
      updatedAt: "2026-09-08T08:00:00.000Z",
      status: "idle",
      pinned: true,
    },
    {
      threadId: "history-new",
      agentId: "agent-p",
      updatedAt: "2026-09-01T09:30:00.000Z",
      status: "idle",
    },
    {
      threadId: "history-pinned",
      agentId: "agent-p",
      updatedAt: "2026-09-01T09:00:00.000Z",
      status: "idle",
      pinned: true,
    },
    {
      threadId: "history-old",
      agentId: "agent-p",
      updatedAt: "2026-09-01T08:30:00.000Z",
      status: "idle",
    },
    {
      threadId: "archived-pinned",
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
    expect(navigation?.openSessions.map((item) => item.threadId)).toEqual([
      "open-pinned",
      "open-pinned-old",
      "history-pinned",
      "open-new",
      "open-old",
    ])
    expect(navigation?.historySessions.map((item) => item.threadId)).toEqual([
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

    expect(navigation?.openSessions.map((item) => item.threadId)).toEqual([
      "open-pinned",
      "open-pinned-old",
      "history-pinned",
      "open-old",
    ])
    // Dismissing an ordinary tab sends its Session to History; a pinned one has
    // nowhere else to be listed.
    expect(navigation?.historySessions.map((item) => item.threadId)).toEqual([
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
      navigation?.archivedSessions.map(({ threadId, title }) => ({
        threadId,
        title,
      }))
    ).toEqual([
      { threadId: "archived-pinned", title: "Campaign retrospective" },
    ])
    expect(
      navigation?.archivedSessions.every((item) => item.canClose === undefined)
    ).toBe(true)
    expect(
      navigation?.openSessions.some(
        (item) => item.threadId === "archived-pinned"
      )
    ).toBe(false)
    expect(
      navigation?.historySessions.some(
        (item) => item.threadId === "archived-pinned"
      )
    ).toBe(false)
  })
})
