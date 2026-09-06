import { describe, expect, it } from "vitest"

import {
  agentBuilderProviderInstructions,
  agUiProviderInstructions,
  fixtureProviderInstructions,
  openCodeProviderInstructions,
} from "./manifests"

describe("provider harness manifests", () => {
  it("advertises OpenCode's exact UI, interaction, and Monty tools", () => {
    expect(openCodeProviderInstructions).toContain("`render_chart`")
    expect(openCodeProviderInstructions).toContain("`render_map`")
    expect(openCodeProviderInstructions).toContain("`render_stats`")
    expect(openCodeProviderInstructions).toContain("`present_plan`")
    expect(openCodeProviderInstructions).toContain("`question`")
    expect(openCodeProviderInstructions).toContain("`monty_search`")
    expect(openCodeProviderInstructions).toContain("`monty_execute`")
  })

  it("keeps fixture and AG-UI prompts honest about their integrations", () => {
    expect(fixtureProviderInstructions).toContain("`ask_user_question`")
    expect(fixtureProviderInstructions).not.toMatch(/monty_/)

    expect(agUiProviderInstructions).toMatch(/fenced `mermaid` blocks/i)
    expect(agUiProviderInstructions).toMatch(
      /Interactive questions are unavailable/i
    )
    expect(agUiProviderInstructions).not.toContain("`render_chart`")
  })

  it("advertises only the Builder controls its permission set exposes", () => {
    expect(agentBuilderProviderInstructions).toContain("`question`")
    expect(agentBuilderProviderInstructions).not.toContain("`render_chart`")
    expect(agentBuilderProviderInstructions).not.toMatch(/monty_/)
    expect(agentBuilderProviderInstructions).toMatch(
      /Todo controls are unavailable/i
    )
    expect(agentBuilderProviderInstructions).toMatch(
      /Subagent delegation is unavailable/i
    )
  })
})
