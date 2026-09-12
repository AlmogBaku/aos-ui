import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ArtifactAdapter } from "@/runtime-adapters/contracts"

import {
  ArtifactDataUI,
  ArtifactOutputs,
  ArtifactToolResultCard,
  ArtifactViewerContent,
  ArtifactWorkspaceProvider,
  createArtifactMessageStabilizer,
  MAX_TEXT_PREVIEW_BYTES,
} from "./artifact-workspace"

const messages = [
  {
    id: "older-message",
    role: "assistant",
    content: [
      {
        type: "data",
        name: "aos.artifact",
        data: {
          id: "older",
          filename: "older.txt",
          mimeType: "text/plain",
          source: { type: "inline", encoding: "utf8", data: "Older body" },
        },
      },
    ],
  },
  {
    id: "newer-message",
    role: "assistant",
    content: [
      {
        type: "data",
        name: "aos.artifact",
        data: {
          id: "newer",
          filename: "newer.txt",
          mimeType: "text/plain",
          source: { type: "inline", encoding: "utf8", data: "Newer body" },
        },
      },
    ],
  },
] as const

const ArtifactTestSurface = () => (
  <>
    <ArtifactOutputs />
    <ArtifactViewerContent />
  </>
)

afterEach(() => {
  cleanup()
})

describe("artifact workspace", () => {
  it("registers the canonical assistant data-part name", () => {
    expect(ArtifactDataUI.unstable_data.name).toBe("aos.artifact")
  })

  it("stabilizes artifact input while ordinary message text streams", () => {
    const stabilize = createArtifactMessageStabilizer()
    const first = stabilize([
      {
        id: "streaming-message",
        role: "assistant",
        content: [{ type: "text", text: "First token" }],
      },
    ])
    const next = stabilize([
      {
        id: "streaming-message",
        role: "assistant",
        content: [{ type: "text", text: "First token, then another" }],
      },
    ])

    expect(next).toBe(first)
  })

  it("renders a validated present_artifact result as a message card", () => {
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: vi.fn<ArtifactAdapter["resolve"]>() }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={[]}
      >
        <ArtifactToolResultCard
          result={{
            id: "ag-ui-output",
            filename: "ag-ui-output.txt",
            source: { type: "inline", encoding: "utf8", data: "Output" },
          }}
        />
      </ArtifactWorkspaceProvider>
    )

    expect(screen.getByText("ag-ui-output.txt")).toBeInTheDocument()
  })

  it("renders Artifacts collapsed by default and reveals them on request", () => {
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: vi.fn<ArtifactAdapter["resolve"]>() }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactOutputs />
      </ArtifactWorkspaceProvider>
    )

    const summary = screen.getByText("Artifacts").closest("summary")
    const disclosure = summary?.closest("details")

    expect(summary).not.toBeNull()
    expect(disclosure).not.toHaveAttribute("open")
    expect(screen.getByText("newer.txt")).not.toBeVisible()

    fireEvent.click(summary!)

    expect(disclosure).toHaveAttribute("open")
    expect(screen.getByText("newer.txt")).toBeVisible()
  })

  it("lists Artifacts newest first and opens a resolved text preview", async () => {
    const resolve = vi.fn<ArtifactAdapter["resolve"]>(async ({ artifact }) =>
      Promise.resolve(
        new Blob([
          artifact.source.type === "inline" ? artifact.source.data : "",
        ])
      )
    )

    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByText("Artifacts"))

    expect(
      screen
        .getAllByText(/\.txt$/)
        .map(({ textContent }) => textContent)
    ).toEqual(["newer.txt", "older.txt"])

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!)

    expect(await screen.findByText("Newer body")).toBeInTheDocument()
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ id: "newer" }),
        agentId: "agent-aster",
        threadId: "thread-aster-market",
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("renders Markdown structure without loading embedded images", async () => {
    const markdownMessages = [
      {
        id: "markdown-message",
        role: "assistant",
        content: [
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "markdown",
              filename: "report.md",
              mimeType: "text/markdown",
              source: {
                type: "inline",
                encoding: "utf8",
                data: "# Report\n\n```ts\nconst report = true\n```\n\n![tracking pixel](https://example.com/pixel.png)",
              },
            },
          },
        ],
      },
    ]
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{
          resolve: async () =>
            new Blob([markdownMessages[0]!.content[0]!.data.source.data]),
        }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={markdownMessages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))

    expect(await screen.findByRole("heading", { name: "Report" })).toBeVisible()
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(screen.getByText("[tracking pixel]")).toBeVisible()
    expect(
      document.querySelector('[data-syntax-language="typescript"]')
    ).toBeInTheDocument()
  })

  it("copies the source of a text-based Artifact", async () => {
    const user = userEvent.setup()
    const source = "# Report\n\n```mermaid\ngraph TD\n  A --> B\n```"
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue()
    const markdownMessages = [
      {
        id: "markdown-message",
        role: "assistant",
        content: [
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "markdown",
              filename: "report.md",
              mimeType: "text/markdown",
              source: { type: "inline", encoding: "utf8", data: source },
            },
          },
        ],
      },
    ]

    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob([source]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={markdownMessages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    await user.click(await screen.findByRole("button", { name: "Copy" }))

    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(source))
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible()
  })

  it("highlights standalone code artifacts using their filename", async () => {
    const codeMessages = [
      {
        id: "code-message",
        role: "assistant",
        content: [
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "code",
              filename: "worker.py",
              mimeType: "text/x-python",
              source: {
                type: "inline",
                encoding: "utf8",
                data: "def run():\n    return True",
              },
            },
          },
        ],
      },
    ]
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{
          resolve: async () => new Blob(["def run():\n    return True"]),
        }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={codeMessages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))

    await waitFor(() =>
      expect(
        document.querySelector('[data-syntax-language="python"]')
      ).toBeInTheDocument()
    )
  })

  it("aborts and closes an obsolete preview when the Session changes", async () => {
    const signals: AbortSignal[] = []
    const resolve = vi.fn<ArtifactAdapter["resolve"]>(({ signal }) => {
      signals.push(signal)
      return new Promise(() => {})
    })

    const { rerender } = render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!)
    await waitFor(() => expect(signals).toHaveLength(1))
    rerender(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-pricing"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Output preview" })
      ).not.toBeInTheDocument()
    )
    expect(signals[0]?.aborted).toBe(true)
    expect(signals).toHaveLength(1)
  })

  it("closes the viewer when the active branch no longer contains its publication", async () => {
    const resolve = vi.fn<ArtifactAdapter["resolve"]>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason))
        })
    )
    const { rerender } = render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!)
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    rerender(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages.slice(0, 1)}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Output preview" })
      ).not.toBeInTheDocument()
    )
  })

  it("restores focus to the control that opened the viewer", async () => {
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob(["Older body"]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages.slice(0, 1)}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )
    const open = screen.getByRole("button", { name: "Open" })
    open.focus()
    fireEvent.click(open)
    fireEvent.click(
      await screen.findByRole("button", { name: "Close preview" })
    )

    await waitFor(() => expect(open).toHaveFocus())
  })

  it("aborts an active download when the Session changes", async () => {
    const signals: AbortSignal[] = []
    const resolve = vi.fn<ArtifactAdapter["resolve"]>(({ signal }) => {
      signals.push(signal)
      return new Promise(() => {})
    })
    const { rerender } = render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getAllByRole("button", { name: "Download" })[0]!)
    await waitFor(() => expect(signals).toHaveLength(1))
    rerender(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-pricing"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    expect(signals[0]?.aborted).toBe(true)
  })

  it("offers a retry after a preview load failure", async () => {
    const resolve = vi
      .fn<ArtifactAdapter["resolve"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Blob(["Recovered body"]))

    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!)
    expect(
      await screen.findByText("This output could not be loaded.")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(await screen.findByText("Recovered body")).toBeInTheDocument()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it("blocks oversized text before asking the adapter to resolve it", async () => {
    const resolve = vi.fn<ArtifactAdapter["resolve"]>()
    const oversizedMessages = [
      {
        id: "large-message",
        role: "assistant",
        content: [
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "large",
              filename: "large.txt",
              mimeType: "text/plain",
              sizeBytes: MAX_TEXT_PREVIEW_BYTES + 1,
              source: { type: "provider", reference: "large-file" },
            },
          },
        ],
      },
    ]

    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={oversizedMessages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(
      await screen.findByText("This text file is too large to preview.")
    ).toBeInTheDocument()
    expect(resolve).not.toHaveBeenCalled()
  })

  it("renders PDF content in the browser preview and revokes its URL", async () => {
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:pdf-preview")
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined)
    const pdfMessages = [
      {
        id: "pdf-message",
        role: "assistant",
        content: [
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "pdf",
              filename: "report.pdf",
              mimeType: "application/pdf",
              source: { type: "provider", reference: "report" },
            },
          },
        ],
      },
    ]
    const { unmount } = render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob(["%PDF-1.7"]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={pdfMessages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))

    expect(await screen.findByTitle("PDF preview")).toHaveAttribute(
      "src",
      "blob:pdf-preview#toolbar=1&view=FitH&page=1"
    )
    expect(createObjectUrl).toHaveBeenCalledOnce()
    unmount()
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:pdf-preview")
  })

  it("opens HTML on a sandboxed Preview tab and keeps source inspectable", async () => {
    const htmlMessages = [
      {
        id: "html-message",
        role: "assistant",
        content: [
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "html",
              filename: "report.html",
              mimeType: "text/html",
              source: {
                type: "inline",
                encoding: "utf8",
                data: "<h1>Report</h1>",
              },
            },
          },
        ],
      },
    ]
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob(["<h1>Report</h1>"]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={htmlMessages}
        artifactHtmlAssetOrigins={["https://assets.example/path"]}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    const previewTab = await screen.findByRole("tab", { name: "Preview" })
    expect(previewTab).toHaveAttribute("aria-selected", "true")
    const frame = screen.getByTitle("HTML preview")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame.getAttribute("srcdoc")).toContain(
      "connect-src https://assets.example"
    )

    fireEvent.click(screen.getByRole("tab", { name: "Source" }))
    expect(screen.getByText("<h1>Report</h1>")).toBeInTheDocument()
    expect(screen.queryByTitle("HTML preview")).not.toBeInTheDocument()
  })

  it("renders localized RTL Artifacts controls", () => {
    const resolve = vi.fn<ArtifactAdapter["resolve"]>()
    render(
      <ArtifactWorkspaceProvider
        locale="he"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    const summary = screen.getByText("ארטיפקטים").closest("summary")
    expect(summary?.closest("details")).toHaveAttribute("dir", "rtl")

    fireEvent.click(summary!)

    expect(screen.getAllByRole("button", { name: "פתיחה" })).toHaveLength(2)
  })

  it("opens an accessible unavailable state when the runtime has no resolver", async () => {
    render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={undefined}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages.slice(0, 1)}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open" }))

    expect(
      await screen.findByText("This runtime cannot open this output.")
    ).toBeVisible()
    expect(
      screen.getAllByRole("button", { name: "Download" })[0]
    ).toBeDisabled()
  })
})
