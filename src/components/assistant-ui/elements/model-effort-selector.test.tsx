// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ModelEffortSelector,
  type ModelEffortSelectorLabels,
} from "./model-effort-selector"

const labels: ModelEffortSelectorLabels = {
  trigger: "חשיבה",
  levels: {
    none: "כבוי",
    low: "נמוך",
    medium: "בינוני",
    high: "גבוה",
  },
  switching: "מחליף מודל…",
  retry: "ניסיון חוזר לבחירת מודל",
}

const EFFORTS = ["none", "low", "medium", "high"] as const

describe("ModelEffortSelector", () => {
  afterEach(cleanup)

  it("shows the localized current level and selects a provider effort id", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ModelEffortSelector
        direction="rtl"
        efforts={EFFORTS}
        labels={labels}
        onValueChange={onValueChange}
        value="medium"
      />
    )

    const trigger = screen.getByRole("combobox", { name: "חשיבה" })
    expect(trigger).toHaveTextContent("בינוני")

    await user.click(trigger)
    for (const effortId of EFFORTS) {
      expect(
        screen.getByRole("option", { name: labels.levels[effortId] })
      ).toBeVisible()
    }

    await user.click(screen.getByRole("option", { name: "גבוה" }))
    expect(onValueChange).toHaveBeenCalledWith("high")
  })

  it("falls back to the trigger label when the provider reports no effort", () => {
    render(
      <ModelEffortSelector
        efforts={EFFORTS}
        labels={labels}
        onValueChange={() => undefined}
      />
    )

    expect(screen.getByRole("combobox", { name: "חשיבה" })).toHaveTextContent(
      "חשיבה"
    )
  })

  it("offers a retry for a failed effort switch", async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    render(
      <ModelEffortSelector
        efforts={EFFORTS}
        labels={labels}
        onValueChange={() => undefined}
        selection={{
          status: "error",
          targetId: "high",
          error: "Effort switch failed",
          retry,
        }}
        value="medium"
      />
    )

    await user.click(screen.getByRole("combobox", { name: "חשיבה" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Effort switch failed"
    )

    await user.click(
      screen.getByRole("button", { name: "ניסיון חוזר לבחירת מודל" })
    )
    expect(retry).toHaveBeenCalledOnce()
  })
})
