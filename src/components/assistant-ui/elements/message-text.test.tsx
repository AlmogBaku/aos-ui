import {
  AssistantRuntimeProvider,
  TextMessagePartProvider,
  useLocalRuntime,
} from "@assistant-ui/react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MessageText } from "./message-text"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function TextPart({
  text,
  running = false,
}: {
  text: string
  running?: boolean
}) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [] }) })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TextMessagePartProvider text={text} isRunning={running}>
        <MessageText />
      </TextMessagePartProvider>
    </AssistantRuntimeProvider>
  )
}

describe("message text display selection", () => {
  it("preserves native streaming status and reduced-motion text updates when plain text becomes Markdown", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    const view = render(<TextPart text="Collecting evidence." running />)
    expect(screen.getByText("Collecting evidence.")).toBeVisible()
    expect(view.container.querySelector(".aui-md")).toHaveAttribute(
      "data-status",
      "running"
    )

    view.rerender(<TextPart text="Collecting **evidence**." running />)
    // This assertion crosses the real lazy Markdown import. Allow cold module
    // loading under the full suite, while still waiting for the actual output.
    expect(
      (await screen.findByText("evidence", {}, { timeout: 4000 })).tagName
    ).toBe("STRONG")
    expect(view.container.querySelector(".aui-md")).toHaveAttribute(
      "data-status",
      "running"
    )

    view.rerender(<TextPart text="Evidence confirmed." />)
    expect(await screen.findByText("Evidence confirmed.")).toBeVisible()
    await waitFor(() =>
      expect(view.container.querySelector(".aui-md")).toHaveAttribute(
        "data-status",
        "complete"
      )
    )
  })

  it.each([
    ["1. First item", "ol"],
    ["    const answer = 42", "pre code"],
    ["First line  \nSecond line", "br"],
    ["Heading\n===", "h1"],
    ["www.example.com", "a"],
    ["name@example.com", "a"],
    ["| Name | Value |\n| --- | --- |\n| Sessions | 42 |", "table"],
    ["- [x] Complete", "input[type=checkbox]"],
    ["Escaped \\*asterisk\\*", "p"],
  ])("keeps the complete Markdown semantics for %s", async (text, selector) => {
    const view = render(<TextPart text={text} />)
    await waitFor(() =>
      expect(view.container.querySelector(selector)).toBeInTheDocument()
    )
    expect(screen.queryByText("Loading formatted text…")).toBeNull()
  })
})
