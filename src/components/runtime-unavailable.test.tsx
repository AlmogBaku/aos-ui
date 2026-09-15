import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { RuntimeUnavailable } from "./runtime-unavailable"

afterEach(cleanup)

describe("RuntimeUnavailable", () => {
  it("renders an explicit English configuration error", () => {
    render(<RuntimeUnavailable locale="en" reason="invalid-runtime-mode" />)

    expect(screen.getByRole("alert")).toBeVisible()
  })

  it("localizes an invalid public configuration in Hebrew", () => {
    render(<RuntimeUnavailable locale="he" reason="invalid-public-config" />)

    const alert = screen.getByRole("alert")
    expect(alert).toHaveAttribute("dir", "rtl")
    expect(alert).toHaveTextContent("תצורת סביבת ההרצה חסרה או אינה תקינה.")
  })
})
