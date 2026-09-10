import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { RuntimeUnavailable } from "./runtime-unavailable"

afterEach(cleanup)

describe("RuntimeUnavailable", () => {
  it("renders an explicit English configuration error", () => {
    render(<RuntimeUnavailable locale="en" reason="invalid-runtime-mode" />)

    expect(screen.getByRole("alert")).toBeVisible()
  })

  it("explains that both OpenCode model override values are required", () => {
    render(
      <RuntimeUnavailable
        locale="en"
        reason="incomplete-opencode-model-override"
      />
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Set both AOS_UI_OPENCODE_PROVIDER_ID and AOS_UI_OPENCODE_MODEL_ID, or neither."
    )
  })

  it("localizes the AG-UI configuration state in Hebrew", () => {
    render(
      <RuntimeUnavailable locale="he" reason="missing-ag-ui-workspace-url" />
    )

    const alert = screen.getByRole("alert")
    expect(alert).toHaveAttribute("dir", "rtl")
    expect(alert).toHaveTextContent("תצורת AG-UI אינה מלאה")
  })
})
