import type { HermesRpcTransport } from "./adapter"

const MAX_NATIVE_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024
const MAX_NATIVE_SOCKET_FRAME_BYTES = 2 * 1024 * 1024
// A multiplexed runtime must tolerate a normal burst from the supported
// Session fan-out while remaining bounded against an untrusted socket.
const MAX_PENDING_NATIVE_SOCKET_FRAMES = 256
const MAX_NATIVE_JSON_DEPTH = 32
const MAX_NATIVE_JSON_NODES = 200_000

export interface HermesSocket {
  readonly readyState: number
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  send(value: string): void
  close(): void
}

export type HermesCredentials = (
  signal?: AbortSignal
) => Promise<Readonly<Record<string, string>>>

export type HermesWebSocketRpcTransportOptions = {
  baseUrl: string
  credentials: HermesCredentials
  fetcher?: typeof fetch
  socketFactory?: (url: string, protocols: string[]) => HermesSocket
  timeoutMs?: number
}

type HermesEventObserver = {
  listener: (event: unknown) => void
  disconnected: (error?: Error) => void
}

/** Private native-auth classification; never serialized across the AOS API. */
export class HermesAuthenticationError extends Error {
  constructor() {
    super("Hermes authentication failed")
    this.name = "HermesAuthenticationError"
  }
}

/** Private native status carrier; its body is deliberately never retained. */
export class HermesHttpError extends Error {
  constructor(readonly status: number) {
    super("Hermes request failed")
    this.name = "HermesHttpError"
  }
}

function normalizeBaseUrl(value: string) {
  try {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.href.replace(/\/$/u, "")
  } catch {
    throw new Error("Invalid Hermes base URL")
  }
}

function webSocketUrl(baseUrl: string, token: string) {
  const url = new URL(`${baseUrl}/api/ws`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", token)
  return url.toString()
}

function declaredLength(response: Response, maxBytes: number) {
  const value = response.headers.get("content-length")
  if (value === null) return
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error()
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > maxBytes) throw new Error()
}

function cancelBody(response: Response) {
  void response.body?.cancel().catch(() => undefined)
}

function responseLimit(requested: number | undefined, ceiling: number) {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error()
  return Math.min(requested, ceiling)
}

function withinDeadline<T>(operation: () => Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      complete()
    }
    const onAbort = () => finish(() => reject(new Error()))
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        () => finish(() => reject(new Error()))
      )
  })
}

async function boundedJsonResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
) {
  try {
    declaredLength(response, maxBytes)
  } catch {
    cancelBody(response)
    throw new Error()
  }
  if (!response.body) throw new Error()
  const reader = response.body.getReader()
  let abortReject: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abortReject = reject
  })
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
    abortReject?.(new Error())
  }
  signal.addEventListener("abort", onAbort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    if (signal.aborted) onAbort()
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      if (value.byteLength > maxBytes - total) {
        void reader.cancel().catch(() => undefined)
        throw new Error()
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {
      // An adversarial stream may leave a read pending after cancellation.
    }
  }
  if (total === 0) throw new Error()
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  if (!boundedJsonShape(value)) throw new Error()
  return value
}

function boundedJsonShape(value: unknown) {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_NATIVE_JSON_NODES || current.depth > MAX_NATIVE_JSON_DEPTH)
      return false
    if (typeof current.value !== "object" || current.value === null) continue
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value))
      pending.push({ value: child, depth: current.depth + 1 })
  }
  return true
}

async function boundedSocketJson(
  event: unknown,
  maxBytes = MAX_NATIVE_SOCKET_FRAME_BYTES
) {
  if (!event || typeof event !== "object" || !("data" in event))
    throw new Error()
  const data = event.data
  let bytes: Uint8Array
  if (typeof data === "string") {
    if (data.length > maxBytes) throw new Error()
    bytes = new TextEncoder().encode(data)
  } else if (data instanceof ArrayBuffer) {
    if (data.byteLength > maxBytes) throw new Error()
    bytes = new Uint8Array(data)
  } else if (ArrayBuffer.isView(data)) {
    if (data.byteLength > maxBytes) throw new Error()
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > maxBytes) throw new Error()
    bytes = new Uint8Array(await data.arrayBuffer())
  } else {
    throw new Error()
  }
  if (bytes.byteLength > maxBytes) throw new Error()
  const frame: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  )
  if (!boundedJsonShape(frame)) throw new Error()
  return frame
}

function socketFrameWithinBound(
  event: unknown,
  maxBytes = MAX_NATIVE_SOCKET_FRAME_BYTES
) {
  if (!event || typeof event !== "object" || !("data" in event)) return false
  const data = event.data
  if (typeof data === "string") return data.length <= maxBytes
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    return data.byteLength <= maxBytes
  if (typeof Blob !== "undefined" && data instanceof Blob)
    return data.size <= maxBytes
  return false
}

export class HermesWebSocketRpcTransport implements HermesRpcTransport {
  readonly #baseUrl: string
  readonly #credentials: HermesCredentials
  readonly #fetch: typeof fetch
  readonly #socketFactory: (url: string, protocols: string[]) => HermesSocket
  readonly #timeoutMs: number
  readonly #eventObservers = new Set<HermesEventObserver>()
  readonly #pending = new Map<
    string,
    {
      maxResponseBytes: number
      timer: ReturnType<typeof setTimeout>
      resolve(value: unknown): void
      reject(error: Error): void
    }
  >()
  #socket: HermesSocket | undefined
  #connecting: Promise<HermesSocket> | undefined
  #frameChain = Promise.resolve()
  #pendingFrames = 0
  #nextId = 0

  constructor(options: HermesWebSocketRpcTransportOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#credentials = options.credentials
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#socketFactory =
      options.socketFactory ??
      ((url, protocols) =>
        new WebSocket(url, protocols) as unknown as HermesSocket)
    this.#timeoutMs = options.timeoutMs ?? 15_000
  }

  async http(
    path: string,
    init: { method?: string; body?: unknown; maxResponseBytes?: number } = {}
  ) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      const maxResponseBytes = responseLimit(
        init.maxResponseBytes,
        MAX_NATIVE_HTTP_RESPONSE_BYTES
      )
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(await withinDeadline(
            () => this.#credentials(controller.signal),
            controller.signal
          )),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      })
      if (response.status === 401 || response.status === 403) {
        cancelBody(response)
        throw new HermesAuthenticationError()
      }
      if (!response.ok) {
        cancelBody(response)
        throw new HermesHttpError(response.status)
      }
      if (init.method === "DELETE" || response.status === 204) {
        cancelBody(response)
        return undefined
      }
      return await boundedJsonResponse(
        response,
        maxResponseBytes,
        controller.signal
      )
    } catch (error) {
      if (
        error instanceof HermesAuthenticationError ||
        error instanceof HermesHttpError
      )
        throw error
      throw new Error("Hermes request failed")
    } finally {
      clearTimeout(timer)
    }
  }

  async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    requestedMaxResponseBytes?: number
  ): Promise<unknown> {
    let maxResponseBytes: number
    try {
      maxResponseBytes = responseLimit(
        requestedMaxResponseBytes,
        MAX_NATIVE_SOCKET_FRAME_BYTES
      )
    } catch {
      throw new Error("Hermes connection failed")
    }
    const socket = await this.#ensureSocket()
    const id = `aos-${++this.#nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new Error("Hermes request timed out"))
      }, this.#timeoutMs)
      this.#pending.set(id, { maxResponseBytes, timer, resolve, reject })
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(pending.timer)
        reject(new Error("Hermes connection failed"))
      }
    })
  }

  async observeEvents(
    listener: (event: unknown) => void,
    disconnected: (error?: Error) => void
  ) {
    await this.#ensureSocket()
    const observer = { listener, disconnected }
    this.#eventObservers.add(observer)
    return () => {
      this.#eventObservers.delete(observer)
    }
  }

  async close() {
    const socket = this.#socket
    this.#invalidate(socket, false)
    socket?.close()
  }

  #publishEvent(event: unknown) {
    for (const observer of this.#eventObservers) observer.listener(event)
  }

  #disconnectObservers() {
    for (const observer of [...this.#eventObservers])
      observer.disconnected(new Error("Hermes connection failed"))
  }

  async #ensureSocket() {
    if (this.#socket?.readyState === 1) return this.#socket
    if (this.#connecting) return this.#connecting
    this.#connecting = this.#openSocket().finally(() => {
      this.#connecting = undefined
    })
    return this.#connecting
  }

  async #openSocket() {
    const token = await this.#serverToken()
    const socket = this.#socketFactory(webSocketUrl(this.#baseUrl, token), [])
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(() => reject(new Error("Hermes connection timed out"))),
        this.#timeoutMs
      )
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onFailure)
        socket.removeEventListener("close", onFailure)
      }
      const finish = (operation: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        operation()
      }
      const onOpen = () => finish(resolve)
      const onFailure = () =>
        finish(() => reject(new Error("Hermes connection failed")))
      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onFailure)
      socket.addEventListener("close", onFailure)
    })
    socket.addEventListener("message", (event) => this.#receive(socket, event))
    socket.addEventListener("error", () => this.#lost(socket))
    socket.addEventListener("close", () => this.#lost(socket))
    this.#socket = socket
    return socket
  }

  #receive(socket: HermesSocket, event: unknown) {
    if (
      socket !== this.#socket ||
      !socketFrameWithinBound(event) ||
      this.#pendingFrames >= MAX_PENDING_NATIVE_SOCKET_FRAMES
    ) {
      this.#lost(socket)
      return
    }
    this.#pendingFrames += 1
    this.#frameChain = this.#frameChain
      .then(async () => {
        const frame = await boundedSocketJson(event)
        if (!frame || typeof frame !== "object") throw new Error()
        if (
          "jsonrpc" in frame &&
          frame.jsonrpc === "2.0" &&
          "method" in frame &&
          frame.method === "event" &&
          "params" in frame
        ) {
          this.#publishEvent(frame.params)
          return
        }
        if (!("id" in frame) || typeof frame.id !== "string") return
        const pending = this.#pending.get(frame.id)
        if (!pending) return
        if (!socketFrameWithinBound(event, pending.maxResponseBytes))
          throw new Error()
        this.#pending.delete(frame.id)
        clearTimeout(pending.timer)
        if ("error" in frame && frame.error)
          pending.reject(new Error("Hermes RPC failed"))
        else pending.resolve("result" in frame ? frame.result : undefined)
      })
      .catch(() => this.#lost(socket))
      .finally(() => {
        this.#pendingFrames -= 1
      })
  }

  #lost(socket: HermesSocket) {
    if (socket !== this.#socket) return
    this.#invalidate(socket, true)
    socket.close()
  }

  #invalidate(socket: HermesSocket | undefined, notify: boolean) {
    if (socket && socket === this.#socket) this.#socket = undefined
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error("Hermes connection failed"))
    }
    if (notify) this.#disconnectObservers()
  }

  async #serverToken() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const headers = await withinDeadline(
        () => this.#credentials(controller.signal),
        controller.signal
      )
      const token = headers["X-Hermes-Session-Token"]
      if (
        typeof token !== "string" ||
        token.length < 1 ||
        token.length > 4096 ||
        /[\0\r\n]/u.test(token)
      )
        throw new HermesAuthenticationError()
      return token
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      throw new Error("Hermes connection failed")
    } finally {
      clearTimeout(timer)
    }
  }
}
