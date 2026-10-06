import { describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../../test/support/fake-clock"
import {
  createHermesHttp,
  HermesAuthenticationError,
  HermesHttpError,
  type HermesHttp,
} from "./http"

describe("bounded Hermes HTTP", () => {
  it.each([403, 404, 409])(
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

  it("maps only a native 401 to a Hermes authentication failure", async () => {
    // Hermes answers 401 for a rejected dashboard credential and 403 for a file
    // it refuses on its own merits, so collapsing the two would report a
    // working gateway token as broken.
    const refusing = (status: number) =>
      createHermesHttp({
        baseUrl: "http://hermes.test",
        credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
        fetcher: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                detail: "Access to sensitive files is not allowed",
              }),
              { status }
            )
        ),
      }).http("/api/fs/read-data-url?path=%2Fsynthetic%2Fcache%2Ftts.mp3")

    await expect(refusing(401)).rejects.toBeInstanceOf(
      HermesAuthenticationError
    )
    const refused = refusing(403)
    await expect(refused).rejects.toBeInstanceOf(HermesHttpError)
    await expect(refused).rejects.not.toBeInstanceOf(HermesAuthenticationError)
    await expect(refused).rejects.toMatchObject({ status: 403 })
  })

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

  it.each([
    ["an HTTP read", (native: HermesHttp) => native.http("/api/sessions")],
    [
      "a stream",
      (native: HermesHttp) =>
        native.stream("/api/fs/download", {
          signal: new AbortController().signal,
        }),
    ],
  ])("redacts credential failures from %s", async (_name, send) => {
    const native = createHermesHttp({
      baseUrl: "http://127.0.0.1:9119",
      credentials: vi.fn(async () => {
        throw new Error("token=native-secret from /srv/hermes/private")
      }),
      fetcher: vi.fn(),
      timeoutMs: 1_000,
    })

    const request = send(native)
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

  it("gives a call its own deadline in place of the client's", async () => {
    const clock = useFakeClock()
    const sent: AbortSignal[] = []
    const { http } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
      fetcher: ((_input: string | URL | Request, init?: RequestInit) => {
        sent.push(init!.signal!)
        return new Promise<Response>(() => undefined)
      }) as typeof fetch,
      timeoutMs: 1_000,
    })

    let failure: unknown
    http("/api/audio/speak", { method: "POST", timeoutMs: 5_000 }).catch(
      (error: unknown) => {
        failure = error
      }
    )
    await clock.advance(1_000)
    expect(sent[0]?.aborted).toBe(false)
    expect(failure).toBeUndefined()
    await clock.advance(4_000)
    expect(sent[0]?.aborted).toBe(true)
    expect(failure).toBeInstanceOf(Error)
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

  it("bounds only the wait for a stream's headers, never its body", async () => {
    const clock = useFakeClock()
    const sent: AbortSignal[] = []
    const { stream } = createHermesHttp({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push(init!.signal!)
        // A Hermes that never answers, then a body that never ends.
        if (String(input).endsWith("/stalled"))
          return new Promise<Response>(() => undefined)
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
          { status: 206 }
        )
      }) as typeof fetch,
      timeoutMs: 1_000,
    })
    const caller = new AbortController()

    let stalled: unknown
    stream("/stalled", { signal: caller.signal }).catch((error: unknown) => {
      stalled = error
    })
    await clock.advance(1_000)
    expect(stalled).toMatchObject({ message: "Hermes request failed" })
    expect(sent[0]?.aborted).toBe(true)

    const response = await stream("/api/fs/download", { signal: caller.signal })
    await clock.advance(2_000)
    expect(response.status).toBe(206)
    expect(sent[1]?.aborted).toBe(false)
    caller.abort()
    expect(sent[1]?.aborted).toBe(true)
  })
})
