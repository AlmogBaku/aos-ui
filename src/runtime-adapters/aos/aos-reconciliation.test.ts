import { describe, expect, it, vi } from "vitest"

import {
  AosReconciliationError,
  AosReconciler,
  type AosEventSocket,
} from "./aos-reconciliation"

class FakeSocket implements AosEventSocket {
  readonly sent: string[] = []
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>()
  readyState = 0

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.#listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.#listeners.get(type)?.delete(listener)
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
    this.emit("close", {})
  }

  open() {
    this.readyState = 1
    this.emit("open", {})
  }

  message(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) })
  }

  emit(type: string, event: unknown) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

const scope = {
  workspaceId: "operator",
  agentId: "researcher",
  sessionId: "hermes:researcher:stored",
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("AOS authoritative browser reconciliation", () => {
  it("authorizes a scoped event connection before browser WebSocket construction", async () => {
    let release!: () => void
    const authorized = new Promise<void>((resolve) => {
      release = resolve
    })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket)
    const authorizeSocket = vi.fn(() => authorized)
    const reconciler = new AosReconciler({
      socketFactory,
      authorizeSocket,
    })
    const scope = {
      workspaceId: "guest",
      agentId: "researcher",
      sessionId: "hermes:researcher:stored-session",
    }

    const read = reconciler.read(scope, async () => "history")
    await Promise.resolve()

    expect(authorizeSocket).toHaveBeenCalledWith(scope)
    expect(socketFactory).not.toHaveBeenCalled()

    release()
    await tick()
    expect(socketFactory).toHaveBeenCalledWith(scope)
    socket.open()
    await tick()
    const streamId = JSON.parse(socket.sent[0]!).streamId as string
    socket.message({
      type: "aos.ready",
      version: 1,
      streamId,
      scope,
      generation: 0,
      read: "authoritative",
    })
    await expect(read).resolves.toBe("history")
    reconciler.close()
  })

  it("subscribes and waits for ready before starting the authoritative read", async () => {
    const socket = new FakeSocket()
    const read = vi.fn(async () => "fresh")
    const reconciler = new AosReconciler({ socketFactory: () => socket })

    const result = reconciler.read(scope, read)
    socket.open()
    await tick()

    expect(read).not.toHaveBeenCalled()
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "aos.subscribe",
      scope,
    })
    const streamId = JSON.parse(socket.sent[0]!).streamId as string
    socket.message({
      type: "aos.ready",
      version: 1,
      streamId,
      scope,
      generation: 0,
      read: "authoritative",
      cursor: "opaque-cursor",
    })

    await expect(result).resolves.toBe("fresh")
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("multiplexes multiple Session scopes over one browser events socket", async () => {
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket)
    const reconciler = new AosReconciler({ socketFactory })
    const otherScope = { ...scope, sessionId: "another-session" }

    const first = reconciler.read(scope, async () => "first")
    const second = reconciler.read(otherScope, async () => "second")
    socket.open()
    await tick()

    expect(socketFactory).toHaveBeenCalledOnce()
    const subscriptions = socket.sent.map(
      (value) => JSON.parse(value) as { streamId: string; scope: typeof scope }
    )
    expect(subscriptions.map(({ scope }) => scope.sessionId)).toEqual([
      scope.sessionId,
      otherScope.sessionId,
    ])
    for (const subscription of subscriptions)
      socket.message({
        type: "aos.ready",
        version: 1,
        streamId: subscription.streamId,
        scope: subscription.scope,
        generation: 0,
        read: "authoritative",
      })

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ])
    reconciler.close()
  })

  it("discards a read overlapped by invalidation and repeats it", async () => {
    const socket = new FakeSocket()
    const first = deferred<string>()
    const read = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce("fresh")
    const reconciler = new AosReconciler({ socketFactory: () => socket })

    const result = reconciler.read(scope, read)
    socket.open()
    await tick()
    const streamId = JSON.parse(socket.sent[0]!).streamId as string
    socket.message({
      type: "aos.ready",
      version: 1,
      streamId,
      scope,
      generation: 0,
      read: "authoritative",
    })
    await tick()
    socket.message({
      type: "aos.invalidate",
      version: 1,
      streamId,
      scope,
      generation: 1,
    })
    first.resolve("stale")

    await expect(result).resolves.toBe("fresh")
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("reconnects with its cursor and performs a fresh read after interruption", async () => {
    const original = new FakeSocket()
    const replacement = new FakeSocket()
    const sockets = [original, replacement]
    const first = deferred<string>()
    const onReconnect = vi.fn(async () => undefined)
    const read = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce("after-reconnect")
    const reconciler = new AosReconciler({
      socketFactory: () => sockets.shift()!,
      onReconnect,
    })

    const result = reconciler.read(scope, read)
    original.open()
    await tick()
    const firstSubscribe = JSON.parse(original.sent[0]!) as {
      streamId: string
    }
    original.message({
      type: "aos.ready",
      version: 1,
      streamId: firstSubscribe.streamId,
      scope,
      generation: 0,
      read: "authoritative",
      cursor: "opaque-cursor",
    })
    await tick()
    original.close()
    first.resolve("stale")
    await tick()

    replacement.open()
    await tick()
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(JSON.parse(replacement.sent[0]!)).toMatchObject({
      type: "aos.subscribe",
      scope,
      cursor: "opaque-cursor",
    })
    const secondStreamId = JSON.parse(replacement.sent[0]!).streamId as string
    replacement.message({
      type: "aos.ready",
      version: 1,
      streamId: secondStreamId,
      scope,
      generation: 0,
      read: "authoritative",
    })

    await expect(result).resolves.toBe("after-reconnect")
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("surfaces authorization expiry distinctly from transport interruption", async () => {
    const socket = new FakeSocket()
    const reconciler = new AosReconciler({ socketFactory: () => socket })
    const result = reconciler.read(scope, async () => "never")
    socket.open()
    await tick()
    const streamId = JSON.parse(socket.sent[0]!).streamId as string
    socket.message({
      type: "aos.error",
      version: 1,
      streamId,
      code: "authorization_expired",
    })

    await expect(result).rejects.toEqual(
      new AosReconciliationError("aos-auth-required")
    )
  })

  it("reconnects an idle live Session stream and resubscribes with its cursor", async () => {
    const original = new FakeSocket()
    const replacement = new FakeSocket()
    const sockets = [original, replacement]
    const scheduled: Array<() => void> = []
    const onReconnect = vi.fn(async () => undefined)
    const reconciler = new AosReconciler({
      socketFactory: () => sockets.shift()!,
      onReconnect,
      schedule: (_delay, task) => scheduled.push(task),
      cancel: vi.fn(),
    })
    const result = reconciler.read(scope, async () => "fresh")
    original.open()
    await tick()
    const first = JSON.parse(original.sent[0]!) as { streamId: string }
    original.message({
      type: "aos.ready",
      version: 1,
      streamId: first.streamId,
      scope,
      generation: 0,
      read: "authoritative",
      cursor: "idle-cursor",
    })
    await expect(result).resolves.toBe("fresh")

    original.close()
    expect(scheduled).toHaveLength(1)
    scheduled.shift()!()
    replacement.open()
    await tick()

    expect(onReconnect).toHaveBeenCalledOnce()
    expect(JSON.parse(replacement.sent[0]!)).toMatchObject({
      type: "aos.subscribe",
      scope,
      cursor: "idle-cursor",
    })
    reconciler.close()
  })
})
