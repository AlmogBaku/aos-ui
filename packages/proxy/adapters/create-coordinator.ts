import type { RuntimeLimits } from "../config"
import type { ServerRuntime } from "../core/runtime"
import { SessionCoordinator } from "../core/session-coordinator"

/**
 * The one Session coordinator a runtime instance runs its turns through, bound
 * by the deployment's limits. Pass the runtime already wrapped by
 * `withMcpApps`, since the coordinator runs turns through `runtime.turns`.
 */
export function createCoordinator(
  runtime: ServerRuntime,
  limits: RuntimeLimits
): SessionCoordinator {
  return new SessionCoordinator({
    engine: runtime.turns,
    readings: runtime,
    maxActiveExecutions: limits.activeExecutions,
    maxGuestActiveExecutions: limits.guestActiveExecutions,
    maxSubscriberEvents: limits.subscriberEvents,
    maxSubscriberBytes: limits.subscriberBytes,
  })
}
