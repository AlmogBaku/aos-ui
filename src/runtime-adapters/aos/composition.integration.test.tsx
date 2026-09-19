import type {
  AgentApp,
  AnyWireMessage,
} from "@agentclientprotocol/sdk/experimental/v2"
import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StrictMode, type ReactNode } from "react"

import {
  SESSION_CATALOG_MAX_WINDOW,
  type RuntimeInfo,
  type Session,
  type SessionModelsResponse,
} from "../../../packages/protocol"
import { createAosAcpAgent } from "../../../packages/proxy/acp/agent"
import { createActivityFeed } from "../../../packages/proxy/acp/activity-feed"
import { createReadState } from "../../../packages/proxy/acp/read-state"
import * as translators from "../../../packages/proxy/acp/translate"
import type { AcpConnectionContext } from "../../../packages/proxy/acp/types"
import { AttachmentStageRegistry } from "../../../packages/proxy/core/attachment-stages"
import {
  RunEventKind,
  type PendingRequest,
  type RunEvent,
} from "../../../packages/proxy/core/events"
import type {
  RuntimeInstance,
  ServerRunEngine,
  ServerRunHandle,
  ServerRuntime,
  SessionScope,
} from "../../../packages/proxy/core/runtime"
import { SessionCoordinator } from "../../../packages/proxy/core/session-coordinator"
import { createSessionRows } from "../../../packages/proxy/core/session-rows"

import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import { PendingInteractionComposer } from "../../components/runtime-interactions/pending-composer"
import { PendingInteractionProvider } from "../../components/runtime-interactions/pending-interaction-context"
import type {
  HarnessRuntime,
  RuntimeInteractionAdapter,
  TodoItem,
} from "../contracts"
import { runtimeAdapter } from "./composition"

/**
 * The Phase B gate: the real operator ACP agent bridged in process to the real
 * browser composition, over one fake native runtime. Nothing here stubs the
 * protocol — only the provider behind it.
 */

const AGENT_ID = "alpha"
const SESSION_ID = "stored-alpha"
const NOW = "2026-01-01T00:00:00.000Z"

const AVAILABLE = { status: "available" } as const

const RUNTIME_INFO: RuntimeInfo = {
  runtime: { id: "hermes", name: "Hermes" },
  status: "ready",
  capabilities: {
    agentCatalog: AVAILABLE,
    agentVisibility: AVAILABLE,
    sessionCatalog: {
      status: "available",
      scope: "workspace",
      order: "recent",
      defaultPageSize: 50,
      maxPageSize: 100,
      maxWindow: SESSION_CATALOG_MAX_WINDOW,
    },
    sessionHistory: {
      status: "available",
      order: "chronological",
      compacted: true,
      loading: "on-open",
      defaultPageSize: 200,
      maxPageSize: 500,
    },
    sessionDetail: AVAILABLE,
    sessionCreation: AVAILABLE,
    sessionTitle: AVAILABLE,
    sessionArchival: AVAILABLE,
    sessionDeletion: AVAILABLE,
    sessionRun: AVAILABLE,
    sessionStop: AVAILABLE,
    sessionSteer: AVAILABLE,
    sessionReadState: AVAILABLE,
  },
}

const MODELS: SessionModelsResponse = {
  selectedId: "sonnet",
  options: [
    { id: "sonnet", label: "Sonnet", group: "Anthropic" },
    { id: "opus", label: "Opus", group: "Anthropic" },
  ],
}

const CAPABILITIES = {
  agent: {},
  workspace: {
    slashCommands: {
      status: "available",
      scope: "attached-session",
      commands: [{ name: "plan", description: "Draft a plan" }],
    },
    models: {
      status: "available",
      scope: "attached-session",
      selection: "native-session",
      choices: "provider-reported",
    },
    context: {
      status: "available",
      scope: "attached-session",
      source: "provider-usage-or-estimate",
      breakdown: "provider-categories",
    },
    todos: {
      status: "available",
      scope: "session",
      mode: "read-only-projection",
      source: "latest-completed-todo-tool-result",
    },
    activity: { status: "unavailable", reason: "activity-unavailable" },
  },
  interactions: {
    steering: {
      status: "available",
      scope: "active-run",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: "ag-ui-interrupt",
      scope: "run",
      choices: [{ value: "once", scope: "request" }],
      maxPending: 1,
    },
    questions: {
      status: "available",
      protocol: "ag-ui-interrupt",
      scope: "run",
      answerModes: ["single", "multiple", "free-text"],
      cancellation: "native-cancel",
      maxQuestions: 1,
      maxChoicesPerQuestion: 4,
      maxAnswerValuesPerQuestion: "complete-request",
      maxStringBytes: 4096,
    },
    reactions: { status: "unavailable", reason: "reactions-unavailable" },
  },
  content: {
    attachments: { status: "unavailable", reason: "attachments-unavailable" },
    artifacts: { status: "available", scope: "session", maxBytes: 1_000_000 },
    transcription: { status: "unavailable", reason: "transcription" },
    speech: { status: "unavailable", reason: "speech" },
  },
}

const unsupported = () => {
  throw new Error("The browser ACP integration does not use this operation")
}

/** One provider run segment the test drives event by event. */
class RunSegment implements ServerRunHandle {
  readonly #values: RunEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<RunEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<RunEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<RunEvent>>((resolve) =>
          this.#waiters.push(resolve)
        )
      },
    }),
  }

  emit(event: RunEvent) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.#values.push(event)
  }

  finish() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
    this.#resolveSettled()
  }

  recoveryPosition() {
    return { epoch: "epoch-1", lastSeen: 0 }
  }
}

function sessionRow(): Session {
  return {
    id: SESSION_ID,
    agentId: AGENT_ID,
    title: "Older",
    archived: false,
    updatedAt: NOW,
    status: "idle",
  }
}

/** The fake native runtime, wired into the real coordinator and ACP agent. */
type StartInput = Parameters<ServerRunEngine["start"]>[1]

function createProxyAgentApp() {
  const segments: RunSegment[] = []
  const inputs: StartInput[] = []
  const start = vi.fn(async (_scope: SessionScope, input: StartInput) => {
    inputs.push(input)
    const segment = new RunSegment()
    segments.push(segment)
    return segment
  })
  const engine: ServerRunEngine = {
    start,
    recover: vi.fn(unsupported),
    discover: vi.fn(async () => undefined),
  }
  const coordinator = new SessionCoordinator({
    engine,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 64,
    maxSubscriberBytes: 256 * 1024,
    maxReplayEvents: 64,
    maxReplayBytes: 256 * 1024,
  })
  const rows = new Map([[SESSION_ID, sessionRow()]])
  let models = MODELS
  const updateModel = vi.fn(
    async (
      _agentId: string,
      _sessionId: string,
      patch: { selectedId?: string; effortId?: string }
    ) => {
      models = { ...models, ...patch }
      return { selectedId: models.selectedId }
    }
  )
  const listAllSessions = async (limit: number, offset: number) => ({
    sessions: [...rows.values()],
    total: rows.size,
    limit,
    offset,
  })
  const runtime: ServerRuntime = {
    runs: engine,
    resolveInvitedSession: unsupported,
    resolveSessionId: (_agentId, publicSessionId) => publicSessionId,
    publicError: () => undefined,
    authState: unsupported,
    runtimeInfo: async () => RUNTIME_INFO,
    listAgents: async () => ({
      revision: "revision-1",
      agents: [
        {
          summary: { kind: "ready", id: AGENT_ID, name: "Alpha" },
          visibility: "visible",
          selectable: true,
          editable: true,
          revision: "revision-1",
        },
      ],
    }),
    updateAgentVisibility: unsupported,
    listAllSessions,
    listSessions: async (_agentId, limit, offset) =>
      listAllSessions(limit, offset),
    history: async (_agentId, sessionId) => ({
      sessionId,
      messages: [
        {
          id: "native-user-1",
          role: "user" as const,
          content: [{ type: "text" as const, text: "Open it" }],
          createdAt: NOW,
        },
        {
          id: "native-assistant-1",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Ready" }],
          createdAt: NOW,
        },
      ],
      total: 2,
      limit: 500,
      offset: 0,
      nextOffset: 0,
    }),
    getSession: async (_agentId, sessionId) => {
      const row = rows.get(sessionId)
      if (!row) throw new Error("Unknown Session")
      return row
    },
    createSession: unsupported,
    mutateSession: async () => undefined,
    workspaceCapabilities: async () => CAPABILITIES,
    models: async () => models,
    updateModel,
    context: async () => ({
      usedTokens: 1_200,
      maxTokens: 20_000,
      source: "provider-usage" as const,
    }),
    subscribeSessionInvalidation: async () => () => undefined,
    subscribeCatalogChanges: async () => () => undefined,
    stageAttachments: unsupported,
    artifact: unsupported,
    transcribe: unsupported,
    speak: unsupported,
  }
  const runtimeInstance: RuntimeInstance = {
    id: "hermes-main",
    runtime,
    sessions: coordinator,
    close: async () => {
      coordinator.close()
    },
  }
  const lane = "operator" as const
  const sessionRows = createSessionRows()
  const context: AcpConnectionContext = {
    connectionId: "connection-1",
    principalId: "operator",
    lane,
    runtimeInstance,
    sessionRows,
    translators,
    attachmentStages: new AttachmentStageRegistry(),
    readState: createReadState({
      runtimeInstance,
      sessionRows,
      lane,
      onUnreadChanged: () => undefined,
    }),
    activityFeed: createActivityFeed({ runtimeInstance, sessionRows }),
  }
  return {
    app: createAosAcpAgent(context),
    segments,
    inputs,
    start,
    updateModel,
    close: () => runtimeInstance.close(),
  }
}

/** A WebSocket-shaped pipe to the in-process proxy agent. */
function pipedSocket(app: AgentApp) {
  return class PipedSocket extends EventTarget {
    readyState = 0
    readonly #inbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
    readonly #writer: WritableStreamDefaultWriter<AnyWireMessage>

    constructor() {
      super()
      const outbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
      app.connect({
        readable: this.#inbound.readable,
        writable: outbound.writable,
      })
      this.#writer = this.#inbound.writable.getWriter()
      void this.#pump(outbound.readable.getReader())
      queueMicrotask(() => {
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
      })
    }

    async #pump(reader: ReadableStreamDefaultReader<AnyWireMessage>) {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(value) })
        )
      }
    }

    send(data: string) {
      void this.#writer.write(JSON.parse(data) as AnyWireMessage)
    }

    close() {
      this.readyState = 3
      this.dispatchEvent(new Event("close"))
    }
  }
}

// The Thread reads the adapter the mounted provider supplied; a stable
// component keeps the composer from remounting between renders.
let activeInteractions: RuntimeInteractionAdapter | undefined

function GatedComposer({ fallback }: { fallback: ReactNode }) {
  const threadId = useAuiState(
    (state) => state.threadListItem.remoteId ?? state.threadListItem.id
  )
  if (!activeInteractions) return fallback
  return (
    <PendingInteractionComposer
      locale="en"
      threadId={threadId}
      interactions={activeInteractions}
      fallback={fallback}
    />
  )
}

const components = { Composer: GatedComposer }

async function mount() {
  const proxy = createProxyAgentApp()
  vi.stubGlobal("WebSocket", pipedSocket(proxy.app))
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("The ACP operator lane reads no REST here")
    })
  )
  let supplied: HarnessRuntime | undefined
  const Provider = runtimeAdapter.Provider
  render(
    <StrictMode>
      <Provider
        config={{
          status: "ready",
          mode: "aos",
          composerFeatures: {
            modelSelectorEnabled: true,
            contextEnabled: true,
          },
        }}
        locale="en"
      >
        {(runtime) => {
          supplied = runtime
          activeInteractions = runtime.interactions
          return (
            <AssistantRuntimeProvider runtime={runtime.assistantRuntime}>
              <PendingInteractionProvider interactions={runtime.interactions}>
                <main>Mounted</main>
                <Thread
                  autoFocus={false}
                  components={components}
                  composerFeatures={runtime.composer}
                  messageRewind={runtime.messageRewind}
                />
              </PendingInteractionProvider>
            </AssistantRuntimeProvider>
          )
        }}
      </Provider>
    </StrictMode>
  )
  expect(await screen.findByRole("main")).toHaveTextContent("Mounted")
  await waitFor(() => expect(supplied).toBeDefined())
  const runtime = () => {
    if (!supplied) throw new Error("The provider supplied no runtime")
    return supplied
  }
  await runtime().assistantRuntime.threads.getLoadThreadsPromise()
  await act(async () => {
    await runtime().assistantRuntime.threads.switchToThread(SESSION_ID)
  })
  return { proxy, runtime }
}

const messageTexts = (runtime: HarnessRuntime) =>
  runtime.assistantRuntime.thread
    .getState()
    .messages.map((message) =>
      message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    )

const dataPartNames = (runtime: HarnessRuntime) =>
  runtime.assistantRuntime.thread
    .getState()
    .messages.flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "data" ? [part.name] : []
      )
    )

const permissionInterrupt = (): PendingRequest => ({
  id: "interrupt-1",
  reason: "approval",
  message: "Run the tool?",
  responseSchema: { type: "string", enum: ["once", "deny"] },
})

async function send(runtime: HarnessRuntime, text: string) {
  act(() => {
    runtime.assistantRuntime.thread.composer.setText(text)
    runtime.assistantRuntime.thread.composer.send()
  })
}

afterEach(() => {
  cleanup()
  activeInteractions = undefined
  vi.unstubAllGlobals()
})

describe("AOS operator browser over the real proxy ACP agent", () => {
  it("replays history, streams one turn, and renders its Todos and artifact", async () => {
    const { proxy, runtime } = await mount()
    expect(await screen.findByText("Open it")).toBeVisible()
    expect(await screen.findByText("Ready")).toBeVisible()

    const todos: TodoItem[][] = []
    runtime().workspace.subscribeTodos?.(SESSION_ID, (next) => todos.push(next))

    await send(runtime(), "Ship it")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    const segment = proxy.segments[0]!
    const runId = proxy.inputs[0]!.runId
    act(() => {
      segment.emit({
        type: RunEventKind.RUN_STARTED,
        threadId: SESSION_ID,
        runId,
      })
      segment.emit({
        type: RunEventKind.ACTIVITY_SNAPSHOT,
        messageId: "aos-plan:stored-alpha",
        activityType: "PLAN",
        content: {
          todos: [{ id: "todo-1", label: "Draft it", status: "active" }],
        },
        replace: true,
      })
      segment.emit({
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      })
      segment.emit({
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "Shipping it",
      })
      segment.emit({
        type: RunEventKind.CUSTOM,
        name: "aos.artifact",
        value: {
          id: "artifact-1",
          filename: "plan.md",
          mimeType: "text/markdown",
          source: { type: "provider", reference: "artifact-1" },
        },
      })
      segment.emit({
        type: RunEventKind.TEXT_MESSAGE_END,
        messageId: "assistant-1",
      })
      segment.emit({
        type: RunEventKind.RUN_FINISHED,
        threadId: SESSION_ID,
        runId,
        outcome: { type: "success" },
      })
      segment.finish()
    })

    expect(await screen.findByText("Shipping it")).toBeVisible()
    await waitFor(() =>
      expect(runtime().assistantRuntime.thread.getState().isRunning).toBe(false)
    )
    expect(messageTexts(runtime())).toEqual([
      "Open it",
      "Ready",
      "Ship it",
      "Shipping it",
    ])
    await waitFor(() =>
      expect(todos.at(-1)).toEqual([
        { id: "todo-1", label: "Draft it", status: "active" },
      ])
    )
    await waitFor(() =>
      expect(dataPartNames(runtime())).toContain("aos.artifact")
    )
    await proxy.close()
  })

  it("stops a run the operator started", async () => {
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")

    await send(runtime(), "Ship it")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    const segment = proxy.segments[0]!
    const runId = proxy.inputs[0]!.runId
    act(() => {
      segment.emit({
        type: RunEventKind.RUN_STARTED,
        threadId: SESSION_ID,
        runId,
      })
    })
    await waitFor(() =>
      expect(runtime().assistantRuntime.thread.getState().isRunning).toBe(true)
    )

    act(() => runtime().assistantRuntime.thread.cancelRun())
    await waitFor(() => expect(segment.stop).toHaveBeenCalledTimes(1))
    act(() => {
      segment.emit({
        type: RunEventKind.RUN_FINISHED,
        threadId: SESSION_ID,
        runId,
        outcome: { type: "success" },
      })
      segment.finish()
    })
    await waitFor(() =>
      expect(runtime().assistantRuntime.thread.getState().isRunning).toBe(false)
    )
    await proxy.close()
  })

  it("resumes the run once the operator answers a permission request", async () => {
    const user = userEvent.setup()
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")

    await send(runtime(), "Ship it")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    const segment = proxy.segments[0]!
    const runId = proxy.inputs[0]!.runId
    act(() => {
      segment.emit({
        type: RunEventKind.RUN_STARTED,
        threadId: SESSION_ID,
        runId,
      })
      segment.emit({
        type: RunEventKind.RUN_FINISHED,
        threadId: SESSION_ID,
        runId,
        outcome: { type: "interrupt", interrupts: [permissionInterrupt()] },
      })
      segment.finish()
    })

    await user.click(await screen.findByRole("option", { name: "Allow once" }))
    await user.click(screen.getByRole("button", { name: "Send answer" }))

    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(2))
    expect(proxy.inputs[1]).toMatchObject({
      resume: [
        {
          interruptId: "interrupt-1",
          status: "resolved",
          payload: "once",
        },
      ],
    })
    const resumed = proxy.segments[1]!
    act(() => {
      resumed.emit({
        type: RunEventKind.TEXT_MESSAGE_START,
        messageId: "assistant-2",
        role: "assistant",
      })
      resumed.emit({
        type: RunEventKind.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-2",
        delta: "Allowed",
      })
      resumed.emit({
        type: RunEventKind.TEXT_MESSAGE_END,
        messageId: "assistant-2",
      })
      resumed.emit({
        type: RunEventKind.RUN_FINISHED,
        threadId: SESSION_ID,
        runId: proxy.inputs[1]!.runId,
        outcome: { type: "success" },
      })
      resumed.finish()
    })
    expect(await screen.findByText("Allowed")).toBeVisible()
    await proxy.close()
  })

  it("round-trips a model change to the provider", async () => {
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")

    await waitFor(() =>
      expect(runtime().composer?.model?.selectedId).toBe("sonnet")
    )
    await act(async () => {
      await runtime().composer?.model?.update({ selectedId: "opus" })
    })
    expect(proxy.updateModel).toHaveBeenCalledWith(AGENT_ID, SESSION_ID, {
      selectedId: "opus",
    })
    await waitFor(() =>
      expect(runtime().composer?.model?.selectedId).toBe("opus")
    )
    await proxy.close()
  })
})
