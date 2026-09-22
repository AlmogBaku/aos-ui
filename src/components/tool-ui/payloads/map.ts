import { z } from "zod"

import { render_mapSchema } from "@shared/presentation/tools"

/** The payload travels in the arguments; the result is the runtime's acknowledgement. */
export const mapPayloadSchema = z
  .object({
    args: render_mapSchema,
    result: z.unknown().optional(),
  })
  .transform(({ args }) => {
    const { title, ...result } = args
    return { args: { title }, result }
  })

export type MapPayload = z.infer<typeof mapPayloadSchema>
