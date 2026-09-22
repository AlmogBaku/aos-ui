import { z } from "zod"
import { chartResultSchema } from "./chart"

export const render_mapSchema = z.object({
  title: z.string().min(1).describe("A concise map title"),
  locations: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
    )
    .min(1),
})

export const render_statsSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  stats: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        value: z.union([z.string(), z.number()]),
        format: z
          .union([
            z.object({ kind: z.enum(["text"]) }),
            z.object({
              kind: z.enum(["number"]),
              decimals: z.number().int().min(0).optional(),
              compact: z.boolean().optional(),
            }),
            z.object({
              kind: z.enum(["currency"]),
              currency: z.string().min(1),
              decimals: z.number().int().min(0).optional(),
            }),
            z.object({
              kind: z.enum(["percent"]),
              decimals: z.number().int().min(0).optional(),
              basis: z.enum(["fraction", "unit"]).optional(),
            }),
          ])
          .optional(),
        diff: z
          .object({
            value: z.number(),
            decimals: z.number().int().min(0).optional(),
            upIsPositive: z.boolean().optional(),
            label: z.string().min(1).optional(),
          })
          .optional(),
        sparkline: z
          .object({
            data: z.array(z.number()).min(2),
            color: z.string().min(1).optional(),
          })
          .optional(),
      })
    )
    .min(1),
})

export const render_chartSchema = chartResultSchema.safeExtend({
  title: z.string().min(1),
})

export const presentationToolDefinitions = {
  render_chart: {
    description:
      "Render a line, bar, or pie chart from supplied structured data, never code. Pie charts require one series, nonnegative values and a positive total. Do not invent factual data.",
    schema: render_chartSchema,
  },
  render_map: {
    description:
      "Render known locations as a map using structured coordinates, not HTML or code. Never invent real locations.",
    schema: render_mapSchema,
  },
  render_stats: {
    description:
      "Render compact accessible metrics from supplied structured data. Label illustrative examples; do not invent facts.",
    schema: render_statsSchema,
  },
} as const

export type PresentationToolName = keyof typeof presentationToolDefinitions

/** Clearly illustrative fixtures; never present these values as user facts. */
export const presentationExamples = {
  render_chart: {
    title: "Illustrative comparison",
    type: "bar",
    xKey: "label",
    series: [{ key: "value", label: "Example value" }],
    data: [
      { label: "A", value: 2 },
      { label: "B", value: 3 },
    ],
  },
  render_map: {
    title: "Illustrative coordinate",
    locations: [
      { id: "origin", label: "Coordinate origin", latitude: 0, longitude: 0 },
    ],
  },
  render_stats: {
    title: "Illustrative metric",
    stats: [{ key: "count", label: "Example count", value: 2 }],
  },
} as const

export function presentationCatalog() {
  return Object.entries(presentationToolDefinitions).map(
    ([name, definition]) => ({
      name,
      description: definition.description,
      examples: [presentationExamples[name as PresentationToolName]],
      parameters: z.toJSONSchema(definition.schema, {
        unrepresentable: "any",
        io: "input",
      }),
      ...(name === "render_chart"
        ? {
            semanticRules: [
              "chart-axis-present",
              "chart-series-numeric",
              "pie-single-series-positive-total",
            ],
          }
        : {}),
    })
  )
}
