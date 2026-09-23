import { AGENT_METHODS, agent } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { OPERATOR_PRINCIPAL } from "../core/principal"
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
  }
}

function service() {
  const contexts: AcpConnectionContext[] = []
  return {
    contexts,
    acp: createAcpService({
      publicOrigin: ORIGIN,
      lane: "operator",
      principalId: OPERATOR_PRINCIPAL,
      agent(context) {
        contexts.push(context)
        return agent({ name: "spec" }).onRequest(
          AGENT_METHODS.initialize,
          () => ({
            protocolVersion: 2,
            info: { name: "spec", version: "0" },
          })
        )
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
      send(raw: string) {
        frames.push(raw)
        resolveFrame?.()
        resolveFrame = undefined
      },
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
  it("authorizes only the public origin and mints a connection id", async () => {
    const { acp } = service()

    await expect(
      acp.authorizeUpgrade(
        new Request(`${ORIGIN}${PATH}`, {
          headers: { origin: "https://attacker.example.test" },
        })
      )
    ).resolves.toBeUndefined()

    const upgrade = await acp.authorizeUpgrade(
      new Request(`${ORIGIN}${PATH}`, { headers: { origin: ORIGIN } })
    )

    expect(upgrade?.principalId).toBe("operator")
    expect(upgrade?.lane).toBe("operator")
    expect(upgrade?.connectionId).toEqual(expect.any(String))
    expect(upgrade?.headers).toEqual({
      "Acp-Connection-Id": upgrade?.connectionId,
    })
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
    expect(contexts).toEqual([
      connectionContext(upgrade!.connectionId, "operator"),
    ])
    expect(transport.closed).toEqual([])

    socket.close()
    socket.receive(initializeFrame(8))
    expect(transport.frames).toHaveLength(1)
  })

  it("carries the configured principal into the connection context", async () => {
    const contexts: AcpConnectionContext[] = []
    const acp = createAcpService({
      publicOrigin: ORIGIN,
      lane: "guest",
      principalId: "invite-42",
      agent(context) {
        contexts.push(context)
        return agent({ name: "spec" }).onRequest(
          AGENT_METHODS.initialize,
          () => ({ protocolVersion: 2, info: { name: "spec", version: "0" } })
        )
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

    expect(contexts).toEqual([
      connectionContext(upgrade!.connectionId, "invite-42"),
    ])
    socket.close()
  })
})
