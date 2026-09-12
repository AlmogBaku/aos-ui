// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
} from "./model-selector"

describe("ModelSelector", () => {
  afterEach(cleanup)

  it("filters descriptions and preserves matching provider groups", async () => {
    const user = userEvent.setup()
    render(
      <ModelSelectorRoot
        models={[
          {
            id: "gpt-fast",
            name: "GPT Fast",
            description: "Fast OpenAI responses",
            group: "OpenAI",
          },
          {
            id: "claude-careful",
            name: "Claude Careful",
            description: "Thoughtful Anthropic responses",
            group: "Anthropic",
          },
        ]}
        value="gpt-fast"
        onValueChange={() => undefined}
      >
        <ModelSelectorTrigger aria-label="Choose model" />
        <ModelSelectorContent searchable />
      </ModelSelectorRoot>
    )

    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(await screen.findByText("Fast OpenAI responses")).toBeVisible()
    expect(screen.getByRole("group", { name: "OpenAI" })).toBeVisible()
    expect(screen.getByRole("group", { name: "Anthropic" })).toBeVisible()

    await user.type(
      screen.getByRole("searchbox", { name: "Search models" }),
      "anthropic"
    )

    expect(screen.queryByRole("group", { name: "OpenAI" })).toBeNull()
    expect(screen.getByRole("group", { name: "Anthropic" })).toBeVisible()
    expect(screen.getByText("Claude Careful")).toBeVisible()
  })

  it("keeps the authoritative selection while a controlled switch is pending and offers retry after failure", async () => {
    const user = userEvent.setup()
    const select = vi.fn()
    const retry = vi.fn()
    render(
      <ModelSelectorRoot
        models={[
          { id: "balanced", name: "Balanced", efforts: true },
          { id: "fast", name: "Fast" },
        ]}
        value="balanced"
        onValueChange={select}
        selection={{
          status: "error",
          targetId: "fast",
          error: "Switch failed",
          retry,
        }}
      >
        <ModelSelectorTrigger aria-label="Choose model" />
        <ModelSelectorContent searchable />
      </ModelSelectorRoot>
    )

    expect(
      screen.getByRole("combobox", { name: "Choose model" })
    ).toHaveTextContent("Balanced")
    await user.click(screen.getByRole("combobox", { name: "Choose model" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Switch failed")
    await user.click(
      screen.getByRole("button", { name: "Retry model selection" })
    )
    expect(retry).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
  })
})
