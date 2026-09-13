import type { HermesRpcTransport } from "./adapter"

const MAX_TICKET_RESPONSE_BYTES = 8 * 1024
const MAX_NATIVE_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024
const MAX_NATIVE_SOCKET_FRAME_BYTES = 2 * 1024 * 1024
const MAX_PENDING_NATIVE_SOCKET_FRAMES = 64
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

function webSocketUrl(baseUrl: string) {
  const url = new URL(`${baseUrl}/api/ws`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
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
    const ticket = await this.#ticket()
    const socket = this.#socketFactory(webSocketUrl(this.#baseUrl), [
      "hermes-gateway-v1",
      `hermes-gateway-ticket.${ticket}`,
    ])
    const id = `aos-${++this.#nextId}`
    return new Promise((resolve, reject) => {
      let settled = false
      let pendingFrames = 0
      let frameChain = Promise.resolve()
      const timeout = setTimeout(
        () => finish(() => reject(new Error("Hermes request timed out"))),
        this.#timeoutMs
      )
      const cleanup = () => {
        clearTimeout(timeout)
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("error", onFailure)
        socket.removeEventListener("close", onFailure)
        socket.close()
      }
      const finish = (complete: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        complete()
      }
      const onOpen = () => {
        try {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        } catch {
          finish(() => reject(new Error("Hermes connection failed")))
        }
      }
      const onMessage = (event: unknown) => {
        if (
          settled ||
          !socketFrameWithinBound(event, maxResponseBytes) ||
          pendingFrames >= MAX_PENDING_NATIVE_SOCKET_FRAMES
        ) {
          finish(() => reject(new Error("Hermes connection failed")))
          return
        }
        pendingFrames += 1
        frameChain = frameChain
          .then(async () => {
            if (settled) return
            const frame = await boundedSocketJson(event, maxResponseBytes)
            if (
              !frame ||
              typeof frame !== "object" ||
              !("id" in frame) ||
              frame.id !== id
            )
              return
            if ("error" in frame && frame.error)
              finish(() => reject(new Error("Hermes RPC failed")))
            else
              finish(() =>
                resolve(
                  "result" in frame
                    ? (frame as { result: unknown }).result
                    : undefined
                )
              )
          })
          .catch(() =>
            finish(() => reject(new Error("Hermes connection failed")))
          )
          .finally(() => {
            pendingFrames -= 1
          })
      }
      const onFailure = () =>
        finish(() => reject(new Error("Hermes connection failed")))
      socket.addEventListener("open", onOpen)
      socket.addEventListener("message", onMessage)
      socket.addEventListener("error", onFailure)
      socket.addEventListener("close", onFailure)
    })
  }

  async observeEvents(
    listener: (event: unknown) => void,
    disconnected: (error?: Error) => void
  ) {
    const ticket = await this.#ticket()
    const socket = this.#socketFactory(webSocketUrl(this.#baseUrl), [
      "hermes-gateway-v1",
      `hermes-gateway-ticket.${ticket}`,
    ])
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        finish(() => reject(new Error("Hermes connection timed out")))
      }, this.#timeoutMs)
      const cleanup = () => {
        clearTimeout(timeout)
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onFailure)
        socket.removeEventListener("close", onFailure)
      }
      const finish = (complete: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        complete()
      }
      const onOpen = () => finish(resolve)
      const onFailure = () =>
        finish(() => reject(new Error("Hermes connection failed")))
      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onFailure)
      socket.addEventListener("close", onFailure)
    })

    let stopped = false
    let pendingFrames = 0
    let frameChain = Promise.resolve()
    const cleanup = () => {
      socket.removeEventListener("message", onMessage)
      socket.removeEventListener("error", onDisconnected)
      socket.removeEventListener("close", onDisconnected)
    }
    const failObservation = () => {
      if (stopped) return
      stopped = true
      cleanup()
      socket.close()
      disconnected(new Error("Hermes connection failed"))
    }
    const onMessage = (event: unknown) => {
      if (
        stopped ||
        !socketFrameWithinBound(event) ||
        pendingFrames >= MAX_PENDING_NATIVE_SOCKET_FRAMES
      ) {
        failObservation()
        return
      }
      pendingFrames += 1
      frameChain = frameChain
        .then(async () => {
          if (stopped) return
          const frame = await boundedSocketJson(event)
          if (stopped) return
          if (
            !frame ||
            typeof frame !== "object" ||
            !("jsonrpc" in frame) ||
            frame.jsonrpc !== "2.0" ||
            !("method" in frame) ||
            frame.method !== "event" ||
            !("params" in frame)
          )
            throw new Error()
          listener(frame.params)
        })
        .catch(() => failObservation())
        .finally(() => {
          pendingFrames -= 1
        })
    }
    const onDisconnected = () => failObservation()
    socket.addEventListener("message", onMessage)
    socket.addEventListener("error", onDisconnected)
    socket.addEventListener("close", onDisconnected)
    return () => {
      if (stopped) return
      stopped = true
      cleanup()
      socket.close()
    }
  }

  async #ticket() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/auth/ws-ticket`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(await withinDeadline(
            () => this.#credentials(controller.signal),
            controller.signal
          )),
        },
      })
      if (response.status === 401 || response.status === 403) {
        cancelBody(response)
        throw new HermesAuthenticationError()
      }
      if (!response.ok) {
        cancelBody(response)
        throw new Error()
      }
      const payload = await boundedJsonResponse(
        response,
        MAX_TICKET_RESPONSE_BYTES,
        controller.signal
      )
      const ticket =
        payload && typeof payload === "object" && "ticket" in payload
          ? payload.ticket
          : undefined
      if (typeof ticket !== "string" || !ticket || ticket.length > 4096)
        throw new Error()
      return ticket
    } catch (error) {
      if (error instanceof HermesAuthenticationError) throw error
      throw new Error("Hermes connection failed")
    } finally {
      clearTimeout(timer)
    }
  }
}
