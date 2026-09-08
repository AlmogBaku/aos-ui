import { z } from "zod"

import { chartResultSchema } from "@shared/presentation/chart"
import { render_chartSchema } from "@shared/presentation/tools"

const resultBackedChartPayloadSchema = z.object({
  args: z.object({ title: z.string().min(1) }),
  result: chartResultSchema.optional(),
})

const argumentBackedChartPayloadSchema = z
  .object({
    args: render_chartSchema,
    result: z.unknown().optional(),
  })
  .transform(({ args }) => {
    const { title, ...result } = args
    return { args: { title }, result }
  })

/**
 * Supported transports may return the structured result or retain the display
 * payload in the call arguments and return an acknowledgement.
 */
export const chartPayloadSchema = z.union([
  resultBackedChartPayloadSchema,
  argumentBackedChartPayloadSchema,
])

export type ChartPayload = z.infer<typeof chartPayloadSchema>
