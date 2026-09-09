import { describe, expect, it } from "vitest"

import {
  readHermesContext,
  toHermesComposerUsage,
} from "./hermes-composer-state"

describe("readHermesContext", () => {
  it("maps Hermes native categories to ComposerContext segments", () => {
    expect(
      readHermesContext({
        context_used: 44_036,
        context_max: 272_000,
        context_source: "local_estimate",
        context_estimated: true,
        categories: [
          { id: "system_prompt", tokens: 10_000 },
          { id: "rules", tokens: 2_000 },
          { id: "skills", tokens: 3_000 },
          { id: "memory", tokens: 1_000 },
          { id: "tool_definitions", tokens: 8_000 },
          { id: "mcp", tokens: 4_000 },
          { id: "subagent_definitions", tokens: 2_000 },
          { id: "conversation", tokens: 14_036 },
        ],
      })
    ).toEqual({
      usedTokens: 44_036,
      maxTokens: 272_000,
      estimated: true,
      breakdown: {
        systemTokens: 16_000,
        toolTokens: 14_000,
        messageTokens: 14_036,
      },
    })
  })

  it("scales estimated Hermes categories to its native overall occupancy", () => {
    expect(
      toHermesComposerUsage({
        usedTokens: 44_036,
        maxTokens: 272_000,
        breakdown: {
          systemTokens: 16_000,
          toolTokens: 14_000,
          messageTokens: 14_036,
        },
      })
    ).toEqual({ system: 16, tools: 14, messages: 14, total: 272 })
  })
})
