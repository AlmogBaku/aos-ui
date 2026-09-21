import { z } from "zod"

const preferencesSchema = z.object({
  enabled: z.boolean(),
  completion: z.boolean(),
  failure: z.boolean(),
  input: z.boolean(),
  sound: z.boolean(),
  prompt: z.enum(["pending", "accepted", "declined"]),
})
/**
 * Version 3 keeps notification preferences only. Activity history is provider
 * state held in memory, so version 1 snapshots and their records are dropped.
 */
const snapshotSchema = z.object({
  version: z.literal(3),
  preferences: preferencesSchema,
})
const storedSnapshotSchema = snapshotSchema
  .extend({ preferences: preferencesSchema.strict() })
  .strict()
/** Version 2 predates the sound and ask-state preferences. */
const legacySnapshotSchema = z.strictObject({
  version: z.literal(2),
  preferences: z.strictObject({
    enabled: z.boolean(),
    completion: z.boolean(),
    failure: z.boolean(),
    input: z.boolean(),
  }),
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
    const value: unknown = JSON.parse(serialized)
    const parsed = storedSnapshotSchema.safeParse(value)
    if (parsed.success) return parsed.data
    const legacy = legacySnapshotSchema.safeParse(value)
    return legacy.success ? upgradeFromVersion2(legacy.data) : null
  } catch {
    return null
  }
}

/**
 * Version 2 wrote its default-off on every publish, so only an explicit opt-in
 * counts as an answered ask; every other device joins the default-on rollout.
 */
function upgradeFromVersion2({
  preferences,
}: z.infer<typeof legacySnapshotSchema>): ActivitySnapshot {
  return {
    version: 3,
    preferences: {
      ...preferences,
      enabled: true,
      sound: true,
      prompt: preferences.enabled ? "accepted" : "pending",
    },
  }
}
