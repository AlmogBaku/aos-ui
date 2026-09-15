import type { RunAgentInput } from "@ag-ui/client"
import { toAgUiMessages } from "@assistant-ui/react-ag-ui"
import { describe, expect, it, vi } from "vitest"

import { AosRemoteClient, createAosRunAgent } from "./aos-client"

function collect(
  agent: ReturnType<typeof createAosRunAgent>,
  input: RunAgentInput
) {
  return new Promise<unknown[]>((resolve, reject) => {
    const events: unknown[] = []
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    })
  })
}

describe("AOS normalized HttpAgent transport", () => {
  it.each([
    { result: { "aos.composerPrefill": 42 }, outcome: { type: "success" } },
    {
      result: { "aos.composerPrefill": "x".repeat(1_048_577) },
      outcome: { type: "success" },
    },
    {
      result: { "aos.composerPrefill": "א".repeat(524_289) },
      outcome: { type: "success" },
    },
    { result: { "aos.composerPrefill": "draft" } },
    {
      result: { "aos.composerPrefill": "draft" },
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "question-1", reason: "input-required" }],
      },
    },
    {
      result: { "aos.composerPrefill": "draft" },
      outcome: { type: "success" },
      threadId: "another-session",
    },
    {
      result: { "aos.composerPrefill": "draft" },
      outcome: { type: "success" },
      runId: "another-run",
    },
  ])(
    "ignores invalid or unsuccessful composer prefill results %#",
    async (finish) => {
      const onComposerPrefill = vi.fn(async () => undefined)
      const agent = createAosRunAgent({
        agentId: "researcher",
        threadId: "session-1",
        onComposerPrefill,
        fetcher: vi.fn(
          async () =>
            new Response(
              `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "session-1", runId: "run-1", ...finish })}\n\n`,
              { headers: { "content-type": "text/event-stream" } }
            )
        ),
      })
      await collect(agent, {
        threadId: "session-1",
        runId: "run-1",
        state: {},
        messages: [{ id: "user-1", role: "user", content: "/undo" }],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      expect(onComposerPrefill).not.toHaveBeenCalled()
    }
  )

  it("applies a successful run composer prefill result", async () => {
    const onComposerPrefill = vi.fn(async () => undefined)
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "session-1",
      onComposerPrefill,
      fetcher: vi.fn(
        async () =>
          new Response(
            'data: {"type":"RUN_FINISHED","threadId":"session-1","runId":"run-1","result":{"aos.composerPrefill":"Earlier question"},"outcome":{"type":"success"}}\n\n',
            { headers: { "content-type": "text/event-stream" } }
          )
      ),
    })

    await collect(agent, {
      threadId: "session-1",
      runId: "run-1",
      state: {},
      messages: [{ id: "user-1", role: "user", content: "/undo" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(onComposerPrefill).toHaveBeenCalledOnce()
    expect(onComposerPrefill).toHaveBeenCalledWith("Earlier question")
  })

  it("does not forward restored PLAN activity as Hermes prompt history", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'data: {"type":"RUN_FINISHED","threadId":"session-1","runId":"run-1","outcome":{"type":"success"}}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        )
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "session-1",
      fetcher,
    })

    await collect(agent, {
      threadId: "session-1",
      runId: "run-1",
      state: {},
      messages: [
        {
          id: "aos-plan:session-1",
          role: "activity",
          activityType: "PLAN",
          content: {
            todos: [{ id: "ship", label: "Ship", status: "active" }],
          },
        },
        { id: "user-1", role: "user", content: "Continue" },
      ],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(
      JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages
    ).toEqual([{ id: "user-1", role: "user", content: "Continue" }])
  })

  it("posts a complete interrupt resume without browser messages or state", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'data: {"type":"RUN_FINISHED","threadId":"session-1","runId":"resume-segment","outcome":{"type":"success"}}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        )
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "session-1",
      fetcher,
    })

    await collect(agent, {
      threadId: "session-1",
      runId: "resume-segment",
      state: { browser: "authority" },
      messages: [{ id: "old-user", role: "user", content: "Do not send" }],
      tools: [],
      context: [],
      forwardedProps: {},
      resume: [
        {
          interruptId: "approval-1",
          status: "resolved",
          payload: { approved: true },
        },
        { interruptId: "question-1", status: "cancelled" },
      ],
    })

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      threadId: "session-1",
      runId: "resume-segment",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      resume: [
        {
          interruptId: "approval-1",
          status: "resolved",
          payload: { approved: true },
        },
        { interruptId: "question-1", status: "cancelled" },
      ],
    })
  })

  it("presents a normalized run error description instead of its JSON payload", async () => {
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "hermes:researcher:stored",
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              description:
                "The service is temporarily unavailable. Please try again.",
            },
          },
          { status: 503 }
        )
      ),
    })

    await expect(
      collect(agent, {
        threadId: "hermes:researcher:stored",
        runId: "run-1",
        state: {},
        messages: [{ id: "message-1", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      })
    ).rejects.toThrow(
      "HTTP 503: The service is temporarily unavailable. Please try again."
    )
  })

  it("reconnects an interrupted run without resending the user prompt", async () => {
    const threadId = "hermes:researcher:stored"
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          [
            "id: 41",
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}`,
            `data: ${JSON.stringify({
              type: "RUN_ERROR",
              message: "Reconnect",
              code: "AOS_CONNECTION_INTERRUPTED",
            })}`,
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          [
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}`,
            `data: ${JSON.stringify({
              type: "TEXT_MESSAGE_START",
              messageId: "assistant-1",
              role: "assistant",
            })}`,
            `data: ${JSON.stringify({
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "assistant-1",
              delta: "Recovered",
            })}`,
            `data: ${JSON.stringify({ type: "TEXT_MESSAGE_END", messageId: "assistant-1" })}`,
            `data: ${JSON.stringify({
              type: "RUN_FINISHED",
              threadId,
              runId: "run-1",
              outcome: { type: "success" },
            })}`,
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } }
        )
      )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId,
      fetcher,
    })

    const events = await collect(agent, {
      threadId,
      runId: "run-1",
      state: {},
      messages: [{ id: "message-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/reconnect"
    )
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      threadId,
      runId: "run-1",
      after: 41,
    })
  })

  it("keeps reconnecting through the normalized endpoint until terminal output", async () => {
    const threadId = "hermes:researcher:stored"
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}\n\ndata: ${JSON.stringify({ type: "RUN_ERROR", code: "AOS_CONNECTION_INTERRUPTED", message: "Reconnect" })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}\n\ndata: ${JSON.stringify({ type: "RUN_ERROR", code: "AOS_CONNECTION_INTERRUPTED", message: "Reconnect again" })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}\n\ndata: ${JSON.stringify({ type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" })}\n\ndata: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "Done" })}\n\ndata: ${JSON.stringify({ type: "TEXT_MESSAGE_END", messageId: "assistant-1" })}\n\ndata: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId: "run-1", outcome: { type: "success" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        )
      )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId,
      fetcher,
    })

    const events = await collect(agent, {
      threadId,
      runId: "run-1",
      state: {},
      messages: [{ id: "message-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/reconnect",
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/reconnect",
    ])
  })

  it("reconnects when the operator SSE body fails before a terminal event", async () => {
    const threadId = "hermes:researcher:stored"
    let pulls = 0
    const interrupted = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          if (pulls === 1) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}\n\n`
              )
            )
            return
          }
          controller.error(new Error("socket lost"))
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(
        new Response(
          [
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId: "run-1" })}`,
            `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId: "run-1", outcome: { type: "success" } })}`,
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } }
        )
      )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId,
      fetcher,
    })

    const events = await collect(agent, {
      threadId,
      runId: "run-1",
      state: {},
      messages: [{ id: "message-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("stages AG-UI attachment content and forwards only text with the opaque stage id", async () => {
    const stageAttachments = vi.fn(async () => ({
      stageId: "stage-1",
      attachments: [],
    }))
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input
        void _init
        return new Response(
          'data: {"type":"RUN_FINISHED","threadId":"opaque-session-1","runId":"run-1","outcome":{"type":"success"}}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        )
      }
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "opaque-session-1",
      fetcher,
      stageAttachments,
    })

    const messages = toAgUiMessages([
      {
        id: "new-user",
        role: "user",
        content: [{ type: "text", text: "Please read this" }],
        attachments: [
          {
            name: "brief.txt",
            contentType: "text/plain",
            content: [
              {
                type: "file",
                data: "data:text/plain;base64,SGk=",
                filename: "brief.txt",
                mimeType: "text/plain",
              },
            ],
          },
        ],
        metadata: { custom: {} },
      },
    ])

    await collect(agent, {
      threadId: "opaque-session-1",
      runId: "run-1",
      state: {},
      messages,
      tools: [],
      context: [],
      forwardedProps: {},
    })

    expect(stageAttachments).toHaveBeenCalledWith("opaque-session-1", [
      {
        type: "file",
        dataUrl: "data:text/plain;base64,SGk=",
        filename: "brief.txt",
        mimeType: "text/plain",
      },
    ])
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      messages: [{ id: "new-user", role: "user", content: "Please read this" }],
      forwardedProps: { aosAttachmentStageId: "stage-1" },
    })
    expect(JSON.stringify(fetcher.mock.calls[0]?.[1]?.body)).not.toContain(
      "SGk="
    )
  })

  it("posts only the trailing user turn with empty browser authority", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input
        void _init
        return new Response(
          [
            'data: {"type":"RUN_STARTED","threadId":"hermes:researcher:stored","runId":"run-1"}',
            'data: {"type":"RUN_FINISHED","threadId":"hermes:researcher:stored","runId":"run-1","outcome":{"type":"success"}}',
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } }
        )
      }
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "hermes:researcher:stored",
      fetcher,
    })

    await collect(agent, {
      threadId: "hermes:researcher:stored",
      runId: "run-1",
      state: { injected: "browser state" },
      messages: [
        { id: "old-user", role: "user", content: "Earlier" },
        { id: "old-assistant", role: "assistant", content: "History" },
        { id: "new-user", role: "user", content: "New turn" },
      ],
      tools: [
        {
          name: "unsafe_browser_tool",
          description: "must not cross",
          parameters: { type: "object", properties: {} },
        },
      ],
      context: [{ description: "browser role", value: "admin" }],
      forwardedProps: { provider: "native" },
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    if (!init) throw new Error("Missing projected request init")
    expect(url).toBe(
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs"
    )
    expect(init.credentials).toBe("same-origin")
    expect(JSON.parse(String(init.body))).toEqual({
      threadId: "hermes:researcher:stored",
      runId: "run-1",
      state: {},
      messages: [{ id: "new-user", role: "user", content: "New turn" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })
  })

  it("carries only an explicit rewind source alongside the replacement turn", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'data: {"type":"RUN_FINISHED","threadId":"stored","runId":"edit-run","outcome":{"type":"success"}}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        )
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "stored",
      fetcher,
    })

    await collect(agent, {
      threadId: "stored",
      runId: "edit-run",
      state: {},
      messages: [
        { id: "hermes-row-1", role: "user", content: "Keep" },
        { id: "hermes-row-2", role: "assistant", content: "Kept reply" },
        { id: "replacement", role: "user", content: "Edited turn" },
      ],
      tools: [],
      context: [],
      forwardedProps: {
        runConfig: { "aos.rewindSourceId": "hermes-row-3" },
      },
    })

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      threadId: "stored",
      runId: "edit-run",
      state: {},
      messages: [{ id: "replacement", role: "user", content: "Edited turn" }],
      tools: [],
      context: [],
      forwardedProps: { "aos.rewindSourceId": "hermes-row-3" },
    })
  })

  it("does not forward an unpersisted stopped turn as a Hermes rewind source", async () => {
    const resolveRewindSourceId = vi.fn(async () => undefined)
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'data: {"type":"RUN_FINISHED","threadId":"stored","runId":"edit-run","outcome":{"type":"success"}}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        )
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "stored",
      fetcher,
      resolveRewindSourceId,
    })

    await collect(agent, {
      threadId: "stored",
      runId: "edit-run",
      state: {},
      messages: [{ id: "replacement", role: "user", content: "Edited turn" }],
      tools: [],
      context: [],
      forwardedProps: {
        runConfig: {
          "aos.rewindSourceId": "local-stopped-turn",
          "aos.rewindSourceText": "Original stopped turn",
        },
      },
    })

    expect(resolveRewindSourceId).toHaveBeenCalledWith(
      "local-stopped-turn",
      { localMessageId: "replacement", text: "Edited turn" },
      "Original stopped turn"
    )
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      messages: [{ id: "replacement", content: "Edited turn" }],
      forwardedProps: {},
    })
  })

  it("resolves a live local turn to its authoritative Hermes row by original text", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith("/history?limit=200&offset=0"))
        return Response.json({
          sessionId: "stored",
          messages: [
            {
              id: "hermes-row-7",
              role: "user",
              content: [{ type: "text", text: "Original live turn" }],
              createdAt: "2026-09-15T08:00:00.000Z",
            },
          ],
          total: 1,
          limit: 200,
          offset: 0,
          nextOffset: 1,
        })
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership("stored", "researcher")

    await expect(
      client.resolveRewindSourceId(
        "stored",
        "local-live-turn",
        { localMessageId: "replacement", text: "Edited turn" },
        "Original live turn"
      )
    ).resolves.toBe("hermes-row-7")
  })

  it("treats a stopped local turn absent from Hermes history as unpersisted", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        sessionId: "stored",
        messages: [],
        total: 0,
        limit: 200,
        offset: 0,
        nextOffset: 0,
      })
    )
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership("stored", "researcher")

    await expect(
      client.resolveRewindSourceId(
        "stored",
        "local-stopped-turn",
        { localMessageId: "replacement", text: "Edited turn" },
        "Original stopped turn"
      )
    ).resolves.toBeUndefined()
  })

  it("does not mistake an older identical turn for an unpersisted stopped turn", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        sessionId: "stored",
        messages: [
          {
            id: "older-identical",
            role: "user",
            content: [{ type: "text", text: "Repeated text" }],
            createdAt: "2026-09-15T07:00:00.000Z",
          },
          {
            id: "latest-durable",
            role: "user",
            content: [{ type: "text", text: "Different durable turn" }],
            createdAt: "2026-09-15T08:00:00.000Z",
          },
        ],
        total: 2,
        limit: 200,
        offset: 0,
        nextOffset: 2,
      })
    )
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership("stored", "researcher")

    await expect(
      client.resolveRewindSourceId(
        "stored",
        "local-stopped-turn",
        { localMessageId: "replacement", text: "Edited turn" },
        "Repeated text"
      )
    ).resolves.toBeUndefined()
  })

  it("keeps the live question when an edited run pauses for an interrupt", async () => {
    const onRewindCompleted = vi.fn(async () => undefined)
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: "RUN_FINISHED",
            threadId: "stored",
            runId: "edit-run",
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: "question-1",
                  reason: "input-required",
                  message: "Choose an option",
                  responseSchema: { type: "object" },
                },
              ],
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        )
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "stored",
      fetcher,
      onRewindCompleted,
    })

    const events = await collect(agent, {
      threadId: "stored",
      runId: "edit-run",
      state: {},
      messages: [{ id: "replacement", role: "user", content: "Edited turn" }],
      tools: [],
      context: [],
      forwardedProps: {
        runConfig: { "aos.rewindSourceId": "hermes-row-3" },
      },
    })

    expect(events.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt" },
    })
    expect(onRewindCompleted).not.toHaveBeenCalled()
  })

  it("resolves a second edit against the replacement turn's authoritative Hermes row", async () => {
    let historyReads = 0
    const runBodies: Record<string, unknown>[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/history?limit=200&offset=0")) {
        historyReads += 1
        const id = historyReads === 1 ? "hermes-row-3" : "hermes-row-8"
        return Response.json({
          sessionId: "stored",
          messages: [
            {
              id,
              role: "user",
              createdAt: "2026-09-14T20:00:00.000Z",
              content: [{ type: "text", text: "Edited turn" }],
            },
          ],
          total: 1,
          limit: 200,
          offset: 0,
          nextOffset: 1,
        })
      }
      if (url.endsWith("/runs")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        runBodies.push(body)
        return new Response(
          `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "stored", runId: body.runId, outcome: { type: "success" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        )
      }
      throw new Error(`Unexpected normalized request: ${url}`)
    })
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership("stored", "researcher")
    await client.loadHistory("stored")
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "stored",
      fetcher,
      resolveRewindSourceId: (sourceId, replacement) =>
        client.resolveRewindSourceId("stored", sourceId, replacement),
      onRewindCompleted: async (replacement) => {
        await client.reconcileRewindReplacement("stored", replacement)
      },
    })

    await collect(agent, {
      threadId: "stored",
      runId: "edit-1",
      state: {},
      messages: [{ id: "local-edit-1", role: "user", content: "Edited turn" }],
      tools: [],
      context: [],
      forwardedProps: {
        runConfig: { "aos.rewindSourceId": "hermes-row-3" },
      },
    })
    await collect(agent, {
      threadId: "stored",
      runId: "edit-2",
      state: {},
      messages: [{ id: "local-edit-2", role: "user", content: "Edited again" }],
      tools: [],
      context: [],
      forwardedProps: {
        runConfig: { "aos.rewindSourceId": "local-edit-1" },
      },
    })

    expect(
      runBodies.map(
        (body) =>
          (body.forwardedProps as Record<string, unknown>)["aos.rewindSourceId"]
      )
    ).toEqual(["hermes-row-3", "hermes-row-8"])
  })

  it("retains authoritative identities for multiple independently edited turns", async () => {
    let historyReads = 0
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (!url.endsWith("/history?limit=200&offset=0"))
        throw new Error(`Unexpected normalized request: ${url}`)
      historyReads += 1
      const messages = [
        {
          id: "hermes-row-8",
          role: "user",
          createdAt: "2026-09-14T20:00:00.000Z",
          content: [{ type: "text", text: "First edited turn" }],
        },
      ]
      if (historyReads > 1)
        messages.push({
          id: "hermes-row-12",
          role: "user",
          createdAt: "2026-09-14T20:01:00.000Z",
          content: [{ type: "text", text: "Second edited turn" }],
        })
      return Response.json({
        sessionId: "stored",
        messages,
        total: messages.length,
        limit: 200,
        offset: 0,
        nextOffset: messages.length,
      })
    })
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership("stored", "researcher")
    const firstReplacement = {
      localMessageId: "local-edit-1",
      text: "First edited turn",
    }
    await client.resolveRewindSourceId(
      "stored",
      "hermes-row-3",
      firstReplacement
    )
    await client.reconcileRewindReplacement("stored", firstReplacement)
    const secondReplacement = {
      localMessageId: "local-edit-2",
      text: "Second edited turn",
    }
    await client.resolveRewindSourceId(
      "stored",
      "hermes-row-10",
      secondReplacement
    )
    await client.reconcileRewindReplacement("stored", secondReplacement)

    await expect(
      client.resolveRewindSourceId("stored", "local-edit-1", {
        localMessageId: "local-edit-3",
        text: "First turn edited again",
      })
    ).resolves.toBe("hermes-row-8")
  })
})
