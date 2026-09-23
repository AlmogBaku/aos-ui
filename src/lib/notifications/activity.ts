import { z } from "zod"

import type { WorkspaceActivityEvent } from "@/runtime-adapters/contracts"

const opaqueId = z.string().min(1).max(512)
export const activityTimestamp = z.iso.datetime({ offset: true })
const base = {
  id: opaqueId,
  agentId: opaqueId,
  threadId: opaqueId,
  occurredAt: activityTimestamp,
}
const turn = z.object({
  ...base,
  type: z.enum(["turn-finished", "turn-failed"]),
  turnId: opaqueId,
})
const start = turn.extend({ type: z.literal("turn-started") })
const attention = z.object({
  ...base,
  type: z.literal("attention-requested"),
  attentionKind: z.enum(["question", "permission"]),
  requestId: opaqueId,
})
const resolution = z.object({
  ...base,
  type: z.literal("attention-resolved"),
  requestId: opaqueId,
})
const activation = z.object({
  ...base,
  type: z.enum(["agent-ready", "agent-activation-failed"]),
})

/** External payloads are projected onto this content-free allowlist. */
export const activityEventSchema = z.discriminatedUnion("type", [
  start,
  turn,
  attention,
  resolution,
  activation,
])

export type VisibleActivityEvent = Exclude<
  WorkspaceActivityEvent,
  { type: "turn-started" | "attention-resolved" }
>
/** Stored Activity; the provider owns read state, so entries never carry it. */
export type ActivityEntry = VisibleActivityEvent & {
  resolved: boolean
  browserDeliveredAt: string | null
}

export type ActivityRecord = ActivityEntry & { read: boolean }

export const ACTIVITY_LIMIT = 200
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function needsAttention(record: ActivityEntry) {
  return record.type === "attention-requested" && !record.resolved
}

export function sortActivity<TEntry extends ActivityEntry>(records: TEntry[]) {
  return records.sort(
    (a, b) =>
      Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export function retainActivity<TEntry extends ActivityEntry>(
  records: TEntry[],
  now: number
) {
  const eligible = sortActivity(
    records.filter(
      (record) =>
        needsAttention(record) ||
        Date.parse(record.occurredAt) > now - ACTIVITY_MAX_AGE_MS
    )
  )
  // Protect unresolved attention from ordinary traffic; the hard cap still wins
  // if more than 200 requests themselves remain unresolved.
  const retained = [
    ...eligible.filter(needsAttention),
    ...eligible.filter((record) => !needsAttention(record)),
  ].slice(0, ACTIVITY_LIMIT)
  return sortActivity(retained)
}

export function activityScope(
  event: { agentId: string; threadId: string },
  id: string
) {
  return JSON.stringify([event.agentId, event.threadId, id])
}
