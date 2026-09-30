import { createServer } from "node:http"

import { describe, expect, it } from "vitest"

import { useFakeClock } from "../../../../test/support/fake-clock"

import {
  OpenCodeClientAbortError,
  OpenCodeClientError,
  OpenCodeMutationUncertainError,
  createOpenCodeClient,
} from "./client"
import { openCodeFailure } from "./failures"

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

function client(
  baseUrl: string,
  password: () => Promise<string> = async () => "pw-test-1"
) {
  return createOpenCodeClient({
    baseUrl,
    directory: "/workspaces/aos",
    username: "operator",
    password,
  })
}

type Subject = ReturnType<typeof client>

/** Runs `check` against a client bound to a native server answering with `handler`. */
async function withSubject(
  handler: Parameters<typeof nativeServer>[0],
  check: (subject: Subject) => Promise<unknown>,
  password?: () => Promise<string>
) {
  const server = await nativeServer(handler)
  const subject = client(server.baseUrl, password)
  try {
    await check(subject)
  } finally {
    await subject.close()
    await server.close()
  }
}

describe("OpenCodeClient", () => {
  it("binds Session pagination to the configured server, directory, and a Basic credential read for each request", async () => {
    const authorizations: (string | null)[] = []
    let password = "pw-test-1"
    await withSubject(
      (request) => {
        expect(request.url.pathname).toBe("/api/session")
        expect(request.url.searchParams.get("limit")).toBe("20")
        expect(request.url.searchParams.get("cursor")).toBe("next-page")
        expect(request.directory).toBe("/workspaces/aos")
        authorizations.push(request.authorization)
        return Response.json({
          data: [],
          cursor: { previous: "previous-page", next: "following-page" },
        })
      },
      async (subject) => {
        await expect(
          subject.sessions.list({ limit: 20, cursor: "next-page" })
        ).resolves.toEqual({
          data: [],
          cursor: { previous: "previous-page", next: "following-page" },
        })
        password = "pw-test-2"
        await subject.sessions.list({ limit: 20, cursor: "next-page" })
        expect(authorizations).toEqual([
          "Basic b3BlcmF0b3I6cHctdGVzdC0x",
          "Basic b3BlcmF0b3I6cHctdGVzdC0y",
        ])
      },
      async () => password
    )
  })

  it("holds a password OpenCode refused as refused until it reads another or OpenCode takes it", async () => {
    let accepts = false
    let password = "pw-test-1"
    await withSubject(
      () =>
        accepts
          ? Response.json({
              data: [],
              cursor: { previous: "previous-page", next: "following-page" },
            })
          : new Response(null, { status: 401 }),
      async (subject) => {
        await expect(subject.credentialRefused()).resolves.toBe(false)
        await expect(subject.sessions.list()).rejects.toMatchObject({
          code: "authentication",
        })
        await expect(subject.credentialRefused()).resolves.toBe(true)
        password = "pw-test-2"
        await expect(subject.credentialRefused()).resolves.toBe(false)
        password = "pw-test-1"
        await expect(subject.credentialRefused()).resolves.toBe(true)
        accepts = true
        await subject.sessions.list()
        await expect(subject.credentialRefused()).resolves.toBe(false)
      },
      async () => password
    )
  })

  it("preserves the native ascending message order before cursor pagination", async () => {
    await withSubject(
      (request) => {
        expect(request.url.pathname).toBe("/api/session/session-1/message")
        expect(request.url.searchParams.get("limit")).toBe("20")
        expect(request.url.searchParams.get("order")).toBe("asc")
        expect(request.url.searchParams.get("cursor")).toBeNull()
        return Response.json({ data: [], cursor: {} })
      },
      async (subject) => {
        await expect(
          subject.sessions.messages("session-1", { limit: 20, order: "asc" })
        ).resolves.toEqual({ data: [], cursor: {} })
      }
    )
  })

  it("reads one Session's native Todo list as a bare or enveloped array", async () => {
    const bare = [{ content: "Read the adapter", status: "pending" }]
    for (const body of [bare, { data: bare }]) {
      await withSubject(
        (request) => {
          expect(request.url.pathname).toBe("/session/session-1/todo")
          expect(request.directory).toBe("/workspaces/aos")
          return Response.json(body)
        },
        async (subject) => {
          await expect(subject.sessions.todos("session-1")).resolves.toEqual(
            bare
          )
        }
      )
    }
  })

  it("switches an exact native model with the same uncertain acknowledgement fence", async () => {
    await withSubject(
      async (request) => {
        expect(request.url.pathname).toBe("/api/session/session-1/model")
        expect(JSON.parse(request.body)).toEqual({
          model: { providerID: "openai", id: "gpt-5" },
        })
        return new Response(null, { status: 204 })
      },
      async (subject) => {
        await expect(
          subject.sessions.switchModel("session-1", {
            providerID: "openai",
            id: "gpt-5",
          })
        ).resolves.toBeUndefined()
      }
    )
  })

  it("renames, archives, pins, and deletes through the pre-v2 native Session routes", async () => {
    const seen: Array<{ method: string; pathname: string; body: string }> = []
    await withSubject(
      (request) => {
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
      },
      async (subject) => {
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
      }
    )

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
    await withSubject(
      () =>
        Response.json(
          { message: "native-password=do-not-disclose" },
          { status: 503 }
        ),
      async (subject) => {
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
      }
    )
  })

  it("maps an aborted native read to a cancellation without retrying it", async () => {
    let started: (() => void) | undefined
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    const controller = new AbortController()
    await withSubject(
      async () => {
        started?.()
        return await new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(Response.json({ data: [], cursor: {} })),
            500
          )
        })
      },
      async (subject) => {
        const request = subject.sessions.list({ signal: controller.signal })
        await requested
        controller.abort()
        await expect(request).rejects.toBeInstanceOf(OpenCodeClientAbortError)
      }
    )
  })

  it("replays and validates durable Session events from the supplied aggregate position", async () => {
    // The durable event the v2 route streams, as the pinned SDK types it.
    const durableEvent = {
      id: "native-42",
      type: "session.next.text.ended",
      durable: { aggregateID: "session-1", seq: 42, version: 1 },
      data: {
        timestamp: 1_042,
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        textID: "text-1",
        text: "finished ".repeat(100),
      },
    }
    await withSubject(
      (request) => {
        expect(request.url.pathname).toBe("/api/session/session-1/event")
        expect(request.url.searchParams.get("after")).toBe("41")
        return new Response(
          [
            `data: ${JSON.stringify({
              id: "42",
              event: "session",
              data: JSON.stringify(durableEvent),
            })}`,
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } }
        )
      },
      async (subject) => {
        const stream = await subject.sessions.events("session-1", {
          after: "41",
        })
        await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
          done: false,
          value: { id: "42", event: "session", data: durableEvent },
        })
      }
    )
  })

  it.each([
    {
      body: "a Session page without data",
      answer: {},
      call: (subject: Subject) => subject.sessions.list(),
    },
    {
      body: "a Todo body that is neither a bare nor an enveloped array",
      answer: { todos: [] },
      call: (subject: Subject) => subject.sessions.todos("session-1"),
    },
  ])(
    "rejects $body before a converter can consume it",
    async ({ answer, call }) => {
      await withSubject(
        () => Response.json(answer),
        (subject) =>
          expect(call(subject)).rejects.toMatchObject({
            name: "OpenCodeClientError",
            code: "invalid_response",
          })
      )
    }
  )

  it("aborts each open observation exactly once when closed repeatedly", async () => {
    const subject = createOpenCodeClient({
      baseUrl: "http://127.0.0.1:1",
      directory: "/workspaces/aos",
      username: "operator",
      password: async () => "pw-test-1",
      // An accepted stream that stays open until its request is aborted.
      fetcher: async (input) => {
        const { signal } = input as Request
        signal.throwIfAborted()
        const body = new ReadableStream({
          start: (stream) =>
            signal.addEventListener("abort", () => stream.error(signal.reason)),
        })
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })

    const stream = await subject.sessions.events("session-1")
    const next = stream[Symbol.asyncIterator]().next()
    await Promise.all([subject.close(), subject.close()])
    await expect(next).resolves.toEqual({ done: true, value: undefined })
  })

  it.each([
    { answer: "a lost acknowledgement", response: () => ({ drop: true }) },
    {
      answer: "a malformed successful acknowledgement",
      response: () => Response.json({}),
    },
    {
      answer: "a server error",
      response: () => Response.json({}, { status: 503 }),
    },
  ] satisfies { answer: string; response: () => NativeResponse }[])(
    "classifies $answer to a mutation the server received as uncertain",
    async ({ response }) => {
      let received = false
      await withSubject(
        (request) => {
          expect(request.url.pathname).toBe("/api/session/session-1/prompt")
          received = true
          return response()
        },
        async (subject) => {
          await expect(
            subject.sessions.prompt("session-1", {
              id: "admission-1",
              prompt: { text: "continue" },
            })
          ).rejects.toBeInstanceOf(OpenCodeMutationUncertainError)
          expect(received).toBe(true)
        }
      )
    }
  )

  it("ends a native call, or a stream's opening, that never answers at the adapter call deadline", async () => {
    const clock = useFakeClock()
    const subject = createOpenCodeClient({
      baseUrl: "http://127.0.0.1:1",
      directory: "/workspaces/aos",
      username: "operator",
      password: async () => "pw-test-1",
      fetcher: async (input) =>
        new Promise<Response>((_resolve, reject) => {
          const { signal } = input as Request
          signal.addEventListener("abort", () => reject(signal.reason))
        }),
    })
    const settled = (call: Promise<unknown>) =>
      call.catch((error: unknown) => error)
    const calls = [
      settled(subject.sessions.list()),
      settled(subject.sessions.events("session-1")),
    ]

    await clock.advance(14_999)
    await expect(
      Promise.race([...calls, Promise.resolve("pending")])
    ).resolves.toBe("pending")
    await clock.advance(1)
    // A read past its deadline is unavailable, and names that kind itself.
    for (const call of calls) {
      const error = await call
      expect(error).toMatchObject({ code: "unavailable" })
      expect(openCodeFailure(error)?.kind).toBe("unavailable")
    }
    await subject.close()
  })

  it("classifies caller cancellation after native mutation dispatch as uncertain", async () => {
    let received: (() => void) | undefined
    const dispatched = new Promise<void>((resolve) => {
      received = resolve
    })
    const controller = new AbortController()
    await withSubject(
      async (request) => {
        received?.()
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
        return Response.json({ data: {} })
      },
      async (subject) => {
        const request = subject.sessions.interrupt(
          "session-1",
          controller.signal
        )
        await dispatched
        controller.abort()
        await expect(request).rejects.toBeInstanceOf(
          OpenCodeMutationUncertainError
        )
      }
    )
  })

  it.each([
    [401, "authentication"],
    [503, "unavailable"],
  ] as const)(
    "refuses to open an event stream OpenCode answers %i, as %s",
    async (status, code) => {
      await withSubject(
        () =>
          new Response("native secret must not cross the facade", {
            status,
            headers: { "content-type": "text/event-stream" },
          }),
        async (subject) => {
          await expect(subject.sessions.events("session-1")).rejects.toEqual(
            expect.objectContaining({ name: "OpenCodeClientError", code })
          )
        }
      )
    }
  )
})
