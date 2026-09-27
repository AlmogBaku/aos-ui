import type { Logger } from "../../lifecycle"
import type { RuntimeLimits } from "../config"
import type { RuntimeInstance, ServerRuntime } from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"

/** A server runtime composed over its native server, and how to release it. */
export type ComposedRuntime = Readonly<{
  runtime: ServerRuntime
  /** Releases the runtime and everything composed with it. */
  close(): Promise<void>
}>

/**
 * The instance the proxy serves: the composed runtime behind the one Session
 * coordinator its turns run through, bound by the deployment's limits. Compose
 * the runtime already wrapped by `withMcpApps`, since the coordinator runs
 * turns through `runtime.turns`. Closing stops the coordinator, then releases
 * the runtime, once however often it is called.
 */
export function coordinatedRuntime(
  id: string,
  { runtime, close }: ComposedRuntime,
  limits: RuntimeLimits,
  logger: Logger
): RuntimeInstance {
  const sessions = new SessionCoordinator({
    engine: runtime.turns,
    readings: runtime,
    maxActiveExecutions: limits.activeExecutions,
    maxSubscriberEvents: limits.subscriberEvents,
    maxSubscriberBytes: limits.subscriberBytes,
    logger,
  })
  let closing: Promise<void> | undefined
  return {
    id,
    runtime,
    sessions,
    close() {
      closing ??= Promise.resolve().then(async () => {
        sessions.close()
        await close()
      })
      return closing
    },
  }
}
