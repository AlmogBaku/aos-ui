import { z } from "zod"
import { defineToolUiContract } from "../shared/contract"
import { ToolUIIdSchema, ToolUIRoleSchema } from "../shared/schema"

import { render_statsSchema } from "@shared/presentation/tools"

export const StatItemSchema = render_statsSchema.shape.stats.element
export const StatFormatSchema = StatItemSchema.shape.format.unwrap()
export const StatDiffSchema = StatItemSchema.shape.diff.unwrap()
export const StatSparklineSchema = StatItemSchema.shape.sparkline.unwrap()
export type StatFormat = z.infer<typeof StatFormatSchema>
export type StatDiff = z.infer<typeof StatDiffSchema>
export type StatSparkline = z.infer<typeof StatSparklineSchema>
export type StatItem = z.infer<typeof StatItemSchema>

export const SerializableStatsDisplaySchema = render_statsSchema.extend({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
})

export type SerializableStatsDisplay = z.infer<
  typeof SerializableStatsDisplaySchema
>

const SerializableStatsDisplaySchemaContract = defineToolUiContract(
  "StatsDisplay",
  SerializableStatsDisplaySchema
)

export const parseSerializableStatsDisplay: (
  input: unknown
) => SerializableStatsDisplay = SerializableStatsDisplaySchemaContract.parse

export const safeParseSerializableStatsDisplay: (
  input: unknown
) => SerializableStatsDisplay | null =
  SerializableStatsDisplaySchemaContract.safeParse
export interface StatsDisplayProps extends SerializableStatsDisplay {
  className?: string
  locale?: string
}
