import { z } from "zod"

export const montyPayloadSchema = z.object({
  args: z.object({ code: z.string().min(1) }),
  result: z.unknown().optional(),
})

export type MontyPayload = z.infer<typeof montyPayloadSchema>
