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
  effort: "Thinking",
  effortLevels: { none: "Off", low: "Low", medium: "Medium", high: "High" },
  effortUnset: "Provider default",
}

const EFFORTS = ["none", "low", "medium", "high"] as const

/** Short enough that the popup offers no search box. */
const SHORT_ROSTER: readonly ModelOption[] = [
  { id: "balanced", name: "Balanced" },
  { id: "fast", name: "Fast" },
]

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
  direction,
  efforts,
  effortValue,
  models,
  onEffortChange,
  onValueChange = () => undefined,
  selection,
  value = "openai-0",
}: {
  direction?: Parameters<typeof ModelSelectorRoot>[0]["direction"]
  efforts?: readonly string[]
  effortValue?: string
  models: readonly ModelOption[]
  onEffortChange?: (next: string) => void
  onValueChange?: (next: string) => void
  selection?: Parameters<typeof ModelSelectorRoot>[0]["selection"]
  value?: string
}) {
  return render(
    <ModelSelectorRoot
      direction={direction}
      efforts={efforts}
      effortValue={effortValue}
      labels={labels}
      models={models}
      onEffortChange={onEffortChange}
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

  it("shows the picked model and announces that the switch is in flight", async () => {
    const user = userEvent.setup()
    renderSelector({
      efforts: EFFORTS,
      effortValue: "high",
      models: SHORT_ROSTER,
      onEffortChange: () => undefined,
      selection: { status: "pending" },
      value: "fast",
    })

    const trigger = screen.getByRole("combobox", { name: "Choose model" })
    expect(trigger).toHaveTextContent("Fast")
    expect(trigger).toHaveTextContent("High")
    expect(trigger).toHaveAttribute("aria-busy", "true")
    await user.click(trigger)
    expect(await screen.findByText("Switching model…")).toBeVisible()
  })

  it("reads as settled once no switch is in flight", () => {
    renderSelector({ models: SHORT_ROSTER, value: "fast" })

    expect(
      screen.getByRole("combobox", { name: "Choose model" })
    ).not.toHaveAttribute("aria-busy")
  })

  it("commits the model a pointer clicks while the search box holds focus", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderSelector({ models: largeRoster(), onValueChange })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    await user.click(await screen.findByText("Anthropic Model 2"))

    expect(onValueChange).toHaveBeenCalledWith("anthropic-2")
  })

  it("names the control instead of reading as empty for an unoffered selection", async () => {
    renderSelector({
      models: SHORT_ROSTER,
      value: "retired-model",
    })

    expect(
      screen.getByRole("combobox", { name: "Choose model" })
    ).toHaveTextContent("Choose model")
  })

  it("moves reasoning effort along the ladder the provider reported", async () => {
    const user = userEvent.setup()
    const onEffortChange = vi.fn()
    renderSelector({
      efforts: EFFORTS,
      effortValue: "medium",
      models: SHORT_ROSTER,
      onEffortChange,
      value: "balanced",
    })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    const effort = await screen.findByRole("slider", { name: "Thinking" })
    effort.focus()

    await user.keyboard("{ArrowUp}")
    expect(onEffortChange).toHaveBeenCalledWith("high")
    // The popup owns both halves of the choice, so it outlives a level change.
    expect(effort).toBeVisible()
  })

  it("reads as the provider's default until a level is reported", async () => {
    const user = userEvent.setup()
    const onEffortChange = vi.fn()
    renderSelector({
      efforts: EFFORTS,
      models: SHORT_ROSTER,
      onEffortChange,
      value: "balanced",
    })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    const effort = await screen.findByRole("slider", { name: "Thinking" })
    expect(effort).toHaveAttribute("aria-valuetext", "Provider default")

    effort.focus()
    await user.keyboard("{ArrowUp}")
    expect(onEffortChange).toHaveBeenCalledWith("low")
  })

  it("offers no effort control for a model that reports no efforts", async () => {
    const user = userEvent.setup()
    renderSelector({
      models: SHORT_ROSTER,
      onEffortChange: () => undefined,
      value: "balanced",
    })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(await screen.findByRole("listbox")).toBeVisible()
    expect(screen.queryByRole("slider", { name: "Thinking" })).toBeNull()
  })

  it("reports a failed effort switch on the one status the choice shares", async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    renderSelector({
      efforts: EFFORTS,
      effortValue: "medium",
      models: SHORT_ROSTER,
      onEffortChange: () => undefined,
      selection: {
        status: "error",
        error: "Effort switch failed",
        retry,
      },
      value: "balanced",
    })

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    const alerts = await screen.findAllByRole("alert")
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent("Effort switch failed")

    await user.click(
      screen.getByRole("button", { name: "Retry model selection" })
    )
    expect(retry).toHaveBeenCalledOnce()
  })

  it("surfaces a failed switch with a retry that repeats only that request", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const retry = vi.fn()
    renderSelector({
      models: SHORT_ROSTER,
      onValueChange,
      selection: { status: "error", error: "Switch failed", retry },
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
