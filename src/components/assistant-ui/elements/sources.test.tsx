import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Source } from "./sources"

const status = { type: "complete" as const }

describe("Source", () => {
  it("renders a protocol URL source as a safe outbound link without a favicon", () => {
    render(
      <Source
        {...status}
        type="source"
        sourceType="url"
        id="source-1"
        title="OpenAI documentation"
        url="https://platform.openai.com/docs"
      />
    )

    const link = screen.getByRole("link", {
      name: "Open source: OpenAI documentation",
    })
    expect(link).toHaveAttribute("href", "https://platform.openai.com/docs")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer noopener")
    expect(document.querySelector("img")).toBeNull()
  })

  it("keeps document and unsafe URL sources as localized textual fallbacks", () => {
    const { rerender } = render(
      <Source
        {...status}
        type="source"
        sourceType="document"
        id="document-1"
        title="סיכום המחקר.pdf"
        mediaType="application/pdf"
        labels={{ documentSource: "מסמך מקור", openSource: "פתיחת מקור" }}
      />
    )

    expect(
      screen.getByLabelText("מסמך מקור: סיכום המחקר.pdf")
    ).toHaveTextContent("סיכום המחקר.pdf")

    rerender(
      <Source
        {...status}
        type="source"
        sourceType="url"
        id="source-2"
        title="Unsafe provider value"
        url="javascript:alert(1)"
        labels={{ documentSource: "מסמך מקור", openSource: "פתיחת מקור" }}
      />
    )

    expect(
      screen.queryByRole("link", { name: "פתיחת מקור: Unsafe provider value" })
    ).toBeNull()
    expect(screen.getByLabelText("מסמך מקור: Unsafe provider value")).toHaveTextContent(
      "Unsafe provider value"
    )
  })
})
