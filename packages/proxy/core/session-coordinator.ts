import {
  RunEventKind,
  isUncertainError,
  pendingRequestsOf,
  type ExecutionEvent,
  type PendingRequest,
  type RunEvent,
} from "./events"

import {
  ServerRunConflictError,
  ServerRunCapacityError,
  ServerRunControlError,
  ServerRunStopNotDispatchedError,
  ServerRunSteerUnavailableError,
  type NewTurnRunInput,
  type RecoveryRequest,
  type ResumeRunInput,
  type ServerAttachmentStage,
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
  event: RunEvent
}

export type CoordinatorAccess = {
  subscriberId: string
  controllerId: string
  lane: "operator" | "guest"
  canControl: boolean
  project?(event: RunEvent): RunEvent | undefined
  onDetach?(): void
  /** Owns request-scoped resources until the provider outcome is known. */
  onTerminal?(event: RunEvent): void | Promise<void>
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
  cacheKey: string
  runId: string
  handle: ServerRunHandle
  fanout: SubscriberFanout<SequencedRunEvent>
  journal?: {
    replay: Array<{ value: SequencedRunEvent; bytes: number }>
    replayBytes: number
  }
  replay: Array<{ value: SequencedRunEvent; bytes: number }>
  replayBytes: number
  replayOverflow: boolean
  nextSequence: number
  terminal: boolean
  interrupts: PendingRequest[]
  onTerminal?: (event: RunEvent) => void | Promise<void>
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
const MAX_ACTIVE_RUN_JOURNALS = 5

function scopeKey(scope: Pick<SessionScope, "agentId" | "sessionId">) {
  return `${scope.agentId}\u0000${scope.sessionId}`
}

function safeEventBytes(event: RunEvent) {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function compactedEvent(
  previous: RunEvent,
  next: RunEvent
): RunEvent | undefined {
  if (
    previous.timestamp !== undefined ||
    previous.rawEvent !== undefined ||
    previous.metadata !== undefined ||
    next.timestamp !== undefined ||
    next.rawEvent !== undefined ||
    next.metadata !== undefined
  )
    return undefined
  if (
    previous.type === RunEventKind.TEXT_MESSAGE_CONTENT &&
    next.type === RunEventKind.TEXT_MESSAGE_CONTENT &&
    previous.messageId === next.messageId &&
    previous.subagentRunId === next.subagentRunId
  )
    return { ...previous, delta: previous.delta + next.delta }
  if (
    previous.type === RunEventKind.REASONING_MESSAGE_CONTENT &&
    next.type === RunEventKind.REASONING_MESSAGE_CONTENT &&
    previous.messageId === next.messageId &&
    previous.subagentRunId === next.subagentRunId
  )
    return { ...previous, delta: previous.delta + next.delta }
  if (
    previous.type === RunEventKind.TOOL_CALL_ARGS &&
    next.type === RunEventKind.TOOL_CALL_ARGS &&
    previous.toolCallId === next.toolCallId &&
    previous.subagentRunId === next.subagentRunId
  )
    return { ...previous, delta: previous.delta + next.delta }
  return undefined
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

function sameInterrupts(expected: readonly string[], input: ResumeRunInput) {
  const received = input.resume.map(({ interruptId }) => interruptId)
  return (
    expected.length > 0 &&
    expected.length === received.length &&
    expected.every((id) => received.includes(id)) &&
    new Set(received).size === received.length
  )
}

export class SessionCoordinator {
  readonly #executions = new Map<string, Execution>()
  readonly #journals = new Map<string, Segment>()
  readonly #admissions = new Set<string>()
  readonly #recoveries = new Map<string, Promise<Execution>>()
  readonly #discoveries = new Map<string, Promise<Execution | undefined>>()
  readonly #observers = new Set<(event: ExecutionEvent) => void>()
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
      : { state: "idle" as const, interrupts: [] as PendingRequest[] }
  }

  /**
   * Workspace-wide execution feed: one listener sees the lifecycle of every
   * Session this coordinator drives, independent of the per-segment run
   * subscriptions and their replay.
   */
  observe(listener: (event: ExecutionEvent) => void) {
    this.#observers.add(listener)
    return () => {
      this.#observers.delete(listener)
    }
  }

  async discover(scope: SessionScope) {
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (
      !this.options.engine.discover ||
      (existing && existing.state !== "waiting-for-input")
    )
      return existing
    const inFlight = this.#discoveries.get(key)
    if (inFlight) return inFlight
    const discovery = this.#discover(scope, key, existing)
    this.#discoveries.set(key, discovery)
    void discovery
      .finally(() => {
        if (this.#discoveries.get(key) === discovery)
          this.#discoveries.delete(key)
      })
      .catch(() => undefined)
    return discovery
  }

  async #discover(
    scope: SessionScope,
    key: string,
    existing: Execution | undefined
  ) {
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    if (!existing) this.#assertCapacity("operator")
    this.#admissions.add(key)
    try {
      const runId =
        existing?.segment.runId ?? `aos-recovered-${crypto.randomUUID()}`
      const discovered = await this.options.engine.discover!(scope, runId)
      if (!discovered) {
        if (existing && this.#executions.get(key) === existing) {
          this.#resolveAttention(existing)
          this.#forgetJournal(existing.segment)
          existing.segment.fanout.close()
          this.#executions.delete(key)
        }
        return undefined
      }
      const segment = this.#segment(
        key,
        runId,
        discovered.handle,
        undefined,
        false
      )
      this.#trackJournal(segment)
      segment.interrupts = structuredClone(discovered.interrupts ?? [])
      const execution: Execution = existing ?? {
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
      if (existing) {
        this.#forgetJournal(existing.segment)
        existing.segment.fanout.close()
        execution.state = discovered.state
        execution.segment = segment
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
    access: CoordinatorAccess,
    attachments?: ServerAttachmentStage
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
      const handle = await this.options.engine.start(
        scope,
        input,
        ...(attachments ? [attachments] : [])
      )
      const execution: Execution = {
        scope,
        state: "running",
        admissionId: input.runId,
        admissionFingerprint: admissionFingerprint(input),
        startedByLane: access.lane,
        controllers: new Set(access.canControl ? [access.controllerId] : []),
        segment: this.#segment(key, input.runId, handle, access.onTerminal),
        control: Promise.resolve(),
        steeringRequests: new Map(),
      }
      this.#executions.set(key, execution)
      this.#trackJournal(execution.segment)
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
    if (
      request.after === undefined &&
      existing?.segment.runId === request.runId &&
      existing.state !== "uncertain"
    ) {
      if (!existing.segment.journal)
        return this.#resetSubscription(existing.segment, access)
      if (access.canControl) existing.controllers.add(access.controllerId)
      this.#touchJournal(existing.segment)
      return this.#subscribeJournal(existing.segment, access)
    }
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
        key,
        request.runId,
        handle,
        existing?.segment.onTerminal,
        false
      )
      if (existing) this.#forgetJournal(existing.segment)
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
      this.#trackJournal(segment)
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
      try {
        const status = await execution.segment.handle.stop()
        execution.state = status === "idle" ? "idle" : "stopping"
        // Stopping a wait ends it without an answer.
        if (status === "idle") this.#resolveAttention(execution)
        return status
      } catch (error) {
        if (error instanceof ServerRunStopNotDispatchedError) {
          execution.state = "running"
          throw error.failure
        }
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
        type: RunEventKind.CUSTOM,
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
      const segment = this.#segment(key, input.runId, handle)
      this.#resolveAttention(execution)
      this.#forgetJournal(execution.segment)
      execution.segment = segment
      execution.control = Promise.resolve()
      execution.steeringRequests = new Map()
      execution.admissionId = input.runId
      execution.admissionFingerprint = admissionFingerprint(input)
      execution.state = "running"
      if (access.canControl) execution.controllers.add(access.controllerId)
      this.#trackJournal(segment)
      this.#consume(execution, segment)
      return this.#subscribe(segment, 0, access)
    } finally {
      this.#admissions.delete(key)
    }
  }

  /** Scope and clock every observed `ExecutionEvent` carries. */
  #origin(scope: SessionScope, runId: string) {
    return {
      agentId: scope.agentId,
      // Observers project to the browser, which knows only public identity.
      sessionId: scope.threadId,
      runId,
      occurredAt: new Date().toISOString(),
    }
  }

  #announce(event: ExecutionEvent) {
    for (const observer of [...this.#observers])
      try {
        observer(event)
      } catch {
        // An observer must not rewrite the provider outcome.
      }
  }

  /** A wait answered elsewhere, ended, or cleared resolves its requests. */
  #resolveAttention(execution: Execution) {
    const { interrupts, runId } = execution.segment
    if (interrupts.length === 0) return
    const origin = this.#origin(execution.scope, runId)
    for (const { id } of interrupts)
      this.#announce({ ...origin, type: "attention-resolved", interruptId: id })
  }

  #segment(
    cacheKey: string,
    runId: string,
    handle: ServerRunHandle,
    onTerminal?: (event: RunEvent) => void | Promise<void>,
    journalComplete = true
  ): Segment {
    return {
      cacheKey,
      runId,
      handle,
      fanout: new SubscriberFanout<SequencedRunEvent>({
        maxEvents: this.options.maxSubscriberEvents,
        maxBytes: this.options.maxSubscriberBytes,
        sizeOf: ({ event }) => safeEventBytes(event),
      }),
      journal: journalComplete ? { replay: [], replayBytes: 0 } : undefined,
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
    // One start per consumed segment: a new turn, a resume, or a recovered
    // run. A rediscovered wait is not a start, so it announces nothing here.
    if (execution.state === "running")
      this.#announce({
        ...this.#origin(execution.scope, segment.runId),
        type: "run-started",
      })
    void (async () => {
      let terminal = false
      try {
        for await (const event of segment.handle.events) {
          if (execution.segment !== segment) return
          if (
            event.type === RunEventKind.RUN_FINISHED ||
            event.type === RunEventKind.RUN_ERROR
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
          this.#rememberJournal(segment, sequenced)
          this.#remember(segment, sequenced)
          segment.fanout.publish(sequenced)
          if (event.type === RunEventKind.RUN_FINISHED) {
            this.#forgetJournal(segment)
            terminal = true
            segment.terminal = true
            segment.interrupts = pendingRequestsOf(event)
            execution.state = segment.interrupts.length
              ? "waiting-for-input"
              : "idle"
            const origin = this.#origin(execution.scope, segment.runId)
            if (segment.interrupts.length)
              for (const request of segment.interrupts)
                this.#announce({
                  ...origin,
                  type: "attention-requested",
                  request: structuredClone(request),
                })
            else this.#announce({ ...origin, type: "run-finished" })
            break
          }
          if (event.type === RunEventKind.RUN_ERROR) {
            this.#forgetJournal(segment)
            terminal = true
            segment.terminal = true
            execution.state = isUncertainError(event) ? "uncertain" : "idle"
            this.#announce({
              ...this.#origin(execution.scope, segment.runId),
              type: "run-failed",
            })
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

  #rememberJournal(segment: Segment, value: SequencedRunEvent) {
    const journal = segment.journal
    if (!journal) return
    const previous = journal.replay.at(-1)
    const compacted = previous
      ? compactedEvent(previous.value.event, value.event)
      : undefined
    const bytes = safeEventBytes(compacted ?? value.event)
    const nextBytes = compacted
      ? journal.replayBytes - previous!.bytes + bytes
      : journal.replayBytes + bytes
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > this.options.maxReplayBytes ||
      nextBytes > this.options.maxReplayBytes
    ) {
      segment.journal = undefined
      this.#journals.delete(segment.cacheKey)
      return
    }
    if (compacted && previous) {
      previous.value = { sequence: value.sequence, event: compacted }
      previous.bytes = bytes
    } else journal.replay.push({ value, bytes })
    journal.replayBytes = nextBytes
    this.#touchJournal(segment)
  }

  #trackJournal(segment: Segment) {
    if (!segment.journal) return
    const previous = this.#journals.get(segment.cacheKey)
    if (previous && previous !== segment) previous.journal = undefined
    this.#journals.delete(segment.cacheKey)
    this.#journals.set(segment.cacheKey, segment)
    while (this.#journals.size > MAX_ACTIVE_RUN_JOURNALS) {
      const oldestKey = this.#journals.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this.#journals.get(oldestKey)
      this.#journals.delete(oldestKey)
      if (oldest) oldest.journal = undefined
    }
  }

  #touchJournal(segment: Segment) {
    if (this.#journals.get(segment.cacheKey) !== segment) return
    this.#journals.delete(segment.cacheKey)
    this.#journals.set(segment.cacheKey, segment)
  }

  #forgetJournal(segment: Segment) {
    if (this.#journals.get(segment.cacheKey) === segment)
      this.#journals.delete(segment.cacheKey)
    segment.journal = undefined
  }

  #publish(segment: Segment, event: RunEvent) {
    const sequenced = { sequence: ++segment.nextSequence, event }
    this.#rememberJournal(segment, sequenced)
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

  #subscribeJournal(segment: Segment, access: CoordinatorAccess) {
    const project = (value: SequencedRunEvent) => {
      const event = access.project ? access.project(value.event) : value.event
      return event ? { sequence: value.sequence, event } : undefined
    }
    const live = segment.fanout.subscribe(project, access.onDetach)
    const barrier = segment.nextSequence
    const replay = segment.journal?.replay.map(({ value }) => value) ?? []
    const events: AsyncIterable<SequencedRunEvent> = {
      [Symbol.asyncIterator]: async function* () {
        try {
          for (const value of replay) {
            const projected = project(value)
            if (projected) yield projected
          }
          for await (const value of live.events) {
            if (value.sequence > barrier) yield value
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

  #resetSubscription(segment: Segment, access: CoordinatorAccess) {
    const candidate: SequencedRunEvent = {
      sequence: segment.nextSequence + 1,
      event: {
        type: RunEventKind.RUN_ERROR,
        code: "AOS_RESET_REQUIRED",
        message: "AOS run history must be reloaded before continuing.",
      },
    }
    const event = access.project
      ? access.project(candidate.event)
      : candidate.event
    const events: AsyncIterable<SequencedRunEvent> = {
      async *[Symbol.asyncIterator]() {
        if (event) yield { sequence: candidate.sequence, event }
      },
    }
    return { runId: segment.runId, events, close: () => undefined }
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
