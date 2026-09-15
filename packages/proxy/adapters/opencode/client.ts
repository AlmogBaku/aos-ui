import { isAbsolute } from "node:path"

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  AgentV2Info,
  CommandV2Info,
  ModelRef,
  ModelV2Info,
  PermissionV2Reply,
  PermissionV2Request,
  PromptInput,
  ProviderV2Info,
  QuestionV2Reply,
  QuestionV2Request,
  SessionHistory,
  SessionInputAdmitted,
  SessionMessage,
  SessionMessagesResponse,
  SessionsResponse,
  SessionV2Info,
} from "@opencode-ai/sdk/v2/client"

const MAX_IDENTIFIER_LENGTH = 512
const MAX_PAGE_LIMIT = 100

export type OpenCodeClientErrorCode =
  | "authentication"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "connection_interrupted"
  | "invalid_response"
  | "closed"

/** A bounded provider error that deliberately retains no native error content. */
export class OpenCodeClientError extends Error {
  constructor(readonly code: OpenCodeClientErrorCode) {
    super(`OpenCode request ${code.replace(/_/gu, " ")}`)
    this.name = "OpenCodeClientError"
  }
}

/** A local cancellation; no inference about native mutation admission is made. */
export class OpenCodeClientAbortError extends Error {
  constructor() {
    super("OpenCode request cancelled")
    this.name = "OpenCodeClientAbortError"
  }
}

export type OpenCodeClientOptions = Readonly<{
  baseUrl: string
  directory: string
  username: string
  password: string
  /** Test-only or server-runtime fetch implementation; never reaches browser code. */
  fetcher?: typeof fetch
}>

export type OpenCodePageOptions = Readonly<{
  limit?: number
  cursor?: string
  signal?: AbortSignal
}>

export type OpenCodeDurableEvent = Readonly<{
  id: string
  event: string
  data: Readonly<{
    type: string
    properties: Readonly<Record<string, unknown>>
  }>
}>

export type OpenCodeSessionEvents = AsyncIterable<OpenCodeDurableEvent> & {
  abort(): void
}

type OpenCodeRawDurableEvent = { id: string; event: string; data: string }

export type OpenCodeClient = Readonly<{
  catalog: Readonly<{
    agents(signal?: AbortSignal): Promise<AgentV2Info[]>
    models(signal?: AbortSignal): Promise<ModelV2Info[]>
    providers(signal?: AbortSignal): Promise<ProviderV2Info[]>
    commands(signal?: AbortSignal): Promise<CommandV2Info[]>
  }>
  sessions: Readonly<{
    list(options?: OpenCodePageOptions): Promise<SessionsResponse>
    get(sessionId: string, signal?: AbortSignal): Promise<SessionV2Info>
    create(
      input?: Readonly<{
        id?: string
        agent?: string
        model?: ModelRef
      }>,
      signal?: AbortSignal
    ): Promise<SessionV2Info>
    active(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
    messages(
      sessionId: string,
      options?: OpenCodePageOptions
    ): Promise<SessionMessagesResponse>
    history(
      sessionId: string,
      options?: Readonly<{
        after?: number
        limit?: number
        signal?: AbortSignal
      }>
    ): Promise<SessionHistory>
    context(sessionId: string, signal?: AbortSignal): Promise<SessionMessage[]>
    prompt(
      sessionId: string,
      input: Readonly<{
        id: string
        prompt: PromptInput
        delivery?: "steer" | "queue"
        resume?: boolean
      }>,
      signal?: AbortSignal
    ): Promise<SessionInputAdmitted>
    interrupt(sessionId: string, signal?: AbortSignal): Promise<void>
    wait(sessionId: string, signal?: AbortSignal): Promise<void>
    events(
      sessionId: string,
      options?: Readonly<{ after?: string; signal?: AbortSignal }>
    ): Promise<OpenCodeSessionEvents>
    questions: Readonly<{
      list(
        sessionId: string,
        signal?: AbortSignal
      ): Promise<QuestionV2Request[]>
      reply(
        sessionId: string,
        requestId: string,
        reply: QuestionV2Reply,
        signal?: AbortSignal
      ): Promise<void>
      reject(
        sessionId: string,
        requestId: string,
        signal?: AbortSignal
      ): Promise<void>
    }>
    permissions: Readonly<{
      list(
        sessionId: string,
        signal?: AbortSignal
      ): Promise<PermissionV2Request[]>
      reply(
        sessionId: string,
        requestId: string,
        reply: PermissionV2Reply,
        message?: string,
        signal?: AbortSignal
      ): Promise<void>
    }>
  }>
  close(): Promise<void>
}>

type OpenCodeSdk = ReturnType<typeof createOpencodeClient>

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  )
}

function identifier(value: string, name: string) {
  void name
  if (!text(value) || hasControl(value))
    throw new OpenCodeClientError("invalid_request")
  return value
}

function hasControl(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function page(options: OpenCodePageOptions | undefined) {
  if (!options) return {}
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_PAGE_LIMIT)
  )
    throw new OpenCodeClientError("invalid_request")
  return {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined
      ? {}
      : { cursor: identifier(options.cursor, "cursor") }),
  }
}

function validArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function validSessionsPage(value: unknown): value is SessionsResponse {
  const candidate = record(value)
  const cursor = candidate && record(candidate.cursor)
  return (
    !!candidate &&
    validArray(candidate.data) &&
    candidate.data.every((item) => text(record(item)?.id)) &&
    !!cursor &&
    (cursor.previous === undefined || text(cursor.previous)) &&
    (cursor.next === undefined || text(cursor.next))
  )
}

function validSession(value: unknown): value is SessionV2Info {
  const candidate = record(value)
  return (
    !!candidate &&
    text(candidate.id) &&
    text(candidate.projectID) &&
    text(candidate.title)
  )
}

function validDataArray<T>(
  value: unknown,
  item: (candidate: unknown) => candidate is T
): value is { data: T[] } {
  const candidate = record(value)
  return !!candidate && validArray(candidate.data) && candidate.data.every(item)
}

function validEvent(value: unknown): value is OpenCodeRawDurableEvent {
  const envelope = record(value)
  if (
    !envelope ||
    !text(envelope.id) ||
    !text(envelope.event) ||
    typeof envelope.data !== "string" ||
    !text(envelope.data)
  )
    return false
  try {
    const data = record(JSON.parse(envelope.data))
    return !!data && text(data.type) && !!record(data.properties)
  } catch {
    return false
  }
}

function parseEvent(value: unknown): OpenCodeDurableEvent {
  if (!validEvent(value)) throw new OpenCodeClientError("invalid_response")
  const envelope = value
  const data = JSON.parse(envelope.data) as {
    type: string
    properties: Record<string, unknown>
  }
  return { id: envelope.id, event: envelope.event, data }
}

function statusError(status: number | undefined) {
  if (status === 401 || status === 403)
    return new OpenCodeClientError("authentication")
  if (status === 400) return new OpenCodeClientError("invalid_request")
  if (status === 404) return new OpenCodeClientError("not_found")
  if (status === 409) return new OpenCodeClientError("conflict")
  if (status !== undefined && status >= 500)
    return new OpenCodeClientError("unavailable")
  return new OpenCodeClientError("connection_interrupted")
}

function validateOptions(options: OpenCodeClientOptions) {
  let baseUrl: URL
  try {
    baseUrl = new URL(options.baseUrl)
  } catch {
    throw new OpenCodeClientError("invalid_request")
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== "/" ||
    !isAbsolute(options.directory) ||
    hasControl(options.directory) ||
    !text(options.username) ||
    !text(options.password) ||
    hasControl(options.username) ||
    hasControl(options.password)
  )
    throw new OpenCodeClientError("invalid_request")

  return { baseUrl: baseUrl.toString().replace(/\/$/u, "") }
}

function discardNativeErrorBodies(fetcher: typeof fetch): typeof fetch {
  const guardedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const response = await fetcher(input, init)
    if (response.ok) return response
    void response.body?.cancel().catch(() => undefined)
    // The generated SDK otherwise reads error bodies before this facade can
    // classify them. Status is sufficient for the adapter's safe error map.
    return new Response(null, { status: response.status })
  }
  return guardedFetch as typeof fetch
}

class Facade implements OpenCodeClient {
  readonly #sdk: OpenCodeSdk
  readonly #controllers = new Set<AbortController>()
  #closed = false

  constructor(options: OpenCodeClientOptions) {
    const config = validateOptions(options)
    this.#sdk = createOpencodeClient({
      baseUrl: config.baseUrl,
      directory: options.directory,
      fetch: discardNativeErrorBodies(
        options.fetcher ?? globalThis.fetch.bind(globalThis)
      ),
      headers: {
        authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`,
      },
    })
  }

  readonly catalog = {
    agents: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.agent.list(undefined, { signal: requestSignal }),
        (value) => {
          if (
            !validDataArray(value, (item): item is AgentV2Info =>
              text(record(item)?.id)
            )
          )
            throw new OpenCodeClientError("invalid_response")
          return value.data
        },
        signal
      ),
    models: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.model.list(undefined, { signal: requestSignal }),
        (value) => {
          if (
            !validDataArray(value, (item): item is ModelV2Info =>
              text(record(item)?.id)
            )
          )
            throw new OpenCodeClientError("invalid_response")
          return value.data
        },
        signal
      ),
    providers: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.provider.list(undefined, { signal: requestSignal }),
        (value) => {
          if (
            !validDataArray(value, (item): item is ProviderV2Info =>
              text(record(item)?.id)
            )
          )
            throw new OpenCodeClientError("invalid_response")
          return value.data
        },
        signal
      ),
    commands: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.command.list(undefined, { signal: requestSignal }),
        (value) => {
          if (
            !validDataArray(value, (item): item is CommandV2Info =>
              text(record(item)?.name)
            )
          )
            throw new OpenCodeClientError("invalid_response")
          return value.data
        },
        signal
      ),
  }

  readonly sessions: OpenCodeClient["sessions"] = {
    list: (options?: OpenCodePageOptions) =>
      this.#request(
        (signal) => this.#sdk.v2.session.list(page(options), { signal }),
        (value) => {
          if (!validSessionsPage(value))
            throw new OpenCodeClientError("invalid_response")
          return value
        },
        options?.signal
      ),
    get: (sessionId: string, signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.get(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        (value) => {
          const data = record(value)?.data
          if (!validSession(data))
            throw new OpenCodeClientError("invalid_response")
          return data
        },
        signal
      ),
    create: (input, signal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.create(
            input
              ? {
                  ...(input.id ? { id: identifier(input.id, "session") } : {}),
                  ...(input.agent
                    ? { agent: identifier(input.agent, "agent") }
                    : {}),
                  ...(input.model ? { model: input.model } : {}),
                }
              : undefined,
            { signal: requestSignal }
          ),
        (value) => {
          const data = record(value)?.data
          if (!validSession(data))
            throw new OpenCodeClientError("invalid_response")
          return data
        },
        signal
      ),
    active: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.active({ signal: requestSignal }),
        (value) => {
          const data = record(value)?.data
          const active = record(data)
          if (!active) throw new OpenCodeClientError("invalid_response")
          return active
        },
        signal
      ),
    messages: (sessionId, options) =>
      this.#request(
        (signal) =>
          this.#sdk.v2.session.messages(
            { sessionID: identifier(sessionId, "session"), ...page(options) },
            { signal }
          ),
        (value) => {
          const candidate = record(value)
          if (
            !candidate ||
            !validArray(candidate.data) ||
            !record(candidate.cursor)
          )
            throw new OpenCodeClientError("invalid_response")
          return value as SessionMessagesResponse
        },
        options?.signal
      ),
    history: (sessionId, options) =>
      this.#request(
        (signal) => {
          if (
            options?.after !== undefined &&
            (!Number.isSafeInteger(options.after) || options.after < 0)
          )
            throw new OpenCodeClientError("invalid_request")
          if (
            options?.limit !== undefined &&
            (!Number.isSafeInteger(options.limit) ||
              options.limit < 1 ||
              options.limit > MAX_PAGE_LIMIT)
          )
            throw new OpenCodeClientError("invalid_request")
          return this.#sdk.v2.session.history(
            {
              sessionID: identifier(sessionId, "session"),
              ...(options?.after === undefined ? {} : { after: options.after }),
              ...(options?.limit === undefined ? {} : { limit: options.limit }),
            },
            { signal }
          )
        },
        (value) => {
          const candidate = record(value)
          if (
            !candidate ||
            !validArray(candidate.data) ||
            typeof candidate.hasMore !== "boolean"
          )
            throw new OpenCodeClientError("invalid_response")
          return value as SessionHistory
        },
        options?.signal
      ),
    context: (sessionId, signal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.context(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        (value) => {
          const data = record(value)?.data
          if (!validArray(data))
            throw new OpenCodeClientError("invalid_response")
          return data as SessionMessage[]
        },
        signal
      ),
    prompt: (sessionId, input, signal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.prompt(
            {
              sessionID: identifier(sessionId, "session"),
              id: identifier(input.id, "request"),
              prompt: input.prompt,
              ...(input.delivery ? { delivery: input.delivery } : {}),
              ...(input.resume === undefined ? {} : { resume: input.resume }),
            },
            { signal: requestSignal }
          ),
        (value) => {
          const data = record(value)?.data
          const admitted = record(data)
          if (
            !admitted ||
            !text(admitted.id) ||
            !text(admitted.sessionID) ||
            !Number.isSafeInteger(admitted.admittedSeq)
          )
            throw new OpenCodeClientError("invalid_response")
          return admitted as SessionInputAdmitted
        },
        signal
      ),
    interrupt: (sessionId, signal) =>
      this.#voidRequest(
        (requestSignal) =>
          this.#sdk.v2.session.interrupt(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        signal
      ),
    wait: (sessionId, signal) =>
      this.#voidRequest(
        (requestSignal) =>
          this.#sdk.v2.session.wait(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        signal
      ),
    events: (sessionId, options) => this.#events(sessionId, options),
    questions: {
      list: (sessionId, signal) =>
        this.#request(
          (requestSignal) =>
            this.#sdk.v2.session.question.list(
              { sessionID: identifier(sessionId, "session") },
              { signal: requestSignal }
            ),
          (value) => {
            if (
              !validDataArray(value, (item): item is QuestionV2Request =>
                text(record(item)?.id)
              )
            )
              throw new OpenCodeClientError("invalid_response")
            return value.data
          },
          signal
        ),
      reply: (sessionId, requestId, reply, signal) =>
        this.#voidRequest(
          (requestSignal) =>
            this.#sdk.v2.session.question.reply(
              {
                sessionID: identifier(sessionId, "session"),
                requestID: identifier(requestId, "question"),
                questionV2Reply: reply,
              },
              { signal: requestSignal }
            ),
          signal
        ),
      reject: (sessionId, requestId, signal) =>
        this.#voidRequest(
          (requestSignal) =>
            this.#sdk.v2.session.question.reject(
              {
                sessionID: identifier(sessionId, "session"),
                requestID: identifier(requestId, "question"),
              },
              { signal: requestSignal }
            ),
          signal
        ),
    },
    permissions: {
      list: (sessionId, signal) =>
        this.#request(
          (requestSignal) =>
            this.#sdk.v2.session.permission.list(
              { sessionID: identifier(sessionId, "session") },
              { signal: requestSignal }
            ),
          (value) => {
            if (
              !validDataArray(value, (item): item is PermissionV2Request =>
                text(record(item)?.id)
              )
            )
              throw new OpenCodeClientError("invalid_response")
            return value.data
          },
          signal
        ),
      reply: (sessionId, requestId, reply, message, signal) =>
        this.#voidRequest(
          (requestSignal) =>
            this.#sdk.v2.session.permission.reply(
              {
                sessionID: identifier(sessionId, "session"),
                requestID: identifier(requestId, "permission"),
                reply,
                ...(message === undefined ? {} : { message }),
              },
              { signal: requestSignal }
            ),
          signal
        ),
    },
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
  }

  async #request<T>(
    operation: (signal: AbortSignal) => Promise<unknown>,
    validate: (value: unknown) => T,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const lease = this.#lease(callerSignal)
    try {
      const result = record(await operation(lease.controller.signal))
      if (!result) throw new OpenCodeClientError("invalid_response")
      if (result.error !== undefined) {
        const response = result.response
        throw statusError(
          response instanceof Response ? response.status : undefined
        )
      }
      return validate(result.data)
    } catch (error) {
      if (lease.controller.signal.aborted) throw new OpenCodeClientAbortError()
      if (error instanceof OpenCodeClientError) throw error
      throw statusError(undefined)
    } finally {
      lease.release()
    }
  }

  async #voidRequest(
    operation: (signal: AbortSignal) => Promise<unknown>,
    callerSignal?: AbortSignal
  ) {
    await this.#request(operation, () => undefined, callerSignal)
  }

  async #events(
    sessionId: string,
    options?: Readonly<{ after?: string; signal?: AbortSignal }>
  ): Promise<OpenCodeSessionEvents> {
    identifier(sessionId, "session")
    if (options?.after !== undefined) identifier(options.after, "after")
    const lease = this.#lease(options?.signal)
    let streamError: unknown
    try {
      const source = await this.#sdk.v2.session.events(
        {
          sessionID: sessionId,
          ...(options?.after === undefined ? {} : { after: options.after }),
        },
        {
          signal: lease.controller.signal,
          // AOS reconnects from the durable aggregate position itself.
          sseMaxRetryAttempts: 1,
          onSseError: (error) => {
            streamError = error
          },
        }
      )
      const iterator = (async function* () {
        try {
          for await (const event of source.stream) yield parseEvent(event)
          if (streamError && !lease.controller.signal.aborted)
            throw statusError(undefined)
        } catch (error) {
          if (lease.controller.signal.aborted) return
          if (error instanceof OpenCodeClientError) throw error
          throw statusError(undefined)
        } finally {
          lease.release()
        }
      })()
      return {
        [Symbol.asyncIterator]: () => iterator,
        abort: () => lease.controller.abort(),
      }
    } catch (error) {
      lease.release()
      if (error instanceof OpenCodeClientError) throw error
      if (lease.controller.signal.aborted) throw new OpenCodeClientAbortError()
      throw statusError(undefined)
    }
  }

  #lease(callerSignal?: AbortSignal) {
    if (this.#closed) throw new OpenCodeClientError("closed")
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    callerSignal?.addEventListener("abort", onAbort, { once: true })
    if (callerSignal?.aborted) controller.abort()
    this.#controllers.add(controller)
    return {
      controller,
      release: () => {
        callerSignal?.removeEventListener("abort", onAbort)
        this.#controllers.delete(controller)
      },
    }
  }
}

export function createOpenCodeClient(
  options: OpenCodeClientOptions
): OpenCodeClient {
  return new Facade(options)
}
