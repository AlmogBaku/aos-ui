import {
  AssistantRuntimeProvider,
  TextMessagePartProvider,
  useLocalRuntime,
} from "@assistant-ui/react"
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ThemeProvider } from "next-themes"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ToolUiLocaleProvider, type ToolUiLocale } from "@/components/tool-ui"

import { MERMAID_MAX_SOURCE_CHARS, MermaidDiagram } from "./mermaid-diagram"

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  bindFunctions: vi.fn(),
}))

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaid.initialize,
    render: mermaid.render,
  },
}))

const CODE = "flowchart LR\n  A[Request] --> B[Response]"

const components: SyntaxHighlighterProps["components"] = {
  Pre: ({ node, ...props }) => {
    void node
    return <pre {...props} />
  },
  Code: ({ node, ...props }) => {
    void node
    return <code {...props} />
  },
}

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

function TestDiagram({
  code = CODE,
  isRunning = false,
  locale = "en",
  theme = "light",
}: {
  code?: string
  isRunning?: boolean
  locale?: ToolUiLocale
  theme?: "light" | "dark"
}) {
  return (
    <RuntimeScope>
      <ThemeProvider forcedTheme={theme} attribute="class">
        <ToolUiLocaleProvider locale={locale}>
          <TextMessagePartProvider
            text={`\`\`\`mermaid\n${code}\n\`\`\``}
            isRunning={isRunning}
          >
            <MermaidDiagram
              code={code}
              components={components}
              language="mermaid"
            />
          </TextMessagePartProvider>
        </ToolUiLocaleProvider>
      </ThemeProvider>
    </RuntimeScope>
  )
}

beforeEach(() => {
  mermaid.initialize.mockReset()
  mermaid.render.mockReset()
  mermaid.bindFunctions.mockReset()
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered flow</text></svg>',
    bindFunctions: mermaid.bindFunctions,
  })
})

afterEach(cleanup)

describe("MermaidDiagram", () => {
  it("keeps escaped, copyable source visible and does no Mermaid work while streaming", async () => {
    const user = userEvent.setup()
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue()

    render(<TestDiagram isRunning />)

    expect(screen.getByRole("status")).toHaveTextContent("Rendering diagram")
    expect(screen.getByText(/A\[Request\] --> B\[Response\]/)).toBeVisible()
    await user.click(
      screen.getByRole("button", { name: "Copy diagram source" })
    )
    expect(clipboard).toHaveBeenCalledWith(CODE)
    expect(mermaid.initialize).not.toHaveBeenCalled()
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it("renders a strict, sanitized, accessible diagram after completion", async () => {
    mermaid.render.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" onload="steal()">
        <image href="https://bad.example/pixel.png" />
        <text>Safe label</text>
      </svg>`,
      bindFunctions: mermaid.bindFunctions,
    })

    render(<TestDiagram />)

    const viewport = await screen.findByRole("img", {
      name: "Mermaid diagram",
    })
    expect(viewport).toHaveTextContent("Safe label")
    expect(viewport.innerHTML).not.toMatch(/bad\.example|onload|<image/i)
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
      })
    )
    expect(mermaid.bindFunctions).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "View diagram source" })
    ).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("A[Request] --> B[Response]")).toBeNull()
  })

  it("shows localized source and a visible fallback when rendering fails", async () => {
    mermaid.render.mockRejectedValue(new Error("Invalid diagram"))

    render(<TestDiagram locale="he" />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "לא ניתן להציג את התרשים"
    )
    expect(screen.getByText(/A\[Request\] --> B\[Response\]/)).toBeVisible()
    expect(
      screen.getByRole("button", { name: "העתקת מקור התרשים" })
    ).toBeVisible()
    expect(
      screen.getByText(/A\[Request\] --> B\[Response\]/).closest("pre")
    ).toHaveAttribute("dir", "ltr")
  })

  it("rejects oversized source without importing or rendering Mermaid", async () => {
    render(
      <TestDiagram
        code={`flowchart LR\n${"A-->B\n".repeat(MERMAID_MAX_SOURCE_CHARS)}`}
      />
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diagram source is too large"
    )
    expect(mermaid.initialize).not.toHaveBeenCalled()
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it("rejects a 401-line source below the character limit without rendering Mermaid", async () => {
    const code = Array.from({ length: 401 }, (_, index) => `A${index}`).join(
      "\n"
    )

    expect(code.length).toBeLessThan(MERMAID_MAX_SOURCE_CHARS)
    render(<TestDiagram code={code} />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diagram source is too large"
    )
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE" && element.textContent === code
      )
    ).toBeVisible()
    expect(mermaid.initialize).not.toHaveBeenCalled()
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it("serializes initialization with rendering so themes cannot cross-contaminate", async () => {
    let finishFirst: ((value: { svg: string }) => void) | undefined
    mermaid.render
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishFirst = resolve
          })
      )
      .mockResolvedValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Dark</text></svg>',
      })

    render(
      <>
        <TestDiagram theme="light" />
        <TestDiagram theme="dark" code="flowchart LR\n  C --> D" />
      </>
    )

    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalledTimes(1))
    expect(mermaid.initialize.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ theme: "default" })
    )

    await act(async () => {
      finishFirst?.({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Light</text></svg>',
      })
    })

    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalledTimes(2))
    expect(mermaid.initialize.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ theme: "dark" })
    )
  })

  it("discards a stale render when the streamed source changes", async () => {
    let finishOld: ((value: { svg: string }) => void) | undefined
    mermaid.render
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishOld = resolve
          })
      )
      .mockResolvedValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Current</text></svg>',
      })

    const view = render(<TestDiagram code="flowchart LR\n  Old --> Value" />)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))

    view.rerender(<TestDiagram code="flowchart LR\n  Current --> Value" />)
    await act(async () => {
      finishOld?.({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Stale</text></svg>',
      })
    })

    const viewport = await screen.findByRole("img", {
      name: "Mermaid diagram",
    })
    expect(viewport).toHaveTextContent("Current")
    expect(viewport).not.toHaveTextContent("Stale")
  })
})
