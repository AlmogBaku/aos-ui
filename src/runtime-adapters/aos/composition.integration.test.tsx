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
  INTERACTION_PROTOCOL,
  SESSION_CATALOG_MAX_WINDOW,
  SessionAttachmentStageRequestSchema,
  type RuntimeInfo,
  type Session,
  type SessionAttachmentStageRequest,
  type SessionMessage,
  type SessionModelsResponse,
} from "../../../packages/protocol"
import { createAosAcpAgent } from "../../../packages/proxy/acp/agent"
import { createActivityFeed } from "../../../packages/proxy/acp/activity-feed"
import { createReadState } from "../../../packages/proxy/acp/read-state"
import { createChannel } from "../../../packages/proxy/core/channel"
import * as translators from "../../../packages/proxy/acp/translate"
import type { AcpConnectionContext } from "../../../packages/proxy/acp/types"
import { AttachmentStageRegistry } from "../../../packages/proxy/core/attachment-stages"
import {
  PendingRequestKind,
  PromptTurnInputSchema,
  TurnEventKind,
  type PendingRequest,
  type TurnEvent,
} from "../../../packages/proxy/core/events"
import type {
  RuntimeInstance,
  ServerTurnEngine,
  ServerTurnHandle,
  ServerRuntime,
  SessionScope,
} from "../../../packages/proxy/core/runtime"
import { SessionCoordinator } from "../../../packages/proxy/core/session-coordinator"
import { EVERY_FEED } from "../../../packages/proxy/core/member"
import { createSessionRows } from "../../../packages/proxy/core/session-rows"

import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import { en } from "../../lib/i18n/dictionaries/en"
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
const CREATED_SESSION_ID = "created-alpha"
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
    sessionPin: AVAILABLE,
    sessionDeletion: AVAILABLE,
    sessionTurn: AVAILABLE,
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
      scope: "active-turn",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
      choices: [{ value: "once", scope: "request" }],
      maxPending: 1,
    },
    questions: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
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
    mcpApps: { status: "unavailable", reason: "not-supported" },
    transcription: { status: "unavailable", reason: "transcription" },
    speech: { status: "unavailable", reason: "speech" },
  },
}

const unsupported = () => {
  throw new Error("The browser ACP integration does not use this operation")
}

/** One provider run segment the test drives event by event. */
class TurnSegment implements ServerTurnHandle {
  readonly #values: TurnEvent[] = []
  readonly #waiters: Array<(value: IteratorResult<TurnEvent>) => void> = []
  readonly stop = vi.fn(async () => "stopping" as const)
  readonly settled: Promise<void>
  #resolveSettled!: () => void
  #closed = false

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve
    })
  }

  readonly events: AsyncIterable<TurnEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ done: false, value })
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<TurnEvent>>((resolve) =>
          this.#waiters.push(resolve)
        )
      },
    }),
  }

  emit(event: TurnEvent) {
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

function sessionRow(id = SESSION_ID, title = "Older"): Session {
  return {
    id,
    agentId: AGENT_ID,
    title,
    archived: false,
    updatedAt: NOW,
    status: "idle",
  }
}

/** The transcript the stored Session replays; only it has one. */
const STORED_MESSAGES: readonly SessionMessage[] = [
  {
    id: "native-user-1",
    role: "user",
    content: [{ type: "text", text: "Open it" }],
    createdAt: NOW,
  },
  {
    id: "native-assistant-1",
    role: "assistant",
    content: [
      { type: "reasoning", text: "Recall the thread." },
      { type: "text", text: "Ready" },
    ],
    createdAt: NOW,
  },
]

/** The fake native runtime, wired into the real coordinator and ACP agent. */
/** The failure a runtime reports while it cannot create a Session yet. */
const UNAVAILABLE = new Error("The runtime is not ready")

type StartInput = Parameters<ServerTurnEngine["start"]>[1]

function createProxyAgentApp(stored: readonly SessionMessage[]) {
  const segments: TurnSegment[] = []
  const scopes: SessionScope[] = []
  const inputs: StartInput[] = []
  const created: string[] = []
  /** How many `session/new` calls the runtime refuses as not ready yet. */
  const unavailable = { creates: 0 }
  const start = vi.fn(async (scope: SessionScope, input: StartInput) => {
    scopes.push(scope)
    inputs.push(input)
    const segment = new TurnSegment()
    segments.push(segment)
    return segment
  })
  const engine: ServerTurnEngine = {
    start,
    recover: vi.fn(unsupported),
    discover: vi.fn(async () => undefined),
  }
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
    turns: engine,
    resolveInvitedSession: unsupported,
    resolveSessionId: (_agentId, publicSessionId) => publicSessionId,
    publicError: (cause) =>
      cause === UNAVAILABLE
        ? { code: "temporarily_unavailable", status: 503 }
        : undefined,
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
          avatarEditable: false,
          revision: "revision-1",
        },
      ],
    }),
    updateAgent: unsupported,
    listAllSessions,
    listSessions: async (_agentId, limit, offset) =>
      listAllSessions(limit, offset),
    // Only the stored Session has a transcript; a Session this run created has
    // nothing to replay, exactly as the runtime reports it.
    history: async (_agentId, sessionId) => {
      const messages = sessionId === SESSION_ID ? [...stored] : []
      return {
        sessionId,
        messages,
        total: messages.length,
        limit: 500,
        offset: 0,
        nextOffset: 0,
      }
    },
    getSession: async (_agentId, sessionId) => {
      const row = rows.get(sessionId)
      if (!row) throw new Error("Unknown Session")
      return row
    },
    createSession: async (agentId, title) => {
      if (unavailable.creates > 0) {
        unavailable.creates -= 1
        throw UNAVAILABLE
      }
      rows.set(
        CREATED_SESSION_ID,
        sessionRow(CREATED_SESSION_ID, title ?? "New Session")
      )
      created.push(agentId)
      return { session: { id: CREATED_SESSION_ID, agentId } }
    },
    updateSession: async () => undefined,
    deleteSession: async () => undefined,
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
  const coordinator = new SessionCoordinator({
    engine,
    readings: runtime,
    maxActiveExecutions: 8,
    maxGuestActiveExecutions: 2,
    maxSubscriberEvents: 64,
    maxSubscriberBytes: 256 * 1024,
    maxReplayEvents: 64,
    maxReplayBytes: 256 * 1024,
  })
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
  const attachmentStages = new AttachmentStageRegistry()
  const context: AcpConnectionContext = {
    connectionId: "connection-1",
    principalId: "operator",
    lane,
    feeds: EVERY_FEED,
    runtimeInstance,
    sessionRows,
    translators,
    attachmentStages,
    rooms: createChannel({
      snapshot: (scope) => coordinator.snapshot(scope),
    }),
    readState: createReadState({
      runtimeInstance,
      sessionRows,
      onUnreadChanged: () => undefined,
    }),
    activityFeed: createActivityFeed({ runtimeInstance, sessionRows }),
  }
  return {
    app: createAosAcpAgent(context),
    segments,
    scopes,
    inputs,
    created,
    unavailable,
    attachmentStages,
    start,
    updateModel,
    close: () => runtimeInstance.close(),
  }
}

type ProxyAgentApp = ReturnType<typeof createProxyAgentApp>

/**
 * The REST leg of an attachment batch: the proxy owns the bytes and hands back
 * a stage id, which the next prompt references over ACP.
 */
function stageAttachmentsOverRest(proxy: ProxyAgentApp) {
  const requests: SessionAttachmentStageRequest[] = []
  const appended: string[] = []
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = /\/agents\/([^/]+)\/sessions\/([^/]+)\/attachments\/stage$/u
    const match = path.exec(String(input))
    if (!match || typeof init?.body !== "string")
      throw new Error("The ACP operator lane reads no other REST here")
    const request = SessionAttachmentStageRequestSchema.parse(
      JSON.parse(init.body)
    )
    requests.push(request)
    const attachments = request.attachments.map((attachment) =>
      attachment.type === "image"
        ? {
            type: "image" as const,
            dataUrl: attachment.dataUrl,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          }
        : {
            type: "file" as const,
            mimeType: attachment.mimeType ?? "application/octet-stream",
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          }
    )
    const stageId = proxy.attachmentStages.create(
      decodeURIComponent(match[1]!),
      decodeURIComponent(match[2]!),
      {
        public: attachments,
        appendTo: (text: string) => {
          appended.push(text)
          return `${text}\n[${attachments.length} attachment]`
        },
        cleanup: async () => undefined,
      }
    )
    if (!stageId) throw new Error("The stage registry refused the batch")
    return Response.json({ stageId, attachments })
  })
  return { fetcher, requests, appended }
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

async function mount(stored: readonly SessionMessage[] = STORED_MESSAGES) {
  const proxy = createProxyAgentApp(stored)
  const staging = stageAttachmentsOverRest(proxy)
  vi.stubGlobal("WebSocket", pipedSocket(proxy.app))
  vi.stubGlobal("fetch", staging.fetcher)
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
  return { proxy, runtime, staging }
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

/** The `aos.artifact` payloads the assistant turn with this prose carries. */
const artifactsOnMessage = (runtime: HarnessRuntime, text: string) => {
  const message = runtime.assistantRuntime.thread
    .getState()
    .messages.find(
      (candidate) =>
        candidate.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("") === text
    )
  return (message?.content ?? []).flatMap((part) =>
    part.type === "data" && part.name === "aos.artifact" ? [part.data] : []
  )
}

const permissionInterrupt = (): PendingRequest => ({
  requestId: "interrupt-1",
  kind: PendingRequestKind.Permission,
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
    act(() => {
      segment.emit({ kind: TurnEventKind.TurnStarted })
      segment.emit({
        kind: TurnEventKind.PlanUpdated,
        todos: [{ id: "todo-1", label: "Draft it", status: "active" }],
      })
      segment.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Shipping it",
      })
      segment.emit({
        kind: TurnEventKind.ArtifactPublished,
        artifact: {
          id: "artifact-1",
          filename: "plan.md",
          mimeType: "text/markdown",
          source: { type: "provider", reference: "artifact-1" },
        },
      })
      segment.emit({ kind: TurnEventKind.TurnEnded })
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

  it("replays a stored artifact onto the turn that published it", async () => {
    const artifact = {
      id: "artifact-stored",
      filename: "Quarterly report",
      sizeBytes: 4_096,
      source: { type: "provider" as const, reference: "artifact-stored" },
    }
    const { proxy, runtime } = await mount([
      STORED_MESSAGES[0]!,
      {
        id: "native-assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "Ready" },
          { type: "data", name: "aos.artifact", data: artifact },
        ],
        createdAt: NOW,
      },
      {
        id: "native-user-2",
        role: "user",
        content: [{ type: "text", text: "And again" }],
        createdAt: NOW,
      },
      {
        id: "native-assistant-2",
        role: "assistant",
        content: [{ type: "text", text: "Still ready" }],
        createdAt: NOW,
      },
    ])

    expect(await screen.findByText("Still ready")).toBeVisible()
    await waitFor(() =>
      expect(artifactsOnMessage(runtime(), "Ready")).toEqual([artifact])
    )
    // The replay addresses the turn that stored it, not the newest one.
    expect(artifactsOnMessage(runtime(), "Still ready")).toEqual([])
    await proxy.close()
  })

  it("resumes the run once the operator answers a permission request", async () => {
    const user = userEvent.setup()
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")

    await send(runtime(), "Ship it")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    const segment = proxy.segments[0]!
    act(() => {
      segment.emit({ kind: TurnEventKind.TurnStarted })
      segment.emit({
        kind: TurnEventKind.TurnRequiresAction,
        requests: [permissionInterrupt()],
      })
      segment.finish()
    })

    // The tool approval is the one place to answer; this harness mounts no
    // toolkit, so Assistant UI's own fallback card offers the choices.
    expect(await screen.findByText("Run the tool?")).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Send answer" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Allow" }))

    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(2))
    expect(proxy.inputs[1]).toMatchObject({
      replies: [
        {
          requestId: "interrupt-1",
          status: "resolved",
          payload: "once",
        },
      ],
    })
    const resumed = proxy.segments[1]!
    act(() => {
      resumed.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-2",
        text: "Allowed",
      })
      resumed.emit({ kind: TurnEventKind.TurnEnded })
      resumed.finish()
    })
    expect(await screen.findByText("Allowed")).toBeVisible()
    // The turn that hosted the permission request is the turn the run resumed
    // into, so the answered interrupt leaves no empty assistant row behind.
    await waitFor(() =>
      expect(messageTexts(runtime())).toEqual([
        "Open it",
        "Ready",
        "Ship it",
        "Allowed",
      ])
    )
    await proxy.close()
  })

  it("a draft's first turn creates the Session and streams", async () => {
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")
    const createSessionDraft = runtime().createSessionDraft
    expect(createSessionDraft).toBeDefined()
    await act(async () => {
      await createSessionDraft?.(AGENT_ID)
    })

    await send(runtime(), "Ship it")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    expect(proxy.created).toEqual([AGENT_ID])
    expect(proxy.scopes[0]!.threadId).toBe(CREATED_SESSION_ID)
    // The turn the operator sent stays on screen across `session/new`.
    expect(messageTexts(runtime())).toEqual(["Ship it"])
    const segment = proxy.segments[0]!
    act(() => {
      segment.emit({ kind: TurnEventKind.TurnStarted })
      segment.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-draft",
        text: "Shipping it",
      })
      segment.emit({ kind: TurnEventKind.TurnEnded })
      segment.finish()
    })

    expect(await screen.findByText("Shipping it")).toBeVisible()
    await waitFor(() =>
      expect(messageTexts(runtime())).toEqual(["Ship it", "Shipping it"])
    )
    await proxy.close()
  })

  it("keeps a refused draft's turn in the composer and opens the next draft empty", async () => {
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")
    await act(async () => {
      await runtime().createSessionDraft?.(AGENT_ID)
    })
    proxy.unavailable.creates = 1

    await send(runtime(), "Ship it")

    expect(
      await screen.findByText(en.runErrors.AOS_PROVIDER_UNAVAILABLE)
    ).toBeVisible()
    expect(runtime().assistantRuntime.thread.composer.getState().text).toBe(
      "Ship it"
    )
    expect(proxy.created).toEqual([])

    await act(async () => {
      await runtime().createSessionDraft?.(AGENT_ID)
    })

    expect(
      screen.queryByText(en.runErrors.AOS_PROVIDER_UNAVAILABLE)
    ).not.toBeInTheDocument()
    expect(runtime().assistantRuntime.thread.getState().messages).toEqual([])
    expect(runtime().assistantRuntime.thread.composer.getState().text).toBe("")

    await send(runtime(), "Ship it")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    expect(proxy.created).toEqual([AGENT_ID])
    await proxy.close()
  })

  it("stages a composed attachment and links it on the prompt", async () => {
    const { proxy, runtime, staging } = await mount()
    await screen.findByText("Ready")

    await act(async () => {
      await runtime().assistantRuntime.thread.composer.addAttachment(
        new File(["chart bytes"], "chart.png", { type: "image/png" })
      )
    })
    await send(runtime(), "Read this")

    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    expect(staging.requests).toEqual([
      {
        attachments: [
          {
            type: "image",
            dataUrl: expect.stringContaining("data:image/png;base64,"),
            filename: "chart.png",
          },
        ],
      },
    ])
    // The proxy only appends a stage it could claim by id, so the turn it
    // admitted proves both the `_meta.aos` stage id and the linked block.
    expect(staging.appended).toEqual(["Read this"])
    expect(PromptTurnInputSchema.parse(proxy.inputs[0]).prompt).toBe(
      "Read this\n[1 attachment]"
    )
    await proxy.close()
  })

  it("prefills the composer with the next turn the run suggested", async () => {
    const { proxy, runtime } = await mount()
    await screen.findByText("Ready")

    await send(runtime(), "/undo")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    const segment = proxy.segments[0]!
    act(() => {
      segment.emit({ kind: TurnEventKind.TurnStarted })
      segment.emit({ kind: TurnEventKind.TurnEnded, composerPrefill: "next?" })
      segment.finish()
    })

    await waitFor(() =>
      expect(runtime().assistantRuntime.thread.composer.getState().text).toBe(
        "next?"
      )
    )
    await proxy.close()
  })

  it("keeps a turn's reasoning and prose on one assistant message", async () => {
    const user = userEvent.setup()
    const { proxy, runtime } = await mount()
    const assistantParts = () =>
      runtime()
        .assistantRuntime.thread.getState()
        .messages.filter((message) => message.role === "assistant")
        .map((message) => message.content.map((part) => part.type))

    // The replayed turn composes the reasoning and the prose it answered with.
    expect(await screen.findByText("Ready")).toBeVisible()
    await waitFor(() =>
      expect(assistantParts()).toEqual([["reasoning", "text"]])
    )

    await send(runtime(), "Think it through")
    await waitFor(() => expect(proxy.start).toHaveBeenCalledTimes(1))
    const segment = proxy.segments[0]!
    act(() => {
      segment.emit({ kind: TurnEventKind.TurnStarted })
    })
    // The run has started but written nothing yet, so the replayed turn keeps
    // the settled disclosure it was projected with.
    await waitFor(() =>
      expect(runtime().assistantRuntime.thread.getState().isRunning).toBe(true)
    )
    expect(screen.getAllByRole("button", { name: /Worked/ })).toHaveLength(1)
    expect(screen.queryAllByRole("button", { name: "Running" })).toEqual([])

    // The reasoning half of a turn names the assistant message it reasons
    // toward, and streams before the prose it belongs to.
    act(() => {
      segment.emit({
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "Weigh ",
      })
      segment.emit({
        kind: TurnEventKind.ThoughtChunk,
        messageId: "assistant-1",
        text: "the options.",
      })
      segment.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "Shipping ",
      })
      segment.emit({
        kind: TurnEventKind.MessageChunk,
        messageId: "assistant-1",
        text: "it.",
      })
      segment.emit({ kind: TurnEventKind.TurnEnded })
      segment.finish()
    })

    expect(await screen.findByText("Shipping it.")).toBeVisible()
    await waitFor(() =>
      expect(assistantParts()).toEqual([
        ["reasoning", "text"],
        ["reasoning", "text"],
      ])
    )
    expect(messageTexts(runtime())).toEqual([
      "Open it",
      "Ready",
      "Think it through",
      "Shipping it.",
    ])
    expect(screen.getAllByText("Shipping it.")).toHaveLength(1)
    // Both turns have settled, so each folds the work it did before answering.
    const folds = screen.getAllByRole("button", { name: /Worked/ })
    expect(folds).toHaveLength(2)
    for (const fold of folds) await user.click(fold)
    // One reasoning disclosure per assistant turn, not one per streamed id. A
    // settled turn's outcome is the fold's to report, so no row claims to run.
    expect(screen.getAllByRole("button", { name: "Reasoning" })).toHaveLength(2)
    expect(screen.queryAllByRole("button", { name: "Running" })).toEqual([])
    await proxy.close()
  })
})
