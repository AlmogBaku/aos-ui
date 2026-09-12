import type { HermesRpcTransport } from "./hermes-adapter"

export interface HermesSocket {
  readonly readyState: number
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  send(value: string): void
  close(): void
}

export type HermesCredentials = () => Promise<Readonly<Record<string, string>>>

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

  async http(path: string, init: { method?: string; body?: unknown } = {}) {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(await this.#credentials()),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch {
      throw new Error("Hermes connection failed")
    }
    if (response.status === 401 || response.status === 403)
      throw new HermesAuthenticationError()
    if (!response.ok) throw new HermesHttpError(response.status)
    if (init.method === "DELETE" || response.status === 204) return undefined
    try {
      return await response.json()
    } catch {
      throw new Error("Hermes request failed")
    }
  }

  async request(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/auth/ws-ticket`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(await this.#credentials()),
        },
      })
    } catch {
      throw new Error("Hermes connection failed")
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403)
      throw new HermesAuthenticationError()
    if (!response.ok) throw new Error("Hermes connection failed")
    let ticket: unknown
    try {
      const payload: unknown = await response.json()
      ticket =
        payload && typeof payload === "object" && "ticket" in payload
          ? payload.ticket
          : undefined
    } catch {
      throw new Error("Hermes connection failed")
    }
    if (typeof ticket !== "string" || !ticket || ticket.length > 4096)
      throw new Error("Hermes connection failed")

    const socket = this.#socketFactory(webSocketUrl(this.#baseUrl), [
      "hermes-gateway-v1",
      `hermes-gateway-ticket.${ticket}`,
    ])
    const id = `aos-${++this.#nextId}`
    return new Promise((resolve, reject) => {
      let settled = false
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
        try {
          const data =
            event && typeof event === "object" && "data" in event
              ? String(event.data)
              : ""
          const frame: unknown = JSON.parse(data)
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
        } catch {
          finish(() => reject(new Error("Hermes connection failed")))
        }
      }
      const onFailure = () =>
        finish(() => reject(new Error("Hermes connection failed")))
      socket.addEventListener("open", onOpen)
      socket.addEventListener("message", onMessage)
      socket.addEventListener("error", onFailure)
      socket.addEventListener("close", onFailure)
    })
  }
}
