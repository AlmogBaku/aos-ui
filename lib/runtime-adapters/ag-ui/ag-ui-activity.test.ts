import type {
  AssistantRuntime,
  MessageStatus,
  ThreadMessage,
  ThreadState,
} from "@assistant-ui/react"
import { describe, expect, it, vi } from "vitest"

import type { WorkspaceActivityEvent } from "../contracts"
import { ActivityStore } from "../../notifications/store"
import { createAgUiActivityPublisher } from "./ag-ui-activity"

type ActivityState = {
  isRunning: boolean
  messages: readonly {
    id?: string
    role: ThreadMessage["role"]
    status: MessageStatus
  }[]
}

function createRuntime(initialState: ActivityState) {
  let state = initialState
  const listeners = new Set<() => void>()
  const thread = {
    getState: () => state as unknown as ThreadState,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return {
    runtime: { thread } as unknown as AssistantRuntime,
    listenerCount: () => listeners.size,
    update(next: ActivityState) {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const idle: ActivityState = { isRunning: false, messages: [] }
const running: ActivityState = { isRunning: true, messages: [] }

describe("AG-UI active Session activity publisher", () => {
  it("pairs one observed start with one successful terminal under the active owner", () => {
    const source = createRuntime(idle)
    const owner = { agentId: "research", threadId: "thread-research" }
    const timestamps = [
      new Date("2026-09-05T08:00:00.000Z"),
      new Date("2026-09-05T08:01:00.000Z"),
    ]
    const publisher = createAgUiActivityPublisher({
      clock: () => timestamps.shift()!,
      activityIdFactory: () => "1",
    })
    const received: WorkspaceActivityEvent[] = []
    publisher.attach(source.runtime, owner)
    const stop = publisher.subscribe((event) => received.push(event))

    source.update(running)
    source.update(running)
    source.update({
      isRunning: false,
      messages: [
        {
          role: "assistant",
          status: { type: "complete", reason: "stop" },
        },
      ],
    })
    source.update(idle)

    expect(received).toEqual([
      {
        id: "ag-ui:run:thread-research:1:started",
        agentId: "research",
        threadId: "thread-research",
        occurredAt: "2026-09-05T08:00:00.000Z",
        type: "run-started",
        lifecycleId: "ag-ui:run:thread-research:1",
      },
      {
        id: "ag-ui:run:thread-research:1:finished",
        agentId: "research",
        threadId: "thread-research",
        occurredAt: "2026-09-05T08:01:00.000Z",
        type: "run-finished",
        lifecycleId: "ag-ui:run:thread-research:1",
      },
    ])
    stop()
  })

  it("prefers the active assistant message ID for lifecycle identity", () => {
    const source = createRuntime(idle)
    const publisher = createAgUiActivityPublisher({
      activityIdFactory: () => "unused-fallback",
    })
    const received: WorkspaceActivityEvent[] = []
    publisher.attach(source.runtime, {
      agentId: "research",
      threadId: "thread-research",
    })
    publisher.subscribe((event) => received.push(event))

    source.update({
      isRunning: true,
      messages: [
        {
          id: "provider-message-7",
          role: "assistant",
          status: { type: "running" },
        },
      ],
    })

    expect(received[0]).toMatchObject({
      lifecycleId: "ag-ui:run:thread-research:provider-message-7",
    })
  })

  it("publishes failure only for the runtime's explicit terminal error status", () => {
    const source = createRuntime(idle)
    const publisher = createAgUiActivityPublisher({
      clock: () => new Date("2026-09-05T09:00:00.000Z"),
      activityIdFactory: () => "1",
    })
    const received: WorkspaceActivityEvent[] = []
    publisher.attach(source.runtime, {
      agentId: "writer",
      threadId: "thread-writer",
    })
    publisher.subscribe((event) => received.push(event))

    source.update(running)
    source.update({
      isRunning: false,
      messages: [
        {
          role: "assistant",
          status: { type: "incomplete", reason: "error" },
        },
      ],
    })

    expect(received.map(({ type }) => type)).toEqual([
      "run-started",
      "run-failed",
    ])
    expect(received[1]).toMatchObject({
      id: "ag-ui:run:thread-writer:1:failed",
      agentId: "writer",
      threadId: "thread-writer",
      lifecycleId: "ag-ui:run:thread-writer:1",
    })
  })

  it.each([
    { type: "incomplete", reason: "cancelled" } as const,
    { type: "requires-action", reason: "interrupt" } as const,
    { type: "incomplete", reason: "other" } as const,
  ])("does not invent a terminal event for $reason", (status) => {
    const source = createRuntime(idle)
    const publisher = createAgUiActivityPublisher()
    const received: WorkspaceActivityEvent[] = []
    publisher.attach(source.runtime, {
      agentId: "research",
      threadId: "thread-research",
    })
    publisher.subscribe((event) => received.push(event))

    source.update(running)
    source.update({
      isRunning: false,
      messages: [{ role: "assistant", status }],
    })

    expect(received.map(({ type }) => type)).toEqual(["run-started"])
  })

  it("observes only the active Session and drops an in-flight lifecycle on retarget", () => {
    const source = createRuntime(idle)
    const owner = { agentId: "research", threadId: "thread-research" }
    const publisher = createAgUiActivityPublisher()
    const received: WorkspaceActivityEvent[] = []
    publisher.attach(source.runtime, owner)
    publisher.subscribe((event) => received.push(event))

    source.update(running)
    owner.agentId = "writer"
    owner.threadId = "thread-writer"
    publisher.attach(source.runtime, owner)
    source.update(idle)
    source.update(running)
    source.update({
      isRunning: false,
      messages: [
        {
          role: "assistant",
          status: { type: "complete", reason: "stop" },
        },
      ],
    })

    expect(
      received.map(({ agentId, threadId, type }) => ({
        agentId,
        threadId,
        type,
      }))
    ).toEqual([
      {
        agentId: "research",
        threadId: "thread-research",
        type: "run-started",
      },
      { agentId: "writer", threadId: "thread-writer", type: "run-started" },
      {
        agentId: "writer",
        threadId: "thread-writer",
        type: "run-finished",
      },
    ])
  })

  it("unsubscribes the inactive Session source and ignores its delayed terminal", () => {
    const research = createRuntime(idle)
    const writer = createRuntime(idle)
    const owner = { agentId: "research", threadId: "thread-research" }
    const publisher = createAgUiActivityPublisher()
    const received: WorkspaceActivityEvent[] = []
    publisher.attach(research.runtime, owner)
    publisher.subscribe((event) => received.push(event))

    research.update(running)
    owner.agentId = "writer"
    owner.threadId = "thread-writer"
    publisher.attach(writer.runtime, owner)

    expect(research.listenerCount()).toBe(0)
    expect(writer.listenerCount()).toBe(1)
    research.update(running)
    research.update({
      isRunning: false,
      messages: [
        {
          role: "assistant",
          status: { type: "complete", reason: "stop" },
        },
      ],
    })
    writer.update(running)
    writer.update({
      isRunning: false,
      messages: [
        {
          role: "assistant",
          status: { type: "complete", reason: "stop" },
        },
      ],
    })

    expect(
      received.map(({ agentId, threadId, type }) => ({
        agentId,
        threadId,
        type,
      }))
    ).toEqual([
      {
        agentId: "research",
        threadId: "thread-research",
        type: "run-started",
      },
      { agentId: "writer", threadId: "thread-writer", type: "run-started" },
      {
        agentId: "writer",
        threadId: "thread-writer",
        type: "run-finished",
      },
    ])
  })

  it("does not synthesize a start from an already-running snapshot", () => {
    const source = createRuntime(running)
    const publisher = createAgUiActivityPublisher()
    const received = vi.fn()
    publisher.attach(source.runtime, {
      agentId: "research",
      threadId: "thread-research",
    })
    publisher.subscribe(received)

    source.update({
      isRunning: false,
      messages: [
        {
          role: "assistant",
          status: { type: "complete", reason: "stop" },
        },
      ],
    })

    expect(received).not.toHaveBeenCalled()
  })

  it("isolates listener failures and releases the runtime subscription", () => {
    const source = createRuntime(idle)
    const publisher = createAgUiActivityPublisher()
    const observed = vi.fn()
    const observedError = vi.fn()
    publisher.attach(source.runtime, {
      agentId: "research",
      threadId: "thread-research",
    })
    const stopThrowing = publisher.subscribe(() => {
      throw new Error("listener failed")
    }, observedError)
    const stopObserved = publisher.subscribe(observed)

    expect(source.listenerCount()).toBe(1)
    source.update(running)
    expect(observedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener failed" })
    )
    expect(observed).toHaveBeenCalledTimes(1)

    stopThrowing()
    stopObserved()
    expect(source.listenerCount()).toBe(0)
    source.update(idle)
    expect(observed).toHaveBeenCalledTimes(1)
  })

  it("detaches the old runtime during source reconfiguration", () => {
    const first = createRuntime(idle)
    const second = createRuntime(idle)
    const publisher = createAgUiActivityPublisher()
    const received = vi.fn()
    publisher.attach(first.runtime, {
      agentId: "research",
      threadId: "thread-research",
    })
    publisher.subscribe(received)
    expect(first.listenerCount()).toBe(1)

    publisher.attach(second.runtime, {
      agentId: "writer",
      threadId: "thread-writer",
    })
    expect(first.listenerCount()).toBe(0)
    expect(second.listenerCount()).toBe(1)
    first.update(running)
    expect(received).not.toHaveBeenCalled()

    publisher.detach()
    expect(second.listenerCount()).toBe(0)
  })

  it("publishes a new lifecycle after publisher recreation and store hydration", () => {
    const owner = { agentId: "research", threadId: "thread-research" }
    const context = {
      selection: null,
      pageVisible: false,
      pageFocused: false,
    }
    const createStore = () =>
      new ActivityStore({
        now: () => new Date("2026-09-05T09:00:00.000Z").getTime(),
        getThreadOwner: (threadId) =>
          threadId === owner.threadId ? owner.agentId : undefined,
      })
    const run = (store: ActivityStore, activityIdFactory: () => string) => {
      const source = createRuntime(idle)
      const publisher = createAgUiActivityPublisher({ activityIdFactory })
      publisher.attach(source.runtime, owner)
      publisher.subscribe((event) => store.ingest(event, context))
      source.update(running)
      source.update({
        isRunning: false,
        messages: [
          {
            role: "assistant",
            status: { type: "complete", reason: "stop" },
          },
        ],
      })
    }

    const first = createStore()
    run(first, () => "fallback-run-one")
    const recreated = createStore()
    recreated.hydrate(first.records())
    run(recreated, () => "fallback-run-two")

    expect(
      recreated
        .records()
        .flatMap((record) =>
          record.type === "run-finished" ? [record.lifecycleId] : []
        )
        .sort()
    ).toEqual([
      "ag-ui:run:thread-research:fallback-run-one",
      "ag-ui:run:thread-research:fallback-run-two",
    ])
  })
})
