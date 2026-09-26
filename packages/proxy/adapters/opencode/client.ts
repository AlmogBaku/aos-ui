import { isAbsolute, relative } from "node:path"

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  ModelRef,
  PermissionV2Reply,
  PromptInput,
  QuestionV2Reply,
} from "@opencode-ai/sdk/v2/client"

import { Deadline, defaultClock } from "../../../lifecycle"

const MAX_IDENTIFIER_LENGTH = 512
const MAX_PAGE_LIMIT = 100
const MAX_DURABLE_EVENT_DATA_BYTES = 2 * 1024 * 1024
/** The innermost bound on one native request that answers once. */
const ADAPTER_CALL_DEADLINE_MS = 15_000

export type OpenCodeClientErrorCode =
  | "authentication"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "connection_interrupted"
  | "invalid_response"
  | "closed"

/**
 * A bounded provider error that deliberately retains no native response body;
 * a transport failure is kept only as its cause.
 */
export class OpenCodeClientError extends Error {
  constructor(
    readonly code: OpenCodeClientErrorCode,
    options?: ErrorOptions
  ) {
    super(`OpenCode request ${code.replace(/_/gu, " ")}`, options)
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

  constructor(options?: ErrorOptions) {
    super("OpenCode mutation acknowledgement is uncertain", options)
    this.name = "OpenCodeMutationUncertainError"
  }
}

export type OpenCodeClientOptions = Readonly<{
  baseUrl: string
  directory: string
  username: string
  /** Read on every request, so a rotated password applies to the next one. */
  password: () => Promise<string>
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
    /** The project's resolved configuration, `GET /config`. */
    config(signal?: AbortSignal): Promise<Record<string, unknown>>
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
    /**
     * The pinned SDK exposes the Todo read only on the pre-v2 route, and types
     * its body as a bare array while every other Session read is enveloped, so
     * the reader accepts either shape and answers with the list itself.
     */
    todos(sessionId: string, signal?: AbortSignal): Promise<unknown[]>
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
  files: Readonly<{
    /**
     * One file's content, as OpenCode's project file route answers it. OpenCode
     * confines the route to its project directory, so a path outside the
     * configured directory is not found without asking it.
     */
    read(path: string, signal?: AbortSignal): Promise<OpenCodeFileContent>
  }>
  close(): Promise<void>
}>

/** The fields of the native `FileContent` an artifact read relies on. */
export type OpenCodeFileContent = Readonly<{
  type: "text" | "binary"
  content: string
  encoding?: "base64"
  mimeType?: string
}>

type OpenCodeSdk = ReturnType<typeof createOpencodeClient>

/** The per-call options every native call is made with. */
type NativeRequest = Readonly<{
  signal: AbortSignal
  headers: Readonly<{ authorization: string }>
}>

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function configRecord(value: unknown) {
  const config = record(value)
  if (!config) throw new OpenCodeClientError("invalid_response")
  return config
}

function providerEnvelope(value: unknown) {
  const envelope = record(value)
  if (!envelope || !Object.hasOwn(envelope, "data"))
    throw new OpenCodeClientError("invalid_response")
  return value
}

/**
 * The native Todo read is the one Session route the pinned SDK types as a bare
 * array, so this reader accepts the array either way and leaves bounding the
 * rows themselves to the Todo projection.
 */
function todoList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const envelope = record(value)
  if (envelope && Array.isArray(envelope.data)) return envelope.data
  throw new OpenCodeClientError("invalid_response")
}

function fileContent(value: unknown): OpenCodeFileContent {
  const file = record(value)
  if (
    !file ||
    (file.type !== "text" && file.type !== "binary") ||
    typeof file.content !== "string" ||
    (file.encoding !== undefined && file.encoding !== "base64") ||
    (file.mimeType !== undefined && typeof file.mimeType !== "string")
  )
    throw new OpenCodeClientError("invalid_response")
  return {
    type: file.type,
    content: file.content,
    ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
  }
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

function statusError(status: number | undefined, options?: ErrorOptions) {
  if (status === 401 || status === 403)
    return new OpenCodeClientError("authentication")
  if (status === 400) return new OpenCodeClientError("invalid_request")
  if (status === 404) return new OpenCodeClientError("not_found")
  if (status === 409) return new OpenCodeClientError("conflict")
  if (status !== undefined && status >= 500)
    return new OpenCodeClientError("unavailable")
  return new OpenCodeClientError("connection_interrupted", options)
}

/**
 * A failed native result: the status the server answered with, or, when none
 * answered, the transport failure the SDK caught as the cause.
 */
function resultFailure(result: Record<string, unknown>) {
  const { response } = result
  if (response instanceof Response)
    return { status: response.status, error: statusError(response.status) }
  return {
    status: undefined,
    error: statusError(undefined, { cause: result.error }),
  }
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
  // Config load already holds the base URL to HTTP(S) with no credentials,
  // query, or fragment; only the root path, which config leaves open, is
  // OpenCode's own rule.
  if (
    new URL(options.baseUrl).pathname !== "/" ||
    !isAbsolute(options.directory) ||
    hasControl(options.directory) ||
    !text(options.username) ||
    hasControl(options.username)
  )
    throw new OpenCodeClientError("invalid_request")
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
  readonly #directory: string
  readonly #username: string
  readonly #password: () => Promise<string>
  readonly #controllers = new Set<AbortController>()
  #closed = false

  constructor(options: OpenCodeClientOptions) {
    validateOptions(options)
    this.#directory = options.directory
    this.#username = options.username
    this.#password = options.password
    this.#sdk = createOpencodeClient({
      baseUrl: options.baseUrl,
      directory: options.directory,
      fetch: discardNativeErrorBodies(
        options.fetcher ?? globalThis.fetch.bind(globalThis)
      ),
    })
  }

  readonly catalog = {
    agents: (signal?: AbortSignal) =>
      this.#request(
        (request) => this.#sdk.v2.agent.list(undefined, request),
        providerEnvelope,
        signal
      ),
    models: (signal?: AbortSignal) =>
      this.#request(
        (request) => this.#sdk.v2.model.list(undefined, request),
        providerEnvelope,
        signal
      ),
    providers: (signal?: AbortSignal) =>
      this.#request(
        (request) => this.#sdk.v2.provider.list(undefined, request),
        providerEnvelope,
        signal
      ),
    commands: (signal?: AbortSignal) =>
      this.#request(
        (request) => this.#sdk.v2.command.list(undefined, request),
        providerEnvelope,
        signal
      ),
    config: (signal?: AbortSignal) =>
      this.#request(
        (request) => this.#sdk.config.get(undefined, request),
        configRecord,
        signal
      ),
  }

  readonly sessions: OpenCodeClient["sessions"] = {
    list: (options?: OpenCodePageOptions) =>
      this.#request(
        (request) => this.#sdk.v2.session.list(page(options), request),
        providerEnvelope,
        options?.signal
      ),
    get: (sessionId: string, signal?: AbortSignal) =>
      this.#request(
        (request) =>
          this.#sdk.v2.session.get(
            { sessionID: identifier(sessionId, "session") },
            request
          ),
        providerEnvelope,
        signal
      ),
    create: (input, signal) =>
      this.#request(
        (request) =>
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
            request
          ),
        providerEnvelope,
        signal
      ),
    update: (sessionId, input, signal) =>
      this.#voidMutation(
        (request) =>
          this.#sdk.session.update(
            {
              sessionID: identifier(sessionId, "session"),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.time === undefined ? {} : { time: { ...input.time } }),
              ...(input.metadata === undefined
                ? {}
                : { metadata: { ...input.metadata } }),
            },
            request
          ),
        signal
      ),
    delete: (sessionId, signal) =>
      this.#voidMutation(
        (request) =>
          this.#sdk.session.delete(
            { sessionID: identifier(sessionId, "session") },
            request
          ),
        signal
      ),
    switchModel: (sessionId, model, signal) =>
      this.#voidMutation(
        (request) =>
          this.#sdk.v2.session.switchModel(
            {
              sessionID: identifier(sessionId, "session"),
              model: modelReference(model),
            },
            request
          ),
        signal
      ),
    active: (signal?: AbortSignal) =>
      this.#request(
        (request) => this.#sdk.v2.session.active(request),
        providerEnvelope,
        signal
      ),
    messages: (sessionId, options) =>
      this.#request(
        (request) =>
          this.#sdk.v2.session.messages(
            { sessionID: identifier(sessionId, "session"), ...page(options) },
            request
          ),
        providerEnvelope,
        options?.signal
      ),
    history: (sessionId, options) =>
      this.#request(
        (request) => {
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
            request
          )
        },
        providerEnvelope,
        options?.signal
      ),
    context: (sessionId, signal) =>
      this.#request(
        (request) =>
          this.#sdk.v2.session.context(
            { sessionID: identifier(sessionId, "session") },
            request
          ),
        providerEnvelope,
        signal
      ),
    todos: (sessionId, signal) =>
      this.#request(
        (request) =>
          this.#sdk.session.todo(
            { sessionID: identifier(sessionId, "session") },
            request
          ),
        todoList,
        signal
      ),
    prompt: (sessionId, input, signal) =>
      this.#mutation(
        (request) =>
          this.#sdk.v2.session.prompt(
            {
              sessionID: identifier(sessionId, "session"),
              id: identifier(input.id, "request"),
              prompt: input.prompt,
              ...(input.delivery ? { delivery: input.delivery } : {}),
              ...(input.resume === undefined ? {} : { resume: input.resume }),
            },
            request
          ),
        providerEnvelope,
        signal
      ),
    interrupt: (sessionId, signal) =>
      this.#voidMutation(
        (request) =>
          this.#sdk.v2.session.interrupt(
            { sessionID: identifier(sessionId, "session") },
            request
          ),
        signal
      ),
    // A long poll that answers when the Session idles, so no call deadline.
    wait: (sessionId, signal) =>
      this.#request(
        (request) =>
          this.#sdk.v2.session.wait(
            { sessionID: identifier(sessionId, "session") },
            request
          ),
        () => undefined,
        signal,
        false
      ),
    events: (sessionId, options) => this.#events(sessionId, options),
    questions: {
      list: (sessionId, signal) =>
        this.#request(
          (request) =>
            this.#sdk.v2.session.question.list(
              { sessionID: identifier(sessionId, "session") },
              request
            ),
          providerEnvelope,
          signal
        ),
      reply: (sessionId, requestId, reply, signal) =>
        this.#voidMutation(
          (request) =>
            this.#sdk.v2.session.question.reply(
              {
                sessionID: identifier(sessionId, "session"),
                requestID: identifier(requestId, "question"),
                questionV2Reply: reply,
              },
              request
            ),
          signal
        ),
      reject: (sessionId, requestId, signal) =>
        this.#voidMutation(
          (request) =>
            this.#sdk.v2.session.question.reject(
              {
                sessionID: identifier(sessionId, "session"),
                requestID: identifier(requestId, "question"),
              },
              request
            ),
          signal
        ),
    },
    permissions: {
      list: (sessionId, signal) =>
        this.#request(
          (request) =>
            this.#sdk.v2.session.permission.list(
              { sessionID: identifier(sessionId, "session") },
              request
            ),
          providerEnvelope,
          signal
        ),
      reply: (sessionId, requestId, reply, message, signal) =>
        this.#voidMutation(
          (request) =>
            this.#sdk.v2.session.permission.reply(
              {
                sessionID: identifier(sessionId, "session"),
                requestID: identifier(requestId, "permission"),
                reply,
                ...(message === undefined ? {} : { message }),
              },
              request
            ),
          signal
        ),
    },
  }

  readonly files: OpenCodeClient["files"] = {
    read: (path, signal) =>
      this.#request(
        (request) => {
          const inside = isAbsolute(path) ? relative(this.#directory, path) : ""
          if (
            !inside ||
            inside === ".." ||
            inside.startsWith("../") ||
            isAbsolute(inside)
          )
            throw new OpenCodeClientError("not_found")
          return this.#sdk.file.read({ path: inside }, request)
        },
        fileContent,
        signal
      ),
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const controller of [...this.#controllers]) controller.abort()
  }

  async #request<T>(
    operation: (request: NativeRequest) => Promise<unknown>,
    validate: (value: unknown) => T,
    callerSignal?: AbortSignal,
    bounded = true
  ): Promise<T> {
    const lease = this.#lease(callerSignal, bounded)
    try {
      const result = record(await operation(await this.#native(lease.signal)))
      if (!result) throw new OpenCodeClientError("invalid_response")
      if (result.error !== undefined) throw resultFailure(result).error
      if (!Object.hasOwn(result, "data"))
        throw new OpenCodeClientError("invalid_response")
      return validate(result.data)
    } catch (error) {
      if (lease.controller.signal.aborted) throw new OpenCodeClientAbortError()
      if (error instanceof OpenCodeClientError) throw error
      throw statusError(undefined, { cause: error })
    } finally {
      lease.release()
    }
  }

  async #mutation<T>(
    operation: (request: NativeRequest) => Promise<unknown>,
    validate: (value: unknown) => T,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const lease = this.#lease(callerSignal, true)
    let dispatched = false
    try {
      const request = await this.#native(lease.signal)
      lease.signal.throwIfAborted()
      dispatched = true
      const result = record(await operation(request))
      if (!result) throw new OpenCodeMutationUncertainError()
      if (result.error !== undefined) {
        const { status, error } = resultFailure(result)
        // A lost answer or a server error after dispatch leaves the write's
        // effect unknown; any other status is the server's refusal.
        if (status === undefined || status >= 500)
          throw new OpenCodeMutationUncertainError({ cause: error })
        throw error
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
      if (dispatched)
        throw error instanceof OpenCodeMutationUncertainError
          ? error
          : new OpenCodeMutationUncertainError({ cause: error })
      if (lease.controller.signal.aborted) throw new OpenCodeClientAbortError()
      throw statusError(undefined, { cause: error })
    } finally {
      lease.release()
    }
  }

  async #voidMutation(
    operation: (request: NativeRequest) => Promise<unknown>,
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
    const lease = this.#lease(options?.signal, false)
    let streamError: unknown
    try {
      const source = await this.#sdk.v2.session.events(
        {
          sessionID: sessionId,
          ...(options?.after === undefined ? {} : { after: options.after }),
        },
        {
          ...(await this.#native(lease.signal)),
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
          throw statusError(undefined, { cause: error })
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
      throw statusError(undefined, { cause: error })
    }
  }

  /**
   * The options for one native call, with the password read for it alone. A
   * password that cannot be read or sent means the call is never made.
   */
  async #native(signal: AbortSignal): Promise<NativeRequest> {
    let password: string
    try {
      password = await this.#password()
    } catch (error) {
      throw new OpenCodeClientError("unavailable", { cause: error })
    }
    if (!text(password) || hasControl(password))
      throw new OpenCodeClientError("unavailable")
    const basic = Buffer.from(`${this.#username}:${password}`, "utf8")
    return {
      signal,
      headers: { authorization: `Basic ${basic.toString("base64")}` },
    }
  }

  /**
   * A native call's controller, which the caller and close abort, and the
   * signal the call runs on: bounded by the adapter call deadline unless the
   * call is a long poll or a stream.
   */
  #lease(callerSignal: AbortSignal | undefined, bounded: boolean) {
    if (this.#closed) throw new OpenCodeClientError("closed")
    const controller = new AbortController()
    // The deadline listens on the controller before `release` does, so an
    // abort reaches the call before release clears the deadline.
    const deadline = bounded
      ? new Deadline(ADAPTER_CALL_DEADLINE_MS, defaultClock, controller.signal)
      : undefined
    const onAbort = () => controller.abort()
    let released = false
    const release = () => {
      if (released) return
      released = true
      deadline?.clear()
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
      signal: deadline?.signal ?? controller.signal,
      release,
    }
  }
}

export function createOpenCodeClient(
  options: OpenCodeClientOptions
): OpenCodeClient {
  return new Facade(options)
}
