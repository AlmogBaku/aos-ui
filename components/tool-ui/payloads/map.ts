import { z } from "zod"

const mapResultSchema = z.object({
  locations: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
      })
    )
    .min(1),
})

const fixtureMapPayloadSchema = z.object({
  args: z.object({ title: z.string().min(1) }),
  result: mapResultSchema.optional(),
})

const openCodeMapPayloadSchema = z
  .object({
    args: mapResultSchema.extend({ title: z.string().min(1) }),
    result: z.unknown().optional(),
  })
  .transform(({ args }) => {
    const { title, ...result } = args
    return { args: { title }, result }
  })

/** OpenCode retains custom tool display payloads in call arguments. */
export const mapPayloadSchema = z.union([
  fixtureMapPayloadSchema,
  openCodeMapPayloadSchema,
])

export type MapPayload = z.infer<typeof mapPayloadSchema>
