import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { CompleteAttachment } from "@assistant-ui/core"

import {
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_METHODS,
  AOS_PLAN_ID,
} from "@aos/protocol/acp"

import type { AcpConnection, AcpSessionUpdateListener } from "./types"
import {
  useAcpExecution,
  useAcpRuntime,
  useAcpTodos,
  type UseAcpRuntimeOptions,
} from "./use-acp-runtime"

const SESSION_ID = "session-1"
const RUN_META = { sequence: 0, runId: "run-1" }

type ResumeReply = Awaited<ReturnType<AcpConnection["resumeSession"]>>

/**
 * The runtime reads nothing from the resume reply — the Session's own
 * `session/update` replay carries its history and state — so the fake settles
 * with an empty body instead of a full capability snapshot.
 */
const resumeReply = (): ResumeReply => JSON.parse("{}")

function createFakeConnection() {
  const updates = new Map<string, Set<AcpSessionUpdateListener>>()
  const notifications = new Map<string, Set<(params: unknown) => void>>()
  const unused = (): never => {
    throw new Error("The ACP runtime does not use this connection method")
  }
  let settle = () => {}
  const resumed = new Promise<ResumeReply>((resolve) => {
    settle = () => resolve(resumeReply())
  })
  const resumeSession = vi.fn(() => resumed)
  const prompt = vi.fn(async () => ({ messageId: "u1" }))
  const cancel = vi.fn()

  const connection: AcpConnection = {
    status: "ready",
    initialized: new Promise<never>(() => {}),
    subscribeStatus: () => () => {},
    login: unused,
    newSession: unused,
    listSessions: unused,
    resumeSession,
    prompt,
    cancel,
    setConfigOption: unused,
    closeSession: unused,
    deleteSession: unused,
    updateSession: unused,
    steer: unused,
    focus: unused,
    listAgents: unused,
    setVisibility: unused,
    onSessionUpdate: (sessionId, listener) => {
      const listeners = updates.get(sessionId) ?? new Set()
      listeners.add(listener)
      updates.set(sessionId, listeners)
      return () => listeners.delete(listener)
    },
    onNotification: (method, listener) => {
      const listeners = notifications.get(method) ?? new Set()
      listeners.add(listener)
      notifications.set(method, listeners)
      return () => listeners.delete(listener)
    },
    onPendingRequest: () => () => {},
    lastSequence: () => undefined,
    close: () => {},
  }

  return {
    connection,
    resumeSession,
    prompt,
    cancel,
    settleResume: () => {
      settle()
      return resumed
    },
    emit: (update: SessionUpdate, meta: Record<string, unknown> = RUN_META) => {
      for (const listener of updates.get(SESSION_ID) ?? [])
        listener(update, meta)
    },
    notify: (method: string, params: unknown) => {
      for (const listener of notifications.get(method) ?? []) listener(params)
    },
  }
}

type Fake = ReturnType<typeof createFakeConnection>

const textUpdate = (
  sessionUpdate: "user_message" | "agent_message",
  messageId: string,
  text: string
): SessionUpdate => ({
  sessionUpdate,
  messageId,
  content: [{ type: "text", text }],
})

const messageText = (part: { type: string }) =>
  part.type === "text" && "text" in part ? String(part.text) : ""

async function mount(
  fake: Fake,
  options?: Pick<
    UseAcpRuntimeOptions,
    "attach" | "enableMessageQueue" | "onComposerPrefill" | "stageAttachments"
  >
) {
  const hook = renderHook(() =>
    useAcpRuntime({
      connection: fake.connection,
      sessionId: SESSION_ID,
      agentId: "agent-1",
      messageRewind: (sourceUserId) => ({
        rewindSourceId: `provider-${sourceUserId}`,
      }),
      ...options,
    })
  )
  await act(async () => {
    await fake.settleResume()
  })
  return hook
}

const visible = (runtime: ReturnType<typeof useAcpRuntime>) =>
  runtime.thread.getState().messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content.map(messageText).join(""),
  }))

describe("useAcpRuntime", () => {
  it("replays the Session on mount and projects its turns", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    expect(fake.resumeSession).toHaveBeenCalledWith(SESSION_ID, {
      replayFromStart: true,
    })
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(textUpdate("agent_message", "a1", "On it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "On it" },
    ])
  })

  it("attaches through the injected attach instead of resuming itself", async () => {
    const fake = createFakeConnection()
    const attach = vi.fn(async () => undefined)
    const { result } = await mount(fake, { attach })
    expect(attach).toHaveBeenCalledWith(SESSION_ID)
    expect(fake.resumeSession).not.toHaveBeenCalled()
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Attached"))
    })
    expect(visible(result.current)).toEqual([
      { id: "a1", role: "assistant", text: "Attached" },
    ])
  })

  it("tracks the run state the Session reports", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    expect(result.current.thread.getState().isRunning).toBe(true)
    act(() => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    })
    expect(result.current.thread.getState().isRunning).toBe(false)
  })

  it("prompts with the user's blocks and re-keys the optimistic turn", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Ship it" }],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Ship it" }],
        {}
      )
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
  })

  it("rewinds the source turn before a retry re-sends it", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("user_message", "u1", "Ship it"))
      fake.emit(textUpdate("agent_message", "a1", "Wrong answer"))
    })
    await act(async () => {
      result.current.thread.startRun({ parentId: "u1" })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Ship it" }],
        { rewindSourceId: "provider-u1" }
      )
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
    ])
  })

  it("cancels the Session's run", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Working"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      result.current.thread.cancelRun()
    })
    expect(fake.cancel).toHaveBeenCalledWith(SESSION_ID)
  })

  it("creates the Session a draft's first turn needs, then prompts it", async () => {
    const fake = createFakeConnection()
    const attach = vi.fn(async () => undefined)
    const resolveSessionId = vi.fn(async () => SESSION_ID)
    const { result } = renderHook(() =>
      useAcpRuntime({
        connection: fake.connection,
        sessionId: undefined,
        agentId: "agent-1",
        attach,
        resolveSessionId,
      })
    )
    expect(attach).not.toHaveBeenCalled()
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Ship it" }],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Ship it" }],
        {}
      )
    })
    expect(resolveSessionId).toHaveBeenCalledTimes(1)
    // Binding the resolved Session is what attaches and observes it.
    expect(attach).toHaveBeenCalledWith(SESSION_ID)
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Shipping it"))
    })
    expect(visible(result.current)).toEqual([
      { id: "u1", role: "user", text: "Ship it" },
      { id: "a1", role: "assistant", text: "Shipping it" },
    ])
  })

  it("stages a turn's attachments and links the batch it staged", async () => {
    const fake = createFakeConnection()
    const stageAttachments = vi.fn(async () => ({
      stageId: "stage-1",
      attachments: [
        { id: "att-1", name: "chart.png", contentType: "image/png" },
      ],
    }))
    const { result } = await mount(fake, { stageAttachments })
    const attachment: CompleteAttachment = {
      id: "att-1",
      type: "image",
      name: "chart.png",
      contentType: "image/png",
      status: { type: "complete" },
      content: [{ type: "image", image: "data:image/png;base64,AAA" }],
    }
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Read this" }],
        attachments: [attachment],
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [
          { type: "text", text: "Read this" },
          {
            type: "resource_link",
            uri: `${AOS_ATTACHMENT_URI_SCHEME}stage-1/att-1`,
            name: "chart.png",
            mimeType: "image/png",
          },
        ],
        { attachmentStageId: "stage-1" }
      )
    })
    expect(stageAttachments).toHaveBeenCalledWith(SESSION_ID, [attachment])
  })

  it("reports a composer prefill for the bound Session only", async () => {
    const fake = createFakeConnection()
    const onComposerPrefill = vi.fn()
    await mount(fake, { onComposerPrefill })
    act(() => {
      fake.notify(AOS_METHODS.notify.composerPrefill, {
        sessionId: "other-session",
        runId: "run-1",
        text: "Elsewhere",
      })
    })
    expect(onComposerPrefill).not.toHaveBeenCalled()
    act(() => {
      fake.notify(AOS_METHODS.notify.composerPrefill, {
        sessionId: SESSION_ID,
        runId: "run-1",
        text: "Next question?",
      })
    })
    expect(onComposerPrefill).toHaveBeenCalledWith("Next question?")
  })

  it("appends an artifact only for its own Session", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake)
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "On it"))
    })
    const artifact = {
      id: "art-1",
      filename: "chart.json",
      mimeType: "application/json",
      source: { type: "inline", encoding: "utf8", data: "{}" },
    }
    act(() => {
      fake.notify(AOS_METHODS.notify.artifact, {
        sessionId: "other-session",
        ...RUN_META,
        artifact,
      })
    })
    expect(result.current.thread.getState().messages[0]?.content).toHaveLength(
      1
    )
    act(() => {
      fake.notify(AOS_METHODS.notify.artifact, {
        sessionId: SESSION_ID,
        ...RUN_META,
        artifact,
      })
    })
    expect(result.current.thread.getState().messages[0]?.content).toHaveLength(
      2
    )
  })

  it("holds queued sends while a run owns the Session", async () => {
    const fake = createFakeConnection()
    const { result } = await mount(fake, { enableMessageQueue: true })
    act(() => {
      fake.emit(textUpdate("agent_message", "a1", "Working"))
      fake.emit({ sessionUpdate: "state_update", state: "running" })
    })
    await act(async () => {
      result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "Also check the logs" }],
      })
    })
    expect(fake.prompt).not.toHaveBeenCalled()
    await act(async () => {
      fake.emit({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    })
    await waitFor(() => {
      expect(fake.prompt).toHaveBeenCalledWith(
        SESSION_ID,
        [{ type: "text", text: "Also check the logs" }],
        {}
      )
    })
  })
})

function Probe() {
  const execution = useAcpExecution()
  const todos = useAcpTodos()
  return (
    <div>
      <p>{`Run: ${execution.status}`}</p>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.label}</li>
        ))}
      </ul>
    </div>
  )
}

function Harness({ connection }: { connection: AcpConnection }) {
  const runtime = useAcpRuntime({
    connection,
    sessionId: SESSION_ID,
    agentId: "agent-1",
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Probe />
    </AssistantRuntimeProvider>
  )
}

describe("useAcpRuntime extras", () => {
  it("exposes the Session's execution and Todos to the tree", async () => {
    const fake = createFakeConnection()
    render(<Harness connection={fake.connection} />)
    await act(async () => {
      await fake.settleResume()
    })
    expect(screen.getByText("Run: idle")).toBeInTheDocument()
    act(() => {
      fake.emit({ sessionUpdate: "state_update", state: "running" })
      fake.emit(
        {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: AOS_PLAN_ID,
            entries: [
              { content: "Ship it", priority: "medium", status: "in_progress" },
            ],
          },
        },
        {
          ...RUN_META,
          todos: [{ id: "todo-1", label: "Ship it", status: "active" }],
        }
      )
    })
    expect(screen.getByText("Run: running")).toBeInTheDocument()
    expect(screen.getByRole("listitem")).toHaveTextContent("Ship it")
  })
})
