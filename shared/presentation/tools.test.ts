import { describe, expect, it } from "vitest"
import {
  presentationCatalog,
  presentationToolDefinitions,
  presentationExamples,
} from "./tools"

describe("portable presentation definitions", () => {
  it("ships executable examples shared by both native packages", () => {
    for (const [name, definition] of Object.entries(
      presentationToolDefinitions
    )) {
      expect(
        definition.schema.safeParse(
          presentationExamples[name as keyof typeof presentationExamples]
        ).success
      ).toBe(true)
    }
  })
  it("exports three model-visible JSON schemas without React dependencies", () => {
    const tools = presentationCatalog()
    expect(tools.map(({ name }) => name)).toEqual([
      "render_chart",
      "render_map",
      "render_stats",
    ])
    expect(tools.every(({ parameters }) => parameters.type === "object")).toBe(
      true
    )
  })
  it("keeps chart semantic checks shared with native tool execution", () => {
    const schema = presentationToolDefinitions.render_chart.schema
    const chart = {
      title: "Shares",
      type: "pie",
      xKey: "name",
      series: [{ key: "value", label: "Value" }],
      data: [{ name: "A", value: 2 }],
    }
    expect(schema.safeParse(chart).success).toBe(true)
    expect(
      schema.safeParse({ ...chart, data: [{ name: "A", value: -2 }] }).success
    ).toBe(false)
    expect(
      schema.safeParse({ ...chart, data: [{ name: "A", other: 2 }] }).success
    ).toBe(false)
    expect(
      schema.safeParse({
        ...chart,
        series: [...chart.series, { key: "other", label: "Other" }],
      }).success
    ).toBe(false)
  })
})
