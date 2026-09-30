import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import {} from "@assistant-ui/react"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"
import { McpAppPipPanel } from "@/components/mcp-apps/mcp-app-card"
import type { McpAppFrameProps } from "@/components/mcp-apps/mcp-app-frame"
import {
  McpAppHostProvider,
  useMcpAppHost,
} from "@/components/mcp-apps/mcp-app-host"
import { MCP_APP_TOOL_ARTIFACT } from "@/components/mcp-apps/tool-part"
import type {
  ArtifactAdapter,
  McpAppAdapter,
} from "@/runtime-adapters/contracts"

import {
  ArtifactOutputs,
  ArtifactToolResultCard,
  artifactPanelFailure,
  ArtifactWorkspaceProvider,
  type ArtifactWorkspaceProviderProps,
  createArtifactMessageStabilizer,
} from "./artifact-workspace"

/** One assistant message that publishes `data` as an Artifact. */
const artifactMessage = (id: string, data: unknown) => ({
  id,
  role: "assistant" as const,
  content: [{ type: "data" as const, name: "aos.artifact", data }],
})

const ArtifactTestSurface = () => null

vi.mock("@/components/mcp-apps/mcp-app-frame", () => ({
  default: (props: McpAppFrameProps) => <iframe title={props.title} />,
}))

/**
 * The Artifacts surface of Aster's market Session; a test passes the adapter
 * and messages that matter, and any other provider prop it changes.
 */
const workspace = ({
  children = <ArtifactTestSurface />,
  ...props
}: Pick<ArtifactWorkspaceProviderProps, "adapter" | "messages"> &
  Partial<ArtifactWorkspaceProviderProps>) => (
  <ArtifactWorkspaceProvider
    locale="en"
    agentId="agent-aster"
    sessionId="thread-aster-market"
    {...props}
  >
    {children}
  </ArtifactWorkspaceProvider>
)

afterEach(() => {
  cleanup()
})

describe("artifact workspace", () => {
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

  const audioArtifact = {
    id: "fixture-audio",
    filename: "intro.mp3",
    mimeType: "audio/mpeg",
    source: { type: "provider" as const, reference: "intro-audio" },
  }
  const videoArtifact = {
    id: "fixture-video",
    filename: "walkthrough.mp4",
    mimeType: "video/mp4",
    source: { type: "provider" as const, reference: "walkthrough-video" },
  }
  const imageArtifact = {
    id: "fixture-image",
    filename: "diagram.png",
    mimeType: "image/png",
    source: { type: "provider" as const, reference: "diagram-image" },
  }

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
      workspace({
        locale,
        adapter: { resolve },
        messages: [artifactMessage(messageId, artifact)],
        children: (
          <ArtifactToolResultCard
            result={artifact}
            occurrenceKey={`${messageId}:0`}
          />
        ),
      })
    )

  it.each([
    {
      kind: "audio",
      artifact: audioArtifact,
      bytes: new Blob(["ID3"], { type: "audio/mpeg" }),
      label: "Audio output: intro.mp3",
      player: HTMLAudioElement,
    },
    {
      kind: "video",
      artifact: videoArtifact,
      bytes: new Blob(["ftyp"], { type: "video/mp4" }),
      label: "Video output: walkthrough.mp4",
      player: HTMLVideoElement,
    },
  ])(
    "plays a published $kind artifact inline with no download of its own",
    async ({ kind, artifact, bytes, label, player }) => {
      vi.spyOn(URL, "createObjectURL").mockReturnValue(`blob:${kind}-artifact`)
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
      renderPublishedArtifact({ artifact, resolve: async () => bytes })

      const element = await screen.findByLabelText(label)
      expect(element).toBeInstanceOf(player)
      expect(element).toHaveAttribute("src", `blob:${kind}-artifact`)
      expect(element).toHaveAttribute("controls")
      expect(element).toHaveAttribute("preload", "metadata")
      expect(
        screen.queryByRole("button", { name: "Download" })
      ).not.toBeInTheDocument()
    }
  )

  it("shows an inline image with no download of its own and reads its bytes once while the conversation keeps streaming", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-artifact")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    const resolve = vi.fn<ArtifactAdapter["resolve"]>(
      async () => new Blob(["PNG"], { type: "image/png" })
    )
    // The workspace holds one adapter instance; what churns while an answer
    // streams is the projected descriptor, a new object for the same bytes.
    const adapter = { resolve }
    const surface = (text: string) =>
      workspace({
        adapter,
        messages: [
          artifactMessage("media-message", { ...imageArtifact }),
          {
            id: "streaming",
            role: "assistant",
            content: [{ type: "text", text }],
          },
        ],
        children: (
          <ArtifactToolResultCard
            result={{ ...imageArtifact }}
            occurrenceKey="media-message:0"
          />
        ),
      })

    const { rerender } = render(surface("First token"))
    expect(
      await screen.findByRole("img", { name: "diagram.png" })
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Download" })
    ).not.toBeInTheDocument()
    expect(resolve).toHaveBeenCalledTimes(1)

    rerender(surface("First token, then another"))
    rerender(surface("First token, then another, and more"))
    expect(
      await screen.findByRole("img", { name: "diagram.png" })
    ).toBeVisible()
    expect(resolve).toHaveBeenCalledTimes(1)
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

  it("explains a pruned inline player without a download", async () => {
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

  it("renders an artifact without a media type as an ordinary card", () => {
    renderPublishedArtifact({
      artifact: {
        id: "capture",
        filename: "capture.bin",
        source: { type: "provider", reference: "capture" },
      },
      resolve: vi.fn<ArtifactAdapter["resolve"]>(),
    })

    expect(screen.getByText("capture.bin")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible()
    expect(
      screen.queryByLabelText(/^(Audio|Video) output/)
    ).not.toBeInTheDocument()
  })
})

describe("artifact side panel", () => {
  const capture = {
    id: "capture",
    filename: "capture.bin",
    source: { type: "provider" as const, reference: "capture" },
  }
  const image = {
    id: "diagram",
    filename: "diagram.png",
    mimeType: "image/png",
    source: { type: "provider" as const, reference: "diagram" },
  }
  const audio = {
    id: "intro",
    filename: "intro.mp3",
    mimeType: "audio/mpeg",
    source: { type: "provider" as const, reference: "intro" },
  }
  /** An App call whose result names `value` as what it shows. */
  const appCall = (id: string, toolName: string, value: object) => ({
    id,
    role: "assistant" as const,
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `call-${id}`,
        toolName,
        args: {},
        artifact: MCP_APP_TOOL_ARTIFACT,
        result: {
          content: [],
          structuredContent: { ok: true, type: "aos.presentation", value },
        },
      },
    ],
  })

  function apps(open: McpAppAdapter["open"] = async () => ({ html: "<p/>" })) {
    return {
      open: vi.fn(open),
      callTool: vi.fn(),
      readResource: vi.fn(),
      renewFiles: vi.fn(),
    } satisfies McpAppAdapter
  }

  /** Aster's market Session with its App host and side panel. */
  function renderSession({
    views = apps(),
    messages,
    children,
  }: {
    views?: McpAppAdapter
    messages: ArtifactWorkspaceProviderProps["messages"]
    children: React.ReactNode
  }) {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:artifact")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    render(
      <McpAppHostProvider
        adapter={views}
        agentId="agent-aster"
        sessionId="thread-aster-market"
      >
        {workspace({
          adapter: { resolve: async () => new Blob(["bytes"]) },
          messages,
          children: (
            <>
              {children}
              <McpAppPipPanel
                locale="en"
                failureNotice={artifactPanelFailure}
              />
            </>
          ),
        })}
      </McpAppHostProvider>
    )
    return views
  }

  const card = (artifact: object) => (
    <ArtifactToolResultCard result={artifact} occurrenceKey="published:0" />
  )

  it("lists the Session's files newest first, leaves out an App call that shows no file, and opens a row in the panel", async () => {
    const user = userEvent.setup()
    const views = renderSession({
      messages: [
        artifactMessage("published", capture),
        appCall("chart", "render_chart", { series: [] }),
        appCall("report", "present_artifact", {
          filename: "report.pdf",
          mimeType: "application/pdf",
        }),
      ],
      children: <ArtifactOutputs />,
    })

    const list = screen.getByRole("region", { name: "Artifacts" })
    expect(
      within(list)
        .getAllByRole("button", { name: /^Open: / })
        .map((row) => row.getAttribute("aria-label"))
    ).toEqual(["Open: report.pdf", "Open: capture.bin"])
    expect(
      within(list).getAllByRole("button", { name: "Download" })
    ).toHaveLength(2)

    await user.click(
      within(list).getByRole("button", { name: "Open: report.pdf" })
    )
    const panel = screen.getByRole("region", { name: "report.pdf" })
    expect(within(panel).getByText("application/pdf")).toBeVisible()
    expect(views.open).toHaveBeenCalledWith(
      {
        agentId: "agent-aster",
        sessionId: "thread-aster-market",
        toolCallId: "call-report",
      },
      expect.any(AbortSignal)
    )
  })

  it("says the Session has no files yet", () => {
    renderSession({ messages: [], children: <ArtifactOutputs /> })
    expect(screen.getByText("No artifacts yet")).toBeInTheDocument()
  })

  it.each([
    { kind: "a file card", artifact: capture },
    { kind: "an inline image", artifact: image },
  ])("opens $kind in the panel by its Artifact", async ({ artifact }) => {
    const user = userEvent.setup()
    const views = renderSession({
      messages: [artifactMessage("published", artifact)],
      children: card(artifact),
    })

    await user.click(
      await screen.findByRole("button", { name: `Open: ${artifact.filename}` })
    )
    expect(
      screen.getByRole("region", { name: artifact.filename })
    ).toBeInTheDocument()
    expect(views.open).toHaveBeenCalledWith(
      {
        agentId: "agent-aster",
        sessionId: "thread-aster-market",
        artifactId: artifact.id,
      },
      expect.any(AbortSignal)
    )
  })

  it("keeps audio inline with nothing to open", async () => {
    const views = renderSession({
      messages: [artifactMessage("published", audio)],
      children: card(audio),
    })
    expect(
      await screen.findByLabelText("Audio output: intro.mp3")
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: /^Open: / })).toBeNull()
    expect(views.open).not.toHaveBeenCalled()
  })

  it("returns focus to the control that opened the panel on Esc and on Close", async () => {
    const user = userEvent.setup()
    renderSession({
      messages: [artifactMessage("published", capture)],
      children: card(capture),
    })
    const opener = screen.getByRole("button", { name: "Open: capture.bin" })

    await user.click(opener)
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("region", { name: "capture.bin" })).toBeNull()
    await waitFor(() => expect(opener).toHaveFocus())

    await user.click(opener)
    await user.click(screen.getByRole("button", { name: "Close preview" }))
    expect(screen.queryByRole("region", { name: "capture.bin" })).toBeNull()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it("returns focus to an Outputs row the side panel replaced while it showed", async () => {
    // The desktop inspector gives its place to the side panel.
    function Inspector() {
      return useMcpAppHost()?.pip ? null : <ArtifactOutputs />
    }
    const user = userEvent.setup()
    renderSession({
      messages: [artifactMessage("published", capture)],
      children: <Inspector />,
    })

    await user.click(screen.getByText("Artifacts"))
    await user.click(screen.getByRole("button", { name: "Open: capture.bin" }))
    expect(screen.queryByRole("region", { name: "Artifacts" })).toBeNull()
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open: capture.bin" })
      ).toHaveFocus()
    )
  })

  it.each([
    {
      failure: "a gone file",
      error: new ArtifactMissingError(),
      title: "This output is no longer available.",
      downloads: 0,
    },
    {
      failure: "a file no viewer opens",
      error: new Error("no viewer"),
      title: "This runtime cannot open this output.",
      downloads: 1,
    },
  ])("explains $failure in the panel", async ({ error, title, downloads }) => {
    const user = userEvent.setup()
    renderSession({
      views: apps(async () => {
        throw error
      }),
      messages: [artifactMessage("published", capture)],
      children: card(capture),
    })

    await user.click(screen.getByRole("button", { name: "Open: capture.bin" }))
    const panel = screen.getByRole("region", { name: "capture.bin" })
    expect(await within(panel).findByText(title)).toBeVisible()
    expect(
      within(panel).queryAllByRole("button", { name: "Download" })
    ).toHaveLength(downloads)
  })
})
