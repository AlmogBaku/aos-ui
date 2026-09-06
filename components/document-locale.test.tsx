import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DocumentLocale } from "./document-locale"

afterEach(() => {
  cleanup()
  document.documentElement.lang = "en"
  document.documentElement.dir = "ltr"
})

describe("DocumentLocale", () => {
  it("keeps document language and direction current during locale navigation", () => {
    const { rerender } = render(<DocumentLocale locale="he" />)

    expect(document.documentElement).toHaveAttribute("lang", "he")
    expect(document.documentElement).toHaveAttribute("dir", "rtl")

    rerender(<DocumentLocale locale="en" />)

    expect(document.documentElement).toHaveAttribute("lang", "en")
    expect(document.documentElement).toHaveAttribute("dir", "ltr")
  })
})
