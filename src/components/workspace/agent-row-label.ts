import { attentionLabels, type AttentionLevel } from "@/lib/attention-level"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { isDraftAgentId } from "@/runtime-adapters/draft-agents"

export type AgentRowCopy = {
  draft: string
  selected: string
  running: string
  unknown: string
  muted: string
  unreadCount: string
  waitingCount: string
  failedCount: string
}

export function agentRowCopy(dictionary: Dictionary): AgentRowCopy {
  return {
    draft: dictionary.creator.draftLabel,
    selected: dictionary.accessibility.selectedAgent,
    running: dictionary.status.running,
    unknown: dictionary.status.unknown,
    muted: dictionary.status.muted,
    unreadCount: dictionary.activity.unreadCount,
    waitingCount: dictionary.activity.waitingCount,
    failedCount: dictionary.activity.failedCount,
  }
}

/**
 * Every Agent row's accessible name, in the rail and on the phone alike, e.g.
 * "Travel Planner, Trip planning, 2 unread, 1 waiting for you". The tile
 * badge shows only the count and its most urgent color; this states it all.
 */
export function agentRowLabel(
  agent: {
    id: string
    name: string
    description?: string
    status?: string
    muted?: true
    attention?: AttentionLevel
  },
  selected: boolean,
  copy: AgentRowCopy
) {
  const level = agent.attention
  return [
    agent.name,
    // A draft's description is its start time; the name says what it is.
    isDraftAgentId(agent.id) ? copy.draft : agent.description,
    ...(level?.count
      ? attentionLabels(level, copy)
      : level?.top === "running"
        ? [copy.running]
        : []),
    agent.muted ? copy.muted : null,
    // A catalog that could not be read is said so; no badge shows it.
    agent.status === "unknown" ? copy.unknown : null,
    selected ? copy.selected : null,
  ]
    .filter(Boolean)
    .join(", ")
}
