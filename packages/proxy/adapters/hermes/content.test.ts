import { describe, expect, it, vi } from "vitest"

import {
  HermesContentCleanupRequiredError,
  HermesContentScopeError,
  HermesContentUnavailableError,
  createHermesContentOperations,
} from "./content"

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
    expect(h.request).toHaveBeenNthCalledWith(
      1,
      "image.attach_bytes",
      {
        session_id: "live-private-1",
        content_base64: png,
        filename: "image.png",
      },
      65_536
    )
    expect(h.request).toHaveBeenNthCalledWith(
      2,
      "file.attach",
      {
        session_id: "live-private-1",
        data_url: text,
        name: "notes.txt",
      },
      65_536
    )
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
    expect(h.request).toHaveBeenLastCalledWith(
      "image.detach",
      {
        session_id: "live-private-1",
        path: "/private/a.png",
      },
      65_536
    )
  })

  it("retains only a retryable cleanup handle when image rollback fails", async () => {
    let detachFails = true
    const h = harness({
      request(method) {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/private/a.png" }
        if (method === "file.attach") return { attached: false }
        if (method === "image.detach") {
          if (detachFails) throw new Error("native /private/a.png failure body")
          return { detached: true }
        }
      },
    })
    let failure: unknown
    try {
      await h.operations.stage("research", "session-public-1", [
        { type: "image", dataUrl: png },
        { type: "file", dataUrl: text, mimeType: "text/plain" },
      ])
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(HermesContentCleanupRequiredError)
    expect(JSON.stringify(failure)).not.toContain("/private")
    await expect(
      h.operations.stage("research", "session-public-1", [])
    ).rejects.toBeInstanceOf(HermesContentCleanupRequiredError)
    detachFails = false
    await (failure as HermesContentCleanupRequiredError).retry()
    await expect(
      h.operations.stage("research", "session-public-1", [])
    ).resolves.toMatchObject({ public: [] })
  })

  it("requires an exact native detach acknowledgement before releasing cleanup fencing", async () => {
    for (const detachResult of [
      undefined,
      {},
      { detached: false },
      { detached: true, path: "/private/a.png" },
    ]) {
      const h = harness({
        request(method) {
          if (method === "image.attach_bytes")
            return { attached: true, path: "/private/a.png" }
          if (method === "file.attach") return { attached: false }
          if (method === "image.detach") return detachResult
        },
      })
      await expect(
        h.operations.stage("research", "session-public-1", [
          { type: "image", dataUrl: png },
          { type: "file", dataUrl: text, mimeType: "text/plain" },
        ])
      ).rejects.toBeInstanceOf(HermesContentCleanupRequiredError)
      await expect(
        h.operations.stage("research", "session-public-1", [])
      ).rejects.toBeInstanceOf(HermesContentCleanupRequiredError)
    }

    let detached = false
    const h = harness({
      request(method) {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/private/a.png" }
        if (method === "file.attach") return { attached: false }
        if (method === "image.detach") return { detached }
      },
    })
    let failure: unknown
    try {
      await h.operations.stage("research", "session-public-1", [
        { type: "image", dataUrl: png },
        { type: "file", dataUrl: text, mimeType: "text/plain" },
      ])
    } catch (error) {
      failure = error
    }
    detached = true
    await (failure as HermesContentCleanupRequiredError).retry()
    await expect(
      h.operations.stage("research", "session-public-1", [])
    ).resolves.toMatchObject({ public: [] })
  })

  it("reports exact per-operation capabilities and unavailable transport reasons", async () => {
    const h = harness()
    expect(h.operations.capabilities()).toMatchObject({
      attachments: {
        status: "available",
        scope: "attached-session",
        maxCount: 16,
        maxImageBytes: 26_214_400,
        maxFileBytes: 26_214_400,
        maxTotalBytes: 26_214_400,
        maxMimeTypeBytes: 256,
        maxFilenameBytes: 255,
        imageMimeTypes: [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "image/bmp",
        ],
      },
      artifacts: {
        status: "available",
        scope: "session",
        maxBytes: 26_214_400,
      },
      transcription: {
        scope: "agent",
        maxRecordingBytes: 5_242_880,
        maxTranscriptBytes: 1_000_000,
        acceptedMimeTypes: [
          "audio/aac",
          "audio/flac",
          "audio/m4a",
          "audio/mp3",
          "audio/mp4",
          "audio/mpeg",
          "audio/ogg",
          "audio/wav",
          "audio/wave",
          "audio/webm",
          "audio/x-m4a",
          "audio/x-wav",
          "video/webm",
        ],
        mimeParameter: "codecs",
        codecValues: [
          "aac",
          "flac",
          "mp3",
          "mp4a.40.2",
          "opus",
          "pcm",
          "vorbis",
        ],
      },
      speech: {
        scope: "agent",
        maxTextBytes: 32_000,
        maxAudioBytes: 20_971_520,
      },
    })
    const operations = createHermesContentOperations({
      authority: { requireSession: h.requireSession } as never,
      transport: { request: h.request } as never,
    })
    expect(operations.capabilities()).toMatchObject({
      transcription: {
        status: "unavailable",
        reason: "native-transcription-unavailable",
      },
      speech: { status: "unavailable", reason: "native-speech-unavailable" },
    })
    await expect(
      operations.audio("research", "session-public-1")
    ).resolves.toEqual({
      transcription: {
        status: "unavailable",
        reason: "native-audio-config-unavailable",
      },
      speech: {
        status: "unavailable",
        reason: "native-audio-config-unavailable",
      },
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

  it("validates the complete attachment batch and aggregate budget before staging any file", async () => {
    const h = harness()
    const aggregate = `data:application/octet-stream;base64,${"A".repeat(
      18_175_320
    )}`
    for (const attachments of [
      [
        { type: "file" as const, dataUrl: text, mimeType: "text/plain" },
        { type: "image" as const, dataUrl: "data:image/png;base64,%%%" },
      ],
      [
        {
          type: "file" as const,
          dataUrl: aggregate,
          mimeType: "application/octet-stream",
        },
        {
          type: "file" as const,
          dataUrl: aggregate,
          mimeType: "application/octet-stream",
        },
      ],
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
      26_214_400,
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
      transcription: { status: "unverified", reason: "native-needs-setup" },
      speech: { status: "ready" },
    })
    expect(h.audioConfig).toHaveBeenCalledWith(scope, "stt", 65_536)
    expect(h.audioConfig).toHaveBeenCalledWith(scope, "tts", 65_536)
  })

  it("bounds native audio provider rows before adapting readiness", async () => {
    const h = harness({
      audioConfig: (kind) => ({
        name: kind,
        has_category: true,
        active_provider: null,
        providers: Array.from({ length: 33 }, () => ({
          name: "native",
          is_active: false,
          status: "ready",
        })),
      }),
    })
    await expect(
      h.operations.audio("research", "session-public-1")
    ).resolves.toEqual({
      transcription: {
        status: "unavailable",
        reason: "native-audio-config-invalid",
      },
      speech: {
        status: "unavailable",
        reason: "native-audio-config-invalid",
      },
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
      transcription: {
        status: "unavailable",
        reason: "native-audio-config-invalid",
      },
      speech: {
        status: "unavailable",
        reason: "native-audio-config-invalid",
      },
    })
  })

  it("encodes a bounded recording only after authorization and never exposes provider output", async () => {
    const h = harness()
    await expect(
      h.operations.transcribe(
        "research",
        Uint8Array.of(1, 2, 3),
        "audio/webm;codecs=opus"
      )
    ).resolves.toBe("transcript")
    expect(h.transcribe).toHaveBeenCalledWith(
      { agentId: "research" },
      {
        data_url: "data:audio/webm;codecs=opus;base64,AQID",
        mime_type: "audio/webm;codecs=opus",
      },
      undefined,
      1_000_000
    )
  })

  it("rejects unsupported and oversized recordings before forwarding", async () => {
    const h = harness()
    await expect(
      h.operations.transcribe("research", Uint8Array.of(1), "text/plain")
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    await expect(
      h.operations.transcribe(
        "research",
        new Uint8Array(5_242_881),
        "audio/webm"
      )
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it("allows only one bounded safe codecs parameter in recording MIME", async () => {
    const h = harness()
    for (const mimeType of [
      "audio/webm;codecs=opus;foo=bar",
      "audio/webm;codec=opus",
      'audio/webm;codecs="opus"',
      "audio/webm;codecs=opus,vorbis",
      "audio/webm;codecs=opus\r\nX-Injected: yes",
      `audio/webm;codecs=${"a".repeat(129)}`,
    ])
      await expect(
        h.operations.transcribe("research", Uint8Array.of(1), mimeType)
      ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it("uses UTF-8 byte limits rather than character counts", async () => {
    const h = harness()
    await expect(
      h.operations.stage("research", "session-public-1", [
        { type: "image", dataUrl: png, filename: "🙂".repeat(100) },
      ])
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    await expect(
      h.operations.speak("research", "🙂".repeat(8_001))
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
    expect(h.request).not.toHaveBeenCalled()
    expect(h.speak).not.toHaveBeenCalled()
  })

  it("rejects an oversized multibyte native transcript without exposing its body", async () => {
    const h = harness({
      transcribe: { ok: true, transcript: "🙂".repeat(250_001) },
    })
    await expect(
      h.operations.transcribe("research", Uint8Array.of(1), "audio/webm")
    ).rejects.toBeInstanceOf(HermesContentUnavailableError)
  })

  it("rejects pre-aborted audio without authority or transport I/O", async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness()
    await expect(
      h.operations.transcribe(
        "research",
        Uint8Array.of(1),
        "audio/webm",
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    await expect(
      h.operations.speak("research", "hello", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(h.requireSession).not.toHaveBeenCalled()
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.speak).not.toHaveBeenCalled()
  })

  it("ignores a late transcription response after cancellation", async () => {
    let resolve: ((value: unknown) => void) | undefined
    const h = harness()
    h.transcribe.mockImplementationOnce(
      async () =>
        new Promise<unknown>((next) => {
          resolve = next
        })
    )
    const controller = new AbortController()
    const pending = h.operations.transcribe(
      "research",
      Uint8Array.of(1),
      "audio/webm",
      controller.signal
    )
    await vi.waitFor(() => expect(h.transcribe).toHaveBeenCalledOnce())
    controller.abort()
    resolve?.({ ok: true, transcript: "late provider response" })
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("ignores a late speech response after cancellation", async () => {
    let resolve: ((value: unknown) => void) | undefined
    const h = harness()
    h.speak.mockImplementationOnce(
      async () =>
        new Promise<unknown>((next) => {
          resolve = next
        })
    )
    const controller = new AbortController()
    const pending = h.operations.speak("research", "hello", controller.signal)
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledOnce())
    controller.abort()
    resolve?.({
      ok: true,
      data_url: "data:audio/mpeg;base64,AQID",
      mime_type: "audio/mpeg",
    })
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("accepts only bounded valid native speech and removes provider metadata", async () => {
    const h = harness()
    await expect(h.operations.speak("research", "hello")).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: "audio/mpeg",
    })
    await expect(h.operations.speak("research", " ")).rejects.toBeInstanceOf(
      HermesContentUnavailableError
    )
    expect(
      JSON.stringify(await h.operations.speak("research", "again"))
    ).not.toContain("private")
    expect(h.speak).toHaveBeenLastCalledWith(
      { agentId: "research" },
      "again",
      undefined,
      27_962_540
    )
  })
})
