import {
  AssistantRuntimeProvider,
  TextMessagePartProvider,
  useLocalRuntime,
} from "@assistant-ui/react"
import { cleanup, render, screen } from "@testing-library/react"
import { ThemeProvider } from "next-themes"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ToolUiLocaleProvider } from "@/components/tool-ui"

import { MarkdownText } from "./markdown-text"

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

vi.mock("mermaid", () => ({
  default: mermaid,
}))

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })),
})

function RuntimeScope({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({
    run: async () => ({ content: [] }),
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  )
}

function TestMarkdown({ text }: { text: string }) {
  return (
    <RuntimeScope>
      <ThemeProvider forcedTheme="light" attribute="class">
        <ToolUiLocaleProvider locale="en">
          <TextMessagePartProvider text={text} isRunning={false}>
            <MarkdownText />
          </TextMessagePartProvider>
        </ToolUiLocaleProvider>
      </ThemeProvider>
    </RuntimeScope>
  )
}

beforeEach(() => {
  mermaid.initialize.mockReset()
  mermaid.render.mockReset()
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered flow</text></svg>',
  })
})

afterEach(cleanup)

describe("MarkdownText fenced diagrams", () => {
  it("routes Mermaid fences to the diagram renderer without duplicate code controls", async () => {
    render(<TestMarkdown text={"```mermaid\nflowchart LR\n  A --> B\n```"} />)

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" })
    ).toHaveTextContent("Rendered flow")
    expect(
      screen.getByRole("button", { name: "View diagram source" })
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull()
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull()
  })

  it("keeps the standard header and copy control for ordinary code fences", async () => {
    render(<TestMarkdown text={"```ts\nconst answer = 42\n```"} />)

    expect(await screen.findByText("const answer = 42")).toBeVisible()
    expect(screen.getByText("ts")).toBeVisible()
    expect(screen.getByRole("button", { name: "Copy code" })).toBeVisible()
    expect(mermaid.initialize).not.toHaveBeenCalled()
    expect(mermaid.render).not.toHaveBeenCalled()
  })
})

describe("MarkdownText links", () => {
  it("opens external links in a new tab and keeps in-app links in place", async () => {
    render(
      <TestMarkdown
        text={
          "[Docs](https://example.com/docs) [Session](/?agent=a) [Top](#top)"
        }
      />
    )

    const external = await screen.findByRole("link", { name: "Docs" })
    expect(external).toHaveAttribute("target", "_blank")
    expect(external.getAttribute("rel")).toContain("noopener")
    expect(screen.getByRole("link", { name: "Session" })).not.toHaveAttribute(
      "target"
    )
    expect(screen.getByRole("link", { name: "Top" })).not.toHaveAttribute(
      "target"
    )
  })
})
