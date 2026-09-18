import { EventType, type AGUIEvent, type Interrupt } from "@ag-ui/core"

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

/** One journaled event and the memory its raw form occupies. */
type JournalEntry = { value: SequencedRunEvent; bytes: number }

/**
 * The one replay store of a run segment: every event it delivered, keyed by run
 * sequence, so a cursor-bearing redial and a cursorless reload read the same
 * history. Adjacent deltas merge only when the journal is read, which keeps a
 * cursor exact and still spares a reload thousands of single-character events.
 */
type SegmentJournal = {
  entries: JournalEntry[]
  /** Bytes a replay of the whole journal occupies once deltas merge. */
  bytes: number
  /** Events a replay of the whole journal emits once deltas merge. */
  events: number
  /** Bytes the raw entries still held occupy, which is what memory costs. */
  retained: number
  /**
   * First run sequence this journal still holds contiguously, or zero while
   * nothing has been pruned and every cursor of the run is answerable.
   */
  firstSequence: number
  /**
   * The compacted trailing event of the journal. A delta that merges into it
   * replaces its bytes instead of adding a whole event, so both bounds measure
   * the replay a subscriber actually receives.
   */
  tail?: { event: AGUIEvent; bytes: number }
  /** The journal holds the run from its first event, so a reload replays it. */
  fromStart: boolean
}

type Segment = {
  cacheKey: string
  runId: string
  handle: ServerRunHandle
  fanout: SubscriberFanout<SequencedRunEvent>
  journal?: SegmentJournal
  nextSequence: number
  terminal: boolean
  interrupts: Interrupt[]
  onTerminal?: (event: AGUIEvent) => void | Promise<void>
  /**
   * Resolves once the provider has spoken for this segment: its first event, or
   * the outcome this coordinator applied when its stream ended. An uncertain
   * turn waits for that signal instead of for a timer.
   */
  spoken: Promise<void>
  announce: () => void
}

/** How a segment relates to the replayable history of its run. */
type SegmentHistory =
  /** First segment of a run: its own journal, its own sequence. */
  | { journal: "start" }
  /** Later segment of the same run: continues the replaced segment's journal. */
  | { journal: "continue"; previous?: Segment }
  /** A provider run AOS never streamed from its beginning. */
  | { journal: "none" }

function freshJournal(fromStart: boolean): SegmentJournal {
  return {
    entries: [],
    bytes: 0,
    events: 0,
    retained: 0,
    firstSequence: 0,
    fromStart,
  }
}

/**
 * A segment inherits the journal of the segment it replaces, so one run keeps
 * one replayable history and one monotonic sequence. A segment that joins a run
 * already in progress starts an empty journal a reload must not replay as the
 * beginning of that run.
 */
function segmentJournal(history: SegmentHistory): SegmentJournal {
  if (history.journal === "continue" && history.previous)
    return history.previous.journal ?? freshJournal(false)
  return freshJournal(history.journal !== "none")
}

type SegmentInit = {
  cacheKey: string
  runId: string
  handle: ServerRunHandle
  history: SegmentHistory
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

/** Every field one admitted turn owns, shared by a new and a restarted one. */
type AdmittedTurn = Pick<
  Execution,
  | "state"
  | "admissionId"
  | "admissionFingerprint"
  | "segment"
  | "control"
  | "steeringRequests"
>

type TurnInit = {
  state: SessionExecutionState
  runId: string
  /** Exact admission request this turn is fingerprinted from. */
  request: unknown
  segment: Segment
}

type ExecutionInit = TurnInit & {
  scope: SessionScope
  startedByLane: "operator" | "guest"
  controllers?: readonly string[]
}

/**
 * One place decides what admitting a turn means, so a field can never be
 * threaded at three construction sites and forgotten at the fourth.
 */
function admittedTurn(init: TurnInit): AdmittedTurn {
  return {
    state: init.state,
    admissionId: init.runId,
    admissionFingerprint: admissionFingerprint(init.request),
    segment: init.segment,
    control: Promise.resolve(),
    steeringRequests: new Map(),
  }
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

function compactedEvent(
  previous: AGUIEvent,
  next: AGUIEvent
): AGUIEvent | undefined {
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
    previous.type === EventType.TEXT_MESSAGE_CONTENT &&
    next.type === EventType.TEXT_MESSAGE_CONTENT &&
    previous.messageId === next.messageId &&
    previous.subagentRunId === next.subagentRunId
  )
    return { ...previous, delta: previous.delta + next.delta }
  if (
    previous.type === EventType.REASONING_MESSAGE_CONTENT &&
    next.type === EventType.REASONING_MESSAGE_CONTENT &&
    previous.messageId === next.messageId &&
    previous.subagentRunId === next.subagentRunId
  )
    return { ...previous, delta: previous.delta + next.delta }
  if (
    previous.type === EventType.TOOL_CALL_ARGS &&
    next.type === EventType.TOOL_CALL_ARGS &&
    previous.toolCallId === next.toolCallId &&
    previous.subagentRunId === next.subagentRunId
  )
    return { ...previous, delta: previous.delta + next.delta }
  return undefined
}

/**
 * The events a subscriber positioned at `after` must receive from a journal:
 * adjacent deltas merge, so a reload replays one event per message instead of
 * one per token, and a cursor never repeats a delta already delivered.
 */
function compactedReplay(
  entries: readonly JournalEntry[],
  after: number
): SequencedRunEvent[] {
  const replay: SequencedRunEvent[] = []
  let runStarted = false
  for (const { value } of entries) {
    if (value.sequence <= after) continue
    // One run replays as one run: a recovered segment repeats RUN_STARTED, and
    // a second one would make the replay an invalid AG-UI stream.
    if (value.event.type === EventType.RUN_STARTED) {
      if (runStarted) continue
      runStarted = true
    }
    const previous = replay.at(-1)
    const compacted = previous
      ? compactedEvent(previous.event, value.event)
      : undefined
    if (compacted) replay[replay.length - 1] = { ...value, event: compacted }
    else replay.push(value)
  }
  return replay
}

/** What one segment can still answer for a subscriber positioned at `after`. */
type ReplayPlan =
  /** The journal replays from the cursor, then the live stream continues. */
  | "history"
  /** The browser owns the run so far, so its live events alone answer it. */
  | "live"
  /** Only authoritative history can answer this cursor. */
  | "reset"

/**
 * How one journal answers a subscriber positioned at `after`.
 *
 * A cursorless reload owns no part of the run, so only a journal that holds the
 * run from its first event answers it. Any other cursor needs the journal to
 * prove the events after it are contiguous, which a pruned prefix no longer
 * does. A cursor of zero comes from a browser that owns no events of this
 * stream either: a fresh reader, or one that just reloaded the authoritative
 * history after a reset, so a segment that is still streaming answers it from
 * its live events alone.
 */
function replayPlan(segment: Segment, after: number | undefined): ReplayPlan {
  const journal = segment.journal
  if (after === undefined) return journal?.fromStart ? "history" : "reset"
  if (journal && after + 1 >= journal.firstSequence) return "history"
  if (after === 0 && !segment.terminal) return "live"
  return "reset"
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

/**
 * A provider stream can end without a terminal AG-UI event. The provider's own
 * settlement decides the turn then; only an unresolved one stays uncertain.
 * One macrotask lets a settlement raced with the stream ending arrive first.
 *
 * This race is the one timer core keeps, and it is deliberate: a settlement that
 * never arrives must still leave the turn uncertain, so the decision cannot wait
 * on the settlement signal alone. A test on fake timers therefore has to advance
 * the clock to observe a segment whose stream ended without a terminal event.
 */
function settledNow(settled: Promise<void>) {
  return Promise.race([
    settled.then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ])
}

function uncertainError(event: AGUIEvent) {
  return (
    event.type === EventType.RUN_ERROR &&
    (event.code === "AOS_SEND_UNCERTAIN" ||
      event.code === "AOS_INTERACTION_UNCERTAIN" ||
      event.code === "AOS_CONNECTION_INTERRUPTED")
  )
}

export class SessionCoordinator {
  readonly #executions = new Map<string, Execution>()
  readonly #journals = new Map<string, Segment>()
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
          this.#forgetJournal(existing.segment)
          existing.segment.fanout.close()
          this.#executions.delete(key)
        }
        return undefined
      }
      const segment = this.#createSegment({
        cacheKey: key,
        runId,
        handle: discovered.handle,
        // AOS never saw this run start, so it has nothing to replay.
        history: { journal: "none" },
      })
      this.#trackJournal(segment)
      segment.interrupts = structuredClone(discovered.interrupts ?? [])
      const execution: Execution =
        existing ??
        this.#createExecution({
          scope,
          state: discovered.state,
          runId,
          request: { threadId: scope.threadId, runId },
          startedByLane: "operator",
          segment,
        })
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
      // A retried admission reads the run from its beginning, so a journal that
      // no longer holds that beginning answers it with its live events alone.
      // For an already-terminal segment that plan is `reset`, and this path
      // deliberately answers it as an empty live stream rather than a reset: the
      // duplicate admission is not the browser's live reader, and the reader's
      // own redial is where a reset is authoritative and acted upon.
      const plan = replayPlan(existing.segment, 0)
      return this.#subscribe(
        existing.segment,
        0,
        access,
        plan === "history" ? "history" : "live"
      )
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

    if (existing && existing.state !== "idle") {
      if (
        existing.state !== "uncertain" ||
        !(await this.#settleUncertain(scope, existing, access))
      )
        throw new ServerRunConflictError()
    }
    this.#assertCapacity(access.lane)
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#admissions.add(key)
    try {
      const handle = await this.options.engine.start(
        scope,
        input,
        ...(attachments ? [attachments] : [])
      )
      const execution: Execution = this.#createExecution({
        scope,
        state: "running",
        runId: input.runId,
        request: input,
        startedByLane: access.lane,
        controllers: access.canControl ? [access.controllerId] : [],
        segment: this.#createSegment({
          cacheKey: key,
          runId: input.runId,
          handle,
          history: { journal: "start" },
          onTerminal: access.onTerminal,
        }),
      })
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
      existing?.segment.runId === request.runId &&
      existing.state !== "uncertain"
    ) {
      const plan = replayPlan(existing.segment, request.after)
      if (plan === "reset")
        return this.#resetSubscription(existing.segment, access)
      if (access.canControl) existing.controllers.add(access.controllerId)
      this.#touchJournal(existing.segment)
      return this.#subscribe(existing.segment, request.after ?? 0, access, plan)
    }

    if (existing && existing.segment.runId !== request.runId)
      throw new ServerRunConflictError()
    const recovered = await this.#recovery(scope, request, access, existing)
    if (recovered.segment.runId !== request.runId)
      throw new ServerRunConflictError()
    // A recovery that replaced a known execution continues its sequence, so the
    // browser cursor still applies. A recovery of a run this coordinator never
    // streamed numbers the segment from one, and that cursor means nothing.
    const after = existing ? request.after : undefined
    const plan = replayPlan(recovered.segment, after)
    if (plan === "reset")
      return this.#resetSubscription(recovered.segment, access)
    if (access.canControl) recovered.controllers.add(access.controllerId)
    return this.#subscribe(recovered.segment, after ?? 0, access, plan)
  }

  #recovery(
    scope: SessionScope,
    request: CoordinatorRecoveryRequest,
    access: CoordinatorAccess,
    existing: Execution | undefined
  ) {
    const key = scopeKey(scope)
    const inFlight = this.#recoveries.get(key)
    if (inFlight) return inFlight
    this.#assertCapacity(existing?.startedByLane ?? access.lane, existing)
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    const recovery = this.#recoverExecution(scope, request, access, existing)
    this.#recoveries.set(key, recovery)
    void recovery
      .finally(() => {
        if (this.#recoveries.get(key) === recovery) this.#recoveries.delete(key)
      })
      .catch(() => undefined)
    return recovery
  }

  /**
   * The provider decides whether an uncertain run is over. A recovery that
   * settles it clears the way for this turn; a run that keeps streaming, and a
   * recovery that cannot be reached, stay authoritative.
   */
  async #settleUncertain(
    scope: SessionScope,
    execution: Execution,
    access: CoordinatorAccess
  ) {
    const key = scopeKey(scope)
    let recovered: Execution
    try {
      recovered = await this.#recovery(
        scope,
        { threadId: scope.threadId, runId: execution.segment.runId },
        access,
        execution
      )
    } catch {
      return false
    }
    // The provider answers this: the recovered segment either reports the
    // outcome of the run or speaks as a run that is still streaming. Waiting on
    // that signal is what keeps an already-terminal recovery, however many
    // turns of the event loop it takes, from reading as a conflict.
    await recovered.segment.spoken
    return this.#executions.get(key)?.state === "idle"
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
      // A handle that cannot name where this browser stopped reading recovers
      // without a position: a fabricated one would never match a real epoch.
      const position = existing?.segment.handle.recoveryPosition()
      const providerRequest: RecoveryRequest = {
        threadId: request.threadId,
        runId: request.runId,
        ...(position ? { position } : {}),
      }
      const handle = await this.options.engine.recover(scope, providerRequest)
      const replaced = existing?.segment
      const segment = this.#createSegment({
        cacheKey: key,
        runId: request.runId,
        handle,
        // One run keeps one journal and one monotonic sequence across its
        // segments: a browser cursor can never skip a recovered event.
        history: { journal: "continue", previous: replaced },
        onTerminal: replaced?.onTerminal,
      })
      if (replaced) this.#forgetJournal(replaced)
      const execution: Execution =
        existing ??
        this.#createExecution({
          scope,
          state: "running",
          runId: request.runId,
          request: providerRequest,
          startedByLane: access.lane,
          segment,
        })
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
      const segment = this.#createSegment({
        cacheKey: key,
        runId: input.runId,
        handle,
        history: { journal: "start" },
      })
      this.#forgetJournal(execution.segment)
      // A resumed turn is a fresh admission on the same execution record.
      Object.assign(
        execution,
        admittedTurn({
          state: "running",
          runId: input.runId,
          request: input,
          segment,
        })
      )
      if (access.canControl) execution.controllers.add(access.controllerId)
      this.#trackJournal(segment)
      this.#consume(execution, segment)
      return this.#subscribe(segment, 0, access)
    } finally {
      this.#admissions.delete(key)
    }
  }

  #createExecution(init: ExecutionInit): Execution {
    return {
      scope: init.scope,
      startedByLane: init.startedByLane,
      controllers: new Set(init.controllers ?? []),
      ...admittedTurn(init),
    }
  }

  #createSegment(init: SegmentInit): Segment {
    const previous =
      init.history.journal === "continue" ? init.history.previous : undefined
    let announce = () => {}
    const spoken = new Promise<void>((resolve) => {
      announce = resolve
    })
    return {
      spoken,
      announce,
      cacheKey: init.cacheKey,
      runId: init.runId,
      handle: init.handle,
      fanout: new SubscriberFanout<SequencedRunEvent>({
        maxEvents: this.options.maxSubscriberEvents,
        maxBytes: this.options.maxSubscriberBytes,
        sizeOf: ({ event }) => safeEventBytes(event),
      }),
      journal: segmentJournal(init.history),
      nextSequence: previous?.nextSequence ?? 0,
      terminal: false,
      interrupts: [],
      ...(init.onTerminal ? { onTerminal: init.onTerminal } : {}),
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
          // A recoverable interrupt is not part of the run: journaling it would
          // replay a failure the provider never reported.
          const interrupted = uncertainError(event)
          if (!interrupted) this.#remember(segment, sequenced)
          segment.fanout.publish(sequenced)
          segment.announce()
          if (event.type === EventType.RUN_FINISHED) {
            this.#forgetJournal(segment)
            terminal = true
            segment.terminal = true
            segment.interrupts = eventInterrupts(event)
            execution.state = segment.interrupts.length
              ? "waiting-for-input"
              : "idle"
            break
          }
          if (event.type === EventType.RUN_ERROR) {
            // The journal outlives an interrupt so a reload after recovery
            // still replays this run from its beginning.
            if (!interrupted) this.#forgetJournal(segment)
            terminal = true
            segment.terminal = true
            execution.state = interrupted ? "uncertain" : "idle"
            break
          }
        }
      } catch {
        // A stream that throws ended like any other stream without a terminal
        // event: the provider's settlement below is what decides the turn.
      } finally {
        segment.fanout.close()
        if (!terminal && execution.segment === segment) {
          const settled = await settledNow(segment.handle.settled)
          if (execution.segment === segment)
            execution.state = settled ? "idle" : "uncertain"
        }
        segment.announce()
      }
    })()
  }

  /**
   * A run that outgrows either replay bound loses its journal. A subscriber the
   * rest of the segment cannot answer is then sent one reset instead of a
   * partial history.
   */
  #remember(segment: Segment, value: SequencedRunEvent) {
    const journal = segment.journal
    if (!journal) return
    const previous = journal.tail
    const merged = previous
      ? compactedEvent(previous.event, value.event)
      : undefined
    // A merged delta extends the trailing event of the replay, so it costs the
    // growth of that event and not another whole event.
    const tail = merged
      ? { event: merged, bytes: safeEventBytes(merged) }
      : { event: value.event, bytes: safeEventBytes(value.event) }
    const bytes =
      journal.bytes - (merged && previous ? previous.bytes : 0) + tail.bytes
    const events = journal.events + (merged ? 0 : 1)
    // The raw event is what a cursor replays exactly, so what it retains is its
    // own size and not the compacted one it merges into.
    const retained = merged ? safeEventBytes(value.event) : tail.bytes
    if (
      !Number.isSafeInteger(tail.bytes) ||
      !Number.isSafeInteger(retained) ||
      events > this.options.maxReplayEvents ||
      bytes > this.options.maxReplayBytes
    ) {
      this.#forgetJournal(segment)
      return
    }
    journal.entries.push({ value, bytes: retained })
    journal.bytes = bytes
    journal.events = events
    journal.retained += retained
    journal.tail = tail
    this.#prune(journal)
    this.#touchJournal(segment)
  }

  /**
   * Compaction bounds the replay one journal delivers, not the raw events it
   * keeps to make a cursor exact, so a flood of single-character deltas is held
   * to the same byte ceiling by dropping the oldest of them. What survives
   * still replays a cursor inside it exactly; every older cursor, and every
   * cursorless reload, is owed authoritative history instead.
   */
  #prune(journal: SegmentJournal) {
    while (journal.retained > this.options.maxReplayBytes) {
      const oldest = journal.entries.shift()
      if (!oldest) break
      journal.retained -= oldest.bytes
      journal.fromStart = false
      journal.firstSequence =
        journal.entries[0]?.value.sequence ?? oldest.value.sequence + 1
    }
  }

  #trackJournal(segment: Segment) {
    if (!segment.journal) return
    const previous = this.#journals.get(segment.cacheKey)
    if (previous && previous !== segment) previous.journal = undefined
    this.#journals.delete(segment.cacheKey)
    this.#journals.set(segment.cacheKey, segment)
    // One Session streams one run at a time and every journal is bounded on its
    // own, so the execution limit bounds the journals a browser can still be
    // reading. A live run is journaling events, which keeps it recently used,
    // so what this trims is the leftover of a Session nobody is streaming.
    while (this.#journals.size > this.options.maxActiveExecutions) {
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

  /**
   * One subscribe path for every browser: the journal answers from `after` (0
   * for a reload that owns nothing yet), then the live stream continues. A
   * browser that already owns the run so far reads the live stream alone.
   */
  #subscribe(
    segment: Segment,
    after: number,
    access: CoordinatorAccess,
    plan: Exclude<ReplayPlan, "reset"> = "history"
  ) {
    const project = (value: SequencedRunEvent) => {
      const event = access.project ? access.project(value.event) : value.event
      return event ? { sequence: value.sequence, event } : undefined
    }
    const live = segment.fanout.subscribe(project, access.onDetach)
    const replay =
      plan === "history"
        ? compactedReplay(segment.journal?.entries ?? [], after)
        : []
    const events: AsyncIterable<SequencedRunEvent> = {
      [Symbol.asyncIterator]: async function* () {
        let last = after
        try {
          for (const value of replay) {
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

  #resetSubscription(segment: Segment, access: CoordinatorAccess) {
    const candidate: SequencedRunEvent = {
      sequence: segment.nextSequence + 1,
      event: {
        type: EventType.RUN_ERROR,
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
