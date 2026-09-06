import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Plan, PlanCompact } from "./index"

afterEach(cleanup)

const todos = [
  { id: "brief", label: "Confirm the brief", status: "completed" as const },
  { id: "launch", label: "Prepare the launch", status: "in_progress" as const },
]

describe("Plan hierarchy", () => {
  it.each([
    ["visual", Plan],
    ["compact", PlanCompact],
  ])("renders response-scoped copy in the %s Plan", (_renderer, Component) => {
    render(
      <Component
        id="plan-launch"
        title="Launch plan"
        caption="Attached to this response."
        todos={todos}
        progressLabel={(done, total) =>
          `${done} of ${total} plan steps complete`
        }
      />
    )

    expect(
      screen.getByRole("heading", { level: 2, name: "Launch plan" })
    ).toBeInTheDocument()
    expect(screen.getByText("Attached to this response.")).toBeInTheDocument()
    expect(screen.getByText("1 of 2 plan steps complete")).toBeInTheDocument()
    expect(screen.getByText("Confirm the brief")).toBeInTheDocument()
  })
})
