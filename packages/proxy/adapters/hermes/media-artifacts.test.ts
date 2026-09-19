import { describe, expect, it } from "vitest"

import {
  HermesMediaTextFilter,
  projectHermesArtifactReceipt,
  projectHermesMediaArtifacts,
  projectHermesMediaText,
  publishedArtifact,
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

  it("preserves blank lines that delimit Markdown blocks", () => {
    const markdown = [
      "- Last list item",
      "",
      "**Candidates:**",
      "",
      "| # | Idea |",
      "|---|---|",
      "| 1 | DevTools |",
      "",
      "**Pick:** DevTools",
    ].join("\n")

    expect(projectHermesMediaText(markdown, [])).toBe(markdown)
  })
})

describe("Hermes published artifact receipts", () => {
  const receipt = (artifact: Record<string, unknown>) =>
    JSON.stringify({ ok: true, type: "aos.artifact", artifact })

  it("projects an opaque descriptor and never the native path", () => {
    const projected = projectHermesArtifactReceipt(
      receipt({
        id: "report-1",
        filename: "report.md",
        path: "/srv/hermes/private/report.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
      })
    )

    expect(projected).toEqual({
      result: {
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
        },
      },
      part: {
        type: "data",
        name: "aos.artifact",
        data: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
          source: { type: "provider", reference: "report-1" },
        },
      },
    })
    expect(JSON.stringify(projected)).not.toContain("/srv/hermes")
  })

  it.each([
    ["a path-shaped id", { id: "/srv/private/report.md", filename: "r.md" }],
    ["a traversing filename", { id: "report-1", filename: "../report.md" }],
    ["a missing filename", { id: "report-1" }],
    [
      "an unusable MIME type",
      { id: "report-1", filename: "r.md", mimeType: "text/markdown; x" },
    ],
    ["a negative size", { id: "report-1", filename: "r.md", sizeBytes: -1 }],
  ])("refuses %s", (_label, artifact) => {
    expect(projectHermesArtifactReceipt(receipt(artifact))).toBeUndefined()
  })

  it("refuses a row that is not a successful artifact receipt", () => {
    expect(projectHermesArtifactReceipt("not json")).toBeUndefined()
    expect(
      projectHermesArtifactReceipt(
        JSON.stringify({ ok: false, type: "aos.artifact", artifact: {} })
      )
    ).toBeUndefined()
    expect(
      projectHermesArtifactReceipt(JSON.stringify({ ok: true, type: "other" }))
    ).toBeUndefined()
  })

  it("resolves a published artifact id to its native reference newest-first", () => {
    const rows = [
      {
        role: "tool",
        content: receipt({
          id: "report-1",
          filename: "old.md",
          path: "reports/old.md",
        }),
      },
      {
        role: "tool",
        content: receipt({
          id: "report-1",
          filename: "report.md",
          path: "reports/report.md",
        }),
      },
    ]

    expect(publishedArtifact(rows, "report-1")).toEqual({
      reference: "reports/report.md",
      filename: "report.md",
    })
    expect(publishedArtifact(rows, "report-2")).toBeUndefined()
  })

  it("refuses an absolute, drive-rooted or traversing native reference", () => {
    for (const path of [
      "/srv/private/report.md",
      "C:\\private\\report.md",
      "reports/../../etc/passwd",
    ])
      expect(
        publishedArtifact(
          [
            {
              role: "tool",
              content: receipt({ id: "report-1", filename: "r.md", path }),
            },
          ],
          "report-1"
        )
      ).toBeUndefined()
  })

  it("resolves trusted TTS media through its opaque artifact id", () => {
    const rows = [
      {
        role: "tool",
        tool_call_id: "tts-call",
        tool_name: "text_to_speech",
        content: JSON.stringify({
          success: true,
          file_path: audioPath,
          file_paths: [audioPath],
          media_tag: `MEDIA:${audioPath}`,
        }),
      },
    ]
    const [media] = projectHermesMediaArtifacts(
      "tts-call",
      "text_to_speech",
      rows[0]!.content
    )

    expect(publishedArtifact(rows, media!.descriptor.id)).toEqual({
      reference: audioPath,
      filename: "quick-brief.mp3",
    })
  })
})
