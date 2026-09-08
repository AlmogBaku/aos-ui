import { z } from "zod"

const chartRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().finite()])
)

export const chartResultSchema = z
  .object({
    type: z.enum(["line", "bar", "pie"]).default("line"),
    xKey: z.string().min(1),
    series: z
      .array(
        z.object({
          key: z.string().min(1),
          label: z.string().min(1),
        })
      )
      .min(1),
    data: z.array(chartRowSchema).min(1),
  })

  .superRefine((chart, context) => {
    chart.data.forEach((row, rowIndex) => {
      if (!(chart.xKey in row)) {
        context.addIssue({
          code: "custom",
          path: ["data", rowIndex, chart.xKey],
          message: "Missing axis value",
        })
      }
      chart.series.forEach((series) => {
        if (typeof row[series.key] !== "number") {
          context.addIssue({
            code: "custom",
            path: ["data", rowIndex, series.key],
            message: "Series values must be numeric",
          })
        }
      })
    })

    if (chart.type === "pie" && chart.series.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["series"],
        message: "Pie charts require exactly one numeric series",
      })
    }

    if (chart.type === "pie" && chart.series.length === 1) {
      const key = chart.series[0].key
      const total = chart.data.reduce((sum, row) => sum + Number(row[key]), 0)
      if (chart.data.some((row) => Number(row[key]) < 0) || total <= 0) {
        context.addIssue({
          code: "custom",
          path: ["data"],
          message:
            "Pie chart values must be non-negative with a positive total",
        })
      }
    }
  })
