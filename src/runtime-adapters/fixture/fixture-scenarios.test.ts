import { describe, expect, it } from "vitest"

import { buildFixtureScenario, fixtureScenarioNames } from "./fixture-scenarios"

describe("deterministic fixture scenarios", () => {
  it("covers the complete interactive and failure matrix", () => {
    expect(fixtureScenarioNames).toEqual(
      expect.arrayContaining([
        "default",
        "question",
        "permission",
        "subagent",
        "plan",
        "todos",
        "chart",
        "map",
        "stats",
        "mermaid",
        "mermaid-incomplete",
        "mermaid-malformed",
        "mermaid-oversized",
        "monty-success",
        "monty-failure",
        "malformed-tool",
        "provider-outage",
      ])
    )
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

  it("keeps Plan output message-scoped and Todo output event-scoped", () => {
    const plan = buildFixtureScenario("Show a plan")
    const todos = buildFixtureScenario("Update todos")

    expect(plan.parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "present_plan",
    })
    expect(plan.todoEvent).toBeUndefined()
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

  it("marks Monty failure and malformed tools for the generic failed lifecycle", () => {
    expect(buildFixtureScenario("monty should fail").parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "monty_execute",
      isError: true,
    })
    expect(buildFixtureScenario("malformed tool").parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "unknown_fixture_tool",
    })
  })
})
