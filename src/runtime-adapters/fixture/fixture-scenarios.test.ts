import { describe, expect, it } from "vitest"

import { buildFixtureScenario, fixtureScenarioNames } from "./fixture-scenarios"
import { readAosToolArtifact } from "@/components/tool-ui/tool-artifact"

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
      ["simulate provider outage", "provider-outage"],
      ["show the tool kinds", "tool-kinds"],
      ["show a diff", "diff"],
      ["stream a terminal live", "terminal-live"],
      ["show a failed terminal", "terminal-failed"],
      ["show a nested subagent", "subagent-nested"],
      ["stop at the length limit", "stop-length"],
      ["show a refusal", "stop-refusal"],
      ["show a provider error", "provider-error-detail"],
      ["compact the context", "compaction"],
      ["show a failed compaction", "compaction-failed"],
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

  it("streams the live terminal in frames that end with its exit", () => {
    const scenario = buildFixtureScenario("Stream a terminal live")
    const terminalOf = (part: unknown) =>
      readAosToolArtifact((part as { artifact?: unknown }).artifact)
        ?.terminals?.[0]

    expect(scenario.frames?.length).toBeGreaterThan(1)
    expect(terminalOf(scenario.frames?.[0]?.[0])?.running).toBe(true)
    expect(terminalOf(scenario.parts[0])).toMatchObject({
      running: false,
      exitCode: 0,
    })
  })

  it("reports a failed terminal's exit code", () => {
    const scenario = buildFixtureScenario("Show a failed terminal")
    const artifact = readAosToolArtifact(
      (scenario.parts[0] as { artifact?: unknown }).artifact
    )

    expect(artifact?.terminals?.[0]?.exitCode).toBe(1)
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

  it("settles the stop and failure scenarios the way a provider would", () => {
    expect(buildFixtureScenario("stop at the length limit").status).toEqual({
      type: "incomplete",
      reason: "length",
    })
    expect(buildFixtureScenario("show a refusal").status).toEqual({
      type: "incomplete",
      reason: "content-filter",
    })
    expect(buildFixtureScenario("show a provider error").status).toMatchObject({
      type: "incomplete",
      reason: "error",
      error: { provider: "Fixture Cloud", model: "fixture-balanced" },
    })
  })

  it("compacts mid-turn, between the turn's edits and its final answer", () => {
    const { parts } = buildFixtureScenario("compact the context")
    const compaction = parts.findIndex((part) => part.type === "data")

    expect(parts[compaction]).toMatchObject({
      name: "aos-compaction",
      data: { status: "completed", summary: expect.any(String) },
    })
    expect(parts.slice(0, compaction).some((p) => p.type === "tool-call")).toBe(
      true
    )
    expect(
      parts.slice(compaction + 1).some((p) => p.type === "tool-call")
    ).toBe(true)
    expect(
      buildFixtureScenario("show a failed compaction").parts.find(
        (part) => part.type === "data"
      )
    ).toMatchObject({ data: { status: "failed", error: expect.any(String) } })
  })

  it("returns an unknown tool for the malformed scenario", () => {
    expect(buildFixtureScenario("malformed tool").parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "unknown_fixture_tool",
    })
  })
})
