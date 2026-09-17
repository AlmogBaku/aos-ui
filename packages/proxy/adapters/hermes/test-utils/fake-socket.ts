/**
 * FakeSocket — an EventTarget-compatible test double for HermesSocket.
 *
 * Moved from transport.test.ts so it can be reused by transport tests and,
 * later, by vendored-client wrapper tests.
 *
 * Usage:
 *
 *   const socket = new FakeSocket()
 *   const transport = new HermesWebSocketRpcTransport({
 *     socketFactory: () => { queueMicrotask(() => socket.open()); return socket },
 *     ...
 *   })
 *   socket.emit("message", { data: socket.serverFrame({ result: {} }) })
 *
 * Auto-reply behaviour: `send()` only echoes back a success result when the
 * outgoing frame carries an `id` field (i.e. a JSON-RPC request).  Notification
 * frames (no `id`) receive no automatic response.  Tests that need to control
 * the response should override `send()` or call `socket.emit("message", …)`
 * directly after sending.
 */

import type { HermesSocket } from "../transport"

export class FakeSocket implements HermesSocket {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readyState = 0
  sent: string[] = []

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
    // Default auto-reply: echo back a successful result so tests that do not
    // override send() can issue a single request without hanging.  Tests that
    // need to control responses should override this method or emit their own
    // "message" event after calling send.
    const frame = JSON.parse(value) as { id?: string }
    if (frame.id) {
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: { profiles: [] },
          }),
        })
      )
    }
  }

  close(): void {
    this.readyState = 3
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Transition readyState to OPEN and fire the "open" event. */
  open(): void {
    this.readyState = 1
    this.emit("open", {})
  }

  /** Fire a listener set (equivalent to dispatchEvent). */
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  /**
   * Encode `obj` as a JSON-RPC "message" event payload string.
   * Pass the result as `{ data: socket.serverFrame(obj) }` to `socket.emit`.
   */
  serverFrame(obj: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", ...obj })
  }

  /**
   * Decode and return the last request frame sent by the transport, or
   * `undefined` if nothing has been sent yet.
   */
  lastRequest(): Record<string, unknown> | undefined {
    const last = this.sent[this.sent.length - 1]
    if (!last) return undefined
    return JSON.parse(last) as Record<string, unknown>
  }
}
