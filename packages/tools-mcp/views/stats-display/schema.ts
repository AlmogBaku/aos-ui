import { z } from "zod"

import { render_statsSchema } from "../../../../shared/presentation/tools"

export const StatItemSchema = render_statsSchema.shape.stats.element
export const StatFormatSchema = StatItemSchema.shape.format.unwrap()
export const StatDiffSchema = StatItemSchema.shape.diff.unwrap()
export const StatSparklineSchema = StatItemSchema.shape.sparkline.unwrap()
export type StatFormat = z.infer<typeof StatFormatSchema>
export type StatDiff = z.infer<typeof StatDiffSchema>
export type StatSparkline = z.infer<typeof StatSparklineSchema>
export type StatItem = z.infer<typeof StatItemSchema>

export type StatsDisplayProps = z.infer<typeof render_statsSchema> & {
  id: string
  className?: string
  locale?: string
}
