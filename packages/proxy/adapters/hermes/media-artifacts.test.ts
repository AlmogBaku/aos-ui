import { describe, expect, it } from "vitest"

import {
  HermesMediaTextFilter,
  projectHermesArtifactReceipt,
  projectHermesAttachedImages,
  projectHermesMediaArtifacts,
  projectHermesMediaText,
  publishedArtifact,
} from "./media-artifacts"
import { projectHermesToolOutcome } from "./tool-data"

const audioPath = "/home/alice/voice-memos/out/quick-brief.mp3"
const imagePath = "/home/alice/.hermes/images/upload_20260920_024035_1.png"

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

  it("redacts a MEDIA line naming a sensitive file without granting an artifact", () => {
    const filter = new HermesMediaTextFilter()
    const output = [
      filter.write("MEDIA:"),
      filter.write("/home/alice/.hermes/auth.json"),
      filter.finish(),
    ].join("")

    expect(output).toBe("[Media unavailable]")
    expect(filter.takeArtifacts()).toEqual([])
  })

  it("turns an assistant MEDIA line into one artifact and drops it from prose", () => {
    const reportPath = "/home/alice/reports/q3 summary.pdf"
    const filter = new HermesMediaTextFilter()
    const streamed = [
      filter.write("The report is ready.\nMEDIA:`/home/alice/rep"),
      filter.write("orts/q3 summary.pdf`\nMEDIA:/home/alice/reports/q3"),
      filter.write(" summary.pdf\nMEDIA:/home/alice/data.bin\nAnything else?"),
      filter.finish(),
    ].join("")
    const artifacts = filter.takeArtifacts()

    expect(streamed).toBe(
      "The report is ready.\nMEDIA:/home/alice/reports/q3 summary.pdf\nAnything else?"
    )
    expect(artifacts.map(({ descriptor }) => descriptor)).toEqual([
      {
        id: expect.stringMatching(/^hermes-media-[a-f0-9]{32}$/u),
        filename: "q3 summary.pdf",
        mimeType: "application/pdf",
        source: { type: "provider", reference: artifacts[0]?.descriptor.id },
      },
      {
        id: expect.stringMatching(/^hermes-media-[a-f0-9]{32}$/u),
        filename: "data.bin",
        source: { type: "provider", reference: artifacts[1]?.descriptor.id },
      },
    ])
    expect(
      JSON.stringify(artifacts.map(({ descriptor }) => descriptor))
    ).not.toContain("/home/")
    expect(artifacts[0]?.reference).toBe(reportPath)
  })

  it("derives the same MEDIA-line id live, on replay, and on a read", () => {
    const text = "Chart attached.\nMEDIA:/home/alice/reports/chart.png"
    const live = new HermesMediaTextFilter()
    for (const chunk of text.match(/.{1,5}/gsu) ?? []) live.write(chunk)
    live.finish()
    const [streamed] = live.takeArtifacts()
    const replayed = projectHermesMediaText(text, [])

    expect(replayed.text).toBe("Chart attached.")
    expect(replayed.artifacts.map(({ descriptor }) => descriptor)).toEqual([
      streamed?.descriptor,
    ])
    expect(
      publishedArtifact(
        [{ role: "assistant", content: text }],
        streamed!.descriptor.id
      )
    ).toEqual({
      reference: "/home/alice/reports/chart.png",
      filename: "chart.png",
    })
  })

  it("publishes no second artifact for a MEDIA line repeating trusted TTS audio", () => {
    const filter = new HermesMediaTextFilter()
    filter.trust(audioPath)

    expect(filter.write(`Listen.\nMEDIA:${audioPath}\n`)).toBe("Listen.\n")
    expect(filter.takeArtifacts()).toEqual([])
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

    expect(projectHermesMediaText(markdown, []).text).toBe(markdown)
  })
})

describe("Hermes published artifact receipts", () => {
  const receipt = (artifact: Record<string, unknown>) =>
    JSON.stringify({ ok: true, type: "aos.artifact", artifact })

  it("projects an opaque descriptor and never the native path", () => {
    const projected = projectHermesArtifactReceipt(
      "call-1",
      receipt({
        id: "report-1",
        filename: "report.md",
        workdir: "/srv/hermes/private",
        path: "report.md",
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
    expect(
      projectHermesArtifactReceipt("call-1", receipt(artifact))
    ).toBeUndefined()
  })

  it("refuses a row that is not a successful artifact receipt", () => {
    expect(projectHermesArtifactReceipt("call-1", "not json")).toBeUndefined()
    expect(
      projectHermesArtifactReceipt(
        "call-1",
        JSON.stringify({ ok: false, type: "aos.artifact", artifact: {} })
      )
    ).toBeUndefined()
    expect(
      projectHermesArtifactReceipt(
        "call-1",
        JSON.stringify({ ok: true, type: "other" })
      )
    ).toBeUndefined()
  })

  it("resolves a published artifact id to its native reference newest-first", () => {
    const rows = [
      {
        role: "tool",
        content: receipt({
          id: "report-1",
          filename: "old.md",
          workdir: "/home/agent",
          path: "reports/old.md",
        }),
      },
      {
        role: "tool",
        content: receipt({
          id: "report-1",
          filename: "report.md",
          workdir: "/home/agent",
          path: "reports/report.md",
        }),
      },
    ]

    expect(publishedArtifact(rows, "report-1")).toEqual({
      reference: "/home/agent/reports/report.md",
      filename: "report.md",
    })
    expect(publishedArtifact(rows, "report-2")).toBeUndefined()
  })

  it("reads a retired plugin receipt through its absolute workdir when valid", () => {
    const row = (workdir?: string) => ({
      role: "tool",
      content: receipt({
        id: "report-1",
        filename: "report.md",
        path: "reports/report.md",
        workdir,
      }),
    })

    expect(
      publishedArtifact([row("/home/agent/scratch/")], "report-1")
    ).toEqual({
      reference: "/home/agent/scratch/reports/report.md",
      filename: "report.md",
    })
    for (const workdir of [undefined, "relative/root", "/home/agent/../root"])
      expect(publishedArtifact([row(workdir)], "report-1")).toEqual({
        reference: "reports/report.md",
        filename: "report.md",
      })
  })

  it("resolves a retired plugin receipt with no workdir to its relative path", () => {
    // The shape every retired-plugin receipt in a live Hermes store carries.
    const legacy = (path: string) => ({
      role: "tool",
      tool_call_id: "call_legacy",
      tool_name: "present_artifact",
      content: receipt({
        id: "hermes-artifact-9e17c0a4b2d84f6e8a1b3c5d7e9f0a12",
        path,
        filename: "A-proceed-internal-memo.pdf",
        sizeBytes: 48_213,
        mimeType: "application/pdf",
      }),
    })
    const id = "hermes-artifact-9e17c0a4b2d84f6e8a1b3c5d7e9f0a12"

    expect(
      publishedArtifact([legacy("A-proceed-internal-memo.pdf")], id)
    ).toEqual({
      reference: "A-proceed-internal-memo.pdf",
      filename: "A-proceed-internal-memo.pdf",
    })
    for (const denied of [".env", "config/.env.local", "pairing/memo.pdf"])
      expect(publishedArtifact([legacy(denied)], id)).toBeUndefined()
  })

  it("refuses an absolute, drive-rooted or traversing native reference", () => {
    for (const path of [
      "/srv/private/report.md",
      "C:\\private\\report.md",
      "reports/../../etc/passwd",
      ".hermes/auth.json",
    ])
      expect(
        publishedArtifact(
          [
            {
              role: "tool",
              content: receipt({
                id: "report-1",
                filename: "r.md",
                workdir: "/home/agent",
                path,
              }),
            },
          ],
          "report-1"
        )
      ).toBeUndefined()
  })

  describe("from the aos-ui MCP server", () => {
    const reportPath = "/home/alice/reports/q3.pdf"
    // How Hermes stores an MCP tool result: the text content, wrapped.
    const mcpResult = (artifact: Record<string, unknown>) =>
      JSON.stringify({ result: receipt(artifact) })
    const content = mcpResult({
      path: reportPath,
      filename: "q3.pdf",
      mimeType: "application/pdf",
    })

    it("derives the id from the call and never publishes the path", () => {
      const projected = projectHermesArtifactReceipt("present-call", content)
      const id = projected?.part.data.id

      expect(id).toMatch(/^hermes-media-[a-f0-9]{32}$/u)
      expect(projected?.result).toEqual({
        ok: true,
        type: "aos.artifact",
        artifact: { id, filename: "q3.pdf", mimeType: "application/pdf" },
      })
      expect(JSON.stringify(projected)).not.toContain("/home/alice")
      expect(
        projectHermesArtifactReceipt("other-call", content)?.part.data.id
      ).not.toBe(id)
    })

    it("resolves only from the tool row that carries it", () => {
      const id = projectHermesArtifactReceipt("present-call", content)!.part
        .data.id
      const toolRow = {
        role: "tool",
        tool_call_id: "present-call",
        tool_name: "mcp__aos_ui__present_artifact",
        content,
      }

      expect(publishedArtifact([toolRow], id)).toEqual({
        reference: reportPath,
        filename: "q3.pdf",
      })
      for (const role of ["assistant", "user"])
        expect(publishedArtifact([{ ...toolRow, role }], id)).toBeUndefined()
    })

    it("resolves a receipt Hermes stored inside its untrusted-data block", () => {
      const wrapped =
        '<untrusted_tool_result source="mcp__aos_ui__present_artifact">\n' +
        "The following content was retrieved from an external source.\n\n" +
        `${content}\n</untrusted_tool_result>`
      const id = projectHermesToolOutcome(
        "present-call",
        "mcp__aos_ui__present_artifact",
        wrapped
      ).parts[0]!.data.id

      expect(
        publishedArtifact(
          [{ role: "tool", tool_call_id: "present-call", content: wrapped }],
          id
        )
      ).toEqual({ reference: reportPath, filename: "q3.pdf" })
    })

    it.each([
      ["a relative path", "reports/q3.pdf"],
      ["a sensitive path", "/home/alice/.env.production"],
      ["a traversing path", "/home/alice/../bob/q3.pdf"],
    ])("refuses %s", (_label, path) => {
      const unsafe = mcpResult({ path, filename: "q3.pdf" })
      expect(
        projectHermesArtifactReceipt("present-call", unsafe)
      ).toBeUndefined()
    })
  })

  it("never takes a receipt-shaped assistant or user row as authority", () => {
    for (const role of ["assistant", "user"])
      expect(
        publishedArtifact(
          [
            {
              role,
              content: receipt({
                id: "report-1",
                filename: "r.md",
                workdir: "/home/agent",
                path: "r.md",
              }),
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

describe("Hermes attached image directives", () => {
  it("projects an attached image as an opaque artifact, never as prose", () => {
    const projected = projectHermesAttachedImages(
      `do u see it?\n@image:${imagePath}`
    )

    expect(projected.text).toBe("do u see it?")
    expect(projected.artifacts).toHaveLength(1)
    expect(projected.artifacts[0]).toMatchObject({
      reference: imagePath,
      descriptor: {
        filename: "upload_20260920_024035_1.png",
        mimeType: "image/png",
      },
    })
    expect(projected.artifacts[0]?.descriptor.id).toMatch(
      /^hermes-media-[a-f0-9]{32}$/u
    )
    expect(projected.artifacts[0]?.descriptor.source).toEqual({
      type: "provider",
      reference: projected.artifacts[0]?.descriptor.id,
    })
    expect(JSON.stringify(projected.artifacts[0]?.descriptor)).not.toContain(
      "/home/"
    )
  })

  it("keeps a directive out of the prose even when it grants no artifact", () => {
    const projected = projectHermesAttachedImages(
      "check this\n@image:/home/alice/.hermes/images/notes.txt"
    )

    expect(projected.text).toBe("check this")
    expect(projected.artifacts).toEqual([])
  })

  it("grants one artifact per attached reference", () => {
    const projected = projectHermesAttachedImages(
      `two refs\n@image:${imagePath}\n@image:${imagePath}`
    )

    expect(projected.artifacts).toHaveLength(1)
  })

  it("resolves an attached image through its opaque artifact id", () => {
    const rows = [
      {
        role: "user",
        text: `do u see it?\n@image:${imagePath}`,
      },
    ]
    const [image] = projectHermesAttachedImages(String(rows[0]!.text)).artifacts

    expect(publishedArtifact(rows, image!.descriptor.id)).toEqual({
      reference: imagePath,
      filename: "upload_20260920_024035_1.png",
    })
    expect(
      publishedArtifact(rows, "hermes-media-" + "0".repeat(32))
    ).toBeUndefined()
  })

  it("refuses an attached image no durable user row carries", () => {
    const [image] = projectHermesAttachedImages(`@image:${imagePath}`).artifacts

    expect(
      publishedArtifact(
        [{ role: "assistant", text: `@image:${imagePath}` }],
        image!.descriptor.id
      )
    ).toBeUndefined()
  })
})
