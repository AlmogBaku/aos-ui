/**
 * The proxy handshake deadline over a real Bun WebSocket. Runs under `bun test` (not vitest) because it needs Bun's
 * actual WebSocket server and client.
 *
 * These tests use a short `handshakeDeadlineMs` override so they do not wait
 * 15 s for the production deadline to fire.
 */
import { AGENT_METHODS, agent } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "bun:test"

import { createAcpService } from "./service"
import { startProxyServer } from "../server"
import type { AcpConnectionContext } from "./types"
import { OPERATOR_PRINCIPAL } from "../core/principal"

const ACP_PATH = "/api/aos/v1/acp"

/** A no-op logger for the test context. */
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
    publicError: () => undefined,
    catalog: {} as AcpConnectionContext["catalog"],
    readState: {} as AcpConnectionContext["readState"],
    activityFeed: {} as AcpConnectionContext["activityFeed"],
    translators: {} as AcpConnectionContext["translators"],
    channels: {} as AcpConnectionContext["channels"],
    logger: silentLogger,
    attachmentStages: {} as AcpConnectionContext["attachmentStages"],
  }
}

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

describe("proxy handshake deadline (bun socket)", () => {
  it("closes the WebSocket with 4408 when initialize is not sent within the deadline", async () => {
    // The service's origin check uses publicOrigin; the test sets the same
    // value on the client side so the upgrade is accepted.
    const publicOrigin = "http://test.local"
    const acpService = createAcpService({
      publicOrigin,
      role: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent: testAgent,
      connection: connectionContext,
      // Short deadline for the test — no need to wait 15 s.
      handshakeDeadlineMs: 100,
    })

    const { server, shutdown } = startProxyServer({
      app: { fetch: () => new Response(null, { status: 404 }) },
      sockets: [{ path: ACP_PATH, service: acpService }],
      host: "127.0.0.1",
      port: 0,
      shutdownGraceMs: 500,
      installSignalHandlers: false,
    })

    const port = (server as { port: number }).port
    const url = `ws://127.0.0.1:${port}${ACP_PATH}`

    let closeCode = 0
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url, {
        headers: { origin: publicOrigin },
      } as unknown as string[])
      ws.addEventListener("close", (event) => {
        closeCode = (event as CloseEvent).code
        resolve()
      })
      ws.addEventListener("error", () => resolve())
    })

    await shutdown()
    expect(closeCode).toBe(4408)
  })
})
