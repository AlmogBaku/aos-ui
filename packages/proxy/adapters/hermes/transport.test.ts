import { describe, expect, it, vi } from "vitest"

import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesRpcError,
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
  it.each([-32601, 4018])(
    "preserves sanitized RPC error code %s for protocol fallback decisions",
    async (code) => {
      const socket = new FakeSocket()
      socket.send = (value) => socket.sent.push(value)
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () => ({
          "X-Hermes-Session-Token": "native-secret",
        }),
        fetcher: vi.fn(async () => Response.json({ ticket: "ticket" })),
        socketFactory: () => {
          queueMicrotask(() => socket.open())
          return socket
        },
        timeoutMs: 1_000,
      })

      const request = transport.request("slash.exec", {})
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
      const { id } = JSON.parse(socket.sent[0]!) as { id: string }
      socket.emit("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code, message: "native secret detail" },
        }),
      })

      await expect(request).rejects.toEqual(new HermesRpcError(code))
      await expect(request).rejects.not.toThrow("native secret detail")
    }
  )

  it("correlates concurrent out-of-order replies on one persistent socket", async () => {
    const socket = new FakeSocket()
    socket.send = (value) => socket.sent.push(value)
    const factory = vi.fn(() => {
      queueMicrotask(() => socket.open())
      return socket
    })
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "ticket" })),
      socketFactory: factory,
      timeoutMs: 1_000,
    })

    const first = transport.request("profiles.list", {})
    const second = transport.request("session.events.since", {
      session_id: "a",
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(factory).toHaveBeenCalledTimes(1)
    const [firstFrame, secondFrame] = socket.sent.map(
      (value) => JSON.parse(value) as { id: string }
    )
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: secondFrame!.id,
        result: "second",
      }),
    })
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: firstFrame!.id,
        result: "first",
      }),
    })

    await expect(first).resolves.toBe("first")
    await expect(second).resolves.toBe("second")
    expect(socket.readyState).toBe(1)
  })

  it("reauthenticates after loss and never replays an uncertain mutation", async () => {
    const sockets: FakeSocket[] = []
    const credentials = vi.fn(async () => ({
      "X-Hermes-Session-Token": "native-secret",
    }))
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials,
      socketFactory: vi.fn(() => {
        const socket = new FakeSocket()
        socket.send = (value) => socket.sent.push(value)
        sockets.push(socket)
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    const mutation = transport.request("prompt.submit", {
      session_id: "live-a",
      text: "once",
    })
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
    sockets[0]!.emit("close", {})
    await expect(mutation).rejects.toThrow("Hermes connection failed")

    const read = transport.request("profiles.list", {})
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(sockets[0]!.sent).toHaveLength(1)
    const frame = JSON.parse(sockets[1]!.sent[0]!) as { id: string }
    sockets[1]!.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: { profiles: [] },
      }),
    })
    await expect(read).resolves.toEqual({ profiles: [] })
    expect(credentials).toHaveBeenCalledTimes(2)
  })

  it("uses one socket for one hundred concurrent Session requests", async () => {
    const socket = new FakeSocket()
    const factory = vi.fn(() => {
      queueMicrotask(() => socket.open())
      return socket
    })
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "ticket" })),
      socketFactory: factory,
      timeoutMs: 1_000,
    })

    await expect(
      Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          transport.request("session.events.since", {
            session_id: `live-${index}`,
          })
        )
      )
    ).resolves.toHaveLength(100)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("keeps the prompt socket bound and forwards its post-ack events to observers", async () => {
    const sockets: FakeSocket[] = []
    const observed = vi.fn()
    const transport = new HermesWebSocketRpcTransport({
      baseUrl: "http://127.0.0.1:9119",
      credentials: async () => ({ "X-Hermes-Session-Token": "native-secret" }),
      fetcher: vi.fn(async () => Response.json({ ticket: "ticket" })),
      socketFactory: vi.fn(() => {
        const socket = new FakeSocket()
        socket.send = (value) => socket.sent.push(value)
        sockets.push(socket)
        queueMicrotask(() => socket.open())
        return socket
      }),
      timeoutMs: 1_000,
    })

    const stop = await transport.observeEvents(observed, vi.fn())
    const submitted = transport.request("prompt.submit", {
      session_id: "live-secret",
      text: "Hello",
    })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const promptSocket = sockets[0]!
    await vi.waitFor(() => expect(promptSocket.sent).toHaveLength(1))
    const { id } = JSON.parse(promptSocket.sent[0]!) as { id: string }
    promptSocket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { status: "streaming" },
      }),
    })

    await expect(submitted).resolves.toEqual({ status: "streaming" })
    expect(promptSocket.readyState).toBe(1)

    for (const [seq, type, payload] of [
      [1, "message.start", { message_id: "reply" }],
      [2, "message.delta", { text: "Hi" }],
      [3, "message.complete", {}],
    ] as const)
      promptSocket.emit("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: {
            type,
            ...(type === "message.complete"
              ? {}
              : { session_id: "live-secret" }),
            seq,
            payload,
          },
        }),
      })

    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(3))
    expect(observed.mock.calls.map(([event]) => event.type)).toEqual([
      "message.start",
      "message.delta",
      "message.complete",
    ])
    expect(observed.mock.calls[2]![0]).toMatchObject({
      type: "message.complete",
    })
    expect(promptSocket.readyState).toBe(1)
    stop()
  })

  it("observes native notifications on the server-token socket", async () => {
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

    for (let index = 0; index < 257; index += 1)
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
  it("uses the configured static token directly for the server-side socket", async () => {
    const fetcher = vi.fn()
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
    expect(fetcher).not.toHaveBeenCalled()
    expect(socketFactory).toHaveBeenCalledWith(
      "ws://127.0.0.1:9119/api/ws?token=native-secret",
      []
    )
    expect(socket.sent).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "aos-1",
        method: "profiles.list",
        params: { include_sessions: false },
      }),
    ])
  })

  it.each([undefined, "", "line\nbreak"])(
    "returns a typed private authentication failure for invalid server token %j",
    async (token) => {
      const transport = new HermesWebSocketRpcTransport({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () =>
          token === undefined ? {} : { "X-Hermes-Session-Token": token },
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

  it("redacts credential failures", async () => {
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
    ["native WebSocket", "Hermes connection failed"],
  ])(
    "includes stalled %s credentials in the deadline and discards late results",
    async (operation, expectedError) => {
      let releaseCredentials: (() => void) | undefined
      let credentialSignal: AbortSignal | undefined
      const credentialsReady = new Promise<void>((resolve) => {
        releaseCredentials = resolve
      })
      const fetcher = vi.fn(async () => Response.json({ sessions: [] }))
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
