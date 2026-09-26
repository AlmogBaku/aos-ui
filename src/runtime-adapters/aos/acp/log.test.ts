import { methods } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, onTestFinished } from "vitest"

import { AOS_META_KEY } from "@aos/protocol/acp"

import { harness } from "../../../../packages/proxy/acp/test-harness"

import { createAcpConnection } from "./connection"
import { acpDebugEnabled, createAcpLogger, frameFields } from "./log"
import { pipedSockets } from "./test-socket"

type Line = Record<string, unknown>

/** The lines a browser connection writes from its start to its close. */
async function connectAndClose(debug: boolean) {
  const lines: Line[] = []
  const test = await harness()
  onTestFinished(() => test.close())
  const connection = createAcpConnection({
    clientInfo: { name: "aos-ui", version: "1" },
    url: "ws://proxy.test/api/aos/v1/acp",
    socketConstructor: pipedSockets(test.agentApp).WebSocket,
    logger: createAcpLogger({ debug, write: (line) => lines.push(line) }),
  })
  const ready = new Promise<void>((resolve) =>
    connection.subscribeStatus((status) => {
      if (status === "ready") resolve()
    })
  )
  connection.start()
  await ready
  connection.close()
  return lines
}

function tabStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe("ACP client logging", () => {
  it("keeps ?debug=acp on for the rest of the tab", () => {
    const tab = tabStorage()

    expect(acpDebugEnabled("", tab)).toBe(false)
    expect(acpDebugEnabled("?debug=acp", tab)).toBe(true)
    expect(acpDebugEnabled("", tab)).toBe(true)
    expect(acpDebugEnabled("", tabStorage())).toBe(false)
  })

  it("writes one line per transition and per wire frame in a debug tab", async () => {
    const lines = await connectAndClose(true)

    expect(
      lines
        .filter(({ msg }) => String(msg).startsWith("connection."))
        .map(({ from, to }) => [from, to])
    ).toEqual([
      ["connecting", "handshaking"],
      ["handshaking", "ready"],
      ["ready", "closed"],
    ])
    const frames = lines.filter(({ msg }) => msg === "acp.frame")
    const initialize = frames.find(
      ({ direction, method }) =>
        direction === "out" && method === methods.agent.initialize
    )
    expect(initialize?.requestId).toBeDefined()
    expect(frames).toContainEqual(
      expect.objectContaining({
        direction: "in",
        requestId: initialize?.requestId,
      })
    )
  })

  it("writes no line without the debug flag", async () => {
    expect(await connectAndClose(false)).toEqual([])
  })

  it("redacts a token under _meta.aos wherever a frame carries one", () => {
    const fields = frameFields("in", {
      jsonrpc: "2.0",
      id: 7,
      result: { _meta: { [AOS_META_KEY]: { token: "secret-token" } } },
    })

    expect(fields).toMatchObject({ direction: "in", requestId: 7 })
    expect(JSON.stringify(fields)).not.toContain("secret-token")
  })
})
