import { SessionCoordinator } from "../../core/session-coordinator"
import type { RuntimeInstance } from "../../core/runtime"
import type { RuntimeConfig, RuntimeLimits } from "../../config"
import { readSecretFile } from "../../secrets"
import { redactForLog } from "../../redaction"
import { HermesServerAdapter } from "./adapter"
import {
  HermesGateway,
  type HermesGatewayOptions,
  type HermesLog,
  type HermesRpcTransport,
} from "./gateway"

type HermesRuntimeConfig = RuntimeConfig & { kind: "hermes" }

export type HermesRuntimeFactoryDependencies = {
  transportFactory?: (options: HermesGatewayOptions) => HermesRpcTransport
}

/**
 * Redacted server-side gateway log. The gateway only ever passes its own event
 * names and bounded fields — never the token, the dial URL or a native payload
 * — and every line still goes through the proxy's shared `redactForLog` and is
 * written as one structured JSON record, like every other proxy log path.
 */
export function createGatewayLog(
  write: (line: string) => void = (line) => console.warn(line)
): HermesLog {
  return {
    warn(event: string, fields: Record<string, unknown>) {
      write(JSON.stringify(redactForLog({ event, ...fields })))
    },
  }
}

export async function createHermesRuntime(
  config: HermesRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: HermesRuntimeFactoryDependencies = {}
): Promise<RuntimeInstance> {
  const token = await readSecretFile(config.tokenFile)
  const transportFactory =
    dependencies.transportFactory ??
    ((options: HermesGatewayOptions) => new HermesGateway(options))
  // One redacted log for the whole runtime: the gateway reports transport
  // outages, the attachment registry reports rebinding failures, and the native
  // run boundary reports the code of every authoritative Hermes rejection.
  const log = createGatewayLog()
  const transport = transportFactory({
    baseUrl: config.baseUrl,
    credentials: async () => ({ "X-Hermes-Session-Token": token }),
    log,
  })
  // Eager dial: the gateway owns its redial ladder from here, so a Hermes that
  // is not up yet is retried in the background instead of failing whichever
  // request happens to arrive first.
  if (transport instanceof HermesGateway)
    void transport.connect().catch(() => undefined)
  const runtime = new HermesServerAdapter(transport, {
    sessionIdleMs: config.sessionIdleMs,
    log,
  })
  const sessions = new SessionCoordinator({
    engine: runtime.runs,
    maxActiveExecutions: limits.activeExecutions,
    maxGuestActiveExecutions: limits.guestActiveExecutions,
    maxSubscriberEvents: limits.subscriberEvents,
    maxSubscriberBytes: limits.subscriberBytes,
    maxReplayEvents: limits.subscriberEvents,
    maxReplayBytes: limits.subscriberBytes,
  })
  let closePromise: Promise<void> | undefined
  return {
    id: config.id,
    runtime,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        await runtime.close()
      })
      return closePromise
    },
  }
}
