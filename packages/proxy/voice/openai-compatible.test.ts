// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { SessionWorkspaceCapabilitiesResponseSchema } from "../../protocol"
import {
  MAX_RECORDING_BYTES,
  MAX_SPEECH_BYTES,
  MAX_SPEECH_TEXT_BYTES,
} from "../../protocol/audio"
import {
  createOpenAiCompatibleSynthesizer,
  createOpenAiCompatibleTranscriber,
  VoiceProviderError,
} from "./openai-compatible"

type Call = { url: string; init: RequestInit }

const transcription = {
  baseUrl: "https://voice.test/v1",
  model: "whisper-1",
  timeoutMs: 5_000,
}
const speech = {
  baseUrl: "https://voice.test/v1",
  model: "tts-1",
  voice: "alloy",
  format: "mp3" as const,
  timeoutMs: 5_000,
}
const content = SessionWorkspaceCapabilitiesResponseSchema.shape.content

function recorder(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const spy = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return Promise.resolve(respond(call))
  })
  return { calls, spy, fetchImpl: spy as unknown as typeof fetch }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function rejection(operation: Promise<unknown>) {
  return operation.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error
  )
}

async function providerCode(operation: Promise<unknown>) {
  const error = await rejection(operation)
  expect(error).toBeInstanceOf(VoiceProviderError)
  return (error as VoiceProviderError).code
}

describe("createOpenAiCompatibleTranscriber", () => {
  it("posts one multipart recording and returns the transcript", async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: "hello there" }))
    const transcriber = createOpenAiCompatibleTranscriber(
      transcription,
      "secret-key",
      fetchImpl
    )

    await expect(
      transcriber.transcribe(
        new Uint8Array([1, 2, 3]),
        "audio/webm;codecs=opus"
      )
    ).resolves.toBe("hello there")

    const [call] = calls
    expect(call.url).toBe("https://voice.test/v1/audio/transcriptions")
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("error")
    expect(new Headers(call.init.headers).get("authorization")).toBe(
      "Bearer secret-key"
    )
    const form = call.init.body as FormData
    expect(form.get("model")).toBe("whisper-1")
    expect(form.get("response_format")).toBe("json")
    expect(form.get("language")).toBeNull()
    const file = form.get("file") as File
    expect(file.name).toBe("recording.webm")
    expect(file.type).toBe("audio/webm")
    expect(file.size).toBe(3)
  })

  it("omits authorization without a key and forwards a configured language", async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: "שלום" }))
    const transcriber = createOpenAiCompatibleTranscriber(
      { ...transcription, language: "he" },
      undefined,
      fetchImpl
    )

    await expect(
      transcriber.transcribe(new Uint8Array([9]), "audio/wav")
    ).resolves.toBe("שלום")

    const [call] = calls
    expect(new Headers(call.init.headers).has("authorization")).toBe(false)
    const form = call.init.body as FormData
    expect(form.get("language")).toBe("he")
    expect((form.get("file") as File).name).toBe("recording.wav")
  })

  it("rejects recordings the provider envelope does not accept", async () => {
    const { fetchImpl, spy } = recorder(() => json({ text: "no" }))
    const transcriber = createOpenAiCompatibleTranscriber(
      transcription,
      undefined,
      fetchImpl
    )
    const bytes = new Uint8Array([1])

    expect(
      await providerCode(transcriber.transcribe(bytes, "audio/x-aiff"))
    ).toBe("invalid_request")
    expect(
      await providerCode(transcriber.transcribe(bytes, "audio/webm;codecs=vp8"))
    ).toBe("invalid_request")
    expect(
      await providerCode(
        transcriber.transcribe(bytes, "audio/webm;profile=low")
      )
    ).toBe("invalid_request")
    expect(
      await providerCode(transcriber.transcribe(new Uint8Array(), "audio/webm"))
    ).toBe("invalid_request")
    expect(
      await providerCode(
        transcriber.transcribe(
          new Uint8Array(MAX_RECORDING_BYTES + 1),
          "audio/webm"
        )
      )
    ).toBe("invalid_request")
    expect(spy).not.toHaveBeenCalled()
  })

  it("keeps upstream failure text out of the raised error", async () => {
    const cancel = vi.fn()
    const { fetchImpl } = recorder(
      () =>
        new Response(
          new ReadableStream({
            cancel,
            pull(controller) {
              controller.enqueue(
                new TextEncoder().encode("upstream key sk-leak invalid")
              )
            },
          }),
          { status: 500 }
        )
    )
    const transcriber = createOpenAiCompatibleTranscriber(
      transcription,
      "secret-key",
      fetchImpl
    )

    const error = await rejection(
      transcriber.transcribe(new Uint8Array([1]), "audio/webm")
    )
    expect(error).toBeInstanceOf(VoiceProviderError)
    expect((error as VoiceProviderError).code).toBe("temporarily_unavailable")
    expect((error as Error).message).toBe("temporarily_unavailable")
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it("reports a transport failure as temporarily unavailable", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError("unexpected redirect"))
    ) as unknown as typeof fetch
    const transcriber = createOpenAiCompatibleTranscriber(
      transcription,
      undefined,
      fetchImpl
    )

    expect(
      await providerCode(
        transcriber.transcribe(new Uint8Array([1]), "audio/webm")
      )
    ).toBe("temporarily_unavailable")
  })

  it("reports an oversized or malformed transcription response as temporarily unavailable", async () => {
    const oversized = recorder(
      () => new Response(new Uint8Array(1024 * 1024 + 1))
    )
    expect(
      await providerCode(
        createOpenAiCompatibleTranscriber(
          transcription,
          undefined,
          oversized.fetchImpl
        ).transcribe(new Uint8Array([1]), "audio/webm")
      )
    ).toBe("temporarily_unavailable")

    const missing = recorder(() => json({ transcript: "wrong field" }))
    expect(
      await providerCode(
        createOpenAiCompatibleTranscriber(
          transcription,
          undefined,
          missing.fetchImpl
        ).transcribe(new Uint8Array([1]), "audio/webm")
      )
    ).toBe("temporarily_unavailable")

    const unparsable = recorder(() => new Response("not json"))
    expect(
      await providerCode(
        createOpenAiCompatibleTranscriber(
          transcription,
          undefined,
          unparsable.fetchImpl
        ).transcribe(new Uint8Array([1]), "audio/webm")
      )
    ).toBe("temporarily_unavailable")
  })

  it("rethrows the caller's abort without calling the provider", async () => {
    const { fetchImpl, spy } = recorder(() => json({ text: "no" }))
    const transcriber = createOpenAiCompatibleTranscriber(
      transcription,
      undefined,
      fetchImpl
    )
    const reason = new Error("caller stopped")
    const controller = new AbortController()
    controller.abort(reason)

    await expect(
      transcriber.transcribe(
        new Uint8Array([1]),
        "audio/webm",
        controller.signal
      )
    ).rejects.toBe(reason)
    expect(spy).not.toHaveBeenCalled()
  })

  it("reports its own timeout as temporarily unavailable", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          )
        })
    ) as unknown as typeof fetch
    const transcriber = createOpenAiCompatibleTranscriber(
      { ...transcription, timeoutMs: 5 },
      undefined,
      fetchImpl
    )

    expect(
      await providerCode(
        transcriber.transcribe(new Uint8Array([1]), "audio/webm")
      )
    ).toBe("temporarily_unavailable")
  })

  it("advertises a transcription capability the protocol accepts", () => {
    const { fetchImpl } = recorder(() => json({ text: "hello" }))
    const capability = createOpenAiCompatibleTranscriber(
      transcription,
      undefined,
      fetchImpl
    ).capability()

    expect(content.shape.transcription.safeParse(capability).success).toBe(true)
    expect(capability.scope).toBe("agent")
    expect(capability.mimeParameter).toBe("codecs")
    expect(capability.acceptedMimeTypes).toContain("audio/webm")
    expect(capability.codecValues).toContain("opus")
    expect(capability.maxRecordingBytes).toBe(MAX_RECORDING_BYTES)
  })
})

describe("createOpenAiCompatibleSynthesizer", () => {
  it("posts one speech request and labels the audio from the configured format", async () => {
    const { calls, fetchImpl } = recorder(
      () => new Response(new Uint8Array([7, 8]))
    )
    const synthesizer = createOpenAiCompatibleSynthesizer(
      speech,
      "secret-key",
      fetchImpl
    )

    await expect(synthesizer.speak("read this")).resolves.toEqual({
      bytes: new Uint8Array([7, 8]),
      mimeType: "audio/mpeg",
    })

    const [call] = calls
    expect(call.url).toBe("https://voice.test/v1/audio/speech")
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("error")
    expect(new Headers(call.init.headers).get("content-type")).toBe(
      "application/json"
    )
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "tts-1",
      input: "read this",
      voice: "alloy",
      response_format: "mp3",
    })
  })

  it("labels every format from its own table rather than the upstream header", async () => {
    for (const [format, mimeType] of [
      ["mp3", "audio/mpeg"],
      ["opus", "audio/ogg"],
      ["wav", "audio/wav"],
      ["flac", "audio/flac"],
    ] as const) {
      const { fetchImpl } = recorder(
        () =>
          new Response(new Uint8Array([1]), {
            headers: { "content-type": "text/html" },
          })
      )
      const synthesizer = createOpenAiCompatibleSynthesizer(
        { ...speech, format },
        undefined,
        fetchImpl
      )

      await expect(synthesizer.speak("read")).resolves.toEqual({
        bytes: new Uint8Array([1]),
        mimeType,
      })
      expect(synthesizer.capability().acceptedMimeTypes).toEqual([mimeType])
    }
  })

  it("rejects text outside the speech envelope", async () => {
    const { fetchImpl, spy } = recorder(() => new Response(new Uint8Array([1])))
    const synthesizer = createOpenAiCompatibleSynthesizer(
      speech,
      undefined,
      fetchImpl
    )

    expect(await providerCode(synthesizer.speak(""))).toBe("invalid_request")
    expect(
      await providerCode(
        synthesizer.speak("a".repeat(MAX_SPEECH_TEXT_BYTES + 1))
      )
    ).toBe("invalid_request")
    expect(spy).not.toHaveBeenCalled()
  })

  it("reports an oversized or failed speech response as temporarily unavailable", async () => {
    const oversized = recorder(
      () => new Response(new Uint8Array(MAX_SPEECH_BYTES + 1))
    )
    expect(
      await providerCode(
        createOpenAiCompatibleSynthesizer(
          speech,
          undefined,
          oversized.fetchImpl
        ).speak("read")
      )
    ).toBe("temporarily_unavailable")

    const failed = recorder(
      () => new Response("upstream detail", { status: 503 })
    )
    expect(
      await providerCode(
        createOpenAiCompatibleSynthesizer(
          speech,
          undefined,
          failed.fetchImpl
        ).speak("read")
      )
    ).toBe("temporarily_unavailable")
  })

  it("rethrows the caller's abort without calling the provider", async () => {
    const { fetchImpl, spy } = recorder(() => new Response(new Uint8Array([1])))
    const synthesizer = createOpenAiCompatibleSynthesizer(
      speech,
      undefined,
      fetchImpl
    )
    const reason = new Error("caller stopped")
    const controller = new AbortController()
    controller.abort(reason)

    await expect(synthesizer.speak("read", controller.signal)).rejects.toBe(
      reason
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it("advertises a speech capability the protocol accepts", () => {
    const { fetchImpl } = recorder(() => new Response(new Uint8Array([1])))
    const capability = createOpenAiCompatibleSynthesizer(
      speech,
      undefined,
      fetchImpl
    ).capability()

    expect(content.shape.speech.safeParse(capability).success).toBe(true)
    expect(capability.scope).toBe("agent")
    expect(capability.maxTextBytes).toBe(MAX_SPEECH_TEXT_BYTES)
    expect(capability.maxAudioBytes).toBe(MAX_SPEECH_BYTES)
  })
})
