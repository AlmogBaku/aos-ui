import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../../test/support/fake-clock"
import { captureLogs } from "../../../../test/support/log-capture"
import { createProxyLogger } from "../../cli/logger"
import { sessionId } from "../../core/ids"
import { CredentialValues } from "../../redaction"
import type { RuntimeServices } from "../create-runtime"
import { createHermesRuntime } from "./factory"
import type { HermesGatewayOptions } from "./gateway"

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
    await writeFile(tokenFile, "tok-test-1", { mode: 0o600 })
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
  async function resumedRuntime(
    clock: ReturnType<typeof useFakeClock>,
    request: (method: string) => Promise<unknown>,
    services: RuntimeServices = {
      logger: captureLogs().logger,
      credentials: new CredentialValues(),
    }
  ) {
    const transport = {
      request: vi.fn((method: string) => request(method)),
      subscribeEvents: () => () => undefined,
      subscribeConnection: () => () => undefined,
      close: vi.fn(async () => undefined),
    }
    const config = await hermesRuntimeConfig()
    let gateway: HermesGatewayOptions | undefined
    const runtime = await createHermesRuntime(config, limits, {
      ...services,
      transportFactory: (options) => {
        gateway = options
        return transport
      },
    })
    // Trigger a session.resume so close() later sends the courtesy session.close.
    const providerSessionId = runtime.runtime.resolveProviderSessionId(
      "researcher",
      "stored"
    )!
    const stop = runtime.runtime.turns.subscribeTurns!(
      {
        agentId: "researcher",
        providerSessionId,
        sessionId: sessionId("stored"),
      },
      { onTurn: () => undefined, onError: () => undefined }
    )
    // The watch's link takes its dial before it releases the observation.
    await clock.advance(0)
    stop()
    return { runtime, transport, config, gateway: gateway! }
  }

  it("closes an attached runtime without waiting on a native call that cannot answer", async () => {
    const clock = useFakeClock()
    const { runtime, transport } = await resumedRuntime(
      clock,
      async (method) => {
        if (method === "session.resume") return { session_id: "live-stored" }
        // Hermes never answers the courtesy close: the socket is going away.
        return new Promise(() => undefined)
      }
    )

    const closed = runtime.close()
    let settled = false
    void closed.then(() => {
      settled = true
    })
    await clock.advance(0)
    expect(settled).toBe(false)

    await clock.advance(1_000)
    await expect(closed).resolves.toBeUndefined()
    expect(transport.close).toHaveBeenCalledOnce()
    // Nothing the runtime armed may keep the process alive after close().
    expect(vi.getTimerCount()).toBe(0)
  })

  it("hands the proxy a turn engine that watches for turns Hermes starts by itself, and re-reads and masks the token on every dial", async () => {
    const lines: string[] = []
    const credentials = new CredentialValues()
    const logger = createProxyLogger({
      level: "info",
      credentials,
      destination: { write: (line) => void lines.push(line) },
    })
    const { runtime, config, gateway } = await resumedRuntime(
      useFakeClock(),
      async (method) =>
        method === "session.resume" ? { session_id: "live-stored" } : {},
      { logger, credentials }
    )

    expect(runtime.runtime.turns.subscribeTurns).toBeTypeOf("function")
    // The operator rotates the token file under a running proxy.
    await writeFile(config.tokenFile, "tok-test-2")
    await expect(gateway.credentials()).resolves.toEqual({
      "X-Hermes-Session-Token": "tok-test-2",
    })
    // A native error that echoes both tokens it was sent.
    logger.warn(
      { detail: "bad token tok-test-1, then tok-test-2" },
      "hermes.rpc.failed"
    )
    expect(lines.join("")).not.toMatch(/tok-test-[12]/u)
    expect(lines.map((line) => JSON.parse(line) as unknown)).toContainEqual(
      expect.objectContaining({
        detail: "bad token [REDACTED], then [REDACTED]",
      })
    )
    await runtime.close()
  })

  it("closes at once when Hermes answers the courtesy close", async () => {
    const { runtime, transport } = await resumedRuntime(
      useFakeClock(),
      async (method) =>
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
