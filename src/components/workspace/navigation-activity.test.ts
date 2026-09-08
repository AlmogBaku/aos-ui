import { describe, expect, it } from "vitest"

import type { ActivityItem } from "./use-activity-coordinator"
import {
  getAgentNavigationActivity,
  getOtherVisibleAgentsNavigationActivity,
  getSessionNavigationActivity,
} from "./navigation-activity"

function item(
  overrides: Partial<ActivityItem> &
    Pick<ActivityItem, "id" | "agentId" | "threadId">
): ActivityItem {
  return {
    occurredAt: "2026-09-08T09:00:00.000Z",
    type: "agent-ready",
    read: false,
    resolved: false,
    browserDeliveredAt: null,
    available: true,
    ...overrides,
  } as ActivityItem
}

describe("navigation activity projection", () => {
  const items: ActivityItem[] = [
    item({ id: "a1-unread", agentId: "agent-a", threadId: "session-1" }),
    item({
      id: "a1-attention",
      agentId: "agent-a",
      threadId: "session-1",
      type: "attention-requested",
      attentionKind: "question",
      requestId: "request-1",
      read: true,
    }),
    item({
      id: "a2-resolved",
      agentId: "agent-a",
      threadId: "session-2",
      type: "attention-requested",
      attentionKind: "permission",
      requestId: "request-2",
      resolved: true,
    }),
    item({ id: "b1-unread", agentId: "agent-b", threadId: "session-3" }),
    item({
      id: "c1-read",
      agentId: "agent-c",
      threadId: "session-4",
      read: true,
    }),
    item({
      id: "hidden-unread",
      agentId: "agent-hidden",
      threadId: "session-5",
    }),
    item({
      id: "unavailable",
      agentId: "agent-b",
      threadId: "session-3",
      available: false,
      type: "attention-requested",
      attentionKind: "question",
      requestId: "request-3",
    }),
  ]

  it("summarizes only the exact available Session", () => {
    expect(getSessionNavigationActivity(items, "agent-a", "session-1")).toEqual(
      { unreadCount: 1, needsAttention: true }
    )
    expect(getSessionNavigationActivity(items, "agent-a", "session-2")).toEqual(
      { unreadCount: 1, needsAttention: false }
    )
  })

  it("aggregates all available Sessions owned by an Agent", () => {
    expect(getAgentNavigationActivity(items, "agent-a")).toEqual({
      unreadCount: 2,
      needsAttention: true,
    })
  })

  it("aggregates only other visible roster Agents", () => {
    expect(
      getOtherVisibleAgentsNavigationActivity(
        items,
        "agent-a",
        new Set(["agent-a", "agent-b", "agent-c"])
      )
    ).toEqual({ unreadCount: 1, needsAttention: false })
  })
})
