import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  cleanup()
  vi.doUnmock("./markdown-text")
  vi.resetModules()
})

describe("assistant message Markdown", () => {
  it("loads the required renderer before mounting the thread instead of showing a message-level loading state", async () => {
    let release!: () => void
    const rendererReady = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.doMock("./markdown-text", async (importOriginal) => {
      await rendererReady
      return importOriginal()
    })

    const threadImport = import("./thread.aui")
    const importState = await Promise.race([
      threadImport.then(() => "ready" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 25)
      ),
    ])
    expect(importState).toBe("pending")

    release()
    const { Thread } = await threadImport
    const { AssistantRuntimeProvider, useLocalRuntime } = await import(
      "@assistant-ui/react"
    )
    const { ToolUiLocaleProvider } = await import("@/components/tool-ui/locale")

    function Scope() {
      const runtime = useLocalRuntime(
        { run: async () => ({ content: [] }) },
        {
          initialMessages: [
            {
              id: "assistant",
              role: "assistant",
              content: "## Findings\n\n**Confirmed**",
            },
          ],
        }
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ToolUiLocaleProvider locale="en">
            <Thread autoFocus={false} />
          </ToolUiLocaleProvider>
        </AssistantRuntimeProvider>
      )
    }

    await act(async () => render(<Scope />))
    expect(
      screen.getByRole("heading", { level: 2, name: "Findings" })
    ).toBeVisible()
    expect(screen.getByText("Confirmed").tagName).toBe("STRONG")
    expect(screen.queryByText("Loading formatted text…")).toBeNull()
  }, 10_000)
})
