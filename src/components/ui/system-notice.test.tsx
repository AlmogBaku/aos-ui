import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Button } from "@/components/ui/button"
import { SystemNotice } from "@/components/ui/system-notice"

afterEach(() => {
  cleanup()
})

describe("system notice", () => {
  it("announces an error as AOS speaking, not the Agent", () => {
    render(
      <SystemNotice
        locale="en"
        title="This output could not be loaded."
        tone="error"
      >
        <Button type="button">Try again</Button>
      </SystemNotice>
    )

    expect(
      screen.getByRole("alert", {
        name: "AOS This output could not be loaded.",
      })
    ).toBeVisible()
    expect(screen.getByText("AOS")).toBeVisible()
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
  })

  it("keeps a warning and an explanation out of the alert role", () => {
    render(
      <SystemNotice
        detail="The provider removed this file."
        locale="en"
        title="This output is no longer available."
        tone="warning"
      />
    )

    expect(
      screen.getByRole("status", {
        name: "AOS This output is no longer available.",
      })
    ).toBeVisible()
    expect(screen.getByText("The provider removed this file.")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("reads as a Hebrew RTL notice under the product name", () => {
    render(
      <SystemNotice locale="he" title="הפלט הזה כבר לא זמין." tone="info" />
    )

    const notice = screen.getByRole("status", {
      name: "AOS הפלט הזה כבר לא זמין.",
    })
    expect(notice).toHaveAttribute("dir", "rtl")
  })
})
