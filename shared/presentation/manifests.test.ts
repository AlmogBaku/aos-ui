import { describe, expect, it } from "vitest"

import {
  agentBuilderProviderInstructions,
  conservativeProviderInstructions,
  fixtureProviderInstructions,
  openCodeProviderInstructions,
} from "./manifests"

describe("provider harness manifests", () => {
  it("advertises OpenCode's UI", () => {
    expect(openCodeProviderInstructions).toContain("`render_chart`")
    expect(openCodeProviderInstructions).toContain("`render_map`")
    expect(openCodeProviderInstructions).toContain("`render_stats`")
    expect(openCodeProviderInstructions).toContain("`present_artifact`")
    expect(openCodeProviderInstructions).toContain("`question`")
  })

  it("keeps fixture and conservative prompts honest about their integrations", () => {
    expect(fixtureProviderInstructions).toContain("`ask_user_question`")

    expect(conservativeProviderInstructions).toMatch(/fenced `mermaid` blocks/i)
    expect(conservativeProviderInstructions).toMatch(
      /Interactive questions are unavailable/i
    )
    expect(conservativeProviderInstructions).not.toContain("`render_chart`")
    expect(conservativeProviderInstructions).toContain("`present_artifact`")
  })

  it("advertises only the Builder controls its permission set exposes", () => {
    expect(agentBuilderProviderInstructions).toContain("`question`")
    expect(agentBuilderProviderInstructions).not.toContain("`render_chart`")
    expect(agentBuilderProviderInstructions).toMatch(
      /Todo controls are unavailable/i
    )
    expect(agentBuilderProviderInstructions).toMatch(
      /Subagent UI controls are unavailable/i
    )
  })
})
