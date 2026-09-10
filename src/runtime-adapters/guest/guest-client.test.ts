import { afterEach, describe, expect, it, vi } from "vitest"

import {
  GuestClient,
  captureInviteToken,
  parseGuestBootstrap,
} from "./guest-client"

afterEach(() => vi.restoreAllMocks())

describe("guest bootstrap", () => {
  it("accepts a scoped artifact descriptor in guest history", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        messages: [
          {
            id: "assistant-artifact",
            role: "assistant",
            content: [
              {
                type: "artifact",
                artifact: {
                  id: "artifact-1",
                  filename: "Report.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 42,
                  source: { type: "provider", reference: "artifact-1" },
                },
              },
            ],
          },
        ],
        running: false,
      })
    )
    const client = new GuestClient(
      {
        conversation: "artifact-chat",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await client.loadHistory()
    expect(client.getSnapshot().messages[0]?.content[0]).toMatchObject({
      type: "artifact",
      artifact: { id: "artifact-1", filename: "Report.pdf" },
    })
  })

  it("downloads an artifact through the bound guest conversation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("pdf", { headers: { "content-type": "application/pdf" } })
      )
    const client = new GuestClient(
      {
        conversation: "artifact-chat",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    const blob = await client.artifact(
      "artifact/one",
      new AbortController().signal
    )

    expect(blob.type).toBe("application/pdf")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/guest/artifact?id=artifact%2Fone"
    )
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get("X-AOS-Conversation")).toBe("artifact-chat")
  })

  const capabilities = {
    attachments: false,
    edit: false,
    regenerate: false,
    branches: false,
    questions: false,
    transcription: false,
    speech: false,
  }

  it("rejects malformed bootstrap data", () => {
    expect(() => parseGuestBootstrap({ conversation: "x" })).toThrow(
      "Invalid guest bootstrap"
    )
  })

  it("accepts an editable prefill only for a new conversation", () => {
    expect(
      parseGuestBootstrap({
        conversation: "new-conversation",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "new",
        prefill: "Help me get started",
        capabilities,
      })
    ).toMatchObject({ state: "new", prefill: "Help me get started" })

    expect(() =>
      parseGuestBootstrap({
        conversation: "existing-conversation",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        prefill: "Must not be returned",
        capabilities,
      })
    ).toThrow("Invalid guest bootstrap")
  })

  it("rejects unknown browser-facing bootstrap fields", () => {
    expect(() =>
      parseGuestBootstrap({
        conversation: "new-conversation",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "new",
        serverOnly: "private server-side context",
        capabilities,
      })
    ).toThrow("Invalid guest bootstrap")
  })

  it("captures the invite fragment and removes it from the URL", () => {
    history.replaceState({}, "", "/join#invite=secret-token")
    expect(captureInviteToken()).toBe("secret-token")
    expect(location.href).not.toContain("secret-token")
    expect(location.hash).toBe("")
  })
})

describe("GuestClient", () => {
  it("invokes a browser-branded fetch transport without rebinding its receiver", async () => {
    const fetcher = function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation")
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], running: false }), {
          headers: { "content-type": "application/json" },
        })
      )
    } as typeof fetch
    const client = new GuestClient(
      {
        conversation: "browser-fetch",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await expect(client.loadHistory()).resolves.toBeUndefined()
  })

  it("binds every scoped request to the bootstrapped conversation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ messages: [], running: false }), {
        headers: { "content-type": "application/json" },
      })
    )
    const client = new GuestClient(
      {
        conversation: "invite-a",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: true,
          edit: true,
          regenerate: true,
          branches: false,
          questions: false,
          transcription: true,
          speech: true,
        },
      },
      { fetcher }
    )

    await client.loadHistory()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("/api/guest/history")
    expect(init?.credentials).toBe("same-origin")
    expect(new Headers(init?.headers).get("X-AOS-Conversation")).toBe(
      "invite-a"
    )
  })

  it("expires permanently when the server rejects its scope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "conversation_mismatch" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new GuestClient(
      {
        conversation: "stale-tab",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )
    await expect(client.loadHistory()).rejects.toThrow("conversation_mismatch")
    expect(client.getSnapshot().revoked).toBe(true)
  })

  it("recovers history without revoking or resending after an uncertain send", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "uncertain" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "accepted-or-not",
                role: "user",
                content: [{ type: "text", text: "Hello" }],
              },
            ],
            running: false,
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
    const client = new GuestClient(
      {
        conversation: "uncertain-send",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await expect(
      client.send([{ type: "text", text: "Hello" }])
    ).rejects.toThrow("uncertain")
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/guest/send",
      "/api/guest/history",
    ])
    expect(client.getSnapshot()).toMatchObject({
      revoked: false,
      error: "uncertain",
      messages: [{ id: "accepted-or-not" }],
    })
  })

  it("keeps a transient HTTP failure visible and retryable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new GuestClient(
      {
        conversation: "temporarily-unavailable",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await expect(client.loadHistory()).rejects.toThrow("unavailable")
    expect(client.getSnapshot()).toMatchObject({
      revoked: false,
      loading: false,
      error: "unavailable",
    })
  })

  it("treats expiresAt as a Unix timestamp in seconds", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new GuestClient(
      {
        conversation: "future-invite",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    expect(client.getSnapshot().revoked).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("revokes the guest when the event stream reports an expired invite", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('event: error\ndata: {"error":"invalid-invite"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    )
    const client = new GuestClient(
      {
        conversation: "expired-stream",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    client.connect()
    await vi.waitFor(() => expect(client.getSnapshot().revoked).toBe(true))
  })

  it("reconnects the event stream after an ordinary EOF", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", { headers: { "content-type": "text/event-stream" } })
      )
      .mockResolvedValueOnce(
        new Response(
          'event: snapshot\ndata: {"messages":[],"running":false}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        )
      )
    const client = new GuestClient(
      {
        conversation: "reconnecting-stream",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    const disconnect = client.connect()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    })
    disconnect()
    expect(client.getSnapshot().revoked).toBe(false)
  })

  it("accepts typed pending questions without native identifiers", async () => {
    const boundedHeader = "H".repeat(256)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [],
          pendingQuestions: [
            {
              id: "opaque-question-1",
              questions: [
                {
                  header: boundedHeader,
                  question: "Continue?",
                  options: [
                    { label: "Yes", description: "Continue the review" },
                    { label: "No", description: "Stop here" },
                  ],
                  multiple: false,
                  custom: true,
                },
              ],
            },
          ],
          running: false,
        }),
        { headers: { "content-type": "application/json" } }
      )
    )
    const client = new GuestClient(
      {
        conversation: "display-projection",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: true,
          questions: true,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await client.loadHistory()
    expect(client.getSnapshot().pendingQuestions).toEqual([
      {
        id: "opaque-question-1",
        questions: [
          {
            header: boundedHeader,
            question: "Continue?",
            options: [
              { label: "Yes", description: "Continue the review" },
              { label: "No", description: "Stop here" },
            ],
            multiple: false,
            custom: true,
          },
        ],
      },
    ])

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [],
          pendingQuestions: [
            {
              id: "opaque-question-1",
              sessionID: "native-session-must-not-cross-the-boundary",
              questions: [],
            },
          ],
          running: false,
        }),
        { headers: { "content-type": "application/json" } }
      )
    )
    await expect(client.loadHistory()).rejects.toThrow("Invalid guest history")
  })

  it.each([
    {
      name: "edit",
      path: "/api/guest/edit",
      run: (client: GuestClient) =>
        client.edit("user-message", [{ type: "text" as const, text: "new" }]),
    },
    {
      name: "regenerate",
      path: "/api/guest/regenerate",
      run: (client: GuestClient) => client.regenerate("user-message"),
    },
  ])("refreshes authoritative history after $name", async ({ path, run }) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        String(input) === "/api/guest/history"
          ? new Response(JSON.stringify({ messages: [], running: false }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ ok: true }), { status: 202 })
      )
    )
    const client = new GuestClient(
      {
        conversation: "mutation-conversation",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: true,
          edit: true,
          regenerate: true,
          branches: false,
          questions: false,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await run(client)

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      path,
      "/api/guest/history",
    ])
  })

  it("submits an ordered question reply within the conversation scope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new GuestClient(
      {
        conversation: "question-conversation",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: true,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await client.replyToQuestion("opaque-question-1", [
      ["Fast", "Thorough"],
      ["A custom answer"],
    ])
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("/api/guest/question/reply")
    expect(new Headers(init?.headers).get("X-AOS-Conversation")).toBe(
      "question-conversation"
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      questionId: "opaque-question-1",
      answers: [["Fast", "Thorough"], ["A custom answer"]],
    })
  })

  it("rejects a pending question through its explicit scoped route", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 202 })
      )
    const client = new GuestClient(
      {
        conversation: "question-conversation",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        state: "existing",
        capabilities: {
          attachments: false,
          edit: false,
          regenerate: false,
          branches: false,
          questions: true,
          transcription: false,
          speech: false,
        },
      },
      { fetcher }
    )

    await client.rejectQuestion("opaque-question-1")
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("/api/guest/question/reject")
    expect(new Headers(init?.headers).get("X-AOS-Conversation")).toBe(
      "question-conversation"
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      questionId: "opaque-question-1",
    })
  })
})
