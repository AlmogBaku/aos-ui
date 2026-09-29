import { AGENT_METHODS, agent } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { OPERATOR_PRINCIPAL } from "../core/principal"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import { createAcpService } from "./service"
import type { AcpConnectionContext } from "./types"

const ORIGIN = "https://aos.example.test"
const PATH = "/api/aos/v1/acp"

function initializeFrame(id: number) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: 2,
      info: { name: "spec-client", version: "0" },
    },
  })
}

/** One classifier for every context, so two contexts compare equal. */
const unclassified = () => undefined

/** A no-op logger for tests that do not assert log output. */
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as AcpConnectionContext["logger"]

function connectionContext(
  connectionId: string,
  principalId: string
): AcpConnectionContext {
  return {
    connectionId,
    principalId,
    role: "operator",
    publicError: unclassified,
    catalog: {} as AcpConnectionContext["catalog"],
    readState: {} as AcpConnectionContext["readState"],
    activityFeed: {} as AcpConnectionContext["activityFeed"],
    translators: {} as AcpConnectionContext["translators"],
    channels: {} as AcpConnectionContext["channels"],
    logger: silentLogger,
    attachmentStages: {} as AcpConnectionContext["attachmentStages"],
  }
}

/**
 * A minimal test agent that handles initialize and signals handshake-complete
 * via the context callback, mirroring what `createAosAcpAgent` does.
 */
function testAgent(context: AcpConnectionContext) {
  return agent({ name: "spec" })
    .onRequest(AGENT_METHODS.initialize, () => ({
      protocolVersion: 2,
      info: { name: "spec", version: "0" },
    }))
    .onConnect(async (connection) => {
      await connection.initialized.catch(() => undefined)
      context.handshakeComplete?.()
    })
}

function service() {
  const contexts: AcpConnectionContext[] = []
  return {
    contexts,
    acp: createAcpService({
      publicOrigin: ORIGIN,
      role: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent(context) {
        contexts.push(context)
        return testAgent(context)
      },
      connection: connectionContext,
    }),
  }
}

function peer() {
  const frames: string[] = []
  const closed: Array<{ code: number; reason: string }> = []
  let resolveFrame: (() => void) | undefined
  return {
    frames,
    closed,
    peer: {
      send(raw: string): number {
        frames.push(raw)
        resolveFrame?.()
        resolveFrame = undefined
        return raw.length
      },
      isOpen: () => closed.length === 0,
      close(code: number, reason: string) {
        closed.push({ code, reason })
      },
    },
    nextFrame() {
      return new Promise<void>((resolve) => {
        resolveFrame = resolve
      })
    },
  }
}

describe("ACP WebSocket service", () => {
  it("authorizes the public origin or none, and mints a connection id", async () => {
    const { acp } = service()

    for (const origin of ["https://attacker.example.test", "null"])
      await expect(
        acp.authorizeUpgrade(
          new Request(`${ORIGIN}${PATH}`, { headers: { origin } })
        )
      ).resolves.toBeUndefined()
    // A client that is no browser sends no Origin at all.
    await expect(
      acp.authorizeUpgrade(new Request(`${ORIGIN}${PATH}`))
    ).resolves.toMatchObject({ principalId: "operator" })

    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}${PATH}`, { headers: { origin: ORIGIN } })
    )

    expect(upgrade?.principalId).toBe("operator")
    expect(upgrade?.role).toBe("operator")
    expect(upgrade?.connectionId).toEqual(expect.any(String))
    expect(upgrade?.headers).toEqual({
      "Acp-Connection-Id": upgrade?.connectionId,
    })
  })

  it("refuses an Agent's address as unavailable while the catalog cannot say", async () => {
    const logs = captureLogs()
    const acp = createAcpService({
      publicOrigin: ORIGIN,
      role: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent: testAgent,
      connection: connectionContext,
      agentAddress: {
        path: PATH,
        exists: () => Promise.reject(new Error("internal detail 7f3a")),
        publicError: () => undefined,
      },
      logger: logs.logger,
    })

    await expect(
      acp.authorizeUpgrade(
        new Request(`${ORIGIN}${PATH}/agents/researcher`, {
          headers: { origin: ORIGIN },
        })
      )
    ).resolves.toEqual({ refused: 503 })
    expect(
      logs.records().map(({ message, fields }) => [message, fields])
    ).toEqual([["acp.upgrade.catalog_failed", { errorCode: "internal_error" }]])
  })

  it("answers the first initialize frame through the prepared connection", async () => {
    const { acp, contexts } = service()
    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}${PATH}`, { headers: { origin: ORIGIN } })
    )
    const transport = peer()

    const socket = acp.open(upgrade!, transport.peer)
    const initialized = transport.nextFrame()
    socket.receive(initializeFrame(7))
    await initialized

    expect(JSON.parse(transport.frames[0]!)).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        protocolVersion: 2,
        info: { name: "spec", version: "0" },
      },
    })
    // The service sets clock and handshakeComplete on the context; check
    // identity fields without asserting on those injected properties.
    expect(contexts[0]).toMatchObject(
      connectionContext(upgrade!.connectionId, "operator")
    )
    expect(transport.closed).toEqual([])
    expect(acp.sockets()).toBe(1)

    socket.close()
    socket.receive(initializeFrame(8))
    expect(transport.frames).toHaveLength(1)
    expect(acp.sockets()).toBe(0)
  })

  it("warns of a dropped send only while its socket is open", async () => {
    const logs = captureLogs()
    const acp = createAcpService({
      publicOrigin: ORIGIN,
      role: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent: testAgent,
      connection: (connectionId, principalId) => ({
        ...connectionContext(connectionId, principalId),
        logger: logs.logger.child({ connectionId }),
      }),
    })
    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}${PATH}`, { headers: { origin: ORIGIN } })
    )
    // Bun answers -1 for a frame it queued and 0 for one it dropped.
    let sent = 0
    let open = true
    let written: (() => void) | undefined
    const socket = acp.open(upgrade!, {
      send() {
        written?.()
        return sent
      },
      isOpen: () => open,
      close: () => undefined,
    })
    const exchange = (id: number, method: string) =>
      new Promise<void>((resolve) => {
        written = resolve
        socket.receive(
          method === "initialize"
            ? initializeFrame(id)
            : JSON.stringify({ jsonrpc: "2.0", id, method })
        )
      })

    await exchange(1, "initialize")
    sent = -1
    await exchange(2, "spec/unknown")
    sent = 0
    open = false
    await exchange(3, "spec/unknown")

    const connectionId = upgrade!.connectionId
    expect(
      logs.records().filter(({ message }) => message.startsWith("acp.send."))
    ).toEqual([
      { level: "warn", message: "acp.send.dropped", fields: { connectionId } },
      {
        level: "debug",
        message: "acp.send.backpressure",
        fields: { connectionId },
      },
      { level: "debug", message: "acp.send.dropped", fields: { connectionId } },
    ])
    socket.close()
  })

  it("carries the configured principal into the connection context", async () => {
    const contexts: AcpConnectionContext[] = []
    const acp = createAcpService({
      publicOrigin: ORIGIN,
      role: "guest",
      principalId: "invite-42",
      agent(context) {
        contexts.push(context)
        return testAgent(context)
      },
      connection: connectionContext,
    })
    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}/api/guest/v1/acp`, { headers: { origin: ORIGIN } })
    )
    const transport = peer()

    const socket = acp.open(upgrade!, transport.peer)
    const initialized = transport.nextFrame()
    socket.receive(initializeFrame(1))
    await initialized

    expect(contexts[0]).toMatchObject(
      connectionContext(upgrade!.connectionId, "invite-42")
    )
    socket.close()
  })

  it("closes the peer with 4408 when initialize is not received within 15 s", async () => {
    const clock = useFakeClock()
    const acp = createAcpService({
      publicOrigin: ORIGIN,
      role: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent: testAgent,
      connection: connectionContext,
    })
    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}${PATH}`, { headers: { origin: ORIGIN } })
    )
    const transport = peer()
    acp.open(upgrade!, transport.peer)

    // No initialize sent — advance past the 15 s deadline.
    await clock.advance(15_000)

    expect(transport.closed).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 4408 })])
    )
  })

  it("keeps the connection when initialize arrives before the 15 s deadline", async () => {
    const clock = useFakeClock()
    const acp = createAcpService({
      publicOrigin: ORIGIN,
      role: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent: testAgent,
      connection: connectionContext,
    })
    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}${PATH}`, { headers: { origin: ORIGIN } })
    )
    const transport = peer()
    const socket = acp.open(upgrade!, transport.peer)

    // Advance to just before the deadline, then send initialize.
    await clock.advance(14_000)
    expect(transport.closed).toEqual([])
    const initialized = transport.nextFrame()
    socket.receive(initializeFrame(1))
    await initialized
    // Let the agent's onConnect continuation clear the handshake deadline.
    // The SDK calls afterResponse → state.complete → initialized resolves →
    // onConnect continuation → context.handshakeComplete?.().
    // Each arrow is one microtask step; four flushes cover the chain.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Advance past the 15 s mark — the deadline was already cleared.
    await clock.advance(2_000)

    expect(transport.closed).toEqual([])
    socket.close()
  })
})
