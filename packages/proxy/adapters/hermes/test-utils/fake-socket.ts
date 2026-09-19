/**
 * FakeSocket — a listener-map test double for `HermesSocket`.
 *
 * Drives `gateway.ts` / `gateway-socket.ts` the way Hermes drives a real
 * socket: text frames, a close event carrying a native close code, and the
 * `gateway.ready` / `gateway.ping` / `event` / server-request frames of the
 * pinned upstream protocol.
 *
 * Usage:
 *
 *   const socket = new FakeSocket()
 *   const gateway = new HermesGateway({
 *     socketFactory: () => { queueMicrotask(() => socket.open()); return socket },
 *     ...
 *   })
 *   socket.deliver({ method: "event", params: { type: "message.delta" } })
 *   socket.reply(socket.lastRequest().id, { profiles: [] })
 *
 * Auto-reply: while `autoReply` is true, `send()` answers any outgoing frame
 * carrying an `id` with `{ profiles: [] }` (and any `gateway.ping` with the
 * upstream pong) on a microtask, so a test that does not care about the
 * response can issue a request without hanging. Set `autoReply = false` to
 * take full control of the wire.
 */

import type { HermesSocket } from "../gateway-socket"

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

export class FakeSocket implements HermesSocket {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSED = CLOSED

  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readyState = CONNECTING
  sent: string[] = []
  /** Close code observed by `close()`, or `undefined` while still open. */
  closedWith: number | undefined
  autoReply = true

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: string): void {
    this.sent.push(value)
    if (!this.autoReply) return
    const frame = JSON.parse(value) as { id?: string; method?: string }
    if (!frame.id) return
    queueMicrotask(() => {
      if (this.readyState !== OPEN) return
      this.reply(
        frame.id!,
        frame.method === "gateway.ping" ? { ok: true } : { profiles: [] }
      )
    })
  }

  /** Close the socket and dispatch the close event Hermes would send. */
  close(code = 1006): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.closedWith = code
    this.emit("close", { code })
  }

  // -------------------------------------------------------------------------
  // Test drivers
  // -------------------------------------------------------------------------

  /** Transition readyState to OPEN and fire the "open" event. */
  open(): void {
    if (this.readyState === CLOSED) return
    this.readyState = OPEN
    this.emit("open", {})
  }

  /** Fire a transport-level "error" event without closing the socket. */
  fail(): void {
    this.emit("error", {})
  }

  /** Fire a listener set (equivalent to dispatchEvent). */
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event)
  }

  /** Deliver one already-serialized inbound frame. */
  deliverText(data: unknown): void {
    this.emit("message", { data })
  }

  /** Deliver one inbound JSON-RPC frame (`jsonrpc: "2.0"` is added). */
  deliver(frame: Record<string, unknown>): void {
    this.deliverText(this.serverFrame(frame))
  }

  /** Deliver a successful response for `id`. */
  reply(id: string, result: unknown): void {
    this.deliver({ id, result })
  }

  /** Deliver a JSON-RPC error response for `id`. */
  replyError(id: string, error: Record<string, unknown>): void {
    this.deliver({ id, error })
  }

  /** Deliver an `event` notification with the given params. */
  deliverEvent(params: Record<string, unknown>): void {
    this.deliver({ method: "event", params })
  }

  /** Deliver the first frame of the pinned protocol. */
  deliverReady(
    payload: Record<string, unknown> = { heartbeat: true, replay_epoch: "e1" }
  ): void {
    this.deliverEvent({ type: "gateway.ready", payload })
  }

  /** Answer every `gateway.ping` frame sent so far with the upstream pong. */
  pong(): void {
    for (const frame of this.requests())
      if (frame.method === "gateway.ping" && typeof frame.id === "string")
        this.reply(frame.id, { ok: true })
  }

  /**
   * Encode `frame` as a JSON-RPC frame string. Pass the result to
   * `deliverText` (or `{ data: … }` when emitting by hand).
   */
  serverFrame(frame: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", ...frame })
  }

  /** Every frame written by the client, decoded. */
  requests(): Array<Record<string, unknown>> {
    return this.sent.map(
      (value) => JSON.parse(value) as Record<string, unknown>
    )
  }

  /** Frames written by the client for `method`, decoded. */
  requestsFor(method: string): Array<Record<string, unknown>> {
    return this.requests().filter((frame) => frame.method === method)
  }

  /**
   * Decode and return the last frame written by the client, or `undefined` if
   * nothing has been written yet.
   */
  lastRequest(): Record<string, unknown> | undefined {
    const last = this.sent[this.sent.length - 1]
    if (!last) return undefined
    return JSON.parse(last) as Record<string, unknown>
  }
}
