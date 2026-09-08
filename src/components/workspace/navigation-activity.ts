import { needsAttention } from "@/lib/notifications/activity"

import type { ActivityItem } from "./use-activity-coordinator"

export type NavigationActivitySummary = {
  unreadCount: number
  needsAttention: boolean
}

type ActivityPredicate = (item: ActivityItem) => boolean

function summarizeNavigationActivity(
  items: readonly ActivityItem[],
  includes: ActivityPredicate
): NavigationActivitySummary {
  let unreadCount = 0
  let hasAttention = false

  for (const item of items) {
    if (!item.available || !includes(item)) continue
    if (!item.read) unreadCount += 1
    if (needsAttention(item)) hasAttention = true
  }

  return { unreadCount, needsAttention: hasAttention }
}

export function getSessionNavigationActivity(
  items: readonly ActivityItem[],
  agentId: string,
  threadId: string
): NavigationActivitySummary {
  return summarizeNavigationActivity(
    items,
    (item) => item.agentId === agentId && item.threadId === threadId
  )
}

export function getAgentNavigationActivity(
  items: readonly ActivityItem[],
  agentId: string
): NavigationActivitySummary {
  return summarizeNavigationActivity(items, (item) => item.agentId === agentId)
}

export function getOtherVisibleAgentsNavigationActivity(
  items: readonly ActivityItem[],
  currentAgentId: string | null,
  visibleAgentIds: Iterable<string>
): NavigationActivitySummary {
  const visible = new Set(visibleAgentIds)
  return summarizeNavigationActivity(
    items,
    (item) => item.agentId !== currentAgentId && visible.has(item.agentId)
  )
}
