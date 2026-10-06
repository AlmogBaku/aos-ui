/**
 * Bounded native HTTP for the Hermes dashboard REST surface.
 *
 * Moved verbatim out of the deleted `transport.ts`: the WebSocket half is now a
 * thin wrapper around the vendored `JsonRpcGatewayClient` (`gateway.ts`), and
 * the REST half has no relationship to it beyond sharing the base URL and the
 * credential provider.
 *
 * Every JSON response is read through a byte budget with a declared-length
 * pre-check and a JSON depth/node bound; a file's `stream` goes to its caller
 * unread. No native body, path or header ever reaches a thrown error: callers
 * see `HermesHttpError(status)`, a `HermesRpcUncertainError` for a write
 * already sent, or a fixed "Hermes request failed" message.
 */

import { Deadline } from "../../../lifecycle"
import { ADAPTER_CALL_MS } from "../../core/limits"
import { boundedJsonShape } from "./native"

/** Hard ceiling for one native REST response body. */
export const MAX_NATIVE_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024

export type HermesCredentials = (
  signal?: AbortSignal
) => Promise<Readonly<Record<string, string>>>

export type HermesHttpInit = {
  method?: string
  body?: unknown
  maxResponseBytes?: number
  /** This call's deadline, in place of the client's. */
  timeoutMs?: number
}

export type HermesHttpOptions = {
  baseUrl: string
  credentials: HermesCredentials
  fetcher?: typeof fetch
  timeoutMs?: number
}

export type HermesStreamInit = {
  /** One byte range, sent as the `range` header. */
  range?: string
  /** Stops the request and its body. */
  signal: AbortSignal
}

export type HermesHttp = {
  http(path: string, init?: HermesHttpInit): Promise<unknown>
  /**
   * One GET whose response comes back unread, whatever its status, for its
   * caller to judge: the deadline bounds only the wait for its headers.
   */
  stream(path: string, init: HermesStreamInit): Promise<Response>
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

/**
 * A mutation went out, as a JSON-RPC frame or an HTTP write, but no result was
 * known: Hermes may have applied it.
 */
export class HermesRpcUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super("Hermes connection failed", options)
    this.name = "HermesRpcUncertainError"
  }
}

function declaredLength(response: Response, maxBytes: number) {
  const value = response.headers.get("content-length")
  if (value === null) return
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error()
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length > maxBytes) throw new Error()
}

function cancelBody(response: Response) {
  response.body?.cancel().catch(() => undefined)
}

/** Clamp a caller's requested byte budget to `ceiling`; throws when unusable. */
export function responseLimit(
  requested: number | undefined,
  ceiling: number
): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error()
  return Math.min(requested, ceiling)
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
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    // Both messages quote the body they refused.
    throw new Error()
  }
  if (!boundedJsonShape(value)) throw new Error()
  return value
}

/** Bounded native REST client; the only AOS surface that talks Hermes HTTP. */
export function createHermesHttp(options: HermesHttpOptions): HermesHttp {
  const { baseUrl } = options
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? ADAPTER_CALL_MS
  return {
    async http(path: string, init: HermesHttpInit = {}) {
      // Once a write reaches the fetcher, a failure no longer proves that
      // Hermes never applied it.
      const write = (init.method ?? "GET") !== "GET"
      let sent = false
      try {
        const deadline = new Deadline(init.timeoutMs ?? timeoutMs)
        return await deadline.run(async (signal) => {
          const maxResponseBytes = responseLimit(
            init.maxResponseBytes,
            MAX_NATIVE_HTTP_RESPONSE_BYTES
          )
          const credentials = await options.credentials(signal)
          // A late credential read must not start the request it was late for.
          signal.throwIfAborted()
          sent = true
          const response = await fetcher(`${baseUrl}${path}`, {
            method: init.method,
            signal,
            headers: {
              accept: "application/json",
              ...(init.body ? { "content-type": "application/json" } : {}),
              ...credentials,
            },
            ...(init.body ? { body: JSON.stringify(init.body) } : {}),
          })
          // Hermes answers 401 for every authentication rejection on this REST
          // surface (`hermes_cli/web_server.py:665` `auth_middleware`, `:443`
          // `_require_token`, `hermes_cli/dashboard_auth/middleware.py:76`,
          // `dashboard_auth/token_auth.py:96`) and never 403. Its 403 means the
          // resource: a file it will not read, a sensitive path, or one outside
          // the managed root (`hermes_cli/web_routers/files.py:165`, `:173`,
          // `:185`). That keeps its status so the caller classifies it as a
          // refusal instead of sending the operator to fix a working credential.
          if (response.status === 401) {
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
          return await boundedJsonResponse(response, maxResponseBytes, signal)
        })
      } catch (error) {
        if (
          error instanceof HermesAuthenticationError ||
          error instanceof HermesHttpError
        )
          throw error
        if (write && sent) throw new HermesRpcUncertainError({ cause: error })
        throw new Error("Hermes request failed")
      }
    },
    async stream(path: string, init: HermesStreamInit) {
      try {
        return await new Deadline(timeoutMs).run(async (signal) => {
          const credentials = await options.credentials(signal)
          signal.throwIfAborted()
          return await fetcher(`${baseUrl}${path}`, {
            // The deadline clears once the headers arrive, so only the
            // caller stops the body.
            signal: AbortSignal.any([init.signal, signal]),
            headers: {
              // A compressed body would misstate its length and its ranges.
              "accept-encoding": "identity",
              ...(init.range === undefined ? {} : { range: init.range }),
              ...credentials,
            },
          })
        })
      } catch {
        throw new Error("Hermes request failed")
      }
    },
  }
}
