// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
  type ModelOption,
  type ModelSelectorLabels,
} from "./model-selector"

const labels: ModelSelectorLabels = {
  placeholder: "Choose model",
  search: "Search models",
  searchPlaceholder: "Search models…",
  empty: "No models found.",
  switching: "Switching model…",
  retry: "Retry model selection",
}

const GROUPS = ["OpenAI", "Anthropic", "Local"] as const

/** A large roster, as a Hermes catalog reports it, plus one Hebrew label. */
function largeRoster(): readonly ModelOption[] {
  const models: ModelOption[] = []
  for (const [groupIndex, group] of GROUPS.entries()) {
    for (let index = 0; index < 6; index += 1) {
      models.push({
        id: `${group.toLowerCase()}-${index}`,
        name: `${group} Model ${index}`,
        description: `${group} tier ${index}`,
        group,
      })
    }
    if (groupIndex === 0) {
      models.push({
        id: `${group.toLowerCase()}-hebrew`,
        name: "מודל עברי",
        description: "תשובות בעברית",
        group,
      })
    }
  }
  models.push({ id: "custom-endpoint", name: "Custom endpoint" })
  return models
}

function renderSelector({
  models,
  onValueChange = () => undefined,
  selection,
  value = "openai-0",
}: {
  models: readonly ModelOption[]
  onValueChange?: (next: string) => void
  selection?: Parameters<typeof ModelSelectorRoot>[0]["selection"]
  value?: string
}) {
  return render(
    <ModelSelectorRoot
      labels={labels}
      models={models}
      onValueChange={onValueChange}
      selection={selection}
      value={value}
    >
      <ModelSelectorTrigger aria-label="Choose model" />
      <ModelSelectorContent />
    </ModelSelectorRoot>
  )
}

describe("ModelSelector", () => {
  afterEach(cleanup)

  it("keeps search focused while the keyboard moves the highlight over a large roster", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const models = largeRoster()
    renderSelector({ models, onValueChange })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))

    const search = await screen.findByRole("combobox", {
      name: "Search models",
    })
    expect(search).toHaveFocus()
    for (const group of GROUPS) {
      expect(screen.getByRole("group", { name: group })).toBeVisible()
    }

    await user.type(search, "Anthropic")
    expect(screen.getByRole("group", { name: "Anthropic" })).toBeVisible()
    expect(screen.queryByRole("group", { name: "OpenAI" })).toBeNull()
    expect(screen.queryByRole("group", { name: "Local" })).toBeNull()

    await user.clear(search)
    await user.type(search, "עברי")
    expect(screen.getByText("מודל עברי")).toBeVisible()
    expect(screen.queryByRole("group", { name: "Local" })).toBeNull()

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(search)
    await user.keyboard("{Enter}")
    expect(onValueChange).toHaveBeenCalledWith("openai-hebrew")
  })

  it("reports an empty roster instead of silently showing nothing", async () => {
    const user = userEvent.setup()
    renderSelector({ models: largeRoster() })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    await user.type(
      await screen.findByRole("combobox", { name: "Search models" }),
      "no-such-provider"
    )

    expect(screen.getByText("No models found.")).toBeVisible()
  })

  it("omits search for a short roster", async () => {
    const user = userEvent.setup()
    renderSelector({
      models: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
        { id: "careful", name: "Careful", description: "Slower, thorough" },
      ],
      value: "balanced",
    })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(await screen.findByText("Slower, thorough")).toBeVisible()
    expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull()
  })

  it("keeps the authoritative selection while a switch is pending", async () => {
    const user = userEvent.setup()
    renderSelector({
      models: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
      selection: { status: "pending", targetId: "fast" },
      value: "balanced",
    })

    const trigger = screen.getByRole("combobox", { name: "Choose model" })
    expect(trigger).toHaveTextContent("Balanced")
    await user.click(trigger)
    expect(await screen.findByText("Switching model…")).toBeVisible()
  })

  it("names the control instead of reading as empty for an unoffered selection", async () => {
    renderSelector({
      models: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
      value: "retired-model",
    })

    expect(
      screen.getByRole("combobox", { name: "Choose model" })
    ).toHaveTextContent("Choose model")
  })

  it("surfaces a failed switch with a retry that repeats only that request", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const retry = vi.fn()
    renderSelector({
      models: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
      onValueChange,
      selection: {
        status: "error",
        targetId: "fast",
        error: "Switch failed",
        retry,
      },
      value: "balanced",
    })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Switch failed")

    await user.click(
      screen.getByRole("button", { name: "Retry model selection" })
    )
    expect(retry).toHaveBeenCalledOnce()
    expect(onValueChange).not.toHaveBeenCalled()
    expect(
      screen.getByRole("combobox", { name: "Choose model" })
    ).toHaveTextContent("Balanced")
  })
})
