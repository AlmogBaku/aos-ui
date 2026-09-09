import { describe, expect, it } from "vitest"
import { extractArtifactOccurrences } from "@/artifacts/artifacts"

import {
  createAgUiArtifactToolkit,
  projectAgUiArtifactMessages,
  publishAgUiArtifact,
} from "./ag-ui-artifacts"

describe("AG-UI artifact publication", () => {
  it("publishes validated inline and public URL descriptors", () => {
    const inline = {
      id: "report",
      filename: "report.md",
      mimeType: "text/markdown",
      source: {
        type: "inline" as const,
        encoding: "utf8" as const,
        data: "# Report",
      },
    }
    expect(publishAgUiArtifact(inline)).toEqual(inline)
    expect(
      publishAgUiArtifact({
        id: "image",
        filename: "chart.png",
        source: { type: "url", url: "https://files.example/chart.png" },
      })
    ).toMatchObject({ id: "image", source: { type: "url" } })
  })

  it("rejects provider references and malformed publications", () => {
    expect(() =>
      publishAgUiArtifact({
        id: "provider",
        filename: "secret.txt",
        source: { type: "provider", reference: "/tmp/secret" },
      })
    ).toThrow("inline content or a public URL")
    expect(() =>
      publishAgUiArtifact({
        id: "bad",
        filename: "bad.txt",
        source: { type: "url", url: "file:///tmp/bad" },
      })
    ).toThrow("valid artifact")
  })

  it("registers one explicit frontend present_artifact tool", () => {
    expect(Object.keys(createAgUiArtifactToolkit())).toEqual([
      "present_artifact",
    ])
  })

  it("projects only completed present_artifact results into canonical data parts", () => {
    const artifact = {
      id: "published",
      filename: "published.txt",
      source: { type: "inline", encoding: "utf8", data: "done" },
    }
    const projected = projectAgUiArtifactMessages([
      {
        id: "assistant-message",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "write_file",
            result: artifact,
            status: { type: "complete" },
          },
          {
            type: "tool-call",
            toolName: "present_artifact",
            result: artifact,
            status: { type: "complete" },
          },
          {
            type: "tool-call",
            toolName: "present_artifact",
            result: { ...artifact, id: "running" },
            status: { type: "running" },
          },
        ],
      },
    ])

    expect(extractArtifactOccurrences(projected)).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({ id: "published" }),
      }),
    ])
  })
})
