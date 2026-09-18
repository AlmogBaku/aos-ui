import type { RunAgentInput } from "@ag-ui/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
} from "./aos-reconnect"

const THREAD_ID = "hermes:researcher:stored"
const RECONNECT_URL =
  "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/reconnect"

type SseEvent = Record<string, unknown>

function frame(event: SseEvent) {
  return `data: ${JSON.stringify(event)}`
}

function sse(lines: readonly string[]) {
  return new Response(lines.concat("").join("\n\n"), {
    headers: { "content-type": "text/event-stream" },
  })
}

const started = frame({
  type: "RUN_STARTED",
  threadId: THREAD_ID,
  runId: "run-1",
})
const finished = frame({
  type: "RUN_FINISHED",
  threadId: THREAD_ID,
  runId: "run-1",
  outcome: { type: "success" },
})
const answer = [
  frame({
    type: "TEXT_MESSAGE_START",
    messageId: "assistant-1",
    role: "assistant",
  }),
  frame({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "assistant-1",
    delta: "Recovered",
  }),
  frame({ type: "TEXT_MESSAGE_END", messageId: "assistant-1" }),
]

function unsettled(code = "AOS_CONNECTION_INTERRUPTED") {
  return frame({ type: "RUN_ERROR", code, message: "Reconnect" })
}

const resetRequired = frame({
  type: "RUN_ERROR",
  code: "AOS_RESET_REQUIRED",
  message: "This run could not be resumed from where it stopped.",
})

const runInput: RunAgentInput = {
  threadId: THREAD_ID,
  runId: "run-1",
  state: {},
  messages: [{ id: "message-1", role: "user", content: "Hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
}

function collect(
  agent: ReturnType<typeof createAosRunAgent>,
  input: RunAgentInput
) {
  return new Promise<SseEvent[]>((resolve, reject) => {
    const events: SseEvent[] = []
    agent.run(input).subscribe({
      next: (event) => events.push(event as unknown as SseEvent),
      error: reject,
      complete: () => resolve(events),
    })
  })
}

async function settleMicrotasks() {
  for (let index = 0; index < 100; index += 1) await Promise.resolve()
}

/**
 * Drives the stream on the fake clock alone: every step drains the queues the
 * response bodies settle on and fires the timers already due, so no assertion
 * depends on how quickly the host happens to schedule them.
 */
async function advanceUntil(ready: () => boolean, description: string) {
  for (let index = 0; index < 200; index += 1) {
    if (ready()) return
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error(`The fake clock never reached ${description}`)
}

function bodyOf(call: Parameters<typeof fetch> | undefined) {
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>
}

function types(events: readonly SseEvent[]) {
  return events.map((event) => event.type)
}

afterEach(() => {
  vi.useRealTimers()
})

describe("AOS run stream reconnect policy", () => {
  it("recovers the run when a redial is rejected before a later attempt succeeds", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(sse([started, ...answer, finished]))
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS)
    const events = await pending

    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(bodyOf(fetcher.mock.calls[2])).toEqual({
      threadId: THREAD_ID,
      runId: "run-1",
      after: 41,
    })
  })

  it("recovers the run when a redial answers 503 before a later attempt succeeds", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              description: "The provider is unavailable",
            },
          },
          { status: 503 }
        )
      )
      .mockResolvedValueOnce(sse([started, ...answer, finished]))
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS)
    const events = await pending

    expect(types(events)).toContain("RUN_FINISHED")
    expect(types(events)).not.toContain("RUN_ERROR")
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it("backs off and keeps the segment cursor when a redial delivers an empty stream", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
      .mockResolvedValueOnce(
        new Response("", { headers: { "content-type": "text/event-stream" } })
      )
      .mockResolvedValueOnce(sse([started, ...answer, finished]))
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    await settleMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await settleMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS)
    expect(fetcher).toHaveBeenCalledTimes(3)
    const events = await pending

    expect(types(events)).toContain("RUN_FINISHED")
    // Nothing was delivered, so the cursor still describes what this browser
    // rendered: replaying the whole segment would duplicate it.
    expect(bodyOf(fetcher.mock.calls[1])).toEqual({
      threadId: THREAD_ID,
      runId: "run-1",
      after: 41,
    })
    expect(bodyOf(fetcher.mock.calls[2])).toEqual({
      threadId: THREAD_ID,
      runId: "run-1",
      after: 41,
    })
  })

  it("restarts from cursor 0 when a redial delivers a lower sequence id than it sent", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
      .mockResolvedValueOnce(sse(["id: 5", unsettled()]))
      .mockResolvedValueOnce(sse([started, ...answer, finished]))
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS)
    const events = await pending

    expect(types(events)).toContain("RUN_FINISHED")
    expect(bodyOf(fetcher.mock.calls[2])).toEqual({
      threadId: THREAD_ID,
      runId: "run-1",
      after: 0,
    })
  })

  it("returns silently when the caller aborts during a reconnect backoff", async () => {
    vi.useFakeTimers()
    // A fixed jitter draw keeps the second redial parked in a backoff window
    // the clock below never reaches, so the abort always lands inside it.
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
      .mockResolvedValue(
        new Response("", { headers: { "content-type": "text/event-stream" } })
      )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    let complete = false
    const settled = pending.finally(() => {
      complete = true
    })
    await advanceUntil(
      () => fetcher.mock.calls.length === 2 && vi.getTimerCount() > 0,
      "a redial waiting out its backoff"
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    agent.abortRun()
    await advanceUntil(() => complete, "the aborted run stream ending")
    const events = await settled

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(
      events.filter(
        (event) =>
          event.type === "RUN_ERROR" &&
          String(event.code ?? "").startsWith("AOS_")
      )
    ).toEqual([])
  })

  it("yields exactly one exhausted run error when every redial fails", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
    fetcher.mockRejectedValue(new TypeError("Failed to fetch"))
    const onEvent = vi.fn()
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
      onEvent,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 20)
    const events = await pending

    expect(fetcher).toHaveBeenCalledTimes(1 + RECONNECT_MAX_ATTEMPTS)
    const errors = events.filter((event) => event.type === "RUN_ERROR")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      type: "RUN_ERROR",
      code: "AOS_RECONNECT_EXHAUSTED",
    })
    expect(onEvent).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ code: "AOS_RECONNECT_EXHAUSTED" })
    )
  })

  it("paces and bounds redials when every reconnect only repeats the interrupt", async () => {
    vi.useFakeTimers()
    // Every reply carries the same interrupt, so no attempt makes progress.
    const fetcher = vi.fn<typeof fetch>(async () =>
      sse(["id: 41", started, unsettled()])
    )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    await settleMicrotasks()
    // The first stream carried run content, so its redial is immediate; a
    // reconnect that only repeats the interrupt made no progress and waits.
    expect(fetcher).toHaveBeenCalledTimes(2)
    await settleMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 20)
    const events = await pending

    expect(fetcher).toHaveBeenCalledTimes(1 + RECONNECT_MAX_ATTEMPTS)
    expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([
      expect.objectContaining({ code: "AOS_RECONNECT_EXHAUSTED" }),
    ])
  })

  it("reports an unresumable run conflict as one exhausted run error without retrying", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, unsettled()]))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "run_conflict",
              description: "The active run changed.",
            },
          },
          { status: 409 }
        )
      )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 20)
    const events = await pending

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([
      expect.objectContaining({ code: "AOS_RECONNECT_EXHAUSTED" }),
    ])
  })

  it.each(["AOS_SEND_UNCERTAIN", "AOS_INTERACTION_UNCERTAIN"])(
    "redials an uncertain run (%s) instead of failing the message",
    async (code) => {
      vi.useFakeTimers()
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(sse(["id: 7", started, unsettled(code)]))
        .mockResolvedValueOnce(sse([started, ...answer, finished]))
      const agent = createAosRunAgent({
        agentId: "researcher",
        threadId: THREAD_ID,
        fetcher,
      })

      const pending = collect(agent, runInput)
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS)
      const events = await pending

      expect(types(events)).not.toContain("RUN_ERROR")
      expect(types(events)).toContain("RUN_FINISHED")
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(String(fetcher.mock.calls[1]?.[0])).toBe(RECONNECT_URL)
    }
  )

  it("localizes a surfaced run error by code and keeps proxy text for an unknown code", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sse([
          started,
          frame({
            type: "RUN_ERROR",
            code: "AOS_PROVIDER_RUN_FAILED",
            message: "Hermes could not complete this run.",
          }),
        ])
      )
      .mockResolvedValueOnce(
        sse([
          started,
          frame({
            type: "RUN_ERROR",
            code: "AOS_UNKNOWN_TO_THIS_BUILD",
            message: "Proxy described this failure.",
          }),
        ])
      )
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
      resolveRunError: (code, fallback) =>
        code === "AOS_PROVIDER_RUN_FAILED"
          ? "לא ניתן להשלים את ההרצה."
          : fallback,
    })

    const failed = await collect(agent, runInput)
    const unknown = await collect(agent, runInput)

    expect(failed.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "AOS_PROVIDER_RUN_FAILED",
      message: "לא ניתן להשלים את ההרצה.",
    })
    expect(unknown.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "Proxy described this failure.",
    })
  })

  it("reloads the Session once and redials from cursor 0 when a live run resets", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, resetRequired]))
      .mockResolvedValueOnce(sse([started, ...answer, finished]))
    const reloadHistory = vi.fn(async () => ({
      execution: { status: "running" },
    }))
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
      reloadHistory,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS)
    const events = await pending

    expect(reloadHistory).toHaveBeenCalledTimes(1)
    expect(types(events)).not.toContain("RUN_ERROR")
    expect(types(events)).toContain("RUN_FINISHED")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(RECONNECT_URL)
    // The journal can no longer serve the cursor this stream holds, so the
    // replacement segment is read from its beginning.
    expect(bodyOf(fetcher.mock.calls[1])).toEqual({
      threadId: THREAD_ID,
      runId: "run-1",
      after: 0,
    })
  })

  it("surfaces one localized reset when the reload no longer reports a running run", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, resetRequired]))
    const reloadHistory = vi.fn(async () => ({
      execution: { status: "failed" },
    }))
    const onEvent = vi.fn()
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
      reloadHistory,
      onEvent,
      resolveRunError: (code, fallback) =>
        code === "AOS_RESET_REQUIRED"
          ? "לא ניתן להמשיך את ההרצה מהמקום שבו נעצרה."
          : fallback,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS)
    const events = await pending

    expect(reloadHistory).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([
      expect.objectContaining({
        code: "AOS_RESET_REQUIRED",
        message: "לא ניתן להמשיך את ההרצה מהמקום שבו נעצרה.",
      }),
    ])
    expect(onEvent).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ code: "AOS_RESET_REQUIRED" })
    )
  })

  it("stops on a second reset instead of reloading the Session again", async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(["id: 41", started, resetRequired]))
      .mockResolvedValueOnce(sse([resetRequired]))
    const reloadHistory = vi.fn(async () => ({
      execution: { status: "running" },
    }))
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: THREAD_ID,
      fetcher,
      reloadHistory,
    })

    const pending = collect(agent, runInput)
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 20)
    const events = await pending

    expect(reloadHistory).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([
      expect.objectContaining({ code: "AOS_RESET_REQUIRED" }),
    ])
  })

  it("observes the first turn of a draft Session through the resolved thread id", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path === "/api/aos/v1/agents/researcher/sessions")
        return Response.json(
          { session: { id: "remote-session", agentId: "researcher" } },
          { status: 201 }
        )
      if (
        path ===
        "/api/aos/v1/agents/researcher/sessions/remote-session/runs/steer"
      )
        return Response.json({ status: "steered" })
      if (path === "/api/aos/v1/agents/researcher/sessions/remote-session/runs")
        return sse([
          frame({
            type: "RUN_STARTED",
            threadId: "remote-session",
            runId: "run-1",
          }),
          ...answer,
          frame({
            type: "RUN_FINISHED",
            threadId: "remote-session",
            runId: "run-1",
            outcome: { type: "success" },
          }),
        ])
      throw new Error(`Unexpected request: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher })
    const { threadId: remoteId } = await client.createSession("researcher")
    const statuses: string[] = []
    const steers: Promise<unknown>[] = []
    const agent = createAosRunAgent({
      agentId: "researcher",
      threadId: "",
      resolveThreadId: () => remoteId,
      fetcher,
      onEvent: (threadId, event) => {
        client.acceptRunEvent(threadId, event)
        statuses.push(`${event.type}:${client.sessionStatus(threadId)}`)
        if (event.type === "RUN_STARTED")
          steers.push(
            client.steerRun(threadId, {
              requestId: "queue-item-1",
              text: "Focus on the second option",
            })
          )
      },
    })

    await collect(agent, { ...runInput, threadId: "" })
    await Promise.all(steers)

    expect(statuses).toEqual(["RUN_STARTED:running", "RUN_FINISHED:idle"])
    expect(client.sessionStatus("remote-session")).toBe("idle")
    expect(
      bodyOf(
        fetcher.mock.calls.find(([input]) =>
          String(input).endsWith("/runs/steer")
        )
      )
    ).toEqual({
      requestId: "queue-item-1",
      expectedRunId: "run-1",
      text: "Focus on the second option",
    })
  })
})
