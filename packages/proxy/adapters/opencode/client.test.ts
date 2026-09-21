import { createServer } from "node:http"

import { describe, expect, it } from "vitest"

import {
  OpenCodeClientAbortError,
  OpenCodeClientError,
  OpenCodeMutationUncertainError,
  createOpenCodeClient,
} from "./client"

type NativeRequest = {
  method: string
  url: URL
  authorization: string | null
  directory: string | null
  body: string
  signal: AbortSignal
}

type NativeResponse = Response | Readonly<{ drop: true }>

async function nativeServer(
  handler: (request: NativeRequest) => NativeResponse | Promise<NativeResponse>
) {
  const server = createServer(async (request, response) => {
    const controller = new AbortController()
    request.once("aborted", () => controller.abort())
    response.once("close", () => {
      if (!response.writableEnded) controller.abort()
    })
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const result = await handler({
      method: request.method ?? "",
      url,
      authorization: request.headers.authorization ?? null,
      directory:
        request.headers["x-opencode-directory"] ??
        url.searchParams.get("directory"),
      body: Buffer.concat(chunks).toString("utf8"),
      signal: controller.signal,
    })
    if ("drop" in result) {
      response.destroy()
      return
    }
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

  it("preserves the native ascending message order before cursor pagination", async () => {
    const server = await nativeServer((request) => {
      expect(request.url.pathname).toBe("/api/session/session-1/message")
      expect(request.url.searchParams.get("limit")).toBe("20")
      expect(request.url.searchParams.get("order")).toBe("asc")
      expect(request.url.searchParams.get("cursor")).toBeNull()
      return Response.json({ data: [], cursor: {} })
    })
    const subject = client(server.baseUrl)

    try {
      await expect(
        subject.sessions.messages("session-1", { limit: 20, order: "asc" })
      ).resolves.toEqual({ data: [], cursor: {} })
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("switches an exact native model with the same uncertain acknowledgement fence", async () => {
    const server = await nativeServer(async (request) => {
      expect(request.url.pathname).toBe("/api/session/session-1/model")
      expect(JSON.parse(request.body)).toEqual({
        model: { providerID: "openai", id: "gpt-5" },
      })
      return new Response(null, { status: 204 })
    })
    const subject = client(server.baseUrl)

    try {
      await expect(
        subject.sessions.switchModel("session-1", {
          providerID: "openai",
          id: "gpt-5",
        })
      ).resolves.toBeUndefined()
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("renames, archives, pins, and deletes through the pre-v2 native Session routes", async () => {
    const seen: Array<{ method: string; pathname: string; body: string }> = []
    const server = await nativeServer((request) => {
      seen.push({
        method: request.method,
        pathname: request.url.pathname,
        body: request.body,
      })
      if (request.method === "DELETE") return Response.json(true)
      return Response.json({
        id: "session-1",
        title: "Renamed",
        time: { created: 1_000 },
      })
    })
    const subject = client(server.baseUrl)

    try {
      await expect(
        subject.sessions.update("session-1", {
          title: "Renamed",
          time: { archived: 1_700 },
          metadata: { "aos.pinned": true },
        })
      ).resolves.toBeUndefined()
      await expect(
        subject.sessions.delete("session-1")
      ).resolves.toBeUndefined()
      await expect(subject.sessions.delete("")).rejects.toBeInstanceOf(
        OpenCodeClientError
      )
    } finally {
      await subject.close()
      await server.close()
    }

    expect(seen).toEqual([
      {
        method: "PATCH",
        pathname: "/session/session-1",
        body: JSON.stringify({
          title: "Renamed",
          time: { archived: 1_700 },
          metadata: { "aos.pinned": true },
        }),
      },
      { method: "DELETE", pathname: "/session/session-1", body: "" },
    ])
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
    const completedText = "finished ".repeat(100)
    const server = await nativeServer((request) => {
      expect(request.url.pathname).toBe("/api/session/session-1/event")
      expect(request.url.searchParams.get("after")).toBe("41")
      return new Response(
        [
          `data: ${JSON.stringify({
            id: "42",
            event: "session",
            data: JSON.stringify({
              type: "session.next.text.ended",
              properties: { sessionID: "session-1", text: completedText },
            }),
          })}`,
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
            type: "session.next.text.ended",
            properties: { sessionID: "session-1", text: completedText },
          },
        },
      })
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("rejects malformed provider payloads before a converter can consume them", async () => {
    const server = await nativeServer(() => Response.json({}))
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

  it("classifies a lost mutation acknowledgement as uncertain after the server received it", async () => {
    let received = false
    const server = await nativeServer((request) => {
      expect(request.url.pathname).toBe("/api/session/session-1/prompt")
      received = true
      return { drop: true }
    })
    const subject = client(server.baseUrl)

    try {
      await expect(
        subject.sessions.prompt("session-1", {
          id: "admission-1",
          prompt: { text: "continue" },
        })
      ).rejects.toBeInstanceOf(OpenCodeMutationUncertainError)
      expect(received).toBe(true)
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("classifies a malformed successful mutation acknowledgement as uncertain", async () => {
    let received = false
    const server = await nativeServer((request) => {
      expect(request.url.pathname).toBe("/api/session/session-1/prompt")
      received = true
      return Response.json({})
    })
    const subject = client(server.baseUrl)

    try {
      await expect(
        subject.sessions.prompt("session-1", {
          id: "admission-2",
          prompt: { text: "continue" },
        })
      ).rejects.toBeInstanceOf(OpenCodeMutationUncertainError)
      expect(received).toBe(true)
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it("classifies caller cancellation after native mutation dispatch as uncertain", async () => {
    let received: (() => void) | undefined
    const dispatched = new Promise<void>((resolve) => {
      received = resolve
    })
    const server = await nativeServer(async (request) => {
      received?.()
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      })
      return Response.json({ data: {} })
    })
    const subject = client(server.baseUrl)
    const controller = new AbortController()

    try {
      const request = subject.sessions.interrupt("session-1", controller.signal)
      await dispatched
      controller.abort()
      await expect(request).rejects.toBeInstanceOf(
        OpenCodeMutationUncertainError
      )
    } finally {
      await subject.close()
      await server.close()
    }
  })

  it.each([
    [401, "authentication"],
    [503, "unavailable"],
  ] as const)(
    "preserves status-only SSE %i failures as %s",
    async (status, code) => {
      const server = await nativeServer(
        () =>
          new Response("native secret must not cross the facade", {
            status,
            headers: { "content-type": "text/event-stream" },
          })
      )
      const subject = client(server.baseUrl)

      try {
        const stream = await subject.sessions.events("session-1")
        await expect(stream[Symbol.asyncIterator]().next()).rejects.toEqual(
          expect.objectContaining({ name: "OpenCodeClientError", code })
        )
      } finally {
        await subject.close()
        await server.close()
      }
    }
  )

  it("releases an unconsumed observation when it is aborted", async () => {
    let requests = 0
    const server = await nativeServer(() => {
      requests += 1
      return new Response(null, {
        headers: { "content-type": "text/event-stream" },
      })
    })
    const subject = client(server.baseUrl)

    try {
      const stream = await subject.sessions.events("session-1")
      stream.abort()
      await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
        done: true,
        value: undefined,
      })
      expect(requests).toBe(0)
    } finally {
      await subject.close()
      await server.close()
    }
  })
})
