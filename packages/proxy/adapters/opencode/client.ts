import { isAbsolute } from "node:path"

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  ModelRef,
  PermissionV2Reply,
  PromptInput,
  QuestionV2Reply,
} from "@opencode-ai/sdk/v2/client"

const MAX_IDENTIFIER_LENGTH = 512
const MAX_PAGE_LIMIT = 100
const MAX_DURABLE_EVENT_DATA_BYTES = 2 * 1024 * 1024

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

/** A native mutation may have been accepted after dispatch but before reply. */
export class OpenCodeMutationUncertainError extends Error {
  readonly code = "uncertain_mutation"

  constructor() {
    super("OpenCode mutation acknowledgement is uncertain")
    this.name = "OpenCodeMutationUncertainError"
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
  /** The pinned SDK forbids combining an order with an opaque cursor. */
  order?: "asc" | "desc"
  signal?: AbortSignal
}>

export type OpenCodeDurableEvent = Readonly<{
  id: string
  event: string
  /** Validated transport envelope; the native-schema leaf owns its payload. */
  data: unknown
}>

export type OpenCodeSessionEvents = AsyncIterable<OpenCodeDurableEvent> & {
  abort(): void
}

type OpenCodeRawDurableEvent = { id: string; event: string; data: string }

export type OpenCodeClient = Readonly<{
  catalog: Readonly<{
    agents(signal?: AbortSignal): Promise<unknown>
    models(signal?: AbortSignal): Promise<unknown>
    providers(signal?: AbortSignal): Promise<unknown>
    commands(signal?: AbortSignal): Promise<unknown>
  }>
  sessions: Readonly<{
    list(options?: OpenCodePageOptions): Promise<unknown>
    get(sessionId: string, signal?: AbortSignal): Promise<unknown>
    create(
      input?: Readonly<{
        id?: string
        agent?: string
        model?: ModelRef
      }>,
      signal?: AbortSignal
    ): Promise<unknown>
    /**
     * The pinned SDK exposes Session updates only on the pre-v2 route, and it
     * types `time.archived` as a bare number with no unarchive route. Callers
     * own what an empty `time` object means to the native server.
     */
    update(
      sessionId: string,
      input: Readonly<{
        title?: string
        time?: Readonly<{ archived?: number }>
        metadata?: Readonly<Record<string, unknown>>
      }>,
      signal?: AbortSignal
    ): Promise<void>
    delete(sessionId: string, signal?: AbortSignal): Promise<void>
    switchModel(
      sessionId: string,
      model: ModelRef,
      signal?: AbortSignal
    ): Promise<void>
    active(signal?: AbortSignal): Promise<unknown>
    messages(sessionId: string, options?: OpenCodePageOptions): Promise<unknown>
    history(
      sessionId: string,
      options?: Readonly<{
        after?: number
        limit?: number
        signal?: AbortSignal
      }>
    ): Promise<unknown>
    context(sessionId: string, signal?: AbortSignal): Promise<unknown>
    prompt(
      sessionId: string,
      input: Readonly<{
        id: string
        prompt: PromptInput
        delivery?: "steer" | "queue"
        resume?: boolean
      }>,
      signal?: AbortSignal
    ): Promise<unknown>
    interrupt(sessionId: string, signal?: AbortSignal): Promise<void>
    wait(sessionId: string, signal?: AbortSignal): Promise<void>
    events(
      sessionId: string,
      options?: Readonly<{ after?: string; signal?: AbortSignal }>
    ): Promise<OpenCodeSessionEvents>
    questions: Readonly<{
      list(sessionId: string, signal?: AbortSignal): Promise<unknown>
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
      list(sessionId: string, signal?: AbortSignal): Promise<unknown>
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

function providerEnvelope(value: unknown) {
  const envelope = record(value)
  if (!envelope || !Object.hasOwn(envelope, "data"))
    throw new OpenCodeClientError("invalid_response")
  return value
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

function modelReference(value: unknown): ModelRef {
  const candidate = record(value)
  const providerID =
    typeof candidate?.providerID === "string"
      ? identifier(candidate.providerID, "provider")
      : undefined
  const id =
    typeof candidate?.id === "string"
      ? identifier(candidate.id, "model")
      : undefined
  const variant =
    candidate?.variant === undefined
      ? undefined
      : typeof candidate.variant === "string"
        ? identifier(candidate.variant, "variant")
        : undefined
  if (!providerID || !id || (candidate?.variant !== undefined && !variant))
    throw new OpenCodeClientError("invalid_request")
  return { providerID, id, ...(variant === undefined ? {} : { variant }) }
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
  if (
    options.order !== undefined &&
    options.order !== "asc" &&
    options.order !== "desc"
  )
    throw new OpenCodeClientError("invalid_request")
  if (options.cursor !== undefined && options.order !== undefined)
    throw new OpenCodeClientError("invalid_request")
  return {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.order === undefined ? {} : { order: options.order }),
    ...(options.cursor === undefined
      ? {}
      : { cursor: identifier(options.cursor, "cursor") }),
  }
}

function validEvent(value: unknown): value is OpenCodeRawDurableEvent {
  const envelope = record(value)
  if (
    !envelope ||
    !text(envelope.id) ||
    !text(envelope.event) ||
    typeof envelope.data !== "string" ||
    new TextEncoder().encode(envelope.data).byteLength >
      MAX_DURABLE_EVENT_DATA_BYTES
  )
    return false
  try {
    const payload = record(JSON.parse(envelope.data))
    return !!payload && text(payload.type) && !!record(payload.properties)
  } catch {
    return false
  }
}

function parseEvent(value: unknown): OpenCodeDurableEvent {
  if (!validEvent(value)) throw new OpenCodeClientError("invalid_response")
  const envelope = value
  const data: unknown = JSON.parse(envelope.data)
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

class OpenCodeHttpStatusError extends Error {
  constructor(readonly status: number) {
    super("OpenCode request failed")
  }
}

function statusFrom(error: unknown) {
  return error instanceof OpenCodeHttpStatusError ? error.status : undefined
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
    const headers = input instanceof Request ? input.headers : init?.headers
    const url = input instanceof Request ? input.url : String(input)
    if (
      new Headers(headers).get("accept")?.includes("text/event-stream") ||
      new URL(url).pathname.endsWith("/event")
    )
      throw new OpenCodeHttpStatusError(response.status)
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
        providerEnvelope,
        signal
      ),
    models: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.model.list(undefined, { signal: requestSignal }),
        providerEnvelope,
        signal
      ),
    providers: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.provider.list(undefined, { signal: requestSignal }),
        providerEnvelope,
        signal
      ),
    commands: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.command.list(undefined, { signal: requestSignal }),
        providerEnvelope,
        signal
      ),
  }

  readonly sessions: OpenCodeClient["sessions"] = {
    list: (options?: OpenCodePageOptions) =>
      this.#request(
        (signal) => this.#sdk.v2.session.list(page(options), { signal }),
        providerEnvelope,
        options?.signal
      ),
    get: (sessionId: string, signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.get(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        providerEnvelope,
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
        providerEnvelope,
        signal
      ),
    update: (sessionId, input, signal) =>
      this.#voidMutation(
        (requestSignal) =>
          this.#sdk.session.update(
            {
              sessionID: identifier(sessionId, "session"),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.time === undefined ? {} : { time: { ...input.time } }),
              ...(input.metadata === undefined
                ? {}
                : { metadata: { ...input.metadata } }),
            },
            { signal: requestSignal }
          ),
        signal
      ),
    delete: (sessionId, signal) =>
      this.#voidMutation(
        (requestSignal) =>
          this.#sdk.session.delete(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        signal
      ),
    switchModel: (sessionId, model, signal) =>
      this.#voidMutation(
        (requestSignal) =>
          this.#sdk.v2.session.switchModel(
            {
              sessionID: identifier(sessionId, "session"),
              model: modelReference(model),
            },
            { signal: requestSignal }
          ),
        signal
      ),
    active: (signal?: AbortSignal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.active({ signal: requestSignal }),
        providerEnvelope,
        signal
      ),
    messages: (sessionId, options) =>
      this.#request(
        (signal) =>
          this.#sdk.v2.session.messages(
            { sessionID: identifier(sessionId, "session"), ...page(options) },
            { signal }
          ),
        providerEnvelope,
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
        providerEnvelope,
        options?.signal
      ),
    context: (sessionId, signal) =>
      this.#request(
        (requestSignal) =>
          this.#sdk.v2.session.context(
            { sessionID: identifier(sessionId, "session") },
            { signal: requestSignal }
          ),
        providerEnvelope,
        signal
      ),
    prompt: (sessionId, input, signal) =>
      this.#mutation(
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
        providerEnvelope,
        signal
      ),
    interrupt: (sessionId, signal) =>
      this.#voidMutation(
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
          providerEnvelope,
          signal
        ),
      reply: (sessionId, requestId, reply, signal) =>
        this.#voidMutation(
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
        this.#voidMutation(
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
          providerEnvelope,
          signal
        ),
      reply: (sessionId, requestId, reply, message, signal) =>
        this.#voidMutation(
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
    for (const controller of [...this.#controllers]) controller.abort()
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
        const status =
          response instanceof Response ? response.status : undefined
        throw statusError(status)
      }
      if (!Object.hasOwn(result, "data"))
        throw new OpenCodeClientError("invalid_response")
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

  async #mutation<T>(
    operation: (signal: AbortSignal) => Promise<unknown>,
    validate: (value: unknown) => T,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const lease = this.#lease(callerSignal)
    let dispatched = false
    try {
      if (lease.controller.signal.aborted) throw new OpenCodeClientAbortError()
      dispatched = true
      const result = record(await operation(lease.controller.signal))
      if (!result) throw new OpenCodeMutationUncertainError()
      if (result.error !== undefined) {
        const response = result.response
        const status =
          response instanceof Response ? response.status : undefined
        if (status === undefined) throw new OpenCodeMutationUncertainError()
        throw statusError(status)
      }
      if (!Object.hasOwn(result, "data"))
        throw new OpenCodeMutationUncertainError()
      try {
        return validate(result.data)
      } catch (error) {
        if (
          error instanceof OpenCodeClientError &&
          error.code === "invalid_response"
        )
          throw new OpenCodeMutationUncertainError()
        throw error
      }
    } catch (error) {
      if (error instanceof OpenCodeClientError) throw error
      if (dispatched) throw new OpenCodeMutationUncertainError()
      if (error instanceof OpenCodeClientAbortError) throw error
      if (lease.controller.signal.aborted) throw new OpenCodeClientAbortError()
      throw statusError(undefined)
    } finally {
      lease.release()
    }
  }

  async #voidMutation(
    operation: (signal: AbortSignal) => Promise<unknown>,
    callerSignal?: AbortSignal
  ) {
    await this.#mutation(operation, () => undefined, callerSignal)
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
            throw statusError(statusFrom(streamError))
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
    let released = false
    const release = () => {
      if (released) return
      released = true
      callerSignal?.removeEventListener("abort", onAbort)
      controller.signal.removeEventListener("abort", release)
      this.#controllers.delete(controller)
    }
    callerSignal?.addEventListener("abort", onAbort, { once: true })
    controller.signal.addEventListener("abort", release, { once: true })
    this.#controllers.add(controller)
    if (callerSignal?.aborted) controller.abort()
    return {
      controller,
      release,
    }
  }
}

export function createOpenCodeClient(
  options: OpenCodeClientOptions
): OpenCodeClient {
  return new Facade(options)
}
