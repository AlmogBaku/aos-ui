import { z } from "zod"

/**
 * Names and shapes of the message parts a runtime writes and the thread
 * renders, kept outside both so neither depends on the other.
 */

/** The data part a runtime emits while it compacts the Session's context. */
export const COMPACTION_DATA_PART_NAME = "aos-compaction"

export const compactionSchema = z.object({
  compactionId: z.string(),
  status: z.enum(["started", "completed", "failed"]),
  summary: z.string().optional(),
  error: z.string().optional(),
})

export type AosCompaction = z.infer<typeof compactionSchema>

/**
 * The id the projector gives an accepted correction's user turn; the queue row
 * watches for it.
 */
export const steerMessageId = (requestId: string) => `steer:${requestId}`
