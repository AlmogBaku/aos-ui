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
