import type { RunAgentInput } from "@ag-ui/client"
import { describe, expect, it, vi } from "vitest"

import { createAosRunAgent } from "./aos-client"

type AosRunInput = RunAgentInput & {
  messages: Array<
    RunAgentInput["messages"][number] & {
      attachments?: unknown
    }
  >
}

function collect(
  agent: ReturnType<typeof createAosRunAgent>,
  input: AosRunInput
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
  it.each(["/help  topic  ", "/unknown", " /help", "/HELP"])(
    "preserves %j for runtime-owned command recognition through the normal run transport",
    async (text) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            [
              `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "session", runId: "run" })}`,
              `data: ${JSON.stringify({ type: "RUN_ERROR", message: "Native command failed", code: "COMMAND_FAILED" })}`,
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } }
          )
      )
      const agent = createAosRunAgent({
        agentId: "agent",
        threadId: "session",
        fetcher,
        authorization: "Bearer invitation",
      })
      await collect(agent, {
        threadId: "session",
        runId: "run",
        state: {},
        messages: [{ id: "message", role: "user", content: text }],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        "/api/aos/v1/agents/agent/sessions/session/runs"
      )
      expect(
        JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages
      ).toEqual([{ id: "message", role: "user", content: text }])
      expect(
        new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")
      ).toBe("Bearer invitation")
    }
  )
  it("reconnects an interrupted run without resending the user prompt", async () => {
    const threadId = "hermes:researcher:stored"
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          [
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
    })
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

  it("stages browser attachments and forwards only the opaque stage id to the normalized run", async () => {
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

    await collect(agent, {
      threadId: "opaque-session-1",
      runId: "run-1",
      state: {},
      messages: [
        {
          id: "new-user",
          role: "user",
          content: "Please read this",
          attachments: [
            {
              id: "draft",
              type: "file",
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
        },
      ],
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
})
