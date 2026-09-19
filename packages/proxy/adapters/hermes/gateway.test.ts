import { afterEach, describe, expect, it, vi } from "vitest"

import {
  HermesAuthenticationError,
  HermesGateway,
  HermesRequestAbortedError,
  HermesRpcRejectedError,
  HermesRpcUncertainError,
  HermesUnavailableError,
  type HermesGatewayOptions,
} from "./gateway"
import { MAX_EVENT_FRAME_BYTES } from "./gateway-socket"
import { FakeSocket } from "./test-utils/fake-socket"
import { nativeTurn } from "./test-utils/native-events"

const TOKEN = "native-secret"
const BASE_URL = "http://127.0.0.1:9119"
const WS_URL = "ws://127.0.0.1:9119/api/ws?token=native-secret"

type Harness = {
  gateway: HermesGateway
  sockets: FakeSocket[]
  factory: ReturnType<typeof vi.fn>
  log: { warn: ReturnType<typeof vi.fn> }
  control: { autoOpen: boolean; autoReply: boolean; autoReady: boolean }
}

function harness(
  options: Partial<HermesGatewayOptions> & {
    autoOpen?: boolean
    autoReply?: boolean
    /** Announce a replay epoch on open, the way a live Hermes does. */
    autoReady?: boolean
  } = {}
): Harness {
  const { autoOpen, autoReply, autoReady, ...gatewayOptions } = options
  const sockets: FakeSocket[] = []
  const control = {
    autoOpen: autoOpen ?? true,
    autoReply: autoReply ?? false,
    autoReady: autoReady ?? false,
  }
  const factory = vi.fn(() => {
    const socket = new FakeSocket()
    socket.autoReply = control.autoReply
    sockets.push(socket)
    if (control.autoOpen)
      queueMicrotask(() => {
        socket.open()
        if (control.autoReady) socket.deliverReady({ replay_epoch: "e1" })
      })
    return socket
  })
  const log = { warn: vi.fn() }
  const gateway = new HermesGateway({
    baseUrl: BASE_URL,
    credentials: async () => ({ "X-Hermes-Session-Token": TOKEN }),
    fetcher: vi.fn(),
    socketFactory: factory,
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    log,
    ...gatewayOptions,
  })
  return {
    gateway,
    sockets,
    factory,
    log,
    control,
  }
}

/** Flush pending microtasks (and any zero-delay timers under fake timers). */
async function flush() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

/**
 * Decoded client frames written after the initial client.capabilities
 * announcement. Every socket sends that announcement first; user frames follow.
 */
function announced(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.requests().slice(1)
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Hermes gateway dial and authentication", () => {
  it("dials the token URL and writes correlated JSON-RPC frames", async () => {
    const { gateway, sockets, factory } = harness({
      autoReply: true,
      autoReady: true,
    })

    await expect(
      gateway.request("profiles.list", { include_sessions: false })
    ).resolves.toEqual({ profiles: [] })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(WS_URL)
    expect(sockets[0]!.sent[0]).toEqual(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "aos-1",
        method: "client.capabilities",
        params: { server_requests: true },
      })
    )
    expect(sockets[0]!.sent[1]).toEqual(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "aos-2",
        method: "profiles.list",
        params: { include_sessions: false },
      })
    )
    await gateway.close()
  })

  it.each([undefined, "", "line\nbreak"])(
    "returns a typed private authentication failure for invalid server token %j",
    async (token) => {
      const factory = vi.fn()
      const gateway = new HermesGateway({
        baseUrl: BASE_URL,
        credentials: async () =>
          token === undefined ? {} : { "X-Hermes-Session-Token": token },
        socketFactory: factory,
        connectTimeoutMs: 50,
      })

      await expect(gateway.connect()).rejects.toBeInstanceOf(
        HermesAuthenticationError
      )
      await expect(gateway.request("profiles.list", {})).rejects.toBeInstanceOf(
        HermesAuthenticationError
      )
      expect(factory).not.toHaveBeenCalled()
      await gateway.close()
    }
  )

  it("keeps the server token out of every error message and log field", async () => {
    const { gateway, sockets, log } = harness()
    await gateway.connect()
    const failures: unknown[] = []
    const capture = (error: unknown) => failures.push(error)

    await gateway.request("prompt.submit", { text: "x" }).catch(capture)
    sockets[0]!.deliverText("{")
    sockets[0]!.close(4401)
    await gateway.request("profiles.list", {}).catch(capture)
    await gateway.close()

    const serialized = JSON.stringify([
      log.warn.mock.calls,
      failures.map((error) =>
        error instanceof Error ? [error.name, error.message] : String(error)
      ),
    ])
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain("127.0.0.1")
    expect(serialized).not.toContain("api/ws")
    expect(log.warn).toHaveBeenCalled()
  })

  it("reports a stalled credential read as unavailable without dialling", async () => {
    let releaseCredentials: (() => void) | undefined
    let credentialSignal: AbortSignal | undefined
    const ready = new Promise<void>((resolve) => {
      releaseCredentials = resolve
    })
    const factory = vi.fn()
    const gateway = new HermesGateway({
      baseUrl: BASE_URL,
      credentials: async (signal) => {
        credentialSignal = signal
        await ready
        return { "X-Hermes-Session-Token": "late-secret" }
      },
      socketFactory: factory,
      connectTimeoutMs: 20,
    })

    const pending = gateway.request("profiles.list", {})
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error: unknown) => (error as Error).name
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("deadline missed"), 200)
      ),
    ])
    releaseCredentials?.()
    await pending.catch(() => undefined)

    expect(outcome).toBe("HermesUnavailableError")
    expect(credentialSignal).toBeInstanceOf(AbortSignal)
    expect(factory).not.toHaveBeenCalled()
    await gateway.close()
  })

  it.each([4401, 4403])(
    "stops redialling after authentication close %d and reports it",
    async (code) => {
      vi.useFakeTimers()
      const { gateway, sockets, factory } = harness()
      await gateway.connect()

      sockets[0]!.close(code)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(factory).toHaveBeenCalledTimes(1)
      await expect(gateway.request("profiles.list", {})).rejects.toBeInstanceOf(
        HermesAuthenticationError
      )
      await gateway.close()
    }
  )
})

describe("Hermes gateway request classification", () => {
  it.each([-32601, 4018])(
    "preserves sanitized RPC error code %s without native detail",
    async (code) => {
      const { gateway, sockets } = harness()
      await gateway.connect()

      const request = gateway.request("slash.exec", {})
      await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
      const { id } = sockets[0]!.lastRequest() as { id: string }
      sockets[0]!.replyError(id, { code, message: "native secret detail" })

      await expect(request).rejects.toEqual(new HermesRpcRejectedError(code))
      await expect(request).rejects.not.toThrow("native secret detail")
      await gateway.close()
    }
  )

  it("correlates concurrent out-of-order replies on one persistent socket", async () => {
    const { gateway, sockets, factory } = harness()
    await gateway.connect()

    const first = gateway.request("profiles.list", {})
    const second = gateway.request("session.events.since", { session_id: "a" })
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(3))
    expect(factory).toHaveBeenCalledTimes(1)
    const [firstFrame, secondFrame] = announced(sockets[0]!) as Array<{
      id: string
    }>
    sockets[0]!.reply(secondFrame!.id, "second")
    sockets[0]!.reply(firstFrame!.id, "first")

    await expect(first).resolves.toBe("first")
    await expect(second).resolves.toBe("second")
    expect(sockets[0]!.readyState).toBe(1)
    await gateway.close()
  })

  it("uses one socket for one hundred concurrent Session requests", async () => {
    const { gateway, sockets, factory } = harness({
      autoReply: true,
      autoReady: true,
    })

    await expect(
      Promise.all(
        Array.from({ length: 100 }, (_unused, index) =>
          gateway.request("session.events.since", {
            session_id: `live-${index}`,
          })
        )
      )
    ).resolves.toHaveLength(100)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    await gateway.close()
  })

  it("never re-sends an uncertain mutation on the socket that replaced it", async () => {
    const credentials = vi.fn(async () => ({
      "X-Hermes-Session-Token": TOKEN,
    }))
    const { gateway, sockets, factory } = harness({ credentials })
    await gateway.connect()

    const mutation = gateway.request("prompt.submit", {
      session_id: "live-a",
      text: "once",
    })
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(2))
    sockets[0]!.close(1006)
    await expect(mutation).rejects.toBeInstanceOf(HermesRpcUncertainError)

    const read = gateway.request("profiles.list", {})
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sockets[1]!.sent).toHaveLength(2))
    const { id } = sockets[1]!.lastRequest() as { id: string }
    sockets[1]!.reply(id, { profiles: [] })
    await expect(read).resolves.toEqual({ profiles: [] })
    expect(sockets[0]!.sent).toHaveLength(2)
    expect(sockets[1]!.requestsFor("prompt.submit")).toEqual([])
    expect(credentials.mock.calls.length).toBeGreaterThanOrEqual(2)
    await gateway.close()
  })

  it("classifies a request timeout as uncertain and never retries it", async () => {
    vi.useFakeTimers()
    const { gateway, sockets } = harness({ requestTimeoutMs: 1_000 })
    await gateway.connect()

    const outcome = gateway
      .request("session.interrupt", { session_id: "live-a" })
      .then(
        () => "resolved",
        (error: unknown) => (error as Error).name
      )
    await flush()
    expect(sockets[0]!.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(outcome).resolves.toBe("HermesRpcUncertainError")
    expect(sockets[0]!.sent).toHaveLength(2)
    await gateway.close()
  })

  it("reports an unopened socket as unavailable without writing anything", async () => {
    vi.useFakeTimers()
    const { gateway, sockets } = harness({
      autoOpen: false,
      connectTimeoutMs: 500,
    })

    const pending = gateway.request("profiles.list", {})
    const outcome = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(600)

    await expect(outcome).resolves.toBeInstanceOf(HermesUnavailableError)
    expect(sockets[0]!.sent).toEqual([])
    await gateway.close()
  })

  it("aborts a request through the caller signal and writes nothing after it", async () => {
    const { gateway, sockets } = harness()
    await gateway.connect()
    const controller = new AbortController()

    const pending = gateway.request(
      "session.events.since",
      { session_id: "live-a" },
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(2))
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(HermesRequestAbortedError)
    expect(sockets[0]!.sent).toHaveLength(2)
    expect(sockets[0]!.readyState).toBe(1)
    await gateway.close()
  })

  it("aborts a request that is still waiting for an open socket", async () => {
    const { gateway, sockets } = harness({
      autoOpen: false,
      connectTimeoutMs: 30_000,
    })
    const controller = new AbortController()

    const pending = gateway.request(
      "profiles.list",
      {},
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(HermesRequestAbortedError)
    expect(sockets[0]!.sent).toEqual([])
    await gateway.close()
  })

  it("refuses a request beyond the in-flight bound without writing it", async () => {
    const { gateway, sockets } = harness({ requestTimeoutMs: 120_000 })
    await gateway.connect()

    // Capabilities is written to the socket but does not count toward the
    // in-flight bound (it bypasses HermesGateway.request); all 256 user
    // requests fit, and the 257th is refused without being written.
    const inFlight = Array.from({ length: 256 }, (_unused, index) =>
      gateway.request("session.events.since", { session_id: `live-${index}` })
    )
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(257))

    await expect(gateway.request("profiles.list", {})).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
    expect(sockets[0]!.sent).toHaveLength(257)

    await gateway.close()
    await Promise.allSettled(inFlight)
  })
})

describe("Hermes gateway response bounds", () => {
  it("rejects only the request whose reply exceeds its own bound", async () => {
    const { gateway, sockets } = harness()
    await gateway.connect()

    const bounded = gateway.request(
      "image.attach_bytes",
      {},
      { maxResponseBytes: 128 }
    )
    const other = gateway.request("profiles.list", {})
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(3))
    const [boundedFrame, otherFrame] = announced(sockets[0]!) as Array<{
      id: string
    }>
    sockets[0]!.reply(boundedFrame!.id, { value: "x".repeat(256) })
    sockets[0]!.reply(otherFrame!.id, { profiles: [] })

    await expect(bounded).rejects.toBeInstanceOf(HermesUnavailableError)
    await expect(other).resolves.toEqual({ profiles: [] })
    expect(sockets[0]!.readyState).toBe(1)
    await gateway.close()
  })

  it("clamps a requested bound to the hard frame ceiling", async () => {
    const { gateway, sockets } = harness()
    await gateway.connect()

    const request = gateway.request(
      "session.events.since",
      { session_id: "live-a" },
      { maxResponseBytes: Number.MAX_SAFE_INTEGER }
    )
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
    const { id } = sockets[0]!.lastRequest() as { id: string }
    sockets[0]!.reply(id, { events: [], epoch: "e1", latest_seq: 4 })

    await expect(request).resolves.toEqual({
      events: [],
      epoch: "e1",
      latest_seq: 4,
    })
    expect(sockets[0]!.readyState).toBe(1)
    await gateway.close()
  })

  it("faults the socket on an unreadable frame and leaves observers silent", async () => {
    const { gateway, sockets, factory } = harness()
    const observed = vi.fn()
    gateway.onEvent(observed)
    await gateway.connect()

    const pending = gateway.request("profiles.list", {})
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
    sockets[0]!.deliverText("{")

    await expect(pending).rejects.toBeInstanceOf(HermesRpcUncertainError)
    expect(observed).not.toHaveBeenCalled()
    expect(sockets[0]!.readyState).toBe(3)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await gateway.close()
  })

  it("ignores a fault from a socket generation that was already replaced", async () => {
    const { gateway, sockets, factory } = harness()
    await gateway.connect()

    sockets[0]!.deliverText("{")
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sockets[1]!.readyState).toBe(1))
    const pending = gateway.request("prompt.submit", { text: "x" })
    await vi.waitFor(() => expect(sockets[1]!.sent).toHaveLength(1))

    // A frame already queued on the abandoned socket must not take down the
    // healthy generation that replaced it.
    sockets[0]!.deliverText("{")

    expect(sockets[1]!.readyState).toBe(1)
    const { id } = sockets[1]!.lastRequest() as { id: string }
    sockets[1]!.reply(id, { ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
    expect(factory).toHaveBeenCalledTimes(2)
    await gateway.close()
  })

  it("resolves a 3 MiB replay reply inside its bound and drops a 3 MiB event", async () => {
    const { gateway, sockets } = harness()
    const observed = vi.fn()
    gateway.onEvent(observed)
    await gateway.connect()

    const page = gateway.request(
      "session.events.since",
      { session_id: "live-a", last_seen: 0 },
      { maxResponseBytes: 6 * 1_048_576 }
    )
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
    const { id } = sockets[0]!.lastRequest() as { id: string }
    const text = "x".repeat(3 * 1_048_576)
    sockets[0]!.reply(id, {
      epoch: "e1",
      latest_seq: 1,
      events: [
        {
          type: "message.delta",
          session_id: "live-a",
          seq: 1,
          payload: { text },
        },
      ],
    })
    sockets[0]!.deliverEvent({
      type: "message.delta",
      session_id: "live-a",
      seq: 2,
      payload: { text },
    })

    await expect(page).resolves.toMatchObject({ epoch: "e1", latest_seq: 1 })
    // One live frame of the same size exceeds the event bound: it is dropped
    // and the run catches up from the ring rather than losing the socket.
    expect(observed).not.toHaveBeenCalled()
    expect(sockets[0]!.readyState).toBe(1)
    await gateway.close()
  })

  it("drops an oversized event frame and keeps delivering the next one", async () => {
    const { gateway, sockets } = harness()
    const observed = vi.fn()
    gateway.onEvent(observed)
    await gateway.connect()

    sockets[0]!.deliverEvent({
      type: "message.delta",
      session_id: "live-a",
      seq: 1,
      payload: { text: "x".repeat(MAX_EVENT_FRAME_BYTES) },
    })
    sockets[0]!.deliverEvent({
      type: "message.delta",
      session_id: "live-a",
      seq: 2,
      payload: { text: "next" },
    })

    expect(sockets[0]!.readyState).toBe(1)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith({
      type: "message.delta",
      session_id: "live-a",
      seq: 2,
      payload: { text: "next" },
    })
    await gateway.close()
  })
})

describe("Hermes gateway event fan-out", () => {
  it("delivers each native frame exactly once after two redials", async () => {
    const { gateway, sockets, factory } = harness()
    const observed = vi.fn()
    gateway.onEvent(observed)
    await gateway.connect()

    for (let generation = 0; generation < 3; generation += 1) {
      if (generation > 0) {
        await vi.waitFor(() =>
          expect(factory).toHaveBeenCalledTimes(generation + 1)
        )
        await vi.waitFor(() => expect(sockets[generation]!.readyState).toBe(1))
      }
      sockets[generation]!.deliverEvent({
        type: "message.delta",
        session_id: "live-a",
        seq: generation + 1,
        payload: { text: "hi" },
      })
      if (generation < 2) sockets[generation]!.close(1006)
    }

    expect(observed).toHaveBeenCalledTimes(3)
    await gateway.close()
  })

  it("delivers two native event frames to an observer in wire order", async () => {
    const { gateway, sockets } = harness()
    const turn = nativeTurn("live-a")
    const observed: unknown[] = []
    gateway.onEvent((event) => {
      observed.push(event)
    })
    await gateway.connect()

    const first = turn.delta("first")
    const second = turn.delta("second")
    sockets[0]!.deliverEvent(first)
    sockets[0]!.deliverEvent(second)

    expect(observed).toEqual([first, second])
    await gateway.close()
  })
})

describe("Hermes gateway heartbeat and redial", () => {
  it("pings on the advertised heartbeat and redials after the deadline", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const { gateway, sockets, factory } = harness({ requestTimeoutMs: 120_000 })
    await gateway.connect()
    sockets[0]!.deliverReady({ heartbeat: true, replay_epoch: "e1" })
    const outcome = gateway.request("prompt.submit", { text: "x" }).then(
      () => "resolved",
      (error: unknown) => (error as Error).name
    )
    await flush()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(sockets[0]!.requestsFor("gateway.ping")).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await expect(outcome).resolves.toBe("HermesRpcUncertainError")
    expect(sockets[0]!.readyState).toBe(3)
    expect(factory).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(150)
    expect(factory).toHaveBeenCalledTimes(2)
    await gateway.close()
  })

  it("never pings a server that did not advertise a heartbeat", async () => {
    vi.useFakeTimers()
    const { gateway, sockets, factory } = harness()
    await gateway.connect()
    sockets[0]!.deliverReady({ replay_epoch: "e1" })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(sockets[0]!.requestsFor("gateway.ping")).toEqual([])
    expect(sockets[0]!.readyState).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)
    await gateway.close()
  })

  it("escalates the redial delay to the configured cap", async () => {
    vi.useFakeTimers()
    const { gateway, sockets, factory, control } = harness({
      backoff: { jitter: false },
      connectTimeoutMs: 1_000,
    })
    await gateway.connect()
    control.autoOpen = false
    sockets[0]!.close(1006)

    const delays = [300, 600, 1_200, 2_400, 4_800, 9_600, 15_000, 15_000]
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(factory).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(factory).toHaveBeenCalledTimes(index + 2)
      // The fresh socket never opens: its dial fails on the connect deadline.
      await vi.advanceTimersByTimeAsync(1_000)
    }

    await gateway.close()
  })

  it("logs one dial failure per outage rather than one per redial", async () => {
    vi.useFakeTimers()
    const { gateway, sockets, log, control } = harness({
      backoff: { jitter: false },
      connectTimeoutMs: 1_000,
    })
    await gateway.connect()
    control.autoOpen = false

    sockets[0]!.close(1006)
    await vi.advanceTimersByTimeAsync(30_000)
    const dialFailures = () =>
      log.warn.mock.calls.filter(
        ([event]) => event === "hermes.gateway.dial_failed"
      )
    expect(dialFailures()).toHaveLength(1)

    control.autoOpen = true
    await vi.advanceTimersByTimeAsync(30_000)
    control.autoOpen = false
    sockets[sockets.length - 1]!.close(1006)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dialFailures()).toHaveLength(2)
    await gateway.close()
  })

  it("holds a short outage inside the heal grace and only reports restored", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const restored = vi.fn()
    const lost = vi.fn()
    const { gateway, sockets, factory } = harness()
    gateway.onConnection({ restored, lost })
    await gateway.connect()
    sockets[0]!.deliverReady({ replay_epoch: "e1" })
    await flush()
    expect(restored).toHaveBeenCalledTimes(1)

    sockets[0]!.close(1006)
    await vi.advanceTimersByTimeAsync(150)
    expect(factory).toHaveBeenCalledTimes(2)
    sockets[1]!.deliverReady({ replay_epoch: "e1" })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(lost).not.toHaveBeenCalled()
    expect(restored).toHaveBeenCalledTimes(2)
    await gateway.close()
  })

  it("reports lost once past the heal grace and restored on the next open", async () => {
    vi.useFakeTimers()
    const restored = vi.fn()
    const lost = vi.fn()
    const { gateway, sockets, control } = harness({
      backoff: { jitter: false },
      healGraceMs: 20_000,
    })
    gateway.onConnection({ restored, lost })
    await gateway.connect()
    control.autoOpen = false

    sockets[0]!.close(1006)
    await vi.advanceTimersByTimeAsync(19_000)
    expect(lost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lost).toHaveBeenCalledTimes(1)

    control.autoOpen = true
    await vi.advanceTimersByTimeAsync(60_000)

    expect(lost).toHaveBeenCalledTimes(1)
    expect(restored).toHaveBeenCalledTimes(2)
    await gateway.close()
  })

  it("reports only an epoch change when Hermes restarted across a reconnect", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const epochChanged = vi.fn()
    const restored = vi.fn()
    const { gateway, sockets } = harness()
    gateway.onConnection({ restored, epochChanged })
    await gateway.connect()
    sockets[0]!.deliverReady({ replay_epoch: "e1" })
    await flush()
    expect(restored).toHaveBeenCalledTimes(1)

    sockets[0]!.close(1006)
    await vi.advanceTimersByTimeAsync(150)
    sockets[1]!.deliverReady({ replay_epoch: "e2" })
    sockets[1]!.deliverReady({ replay_epoch: "e2" })
    await flush()

    expect(epochChanged).toHaveBeenCalledTimes(1)
    // Re-resuming every binding a restart already killed is pure churn.
    expect(restored).toHaveBeenCalledTimes(1)
    await gateway.close()
  })

  it("reports only restored when the reconnect carries the same epoch", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const epochChanged = vi.fn()
    const restored = vi.fn()
    const { gateway, sockets } = harness()
    gateway.onConnection({ restored, epochChanged })
    await gateway.connect()
    sockets[0]!.deliverReady({ replay_epoch: "e1" })
    await flush()

    sockets[0]!.close(1006)
    await vi.advanceTimersByTimeAsync(150)
    sockets[1]!.deliverReady({ replay_epoch: "e1" })
    await flush()

    expect(restored).toHaveBeenCalledTimes(2)
    expect(epochChanged).not.toHaveBeenCalled()
    await gateway.close()
  })

  it("reports restored when no ready frame announces an epoch in time", async () => {
    vi.useFakeTimers()
    const epochChanged = vi.fn()
    const restored = vi.fn()
    const { gateway } = harness()
    gateway.onConnection({ restored, epochChanged })
    await gateway.connect()
    await flush()

    expect(restored).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)

    expect(restored).toHaveBeenCalledTimes(1)
    expect(epochChanged).not.toHaveBeenCalled()
    await gateway.close()
  })

  it("redials and connects after a socket factory throws once", async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    let attempts = 0
    const factory = vi.fn(() => {
      attempts += 1
      if (attempts === 1) throw new Error("socket refused")
      const socket = new FakeSocket()
      sockets.push(socket)
      queueMicrotask(() => socket.open())
      return socket
    })
    const gateway = new HermesGateway({
      baseUrl: BASE_URL,
      credentials: async () => ({ "X-Hermes-Session-Token": TOKEN }),
      fetcher: vi.fn(),
      socketFactory: factory,
      backoff: { jitter: false },
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    })

    await expect(gateway.connect()).rejects.toBeInstanceOf(
      HermesUnavailableError
    )

    await vi.advanceTimersByTimeAsync(300)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(sockets[0]!.readyState).toBe(1)
    await expect(
      gateway.request("profiles.list", { include_sessions: false })
    ).resolves.toEqual({ profiles: [] })
    await gateway.close()
  })

  it("logs a refused socket factory apart from a failed handshake", async () => {
    vi.useFakeTimers()
    const log = { warn: vi.fn() }
    const factory = vi.fn(() => {
      throw new TypeError("socket refused for wss://hermes.internal/api/ws")
    })
    const gateway = new HermesGateway({
      baseUrl: BASE_URL,
      credentials: async () => ({ "X-Hermes-Session-Token": TOKEN }),
      fetcher: vi.fn(),
      socketFactory: factory,
      backoff: { jitter: false },
      connectTimeoutMs: 1_000,
      log,
    })

    await expect(gateway.connect()).rejects.toBeInstanceOf(
      HermesUnavailableError
    )

    expect(
      log.warn.mock.calls.filter(
        ([event]) => event === "hermes.gateway.dial_failed"
      )
    ).toEqual([
      [
        "hermes.gateway.dial_failed",
        { reason: "socket_factory_threw", error: "TypeError" },
      ],
    ])
    await gateway.close()
  })

  it("logs a handshake failure under its own reason", async () => {
    const { gateway, log } = harness({ autoOpen: false, connectTimeoutMs: 20 })

    await expect(gateway.connect()).rejects.toBeInstanceOf(
      HermesUnavailableError
    )

    expect(
      log.warn.mock.calls
        .filter(([event]) => event === "hermes.gateway.dial_failed")
        .map(([, fields]) => (fields as { reason?: unknown }).reason)
    ).toEqual(["handshake_failed"])
    await gateway.close()
  })

  it("writes a request parked during an outage only after restore settles", async () => {
    const { gateway, sockets } = harness({ autoOpen: false })
    let releaseRestore = () => {}
    const restoreDone = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    const restored = vi.fn(() => restoreDone)
    gateway.onConnection({ restored })

    const parked = gateway.request("profiles.list", {})
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.autoReply = true
    sockets[0]!.open()
    sockets[0]!.deliverReady({ replay_epoch: "e1" })
    await flush()

    expect(restored).toHaveBeenCalledTimes(1)
    // The capabilities announcement was sent on open; the parked user request
    // must not be written until the restore handler settles.
    expect(sockets[0]!.requestsFor("profiles.list")).toEqual([])

    releaseRestore()

    await expect(parked).resolves.toEqual({ profiles: [] })
    expect(sockets[0]!.requestsFor("profiles.list")).toHaveLength(1)
    await gateway.close()
  })

  it("writes a parked request even when a restored handler rejects", async () => {
    const { gateway, sockets, log } = harness({ autoOpen: false })
    gateway.onConnection({ restored: () => Promise.reject(new Error("boom")) })

    const parked = gateway.request("profiles.list", {})
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.autoReply = true
    sockets[0]!.open()
    sockets[0]!.deliverReady({ replay_epoch: "e1" })

    await expect(parked).resolves.toEqual({ profiles: [] })
    expect(
      log.warn.mock.calls.filter(
        ([event]) => event === "hermes.gateway.handler_failed"
      )
    ).toHaveLength(1)
    await gateway.close()
  })
})

describe("Hermes gateway lifecycle and server requests", () => {
  it("ignores a dial that completes after close and publishes nothing", async () => {
    const { gateway, sockets, factory } = harness({ autoOpen: false })
    const observed = vi.fn()
    const restored = vi.fn()
    gateway.onEvent(observed)
    gateway.onConnection({ restored })

    const dial = gateway.connect()
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))
    await gateway.close()
    const outcome = await dial.then(
      () => "resolved",
      (error: unknown) => (error as Error).name
    )
    // The socket of a cancelled dial is released, not left dangling: a native
    // handle that outlived close() would hold the process past its shutdown.
    expect(sockets[0]!.closedWith).not.toBeUndefined()
    sockets[0]!.open()
    sockets[0]!.deliverEvent({ type: "message.delta", session_id: "live-a" })

    expect(outcome).toBe("HermesUnavailableError")
    expect(observed).not.toHaveBeenCalled()
    expect(restored).not.toHaveBeenCalled()
    expect(factory).toHaveBeenCalledTimes(1)
    await expect(gateway.request("profiles.list", {})).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
    await expect(gateway.connect()).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
  })

  it("answers an unclaimed server request so Hermes stops waiting on it", async () => {
    const { gateway, sockets } = harness()
    await gateway.connect()
    const declined = vi.fn(() => false as const)
    gateway.onRequest(declined)

    sockets[0]!.deliver({
      id: "srq-000000000001",
      method: "sudo",
      params: { session_id: "live-secret" },
    })

    expect(declined).toHaveBeenCalledTimes(1)
    expect(sockets[0]!.lastRequest()).toMatchObject({
      id: "srq-000000000001",
      error: { code: -32601 },
    })
    await gateway.close()
  })

  it("reports whether an answer written now can reach Hermes", async () => {
    const { gateway, sockets } = harness()

    expect(gateway.connected()).toBe(false)
    await gateway.connect()
    expect(gateway.connected()).toBe(true)

    sockets[0]!.close(1006)
    expect(gateway.connected()).toBe(false)

    await gateway.close()
    expect(gateway.connected()).toBe(false)
  })

  it("re-delivers open requests from a resume result before it resolves", async () => {
    const { gateway, sockets } = harness()
    await gateway.connect()
    const claimed: Array<{ id: string; replayed?: boolean }> = []
    gateway.onRequest((request) => {
      claimed.push({ id: request.id, replayed: request.replayed })
      return true
    })

    const resume = gateway.request("session.resume", { session_id: "stored" })
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(2))
    const { id } = sockets[0]!.lastRequest() as { id: string }
    sockets[0]!.reply(id, {
      session_id: "live-secret",
      running: true,
      open_requests: [
        {
          id: "srq-000000000003",
          method: "approval",
          params: { session_id: "live-secret" },
        },
      ],
    })

    await expect(resume).resolves.toMatchObject({ running: true })
    expect(claimed).toEqual([{ id: "srq-000000000003", replayed: true }])
    expect(sockets[0]!.sent).toHaveLength(2)
    await gateway.close()
  })

  it("hands server requests to a registered handler instead of claiming them", async () => {
    const { gateway, sockets } = harness()
    await gateway.connect()
    const handled = vi.fn(() => true)
    const stop = gateway.onRequest(handled)

    sockets[0]!.deliver({
      id: "srq-000000000004",
      method: "clarify",
      params: { session_id: "live-secret" },
    })

    expect(handled).toHaveBeenCalledTimes(1)
    stop()
    await gateway.close()
  })

  it("delegates bounded native HTTP reads with server-side credentials", async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [] }))
    const gateway = new HermesGateway({
      baseUrl: BASE_URL,
      credentials: async () => ({ "X-Hermes-Session-Token": TOKEN }),
      fetcher,
      socketFactory: vi.fn(),
    })

    await expect(gateway.http("/api/sessions?profile=x")).resolves.toEqual({
      sessions: [],
    })
    expect(fetcher).toHaveBeenCalledWith(
      `${BASE_URL}/api/sessions?profile=x`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Hermes-Session-Token": TOKEN,
        }),
      })
    )
    await gateway.close()
  })

  it("re-announces capabilities on each new socket after a redial", async () => {
    const { gateway, sockets, factory } = harness()
    await gateway.connect()

    // First socket: capabilities was announced immediately on open.
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
    expect(sockets[0]!.requests()[0]).toMatchObject({
      method: "client.capabilities",
      params: { server_requests: true },
    })

    // Drop the socket and wait for the gateway to redial.
    sockets[0]!.close(1006)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sockets[1]!.sent).toHaveLength(1))

    // New socket: capabilities was announced again.
    expect(sockets[1]!.requests()[0]).toMatchObject({
      method: "client.capabilities",
      params: { server_requests: true },
    })
    await gateway.close()
  })

  it("succeeds the dial and logs capabilities_unacknowledged when the announcement is rejected", async () => {
    const { gateway, sockets, log } = harness({ autoReply: false })
    await gateway.connect()

    // The capabilities frame is the first frame sent; reply with a JSON-RPC
    // error as an older Hermes would (method not found).
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
    const { id } = sockets[0]!.requests()[0]! as { id: string }
    sockets[0]!.replyError(id, { code: -32601, message: "method not found" })
    await flush()

    expect(log.warn).toHaveBeenCalledWith(
      "hermes.gateway.capabilities_unacknowledged",
      {}
    )
    // The dial itself is still open; requests can still be issued.
    expect(gateway.connected()).toBe(true)
    await gateway.close()
  })
})
