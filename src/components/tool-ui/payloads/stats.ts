import { z } from "zod"

import { render_statsSchema } from "@shared/presentation/tools"

/** The payload travels in the arguments; the result is the runtime's acknowledgement. */
export const statsPayloadSchema = z
  .object({ args: render_statsSchema, result: z.unknown().optional() })
  .transform(({ args }) => ({
    args: { title: args.title },
    result: args,
  }))

export type StatsPayload = z.infer<typeof statsPayloadSchema>
