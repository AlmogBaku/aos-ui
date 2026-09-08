import { z } from "zod"

import { render_mapSchema } from "@shared/presentation/tools"

const mapResultSchema = render_mapSchema.omit({ title: true })

const fixtureMapPayloadSchema = z.object({
  args: z.object({ title: z.string().min(1) }),
  result: mapResultSchema.optional(),
})

const openCodeMapPayloadSchema = z
  .object({
    args: render_mapSchema,
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
