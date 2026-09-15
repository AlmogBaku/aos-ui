import { describe, expect, it } from "vitest"

import {
  HermesMediaTextFilter,
  projectHermesMediaArtifacts,
} from "./media-artifacts"

const audioPath = "/home/alice/voice-memos/out/quick-brief.mp3"

describe("Hermes native media projection", () => {
  it("projects only explicitly delivered TTS audio as an opaque artifact", () => {
    const artifacts = projectHermesMediaArtifacts(
      "tts-call",
      "text_to_speech",
      JSON.stringify({
        success: true,
        file_path: audioPath,
        file_paths: [audioPath],
        media_tag: `MEDIA:${audioPath}`,
        provider: "edge",
      })
    )

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      reference: audioPath,
      descriptor: {
        filename: "quick-brief.mp3",
        mimeType: "audio/mpeg",
      },
    })
    expect(artifacts[0]?.descriptor.id).toMatch(/^hermes-media-[a-f0-9]{32}$/u)
    expect(artifacts[0]?.descriptor.source).toEqual({
      type: "provider",
      reference: artifacts[0]?.descriptor.id,
    })
    expect(JSON.stringify(artifacts[0]?.descriptor)).not.toContain(audioPath)
  })

  it("rejects failed, non-TTS, and non-delivered path claims", () => {
    const receipt = {
      success: true,
      file_path: audioPath,
      file_paths: [audioPath],
      media_tag: `MEDIA:${audioPath}`,
    }

    expect(
      projectHermesMediaArtifacts("tts-call", "read_file", receipt)
    ).toEqual([])
    expect(
      projectHermesMediaArtifacts("tts-call", "text_to_speech", {
        ...receipt,
        success: false,
      })
    ).toEqual([])
    expect(
      projectHermesMediaArtifacts("tts-call", "text_to_speech", {
        ...receipt,
        media_tag: "MEDIA:/home/alice/private/credentials.txt",
      })
    ).toEqual([])
  })

  it("suppresses a trusted MEDIA line across split deltas while preserving prose", () => {
    const filter = new HermesMediaTextFilter([audioPath])
    const output = [
      filter.write("Your brief is ready.\nME"),
      filter.write("DIA:"),
      filter.write("/home/alice/voice-"),
      filter.write("memos/out/quick-brief.mp3\nPlay it when convenient."),
      filter.finish(),
    ].join("")

    expect(output).toBe("Your brief is ready.\nPlay it when convenient.")
    expect(output).not.toContain("MEDIA:")
    expect(output).not.toContain("/home/")
  })

  it("redacts an untrusted MEDIA path without granting an artifact", () => {
    const filter = new HermesMediaTextFilter()
    const output = [
      filter.write("MEDIA:"),
      filter.write("/home/alice/private/credentials.txt"),
      filter.finish(),
    ].join("")

    expect(output).toBe("[Media unavailable]")
    expect(output).not.toContain("/home/")
  })

  it("suppresses a redundant unmatched marker after trusted media was delivered", () => {
    const filter = new HermesMediaTextFilter([audioPath])
    const output = [
      filter.write("MEDIA:/home/alice/voice-memos/out/copied-brief.mp3"),
      filter.finish(),
    ].join("")

    expect(output).toBe("")
  })
})
