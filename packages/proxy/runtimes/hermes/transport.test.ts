import { describe, expect, it, vi } from "vitest"

import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesWebSocketRpcTransport,
  type HermesSocket,
} from "./transport"

class FakeSocket implements HermesSocket {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readyState = 0
  sent: string[] = []

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: string) {
    this.sent.push(value)
    const frame = JSON.parse(value) as { id: string }
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { profiles: [] },
        }),
      })
    )
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.emit("open", {})
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe("Hermes WebSocket RPC transport", () => {
  it("retains only native RPC error codes for explicit unsupported-command routing", async () => {
    const socket = new FakeSocket()
    socket.send = (raw) => {
      const frame = JSON.parse(raw) as { id: string }
      queueMicrotask(() =>
        socket.emit("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "private native failure" },
          }),
        })
      )
    }
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "ticket" })),
      socketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket
      },
    })
    await expect(transport.request("slash.exec", {})).rejects.toMatchObject({
      code: -32601,
      message: "Hermes RPC failed",
    })
  })
  it("observes native notifications on a server-only ticketed socket", async () => {
    const socket = new FakeSocket()
    const observed = vi.fn()
    const disconnected = vi.fn()
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "observe-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    const stop = await transport.observeEvents(observed, disconnected)
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "message.delta",
          session_id: "live-secret",
          seq: 2,
          payload: { text: "Hello" },
        },
      }),
    })
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1))
    expect(observed).toHaveBeenCalledWith({
      type: "message.delta",
      session_id: "live-secret",
      seq: 2,
      payload: { text: "Hello" },
    })
    expect(disconnected).not.toHaveBeenCalled()
    socket.emit("error", {})
    socket.emit("close", {})
    expect(disconnected).toHaveBeenCalledTimes(1)

    stop()
    expect(socket.readyState).toBe(3)
  })

  it("dispatches asynchronously decoded native notifications in arrival order", async () => {
    const socket = new FakeSocket()
    const observed = vi.fn()
    const deferredFrame = (seq: number) => {
      let resolve: (() => void) | undefined
      const ready = new Promise<void>((done) => {
        resolve = done
      })
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { type: "message.delta", session_id: "live", seq },
        })
      )
      const blob = new Blob([bytes])
      Object.defineProperty(blob, "arrayBuffer", {
        value: async () => {
          await ready
          return bytes.buffer
        },
      })
      return { blob, resolve: () => resolve?.() }
    }
    const first = deferredFrame(1)
    const second = deferredFrame(2)
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "observe-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    const stop = await transport.observeEvents(observed, vi.fn())
    socket.emit("message", { data: first.blob })
    socket.emit("message", { data: second.blob })
    second.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observed).not.toHaveBeenCalled()
    first.resolve()
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(2))
    expect(observed.mock.calls.map(([event]) => event.seq)).toEqual([1, 2])
    stop()
  })

  it("closes an observation whose asynchronous frame queue exceeds its bound", async () => {
    const socket = new FakeSocket()
    const disconnected = vi.fn()
    const pending = new Promise<ArrayBuffer>(() => undefined)
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "observe-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })
    await transport.observeEvents(vi.fn(), disconnected)
    const frame = new Blob(["{}"])
    Object.defineProperty(frame, "arrayBuffer", { value: () => pending })

    for (let index = 0; index < 65; index += 1)
      socket.emit("message", { data: frame })

    expect(socket.readyState).toBe(3)
    expect(disconnected).toHaveBeenCalledTimes(1)
  })

  it.each([404, 409])(
    "preserves native REST status %i without exposing its response body",
    async (status) => {
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://hermes.test",
        credentials: async () => ({
          "X-Hermes-Session-Token": "secret",
        }),
        fetcher: vi.fn(
          async () => new Response("/private/path token=secret", { status })
        ),
      })

      const request = transport.http("/api/sessions/missing?profile=researcher")
      await expect(request).rejects.toMatchObject({ status })
      await expect(request).rejects.toBeInstanceOf(HermesHttpError)
      await expect(request).rejects.not.toThrow("private/path")
    }
  )

  it("keeps static credentials server-side for native REST Session reads", async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [] }))
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "secret" }),
      fetcher,
    })
    await expect(
      transport.http("/api/sessions?profile=researcher")
    ).resolves.toEqual({ sessions: [] })
    expect(fetcher).toHaveBeenCalledWith(
      "http://hermes.test/api/sessions?profile=researcher",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Hermes-Session-Token": "secret",
        }),
      })
    )
  })
  it("uses the configured static token only for native ws-ticket brokerage", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ticket: "single-use-ticket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => {
      queueMicrotask(() => socket.open())
      return socket
    })
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher,
      socketFactory,
      timeoutMs: 1_000,
    })

    await expect(
      transport.request("profiles.list", { include_sessions: false })
    ).resolves.toEqual({ profiles: [] })
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/auth/ws-ticket",
      expect.objectContaining({
        method: "POST",
        headers: {
          accept: "application/json",
          "X-Hermes-Session-Token": "native-secret",
        },
      })
    )
    expect(socketFactory).toHaveBeenCalledWith("ws://127.0.0.1:9119/api/ws", [
      "hermes-gateway-v1",
      "hermes-gateway-ticket.single-use-ticket",
    ])
    expect(socket.sent).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "aos-1",
        method: "profiles.list",
        params: { include_sessions: false },
      }),
    ])
  })

  it.each([401, 403])(
    "returns a typed private authentication failure for ticket status %i",
    async (status) => {
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () => ({
          "X-Hermes-Session-Token": "native-secret",
        }),
        fetcher: vi.fn(async () => new Response("native details", { status })),
        socketFactory: vi.fn(),
        timeoutMs: 1_000,
      })
      await expect(
        transport.request("profiles.list", {})
      ).rejects.toBeInstanceOf(HermesAuthenticationError)
    }
  )

  it.each([
    [
      "declared oversized",
      () =>
        new Response(JSON.stringify({ ticket: "ignored" }), {
          headers: { "content-length": "8193" },
        }),
    ],
    [
      "chunked oversized",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4_096))
              controller.enqueue(new Uint8Array(4_097))
              controller.close()
            },
          })
        ),
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
  ])(
    "bounds %s ticket responses through the full deadline",
    async (_name, response) => {
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () => ({
          "X-Hermes-Session-Token": "native-secret",
        }),
        fetcher: vi.fn(async () => response()),
        socketFactory: vi.fn(),
        timeoutMs: 20,
      })

      await expect(transport.request("profiles.list", {})).rejects.toThrow(
        "Hermes connection failed"
      )
    }
  )

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
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => response()),
      timeoutMs: 20,
    })

    await expect(transport.http("/api/sessions")).rejects.toThrow(
      "Hermes request failed"
    )
  })

  it.each([
    ["oversized text", "x".repeat(2 * 1024 * 1024 + 1)],
    ["oversized ArrayBuffer", new ArrayBuffer(2 * 1024 * 1024 + 1)],
    ["oversized Blob", new Blob([new Uint8Array(2 * 1024 * 1024 + 1)])],
    ["malformed JSON", "{"],
    [
      "excessive depth",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: JSON.parse(`${"[".repeat(40)}null${"]".repeat(40)}`),
      }),
    ],
  ])("closes on %s native event frames", async (_name, data) => {
    const socket = new FakeSocket()
    const observed = vi.fn()
    const disconnected = vi.fn()
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "observe-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    await transport.observeEvents(observed, disconnected)
    socket.emit("message", { data })
    await vi.waitFor(() => expect(socket.readyState).toBe(3))
    expect(observed).not.toHaveBeenCalled()
    expect(disconnected).toHaveBeenCalledTimes(1)
  })

  it("clamps requested native RPC response limits to the hard frame ceiling", async () => {
    const socket = new FakeSocket()
    socket.send = () => {
      queueMicrotask(() =>
        socket.emit("message", { data: "x".repeat(2 * 1024 * 1024 + 1) })
      )
    }
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "rpc-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    await expect(
      transport.request("profiles.list", {}, Number.MAX_SAFE_INTEGER)
    ).rejects.toThrow("Hermes connection failed")
    expect(socket.readyState).toBe(3)
  })

  it("enforces a request-specific native RPC response limit", async () => {
    const socket = new FakeSocket()
    socket.send = (value) => {
      const { id } = JSON.parse(value) as { id: string }
      queueMicrotask(() =>
        socket.emit("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { value: "x".repeat(256) },
          }),
        })
      )
    }
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "rpc-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    await expect(
      transport.request("image.attach_bytes", {}, 128)
    ).rejects.toThrow("Hermes connection failed")
    expect(socket.readyState).toBe(3)
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
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => response),
      timeoutMs: 1_000,
    })

    const outcome = await transport
      .http("/api/fs/read-data-url", { maxResponseBytes: 128 })
      .then(
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
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://hermes.test",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => response),
      timeoutMs: 1_000,
    })

    await expect(
      transport.http("/api/sessions", {
        maxResponseBytes: Number.MAX_SAFE_INTEGER,
      })
    ).rejects.toThrow("Hermes request failed")
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it("settles matching asynchronous RPC frames in arrival order", async () => {
    const socket = new FakeSocket()
    socket.send = (value) => socket.sent.push(value)
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "rpc-ticket" })),
      socketFactory: vi.fn(() => {
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })
    const requestPromise = transport.request("profiles.list", {})
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const id = (JSON.parse(socket.sent[0]!) as { id: string }).id
    const deferredFrame = (frame: unknown) => {
      let resolve: (() => void) | undefined
      const ready = new Promise<void>((done) => {
        resolve = done
      })
      const bytes = new TextEncoder().encode(JSON.stringify(frame))
      const blob = new Blob([bytes])
      Object.defineProperty(blob, "arrayBuffer", {
        value: async () => {
          await ready
          return bytes.buffer
        },
      })
      return { blob, resolve: () => resolve?.() }
    }
    const first = deferredFrame({
      jsonrpc: "2.0",
      id,
      result: { profiles: ["first"] },
    })
    const second = deferredFrame({
      jsonrpc: "2.0",
      id,
      error: { message: "late" },
    })
    socket.emit("message", { data: first.blob })
    socket.emit("message", { data: second.blob })
    second.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    first.resolve()

    await expect(requestPromise).resolves.toEqual({ profiles: ["first"] })
  })

  it("cancels rejected declared-length bodies and redacts credential failures", async () => {
    const cancelled = vi.fn()
    const oversized = new Response(
      new ReadableStream<Uint8Array>({ cancel: cancelled }),
      { headers: { "content-length": "8193" } }
    )
    const ticketTransport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => oversized),
      socketFactory: vi.fn(),
      timeoutMs: 1_000,
    })
    await expect(ticketTransport.request("profiles.list", {})).rejects.toThrow(
      "Hermes connection failed"
    )
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))

    const credentialFailure = new Error(
      "token=native-secret from /srv/hermes/private"
    )
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: vi.fn(async () => {
        throw credentialFailure
      }),
      fetcher: vi.fn(),
      socketFactory: vi.fn(),
      timeoutMs: 1_000,
    })
    const rpc = transport.request("profiles.list", {})
    await expect(rpc).rejects.toThrow("Hermes connection failed")
    await expect(rpc).rejects.not.toThrow("native-secret")
    const http = transport.http("/api/sessions")
    await expect(http).rejects.toThrow("Hermes request failed")
    await expect(http).rejects.not.toThrow("/srv/hermes")
  })

  it.each([
    ["native HTTP", "Hermes request failed"],
    ["ticket brokerage", "Hermes connection failed"],
  ])(
    "includes stalled %s credentials in the deadline and discards late results",
    async (operation, expectedError) => {
      let releaseCredentials: (() => void) | undefined
      let credentialSignal: AbortSignal | undefined
      const credentialsReady = new Promise<void>((resolve) => {
        releaseCredentials = resolve
      })
      const fetcher = vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/api/auth/ws-ticket")
          ? Response.json({ ticket: "late-ticket" })
          : Response.json({ sessions: [] })
      )
      const socketFactory = vi.fn(() => {
        const socket = new FakeSocket()
        queueMicrotask(() => socket.open())
        return socket
      })
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async (signal) => {
          credentialSignal = signal
          await credentialsReady
          return { "X-Hermes-Session-Token": "late-secret" }
        },
        fetcher,
        socketFactory,
        timeoutMs: 20,
      })
      const pending =
        operation === "native HTTP"
          ? transport.http("/api/sessions")
          : transport.request("profiles.list", {})
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

      expect(outcome).toBe(expectedError)
      expect(credentialSignal).toBeInstanceOf(AbortSignal)
      expect(fetcher).not.toHaveBeenCalled()
      expect(socketFactory).not.toHaveBeenCalled()
    }
  )
})
