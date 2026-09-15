import {
  GatewaySessionMessageSubscriptionCoordinator,
  type GatewaySessionMessageSubscription,
} from "@openclaw/gateway-client"
import {
  AgentEventSchema,
  ChatEventSchema,
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  type EventFrame,
  type SessionApprovalReplay,
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
  readonly key: string
  readonly approvalReplayKey: string | undefined
  approvalReplay():
    Readonly<{ generation: number; replay: SessionApprovalReplay }> | undefined
  takeApprovalDirty(): boolean
  refreshApprovalReplay(): Promise<void>
  release(): Promise<void>
}>

export type OpenClawReconciliationFence = Readonly<{
  dirty(): boolean
}>

type LogicalLease = {
  scope: OpenClawSubscriptionScope
  listener: (event: EventFrame) => void
  reconcile?: (
    reason: "gap" | "reconnect",
    fence: OpenClawReconciliationFence
  ) => void | Promise<void>
  native?: GatewaySessionMessageSubscription
  nativeGeneration: number
  approvalReplayKey?: string
  approvalDirty: boolean
  released: boolean
  dirty: boolean
}

function validIdentity(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function scopedSessionAgentId(key: string) {
  return /^agent:([^:]+):/i.exec(key)?.[1]
}

function approvalReplayMatchesRequest(
  replay: SessionApprovalReplay,
  acknowledgementKey: string,
  requestedKey: unknown,
  expectedAgentId: unknown
) {
  if (
    !validIdentity(requestedKey) ||
    !validIdentity(expectedAgentId) ||
    !validIdentity(replay.sessionKey)
  )
    return false
  const requestedAgentId = scopedSessionAgentId(requestedKey as string)
  const acknowledgementAgentId = scopedSessionAgentId(acknowledgementKey)
  const normalizedAgentId = (expectedAgentId as string).trim().toLowerCase()
  const expectedReplayKey =
    acknowledgementKey.trim().toLowerCase() === "global"
      ? `agent:${normalizedAgentId}:global`
      : acknowledgementKey
  return (
    (requestedAgentId === undefined || requestedAgentId === expectedAgentId) &&
    (acknowledgementAgentId === undefined ||
      acknowledgementAgentId === expectedAgentId) &&
    replay.sessionKey === expectedReplayKey
  )
}

function validNativeEvent(frame: unknown): frame is EventFrame {
  if (!isGatewayEventFrame(frame)) return false
  if (frame.event === "chat") return Check(ChatEventSchema, frame.payload)
  if (frame.event === "session.approval")
    return Check(SessionApprovalEventSchema, frame.payload)
  if (frame.event !== "agent" && frame.event !== "session.tool") return false
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

function eventMatchesScope(
  frame: EventFrame,
  scope: OpenClawSubscriptionScope
) {
  const payload = frame.payload as Record<string, unknown>
  if (frame.event !== "session.approval")
    return payload.agentId === undefined || payload.agentId === scope.agentId
  const approval = payload.approval as Record<string, unknown>
  const presentation = approval.presentation as Record<string, unknown>
  return presentation.agentId === scope.agentId
}

export class OpenClawSessionSubscriptions {
  readonly #client: OpenClawSubscriptionRequestClient
  #coordinator: GatewaySessionMessageSubscriptionCoordinator
  readonly #leases = new Set<LogicalLease>()
  #generation = 1
  #transition: Promise<void> = Promise.resolve()
  #paused = false
  readonly #buffer: EventFrame[] = []

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
    reconcile?: (
      reason: "gap" | "reconnect",
      fence: OpenClawReconciliationFence
    ) => void | Promise<void>
  ): Promise<OpenClawSessionLease> {
    if (!validIdentity(scope.agentId) || !validIdentity(scope.sessionKey))
      throw new Error("Invalid OpenClaw Session subscription scope")
    return this.#enqueue(async () => {
      const generation = this.#generation
      const logical: LogicalLease = {
        scope,
        listener,
        ...(reconcile ? { reconcile } : {}),
        nativeGeneration: generation,
        approvalDirty: false,
        released: false,
        dirty: false,
      }
      this.#leases.add(logical)
      try {
        logical.native = await this.#coordinator.acquire(scope.sessionKey, {
          agentId: scope.agentId,
          includeApprovals: true,
        })
        logical.nativeGeneration = generation
        logical.approvalReplayKey = Check(
          SessionApprovalReplaySchema,
          logical.native.approvalReplay
        )
          ? logical.native.approvalReplay.sessionKey
          : undefined
        return this.#lease(logical)
      } catch (error) {
        logical.released = true
        this.#leases.delete(logical)
        throw error
      }
    })
  }

  accept(candidate: unknown, generation: number) {
    if (generation !== this.#generation || !validNativeEvent(candidate)) return
    const payload = candidate.payload as Record<string, unknown>
    const sessionKey = payload.sessionKey as string
    if (candidate.event === "session.approval")
      for (const lease of this.#leases)
        if (
          !lease.released &&
          lease.native === undefined &&
          eventMatchesScope(candidate, lease.scope)
        )
          lease.approvalDirty = true
    const matching = [...this.#leases].filter(
      (lease) =>
        !lease.released &&
        (lease.scope.sessionKey === sessionKey ||
          lease.native?.key === sessionKey ||
          lease.approvalReplayKey === sessionKey) &&
        eventMatchesScope(candidate, lease.scope)
    )
    if (this.#paused) {
      for (const lease of matching) lease.dirty = true
      if (this.#buffer.length < 4_096) this.#buffer.push(candidate)
      return
    }
    for (const lease of matching) {
      try {
        lease.listener(candidate)
      } catch {
        // One downstream native observer cannot disrupt another Session.
      }
    }
  }

  replaceGeneration(reason: "gap" | "reconnect") {
    this.#generation += 1
    const generation = this.#generation
    this.#paused = true
    this.#buffer.splice(0)
    for (const lease of this.#leases) lease.dirty = true
    return this.#enqueue(async () => {
      this.#coordinator.reset()
      this.#coordinator = this.#createCoordinator()
      for (const lease of this.#leases) {
        if (lease.released) continue
        lease.native = await this.#coordinator.acquire(lease.scope.sessionKey, {
          agentId: lease.scope.agentId,
          includeApprovals: true,
        })
        lease.nativeGeneration = generation
        lease.approvalReplayKey = Check(
          SessionApprovalReplaySchema,
          lease.native.approvalReplay
        )
          ? lease.native.approvalReplay.sessionKey
          : undefined
      }
      let dirty: boolean
      do {
        const leases = [...this.#leases].filter((lease) => !lease.released)
        for (const lease of leases) lease.dirty = false
        for (const lease of leases)
          await lease.reconcile?.(reason, { dirty: () => lease.dirty })
        dirty = leases.some((lease) => !lease.released && lease.dirty)
      } while (generation === this.#generation && dirty)
      if (generation === this.#generation) {
        this.#buffer.splice(0)
        this.#paused = false
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
          const acknowledgement = result as Record<string, unknown>
          if (
            acknowledgement.approvalReplay !== undefined &&
            (!Check(
              SessionApprovalReplaySchema,
              acknowledgement.approvalReplay
            ) ||
              !approvalReplayMatchesRequest(
                acknowledgement.approvalReplay as SessionApprovalReplay,
                acknowledgement.key as string,
                params.key,
                params.agentId
              ))
          )
            throw new Error("Invalid OpenClaw approval replay")
        }
        return result
      },
    })
  }

  #lease(logical: LogicalLease): OpenClawSessionLease {
    const subscriptions = this
    return {
      get key() {
        return logical.native?.key ?? logical.scope.sessionKey
      },
      get approvalReplayKey() {
        return !logical.released &&
          logical.nativeGeneration === subscriptions.#generation
          ? logical.approvalReplayKey
          : undefined
      },
      approvalReplay: () => {
        if (
          logical.released ||
          logical.nativeGeneration !== this.#generation ||
          !Check(SessionApprovalReplaySchema, logical.native?.approvalReplay)
        )
          return undefined
        return {
          generation: logical.nativeGeneration,
          replay: structuredClone(logical.native.approvalReplay),
        }
      },
      takeApprovalDirty: () => {
        const dirty = logical.approvalDirty
        logical.approvalDirty = false
        return dirty
      },
      refreshApprovalReplay: () =>
        this.#enqueue(async () => {
          if (logical.released) return
          const previous = logical.native
          const generation = this.#generation
          const native = await this.#coordinator.acquire(
            logical.scope.sessionKey,
            {
              agentId: logical.scope.agentId,
              includeApprovals: true,
            }
          )
          logical.native = native
          logical.nativeGeneration = generation
          logical.approvalReplayKey = Check(
            SessionApprovalReplaySchema,
            native.approvalReplay
          )
            ? native.approvalReplay.sessionKey
            : undefined
          if (previous) await this.#coordinator.release(previous)
        }),
      release: async () => {
        await this.#enqueue(async () => {
          if (logical.released) return
          logical.released = true
          this.#leases.delete(logical)
          if (logical.native) await this.#coordinator.release(logical.native)
        })
      },
    }
  }
}
