import { z } from "zod"
import { SerializableStatsDisplaySchema } from "../stats-display/schema"

const statsResultSchema = SerializableStatsDisplaySchema.omit({
  id: true,
  role: true,
})

const resultBackedStatsPayloadSchema = z.object({
  args: z.object({ title: z.string().min(1) }),
  result: statsResultSchema.optional(),
})

const argumentBackedStatsPayloadSchema = z
  .object({ args: statsResultSchema, result: z.unknown().optional() })
  .transform(({ args }) => ({
    args: { title: args.title },
    result: args,
  }))

/** Supported transports may return results or retain display data in args. */
export const statsPayloadSchema = z.union([
  argumentBackedStatsPayloadSchema,
  resultBackedStatsPayloadSchema,
])

export type StatsPayload = z.infer<typeof statsPayloadSchema>
