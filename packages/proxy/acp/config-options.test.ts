import { describe, expect, it } from "vitest"

import type { SessionModelsResponse } from "../../protocol"
import { configOptionsOf, configWriteOf } from "./config-options"

const models: SessionModelsResponse = {
  selectedId: "sonnet",
  effortId: "medium",
  options: [
    {
      id: "sonnet",
      label: "Sonnet",
      group: "Anthropic",
      efforts: ["low", "medium", "high"],
    },
    { id: "haiku", label: "Haiku", group: "Anthropic" },
  ],
}

describe("configOptionsOf", () => {
  it("offers the model catalog as one selector", () => {
    expect(configOptionsOf(models)[0]).toEqual({
      type: "select",
      configId: "model",
      name: "Model",
      category: "model",
      currentValue: "sonnet",
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "haiku", name: "Haiku" },
      ],
    })
  })

  it("offers the efforts of the selected model as the thought level", () => {
    expect(configOptionsOf(models)[1]).toEqual({
      type: "select",
      configId: "thought_level",
      name: "Thought level",
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "low", name: "low" },
        { value: "medium", name: "medium" },
        { value: "high", name: "high" },
      ],
    })
  })

  it("leaves the thought level unset while the provider default applies", () => {
    const { effortId, ...withoutEffort } = models
    void effortId

    expect(configOptionsOf(withoutEffort)[1]).toMatchObject({
      configId: "thought_level",
      currentValue: "",
    })
  })

  it.each([
    ["a model that reports no efforts", "haiku"],
    ["a selection outside the catalog", "opus"],
  ])("omits the thought level for %s", (_label, selectedId) => {
    expect(configOptionsOf({ ...models, selectedId })).toHaveLength(1)
  })
})

describe("configWriteOf", () => {
  it.each([
    ["model", "haiku", { selectedId: "haiku" }],
    ["thought_level", "high", { effortId: "high" }],
  ])("writes %s", (configId, value, expected) => {
    expect(configWriteOf(configId, value)).toEqual(expected)
  })

  it.each([
    ["an unknown option", "mode", "plan"],
    ["a non-string model", "model", 3],
    ["a missing thought level", "thought_level", undefined],
  ])("refuses %s", (_label, configId, value) => {
    expect(configWriteOf(configId, value)).toBeUndefined()
  })
})
