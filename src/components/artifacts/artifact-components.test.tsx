import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {} from "@assistant-ui/react"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"
import type { ArtifactAdapter } from "@/runtime-adapters/contracts"

import {
  ArtifactToolResultCard,
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

  it("reads an inline image's bytes once while the conversation keeps streaming", async () => {
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
