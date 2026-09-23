import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RichToolPart } from "./types"

function toolPart(
  overrides: Partial<RichToolPart> & Pick<RichToolPart, "toolName">
): RichToolPart {
  return {
    type: "tool-call",
    toolCallId: "lazy-tool",
    args: {},
    argsText: "{}",
    status: { type: "complete" },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...overrides,
  }
}

const questionPart = toolPart({
  toolName: "ask_user_question",
  args: { question: "Which audience leads?", options: ["Investors"] },
  result: "Question answered",
})

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.doUnmock("./question-flow")
  vi.doUnmock("./permission")
})

describe("optional renderer loading", () => {
  // Break caught: importing any optional renderer during registry adaptation
  // makes a missing display chunk prevent every tool from being validated.
  it("validates optional payloads and renders first-load tools when every optional renderer is unavailable", async () => {
    const unavailable = () => {
      throw new Error("Optional display chunk unavailable")
    }
    vi.doMock("./question-flow", unavailable)
    vi.doMock("./permission", unavailable)

    const imported = import("./registry")
    await expect(imported).resolves.toHaveProperty("richToolRegistry")
    const { richToolRegistry, RichToolRenderer } = await imported
    for (const part of [
      questionPart,
      toolPart({
        toolName: "request_permission",
        args: { action: "Read" },
        approval: { id: "approval" },
      }),
    ]) {
      expect(richToolRegistry[part.toolName].validate(part).valid).toBe(true)
    }

    render(
      <>
        <RichToolRenderer
          {...toolPart({
            toolName: "delegate_subagent",
            args: { task: "Validate the market segments" },
          })}
        />
        <RichToolRenderer
          {...toolPart({
            toolName: "tool_activity",
            args: { name: "Provider activity" },
          })}
        />
        <RichToolRenderer
          {...toolPart({
            toolName: "unknown_tool",
            result: "Raw provider result",
          })}
        />
      </>
    )
    expect(screen.getByText("Validate the market segments")).toBeVisible()
    fireEvent.click(screen.getByText("tool_activity"))
    expect(screen.getByText(/Provider activity/)).toBeVisible()
    fireEvent.click(screen.getByText("unknown_tool"))
    expect(screen.getByText(/Raw provider result/)).toBeVisible()
  })

  // Break caught: removing the registry's Suspense or JSON fallback leaves a
  // slow optional download blank and conceals the provider's result.
  it.each([
    ["en", "Loading tool display…"],
    ["he", "תצוגת הכלי נטענת…"],
  ] as const)(
    "keeps the payload inspectable during a slow %s display download",
    async (locale, loadingLabel) => {
      let release!: () => void
      const download = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.doMock("./question-flow", async (importOriginal) => {
        await download
        return importOriginal()
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const imported = await Promise.race([
          import("./registry"),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 1000)
          }),
        ])
        expect(
          imported,
          "Registry must be usable before the display download finishes"
        ).not.toBeNull()
        const { ToolUiLocaleProvider } = await import("./locale")
        const RichToolRenderer = imported!.RichToolRenderer
        render(
          <ToolUiLocaleProvider locale={locale}>
            <RichToolRenderer {...questionPart} />
          </ToolUiLocaleProvider>
        )
        expect(screen.getByText(loadingLabel)).toHaveAttribute("role", "status")
        fireEvent.click(screen.getByText("ask_user_question"))
        expect(screen.getByText(/"options"/)).toBeVisible()
        expect(screen.getByText(/Question answered/)).toBeVisible()

        await act(async () => {
          release()
          await download
        })
        expect(await screen.findByText("Which audience leads?")).toBeVisible()
        expect(screen.queryByText(loadingLabel)).not.toBeInTheDocument()
      } finally {
        clearTimeout(timer)
        release()
      }
    }
  )

  // Break caught: an import rejection escapes the tool boundary and removes
  // the transcript instead of exposing localized failure and raw provider data.
  it.each([
    ["en", "Tool display unavailable. The raw payload remains available."],
    ["he", "תצוגת הכלי אינה זמינה. נתוני המקור עדיין זמינים."],
  ] as const)(
    "preserves inspectable provider data after a failed %s display download",
    async (locale, errorLabel) => {
      vi.doMock("./question-flow", () => {
        throw new Error("Display download failed")
      })
      const imported = import("./registry")
      await expect(imported).resolves.toHaveProperty("RichToolRenderer")
      const { RichToolRenderer } = await imported
      const { ToolUiLocaleProvider } = await import("./locale")
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        render(
          <ToolUiLocaleProvider locale={locale}>
            <p>Transcript remains</p>
            <RichToolRenderer {...questionPart} />
          </ToolUiLocaleProvider>
        )
        expect(await screen.findByRole("alert")).toHaveTextContent(errorLabel)
        expect(screen.getByText("Transcript remains")).toBeVisible()
        fireEvent.click(screen.getByText("ask_user_question"))
        expect(screen.getByText(/"options"/)).toBeVisible()
        expect(screen.getByText(/Question answered/)).toBeVisible()
      } finally {
        error.mockRestore()
      }
    }
  )
})
