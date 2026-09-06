import { z } from "zod"

import {
  ACTIVITY_LIMIT,
  activityRecordSchema,
  storedActivityRecordSchema,
} from "./activity"

const preferencesSchema = z.object({
  enabled: z.boolean(),
  completion: z.boolean(),
  failure: z.boolean(),
  input: z.boolean(),
})
const snapshotSchema = z.object({
  version: z.literal(1),
  records: z.array(activityRecordSchema).max(ACTIVITY_LIMIT),
  preferences: preferencesSchema,
})
const storedSnapshotSchema = snapshotSchema
  .extend({
    records: z.array(storedActivityRecordSchema).max(ACTIVITY_LIMIT),
    preferences: preferencesSchema.strict(),
  })
  .strict()
  .refine((snapshot) => {
    const ids = new Set<string>()
    const owners = new Map<string, string>()
    for (const record of snapshot.records) {
      if (
        ids.has(record.id) ||
        (owners.has(record.threadId) &&
          owners.get(record.threadId) !== record.agentId)
      )
        return false
      ids.add(record.id)
      owners.set(record.threadId, record.agentId)
    }
    return true
  })

export type ActivitySnapshot = z.infer<typeof storedSnapshotSchema>

/** Unknown extra payload fields are never carried into persisted JSON. */
export function serializeActivity(snapshot: unknown): string {
  const projected = snapshotSchema.parse(snapshot)
  return JSON.stringify(storedSnapshotSchema.parse(projected))
}

export function deserializeActivity(
  serialized: string
): ActivitySnapshot | null {
  try {
    const parsed = storedSnapshotSchema.safeParse(JSON.parse(serialized))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
