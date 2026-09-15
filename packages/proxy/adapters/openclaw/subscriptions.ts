import {
  GatewaySessionMessageSubscriptionCoordinator,
  type GatewaySessionMessageSubscription,
} from "@openclaw/gateway-client"
import {
  AgentEventSchema,
  ChatEventSchema,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  type EventFrame,
} from "@openclaw/gateway-protocol"
import { isGatewayEventFrame } from "@openclaw/gateway-protocol/frame-guards"
import { Check } from "typebox/value"

export interface OpenClawSubscriptionRequestClient {
  request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number | null }
  ): Promise<T>
}

export type OpenClawSubscriptionScope = Readonly<{
  agentId: string
  sessionKey: string
}>

export type OpenClawSessionLease = Readonly<{
  release(): Promise<void>
}>

type LogicalLease = {
  scope: OpenClawSubscriptionScope
  listener: (event: EventFrame) => void
  reconcile?: (reason: "gap" | "reconnect") => void
  native: GatewaySessionMessageSubscription
  released: boolean
}

function validIdentity(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function validNativeEvent(frame: unknown): frame is EventFrame {
  if (!isGatewayEventFrame(frame)) return false
  if (frame.event === "chat") return Check(ChatEventSchema, frame.payload)
  if (frame.event !== "agent") return false
  if (!frame.payload || typeof frame.payload !== "object") return false
  const payload = frame.payload as Record<string, unknown>
  const core = {
    runId: payload.runId,
    seq: payload.seq,
    stream: payload.stream,
    ts: payload.ts,
    ...(payload.spawnedBy === undefined
      ? {}
      : { spawnedBy: payload.spawnedBy }),
    ...(payload.isHeartbeat === undefined
      ? {}
      : { isHeartbeat: payload.isHeartbeat }),
    data: payload.data,
  }
  return (
    Check(AgentEventSchema, core) &&
    validIdentity(payload.sessionKey) &&
    (payload.agentId === undefined || validIdentity(payload.agentId))
  )
}

export class OpenClawSessionSubscriptions {
  readonly #client: OpenClawSubscriptionRequestClient
  #coordinator: GatewaySessionMessageSubscriptionCoordinator
  readonly #leases = new Set<LogicalLease>()
  #generation = 1
  #transition: Promise<void> = Promise.resolve()

  constructor(client: OpenClawSubscriptionRequestClient) {
    this.#client = client
    this.#coordinator = this.#createCoordinator()
  }

  get generation() {
    return this.#generation
  }

  async acquire(
    scope: OpenClawSubscriptionScope,
    listener: (event: EventFrame) => void,
    reconcile?: (reason: "gap" | "reconnect") => void
  ): Promise<OpenClawSessionLease> {
    if (!validIdentity(scope.agentId) || !validIdentity(scope.sessionKey))
      throw new Error("Invalid OpenClaw Session subscription scope")
    return this.#enqueue(async () => {
      const native = await this.#coordinator.acquire(scope.sessionKey, {
        agentId: scope.agentId,
      })
      const logical: LogicalLease = {
        scope,
        listener,
        ...(reconcile ? { reconcile } : {}),
        native,
        released: false,
      }
      this.#leases.add(logical)
      return this.#lease(logical)
    })
  }

  accept(candidate: unknown, generation: number) {
    if (generation !== this.#generation || !validNativeEvent(candidate)) return
    const payload = candidate.payload as Record<string, unknown>
    const sessionKey = payload.sessionKey as string
    const agentId =
      typeof payload.agentId === "string" ? payload.agentId : undefined
    for (const lease of this.#leases) {
      if (
        lease.released ||
        (lease.scope.sessionKey !== sessionKey &&
          lease.native.key !== sessionKey) ||
        (agentId !== undefined && agentId !== lease.scope.agentId)
      )
        continue
      try {
        lease.listener(candidate)
      } catch {
        // One downstream native observer cannot disrupt another Session.
      }
    }
  }

  async replaceGeneration(reason: "gap" | "reconnect") {
    return this.#enqueue(async () => {
      this.#generation += 1
      this.#coordinator.reset()
      this.#coordinator = this.#createCoordinator()
      for (const lease of this.#leases) {
        if (lease.released) continue
        lease.native = await this.#coordinator.acquire(lease.scope.sessionKey, {
          agentId: lease.scope.agentId,
        })
      }
      for (const lease of this.#leases) {
        if (lease.released) continue
        try {
          lease.reconcile?.(reason)
        } catch {
          // Reconciliation is isolated per normalized Session.
        }
      }
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transition.then(operation)
    this.#transition = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  #createCoordinator() {
    return new GatewaySessionMessageSubscriptionCoordinator({
      request: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: { timeoutMs?: number | null }
      ) => {
        const valid =
          method === "sessions.messages.subscribe"
            ? validateSessionsMessagesSubscribeParams(params)
            : method === "sessions.messages.unsubscribe"
              ? validateSessionsMessagesUnsubscribeParams(params)
              : false
        if (!valid) throw new Error("Invalid OpenClaw subscription request")
        const result = await this.#client.request<T>(method, params, options)
        if (method === "sessions.messages.subscribe") {
          if (
            !result ||
            typeof result !== "object" ||
            !("key" in result) ||
            !validIdentity(result.key)
          )
            throw new Error("Invalid OpenClaw subscription acknowledgement")
        }
        return result
      },
    })
  }

  #lease(logical: LogicalLease): OpenClawSessionLease {
    return {
      release: async () => {
        await this.#enqueue(async () => {
          if (logical.released) return
          logical.released = true
          this.#leases.delete(logical)
          await this.#coordinator.release(logical.native)
        })
      },
    }
  }
}
