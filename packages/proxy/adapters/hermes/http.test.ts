import { describe, expect, it, vi } from "vitest"

import { createHermesHttp, HermesHttpError } from "./http"

describe("bounded Hermes HTTP", () => {
  it.each([404, 409])(
    "preserves native REST status %i without exposing its response body",
    async (status) => {
      const { http } = createHermesHttp({
        baseUrl: "http://hermes.test",
        credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
        fetcher: vi.fn(
          async () => new Response("/private/path token=secret", { status })
        ),
      })

      const request = http("/api/sessions/missing?profile=researcher")
      await expect(request).rejects.toMatchObject({ status })
      await expect(request).rejects.toBeInstanceOf(HermesHttpError)
      await expect(request).rejects.not.toThrow("private/path")
    }
  )

  it("keeps static credentials server-side for native REST Session reads", async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [] }))
    const { http } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
      fetcher,
    })

    await expect(http("/api/sessions?profile=researcher")).resolves.toEqual({
      sessions: [],
    })
    expect(fetcher).toHaveBeenCalledWith(
      "http://hermes.test/api/sessions?profile=researcher",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Hermes-Session-Token": "secret",
        }),
      })
    )
  })

  it.each([
    [
      "declared oversized",
      () =>
        new Response("{}", {
          headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        }),
    ],
    [
      "chunked oversized",
      () => {
        const chunk = new Uint8Array(1024 * 1024)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < 65; index += 1)
                controller.enqueue(chunk)
              controller.close()
            },
          })
        )
      },
    ],
    [
      "never-ending",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined)
            },
          })
        ),
    ],
  ])("bounds %s native HTTP responses", async (_name, response) => {
    const { http } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => response()),
      timeoutMs: 20,
    })

    await expect(http("/api/sessions")).rejects.toThrow("Hermes request failed")
  })

  it("cancels a native HTTP response at its request-specific byte limit", async () => {
    let pulls = 0
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1
            if (pulls === 1) {
              controller.enqueue(new Uint8Array(128))
              return
            }
            if (pulls === 2) {
              controller.enqueue(Uint8Array.of(1))
              return
            }
            controller.close()
          },
          cancel,
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-length": "1" } }
    )
    const { http } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => response),
      timeoutMs: 1_000,
    })

    const outcome = await http("/api/fs/read-data-url", {
      maxResponseBytes: 128,
    }).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : "unknown error"
    )

    expect(outcome).toBe("Hermes request failed")
    expect(cancel).toHaveBeenCalledOnce()
    expect(pulls).toBe(2)
  })

  it("clamps requested native HTTP response limits to the hard ceiling", async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"))
          controller.close()
        },
        cancel,
      }),
      { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }
    )
    const { http } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => response),
      timeoutMs: 1_000,
    })

    await expect(
      http("/api/sessions", { maxResponseBytes: Number.MAX_SAFE_INTEGER })
    ).rejects.toThrow("Hermes request failed")
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it("redacts credential failures", async () => {
    const { http } = createHermesHttp({
      baseUrl: "http://127.0.0.1:9119",
      credentials: vi.fn(async () => {
        throw new Error("token=native-secret from /srv/hermes/private")
      }),
      fetcher: vi.fn(),
      timeoutMs: 1_000,
    })

    const request = http("/api/sessions")
    await expect(request).rejects.toThrow("Hermes request failed")
    await expect(request).rejects.not.toThrow("/srv/hermes")
    await expect(request).rejects.not.toThrow("native-secret")
  })

  it("includes stalled credentials in the deadline and discards late results", async () => {
    let releaseCredentials: (() => void) | undefined
    let credentialSignal: AbortSignal | undefined
    const credentialsReady = new Promise<void>((resolve) => {
      releaseCredentials = resolve
    })
    const fetcher = vi.fn(async () => Response.json({ sessions: [] }))
    const { http } = createHermesHttp({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async (signal) => {
        credentialSignal = signal
        await credentialsReady
        return { "X-Hermes-Session-Token": "late-secret" }
      },
      fetcher,
      timeoutMs: 20,
    })

    const pending = http("/api/sessions")
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : "unknown error"
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("deadline missed"), 100)
      ),
    ])
    releaseCredentials?.()
    await pending.catch(() => undefined)

    expect(outcome).toBe("Hermes request failed")
    expect(credentialSignal).toBeInstanceOf(AbortSignal)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("returns no body for a native DELETE or 204 response", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const { http } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
      fetcher,
    })

    await expect(
      http("/api/sessions/stored", { method: "DELETE" })
    ).resolves.toBeUndefined()
  })

  it("rejects an unusable native base URL", () => {
    expect(() =>
      createHermesHttp({
        baseUrl: "ftp://hermes.test",
        credentials: async () => ({}),
      })
    ).toThrow("Invalid Hermes base URL")
  })
})
