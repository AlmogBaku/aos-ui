import { z } from "zod"

const preferencesSchema = z.object({
  enabled: z.boolean(),
  completion: z.boolean(),
  failure: z.boolean(),
  input: z.boolean(),
})
/**
 * Version 2 keeps notification preferences only. Activity history is provider
 * state held in memory, so version 1 snapshots and their records are dropped.
 */
const snapshotSchema = z.object({
  version: z.literal(2),
  preferences: preferencesSchema,
})
const storedSnapshotSchema = snapshotSchema
  .extend({ preferences: preferencesSchema.strict() })
  .strict()

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
