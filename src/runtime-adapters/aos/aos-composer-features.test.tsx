import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useAosComposerFeatures } from "./aos-composer-features"

describe("AOS composer features", () => {
  it("projects normalized selected model and context for only the selected Session", async () => {
    const models = vi.fn(async () => ({
      selectedId: "small",
      options: [{ id: "small", label: "Small", group: "Native" }],
    }))
    const context = vi.fn(async () => ({
      usedTokens: 1_200,
      maxTokens: 8_000,
      source: "provider-usage" as const,
      breakdown: { systemTokens: 100, toolTokens: 200, messageTokens: 900 },
    }))
    const client = { models, context, selectModel: vi.fn() }
    const { result } = renderHook(() =>
      useAosComposerFeatures(
        client,
        {
          modelSelectorEnabled: true,
          contextEnabled: true,
        },
        "session-1"
      )
    )

    await waitFor(() => expect(result.current.model?.selectedId).toBe("small"))
    expect(result.current.context?.usage).toEqual({
      system: 0,
      tools: 0,
      messages: 1,
      total: 8,
    })
    expect(models).toHaveBeenCalledWith("session-1")
    expect(context).toHaveBeenCalledWith("session-1")
  })
})
