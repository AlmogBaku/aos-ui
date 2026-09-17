/**
 * rpcRouter — a lightweight fake HermesRpcTransport for unit tests.
 *
 * Modelled on the repeated `request = vi.fn(...)` routers in
 * adapter.test.ts:31-55 and slash-commands.test.ts:15-30.
 *
 * Usage:
 *
 *   const router = rpcRouter({
 *     "session.resume": async () => ({ session_id: "live-secret", running: false }),
 *     "commands.catalog": async () => ({ pairs: [] }),
 *   })
 *   const adapter = new HermesServerAdapter(router)
 *
 *   // Later: drive native events into any observeEvents subscriber
 *   router.publish({ type: "session.info", session_id: "live-secret",
 *                    seq: 1, payload: { running: false } })
 *
 *   // Assert: which methods were called and with what params?
 *   expect(router.calls("session.resume")).toHaveLength(1)
 */

import type { HermesRpcOptions, HermesRpcTransport } from "../gateway"

export type RpcHandler = (
  params: Readonly<Record<string, unknown>>
) => Promise<unknown>

export type RpcRouter = HermesRpcTransport & {
  /** Publish an event to all active observeEvents subscribers. */
  publish(event: unknown): void
  /** Return all recorded calls for `method`, newest-last. */
  calls(method: string): Array<{
    params: Readonly<Record<string, unknown>>
    maxResponseBytes: number | undefined
  }>
}

/**
 * Build a fake `HermesRpcTransport` from a map of method handlers.
 *
 * Defaults:
 *  - `session.resume` → `{ session_id: "live-secret", running: false }`
 *  - Any method without a handler throws `Error("unexpected RPC: <method>")`.
 *
 * The returned object records every `request()` call for later assertion.
 * `observeEvents` and `close` are stubs that track subscriptions; call
 * `publish(event)` to fan out to all active listeners.
 */
export function rpcRouter(
  handlers: Partial<Record<string, RpcHandler>> = {}
): RpcRouter {
  const effectiveHandlers: Record<string, RpcHandler> = {
    "session.resume": async () => ({
      session_id: "live-secret",
      running: false,
    }),
    ...handlers,
  }

  const callLog = new Map<
    string,
    Array<{
      params: Readonly<Record<string, unknown>>
      maxResponseBytes: number | undefined
    }>
  >()
  const subscribers: Array<(event: unknown) => void> = []

  function recordCall(
    method: string,
    params: Readonly<Record<string, unknown>>,
    maxResponseBytes: number | undefined
  ) {
    let entries = callLog.get(method)
    if (!entries) {
      entries = []
      callLog.set(method, entries)
    }
    entries.push({ params, maxResponseBytes })
  }

  const transport: RpcRouter = {
    async request(
      method: string,
      params: Readonly<Record<string, unknown>>,
      options?: HermesRpcOptions
    ): Promise<unknown> {
      recordCall(method, params, options?.maxResponseBytes)
      const handler = effectiveHandlers[method]
      if (!handler) throw new Error(`unexpected RPC: ${method}`)
      return handler(params)
    },

    observeEvents: async (
      listener: (event: unknown) => void
    ): Promise<() => void> => {
      subscribers.push(listener)
      return () => {
        const index = subscribers.indexOf(listener)
        if (index !== -1) subscribers.splice(index, 1)
      }
    },

    close: async (): Promise<void> => {
      subscribers.splice(0)
    },

    publish(event: unknown): void {
      for (const listener of subscribers.slice()) listener(event)
    },

    calls(method: string): Array<{
      params: Readonly<Record<string, unknown>>
      maxResponseBytes: number | undefined
    }> {
      return callLog.get(method) ?? []
    },
  }

  return transport
}
