import { render, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ToolTimeline } from "./tool-timeline"

describe("ToolTimeline", () => {
  it("shows a settled check and exposes the completed status while collapsed", () => {
    const { container } = render(
      <ToolTimeline
        steps={[]}
        visibleSteps={0}
        streaming={false}
        open={false}
        onOpenChange={vi.fn()}
        restingLabel="2 tool calls"
        activeLabel="Running"
        stats={[]}
        state="complete"
        statusLabel="Complete"
      />
    )

    const trigger = within(container).getByRole("button", {
      name: "2 tool calls",
    })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(trigger).toHaveAccessibleDescription("Complete")
  })

  it.each([
    ["running", "Running"],
    ["attention", "Needs input"],
    ["failed", "Failed"],
  ] as const)(
    "exposes %s without showing a completion check",
    (state, label) => {
      const { container } = render(
        <ToolTimeline
          steps={[]}
          visibleSteps={0}
          streaming={state === "running"}
          open={false}
          onOpenChange={vi.fn()}
          restingLabel="1 tool call"
          activeLabel="Running"
          stats={[]}
          state={state}
          statusLabel={label}
        />
      )

      const accessibleName = state === "running" ? label : "1 tool call"
      const trigger = within(container).getByRole("button", {
        name: accessibleName,
      })
      expect(trigger).toHaveAccessibleDescription(label)
    }
  )
})
