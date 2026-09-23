import { AGENT_METHODS, agent } from "@agentclientprotocol/sdk/experimental/v2"
import { afterEach, describe, expect, it } from "bun:test"
import { request } from "node:http"

import { AOS_ACP_OPERATOR_PATH } from "../protocol/acp"
import { createAcpService } from "./acp/service"
import type { AcpConnectionContext } from "./acp/types"
import { OPERATOR_PRINCIPAL } from "./core/principal"
import { startProxyServer } from "./server"

const ORIGIN = "https://aos.example.test"
const lifecycles: Array<ReturnType<typeof startProxyServer>> = []

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map(({ shutdown }) => shutdown()))
})

function portOf(lifecycle: ReturnType<typeof startProxyServer>) {
  return (lifecycle.server as unknown as { port: number }).port
}

function connectionContext(
  connectionId: string,
  principalId: string
): AcpConnectionContext {
  return {
    connectionId,
    principalId,
    lane: "operator",
    runtimeInstance: {} as AcpConnectionContext["runtimeInstance"],
    sessionRows: {} as AcpConnectionContext["sessionRows"],
    readState: {} as AcpConnectionContext["readState"],
    activityFeed: {} as AcpConnectionContext["activityFeed"],
    translators: {} as AcpConnectionContext["translators"],
    rooms: {} as AcpConnectionContext["rooms"],
    attachmentStages: {} as AcpConnectionContext["attachmentStages"],
  }
}

/** A spec-only ACP agent app: it answers `initialize` and nothing else. */
function initializeOnlyAgent() {
  return agent({ name: "spec" }).onRequest(AGENT_METHODS.initialize, () => ({
    protocolVersion: 2,
    info: { name: "spec", version: "0" },
  }))
}

function acpProxy() {
  const lifecycle = startProxyServer({
    app: { fetch: () => new Response("not found", { status: 404 }) },
    sockets: [
      {
        path: AOS_ACP_OPERATOR_PATH,
        service: createAcpService({
          publicOrigin: ORIGIN,
          lane: "operator",
          principalId: OPERATOR_PRINCIPAL,
          agent: initializeOnlyAgent,
          connection: connectionContext,
        }),
      },
    ],
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 1_000,
    installSignalHandlers: false,
  })
  lifecycles.push(lifecycle)
  return lifecycle
}

describe("real Bun WebSocket upgrade", () => {
  it("authorizes before upgrade, sends frames, and cleans up on peer close", async () => {
    let opened = 0
    let closed = 0
    let resolveClosed!: () => void
    const peerClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    const lifecycle = startProxyServer({
      app: { fetch: () => new Response("not found", { status: 404 }) },
      sockets: [
        {
          path: AOS_ACP_OPERATOR_PATH,
          service: {
            authorizeUpgrade: async (request) =>
              request.headers.get("origin") === ORIGIN
                ? { principalId: "operator", connectionId: "connection-1" }
                : undefined,
            open: (_authorization, peer) => {
              opened += 1
              peer.send(JSON.stringify({ jsonrpc: "2.0", method: "opened" }))
              return {
                async receive(raw) {
                  if (raw === "notify")
                    peer.send(
                      JSON.stringify({ jsonrpc: "2.0", method: "notified" })
                    )
                },
                close() {
                  closed += 1
                  resolveClosed()
                },
              }
            },
          },
        },
      ],
      host: "127.0.0.1",
      port: 0,
      shutdownGraceMs: 1_000,
      installSignalHandlers: false,
    })
    lifecycles.push(lifecycle)
    const port = portOf(lifecycle)

    const denied = await fetch(
      `http://127.0.0.1:${port}${AOS_ACP_OPERATOR_PATH}`
    )
    expect(denied.status).toBe(401)
    expect(opened).toBe(0)

    const frames: unknown[] = []
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${AOS_ACP_OPERATOR_PATH}`,
      { headers: { Origin: ORIGIN } }
    )
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)))
        if (frames.length === 1) socket.send("notify")
        if (frames.length === 2) resolve()
      })
      socket.addEventListener("error", reject)
    })

    expect(frames).toEqual([
      { jsonrpc: "2.0", method: "opened" },
      { jsonrpc: "2.0", method: "notified" },
    ])
    expect(opened).toBe(1)
    socket.close()
    await peerClosed
    expect(closed).toBe(1)
  })

  it("answers an ACP initialize first frame over the hosted socket", async () => {
    const port = portOf(acpProxy())

    const denied = await fetch(
      `http://127.0.0.1:${port}${AOS_ACP_OPERATOR_PATH}`
    )
    expect(denied.status).toBe(401)

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${AOS_ACP_OPERATOR_PATH}`,
      { headers: { Origin: ORIGIN } }
    )
    const frames: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 2,
              info: { name: "spec-client", version: "0" },
            },
          })
        )
      )
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)))
        resolve()
      })
      socket.addEventListener("error", reject)
    })

    expect(frames[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 2, info: { name: "spec", version: "0" } },
    })
    socket.close()
  })

  it("carries the ACP connection id on the 101 response", async () => {
    const port = portOf(acpProxy())

    const switching = await new Promise<{
      status: number | undefined
      headers: Record<string, string | string[] | undefined>
    }>((resolve, reject) => {
      const upgrade = request({
        hostname: "127.0.0.1",
        port,
        path: AOS_ACP_OPERATOR_PATH,
        headers: {
          Origin: ORIGIN,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      })
      const settle = (
        response: {
          statusCode?: number | undefined
          headers: Record<string, string | string[] | undefined>
        },
        peer?: { destroy(): void }
      ) => {
        peer?.destroy()
        resolve({ status: response.statusCode, headers: response.headers })
      }
      upgrade.on("upgrade", (response, peer) => settle(response, peer))
      upgrade.on("response", (response) => settle(response))
      upgrade.on("error", reject)
      upgrade.end()
    })

    expect(switching.status).toBe(101)
    expect(switching.headers["acp-connection-id"]).toMatch(/^[0-9a-f-]{36}$/u)
  })
})
