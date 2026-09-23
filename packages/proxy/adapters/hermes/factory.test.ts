import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createGatewayLog, createHermesRuntime } from "./factory"

describe("Hermes gateway log", () => {
  it("writes one redacted structured line per gateway event", () => {
    const write = vi.fn()
    const log = createGatewayLog(write)

    log.warn("hermes.gateway.dial_failed", {
      reason: "HermesUnavailableError",
      close_code: 4401,
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({
      event: "hermes.gateway.dial_failed",
      reason: "HermesUnavailableError",
      close_code: 4401,
    })
  })

  it("redacts a secret-bearing field a caller passes by mistake", () => {
    const write = vi.fn()
    const log = createGatewayLog(write)

    log.warn("hermes.gateway.frame_rejected", {
      token: "native-secret",
      url: "http://127.0.0.1:9119/api/ws?token=native-secret",
    })

    const line = write.mock.calls[0]![0] as string
    expect(line).not.toContain("native-secret")
    expect(JSON.parse(line)).toEqual({
      event: "hermes.gateway.frame_rejected",
      token: "[REDACTED]",
      url: "http://127.0.0.1:9119/api/ws",
    })
  })
})

describe("Hermes runtime shutdown", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  async function hermesRuntimeConfig() {
    const directory = await mkdtemp(join(tmpdir(), "aos-hermes-factory-"))
    temporaryDirectories.push(directory)
    const tokenFile = join(directory, "hermes-token")
    await writeFile(tokenFile, "hermes-token", { mode: 0o600 })
    return {
      id: "hermes-main",
      kind: "hermes",
      baseUrl: "http://127.0.0.1:9119",
      tokenFile,
      sessionIdleMs: 300_000,
    } as const
  }

  const limits = {
    activeExecutions: 8,
    guestActiveExecutions: 2,
    operatorEventPeers: 8,
    subscriberEvents: 64,
    subscriberBytes: 65_536,
  }

  /**
   * The review deployment's state at restart: one durable Session bound to a
   * live Hermes Session, nobody retaining it, its idle close armed.
   */
  async function attachedRuntime(
    request: (method: string) => Promise<unknown>
  ) {
    const transport = {
      request: vi.fn((method: string) => request(method)),
      onEvent: () => () => undefined,
      onConnection: () => () => undefined,
      close: vi.fn(async () => undefined),
    }
    const runtime = await createHermesRuntime(
      await hermesRuntimeConfig(),
      limits,
      { transportFactory: () => transport }
    )
    const unsubscribe = await runtime.runtime.subscribeSessionInvalidation(
      "researcher",
      "stored",
      () => undefined
    )
    unsubscribe()
    return { runtime, transport }
  }

  it("closes an attached runtime without waiting on a native call that cannot answer", async () => {
    vi.useFakeTimers()
    const { runtime, transport } = await attachedRuntime(async (method) => {
      if (method === "session.resume") return { session_id: "live-stored" }
      // Hermes never answers the courtesy close: the socket is going away.
      return new Promise(() => undefined)
    })

    const closed = runtime.close()
    let settled = false
    void closed.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(closed).resolves.toBeUndefined()
    expect(transport.close).toHaveBeenCalledOnce()
    // Nothing the runtime armed may keep the process alive after close().
    expect(vi.getTimerCount()).toBe(0)
  })

  it("hands the proxy a turn engine that watches for turns Hermes starts by itself", async () => {
    const { runtime } = await attachedRuntime(async (method) =>
      method === "session.resume" ? { session_id: "live-stored" } : {}
    )

    expect(runtime.runtime.turns.watch).toBeTypeOf("function")
    await runtime.close()
  })

  it("closes at once when Hermes answers the courtesy close", async () => {
    vi.useFakeTimers()
    const { runtime, transport } = await attachedRuntime(async (method) =>
      method === "session.resume" ? { session_id: "live-stored" } : {}
    )

    await expect(runtime.close()).resolves.toBeUndefined()

    expect(transport.request).toHaveBeenCalledWith("session.close", {
      session_id: "live-stored",
    })
    expect(transport.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
