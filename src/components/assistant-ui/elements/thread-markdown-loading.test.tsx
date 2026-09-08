import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

beforeEach(() => vi.resetModules())
afterEach(() => {
  cleanup()
  vi.doUnmock("./markdown-text")
  vi.unstubAllGlobals()
})

async function loadThread() {
  const imported = import("./thread.aui")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const importedThread = await Promise.race([
      imported,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1500)
      }),
    ])
    // An optional Markdown download must not prevent the thread from mounting.
    expect(importedThread).not.toBeNull()
    return importedThread!
  } finally {
    clearTimeout(timer)
  }
}

async function renderThread(
  Thread: typeof import("./thread.aui").Thread,
  locale: "en" | "he"
) {
  const {
    AssistantRuntimeProvider,
    useLocalRuntime,
    ExportedMessageRepository,
  } = await import("@assistant-ui/react")
  const { ToolUiLocaleProvider } = await import("@/components/tool-ui/locale")
  let runtime!: ReturnType<typeof useLocalRuntime>
  const messages = (text: string) => [
    { id: "assistant", role: "assistant" as const, content: text },
  ]
  function Scope() {
    runtime = useLocalRuntime(
      { run: async () => ({ content: [] }) },
      { initialMessages: messages("First paragraph.\n\nSecond paragraph.") }
    )
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ToolUiLocaleProvider locale={locale}>
          <Thread autoFocus={false} />
        </ToolUiLocaleProvider>
      </AssistantRuntimeProvider>
    )
  }
  const view = render(<Scope />)
  return {
    ...view,
    update: (text: string) =>
      act(() =>
        runtime.thread.import(
          ExportedMessageRepository.fromArray(messages(text))
        )
      ),
  }
}

describe("optional Markdown display", () => {
  it("never rewinds already-visible normal-motion streaming text across a delayed Markdown handoff", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    let release!: () => void
    const download = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.doMock("./markdown-text", async (importOriginal) => {
      await download
      return importOriginal()
    })
    const { MessageText } = await import("./message-text")
    const {
      AssistantRuntimeProvider,
      TextMessagePartProvider,
      useLocalRuntime,
    } = await import("@assistant-ui/react")
    function StreamingPart({ text }: { text: string }) {
      const runtime = useLocalRuntime({ run: async () => ({ content: [] }) })
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <TextMessagePartProvider text={text} isRunning>
            <MessageText />
          </TextMessagePartProvider>
        </AssistantRuntimeProvider>
      )
    }
    const original = "Already visible evidence remains available. "
      .repeat(16)
      .trim()
    const view = render(<StreamingPart text={original} />)
    // Suspense may retain hidden old DOM. Only count what the user can see.
    const visibleText = () =>
      Array.from(view.container.querySelectorAll("p, pre"))
        .filter((node) => {
          if (node.getAttribute("role")) return false
          for (
            let current: Element | null = node;
            current;
            current = current.parentElement
          ) {
            if (getComputedStyle(current).display === "none") return false
          }
          return true
        })
        .map((node) => node.textContent)
        .join("")
    await waitFor(() => expect(visibleText()).toBe(original), { timeout: 3000 })
    const snapshots: string[] = []
    const observer = new MutationObserver(() => snapshots.push(visibleText()))
    observer.observe(view.container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
    try {
      view.rerender(<StreamingPart text={`${original} **Confirmed**`} />)
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading formatted text…"
      )
      snapshots.push(visibleText())
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      snapshots.push(visibleText())
      await act(async () => {
        release()
        await import("./markdown-text")
      })
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
      snapshots.push(visibleText())
      await waitFor(() =>
        expect(view.container.querySelector("strong")).toHaveTextContent(
          "Confirmed"
        )
      )
      view.rerender(
        <StreamingPart text={`${original} **Confirmed** More evidence.`} />
      )
      await waitFor(() =>
        expect(visibleText()).toContain("Confirmed More evidence.")
      )
      snapshots.push(visibleText())
      expect(snapshots.length).toBeGreaterThan(3)
      let previous = original
      for (const snapshot of snapshots) {
        // Formatting removes source delimiters; the readable text must only grow.
        const text = snapshot.replaceAll("**", "")
        expect(text.slice(0, previous.length)).toBe(previous)
        previous = text
      }
      expect(view.container.querySelector(".aui-md")).toHaveAttribute(
        "data-status",
        "running"
      )
    } finally {
      observer.disconnect()
      await act(async () => {
        release()
        await import("./markdown-text")
      })
    }
  })

  it("keeps plain paragraphs available during a slow download and activates full Markdown when syntax arrives", async () => {
    let release!: () => void
    const download = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.doMock("./markdown-text", async (importOriginal) => {
      await download
      return importOriginal()
    })
    try {
      const { Thread } = await loadThread()
      const view = await renderThread(Thread, "en")
      expect(screen.getByText("First paragraph.").tagName).toBe("P")
      expect(screen.getByText("Second paragraph.").tagName).toBe("P")
      const markdown =
        "First paragraph.\n\n## Findings\n\n**Confirmed** with [source](https://example.com)."
      await view.update(markdown)
      expect(screen.getByText("Loading formatted text…")).toHaveAttribute(
        "role",
        "status"
      )
      expect(view.container).toHaveTextContent("**Confirmed**")
      await act(async () => {
        release()
        await import("./markdown-text")
      })
      expect(
        await screen.findByRole("heading", { level: 2, name: "Findings" })
      ).toBeVisible()
      expect(screen.getByText("Confirmed").tagName).toBe("STRONG")
      expect(screen.getByRole("link", { name: "source" })).toHaveAttribute(
        "href",
        "https://example.com"
      )
      await waitFor(() =>
        expect(screen.queryByText("Loading formatted text…")).toBeNull()
      )
    } finally {
      await act(async () => {
        release()
        await import("./markdown-text")
      })
    }
  })

  it.each([
    ["en", "ltr", "## פלט הספק"],
    ["he", "rtl", "## Provider output"],
  ] as const)(
    "keeps opposite-language source direction automatic during %s Markdown loading",
    async (locale, direction, source) => {
      let release!: () => void
      const download = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.doMock("./markdown-text", async (importOriginal) => {
        await download
        return importOriginal()
      })
      try {
        const { Thread } = await loadThread()
        const view = await renderThread(Thread, locale)
        await view.update(source)
        const status = screen.getByText(
          locale === "he" ? "הטקסט המעוצב נטען…" : "Loading formatted text…"
        )
        expect(status).toHaveAttribute("role", "status")
        expect(status.parentElement).toHaveAttribute("dir", direction)
        expect(view.container.querySelector("pre")).toHaveTextContent(source)
        expect(view.container.querySelector("pre")).toHaveAttribute(
          "dir",
          "auto"
        )
      } finally {
        await act(async () => {
          release()
          await import("./markdown-text")
        })
        await screen.findByRole("heading", { name: source.slice(3) })
      }
    }
  )

  it.each([
    [
      "en",
      "ltr",
      "Formatted text unavailable. The source remains available.",
      "## פלט הספק",
    ],
    [
      "he",
      "rtl",
      "הטקסט המעוצב אינו זמין. המקור עדיין זמין.",
      "## Provider output",
    ],
  ] as const)(
    "keeps %s source text inspectable when the Markdown download fails",
    async (locale, direction, label, source) => {
      vi.doMock("./markdown-text", () => {
        throw new Error("Markdown display unavailable")
      })
      const imported = import("./thread.aui")
      await expect(imported).resolves.toHaveProperty("Thread")
      const { Thread } = await imported
      const view = await renderThread(Thread, locale)
      expect(screen.getByText("First paragraph.")).toBeVisible()
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {})
      try {
        await view.update(
          `${source}\n\n\`\`\`js\nalert('never execute')\n\`\`\``
        )
        expect(await screen.findByRole("alert")).toHaveTextContent(label)
        expect(screen.getByRole("alert").parentElement).toHaveAttribute(
          "dir",
          direction
        )
        expect(view.container.querySelector("pre")).toHaveTextContent(source)
        expect(view.container.querySelector("pre")).toHaveAttribute(
          "dir",
          "auto"
        )
        expect(view.container).toHaveTextContent("alert('never execute')")
        expect(
          screen.getByRole("textbox", { name: "Message input" })
        ).toBeVisible()
      } finally {
        consoleError.mockRestore()
      }
    }
  )
})
