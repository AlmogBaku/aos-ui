import { z } from "zod"
import {
  ActivityDeltaEventSchema,
  ActivitySnapshotEventSchema,
  HttpAgent,
  RunAgentInputSchema,
  type HttpAgentFetchFn,
} from "@ag-ui/client"
import {
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  CustomEventSchema,
  StepFinishedEventSchema,
  StepStartedEventSchema,
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type AgentCapabilities,
  type AGUIEvent,
  type RunFinishedEvent,
} from "@ag-ui/core"

import {
  AgentCatalogResponseSchema,
  ErrorResponseSchema,
  RuntimeInfoSchema,
  RunSteerRequestSchema,
  RunSteerResponseSchema,
  RunStopResponseSchema,
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionCatalogResponseSchema,
  SessionContextResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionModelSelectRequestSchema,
  SessionModelsResponseSchema,
  SessionSchema,
  SessionSpeechRequestSchema,
  SessionTodosResponseSchema,
  SessionTranscriptionRequestSchema,
  SessionTranscriptionResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  VisibilityUpdateResponseSchema,
} from "@aos/protocol"
import type {
  Session,
  SessionHistoryResponse,
  SessionMessage,
} from "@aos/protocol"
import type {
  AgentCatalogEntry,
  AgentVisibility,
  TodoItem,
  WorkspaceAdapter,
  WorkspaceActivityEvent,
} from "../contracts"
import type { AosEventScope } from "./aos-reconciliation"

type Schema<T> = Pick<z.ZodType<T>, "safeParse">

export type AosWorkspaceCapabilities = Omit<
  z.infer<typeof SessionWorkspaceCapabilitiesResponseSchema>,
  "agent"
> & { agent: AgentCapabilities }
export type AosModelChoices = z.infer<typeof SessionModelsResponseSchema>
export type AosContext = z.infer<typeof SessionContextResponseSchema>
export type AosLoadedHistory = Omit<SessionHistoryResponse, "messages"> & {
  messages: SessionMessage[]
}
export type AosStagedAttachment = z.infer<
  typeof SessionAttachmentStageResponseSchema
>

async function normalizedError(response: Response) {
  const parsed = ErrorResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  )
  return parsed.success ? parsed.data.error : undefined
}

async function friendlyErrorResponse(response: Response) {
  if (response.ok) return response
  const error = await normalizedError(response.clone())
  if (!error) return response
  const headers = new Headers(response.headers)
  headers.set("content-type", "text/plain; charset=UTF-8")
  return new Response(error.description, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function dataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return `data:${blob.type};base64,${btoa(binary)}`
}

export type AosClientFailure =
  "connection-interrupted" | "provider-unavailable" | "proxy-failure"

export class AosClientError extends Error {
  constructor(
    readonly kind: AosClientFailure,
    message = "AOS proxy request failed",
    readonly code?: string
  ) {
    super(message)
    this.name = "AosClientError"
  }
}

export type AosRemoteClientOptions = {
  fetcher?: typeof fetch
  basePath?: string
  authorization?: string
  scope?: AosEventScope
  reconciler?: {
    read<T>(scope: AosEventScope, operation: () => Promise<T>): Promise<T>
    subscribe?(scope: AosEventScope, listener: () => void): () => void
  }
}

type StagedRunAttachment = {
  type: "image" | "file"
  dataUrl: string
  filename?: string
  mimeType: string
}

type RewindReplacement = {
  localMessageId: string
  text: string
}

const MAX_REWIND_REPLACEMENTS_PER_SESSION = 32

type SessionStatus = Session["status"]
type AosSessionSignalEvent =
  AGUIEvent | ActivitySnapshotEvent | ActivityDeltaEvent
type SessionMetadataSubscription = {
  threadIds: ReadonlySet<string>
  listener: Parameters<
    NonNullable<WorkspaceAdapter["subscribeSessionMetadata"]>
  >[1]
}

function messageText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : []
    )
    .join("")
}

function attachmentsForStage(value: unknown): StagedRunAttachment[] {
  if (!value || typeof value !== "object" || !("content" in value)) return []
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const staged: StagedRunAttachment[] = []
  for (const candidate of content) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      (candidate as { type?: unknown }).type === "text"
    )
      continue
    const part = candidate as Record<string, unknown>
    const type = part.type === "image" ? "image" : "file"
    const source = part.source
    if (
      !source ||
      typeof source !== "object" ||
      (source as { type?: unknown }).type !== "data"
    )
      throw new Error("Invalid AOS attachment")
    const sourceRecord = source as Record<string, unknown>
    const mimeType = sourceRecord.mimeType
    const data = sourceRecord.value
    const metadata = part.metadata
    const filename =
      metadata &&
      typeof metadata === "object" &&
      typeof (metadata as { filename?: unknown }).filename === "string"
        ? String((metadata as { filename: string }).filename)
        : undefined
    if (typeof data !== "string" || typeof mimeType !== "string")
      throw new Error("Invalid AOS attachment")
    const dataUrl = `data:${mimeType};base64,${data}`
    staged.push({ type, dataUrl, ...(filename ? { filename } : {}), mimeType })
  }
  return staged
}

function sseFrameBoundary(value: string) {
  const boundaries = ["\n\n", "\r\n\r\n", "\r\r"]
    .map((separator) => ({ index: value.indexOf(separator), separator }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index)
  return boundaries[0]
}

function sseEvent(frame: string) {
  const data = frame
    .split(/\r?\n|\r/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""))
    .join("\n")
  if (!data) return undefined
  try {
    const event: unknown = JSON.parse(data)
    return event && typeof event === "object"
      ? (event as { type?: unknown; code?: unknown })
      : undefined
  } catch {
    return undefined
  }
}

function sessionSignalEvent(value: unknown): AosSessionSignalEvent | undefined {
  const type =
    value && typeof value === "object" && "type" in value
      ? (value as { type?: unknown }).type
      : undefined
  const schema =
    type === "ACTIVITY_SNAPSHOT"
      ? ActivitySnapshotEventSchema
      : type === "ACTIVITY_DELTA"
        ? ActivityDeltaEventSchema
        : type === "RUN_STARTED"
          ? RunStartedEventSchema
          : type === "CUSTOM"
            ? CustomEventSchema
            : type === "RUN_FINISHED"
              ? RunFinishedEventSchema
              : type === "RUN_ERROR"
                ? RunErrorEventSchema
                : type === "STEP_STARTED"
                  ? StepStartedEventSchema
                  : type === "STEP_FINISHED"
                    ? StepFinishedEventSchema
                    : undefined
  if (!schema) return undefined
  const result = schema.safeParse(value)
  return result.success ? (result.data as AosSessionSignalEvent) : undefined
}

function ssePosition(frame: string) {
  const id = frame
    .split(/\r?\n|\r/u)
    .find((line) => line.startsWith("id:"))
    ?.slice(3)
    .trim()
  if (!id || !/^\d+$/u.test(id)) return undefined
  const position = Number(id)
  return Number.isSafeInteger(position) ? position : undefined
}

async function* reconnectingSse(
  initial: Response,
  reconnect: (after?: number) => Promise<Response>,
  signal: AbortSignal | null | undefined,
  onRunFinished?: (event: RunFinishedEvent) => Promise<void>,
  onEvent?: (event: AosSessionSignalEvent) => void
) {
  let response = initial
  let reconnected = false
  let terminal = false
  let after: number | undefined
  while (true) {
    if (!response.ok || !response.body)
      throw new Error(`AOS run request failed (${response.status})`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let buffered = ""
    let interrupted = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffered += decoder.decode(value, { stream: !done })
        while (true) {
          const boundary = sseFrameBoundary(buffered)
          if (!boundary) break
          const frame = buffered.slice(0, boundary.index)
          buffered = buffered.slice(boundary.index + boundary.separator.length)
          const event = sseEvent(frame)
          const position = ssePosition(frame)
          if (position !== undefined) after = position
          if (
            event?.type === "RUN_ERROR" &&
            event.code === "AOS_CONNECTION_INTERRUPTED" &&
            !signal?.aborted
          ) {
            interrupted = true
            break
          }
          if (reconnected && event?.type === "RUN_STARTED") continue
          const signalEvent = sessionSignalEvent(event)
          if (signalEvent) onEvent?.(signalEvent)
          terminal =
            event?.type === "RUN_FINISHED" || event?.type === "RUN_ERROR"
          if (event?.type === "RUN_FINISHED" && onRunFinished)
            await onRunFinished(event as RunFinishedEvent).catch(
              () => undefined
            )
          yield new TextEncoder().encode(`${frame}${boundary.separator}`)
        }
        if (interrupted || done) break
      }
    } catch (error) {
      if (signal?.aborted) throw error
      interrupted = true
    } finally {
      if (interrupted) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    if (terminal || signal?.aborted) {
      if (buffered) yield new TextEncoder().encode(buffered)
      return
    }
    reconnected = true
    response = await reconnect(after)
  }
}

function reconnectingResponse(
  initial: Response,
  reconnect: (after?: number) => Promise<Response>,
  signal: AbortSignal | null | undefined,
  onRunFinished?: (event: RunFinishedEvent) => Promise<void>,
  onEvent?: (event: AosSessionSignalEvent) => void
) {
  if (!initial.ok || !initial.body) return initial
  const events = reconnectingSse(
    initial,
    reconnect,
    signal,
    onRunFinished,
    onEvent
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel() {
        await events.return(undefined)
      },
    }),
    { status: initial.status, headers: initial.headers }
  )
}

export function createAosRunAgent({
  agentId,
  threadId,
  fetcher = globalThis.fetch.bind(globalThis),
  stageAttachments,
  basePath = "/api/aos/v1",
  authorization,
  resolveRewindSourceId,
  onRewindCompleted,
  onRunFinished,
  onEvent,
  getCapabilities,
}: {
  agentId: string
  threadId: string
  fetcher?: typeof fetch
  stageAttachments?: (
    threadId: string,
    attachments: readonly StagedRunAttachment[]
  ) => Promise<{ stageId: string }>
  basePath?: string
  authorization?: string
  resolveRewindSourceId?: (
    sourceId: string,
    replacement: RewindReplacement,
    sourceText?: string
  ) => string | undefined | Promise<string | undefined>
  onRewindCompleted?: (replacement: RewindReplacement) => Promise<void>
  onRunFinished?: (event: RunFinishedEvent) => Promise<void>
  onEvent?: (event: AosSessionSignalEvent) => void
  getCapabilities?: () => Promise<AgentCapabilities>
}) {
  const url = `${basePath}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/runs`
  const runFetch: HttpAgentFetchFn = async (requestUrl, init) => {
    if (requestUrl !== url || typeof init.body !== "string")
      throw new Error("Invalid AOS run request")
    let candidate: unknown
    try {
      candidate = JSON.parse(init.body) as unknown
    } catch {
      throw new Error("Invalid AOS run request")
    }
    const input = RunAgentInputSchema.parse(candidate)
    const resume = input.resume?.length ? input.resume : undefined
    const message = input.messages.at(-1)
    if (!resume && (!message || message.role !== "user"))
      throw new Error("AOS runs require a trailing user turn")
    const staged = attachmentsForStage(!resume ? message : undefined)
    const stage = staged.length
      ? await stageAttachments?.(threadId, staged)
      : undefined
    if (staged.length && !stage)
      throw new Error("AOS attachment staging is unavailable")
    const messageWithoutAttachments = message
      ? {
          ...(message as Record<string, unknown>),
          ...(staged.length ? { content: messageText(message.content) } : {}),
        }
      : undefined
    const forwardedProps =
      candidate && typeof candidate === "object"
        ? (candidate as { forwardedProps?: unknown }).forwardedProps
        : undefined
    const runConfig =
      forwardedProps && typeof forwardedProps === "object"
        ? (forwardedProps as { runConfig?: unknown }).runConfig
        : undefined
    const requestedRewindSourceId =
      !resume && runConfig && typeof runConfig === "object"
        ? (runConfig as Record<string, unknown>)["aos.rewindSourceId"]
        : undefined
    const requestedRewindSourceText =
      !resume && runConfig && typeof runConfig === "object"
        ? (runConfig as Record<string, unknown>)["aos.rewindSourceText"]
        : undefined
    const rewindReplacement =
      typeof requestedRewindSourceId === "string" && message
        ? {
            localMessageId: message.id,
            text: messageText(message.content),
          }
        : undefined
    const rewindSourceId = rewindReplacement
      ? resolveRewindSourceId
        ? await resolveRewindSourceId(
            requestedRewindSourceId as string,
            rewindReplacement,
            typeof requestedRewindSourceText === "string"
              ? requestedRewindSourceText
              : undefined
          )
        : requestedRewindSourceId
      : undefined
    const headers = new Headers(init.headers)
    if (authorization) headers.set("authorization", authorization)
    const request = {
      ...init,
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        threadId: input.threadId,
        runId: input.runId,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        state: {},
        messages: resume
          ? []
          : messageWithoutAttachments
            ? [messageWithoutAttachments]
            : [],
        tools: [],
        context: [],
        forwardedProps: resume
          ? {}
          : {
              ...(typeof rewindSourceId === "string"
                ? { "aos.rewindSourceId": rewindSourceId }
                : {}),
              ...(stage ? { aosAttachmentStageId: stage.stageId } : {}),
            },
        ...(resume ? { resume } : {}),
      }),
    } satisfies RequestInit
    const response = await friendlyErrorResponse(await fetcher(url, request))
    const reconnectUrl = `${url}/reconnect`
    return reconnectingResponse(
      response,
      async (after) =>
        friendlyErrorResponse(
          await fetcher(reconnectUrl, {
            ...request,
            body: JSON.stringify({
              threadId: input.threadId,
              runId: input.runId,
              ...(after === undefined ? {} : { after }),
            }),
          })
        ),
      init.signal,
      typeof rewindSourceId === "string" && rewindReplacement
        ? async (event) => {
            if (event.outcome?.type === "success")
              await onRewindCompleted?.(rewindReplacement)
            await onRunFinished?.(event)
          }
        : onRunFinished,
      onEvent
    )
  }
  const agent = new HttpAgent({
    url,
    agentId,
    threadId,
    fetch: runFetch,
  })
  if (getCapabilities) agent.getCapabilities = getCapabilities
  return agent
}

export class AosRemoteClient implements WorkspaceAdapter {
  readonly #fetch: typeof fetch
  readonly #basePath: string
  readonly #authorization?: string
  readonly #scope?: AosEventScope
  readonly #reconciler?: AosRemoteClientOptions["reconciler"]
  readonly #revisions = new Map<string, string>()
  readonly #sessions = new Map<string, Session>()
  readonly #sessionStatuses = new Map<string, Session["status"]>()
  readonly #sessionOwners = new Map<string, string>()
  readonly #rewindReplacements = new Map<
    string,
    Map<string, RewindReplacement & { durableMessageId?: string }>
  >()
  readonly #capabilities = new Map<string, Promise<AosWorkspaceCapabilities>>()
  readonly #plans = new Map<string, { messageId: string; todos: TodoItem[] }>()
  readonly #steeringReconciliations = new Set<string>()
  readonly #todoListeners = new Map<string, Set<(todos: TodoItem[]) => void>>()
  readonly #metadataSubscriptions = new Set<SessionMetadataSubscription>()
  readonly #activityListeners = new Set<
    (event: WorkspaceActivityEvent) => void
  >()
  readonly #runIds = new Map<string, string>()

  constructor(options: AosRemoteClientOptions = {}) {
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#basePath = options.basePath ?? "/api/aos/v1"
    this.#authorization = options.authorization
    this.#scope = options.scope
    this.#reconciler = options.reconciler
    if (options.scope)
      this.#sessionOwners.set(options.scope.sessionId, options.scope.agentId)
  }

  async #read<T>(
    path: string,
    schema: Schema<T>,
    init?: RequestInit,
    scope?: AosEventScope
  ): Promise<T> {
    const operation = () => this.#readDirect(path, schema, init)
    return scope && this.#reconciler
      ? this.#reconciler.read(scope, operation)
      : operation()
  }

  async #readDirect<T>(
    path: string,
    schema: Schema<T>,
    init?: RequestInit
  ): Promise<T> {
    let response: Response
    try {
      const headers = new Headers(init?.headers)
      headers.set("accept", "application/json")
      if (this.#authorization) headers.set("authorization", this.#authorization)
      response = await this.#fetch(`${this.#basePath}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      })
    } catch {
      throw new AosClientError("connection-interrupted")
    }
    if (!response.ok) {
      const error = await normalizedError(response)
      throw new AosClientError(
        response.status === 503 ? "provider-unavailable" : "proxy-failure",
        error?.description,
        error?.code
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success)
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    return parsed.data
  }

  runtimeInfo(signal?: AbortSignal) {
    return this.#read("/runtime", RuntimeInfoSchema, { signal })
  }

  async #catalog(signal?: AbortSignal) {
    const catalog = await this.#read("/agents", AgentCatalogResponseSchema, {
      signal,
    })
    this.#revisions.clear()
    for (const entry of catalog.agents)
      this.#revisions.set(entry.summary.id, entry.revision)
    return catalog
  }

  async listAgents() {
    return (await this.#catalog()).agents.map(({ summary }) =>
      structuredClone(summary)
    )
  }

  refreshAgents() {
    return this.listAgents()
  }

  async listAgentCatalog(signal?: AbortSignal): Promise<AgentCatalogEntry[]> {
    return (await this.#catalog(signal)).agents.map(
      ({ summary, visibility, selectable, editable }) =>
        structuredClone({ summary, visibility, selectable, editable })
    )
  }

  async updateAgentVisibility(agentId: string, visibility: AgentVisibility) {
    const revision = this.#revisions.get(agentId)
    if (!revision || revision === "unavailable")
      throw new Error("Agent visibility requires a fresh catalog revision")
    const result = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/visibility`,
      VisibilityUpdateResponseSchema,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility, revision }),
      }
    )
    this.#revisions.set(agentId, result.agent.revision)
  }

  async listSessions(agentId: string, limit = 50, offset = 0) {
    const page = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions?limit=${limit}&offset=${offset}`,
      SessionCatalogResponseSchema,
      undefined
    )
    if (page.sessions.some((session) => session.agentId !== agentId))
      throw new Error("Invalid AOS proxy response")
    for (const session of page.sessions) this.#rememberSession(session)
    return page
  }

  async listSessionCatalog(limit = 50, offset = 0, signal?: AbortSignal) {
    const page = await this.#read(
      `/sessions?limit=${limit}&offset=${offset}`,
      SessionCatalogResponseSchema,
      { signal }
    )
    for (const session of page.sessions) this.#rememberSession(session)
    return page
  }

  async getSession(threadId: string) {
    const agentId = this.#owner(threadId)
    const session = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      SessionSchema,
      undefined,
      this.#eventScope(agentId, threadId)
    )
    if (session.id !== threadId || session.agentId !== agentId)
      throw new Error("Invalid AOS proxy response")
    this.#rememberSession(session)
    return session
  }

  async getSessionMetadata(threadIds: string[]) {
    const sessions = await Promise.all(
      threadIds.map(async (threadId) => {
        const cached = this.#sessions.get(threadId)
        if (cached) return cached
        return this.#sessionOwners.has(threadId)
          ? this.getSession(threadId)
          : undefined
      })
    )
    return sessions.flatMap((session) => {
      return session
        ? [
            {
              threadId: session.id,
              agentId: session.agentId,
              updatedAt: session.updatedAt,
              status: session.status,
            },
          ]
        : []
    })
  }

  subscribeSessionMetadata(
    threadIds: readonly string[],
    listener: SessionMetadataSubscription["listener"]
  ) {
    const subscription = { threadIds: new Set(threadIds), listener }
    this.#metadataSubscriptions.add(subscription)
    queueMicrotask(() => {
      if (this.#metadataSubscriptions.has(subscription))
        listener(this.#metadataFor(subscription.threadIds))
    })
    return () => this.#metadataSubscriptions.delete(subscription)
  }

  subscribeActivity(listener: (event: WorkspaceActivityEvent) => void) {
    this.#activityListeners.add(listener)
    return () => this.#activityListeners.delete(listener)
  }

  sessionStatus(threadId: string): SessionStatus {
    return this.#sessionStatuses.get(threadId) ?? "unknown"
  }

  subscribeSessionStatus(threadId: string, listener: () => void) {
    const subscription: SessionMetadataSubscription = {
      threadIds: new Set([threadId]),
      listener: () => listener(),
    }
    this.#metadataSubscriptions.add(subscription)
    return () => this.#metadataSubscriptions.delete(subscription)
  }

  acceptRunEvent(threadId: string, event: AosSessionSignalEvent) {
    if (!this.#sessionOwners.has(threadId)) return
    if (
      event.type === "CUSTOM" &&
      event.name === "aos.steer.accepted" &&
      event.value &&
      typeof event.value === "object" &&
      typeof (event.value as { requestId?: unknown }).requestId === "string" &&
      typeof (event.value as { text?: unknown }).text === "string" &&
      ((event.value as { delivery?: unknown }).delivery === "steered" ||
        (event.value as { delivery?: unknown }).delivery === "queued")
    ) {
      this.#steeringReconciliations.add(threadId)
      return
    }
    if (
      (event.type === "RUN_STARTED" || event.type === "RUN_FINISHED") &&
      event.threadId !== threadId
    )
      return
    if (event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "PLAN") {
      const parsed = SessionTodosResponseSchema.safeParse(event.content)
      if (parsed.success)
        this.#setPlan(threadId, event.messageId, parsed.data.todos)
      return
    }
    if (event.type === "ACTIVITY_DELTA" && event.activityType === "PLAN") {
      const current = this.#plans.get(threadId)
      if (!current || current.messageId !== event.messageId) return
      let todos = current.todos
      for (const operation of event.patch) {
        if (
          !operation ||
          typeof operation !== "object" ||
          !("op" in operation) ||
          !("path" in operation) ||
          operation.op !== "replace" ||
          operation.path !== "/todos" ||
          !("value" in operation)
        )
          return
        const parsed = SessionTodosResponseSchema.safeParse({
          todos: operation.value,
        })
        if (!parsed.success) return
        todos = parsed.data.todos
      }
      this.#setPlan(threadId, event.messageId, todos)
      return
    }

    const runId =
      event.type === "RUN_STARTED" || event.type === "RUN_FINISHED"
        ? event.runId
        : this.#runIds.get(threadId)
    const occurredAt = new Date(
      typeof event.timestamp === "number" ? event.timestamp : Date.now()
    ).toISOString()
    const session = this.#sessions.get(threadId)
    const agentId = session?.agentId ?? this.#sessionOwners.get(threadId)
    if (!agentId) return
    if (event.type === "RUN_STARTED") {
      this.#runIds.set(threadId, event.runId)
      this.#setSessionStatus(threadId, "running")
      this.#emitActivity({
        id: `${threadId}:${event.runId}:started`,
        type: "run-started",
        lifecycleId: event.runId,
        agentId,
        threadId,
        occurredAt,
      })
    } else if (event.type === "RUN_FINISHED") {
      const outcome = event.outcome
      const waiting = outcome?.type === "interrupt"
      this.#setSessionStatus(threadId, waiting ? "waiting-for-input" : "idle")
      if (outcome?.type === "interrupt")
        for (const interrupt of outcome.interrupts)
          this.#emitActivity({
            id: `${threadId}:${interrupt.id}:attention`,
            type: "attention-requested",
            attentionKind:
              interrupt.reason === "confirmation" ? "permission" : "question",
            requestId: interrupt.id,
            agentId,
            threadId,
            occurredAt,
          })
      else if (runId)
        this.#emitActivity({
          id: `${threadId}:${runId}:finished`,
          type: "run-finished",
          lifecycleId: runId,
          agentId,
          threadId,
          occurredAt,
        })
      this.#runIds.delete(threadId)
    } else if (event.type === "RUN_ERROR") {
      this.#setSessionStatus(threadId, "failed")
      if (runId)
        this.#emitActivity({
          id: `${threadId}:${runId}:failed`,
          type: "run-failed",
          lifecycleId: runId,
          agentId,
          threadId,
          occurredAt,
        })
      this.#runIds.delete(threadId)
    }
  }

  /** Rehydrates immutable ownership from normalized Assistant UI thread metadata. */
  adoptSessionOwnership(threadId: string, agentId: string) {
    if (!threadId || !agentId)
      throw new Error("Invalid Session ownership metadata")
    const current = this.#sessionOwners.get(threadId)
    if (current && current !== agentId)
      throw new Error("Conflicting Session ownership metadata")
    this.#sessionOwners.set(threadId, agentId)
  }

  async createSession(
    agentId: string,
    options?: { title: string }
  ): Promise<{ threadId: string }> {
    const result = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions`,
      SessionCreateResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options ? { title: options.title } : {}),
      }
    )
    if (result.session.agentId !== agentId)
      throw new Error("Invalid AOS proxy response")
    this.#sessionOwners.set(result.session.id, agentId)
    this.#sessionStatuses.set(result.session.id, "idle")
    return { threadId: result.session.id }
  }

  async loadHistory(threadId: string): Promise<AosLoadedHistory> {
    const agentId = this.#owner(threadId)
    const messages: SessionMessage[] = []
    const seen = new Set<string>()
    const page = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/history?limit=200&offset=0`,
      SessionHistoryResponseSchema,
      undefined,
      this.#eventScope(agentId, threadId)
    )
    if (
      page.sessionId !== threadId ||
      page.offset !== 0 ||
      page.nextOffset < 0 ||
      (page.nextOffset === 0 && page.nextOffset < page.total)
    )
      throw new Error("Invalid AOS proxy response")
    for (const message of page.messages) {
      if (message.role === "activity") {
        this.#setPlan(threadId, message.id, message.content.todos)
        continue
      }
      if (seen.has(message.id)) throw new Error("Invalid AOS proxy response")
      seen.add(message.id)
      messages.push(message)
    }
    if (page.execution) {
      this.#setSessionStatus(threadId, page.execution.status)
      if (page.execution.status === "running" && page.execution.runId)
        this.#runIds.set(threadId, page.execution.runId)
      else this.#runIds.delete(threadId)
    } else this.#runIds.delete(threadId)
    return {
      sessionId: threadId,
      messages,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      nextOffset: page.nextOffset,
      ...(page.execution ? { execution: page.execution } : {}),
    }
  }

  async resolveRewindSourceId(
    threadId: string,
    sourceId: string,
    replacement: RewindReplacement,
    sourceText?: string
  ) {
    this.#owner(threadId)
    const previous = this.#rewindReplacements.get(threadId)?.get(sourceId)
    if (previous) await this.reconcileRewindReplacement(threadId, previous)
    let durableSourceId: string | undefined =
      this.#rewindReplacements.get(threadId)?.get(sourceId)?.durableMessageId ??
      sourceId
    if (!previous && sourceText !== undefined) {
      const history = await this.loadHistory(threadId)
      const users = history.messages.filter(
        (message) => message.role === "user"
      )
      const durable =
        users.find((message) => message.id === sourceId) ??
        (messageText(users.at(-1)?.content).trim() === sourceText.trim()
          ? users.at(-1)
          : undefined)
      durableSourceId = durable?.id
      if (durable)
        this.#rememberRewindReplacement(threadId, {
          localMessageId: sourceId,
          text: sourceText,
          durableMessageId: durable.id,
        })
    }
    this.#rememberRewindReplacement(threadId, replacement)
    return durableSourceId
  }

  async reconcileRewindReplacement(
    threadId: string,
    replacement: RewindReplacement
  ) {
    const history = await this.loadHistory(threadId)
    const replacements = this.#rewindReplacements.get(threadId)
    const current = replacements?.get(replacement.localMessageId)
    if (!current || current.text !== replacement.text) return history
    const users = history.messages.filter((message) => message.role === "user")
    const durable =
      users.find((message) => message.id === current.durableMessageId) ??
      users.findLast(
        (message) =>
          messageText(message.content).trim() === replacement.text.trim()
      )
    replacements!.set(
      replacement.localMessageId,
      durable
        ? { ...replacement, durableMessageId: durable.id }
        : { ...replacement }
    )
    return history
  }

  #rememberRewindReplacement(
    threadId: string,
    replacement: RewindReplacement & { durableMessageId?: string }
  ) {
    let replacements = this.#rewindReplacements.get(threadId)
    if (!replacements) {
      replacements = new Map()
      this.#rewindReplacements.set(threadId, replacements)
    }
    replacements.delete(replacement.localMessageId)
    replacements.set(replacement.localMessageId, replacement)
    if (replacements.size <= MAX_REWIND_REPLACEMENTS_PER_SESSION) return
    const oldest = replacements.keys().next().value
    if (oldest !== undefined) replacements.delete(oldest)
  }

  renameSession(threadId: string, title: string) {
    return this.#patchSession(threadId, { title })
  }

  archiveSession(threadId: string) {
    return this.#patchSession(threadId, { archived: true })
  }

  unarchiveSession(threadId: string) {
    return this.#patchSession(threadId, { archived: false })
  }

  async deleteSession(threadId: string) {
    const agentId = this.#owner(threadId)
    await this.#writeVoid(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      { method: "DELETE" }
    )
    this.#sessions.delete(threadId)
    this.#sessionStatuses.delete(threadId)
    this.#sessionOwners.delete(threadId)
    this.#rewindReplacements.delete(threadId)
    this.#capabilities.delete(threadId)
    this.#plans.delete(threadId)
    this.#runIds.delete(threadId)
    this.#steeringReconciliations.delete(threadId)
  }

  async stopRun(threadId: string) {
    const agentId = this.#owner(threadId)
    const result = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/runs/stop`,
      RunStopResponseSchema,
      { method: "POST" }
    )
    this.#setSessionStatus(
      threadId,
      result.status === "stopping" ? "running" : "idle"
    )
    return result
  }

  async steerRun(
    threadId: string,
    request: { requestId: string; text: string }
  ) {
    const agentId = this.#owner(threadId)
    const expectedRunId = this.#runIds.get(threadId)
    if (!expectedRunId)
      throw new AosClientError(
        "proxy-failure",
        "The active run changed.",
        "run_conflict"
      )
    const body = RunSteerRequestSchema.parse({ ...request, expectedRunId })
    const response = await this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/runs/steer`,
      RunSteerResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    )
    this.#steeringReconciliations.add(threadId)
    return response
  }

  needsSteeringReconciliation(threadId: string) {
    return this.#steeringReconciliations.has(threadId)
  }

  completeSteeringReconciliation(threadId: string) {
    this.#steeringReconciliations.delete(threadId)
  }

  workspaceCapabilities(threadId: string) {
    this.#owner(threadId)
    const cached = this.#capabilities.get(threadId)
    if (cached) return cached
    const request = this.#sessionRead(
      threadId,
      "/workspace/capabilities",
      SessionWorkspaceCapabilitiesResponseSchema as unknown as Schema<AosWorkspaceCapabilities>
    ).catch((error) => {
      this.#capabilities.delete(threadId)
      throw error
    })
    this.#capabilities.set(threadId, request)
    return request
  }

  models(threadId: string) {
    return this.#sessionRead(
      threadId,
      "/workspace/models",
      SessionModelsResponseSchema
    )
  }

  async selectModel(threadId: string, selectedId: string) {
    const result = await this.#sessionRead(
      threadId,
      "/workspace/models/select",
      SessionModelSelectRequestSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectedId }),
      }
    )
    if (result.selectedId !== selectedId)
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    return result
  }

  context(threadId: string) {
    return this.#sessionRead(
      threadId,
      "/workspace/context",
      SessionContextResponseSchema
    )
  }

  subscribeTodos(
    threadId: string,
    listener: (todos: TodoItem[]) => void,
    onError?: (error: Error) => void
  ) {
    void onError
    if (!this.#sessionOwners.has(threadId)) return () => {}
    const listeners = this.#todoListeners.get(threadId) ?? new Set()
    listeners.add(listener)
    this.#todoListeners.set(threadId, listeners)
    queueMicrotask(() => {
      if (listeners.has(listener))
        listener(structuredClone(this.#plans.get(threadId)?.todos ?? []))
    })
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#todoListeners.delete(threadId)
    }
  }

  subscribeSessionInvalidation(threadId: string, listener: () => void) {
    if (!this.#sessionOwners.has(threadId)) return () => {}
    const { scope } = this.#sessionPath(threadId, "")
    return this.#reconciler?.subscribe?.(scope, listener) ?? (() => {})
  }

  async *reconnectRun(
    threadId: string,
    runId: string,
    signal?: AbortSignal
  ): AsyncGenerator<AGUIEvent> {
    const agentId = this.#owner(threadId)
    const url = `${this.#basePath}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/runs/reconnect`
    const agent = new HttpAgent({
      url,
      agentId,
      threadId,
      fetch: async (_url, init) => {
        const reconnect = async (after?: number) => {
          const headers = new Headers(init.headers)
          headers.set("content-type", "application/json")
          if (this.#authorization)
            headers.set("authorization", this.#authorization)
          return friendlyErrorResponse(
            await this.#fetch(url, {
              ...init,
              signal,
              credentials: "same-origin",
              headers,
              body: JSON.stringify({
                threadId,
                runId,
                ...(after === undefined ? {} : { after }),
              }),
            })
          )
        }
        return reconnectingResponse(await reconnect(), reconnect, signal)
      },
    })
    const events: AGUIEvent[] = []
    let wake: (() => void) | undefined
    let complete = false
    let failure: unknown
    const subscription = agent
      .run({
        threadId,
        runId,
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (event) => {
          const normalized = event as AGUIEvent
          this.acceptRunEvent(threadId, normalized)
          events.push(normalized)
          wake?.()
          wake = undefined
        },
        error: (error) => {
          failure = error
          complete = true
          wake?.()
          wake = undefined
        },
        complete: () => {
          complete = true
          wake?.()
          wake = undefined
        },
      })
    try {
      while (!complete || events.length) {
        if (!events.length)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        while (events.length) yield events.shift()!
      }
      if (failure) throw failure
    } finally {
      subscription.unsubscribe()
    }
  }

  async stageAttachments(
    threadId: string,
    attachments: readonly StagedRunAttachment[]
  ) {
    const request = SessionAttachmentStageRequestSchema.safeParse({
      attachments: attachments.map(({ dataUrl, filename, mimeType, type }) =>
        type === "image"
          ? { type, dataUrl, ...(filename ? { filename } : {}) }
          : {
              type,
              dataUrl,
              ...(filename ? { filename } : {}),
              ...(mimeType ? { mimeType } : {}),
            }
      ),
    })
    if (!request.success)
      throw new AosClientError(
        "proxy-failure",
        "Invalid attachment staging request"
      )
    return this.#sessionRead(
      threadId,
      "/attachments/stage",
      SessionAttachmentStageResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      }
    )
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
    signal?: AbortSignal
  ) {
    if (!artifactId.trim() || artifactId.length > 512)
      throw new AosClientError("proxy-failure", "Invalid artifact reference")
    const { path, scope } = this.#sessionPath(
      threadId,
      `/artifacts/${encodeURIComponent(artifactId)}`
    )
    return this.#readBlob(path, { signal }, scope)
  }

  async transcribe(threadId: string, audio: Blob, signal?: AbortSignal) {
    if (!audio.size || !audio.type)
      throw new AosClientError("proxy-failure", "Invalid audio recording")
    const request = SessionTranscriptionRequestSchema.safeParse({
      dataUrl: await dataUrl(audio),
      mimeType: audio.type,
    })
    if (!request.success)
      throw new AosClientError("proxy-failure", "Invalid audio recording")
    const agentId = this.#owner(threadId)
    const path = `/agents/${encodeURIComponent(agentId)}/audio/transcribe`
    const scope = this.#eventScope(agentId, threadId)
    const response = await this.#read(
      path,
      SessionTranscriptionResponseSchema,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      },
      scope
    )
    return response.transcript
  }

  async speak(threadId: string, text: string, signal?: AbortSignal) {
    const request = SessionSpeechRequestSchema.safeParse({ text })
    if (!request.success)
      throw new AosClientError("proxy-failure", "Invalid speech input")
    const agentId = this.#owner(threadId)
    const path = `/agents/${encodeURIComponent(agentId)}/audio/speak`
    const scope = this.#eventScope(agentId, threadId)
    return this.#readBlob(
      path,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      },
      scope
    )
  }

  async #patchSession(
    threadId: string,
    patch: { title: string } | { archived: boolean }
  ) {
    const agentId = this.#owner(threadId)
    await this.#writeVoid(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }
    )
    const current = this.#sessions.get(threadId)
    if (current) this.#sessions.set(threadId, { ...current, ...patch })
  }

  async #writeVoid(path: string, init: RequestInit) {
    let response: Response
    try {
      const headers = new Headers(init.headers)
      headers.set("accept", "application/json")
      if (this.#authorization) headers.set("authorization", this.#authorization)
      response = await this.#fetch(`${this.#basePath}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      })
    } catch {
      throw new Error("AOS proxy request failed")
    }
    if (!response.ok) {
      const error = await normalizedError(response)
      throw new AosClientError(
        response.status === 503 ? "provider-unavailable" : "proxy-failure",
        error?.description
      )
    }
  }

  #sessionPath(threadId: string, suffix: string) {
    const agentId = this.#owner(threadId)
    return {
      path: `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}${suffix}`,
      scope: this.#eventScope(agentId, threadId),
    }
  }

  #eventScope(agentId: string, sessionId: string): AosEventScope {
    return {
      workspaceId: this.#scope?.workspaceId ?? "operator",
      agentId,
      sessionId,
    }
  }

  #sessionRead<T>(
    threadId: string,
    suffix: string,
    schema: Schema<T>,
    init?: RequestInit
  ) {
    const { path, scope } = this.#sessionPath(threadId, suffix)
    return this.#read(path, schema, init, scope)
  }

  async #readBlob(path: string, init?: RequestInit, scope?: AosEventScope) {
    const operation = async () => {
      let response: Response
      try {
        const headers = new Headers(init?.headers)
        headers.set("accept", "application/octet-stream")
        if (this.#authorization)
          headers.set("authorization", this.#authorization)
        response = await this.#fetch(`${this.#basePath}${path}`, {
          ...init,
          credentials: "same-origin",
          headers,
        })
      } catch {
        throw new AosClientError("connection-interrupted")
      }
      if (!response.ok) {
        const error = await normalizedError(response)
        throw new AosClientError(
          response.status === 503 ? "provider-unavailable" : "proxy-failure",
          error?.description
        )
      }
      const contentType = response.headers.get("content-type")
      if (!contentType || /[\r\n]/u.test(contentType))
        throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
      try {
        return await response.blob()
      } catch {
        throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
      }
    }
    return scope && this.#reconciler
      ? this.#reconciler.read(scope, operation)
      : operation()
  }

  #rememberSession(session: Session) {
    const status = this.#sessionStatuses.get(session.id) ?? session.status
    this.#sessions.set(session.id, structuredClone({ ...session, status }))
    this.#sessionStatuses.set(session.id, status)
    this.#sessionOwners.set(session.id, session.agentId)
    this.#notifySessionMetadata(session.id)
  }

  #metadataFor(threadIds: ReadonlySet<string>) {
    return [...threadIds].flatMap((threadId) => {
      const session = this.#sessions.get(threadId)
      return session
        ? [
            {
              threadId: session.id,
              agentId: session.agentId,
              updatedAt: session.updatedAt,
              status: session.status,
            },
          ]
        : []
    })
  }

  #notifySessionMetadata(threadId: string) {
    for (const subscription of this.#metadataSubscriptions)
      if (subscription.threadIds.has(threadId))
        subscription.listener(this.#metadataFor(subscription.threadIds))
  }

  #setSessionStatus(threadId: string, status: SessionStatus) {
    this.#sessionStatuses.set(threadId, status)
    const current = this.#sessions.get(threadId)
    if (!current || current.status === status) return
    this.#sessions.set(threadId, {
      ...current,
      status,
    })
    this.#notifySessionMetadata(threadId)
  }

  #setPlan(threadId: string, messageId: string, todos: TodoItem[]) {
    const next = structuredClone(todos)
    this.#plans.set(threadId, { messageId, todos: next })
    for (const listener of this.#todoListeners.get(threadId) ?? [])
      listener(structuredClone(next))
  }

  #emitActivity(event: WorkspaceActivityEvent) {
    for (const listener of this.#activityListeners)
      listener(structuredClone(event))
  }

  #owner(threadId: string) {
    const owner = this.#sessionOwners.get(threadId)
    if (!owner) throw new Error("Session ownership is unknown")
    return owner
  }
}
