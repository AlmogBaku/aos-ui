import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { ToolUiLocaleProvider } from "@/components/tool-ui"
import { Collapsible } from "@/components/ui/collapsible"

import { ImageContentFilterError, ImageGenerating, ImageZoom } from "./image"
import { CodeHeader } from "./markdown-text"
import {
  ReasoningContent,
  ReasoningFade,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "./reasoning"
import {
  ToolFallbackContent,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from "./tool-fallback.aui"
import { ToolGroupTrigger } from "./tool-group.aui"

afterEach(cleanup)

describe("localized conversation presentation", () => {
  it("localizes tool-group and reasoning disclosures without changing numeric content", () => {
    render(
      <ToolUiLocaleProvider locale="he">
        <Collapsible>
          <ToolGroupTrigger count={2} active />
        </Collapsible>
        <Collapsible>
          <ReasoningTrigger duration={7} active />
        </Collapsible>
      </ToolUiLocaleProvider>
    )

    expect(screen.getByRole("button", { name: "2 קריאות לכלים" })).toBeVisible()
    expect(screen.getByRole("button", { name: "חשיבה (7 שנ׳)" })).toBeVisible()
  })

  it("localizes image generation states", () => {
    render(
      <ToolUiLocaleProvider locale="he">
        <ImageGenerating />
        <ImageContentFilterError />
      </ToolUiLocaleProvider>
    )

    expect(screen.getByRole("status")).toHaveTextContent("התמונה נוצרת…")
    expect(screen.getByText("לא ניתן ליצור את התמונה")).toBeVisible()
  })

  it("localizes markdown code copy feedback", async () => {
    const user = userEvent.setup()
    render(
      <ToolUiLocaleProvider locale="he">
        <CodeHeader language="ts" code="const answer = 42" />
      </ToolUiLocaleProvider>
    )

    const copy = screen.getByRole("button", { name: "העתקת קוד" })
    await user.click(copy)
    expect(screen.getByRole("button", { name: "הועתק" })).toBeVisible()
  })
})

describe("reduced-motion presentation", () => {
  it("suppresses fallback and reasoning disclosure animations", () => {
    const { container } = render(
      <>
        <ToolFallbackRoot defaultOpen>
          <ToolFallbackTrigger toolName="search" status={{ type: "running" }} />
          <ToolFallbackContent>Searching</ToolFallbackContent>
        </ToolFallbackRoot>
        <ReasoningRoot defaultOpen>
          <ReasoningTrigger active />
          <ReasoningContent>
            <ReasoningFade side="top" />
            <ReasoningText>Thinking</ReasoningText>
          </ReasoningContent>
        </ReasoningRoot>
      </>
    )

    const animatedElements = container.querySelectorAll<HTMLElement>(
      '[class*="animate-"]'
    )
    expect(animatedElements.length).toBeGreaterThan(0)
    for (const element of animatedElements) {
      const classes = element.getAttribute("class")?.split(/\s+/) ?? []
      const unconditionalAnimations = classes.filter(
        (className) =>
          className.includes("animate-") &&
          !className.includes("animate-none") &&
          !className.includes("motion-safe:")
      )
      if (unconditionalAnimations.length > 0) {
        expect(element).toHaveClass("motion-reduce:animate-none")
      }
    }

    const transitioningElements = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="transition"]')
    ).filter((element) =>
      (element.getAttribute("class") ?? "")
        .split(/\s+/)
        .some((className) => className.startsWith("transition"))
    )
    expect(transitioningElements.length).toBeGreaterThan(0)
    for (const element of transitioningElements) {
      expect(element).toHaveClass("motion-reduce:transition-none")
    }

    const pressableElements = container.querySelectorAll<HTMLElement>(
      '[class*="active:scale"]'
    )
    expect(pressableElements.length).toBeGreaterThan(0)
    for (const element of pressableElements) {
      expect(element).toHaveClass("motion-reduce:active:scale-100")
    }
  })
})

describe("image zoom accessibility", () => {
  it("uses a native button and managed dialog with localized focus restoration", async () => {
    const user = userEvent.setup()
    render(
      <ToolUiLocaleProvider locale="he">
        <ImageZoom src="data:image/png;base64,AA==" alt="Provider alt text">
          <span>Provider image</span>
        </ImageZoom>
      </ToolUiLocaleProvider>
    )

    const trigger = screen.getByRole("button", { name: "הגדלת התמונה" })
    expect(trigger.tagName).toBe("BUTTON")
    trigger.focus()
    await user.keyboard(" ")

    const dialog = await screen.findByRole("dialog", {
      name: "תצוגת תמונה מוגדלת",
    })
    expect(dialog).toBeVisible()
    expect(screen.getByAltText("Provider alt text")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "סגירת התמונה" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
