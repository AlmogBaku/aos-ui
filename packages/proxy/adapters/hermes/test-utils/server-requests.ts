/**
 * serverRequests — the server→client request half of a Hermes gateway, driven
 * by the vendored `JsonRpcRequestChannel` itself.
 *
 * Using the real channel keeps a test honest about the parts AOS does not own:
 * handlers run in registration order, a declined request is answered `-32601`
 * by the channel, `respond` is idempotent and swallows a dead socket, and an
 * `open_requests` entry is re-delivered with `replayed: true`.
 *
 * Usage:
 *
 *   const requests = serverRequests()
 *   const interactions = new HermesInteractions(requests.transport, attachments)
 *   const id = requests.deliver("clarify", { session_id: "live", question: "?" })
 *   expect(requests.answer(id)).toEqual({ answer: "eu" })
 */

import { HermesRpcRejectedError } from "../gateway"
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcRequestChannel,
  type ServerRequestHandler,
} from "../vendor/hermes-shared/json-rpc-channel"

export type ServerRequestsHarness = {
  /** The transport surface an answering surface subscribes to. */
  transport: {
    onRequest(handler: ServerRequestHandler): () => void
    onEvent(listener: (event: unknown) => void): () => void
    connected(): boolean
    request(
      method: string,
      params: Readonly<Record<string, unknown>>
    ): Promise<unknown>
  }
  /** Deliver one live server→client request; returns its `srq-…` id. */
  deliver(
    method: string,
    params: Record<string, unknown>,
    options?: { id?: string; replayed?: boolean }
  ): string
  /** Re-deliver every `open_requests` entry of an RPC result, as a reconnect does. */
  deliverOpen(result: unknown): void
  /** Deliver one `event` notification. */
  emit(params: Record<string, unknown>): void
  /** Every frame written back to Hermes, decoded. */
  frames(): Array<Record<string, unknown>>
  /** The `result` written for `id`, or `undefined` when none was. */
  answer(id: string): Record<string, unknown> | undefined
  /** The JSON-RPC `error` written for `id`, if the request was refused. */
  refusal(id: string): { code?: number; message?: string } | undefined
  /**
   * Make `request.answer` report that Hermes had already settled the request,
   * as it does once another attached user answered it.
   */
  expireAnswers(): void
  /** Answer RPCs fail like an older Hermes that has no `request.answer`. */
  withoutAnswerMethod(): void
  /** Answer RPCs fail with a lost acknowledgement. */
  breakAnswers(): void
  /** Drop the socket: later writes are swallowed and `connected()` is false. */
  disconnect(): void
  reconnect(): void
}

export function serverRequests(): ServerRequestsHarness {
  const written: Array<Record<string, unknown>> = []
  const listeners = new Set<(event: unknown) => void>()
  let open = true
  const channel = new JsonRpcRequestChannel({
    onEvent: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
  })
  const socket = {
    send(text: string) {
      if (!open) throw new Error("socket closed")
      written.push(JSON.parse(text) as Record<string, unknown>)
    },
  }
  channel.attach(socket)
  let sequence = 0
  let answers: "ok" | "expired" | "missing" | "broken" = "ok"
  const frameFor = (id: string, member: "result" | "error") =>
    written.find((frame) => frame.id === id && frame[member] !== undefined)?.[
      member
    ]

  return {
    transport: {
      onRequest: (handler) => channel.onRequest(handler),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      connected: () => open,
      // `request.answer` carries the frame `resolve_response` would have routed,
      // so an accepted answer lands where a response frame does and `answer(id)`
      // reads it either way.
      request: async (method, params) => {
        if (method !== "request.answer")
          throw new Error(`unexpected RPC: ${method}`)
        if (answers === "missing")
          throw new HermesRpcRejectedError(JSON_RPC_METHOD_NOT_FOUND)
        if (answers === "broken") throw new Error("socket closed")
        if (answers === "ok")
          written.push({
            jsonrpc: "2.0",
            id: params.id as string,
            result: params.result as Record<string, unknown>,
          })
        return { status: answers === "ok" ? "ok" : "expired" }
      },
    },
    deliver(method, params, options = {}) {
      sequence += 1
      const id = options.id ?? `srq-${sequence.toString(16).padStart(12, "0")}`
      if (options.replayed) channel.deliverRequest(id, method, params, true)
      else
        channel.handleFrame(
          JSON.stringify({ jsonrpc: "2.0", id, method, params })
        )
      return id
    },
    deliverOpen(result) {
      const open_requests = (result as { open_requests?: unknown })
        ?.open_requests
      if (!Array.isArray(open_requests)) return
      for (const entry of open_requests as Array<Record<string, unknown>>)
        channel.deliverRequest(
          entry.id as string,
          entry.method as string,
          (entry.params ?? {}) as Record<string, unknown>,
          true
        )
    },
    emit(params) {
      channel.handleFrame(
        JSON.stringify({ jsonrpc: "2.0", method: "event", params })
      )
    },
    frames: () => written,
    answer: (id) =>
      frameFor(id, "result") as Record<string, unknown> | undefined,
    refusal: (id) =>
      frameFor(id, "error") as { code?: number; message?: string } | undefined,
    expireAnswers() {
      answers = "expired"
    },
    withoutAnswerMethod() {
      answers = "missing"
    },
    breakAnswers() {
      answers = "broken"
    },
    disconnect() {
      open = false
      channel.detach(new Error("socket closed"))
    },
    reconnect() {
      open = true
      channel.attach(socket)
    },
  }
}
