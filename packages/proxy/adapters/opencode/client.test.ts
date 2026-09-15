import { createServer } from "node:http"

import { describe, expect, it } from "vitest"

import {
  OpenCodeClientAbortError,
  OpenCodeClientError,
  createOpenCodeClient,
} from "./client"

type NativeRequest = {
  url: URL
  authorization: string | null
  directory: string | null
  signal: AbortSignal
}

async function nativeServer(
  handler: (request: NativeRequest) => Response | Promise<Response>
) {
  const server = createServer(async (request, response) => {
    const controller = new AbortController()
    request.once("aborted", () => controller.abort())
    response.once("close", () => {
      if (!response.writableEnded) controller.abort()
    })
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const result = await handler({
      url,
      authorization: request.headers.authorization ?? null,
      directory:
        request.headers["x-opencode-directory"] ??
        url.searchParams.get("directory"),
      signal: controller.signal,
    })
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function client(baseUrl: string) {
  return createOpenCodeClient({
    baseUrl,
    directory: "/workspaces/aos",
    username: "operator",
    password: "password",
  })
}

describe("OpenCodeClient", () => {
  it("binds Session pagination to the configured server, directory, and Basic credential", async () => {
    const server = await nativeServer((request) => {
      expect(request.url.pathname).toBe("/api/session")
      expect(request.url.searchParams.get("limit")).toBe("20")
      expect(request.url.searchParams.get("cursor")).toBe("next-page")
      expect(request.directory).toBe("/workspaces/aos")
      expect(request.authorization).toBe("Basic b3BlcmF0b3I6cGFzc3dvcmQ=")
      return Response.json({
        data: [],
        cursor: { previous: "previous-page", next: "following-page" },
      })
    })
    const subject = client(server.baseUrl)

    try {
      await expect(
        subject.sessions.list({ limit: 20, cursor: "next-page" })
      ).resolves.toEqual({
        data: [],
        cursor: { previous: "previous-page", next: "following-page" },
      })
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("returns a bounded public error instead of an upstream error body", async () => {
    const server = await nativeServer(() =>
      Response.json(
        { message: "native-password=do-not-disclose" },
        { status: 503 }
      )
    )
    const subject = client(server.baseUrl)

    try {
      await expect(subject.sessions.list()).rejects.toEqual(
        expect.objectContaining({
          name: "OpenCodeClientError",
          code: "unavailable",
          message: "OpenCode request unavailable",
        })
      )
      await subject.sessions.list().catch((error: unknown) => {
        expect(error).toBeInstanceOf(OpenCodeClientError)
        expect(JSON.stringify(error)).not.toContain("native-password")
        expect(error instanceof Error && error.message).not.toContain(
          "native-password"
        )
      })
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("maps an aborted native read to a cancellation without retrying it", async () => {
    let started: (() => void) | undefined
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    const server = await nativeServer(async () => {
      started?.()
      return await new Promise<Response>((resolve) => {
        setTimeout(() => resolve(Response.json({ data: [], cursor: {} })), 500)
      })
    })
    const subject = client(server.baseUrl)
    const controller = new AbortController()

    try {
      const request = subject.sessions.list({ signal: controller.signal })
      await requested
      controller.abort()
      await expect(request).rejects.toBeInstanceOf(OpenCodeClientAbortError)
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("replays and validates durable Session events from the supplied aggregate position", async () => {
    const server = await nativeServer((request) => {
      expect(request.url.pathname).toBe("/api/session/session-1/event")
      expect(request.url.searchParams.get("after")).toBe("41")
      return new Response(
        [
          'data: {"id":"42","event":"session","data":"{\\"type\\":\\"session.next.text.started\\",\\"properties\\":{\\"sessionID\\":\\"session-1\\"}}"}',
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      )
    })
    const subject = client(server.baseUrl)

    try {
      const stream = await subject.sessions.events("session-1", { after: "41" })
      await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
        done: false,
        value: {
          id: "42",
          event: "session",
          data: {
            type: "session.next.text.started",
            properties: { sessionID: "session-1" },
          },
        },
      })
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("rejects malformed provider payloads before a converter can consume them", async () => {
    const server = await nativeServer(() => Response.json({ data: [] }))
    const subject = client(server.baseUrl)

    try {
      await expect(subject.sessions.list()).rejects.toEqual(
        expect.objectContaining({
          name: "OpenCodeClientError",
          code: "invalid_response",
        })
      )
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("aborts each active observation exactly once when closed repeatedly", async () => {
    let resolveOpened: (() => void) | undefined
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve
    })
    const server = await nativeServer(async (request) => {
      resolveOpened?.()
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      })
      return new Response(null, {
        headers: { "content-type": "text/event-stream" },
      })
    })
    const subject = client(server.baseUrl)

    const stream = await subject.sessions.events("session-1")
    const next = stream[Symbol.asyncIterator]().next()
    await opened
    await Promise.all([subject.close(), subject.close()])
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    await server.close()
  })
})
