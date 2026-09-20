import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"
import type { ArtifactMessage } from "@/artifacts/artifacts"
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

const noOpAdapter: ChatModelAdapter = {
  async *run() {},
}

const duplicateArtifactMessages = [
  {
    id: "first-publication",
    role: "assistant",
    content: [messages[1].content[0]],
  },
  {
    id: "second-publication",
    role: "assistant",
    content: [messages[1].content[0]],
  },
] satisfies ThreadMessageLike[]

const ArtifactMessageParts = () => <MessagePrimitive.Parts />

function InlineArtifactTestSurface({
  providerMessages,
}: {
  providerMessages: readonly ArtifactMessage[]
}) {
  const runtime = useLocalRuntime(noOpAdapter, {
    initialMessages: duplicateArtifactMessages,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob(["Newer body"]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={providerMessages}
      >
        <ArtifactDataUI />
        <ThreadPrimitive.Messages
          components={{ Message: ArtifactMessageParts }}
        />
        <ArtifactViewerContent />
      </ArtifactWorkspaceProvider>
    </AssistantRuntimeProvider>
  )
}

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
    expect(
      screen.getByRole("button", { name: "Open: ag-ui-output.txt" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /^Open$/ })
    ).not.toBeInTheDocument()
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
      screen.getAllByText(/\.txt$/).map(({ textContent }) => textContent)
    ).toEqual(["newer.txt", "older.txt"])

    fireEvent.click(screen.getAllByRole("button", { name: /^Open:/ })[0]!)

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

    fireEvent.click(screen.getByRole("button", { name: /^Open:/ }))

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

    await user.click(screen.getByRole("button", { name: /^Open:/ }))
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

    fireEvent.click(screen.getByRole("button", { name: /^Open:/ }))

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

    fireEvent.click(screen.getAllByRole("button", { name: /^Open:/ })[0]!)
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

  it("keeps the viewer open when the conversation continues after its publication", async () => {
    const resolve = vi.fn<ArtifactAdapter["resolve"]>(async () =>
      Promise.resolve(new Blob(["Newer body"]))
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

    fireEvent.click(screen.getAllByRole("button", { name: /^Open:/ })[0]!)
    expect(
      await screen.findByRole("region", { name: "Output preview" })
    ).toBeVisible()

    rerender(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={[
          ...messages,
          {
            id: "follow-up",
            role: "user",
            content: [{ type: "text", text: "Continue" }],
          },
          {
            id: "completion",
            role: "assistant",
            content: [{ type: "text", text: "Completed" }],
          },
        ]}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    expect(screen.getByRole("region", { name: "Output preview" })).toBeVisible()
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

    fireEvent.click(screen.getAllByRole("button", { name: /^Open:/ })[0]!)
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

  it("closes the viewer when an identical artifact replaces its publication on another branch", async () => {
    const { rerender } = render(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob(["Newer body"]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={messages}
      >
        <ArtifactTestSurface />
      </ArtifactWorkspaceProvider>
    )

    fireEvent.click(screen.getAllByRole("button", { name: /^Open:/ })[0]!)
    expect(
      await screen.findByRole("region", { name: "Output preview" })
    ).toBeVisible()

    rerender(
      <ArtifactWorkspaceProvider
        locale="en"
        adapter={{ resolve: async () => new Blob(["Newer body"]) }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={[
          messages[0],
          { ...messages[1], id: "replacement-publication" },
        ]}
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

  it("tracks the publication opened from an inline artifact card", async () => {
    const { rerender } = render(
      <InlineArtifactTestSurface providerMessages={duplicateArtifactMessages} />
    )

    const openButtons = await screen.findAllByRole("button", {
      name: "Open: newer.txt",
    })
    fireEvent.click(openButtons[0]!)
    expect(
      await screen.findByRole("region", { name: "Output preview" })
    ).toBeVisible()

    rerender(
      <InlineArtifactTestSurface
        providerMessages={duplicateArtifactMessages.slice(1)}
      />
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
    const open = screen.getByRole("button", { name: /^Open:/ })
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

    fireEvent.click(screen.getAllByRole("button", { name: /^Open:/ })[0]!)
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

    fireEvent.click(screen.getByRole("button", { name: /^Open:/ }))
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

    fireEvent.click(screen.getByRole("button", { name: /^Open:/ }))

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

    fireEvent.click(screen.getByRole("button", { name: /^Open:/ }))
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

    expect(screen.getAllByRole("button", { name: /^פתיחה:/ })).toHaveLength(2)
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

    fireEvent.click(screen.getByRole("button", { name: /^Open:/ }))

    expect(
      await screen.findByText("This runtime cannot open this output.")
    ).toBeVisible()
    expect(
      screen.getAllByRole("button", { name: "Download" })[0]
    ).toBeDisabled()
  })

  const audioArtifact = {
    id: "voice-note",
    filename: "intro.mp3",
    mimeType: "audio/mpeg",
    source: { type: "provider", reference: "voice-note" },
  }
  const videoArtifact = {
    id: "walkthrough",
    filename: "walkthrough.mp4",
    mimeType: "video/mp4",
    source: { type: "provider", reference: "walkthrough" },
  }
  const imageArtifact = {
    id: "diagram",
    filename: "diagram.png",
    mimeType: "image/png",
    source: { type: "provider", reference: "diagram" },
  }

  /** One published artifact on the conversation surface that carries it. */
  const renderPublishedArtifact = ({
    artifact,
    resolve,
    locale = "en",
    messageId = "media-message",
  }: {
    artifact: unknown
    resolve: ArtifactAdapter["resolve"]
    locale?: "en" | "he"
    messageId?: string
  }) =>
    render(
      <ArtifactWorkspaceProvider
        locale={locale}
        adapter={{ resolve }}
        agentId="agent-aster"
        threadId="thread-aster-market"
        messages={[
          {
            id: messageId,
            role: "assistant",
            content: [{ type: "data", name: "aos.artifact", data: artifact }],
          },
        ]}
      >
        <ArtifactToolResultCard
          result={artifact}
          occurrenceKey={`${messageId}:0`}
        />
        <ArtifactViewerContent />
      </ArtifactWorkspaceProvider>
    )

  it("plays a published audio artifact inline instead of opening the viewer", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio-artifact")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    renderPublishedArtifact({
      artifact: audioArtifact,
      resolve: async () => new Blob(["ID3"], { type: "audio/mpeg" }),
    })

    const player = await screen.findByLabelText("Audio output: intro.mp3")
    expect(player).toBeInstanceOf(HTMLAudioElement)
    expect(player).toHaveAttribute("src", "blob:audio-artifact")
    expect(player).toHaveAttribute("controls")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible()
    expect(
      screen.queryByRole("button", { name: /^Open/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("region", { name: "Output preview" })
    ).not.toBeInTheDocument()
  })

  it("plays a published video artifact inline", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video-artifact")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    renderPublishedArtifact({
      artifact: videoArtifact,
      resolve: async () => new Blob(["ftyp"], { type: "video/mp4" }),
    })

    const player = await screen.findByLabelText("Video output: walkthrough.mp4")
    expect(player).toBeInstanceOf(HTMLVideoElement)
    expect(player).toHaveAttribute("src", "blob:video-artifact")
    expect(player).toHaveAttribute("controls")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible()
    expect(
      screen.queryByRole("region", { name: "Output preview" })
    ).not.toBeInTheDocument()
  })

  it("shows a published image inline as a bounded preview that opens the viewer", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-artifact")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    renderPublishedArtifact({
      artifact: imageArtifact,
      resolve: async () => new Blob(["PNG"], { type: "image/png" }),
    })

    const preview = await screen.findByRole("img", { name: "diagram.png" })
    expect(preview).toHaveAttribute("src", "blob:image-artifact")
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible()
    expect(
      screen.queryByRole("region", { name: "Output preview" })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Open: diagram.png" }))
    expect(
      await screen.findByRole("region", { name: "Output preview" })
    ).toBeVisible()
  })

  it("names an inline player in the selected locale", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio-artifact")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    renderPublishedArtifact({
      artifact: audioArtifact,
      locale: "he",
      resolve: async () => new Blob(["ID3"], { type: "audio/mpeg" }),
    })

    expect(await screen.findByLabelText("קובץ שמע: intro.mp3")).toBeInstanceOf(
      HTMLAudioElement
    )
  })

  it("keeps an unreadable audio artifact honest and still downloadable", async () => {
    renderPublishedArtifact({
      artifact: audioArtifact,
      resolve: async () => {
        throw new Error("offline")
      },
    })

    expect(
      await screen.findByText("This output could not be loaded.")
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible()
    expect(screen.queryByLabelText(/^Audio output/)).not.toBeInTheDocument()
  })

  it("explains a pruned inline player without retry or download", async () => {
    renderPublishedArtifact({
      artifact: audioArtifact,
      resolve: async () => {
        throw new ArtifactMissingError()
      },
    })

    expect(
      await screen.findByText("This output is no longer available.")
    ).toBeVisible()
    expect(
      screen.getByText(
        "The provider keeps generated audio and video for a limited time and has since removed this file. Ask the agent to generate it again if you still need it."
      )
    ).toBeVisible()
    expect(screen.getByText("intro.mp3")).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Download" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument()
  })

  it("explains a pruned inline player in Hebrew", async () => {
    renderPublishedArtifact({
      artifact: audioArtifact,
      locale: "he",
      resolve: async () => {
        throw new ArtifactMissingError()
      },
    })

    expect(await screen.findByText("הפלט הזה כבר לא זמין.")).toBeVisible()
    expect(
      screen.getByText(
        "הספק שומר אודיו ווידאו שנוצרו לזמן מוגבל ומאז הסיר את הקובץ הזה. אם עדיין צריך אותו, אפשר לבקש מהסוכן ליצור אותו שוב."
      )
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "הורדה" })
    ).not.toBeInTheDocument()
  })

  it("drops retry and download from the viewer of a pruned output", async () => {
    renderPublishedArtifact({
      artifact: {
        id: "notes",
        filename: "notes.txt",
        mimeType: "text/plain",
        source: { type: "provider", reference: "notes" },
      },
      messageId: "notes-message",
      resolve: async () => {
        throw new ArtifactMissingError()
      },
    })

    fireEvent.click(screen.getByRole("button", { name: "Open: notes.txt" }))

    const viewer = await screen.findByRole("region", {
      name: "Output preview",
    })
    expect(
      within(viewer).getByText("This output is no longer available.")
    ).toBeVisible()
    expect(
      within(viewer).getByText(
        "The provider keeps generated audio and video for a limited time and has since removed this file. Ask the agent to generate it again if you still need it."
      )
    ).toBeVisible()
    expect(within(viewer).getByText("notes.txt")).toBeVisible()
    expect(
      within(viewer).queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument()
    expect(
      within(viewer).queryByRole("button", { name: "Download" })
    ).not.toBeInTheDocument()
  })

  it("renders an artifact without a media type as an ordinary card", () => {
    renderPublishedArtifact({
      artifact: {
        id: "capture",
        filename: "capture.bin",
        source: { type: "provider", reference: "capture" },
      },
      resolve: vi.fn<ArtifactAdapter["resolve"]>(),
    })

    expect(
      screen.getByRole("button", { name: "Open: capture.bin" })
    ).toBeVisible()
    expect(
      screen.queryByLabelText(/^(Audio|Video) output/)
    ).not.toBeInTheDocument()
  })
})
