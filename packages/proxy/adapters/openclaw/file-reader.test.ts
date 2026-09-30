import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { inspect } from "node:util"

import { describe, expect, it, onTestFinished } from "vitest"

import { captureLogs } from "../../../../test/support/log-capture"
import { OpenClawClientUnavailableError } from "./client"
import { composeOpenClawRuntime } from "./factory"
import { OpenClawNativePayloadError } from "./native-schemas"
import { AGENT_WORKSPACE, stubOpenClawClient } from "./test-utils/fake-openclaw"

const scope = {
  agentId: "research",
  providerSessionId: "agent:research:main",
  sessionId: "t1",
}
const REPORT = `${AGENT_WORKSPACE}/report.md`
const MISSING = `${AGENT_WORKSPACE}/missing.md`
const signal = new AbortController().signal

/**
 * The file reader of an OpenClaw runtime over a gateway on a local port. Its
 * `config.get` answers `basePath`; its HTTP side records each request,
 * redirects under `/moved`, answers 404 for `MISSING`, and serves any other
 * file. Each read presents the device token `token.value` holds.
 */
async function openClaw(
  basePath: unknown,
  token = { value: "device-token-1" }
) {
  const received: {
    path: string
    query: Record<string, string>
    headers: IncomingHttpHeaders
  }[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://gateway")
    received.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
    })
    if (url.pathname.startsWith("/moved/"))
      response.writeHead(302, { location: "/elsewhere" }).end()
    else if (url.searchParams.get("source") === MISSING)
      response.writeHead(404).end()
    else response.end("quarterly totals")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  let up = false
  const client = stubOpenClawClient(
    async (method: string) => {
      // A call before the link is up fails, as the real client's does.
      if (!up) throw new OpenClawClientUnavailableError()
      if (method !== "config.get") throw new Error(`Unexpected ${method}`)
      return { config: { gateway: { controlUi: { basePath } } } }
    },
    {
      start: async () => {
        up = true
      },
    }
  )
  const { runtime, close } = composeOpenClawRuntime({
    baseUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    credentials: async () => ({ deviceToken: token.value }) as never,
    logger: captureLogs().logger,
    clientFactory: () => client,
  })
  onTestFinished(close)
  return { reader: runtime.readFile!, runtime, received, token }
}

describe("OpenClaw MCP App file reads", () => {
  it("asks the media route for the Session's file with the token read afresh", async () => {
    const { reader, received, token } = await openClaw("/openclaw")

    const report = await reader.read(scope, REPORT, {
      range: "bytes=0-7",
      signal,
    })
    token.value = "device-token-2"
    const missing = await reader.read(scope, MISSING, { signal })

    await expect(report.text()).resolves.toBe("quarterly totals")
    expect(missing.status).toBe(404)
    const request = (source: string, deviceToken: string) => ({
      path: "/openclaw/__openclaw__/assistant-media",
      query: {
        source,
        sessionKey: scope.providerSessionId,
        agentId: scope.agentId,
      },
      headers: expect.objectContaining({
        authorization: `Bearer ${deviceToken}`,
        // Fetch adds its own `identity` to a ranged read.
        "accept-encoding": expect.stringMatching(/^identity(?:, identity)?$/u),
        accept: "application/octet-stream",
      }),
    })
    expect(received).toEqual([
      request(REPORT, "device-token-1"),
      request(MISSING, "device-token-2"),
    ])
    expect(received.map(({ headers }) => headers.range)).toEqual([
      "bytes=0-7",
      undefined,
    ])
  })

  it.each([
    [" openclaw/ ", "/openclaw/__openclaw__/assistant-media"],
    ["/", "/__openclaw__/assistant-media"],
    [undefined, "/__openclaw__/assistant-media"],
  ])(
    "reads under the base path %j as the gateway serves it",
    async (basePath, path) => {
      const { reader, received } = await openClaw(basePath)

      await reader.read(scope, REPORT, { signal })

      expect(received.map((each) => each.path)).toEqual([path])
    }
  )

  it.each([
    "//evil",
    "https://evil",
    "/a/../b",
    "/a/%2e%2e/b",
    "/a\\b",
    "/a@b",
    "/a?x",
    42,
  ])("refuses the base path %j before any request", async (basePath) => {
    const { reader, received } = await openClaw(basePath)

    await expect(reader.read(scope, REPORT, { signal })).rejects.toBeInstanceOf(
      OpenClawNativePayloadError
    )
    expect(received).toEqual([])
  })

  it("follows no redirect, so the token goes nowhere else", async () => {
    const { reader, runtime, received } = await openClaw("/moved")

    await expect(reader.read(scope, REPORT, { signal })).rejects.toSatisfy(
      (error) => runtime.publicError(error)?.kind === "unavailable"
    )
    expect(received.map((each) => each.path)).toEqual([
      "/moved/__openclaw__/assistant-media",
    ])
  })

  it("sends nothing for a read already abandoned", async () => {
    const { reader, received } = await openClaw("/openclaw")

    await expect(
      reader.read(scope, REPORT, { signal: AbortSignal.abort() })
    ).rejects.toBeInstanceOf(Error)
    expect(received).toEqual([])
  })

  it("keeps the device token out of a failed read's error", async () => {
    // A header value fetch refuses, which its own error quotes.
    const { reader, runtime, received } = await openClaw("/openclaw", {
      value: "device-token\n2",
    })

    const error = await reader
      .read(scope, REPORT, { signal })
      .catch((caught: unknown) => caught)

    expect(runtime.publicError(error)?.kind).toBe("unavailable")
    expect(inspect(error)).not.toContain("device-token")
    expect(received).toEqual([])
  })

  it("refuses a path the gateway would trim to another one", async () => {
    const { reader, runtime, received } = await openClaw("/openclaw")

    await expect(
      reader.read(scope, `${AGENT_WORKSPACE}/.. `, { signal })
    ).rejects.toSatisfy((error) => runtime.publicError(error)?.kind === "gone")
    expect(received).toEqual([])
  })
})
