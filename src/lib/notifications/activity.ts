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
const run = z.object({
  ...base,
  type: z.enum(["run-finished", "run-failed"]),
  lifecycleId: opaqueId,
})
const start = run.extend({ type: z.literal("run-started") })
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
  run,
  attention,
  resolution,
  activation,
])

export type VisibleActivityEvent = Exclude<
  WorkspaceActivityEvent,
  { type: "run-started" | "attention-resolved" }
>
export type ActivityRecord = VisibleActivityEvent & {
  read: boolean
  resolved: boolean
  browserDeliveredAt: string | null
}

const state = {
  read: z.boolean(),
  resolved: z.boolean(),
  browserDeliveredAt: activityTimestamp.nullable(),
}
const recordVariants = [
  run.extend({ ...state, type: z.enum(["run-finished", "run-failed"]) }),
  attention.extend(state),
  activation.extend(state),
] as const

export const activityRecordSchema = z.discriminatedUnion("type", recordVariants)
export const storedActivityRecordSchema = z.discriminatedUnion("type", [
  recordVariants[0].strict(),
  recordVariants[1].strict(),
  recordVariants[2].strict(),
])

export const ACTIVITY_LIMIT = 200
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function needsAttention(record: ActivityRecord) {
  return record.type === "attention-requested" && !record.resolved
}

export function sortActivity(records: ActivityRecord[]) {
  return records.sort(
    (a, b) =>
      Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export function retainActivity(records: ActivityRecord[], now: number) {
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
