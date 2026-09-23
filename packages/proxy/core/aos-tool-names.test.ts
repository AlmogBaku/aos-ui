import { describe, expect, it } from "vitest"

import {
  canonicalAosToolName,
  canonicalToolName,
  formatMcpToolName,
  type McpToolNameResolver,
} from "./aos-tool-names"

const TOOLS = ["render_chart", "render_map", "render_stats", "present_artifact"]

describe("canonicalAosToolName", () => {
  it.each(["mcp__aos_ui__", "aos-ui_", "aos_ui_", "mcp__aos-ui__"])(
    "reduces the %s prefix to the bare tool name",
    (prefix) => {
      for (const tool of TOOLS)
        expect(canonicalAosToolName(`${prefix}${tool}`)).toBe(tool)
    }
  )

  it.each([
    "mcp__other__render_chart",
    "render_chart_x",
    "mcp__aos_ui__render_chart_x",
    "mcp__aos_ui__delete_everything",
    "render_chart",
  ])("leaves %s alone", (name) => {
    expect(canonicalAosToolName(name)).toBeUndefined()
  })
})

describe("canonicalToolName", () => {
  const resolve: McpToolNameResolver = (raw) =>
    raw === "weather_forecast"
      ? { server: "weather", tool: "forecast" }
      : raw === "aos-ui_render_chart"
        ? { server: "aos-ui", tool: "render_chart" }
        : undefined

  it("keeps an aos-ui tool bare even when the resolver recognizes it", () => {
    expect(canonicalToolName("aos-ui_render_chart", resolve)).toBe(
      "render_chart"
    )
  })

  it("names another resolved MCP tool by its server and tool", () => {
    expect(canonicalToolName("weather_forecast", resolve)).toBe(
      "mcp__weather__forecast"
    )
    expect(formatMcpToolName("weather", "forecast")).toBe(
      "mcp__weather__forecast"
    )
  })

  it("leaves a name the resolver does not recognize alone", () => {
    expect(canonicalToolName("read_file", resolve)).toBe("read_file")
  })
})
