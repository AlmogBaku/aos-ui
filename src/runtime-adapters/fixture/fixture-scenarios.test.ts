import { describe, expect, it } from "vitest"

import { buildFixtureScenario, fixtureScenarioNames } from "./fixture-scenarios"

describe("deterministic fixture scenarios", () => {
  it("routes representative prompts to every supported scenario", () => {
    const cases = [
      ["default brief", "default"],
      ["ask a question", "question"],
      ["request permission", "permission"],
      ["delegate to a subagent", "subagent"],
      ["update todos", "todos"],
      ["render a chart", "chart"],
      ["publish an artifact", "artifact"],
      ["publish an image", "image"],
      ["publish an audio note", "audio"],
      ["publish a video note", "video"],
      ["show a map", "map"],
      ["show metrics", "stats"],
      ["show mermaid", "mermaid"],
      ["show wide mermaid", "mermaid-wide"],
      ["show incomplete mermaid stream", "mermaid-incomplete"],
      ["show malformed mermaid", "mermaid-malformed"],
      ["show oversized mermaid", "mermaid-oversized"],
      ["return a malformed tool", "malformed-tool"],
      ["open the mcp app", "mcp-app"],
      ["simulate provider outage", "provider-outage"],
    ]
    const scenarios = cases.map(([prompt, expected]) => {
      expect(buildFixtureScenario(prompt).name).toBe(expected)
      return buildFixtureScenario(prompt)
    })
    expect(new Set(scenarios.map(({ name }) => name))).toEqual(
      new Set(fixtureScenarioNames)
    )
    expect(
      scenarios.every(
        ({ parts }) =>
          parts.length > 0 &&
          parts.every((part) =>
            part.type === "text"
              ? part.text.trim().length > 0
              : part.type === "tool-call"
                ? Boolean(part.toolName)
                : part.type === "data" && part.data != null
          )
      )
    ).toBe(true)
  })

  it("keeps Question and Permission payloads distinct", () => {
    const question = buildFixtureScenario("Please ask me a question")
    const permission = buildFixtureScenario("Request permission first")

    expect(question.parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "ask_user_question",
    })
    expect(permission.parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "request_permission",
    })
    expect(question.parts[0]).not.toHaveProperty("approval")
    expect(permission.parts[0]).toHaveProperty("approval")
  })

  it("keeps Todo output event-scoped instead of message-scoped", () => {
    const todos = buildFixtureScenario("Update todos")

    expect(todos.parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(todos.todoEvent?.[0]?.id).toBe("todo-fixture-1")
  })

  it("keeps a metrics request as a structured stats display, not a Todo", () => {
    const scenario = buildFixtureScenario("Show launch metrics")

    expect(scenario.name).toBe("stats")
    expect(scenario.todoEvent).toBeUndefined()
    expect(scenario.parts[0]).toMatchObject({ toolName: "render_stats" })
  })

  it("returns Mermaid as ordinary markdown instead of a browser-executed tool", () => {
    const scenario = buildFixtureScenario("Show a Mermaid diagram")

    expect(scenario.name).toBe("mermaid")
    expect(scenario.parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("```mermaid"),
      },
    ])
    expect(scenario.todoEvent).toBeUndefined()
  })

  it("provides stable incomplete, malformed, and oversized Mermaid fixtures", () => {
    const incomplete = buildFixtureScenario("Show an incomplete Mermaid stream")
    const malformed = buildFixtureScenario("Show malformed Mermaid")
    const oversized = buildFixtureScenario("Show oversized Mermaid")

    expect(incomplete.name).toBe("mermaid-incomplete")
    expect(incomplete.parts[0]).toMatchObject({
      type: "text",
      text: expect.not.stringMatching(/```$/),
    })
    expect(malformed.name).toBe("mermaid-malformed")
    expect(malformed.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Request -->"),
    })
    expect(oversized.name).toBe("mermaid-oversized")
    expect(oversized.parts[0]).toMatchObject({ type: "text" })
    const oversizedText = oversized.parts[0]
    expect(
      oversizedText?.type === "text"
        ? (oversizedText.text.match(/\n/g)?.length ?? 0)
        : 0
    ).toBeGreaterThan(400)
    expect(
      oversizedText?.type === "text" ? oversizedText.text.length : Infinity
    ).toBeLessThan(2_000)
  })

  it("returns an unknown tool for the malformed scenario", () => {
    expect(buildFixtureScenario("malformed tool").parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "unknown_fixture_tool",
    })
  })
})
