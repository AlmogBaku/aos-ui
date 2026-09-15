import { EventType, type AGUIEvent, type Interrupt } from "@ag-ui/core"

import {
  ServerRunConflictError,
  ServerRunCapacityError,
  ServerRunControlError,
  ServerRunSteerUnavailableError,
  type NewTurnRunInput,
  type RecoveryRequest,
  type ResumeRunInput,
  type ServerRunEngine,
  type ServerRunHandle,
  type SessionScope,
} from "./runtime"
import type { RunSteerRequest, RunSteerResponse } from "../../protocol"
import { SubscriberFanout } from "./subscriber-fanout"

export type SessionExecutionState =
  "idle" | "running" | "stopping" | "waiting-for-input" | "uncertain"

export type SequencedRunEvent = {
  sequence: number
  event: AGUIEvent
}

export type CoordinatorAccess = {
  subscriberId: string
  controllerId: string
  lane: "operator" | "guest"
  canControl: boolean
  project?(event: AGUIEvent): AGUIEvent | undefined
  onDetach?(): void
  /** Owns request-scoped resources until the provider outcome is known. */
  onTerminal?(event: AGUIEvent): void | Promise<void>
}

export type CoordinatorRecoveryRequest = Pick<
  RecoveryRequest,
  "threadId" | "runId"
> & {
  after?: number
}

export type CoordinatedRunSubscription = {
  runId: string
  events: AsyncIterable<SequencedRunEvent>
  close(): void
}

export type SessionCoordinatorOptions = {
  engine: ServerRunEngine
  maxActiveExecutions: number
  maxGuestActiveExecutions: number
  maxSubscriberEvents: number
  maxSubscriberBytes: number
  maxReplayEvents: number
  maxReplayBytes: number
}

type Segment = {
  runId: string
  handle: ServerRunHandle
  fanout: SubscriberFanout<SequencedRunEvent>
  replay: Array<{ value: SequencedRunEvent; bytes: number }>
  replayBytes: number
  replayOverflow: boolean
  nextSequence: number
  terminal: boolean
  interrupts: Interrupt[]
  onTerminal?: (event: AGUIEvent) => void | Promise<void>
}

type Execution = {
  scope: SessionScope
  state: SessionExecutionState
  admissionId: string
  admissionFingerprint: string
  startedByLane: "operator" | "guest"
  controllers: Set<string>
  segment: Segment
  control: Promise<void>
  steeringRequests: Map<
    string,
    { fingerprint: string; result: Promise<RunSteerResponse> }
  >
}

const MAX_STEERING_REQUESTS_PER_EXECUTION = 256

function scopeKey(scope: Pick<SessionScope, "agentId" | "sessionId">) {
  return `${scope.agentId}\u0000${scope.sessionId}`
}

function safeEventBytes(event: AGUIEvent) {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function admissionFingerprint(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical)
    if (!candidate || typeof candidate !== "object") return candidate
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)])
    )
  }
  return JSON.stringify(canonical(value))
}

function isResume(
  input: NewTurnRunInput | ResumeRunInput
): input is ResumeRunInput {
  return Array.isArray(input.resume) && input.resume.length > 0
}

function eventInterrupts(event: AGUIEvent): Interrupt[] {
  if (event.type !== EventType.RUN_FINISHED) return []
  const outcome = event.outcome
  if (
    !outcome ||
    typeof outcome !== "object" ||
    !("type" in outcome) ||
    outcome.type !== "interrupt" ||
    !("interrupts" in outcome) ||
    !Array.isArray(outcome.interrupts)
  )
    return []
  return outcome.interrupts
}

function sameInterrupts(expected: readonly string[], input: ResumeRunInput) {
  const received = input.resume.map(({ interruptId }) => interruptId)
  return (
    expected.length > 0 &&
    expected.length === received.length &&
    expected.every((id) => received.includes(id)) &&
    new Set(received).size === received.length
  )
}

function uncertainError(event: AGUIEvent) {
  return (
    event.type === EventType.RUN_ERROR &&
    (event.code === "AOS_SEND_UNCERTAIN" ||
      event.code === "AOS_INTERACTION_UNCERTAIN" ||
      event.code === "AOS_CONNECTION_INTERRUPTED" ||
      event.code === "AOS_RESET_REQUIRED")
  )
}

export class SessionCoordinator {
  readonly #executions = new Map<string, Execution>()
  readonly #admissions = new Set<string>()
  readonly #recoveries = new Map<string, Promise<Execution>>()
  readonly #discoveries = new Map<string, Promise<Execution | undefined>>()
  #closed = false

  constructor(private readonly options: SessionCoordinatorOptions) {
    for (const value of [
      options.maxActiveExecutions,
      options.maxGuestActiveExecutions,
      options.maxSubscriberEvents,
      options.maxSubscriberBytes,
      options.maxReplayEvents,
      options.maxReplayBytes,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid Session coordinator limits")
  }

  state(scope: Pick<SessionScope, "agentId" | "sessionId">) {
    return this.#executions.get(scopeKey(scope))?.state ?? "idle"
  }

  snapshot(scope: Pick<SessionScope, "agentId" | "sessionId">) {
    const execution = this.#executions.get(scopeKey(scope))
    return execution
      ? {
          state: execution.state,
          runId: execution.segment.runId,
          interrupts: structuredClone(execution.segment.interrupts),
        }
      : { state: "idle" as const, interrupts: [] as Interrupt[] }
  }

  async discover(scope: SessionScope) {
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (existing || !this.options.engine.discover) return existing
    const inFlight = this.#discoveries.get(key)
    if (inFlight) return inFlight
    const discovery = this.#discover(scope, key)
    this.#discoveries.set(key, discovery)
    void discovery
      .finally(() => {
        if (this.#discoveries.get(key) === discovery)
          this.#discoveries.delete(key)
      })
      .catch(() => undefined)
    return discovery
  }

  async #discover(scope: SessionScope, key: string) {
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#assertCapacity("operator")
    this.#admissions.add(key)
    try {
      const runId = `aos-recovered-${crypto.randomUUID()}`
      const discovered = await this.options.engine.discover!(scope, runId)
      if (!discovered) return undefined
      const segment = this.#segment(runId, discovered.handle)
      segment.interrupts = structuredClone(discovered.interrupts ?? [])
      const execution: Execution = {
        scope,
        state: discovered.state,
        admissionId: runId,
        admissionFingerprint: admissionFingerprint({
          threadId: scope.threadId,
          runId,
        }),
        startedByLane: "operator",
        controllers: new Set(),
        segment,
        control: Promise.resolve(),
        steeringRequests: new Map(),
      }
      this.#executions.set(key, execution)
      this.#consume(execution, segment)
      return execution
    } finally {
      this.#admissions.delete(key)
    }
  }

  async start(
    scope: SessionScope,
    input: NewTurnRunInput | ResumeRunInput,
    access: CoordinatorAccess
  ): Promise<CoordinatedRunSubscription> {
    if (this.#closed) throw new Error("Session coordinator is closed")
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (existing?.segment.runId === input.runId) {
      if (existing.admissionFingerprint !== admissionFingerprint(input))
        throw new ServerRunConflictError()
      if (access.canControl) existing.controllers.add(access.controllerId)
      return this.#subscribe(existing.segment, 0, access)
    }

    if (isResume(input)) {
      if (
        !existing ||
        existing.state !== "waiting-for-input" ||
        !sameInterrupts(
          existing.segment.interrupts.map(({ id }) => id),
          input
        )
      )
        throw new ServerRunConflictError()
      return this.#startSegment(existing, input, access)
    }

    if (existing && existing.state !== "idle")
      throw new ServerRunConflictError()
    this.#assertCapacity(access.lane)
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#admissions.add(key)
    try {
      const handle = await this.options.engine.start(scope, input)
      const execution: Execution = {
        scope,
        state: "running",
        admissionId: input.runId,
        admissionFingerprint: admissionFingerprint(input),
        startedByLane: access.lane,
        controllers: new Set(access.canControl ? [access.controllerId] : []),
        segment: this.#segment(input.runId, handle, access.onTerminal),
        control: Promise.resolve(),
        steeringRequests: new Map(),
      }
      this.#executions.set(key, execution)
      this.#consume(execution, execution.segment)
      return this.#subscribe(execution.segment, 0, access)
    } finally {
      this.#admissions.delete(key)
    }
  }

  async recover(
    scope: SessionScope,
    request: CoordinatorRecoveryRequest,
    access: CoordinatorAccess
  ): Promise<CoordinatedRunSubscription> {
    if (this.#closed) throw new Error("Session coordinator is closed")
    if (request.threadId !== scope.threadId)
      throw new Error("Recovery scope does not match this Session")
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    const after = request.after ?? 0
    if (
      existing?.segment.runId === request.runId &&
      !existing.segment.replayOverflow &&
      existing.state !== "uncertain"
    ) {
      if (access.canControl) existing.controllers.add(access.controllerId)
      return this.#subscribe(existing.segment, after, access)
    }

    if (existing && existing.segment.runId !== request.runId)
      throw new ServerRunConflictError()
    let recovery = this.#recoveries.get(key)
    if (!recovery) {
      this.#assertCapacity(existing?.startedByLane ?? access.lane, existing)
      if (this.#admissions.has(key)) throw new ServerRunConflictError()
      recovery = this.#recoverExecution(scope, request, access, existing)
      this.#recoveries.set(key, recovery)
      void recovery
        .finally(() => {
          if (this.#recoveries.get(key) === recovery)
            this.#recoveries.delete(key)
        })
        .catch(() => undefined)
    }
    const recovered = await recovery
    if (recovered.segment.runId !== request.runId)
      throw new ServerRunConflictError()
    if (access.canControl) recovered.controllers.add(access.controllerId)
    return this.#subscribe(recovered.segment, 0, access)
  }

  async #recoverExecution(
    scope: SessionScope,
    request: CoordinatorRecoveryRequest,
    access: CoordinatorAccess,
    existing: Execution | undefined
  ) {
    const key = scopeKey(scope)
    this.#admissions.add(key)
    try {
      const providerRequest: RecoveryRequest = {
        threadId: request.threadId,
        runId: request.runId,
        ...(existing
          ? { position: existing.segment.handle.recoveryPosition() }
          : {}),
      }
      const handle = await this.options.engine.recover(scope, providerRequest)
      const segment = this.#segment(
        request.runId,
        handle,
        existing?.segment.onTerminal
      )
      const execution: Execution = existing
        ? existing
        : {
            scope,
            state: "running",
            admissionId: request.runId,
            admissionFingerprint: admissionFingerprint(providerRequest),
            startedByLane: access.lane,
            controllers: new Set<string>(),
            segment,
            control: Promise.resolve(),
            steeringRequests: new Map(),
          }
      if (existing) existing.segment.fanout.close()
      execution.state = "running"
      execution.segment = segment
      if (access.canControl) execution.controllers.add(access.controllerId)
      this.#executions.set(key, execution)
      this.#consume(execution, segment)
      return execution
    } finally {
      this.#admissions.delete(key)
    }
  }

  async stop(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    controllerId: string
  ) {
    const execution = this.#executions.get(scopeKey(scope))
    if (!execution || execution.state === "idle") return "idle" as const
    return this.#withControl(execution, async () => {
      if (!execution.controllers.has(controllerId))
        throw new ServerRunControlError()
      if (execution.state === "stopping") return "stopping" as const
      try {
        const status = await execution.segment.handle.stop()
        execution.state = status === "idle" ? "idle" : "stopping"
        return status
      } catch (error) {
        execution.state = "uncertain"
        throw error
      }
    })
  }

  async steer(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    request: RunSteerRequest,
    controllerId: string
  ): Promise<RunSteerResponse> {
    const execution = this.#executions.get(scopeKey(scope))
    if (
      !execution ||
      execution.state !== "running" ||
      execution.segment.runId !== request.expectedRunId
    )
      throw new ServerRunConflictError()
    if (!execution.controllers.has(controllerId))
      throw new ServerRunControlError()

    const fingerprint = admissionFingerprint({
      expectedRunId: request.expectedRunId,
      text: request.text,
    })
    const existing = execution.steeringRequests.get(request.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ServerRunConflictError()
      return existing.result
    }

    const result = this.#withControl(execution, async () => {
      if (
        execution.state !== "running" ||
        execution.segment.runId !== request.expectedRunId
      )
        throw new ServerRunConflictError()
      const steer = execution.segment.handle.steer
      if (!steer) throw new ServerRunSteerUnavailableError()
      const delivery = await steer({
        requestId: request.requestId,
        text: request.text,
      })
      this.#publish(execution.segment, {
        type: EventType.CUSTOM,
        name: "aos.steer.accepted",
        value: {
          requestId: request.requestId,
          text: request.text,
          delivery,
        },
      })
      return { status: delivery }
    })
    execution.steeringRequests.set(request.requestId, { fingerprint, result })
    if (execution.steeringRequests.size > MAX_STEERING_REQUESTS_PER_EXECUTION) {
      const oldest = execution.steeringRequests.keys().next().value
      if (oldest !== undefined) execution.steeringRequests.delete(oldest)
    }
    return result
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const execution of this.#executions.values())
      execution.segment.fanout.close()
  }

  async #startSegment(
    execution: Execution,
    input: ResumeRunInput,
    access: CoordinatorAccess
  ) {
    const key = scopeKey(execution.scope)
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#admissions.add(key)
    try {
      const handle = await this.options.engine.start(execution.scope, input)
      const segment = this.#segment(input.runId, handle)
      execution.segment = segment
      execution.control = Promise.resolve()
      execution.steeringRequests = new Map()
      execution.admissionId = input.runId
      execution.admissionFingerprint = admissionFingerprint(input)
      execution.state = "running"
      if (access.canControl) execution.controllers.add(access.controllerId)
      this.#consume(execution, segment)
      return this.#subscribe(segment, 0, access)
    } finally {
      this.#admissions.delete(key)
    }
  }

  #segment(
    runId: string,
    handle: ServerRunHandle,
    onTerminal?: (event: AGUIEvent) => void | Promise<void>
  ): Segment {
    return {
      runId,
      handle,
      fanout: new SubscriberFanout<SequencedRunEvent>({
        maxEvents: this.options.maxSubscriberEvents,
        maxBytes: this.options.maxSubscriberBytes,
        sizeOf: ({ event }) => safeEventBytes(event),
      }),
      replay: [],
      replayBytes: 0,
      replayOverflow: false,
      nextSequence: 0,
      terminal: false,
      interrupts: [],
      ...(onTerminal ? { onTerminal } : {}),
    }
  }

  #consume(execution: Execution, segment: Segment) {
    void (async () => {
      let terminal = false
      try {
        for await (const event of segment.handle.events) {
          if (execution.segment !== segment) return
          if (
            event.type === EventType.RUN_FINISHED ||
            event.type === EventType.RUN_ERROR
          )
            try {
              await segment.onTerminal?.(event)
            } catch {
              // Resource cleanup must not rewrite the provider outcome.
            }
          const sequenced = {
            sequence: ++segment.nextSequence,
            event,
          }
          this.#remember(segment, sequenced)
          segment.fanout.publish(sequenced)
          if (event.type === EventType.RUN_FINISHED) {
            terminal = true
            segment.terminal = true
            segment.interrupts = eventInterrupts(event)
            execution.state = segment.interrupts.length
              ? "waiting-for-input"
              : "idle"
            break
          }
          if (event.type === EventType.RUN_ERROR) {
            terminal = true
            segment.terminal = true
            execution.state = uncertainError(event) ? "uncertain" : "idle"
            break
          }
        }
      } catch {
        if (execution.segment === segment) execution.state = "uncertain"
      } finally {
        if (!terminal && execution.segment === segment)
          execution.state = "uncertain"
        segment.fanout.close()
      }
    })()
  }

  #remember(segment: Segment, value: SequencedRunEvent) {
    if (segment.replayOverflow) return
    const bytes = safeEventBytes(value.event)
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > this.options.maxReplayBytes ||
      segment.replay.length >= this.options.maxReplayEvents ||
      segment.replayBytes + bytes > this.options.maxReplayBytes
    ) {
      segment.replayOverflow = true
      segment.replay.splice(0)
      segment.replayBytes = 0
      return
    }
    segment.replay.push({ value, bytes })
    segment.replayBytes += bytes
  }

  #publish(segment: Segment, event: AGUIEvent) {
    const sequenced = { sequence: ++segment.nextSequence, event }
    this.#remember(segment, sequenced)
    segment.fanout.publish(sequenced)
  }

  #withControl<T>(execution: Execution, operation: () => Promise<T>) {
    const result = execution.control.then(operation, operation)
    execution.control = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  #subscribe(segment: Segment, after: number, access: CoordinatorAccess) {
    const project = (value: SequencedRunEvent) => {
      const event = access.project ? access.project(value.event) : value.event
      return event ? { sequence: value.sequence, event } : undefined
    }
    const live = segment.fanout.subscribe(project, access.onDetach)
    const replay = segment.replay.map(({ value }) => value)
    const events: AsyncIterable<SequencedRunEvent> = {
      [Symbol.asyncIterator]: async function* () {
        let last = after
        try {
          for (const value of replay) {
            if (value.sequence <= last) continue
            const projected = project(value)
            if (!projected) continue
            last = projected.sequence
            yield projected
          }
          for await (const value of live.events) {
            if (value.sequence <= last) continue
            last = value.sequence
            yield value
          }
        } finally {
          live.close()
        }
      },
    }
    return {
      runId: segment.runId,
      events,
      close: () => live.close(),
    }
  }

  #assertCapacity(lane: "operator" | "guest", existing?: Execution) {
    if (existing) return
    const active = [...this.#executions.values()].filter(
      ({ state }) => state !== "idle"
    )
    if (active.length >= this.options.maxActiveExecutions)
      throw new ServerRunCapacityError("global")
    if (
      lane === "guest" &&
      active.filter(({ startedByLane }) => startedByLane === "guest").length >=
        this.options.maxGuestActiveExecutions
    )
      throw new ServerRunCapacityError("guest")
  }
}
