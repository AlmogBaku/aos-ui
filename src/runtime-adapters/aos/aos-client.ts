import { z } from "zod"
import {
  HttpAgent,
  RunAgentInputSchema,
  type HttpAgentFetchFn,
} from "@ag-ui/client"
import type { AGUIEvent } from "@ag-ui/core"

import {
  AgentCatalogResponseSchema,
  ErrorResponseSchema,
  OperatorAuthStateSchema,
  RuntimeAuthStateSchema,
  RuntimeInfoSchema,
  RunStopResponseSchema,
  SessionActivityResponseSchema,
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionAudioResponseSchema,
  SessionCatalogResponseSchema,
  SessionContextResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionInteractionSnapshotResponseSchema,
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
import type { Session, SessionHistoryResponse } from "@aos/protocol"
import type {
  AgentCatalogEntry,
  AgentVisibility,
  TodoItem,
  WorkspaceAdapter,
} from "../contracts"
import type { AosEventScope } from "./aos-reconciliation"

type Schema<T> = Pick<z.ZodType<T>, "safeParse">

const InteractionResponseSchema = z.strictObject({
  status: z.enum(["resolved", "expired", "already-resolved"]),
})
export type AosWorkspaceCapabilities = z.infer<
  typeof SessionWorkspaceCapabilitiesResponseSchema
>
export type AosModelChoices = z.infer<typeof SessionModelsResponseSchema>
export type AosContext = z.infer<typeof SessionContextResponseSchema>
export type AosSessionActivity = z.infer<typeof SessionActivityResponseSchema>
export type AosStagedAttachment = z.infer<
  typeof SessionAttachmentStageResponseSchema
>
export type AosPendingInteraction = z.infer<
  typeof SessionInteractionSnapshotResponseSchema
>

async function dataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return `data:${blob.type};base64,${btoa(binary)}`
}

export type AosClientFailure =
  | "aos-auth-required"
  | "runtime-auth-required"
  | "connection-interrupted"
  | "provider-unavailable"
  | "proxy-failure"

export class AosClientError extends Error {
  constructor(
    readonly kind: AosClientFailure,
    message = "AOS proxy request failed"
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
  onAuthRequired?: (
    kind: "aos-auth-required" | "runtime-auth-required"
  ) => void
}

type StagedRunAttachment = {
  type: "image" | "file"
  dataUrl: string
  filename?: string
  mimeType: string
}

function attachmentsForStage(value: unknown): StagedRunAttachment[] {
  if (!value || typeof value !== "object" || !("attachments" in value))
    return []
  const attachments = (value as { attachments?: unknown }).attachments
  if (!Array.isArray(attachments)) return []
  const staged: StagedRunAttachment[] = []
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object")
      throw new Error("Invalid AOS attachment")
    const row = attachment as Record<string, unknown>
    if (!Array.isArray(row.content)) throw new Error("Invalid AOS attachment")
    const part = row.content.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        ((candidate as { type?: unknown }).type === "image" ||
          (candidate as { type?: unknown }).type === "file")
    )
    if (!part) throw new Error("Invalid AOS attachment")
    const type = part.type
    const dataUrl = type === "image" ? part.image : part.data
    const filename =
      typeof part.filename === "string"
        ? part.filename
        : typeof row.name === "string"
          ? row.name
          : undefined
    const mimeType =
      type === "file" && typeof part.mimeType === "string"
        ? part.mimeType
        : typeof row.contentType === "string"
          ? row.contentType
          : undefined
    if (
      (type !== "image" && type !== "file") ||
      typeof dataUrl !== "string" ||
      !mimeType
    )
      throw new Error("Invalid AOS attachment")
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

async function* reconnectingSse(
  initial: Response,
  reconnect: () => Promise<Response>,
  signal: AbortSignal | null | undefined
) {
  let response = initial
  let reconnected = false
  let terminal = false
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
          if (
            event?.type === "RUN_ERROR" &&
            event.code === "AOS_CONNECTION_INTERRUPTED" &&
            !reconnected
          ) {
            interrupted = true
            break
          }
          if (reconnected && event?.type === "RUN_STARTED") continue
          terminal =
            event?.type === "RUN_FINISHED" || event?.type === "RUN_ERROR"
          yield new TextEncoder().encode(`${frame}${boundary.separator}`)
        }
        if (interrupted || done) break
      }
    } catch (error) {
      if (reconnected || signal?.aborted) throw error
      interrupted = true
    } finally {
      if (interrupted) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    if (terminal || reconnected || signal?.aborted) {
      if (buffered) yield new TextEncoder().encode(buffered)
      return
    }
    reconnected = true
    response = await reconnect()
  }
}

function reconnectingResponse(
  initial: Response,
  reconnect: () => Promise<Response>,
  signal: AbortSignal | null | undefined
) {
  if (!initial.ok || !initial.body) return initial
  const events = reconnectingSse(initial, reconnect, signal)
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
    const message = input.messages.at(-1)
    if (!message || message.role !== "user")
      throw new Error("AOS runs require a trailing user turn")
    const rawMessages =
      candidate && typeof candidate === "object" && "messages" in candidate
        ? (candidate as { messages?: unknown }).messages
        : undefined
    const rawMessage = Array.isArray(rawMessages)
      ? rawMessages.at(-1)
      : undefined
    const staged = attachmentsForStage(rawMessage)
    const stage = staged.length
      ? await stageAttachments?.(threadId, staged)
      : undefined
    if (staged.length && !stage)
      throw new Error("AOS attachment staging is unavailable")
    const messageWithoutAttachments = {
      ...(message as Record<string, unknown>),
    }
    delete messageWithoutAttachments.attachments
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
        messages: [messageWithoutAttachments],
        tools: [],
        context: [],
        forwardedProps: stage ? { aosAttachmentStageId: stage.stageId } : {},
      }),
    } satisfies RequestInit
    const response = await fetcher(url, request)
    const reconnectUrl = `${url}/reconnect`
    return reconnectingResponse(
      response,
      () =>
        fetcher(reconnectUrl, {
          ...request,
          body: JSON.stringify({
            threadId: input.threadId,
            runId: input.runId,
          }),
        }),
      init.signal
    )
  }
  return new HttpAgent({
    url,
    agentId,
    threadId,
    fetch: runFetch,
  })
}

export class AosRemoteClient implements WorkspaceAdapter {
  readonly #fetch: typeof fetch
  readonly #basePath: string
  readonly #authorization?: string
  readonly #scope?: AosEventScope
  readonly #reconciler?: AosRemoteClientOptions["reconciler"]
  readonly #onAuthRequired?: AosRemoteClientOptions["onAuthRequired"]
  readonly #revisions = new Map<string, string>()
  readonly #sessions = new Map<string, Session>()
  readonly #sessionOwners = new Map<string, string>()

  constructor(options: AosRemoteClientOptions = {}) {
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#basePath = options.basePath ?? "/api/aos/v1"
    this.#authorization = options.authorization
    this.#scope = options.scope
    this.#reconciler = options.reconciler
    this.#onAuthRequired = options.onAuthRequired
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
      if (response.status === 401) {
        const error = ErrorResponseSchema.safeParse(
          await response.json().catch(() => undefined)
        )
        if (error.success) {
          const kind =
            error.data.error.code === "unauthenticated"
              ? "aos-auth-required"
              : error.data.error.code === "runtime_authentication_required"
                ? "runtime-auth-required"
                : undefined
          if (kind) {
            this.#onAuthRequired?.(kind)
            throw new AosClientError(kind)
          }
        }
      }
      throw new AosClientError(
        response.status === 503 ? "provider-unavailable" : "proxy-failure"
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

  operatorAuth(signal?: AbortSignal) {
    return this.#read("/auth/operator", OperatorAuthStateSchema, { signal })
  }

  runtimeAuth(signal?: AbortSignal) {
    return this.#read("/auth/runtime", RuntimeAuthStateSchema, { signal })
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
    return { threadId: result.session.id }
  }

  async loadHistory(threadId: string): Promise<SessionHistoryResponse> {
    const agentId = this.#owner(threadId)
    const messages: SessionHistoryResponse["messages"] = []
    const seen = new Set<string>()
    let offset = 0
    let total = 0
    do {
      const page = await this.#read(
        `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/history?limit=200&offset=${offset}`,
        SessionHistoryResponseSchema,
        undefined,
        this.#eventScope(agentId, threadId)
      )
      if (
        page.sessionId !== threadId ||
        page.offset !== offset ||
        page.nextOffset < offset ||
        (page.nextOffset === offset && page.nextOffset < page.total)
      )
        throw new Error("Invalid AOS proxy response")
      for (const message of page.messages) {
        if (seen.has(message.id)) throw new Error("Invalid AOS proxy response")
        seen.add(message.id)
        messages.push(message)
      }
      total = page.total
      offset = page.nextOffset
    } while (offset < total)
    return {
      sessionId: threadId,
      messages,
      total,
      limit: 200,
      offset: 0,
      nextOffset: offset,
    }
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
    this.#sessionOwners.delete(threadId)
  }

  stopRun(threadId: string) {
    const agentId = this.#owner(threadId)
    return this.#read(
      `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/runs/stop`,
      RunStopResponseSchema,
      { method: "POST" }
    )
  }

  workspaceCapabilities(threadId: string) {
    return this.#sessionRead(
      threadId,
      "/workspace/capabilities",
      SessionWorkspaceCapabilitiesResponseSchema
    )
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

  async todos(threadId: string) {
    return (
      await this.#sessionRead(
        threadId,
        "/workspace/todos",
        SessionTodosResponseSchema
      )
    ).todos
  }

  activity(threadId: string) {
    return this.#sessionRead(
      threadId,
      "/workspace/activity",
      SessionActivityResponseSchema
    )
  }

  subscribeTodos(
    threadId: string,
    listener: (todos: TodoItem[]) => void,
    onError?: (error: Error) => void
  ) {
    if (!this.#sessionOwners.has(threadId)) return () => {}
    const { scope } = this.#sessionPath(threadId, "")
    let active = true
    const refresh = () => {
      void this.todos(threadId).then(
        (todos) => active && listener(todos),
        (reason) =>
          active &&
          onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
      )
    }
    refresh()
    const unsubscribe = this.#reconciler?.subscribe?.(scope, refresh)
    return () => {
      active = false
      unsubscribe?.()
    }
  }

  subscribeSessionInvalidation(threadId: string, listener: () => void) {
    if (!this.#sessionOwners.has(threadId)) return () => {}
    const { scope } = this.#sessionPath(threadId, "")
    return this.#reconciler?.subscribe?.(scope, listener) ?? (() => {})
  }

  async respondToInteraction(
    threadId: string,
    runId: string,
    requestId: string,
    response: { kind: "question"; answers: string[][] } | { kind: "reject" }
  ) {
    if (
      !runId.trim() ||
      runId.length > 512 ||
      !requestId.trim() ||
      requestId.length > 512
    )
      throw new AosClientError("proxy-failure", "Invalid interaction request")
    const result = await this.#sessionRead(
      threadId,
      "/interactions/respond",
      InteractionResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, requestId, response }),
      }
    )
    if (result.status === "expired" || result.status === "already-resolved")
      throw new AosClientError(
        "proxy-failure",
        "Interaction is no longer pending"
      )
  }

  pendingInteraction(threadId: string, runId?: string) {
    if (runId !== undefined && (!runId.trim() || runId.length > 512))
      throw new AosClientError("proxy-failure", "Invalid interaction run")
    return this.#sessionRead(
      threadId,
      `/interactions/pending${
        runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`
      }`,
      SessionInteractionSnapshotResponseSchema
    )
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
        const headers = new Headers(init.headers)
        headers.set("content-type", "application/json")
        if (this.#authorization)
          headers.set("authorization", this.#authorization)
        return this.#fetch(url, {
          ...init,
          signal,
          credentials: "same-origin",
          headers,
          body: JSON.stringify({ threadId, runId }),
        })
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
          events.push(event as AGUIEvent)
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

  audioAvailability(threadId: string) {
    return this.#sessionRead(
      threadId,
      "/audio",
      SessionAudioResponseSchema
    ).then(({ speech, transcription }) => ({
      transcription: transcription.status,
      speech: speech.status,
    }))
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
    const { path, scope } = this.#sessionPath(threadId, "/audio/transcribe")
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
    const { path, scope } = this.#sessionPath(threadId, "/audio/speak")
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
    if (!response.ok)
      throw new Error(`AOS proxy request failed (${response.status})`)
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
      if (!response.ok)
        throw new AosClientError(
          response.status === 503 ? "provider-unavailable" : "proxy-failure"
        )
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
    this.#sessions.set(session.id, structuredClone(session))
    this.#sessionOwners.set(session.id, session.agentId)
  }

  #owner(threadId: string) {
    const owner = this.#sessionOwners.get(threadId)
    if (!owner) throw new Error("Session ownership is unknown")
    return owner
  }
}
