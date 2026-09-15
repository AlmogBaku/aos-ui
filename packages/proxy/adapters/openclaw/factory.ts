import type { RuntimeLimits } from "../../config"
import { SessionCoordinator } from "../../core/session-coordinator"
import type { RuntimeInstance } from "../../core/runtime"
import { OpenClawServerAdapter } from "./adapter"

/**
 * The integration owner supplies the configured device/client and run leaves.
 * This local factory deliberately has no configuration parsing or secret I/O.
 */
export async function createOpenClawRuntime(input: {
  id: string
  limits: RuntimeLimits
  adapter: OpenClawServerAdapter
}): Promise<RuntimeInstance> {
  const sessions = new SessionCoordinator({
    engine: input.adapter.runs,
    maxActiveExecutions: input.limits.activeExecutions,
    maxGuestActiveExecutions: input.limits.guestActiveExecutions,
    maxSubscriberEvents: input.limits.subscriberEvents,
    maxSubscriberBytes: input.limits.subscriberBytes,
    maxReplayEvents: input.limits.subscriberEvents,
    maxReplayBytes: input.limits.subscriberBytes,
  })
  let closePromise: Promise<void> | undefined
  return {
    id: input.id,
    runtime: input.adapter,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        await input.adapter.close()
      })
      return closePromise
    },
  }
}
