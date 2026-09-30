import { describe, expect, it } from "vitest"

import { artifactMediaKind } from "./artifact-renderers"

describe("artifactMediaKind", () => {
  it("returns the media kind for image, audio and video MIME types", () => {
    expect(artifactMediaKind("image/png", "chart.png")).toBe("image")
    expect(artifactMediaKind("audio/mpeg", "brief.mp3")).toBe("audio")
    expect(artifactMediaKind("video/mp4", "demo.mp4")).toBe("video")
  })

  it("returns null for non-media MIME types", () => {
    expect(artifactMediaKind("text/markdown", "brief.md")).toBeNull()
    expect(artifactMediaKind("application/pdf", "report.pdf")).toBeNull()
    expect(artifactMediaKind(undefined, "archive.zip")).toBeNull()
  })

  it("falls back to filename extension when MIME type is absent", () => {
    expect(artifactMediaKind(undefined, "photo.jpg")).toBe("image")
    expect(artifactMediaKind(undefined, "clip.mp4")).toBe("video")
    expect(artifactMediaKind(undefined, "note.wav")).toBe("audio")
  })
})
