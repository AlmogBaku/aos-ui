import { tool } from "@opencode-ai/plugin"

/** A display-only bridge to the shadcn Tool UI stats-display component. */
export default tool({
  description:
    "Render compact, accessible key metrics in the AOS conversation. Use when the user explicitly asks for metrics, KPIs, or a statistical summary. Supply structured values, not HTML or code. Do not invent factual data: when no data is available, label examples as illustrative.",
  args: {
    title: tool.schema.string().min(1).optional(),
    description: tool.schema.string().min(1).optional(),
    stats: tool.schema
      .array(
        tool.schema.object({
          key: tool.schema.string().min(1),
          label: tool.schema.string().min(1),
          value: tool.schema.union([
            tool.schema.string(),
            tool.schema.number(),
          ]),
          format: tool.schema
            .union([
              tool.schema.object({ kind: tool.schema.enum(["text"]) }),
              tool.schema.object({
                kind: tool.schema.enum(["number"]),
                decimals: tool.schema.number().int().min(0).optional(),
                compact: tool.schema.boolean().optional(),
              }),
              tool.schema.object({
                kind: tool.schema.enum(["currency"]),
                currency: tool.schema.string().min(1),
                decimals: tool.schema.number().int().min(0).optional(),
              }),
              tool.schema.object({
                kind: tool.schema.enum(["percent"]),
                decimals: tool.schema.number().int().min(0).optional(),
                basis: tool.schema.enum(["fraction", "unit"]).optional(),
              }),
            ])
            .optional(),
          diff: tool.schema
            .object({
              value: tool.schema.number(),
              decimals: tool.schema.number().int().min(0).optional(),
              upIsPositive: tool.schema.boolean().optional(),
              label: tool.schema.string().min(1).optional(),
            })
            .optional(),
          sparkline: tool.schema
            .object({
              data: tool.schema.array(tool.schema.number()).min(2),
              color: tool.schema.string().min(1).optional(),
            })
            .optional(),
        })
      )
      .min(1),
  },
  async execute(args) {
    return `Metrics ready for display: ${args.title ?? "metrics"}`
  },
})
