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

const statsPart = toolPart({
  toolName: "render_stats",
  args: {
    title: "Provider metrics",
    stats: [{ key: "sessions", label: "Sessions", value: 42 }],
  },
  result: "Metrics ready",
})

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.doUnmock("./question-flow")
  vi.doUnmock("./permission")
  vi.doUnmock("./monty")
  vi.doUnmock("./chart")
  vi.doUnmock("./map")
  vi.doUnmock("./stats")
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
    vi.doMock("./monty", unavailable)
    vi.doMock("./chart", unavailable)
    vi.doMock("./map", unavailable)
    vi.doMock("./stats", unavailable)

    const imported = import("./registry")
    await expect(imported).resolves.toHaveProperty("richToolRegistry")
    const { richToolRegistry, RichToolRenderer } = await imported
    for (const part of [
      toolPart({
        toolName: "ask_user_question",
        args: { question: "Choose", options: ["One"] },
      }),
      toolPart({
        toolName: "request_permission",
        args: { action: "Read" },
        approval: { id: "approval" },
      }),
      toolPart({ toolName: "monty_execute", args: { code: "print(42)" } }),
      toolPart({ toolName: "render_chart", args: { title: "Chart" } }),
      toolPart({ toolName: "render_map", args: { title: "Map" } }),
      statsPart,
    ]) {
      expect(richToolRegistry[part.toolName].validate(part).valid).toBe(true)
    }

    render(
      <>
        <RichToolRenderer
          {...toolPart({
            toolName: "present_plan",
            args: {
              id: "plan",
              title: "Plan",
              steps: [{ id: "first", label: "First step", status: "pending" }],
            },
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
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("Provider activity")).toBeInTheDocument()
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
      vi.doMock("./stats", async (importOriginal) => {
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
            <RichToolRenderer {...statsPart} />
          </ToolUiLocaleProvider>
        )
        expect(screen.getByText(loadingLabel)).toHaveAttribute("role", "status")
        fireEvent.click(screen.getByText("render_stats"))
        expect(screen.getByText(/"value": 42/)).toBeVisible()
        expect(screen.getByText(/Metrics ready/)).toBeVisible()

        await act(async () => {
          release()
          await download
        })
        expect(await screen.findByText("Sessions")).toBeVisible()
        expect(screen.getByText("42")).toBeVisible()
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
      vi.doMock("./stats", () => {
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
            <RichToolRenderer {...statsPart} />
          </ToolUiLocaleProvider>
        )
        expect(await screen.findByRole("alert")).toHaveTextContent(errorLabel)
        expect(screen.getByText("Transcript remains")).toBeVisible()
        fireEvent.click(screen.getByText("render_stats"))
        expect(screen.getByText(/"value": 42/)).toBeVisible()
        expect(screen.getByText(/Metrics ready/)).toBeVisible()
      } finally {
        error.mockRestore()
      }
    }
  )
})
