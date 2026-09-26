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

import { backoffDelay, Deadline, type Logger } from "../../../lifecycle"

/** How long a replaced generation may hold delivery while it re-subscribes and reconciles. */
const PAUSE_DEADLINE_MS = 30_000
/** How a lease whose re-subscribe failed tries again. */
const RESUBSCRIBE_BACKOFF = { baseMs: 1_000, capMs: 30_000 }

export interface OpenClawSubscriptionRequestClient {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
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
  const requested = requestedKey as string
  const agentId = expectedAgentId as string
  const mainAlias =
    requested === "main" || requested === `agent:${agentId}:main`
  if (acknowledgementKey === "global")
    return (
      (requested === "global" || mainAlias) &&
      replay.sessionKey === `agent:${agentId}:global`
    )
  if (requested === "global") return false
  if (mainAlias)
    return (
      scopedSessionAgentId(acknowledgementKey) === agentId &&
      replay.sessionKey === acknowledgementKey
    )
  return (
    acknowledgementKey === requested &&
    replay.sessionKey === acknowledgementKey &&
    scopedSessionAgentId(requested) === agentId
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

type Reason = "gap" | "reconnect"

export class OpenClawSessionSubscriptions {
  readonly #client: OpenClawSubscriptionRequestClient
  readonly #logger: Logger
  #coordinator: GatewaySessionMessageSubscriptionCoordinator
  readonly #leases = new Set<LogicalLease>()
  #generation = 1
  #transition: Promise<void> = Promise.resolve()
  /** The generation that holds delivery; only that generation resumes it. */
  #paused: number | undefined
  #retry?: ReturnType<typeof setTimeout>

  constructor(client: OpenClawSubscriptionRequestClient, logger: Logger) {
    this.#client = client
    this.#logger = logger
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
    if (this.#paused !== undefined) {
      for (const lease of matching) lease.dirty = true
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

  /**
   * Holds delivery once the link drops: a new generation refuses the old
   * one's work, and every lease is marked for reconciliation.
   */
  pause() {
    this.#generation += 1
    this.#paused = this.#generation
    clearTimeout(this.#retry)
    for (const lease of this.#leases) lease.dirty = true
    return this.#generation
  }

  /**
   * Re-subscribes every lease on a new generation and reconciles each,
   * holding delivery until then or until the paused deadline passes. A lease
   * that fails to re-subscribe tries again on a capped backoff while the
   * others deliver.
   */
  replaceGeneration(reason: Reason) {
    const generation = this.pause()
    const deadline = new Deadline(PAUSE_DEADLINE_MS)
    deadline.signal.addEventListener("abort", () => this.#resume(generation))
    return this.#enqueue(async () => {
      if (generation !== this.#generation) return
      this.#coordinator.reset()
      this.#coordinator = this.#createCoordinator()
      const leases = [...this.#leases]
      const failed = await this.#resubscribe(leases, generation)
      await this.#reconcile(
        leases.filter((lease) => !failed.includes(lease)),
        reason,
        generation,
        deadline.signal
      )
      if (failed.length > 0) this.#retryLater(failed, reason, generation, 0)
    }).finally(() => {
      deadline.clear()
      this.#resume(generation)
    })
  }

  /** Stops every retry; the client's own stop ends the native subscriptions. */
  close() {
    this.#generation += 1
    clearTimeout(this.#retry)
  }

  #resume(generation: number) {
    if (this.#paused === generation) this.#paused = undefined
  }

  /** Re-acquires each live lease on `generation` and returns the ones that failed. */
  async #resubscribe(leases: readonly LogicalLease[], generation: number) {
    const failed: LogicalLease[] = []
    for (const lease of leases) {
      if (generation !== this.#generation) break
      if (lease.released) continue
      try {
        const native = await this.#coordinator.acquire(lease.scope.sessionKey, {
          agentId: lease.scope.agentId,
          includeApprovals: true,
        })
        if (generation !== this.#generation) break
        lease.native = native
        lease.nativeGeneration = generation
        lease.approvalReplayKey = Check(
          SessionApprovalReplaySchema,
          native.approvalReplay
        )
          ? native.approvalReplay.sessionKey
          : undefined
      } catch (err) {
        this.#logger.warn({ err }, "openclaw.subscription.resubscribe_failed")
        failed.push(lease)
      }
    }
    return failed
  }

  /**
   * Reconciles `leases` until none is dirty, the generation moves on, or
   * `signal` aborts. A failed reconcile is its lease's own to report.
   */
  async #reconcile(
    leases: readonly LogicalLease[],
    reason: Reason,
    generation: number,
    signal?: AbortSignal
  ) {
    let dirty: boolean
    do {
      const live = leases.filter((lease) => !lease.released)
      for (const lease of live) lease.dirty = false
      for (const lease of live) {
        if (generation !== this.#generation) return
        try {
          await lease.reconcile?.(reason, { dirty: () => lease.dirty })
        } catch (err) {
          this.#logger.warn({ err }, "openclaw.subscription.reconcile_failed")
        }
      }
      dirty = live.some((lease) => !lease.released && lease.dirty)
    } while (dirty && generation === this.#generation && !signal?.aborted)
  }

  #retryLater(
    leases: readonly LogicalLease[],
    reason: Reason,
    generation: number,
    attempt: number
  ) {
    if (generation !== this.#generation) return
    clearTimeout(this.#retry)
    this.#retry = setTimeout(
      () => {
        void this.#enqueue(async () => {
          if (generation !== this.#generation) return
          const failed = await this.#resubscribe(leases, generation)
          await this.#reconcile(
            leases.filter((lease) => !failed.includes(lease)),
            reason,
            generation
          )
          if (failed.length > 0)
            this.#retryLater(failed, reason, generation, attempt + 1)
        }).catch((err: unknown) =>
          this.#logger.warn({ err }, "openclaw.subscription.retry_failed")
        )
      },
      backoffDelay(attempt, RESUBSCRIBE_BACKOFF)
    )
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
      request: async <T>(method: string, params: Record<string, unknown>) => {
        const valid =
          method === "sessions.messages.subscribe"
            ? validateSessionsMessagesSubscribeParams(params)
            : method === "sessions.messages.unsubscribe"
              ? validateSessionsMessagesUnsubscribeParams(params)
              : false
        if (!valid) throw new Error("Invalid OpenClaw subscription request")
        const result = await this.#client.request<T>(method, params)
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
    const currentGeneration = () => this.#generation
    return {
      get key() {
        return logical.native?.key ?? logical.scope.sessionKey
      },
      get approvalReplayKey() {
        return !logical.released &&
          logical.nativeGeneration === currentGeneration()
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
