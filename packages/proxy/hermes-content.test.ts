import { describe, expect, it, vi } from "vitest"

import {
  HermesContentScopeError,
  HermesContentUnavailableError,
  createHermesContentOperations,
} from "./hermes-content"

const scope = {
  agentId: "research",
  sessionId: "session-public-1",
  liveSessionId: "live-private-1",
  attached: true,
}

const png = "data:image/png;base64,aGVsbG8="
const text = "data:text/plain;base64,bm90ZXM="

function harness(overrides?: {
  scope?: Partial<typeof scope>
  authoritySession?: unknown
  request?: (
    method: string,
    params: Readonly<Record<string, unknown>>
  ) => unknown
  artifact?: (id: string) => unknown
  artifactReaderResult?: unknown
  audioConfig?: (kind: "stt" | "tts") => unknown
  transcribe?: unknown
  speak?: unknown
}) {
  const requireSession = vi.fn(async () =>
    overrides && Object.hasOwn(overrides, "authoritySession")
      ? overrides.authoritySession
      : { ...scope, ...overrides?.scope }
  )
  const requireArtifact = vi.fn(async (_scope: typeof scope, id: string) =>
    overrides?.artifact
      ? overrides.artifact(id)
      : { reference: "reports/private.pdf", filename: "Report.pdf" }
  )
  const request = vi.fn(
    async (method: string, params: Readonly<Record<string, unknown>>) =>
      overrides?.request?.(method, params)
  )
  const readArtifact = vi.fn(async () =>
    overrides && Object.hasOwn(overrides, "artifactReaderResult")
      ? overrides.artifactReaderResult
      : {
          bytes: Uint8Array.of(1, 2, 3),
          mimeType: "application/pdf",
        }
  )
  const audioConfig = vi.fn(
    async (_scope: typeof scope, kind: "stt" | "tts") =>
      overrides?.audioConfig?.(kind) ?? {
        name: kind,
        has_category: true,
        active_provider: "native",
        providers: [{ name: "native", is_active: true, status: "ready" }],
      }
  )
  const transcribe = vi.fn(
    async () =>
      overrides?.transcribe ?? {
        ok: true,
        transcript: "transcript",
        provider: "private",
      }
  )
  const speak = vi.fn(
    async () =>
      overrides?.speak ?? {
        ok: true,
        data_url: "data:audio/mpeg;base64,AQID",
        mime_type: "audio/mpeg",
        provider: "private",
      }
  )
  return {
    requireSession,
    requireArtifact,
    request,
    readArtifact,
    audioConfig,
    transcribe,
    speak,
    operations: createHermesContentOperations({
      authority: { requireSession, requireArtifact } as never,
      transport: {
        request,
        readArtifact,
        audioConfig,
        transcribe,
        speak,
      } as never,
    }),
  }
}

describe("Hermes content operations", () => {
  it("stages validated image and file content for the owned attached Session without returning native references", async () => {
    const h = harness({
      request(method) {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/srv/private/image.png" }
        if (method === "file.attach")
          return {
            attached: true,
            ref_text: "@file:notes.txt",
            path: "/srv/private/notes.txt",
          }
      },
    })

    const staged = await h.operations.stage("research", "session-public-1", [
      { type: "image", dataUrl: png, filename: "image.png" },
      {
        type: "file",
        dataUrl: text,
        filename: "notes.txt",
        mimeType: "text/plain",
      },
    ])

    expect(staged.public).toEqual([
      { type: "image", dataUrl: png, filename: "image.png" },
      { type: "file", filename: "notes.txt", mimeType: "text/plain" },
    ])
    expect(staged.appendTo("Inspect")).toBe("Inspect\n@file:notes.txt")
    expect(JSON.stringify(staged.public)).not.toContain("/srv/private")
    expect(h.request).toHaveBeenNthCalledWith(1, "image.attach_bytes", {
      session_id: "live-private-1",
      content_base64: png,
      filename: "image.png",
    })
    expect(h.request).toHaveBeenNthCalledWith(2, "file.attach", {
      session_id: "live-private-1",
      data_url: text,
      name: "notes.txt",
    })
  })

  it("detaches already-staged native images when a later attachment is rejected", async () => {
    const h = harness({
      request(method) {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/private/a.png" }
        if (method === "file.attach") return { attached: false }
        if (method === "image.detach") return { detached: true }
      },
    })

    await expect(
      h.operations.stage("research", "session-public-1", [
        { type: "image", dataUrl: png },
        { type: "file", dataUrl: text, mimeType: "text/plain" },
      ])
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.request).toHaveBeenLastCalledWith("image.detach", {
      session_id: "live-private-1",
      path: "/private/a.png",
    })
  })

  it("rejects malformed, oversized, and too-many attachments before native I/O", async () => {
    const h = harness()
    const oversized = `data:image/png;base64,${"A".repeat(34_952_536)}`
    for (const attachments of [
      [{ type: "image" as const, dataUrl: "data:image/png;base64,%%%" }],
      [{ type: "image" as const, dataUrl: oversized }],
      Array.from({ length: 17 }, () => ({
        type: "file" as const,
        dataUrl: text,
        mimeType: "text/plain",
      })),
    ])
      await expect(
        h.operations.stage("research", "session-public-1", attachments)
      ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.request).not.toHaveBeenCalled()
  })

  it("rejects unrecognized nested attachment input before native I/O", async () => {
    const h = harness()
    await expect(
      h.operations.stage("research", "session-public-1", [
        {
          type: "file",
          dataUrl: text,
          mimeType: "text/plain",
          metadata: { private: { deeply: "nested" } },
        } as never,
      ])
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.request).not.toHaveBeenCalled()
  })

  it("requires the selected ownership scope before staging any native content", async () => {
    const h = harness({ scope: { agentId: "other" } })
    await expect(
      h.operations.stage("research", "session-public-1", [])
    ).rejects.toBeInstanceOf(HermesContentScopeError)
    expect(h.request).not.toHaveBeenCalled()
  })

  it("fails closed when the Session authority returns malformed runtime data", async () => {
    for (const authoritySession of [
      undefined,
      null,
      "private session",
      { ...scope, attached: "true" },
      { ...scope, liveSessionId: "x".repeat(4_097) },
    ]) {
      const h = harness({ authoritySession })
      await expect(
        h.operations.stage("research", "session-public-1", [])
      ).rejects.toBeInstanceOf(HermesContentScopeError)
      expect(h.request).not.toHaveBeenCalled()
    }
  })

  it("reads only an authority-bound opaque artifact and strips its native reference", async () => {
    const h = harness()
    await expect(
      h.operations.artifact("research", "session-public-1", "artifact-1")
    ).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: "application/pdf",
      filename: "Report.pdf",
    })
    expect(h.requireArtifact).toHaveBeenCalledWith(scope, "artifact-1")
    expect(h.readArtifact).toHaveBeenCalledWith(
      scope,
      "reports/private.pdf",
      26_214_400
    )
  })

  it("does not fetch an unknown artifact and rejects an oversized native download", async () => {
    const unknown = harness({ artifact: () => undefined })
    await expect(
      unknown.operations.artifact("research", "session-public-1", "artifact-1")
    ).rejects.toBeInstanceOf(HermesContentScopeError)
    expect(unknown.readArtifact).not.toHaveBeenCalled()

    const oversized = harness({
      artifactReaderResult: { bytes: new Uint8Array(26_214_401) },
    })
    await expect(
      oversized.operations.artifact(
        "research",
        "session-public-1",
        "artifact-1"
      )
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
  })

  it("fails closed when the native artifact reader returns malformed runtime data", async () => {
    for (const artifactReaderResult of [
      undefined,
      null,
      "native error body",
      {},
      { bytes: "not bytes" },
      { bytes: Uint8Array.of(1), mimeType: "x".repeat(257) },
    ]) {
      const h = harness({ artifactReaderResult })
      await expect(
        h.operations.artifact("research", "session-public-1", "artifact-1")
      ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    }
  })

  it("reports per-profile native audio readiness without treating setup metadata as disabled", async () => {
    const h = harness({
      audioConfig(kind) {
        return {
          name: kind,
          has_category: true,
          active_provider: "native",
          providers: [
            {
              name: "native",
              is_active: true,
              status: kind === "stt" ? "needs_setup" : "ready",
              tts_provider: "edge",
            },
          ],
        }
      },
    })
    await expect(
      h.operations.audio("research", "session-public-1")
    ).resolves.toEqual({
      transcription: "unverified",
      speech: "ready",
    })
  })

  it("treats malformed native audio metadata as unavailable", async () => {
    const h = harness({
      audioConfig: () => ({
        name: "stt",
        has_category: true,
        active_provider: null,
        providers: [{ name: "native" }],
      }),
    })
    await expect(
      h.operations.audio("research", "session-public-1")
    ).resolves.toEqual({
      transcription: "unavailable",
      speech: "unavailable",
    })
  })

  it("encodes a bounded recording only after authorization and never exposes provider output", async () => {
    const h = harness()
    await expect(
      h.operations.transcribe(
        "research",
        "session-public-1",
        Uint8Array.of(1, 2, 3),
        "audio/webm;codecs=opus"
      )
    ).resolves.toBe("transcript")
    expect(h.transcribe).toHaveBeenCalledWith(scope, {
      data_url: "data:audio/webm;codecs=opus;base64,AQID",
      mime_type: "audio/webm;codecs=opus",
    })
  })

  it("rejects unsupported and oversized recordings before forwarding", async () => {
    const h = harness()
    await expect(
      h.operations.transcribe(
        "research",
        "session-public-1",
        Uint8Array.of(1),
        "text/plain"
      )
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    await expect(
      h.operations.transcribe(
        "research",
        "session-public-1",
        new Uint8Array(5_242_881),
        "audio/webm"
      )
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it("accepts only bounded valid native speech and removes provider metadata", async () => {
    const h = harness()
    await expect(
      h.operations.speak("research", "session-public-1", "hello")
    ).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: "audio/mpeg",
    })
    await expect(
      h.operations.speak("research", "session-public-1", " ")
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(
      JSON.stringify(
        await h.operations.speak("research", "session-public-1", "again")
      )
    ).not.toContain("private")
  })
})
