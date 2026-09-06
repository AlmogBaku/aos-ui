import type { AbstractAgent } from "@ag-ui/client"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceActivityEvent } from "../contracts"
import { ActivityStore } from "../../notifications/store"
import type { AgUiWorkspaceTransport } from "./ag-ui-workspace"
import { useAgUiRuntimeBundle } from "./use-ag-ui-runtime-bundle"

afterEach(cleanup)

function createHarness() {
  const loadSession = vi.fn(async (threadId: string) => ({
    messages: [
      {
        id: `message-${threadId}`,
        role: "assistant",
        content: `History for ${threadId}`,
      },
    ],
    state: { hydratedThreadId: threadId },
  }))
  const sessions = [
    {
      threadId: "thread-research",
      agentId: "research",
      title: "Research brief",
      updatedAt: "2026-09-04T09:00:00.000Z",
      status: "idle" as const,
    },
    {
      threadId: "thread-writer",
      agentId: "writer",
      title: "Launch copy",
      updatedAt: "2026-09-04T08:00:00.000Z",
      status: "idle" as const,
    },
  ]
  const transport: AgUiWorkspaceTransport = {
    listAgents: async () => [
      { kind: "ready", id: "research", name: "Research" },
      { kind: "ready", id: "writer", name: "Writer" },
    ],
    listSessions: async () => sessions,
    loadSession,
    createSession: async (agentId) => {
      const created = {
        threadId: `thread-created-${agentId}`,
        agentId,
        title: "Fresh session",
        updatedAt: "2026-09-04T10:00:00.000Z",
        status: "idle" as const,
      }
      return created
    },
  }
  const agent = {
    runAgent: vi.fn(),
    abortRun: vi.fn(),
    threadId: "",
    agentId: undefined,
  } as unknown as AbstractAgent

  return { agent, loadSession, transport }
}

function controlledAgent() {
  const releases: Array<() => void> = []
  const runAgent = vi.fn(
    async (_input: unknown, subscriber: { onRunFinalized?: () => void }) => {
      await new Promise<void>((resolve) => {
        releases.push(() => {
          subscriber.onRunFinalized?.()
          resolve()
        })
      })
    }
  )
  return {
    agent: {
      runAgent,
      abortRun: vi.fn(),
      threadId: "",
      agentId: undefined,
    } as unknown as AbstractAgent,
    release: () => {
      const release = releases.shift()
      if (!release) throw new Error("No controlled AG-UI run is pending")
      release()
    },
    runAgent,
  }
}

function messageText(
  agent: AbstractAgent,
  runtime: ReturnType<typeof useAgUiRuntimeBundle>["assistantRuntime"]
) {
  return {
    agentId: agent.agentId,
    threadId: agent.threadId,
    messages: runtime.thread
      .getState()
      .messages.flatMap((message) =>
        message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      ),
  }
}

describe("AG-UI runtime bundle integration", () => {
  it("parks queued follow-ups after cancel without an automatic second run", async () => {
    const harness = createHarness()
    const controlled = controlledAgent()
    const hook = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: controlled.agent,
        workspaceTransport: harness.transport,
      })
    )

    await waitFor(() =>
      expect(controlled.agent.threadId).toBe("thread-research")
    )

    act(() => {
      hook.result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "First request" }],
      })
    })
    await waitFor(() => expect(controlled.runAgent).toHaveBeenCalledOnce())

    act(() => {
      hook.result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Park this follow-up" }],
      })
    })
    await waitFor(() =>
      expect(
        hook.result.current.assistantRuntime.thread.composer.getState().queue
      ).toHaveLength(1)
    )

    act(() => {
      hook.result.current.assistantRuntime.thread.cancelRun()
    })
    await waitFor(() =>
      expect(controlled.agent.abortRun).toHaveBeenCalledOnce()
    )
    await act(async () => controlled.release())
    await waitFor(() =>
      expect(
        hook.result.current.assistantRuntime.thread.getState().isRunning
      ).toBe(false)
    )
    expect(
      hook.result.current.assistantRuntime.thread.composer.getState().queue
    ).toHaveLength(1)
    expect(controlled.runAgent).toHaveBeenCalledOnce()

    hook.unmount()
  })

  it("publishes a fresh provider lifecycle after bundle recreation and hydration", async () => {
    const harness = createHarness()
    const owner = (threadId: string) =>
      threadId === "thread-research" ? "research" : undefined
    const context = {
      selection: null,
      pageVisible: false,
      pageFocused: false,
    }
    const firstStore = new ActivityStore({
      now: () => Date.now(),
      getThreadOwner: owner,
    })
    const firstAgent = controlledAgent()
    const first = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: firstAgent.agent,
        workspaceTransport: harness.transport,
      })
    )
    await waitFor(() =>
      expect(firstAgent.agent.threadId).toBe("thread-research")
    )
    first.result.current.workspace.subscribeActivity?.((event) =>
      firstStore.ingest(event, context)
    )
    act(() => {
      first.result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "First private request" }],
      })
    })
    await waitFor(() => expect(firstAgent.runAgent).toHaveBeenCalledOnce())
    await act(async () => firstAgent.release())
    await waitFor(() => expect(firstStore.records()).toHaveLength(1))
    first.unmount()

    const recreatedStore = new ActivityStore({
      now: () => Date.now(),
      getThreadOwner: owner,
    })
    recreatedStore.hydrate(firstStore.records())
    const secondAgent = controlledAgent()
    const second = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: secondAgent.agent,
        workspaceTransport: harness.transport,
      })
    )
    await waitFor(() =>
      expect(secondAgent.agent.threadId).toBe("thread-research")
    )
    second.result.current.workspace.subscribeActivity?.((event) =>
      recreatedStore.ingest(event, context)
    )
    act(() => {
      second.result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Second private request" }],
      })
    })
    await waitFor(() => expect(secondAgent.runAgent).toHaveBeenCalledOnce())
    await act(async () => secondAgent.release())
    await waitFor(() => expect(recreatedStore.records()).toHaveLength(2))

    const lifecycles = recreatedStore
      .records()
      .flatMap((record) =>
        record.type === "run-finished" ? [record.lifecycleId] : []
      )
    expect(new Set(lifecycles).size).toBe(2)
    expect(JSON.stringify(recreatedStore.records())).not.toContain(
      "private request"
    )
  })

  it("publishes the real active runtime lifecycle with host-owned Agent and Session IDs", async () => {
    const harness = createHarness()
    const controlled = controlledAgent()
    const activity: WorkspaceActivityEvent[] = []
    const timestamps = [
      new Date("2026-09-05T10:00:00.000Z"),
      new Date("2026-09-05T10:01:00.000Z"),
    ]
    const activityClock = () => timestamps.shift()!
    const activityIdFactory = () => "1"
    const { result } = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: controlled.agent,
        workspaceTransport: harness.transport,
        activityClock,
        activityIdFactory,
      })
    )

    await waitFor(() =>
      expect(controlled.agent.threadId).toBe("thread-research")
    )
    const stop = result.current.workspace.subscribeActivity?.((event) =>
      activity.push(event)
    )

    act(() => {
      result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Run the active Session" }],
      })
    })
    await waitFor(() => expect(controlled.runAgent).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(result.current.assistantRuntime.thread.getState().isRunning).toBe(
        true
      )
    )
    await waitFor(() =>
      expect(activity.map(({ type }) => type)).toEqual(["run-started"])
    )

    await act(async () => controlled.release())
    await waitFor(() =>
      expect(activity.map(({ type }) => type)).toEqual([
        "run-started",
        "run-finished",
      ])
    )
    const lifecycleId =
      activity[0]?.type === "run-started" ? activity[0].lifecycleId : undefined
    expect(lifecycleId).toMatch(/^ag-ui:run:thread-research:/u)
    expect(activity).toEqual([
      expect.objectContaining({
        agentId: "research",
        threadId: "thread-research",
        occurredAt: "2026-09-05T10:00:00.000Z",
        type: "run-started",
        lifecycleId,
      }),
      expect.objectContaining({
        agentId: "research",
        threadId: "thread-research",
        occurredAt: "2026-09-05T10:01:00.000Z",
        type: "run-finished",
        lifecycleId,
      }),
    ])
    stop?.()
  })

  it("stops observing an in-flight runtime when the bundle unmounts", async () => {
    const harness = createHarness()
    const controlled = controlledAgent()
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const hook = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: controlled.agent,
        workspaceTransport: harness.transport,
      })
    )

    await waitFor(() =>
      expect(controlled.agent.threadId).toBe("thread-research")
    )
    hook.result.current.workspace.subscribeActivity?.(activity)
    act(() => {
      hook.result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Run then unmount" }],
      })
    })
    await waitFor(() => expect(activity).toHaveBeenCalledTimes(1))

    hook.unmount()
    await act(async () => controlled.release())
    expect(activity).toHaveBeenCalledTimes(1)
  })

  it("retargets activity to the newly active Session without leaking private content", async () => {
    const harness = createHarness()
    const controlled = controlledAgent()
    const activity: WorkspaceActivityEvent[] = []
    const timestamps = [
      new Date("2026-09-05T11:00:00.000Z"),
      new Date("2026-09-05T11:01:00.000Z"),
      new Date("2026-09-05T11:02:00.000Z"),
      new Date("2026-09-05T11:03:00.000Z"),
    ]
    const activityClock = () => timestamps.shift()!
    let activitySequence = 0
    const activityIdFactory = () => String(++activitySequence)
    const { result } = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: controlled.agent,
        workspaceTransport: harness.transport,
        activityClock,
        activityIdFactory,
      })
    )

    await waitFor(() =>
      expect(controlled.agent.threadId).toBe("thread-research")
    )
    result.current.workspace.subscribeActivity?.((event) =>
      activity.push(event)
    )
    act(() => {
      result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Private research request" }],
      })
    })
    await waitFor(() => expect(activity).toHaveLength(1))
    await act(async () => controlled.release())
    await waitFor(() => expect(activity).toHaveLength(2))

    await act(async () => {
      await result.current.assistantRuntime.threads.switchToThread(
        "thread-writer"
      )
    })
    act(() => {
      result.current.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Private writing request" }],
      })
    })
    await waitFor(() => expect(activity).toHaveLength(3))
    await act(async () => controlled.release())
    await waitFor(() => expect(activity).toHaveLength(4))

    const summaries = activity.map((event) => ({
      agentId: event.agentId,
      threadId: event.threadId,
      type: event.type,
      lifecycleId: "lifecycleId" in event ? event.lifecycleId : undefined,
    }))
    const researchLifecycle = summaries[0]?.lifecycleId
    const writerLifecycle = summaries[2]?.lifecycleId
    expect(researchLifecycle).toMatch(/^ag-ui:run:thread-research:/u)
    expect(writerLifecycle).toMatch(/^ag-ui:run:thread-writer:/u)
    expect(writerLifecycle).not.toBe(researchLifecycle)
    expect(summaries).toEqual([
      {
        agentId: "research",
        threadId: "thread-research",
        type: "run-started",
        lifecycleId: researchLifecycle,
      },
      {
        agentId: "research",
        threadId: "thread-research",
        type: "run-finished",
        lifecycleId: researchLifecycle,
      },
      {
        agentId: "writer",
        threadId: "thread-writer",
        type: "run-started",
        lifecycleId: writerLifecycle,
      },
      {
        agentId: "writer",
        threadId: "thread-writer",
        type: "run-finished",
        lifecycleId: writerLifecycle,
      },
    ])
    expect(JSON.stringify(activity)).not.toContain("Private")
  })

  it("populates host Sessions and hydrates the newest Session history", async () => {
    const harness = createHarness()
    const { result } = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: harness.agent,
        workspaceTransport: harness.transport,
      })
    )

    await waitFor(() =>
      expect(
        result.current.assistantRuntime.threads.getState().threadIds
      ).toEqual(["thread-research", "thread-writer"])
    )
    expect(
      result.current.assistantRuntime.threads.getState().threadItems[
        "thread-research"
      ]?.title
    ).toBe("Research brief")
    await waitFor(() =>
      expect(
        messageText(harness.agent, result.current.assistantRuntime)
      ).toEqual({
        agentId: "research",
        threadId: "thread-research",
        messages: ["History for thread-research"],
      })
    )
  })

  it("hydrates history and retargets the official Agent when switching Agents", async () => {
    const harness = createHarness()
    const { result } = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: harness.agent,
        workspaceTransport: harness.transport,
      })
    )

    await waitFor(() =>
      expect(
        result.current.assistantRuntime.threads.getState().threadIds
      ).toHaveLength(2)
    )
    await act(async () => {
      await result.current.assistantRuntime.threads.switchToThread(
        "thread-writer"
      )
    })

    expect(messageText(harness.agent, result.current.assistantRuntime)).toEqual(
      {
        agentId: "writer",
        threadId: "thread-writer",
        messages: ["History for thread-writer"],
      }
    )
    expect(harness.loadSession).toHaveBeenCalledWith("thread-writer")

    await act(async () => {
      await result.current.assistantRuntime.threads.switchToThread(
        "thread-research"
      )
    })
    expect(messageText(harness.agent, result.current.assistantRuntime)).toEqual(
      {
        agentId: "research",
        threadId: "thread-research",
        messages: ["History for thread-research"],
      }
    )
  })

  it("adds a provider-created Session before selecting and hydrating it", async () => {
    const harness = createHarness()
    const { result } = renderHook(() =>
      useAgUiRuntimeBundle({
        agent: harness.agent,
        workspaceTransport: harness.transport,
      })
    )

    await waitFor(() =>
      expect(
        result.current.assistantRuntime.threads.getState().threadIds
      ).toHaveLength(2)
    )
    let created!: { threadId: string }
    await act(async () => {
      created = await result.current.workspace.createSession("writer")
    })
    expect(
      result.current.assistantRuntime.threads.getState().threadIds
    ).toContain(created.threadId)

    await act(async () => {
      await result.current.assistantRuntime.threads.switchToThread(
        created.threadId
      )
    })
    expect(messageText(harness.agent, result.current.assistantRuntime)).toEqual(
      {
        agentId: "writer",
        threadId: "thread-created-writer",
        messages: ["History for thread-created-writer"],
      }
    )
  })
})
