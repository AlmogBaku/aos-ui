/**
 * Bounded native HTTP for the Hermes dashboard REST surface.
 *
 * Moved verbatim out of the deleted `transport.ts`: the WebSocket half is now a
 * thin wrapper around the vendored `JsonRpcGatewayClient` (`gateway.ts`), and
 * the REST half has no relationship to it beyond sharing the base URL and the
 * credential provider.
 *
 * Every response is read through a byte budget with a declared-length pre-check
 * and a JSON depth/node bound, and no native body, path or header ever reaches
 * a thrown error: callers see `HermesHttpError(status)` or a fixed
 * "Hermes request failed" message.
 */

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
}

export type HermesHttpOptions = {
  baseUrl: string
  credentials: HermesCredentials
  fetcher?: typeof fetch
  timeoutMs?: number
}

export type HermesHttp = {
  http(path: string, init?: HermesHttpInit): Promise<unknown>
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

export function normalizeBaseUrl(value: string) {
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

/** Clamp a caller's requested byte budget to `ceiling`; throws when unusable. */
export function responseLimit(
  requested: number | undefined,
  ceiling: number
): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error()
  return Math.min(requested, ceiling)
}

/**
 * Run `operation` under `signal`, rejecting with a bare error the moment the
 * signal aborts and discarding any later result. Used so a stalled credential
 * provider counts against the caller's deadline.
 */
export function withinDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal
) {
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

/** Bounded native REST client; the only AOS surface that talks Hermes HTTP. */
export function createHermesHttp(options: HermesHttpOptions): HermesHttp {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? 15_000
  return {
    async http(path: string, init: HermesHttpInit = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        const maxResponseBytes = responseLimit(
          init.maxResponseBytes,
          MAX_NATIVE_HTTP_RESPONSE_BYTES
        )
        response = await fetcher(`${baseUrl}${path}`, {
          method: init.method,
          signal: controller.signal,
          headers: {
            accept: "application/json",
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(await withinDeadline(
              () => options.credentials(controller.signal),
              controller.signal
            )),
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
    },
  }
}
