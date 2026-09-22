import { z } from "zod"

import { render_chartSchema } from "@shared/presentation/tools"

/** The payload travels in the arguments; the result is the runtime's acknowledgement. */
export const chartPayloadSchema = z
  .object({
    args: render_chartSchema,
    result: z.unknown().optional(),
  })
  .transform(({ args }) => {
    const { title, ...result } = args
    return { args: { title }, result }
  })

export type ChartPayload = z.infer<typeof chartPayloadSchema>
