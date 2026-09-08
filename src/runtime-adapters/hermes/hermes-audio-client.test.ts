// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { HermesAudioClient } from "./hermes-audio-client"

const recording = () =>
  new Blob([Uint8Array.of(1, 2, 3)], { type: "audio/webm" })

function providerRow(name: string, status = "ready", isActive = true) {
  return {
    name,
    badge: "",
    tag: "",
    env_vars: [],
    post_setup: null,
    requires_nous_auth: false,
    is_active: isActive,
    status,
  }
}

function metadata(name: "stt" | "tts", status = "ready") {
  const row =
    name === "stt"
      ? {
          ...providerRow("Local Whisper", status),
          post_setup: "faster_whisper",
        }
      : { ...providerRow("Microsoft Edge TTS", status), tts_provider: "edge" }
  return {
    name,
    has_category: true,
    providers: [row],
    active_provider: row.name,
  }
}

const speechResponse = {
  ok: true,
  data_url: "data:audio/mpeg;base64,SUQzBAAA",
  mime_type: "audio/mpeg",
  provider: "edge",
}

describe("Hermes audio transport", () => {
  it("transcribes the actual recording MIME through the native profile and base path", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, transcript: "שלום", provider: "local" })
      )
    const client = new HermesAudioClient({
      baseUrl: "https://aos.test/native/hermes/",
      fetcher,
    })
    const signal = new AbortController().signal
    const recording = new Blob([Uint8Array.from([1, 2, 3])], {
      type: "audio/webm;codecs=opus",
    })

    await expect(
      client.transcribe("voice + עברית", recording, signal)
    ).resolves.toBe("שלום")

    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://aos.test/native/hermes/api/audio/transcribe?profile=voice+%2B+%D7%A2%D7%91%D7%A8%D7%99%D7%AA",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        redirect: "error",
        signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          data_url: "data:audio/webm;codecs=opus;base64,AQID",
          mime_type: "audio/webm;codecs=opus",
        }),
      })
    )
  })

  it.each(["", "A quiet pause followed by speech."])(
    "accepts a successful transcript including silence: %j",
    async (transcript) => {
      const client = new HermesAudioClient({
        baseUrl: "/hermes",
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ ok: true, transcript, provider: null })
          ),
      })

      await expect(
        client.transcribe("research", recording(), new AbortController().signal)
      ).resolves.toBe(transcript)
    }
  )

  it.each(
    [
      null,
      [],
      { transcript: "missing success" },
      { ok: false, transcript: "failed" },
      { ok: true, transcript: 5 },
      { ok: true },
    ].map((body) => ({ body }))
  )(
    "rejects malformed transcription without exposing its payload: $body",
    async ({ body }) => {
      const client = new HermesAudioClient({
        baseUrl: "/hermes",
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      })

      await expect(
        client.transcribe("research", recording(), new AbortController().signal)
      ).rejects.toMatchObject({
        name: "HermesAudioError",
        code: "invalid-response",
      })
    }
  )

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [404, "unavailable"],
    [413, "too-large"],
    [400, "unavailable"],
    [500, "unavailable"],
  ])(
    "sanitizes native HTTP %i failures without retrying",
    async (status, code) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { detail: "secret-provider-key private audio text" },
            { status }
          )
        )
      const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })
      const error = await client
        .transcribe("research", recording(), new AbortController().signal)
        .catch((error: unknown) => error)

      expect(error).toMatchObject({ name: "HermesAudioError", code })
      expect(String(error)).not.toMatch(
        /secret-provider-key|private audio text/
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it("sanitizes network failures without retrying", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private upstream URL and credential"))
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })
    const error = await client
      .transcribe("research", recording(), new AbortController().signal)
      .catch((error: unknown) => error)

    expect(error).toMatchObject({ name: "HermesAudioError", code: "network" })
    expect(String(error)).not.toContain("credential")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("rejects non-JSON native responses without echoing their contents", async () => {
    const client = new HermesAudioClient({
      baseUrl: "/hermes",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("secret HTML")),
    })

    await expect(
      client.transcribe("research", recording(), new AbortController().signal)
    ).rejects.toMatchObject({
      name: "HermesAudioError",
      code: "invalid-response",
    })
  })

  it.each(["", "text/html", "video/mp4", "audio/webm,malformed"])(
    "rejects unsupported recording MIME %j before uploading",
    async (type) => {
      const fetcher = vi.fn<typeof fetch>()
      const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

      await expect(
        client.transcribe(
          "research",
          new Blob(["recording"], { type }),
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: "invalid-recording" })
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each([
    [0, "invalid-recording"],
    [5 * 1024 * 1024 + 1, "too-large"],
  ])(
    "rejects a %i-byte recording before encoding or uploading",
    async (size, code) => {
      const fetcher = vi.fn<typeof fetch>()
      const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })
      const input = new Blob([new Uint8Array(size)], { type: "audio/webm" })
      const read = vi.spyOn(input, "arrayBuffer")

      await expect(
        client.transcribe("research", input, new AbortController().signal)
      ).rejects.toMatchObject({ code })
      expect(read).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it("does not read or send a recording after cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })
    const controller = new AbortController()
    controller.abort()
    const input = recording()
    const read = vi.spyOn(input, "arrayBuffer")

    await expect(
      client.transcribe("research", input, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(read).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("discards a recording cancelled while its bytes are being read", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })
    const controller = new AbortController()
    const input = recording()
    let finishRead!: (buffer: ArrayBuffer) => void
    vi.spyOn(input, "arrayBuffer").mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve
      })
    )

    const result = client.transcribe("research", input, controller.signal)
    controller.abort()
    finishRead(new ArrayBuffer(3))

    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("preserves cancellation during an in-flight native request", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort()
      throw controller.signal.reason
    })
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

    await expect(
      client.transcribe("research", recording(), controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("discards a successful response that arrives after cancellation", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort()
      return Response.json({ ok: true, transcript: "late", provider: "local" })
    })
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

    await expect(
      client.transcribe("research", recording(), controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("sanitizes a failed recording read before uploading", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })
    const input = recording()
    vi.spyOn(input, "arrayBuffer").mockRejectedValue(
      new Error("private source")
    )

    await expect(
      client.transcribe("research", input, new AbortController().signal)
    ).rejects.toMatchObject({
      name: "HermesAudioError",
      code: "invalid-recording",
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("keeps a maximum-size recording within the proxy JSON upload limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        transcript: "large recording",
        provider: "local",
      })
    )
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

    await expect(
      client.transcribe(
        "research",
        new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "audio/mp4" }),
        new AbortController().signal
      )
    ).resolves.toBe("large recording")
    const body = fetcher.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe("string")
    expect(new Blob([String(body)]).size).toBeLessThan(8 * 1024 * 1024)
  })

  it("never sends a request with an implicit default profile", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

    await expect(
      client.transcribe("", recording(), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("synthesizes through the same native profile and converts safe audio into a Blob", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(speechResponse))
    const client = new HermesAudioClient({
      baseUrl: "https://aos.test/hermes/",
      fetcher,
    })
    const signal = new AbortController().signal

    const audio = await client.synthesize("voice + עברית", "שלום", signal)

    expect(audio.type).toBe("audio/mpeg")
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
      Uint8Array.of(73, 68, 51, 4, 0, 0)
    )
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://aos.test/hermes/api/audio/speak?profile=voice+%2B+%D7%A2%D7%91%D7%A8%D7%99%D7%AA",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        signal,
        body: JSON.stringify({ text: "שלום" }),
      })
    )
  })

  it.each(
    [
      null,
      [],
      { ...speechResponse, ok: false },
      { ...speechResponse, mime_type: "text/html" },
      { ...speechResponse, mime_type: "audio/wav" },
      { ...speechResponse, mime_type: undefined },
      { ...speechResponse, data_url: "https://outside.test/audio.mp3" },
      { ...speechResponse, data_url: "data:text/html;base64,PHNjcmlwdD4=" },
      { ...speechResponse, data_url: "data:audio/mpeg,<script>" },
      { ...speechResponse, data_url: "data:audio/mpeg;base64,invalid!" },
      { ...speechResponse, data_url: "data:audio/mpeg;base64,A===" },
      { ...speechResponse, data_url: "data:audio/mpeg;base64," },
      { ...speechResponse, data_url: 42 },
    ].map((body) => ({ body }))
  )("rejects unsafe or malformed speech: $body", async ({ body }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

    await expect(
      client.synthesize("research", "hello", new AbortController().signal)
    ).rejects.toMatchObject({
      name: "HermesAudioError",
      code: "invalid-response",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("requests only non-secret native readiness metadata for the supplied profile", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      return Response.json(
        metadata(String(input).includes("/stt/") ? "stt" : "tts")
      )
    })
    const client = new HermesAudioClient({
      baseUrl: "https://aos.test/hermes/",
      fetcher,
    })
    const signal = new AbortController().signal

    await expect(
      client.getAvailability("voice + עברית", signal)
    ).resolves.toEqual({
      transcription: "ready",
      speech: "ready",
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const toolset of ["stt", "tts"]) {
      expect(fetcher).toHaveBeenCalledWith(
        `https://aos.test/hermes/api/tools/toolsets/${toolset}/config?profile=voice+%2B+%D7%A2%D7%91%D7%A8%D7%99%D7%AA`,
        expect.objectContaining({
          method: "GET",
          credentials: "include",
          cache: "no-store",
          signal,
        })
      )
    }
  })

  it.each(["needs_keys", "needs_auth", "needs_setup"])(
    "treats picker %s as unverified, not proof that native speech is unconfigured",
    async (status) => {
      const client = new HermesAudioClient({
        baseUrl: "/hermes",
        fetcher: vi.fn<typeof fetch>().mockImplementation(async (input) => {
          return Response.json(
            metadata(String(input).includes("/stt/") ? "stt" : "tts", status)
          )
        }),
      })

      await expect(
        client.getAvailability("research", new AbortController().signal)
      ).resolves.toEqual({
        transcription: "unverified",
        speech: "unverified",
      })
    }
  )

  it("recognizes native default Edge speech when no provider is explicitly selected", async () => {
    const client = new HermesAudioClient({
      baseUrl: "/hermes",
      fetcher: vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const value = metadata(String(input).includes("/stt/") ? "stt" : "tts")
        return Response.json({
          ...value,
          active_provider: null,
          providers: value.providers.map((row) => ({
            ...row,
            is_active: false,
          })),
        })
      }),
    })

    await expect(
      client.getAvailability("research", new AbortController().signal)
    ).resolves.toEqual({
      transcription: "unverified",
      speech: "ready",
    })
  })

  it("does not substitute another ready provider for a selected provider needing setup", async () => {
    const tts = {
      ...metadata("tts"),
      active_provider: "Piper",
      providers: [
        {
          ...providerRow("Microsoft Edge TTS", "ready", false),
          tts_provider: "edge",
        },
        {
          ...providerRow("Piper", "needs_setup"),
          tts_provider: "piper",
          post_setup: "piper",
        },
      ],
    }
    const client = new HermesAudioClient({
      baseUrl: "/hermes",
      fetcher: vi.fn<typeof fetch>().mockImplementation(async (input) => {
        return Response.json(
          String(input).includes("/stt/") ? metadata("stt") : tts
        )
      }),
    })

    await expect(
      client.getAvailability("research", new AbortController().signal)
    ).resolves.toEqual({
      transcription: "ready",
      speech: "unverified",
    })
  })

  it.each(["stt", "tts"])(
    "keeps the other readiness result after a %s metadata failure",
    async (failed) => {
      const client = new HermesAudioClient({
        baseUrl: "/hermes",
        fetcher: vi.fn<typeof fetch>().mockImplementation(async (input) => {
          if (String(input).includes(`/${failed}/`))
            throw new Error("private failure")
          return Response.json(metadata(failed === "stt" ? "tts" : "stt"))
        }),
      })

      await expect(
        client.getAvailability("research", new AbortController().signal)
      ).resolves.toEqual({
        transcription: failed === "stt" ? "unavailable" : "ready",
        speech: failed === "tts" ? "unavailable" : "ready",
      })
    }
  )

  it.each(
    [
      null,
      [],
      { ...metadata("stt"), name: "tts" },
      { ...metadata("stt"), has_category: false },
      { ...metadata("stt"), providers: {} },
      { ...metadata("stt"), active_provider: undefined },
      { ...metadata("stt"), active_provider: "missing" },
      {
        ...metadata("stt"),
        providers: [providerRow("Local Whisper", "unknown-status")],
      },
      {
        ...metadata("stt"),
        providers: [
          { ...providerRow("Local Whisper"), status: ["needs_keys"] },
        ],
      },
      {
        ...metadata("stt"),
        providers: [providerRow("Local Whisper", "ready", false)],
      },
    ].map((body) => ({ body }))
  )(
    "degrades malformed readiness metadata independently: $body",
    async ({ body }) => {
      const client = new HermesAudioClient({
        baseUrl: "/hermes",
        fetcher: vi.fn<typeof fetch>().mockImplementation(async (input) => {
          return Response.json(
            String(input).includes("/stt/") ? body : metadata("tts")
          )
        }),
      })

      await expect(
        client.getAvailability("research", new AbortController().signal)
      ).resolves.toEqual({
        transcription: "unavailable",
        speech: "ready",
      })
    }
  )

  it("propagates cancellation rather than publishing unavailable readiness", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort()
      throw controller.signal.reason
    })
    const client = new HermesAudioClient({ baseUrl: "/hermes", fetcher })

    await expect(
      client.getAvailability("research", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
