import {
  TurnEventKind,
  isAwaitingStopFailure,
  isRedialableFailure,
  pendingRequestsOf,
  type ExecutionEvent,
  type PendingRequest,
  type PromptTurnInput,
  type RepliesTurnInput,
  type RequestReply,
  type TurnEvent,
  type TurnEventOf,
} from "./events"

import {
  ServerRequestStaleError,
  ServerTurnConflictError,
  ServerTurnCapacityError,
  ServerTurnControlError,
  ServerTurnStopNotDispatchedError,
  ServerTurnSteerUnavailableError,
  type RecoveryRequest,
  type ServerAttachmentStage,
  type ServerRuntime,
  type ServerTurnEngine,
  type ServerTurnHandle,
  type SessionScope,
} from "./runtime"
import {
  SessionContextResponseSchema,
  SessionModelsResponseSchema,
  type SessionContextResponse,
  type SessionModelsResponse,
  type TurnSteerRequest,
  type TurnSteerResponse,
} from "../../protocol"
import { SessionReporter, type ReadingListener } from "./session-reporter"
import { SubscriberFanout } from "./subscriber-fanout"

export type SessionExecutionState =
  "idle" | "running" | "stopping" | "waiting-for-input" | "uncertain"

/** One Session's execution as a member reads it, outside the turn stream. */
export type SessionSnapshot = {
  state: SessionExecutionState
  turnId?: string
  /** The requests the turn still waits on: those nobody has answered. */
  requests: PendingRequest[]
  /** The controller that admitted the turn, when this proxy admitted it. */
  startedBy?: string
}

export type SequencedTurnEvent = {
  sequence: number
  event: TurnEvent
}

export type CoordinatorAccess = {
  subscriberId: string
  controllerId: string
  lane: "operator" | "guest"
  canControl: boolean
  onDetach?(): void
  /** Owns request-scoped resources until the provider outcome is known. */
  onTerminal?(event: TurnEvent): void | Promise<void>
}

export type CoordinatorRecoveryRequest = Pick<
  RecoveryRequest,
  "threadId" | "turnId"
> & {
  after?: number
  /** The reader holds part of the turn it cannot position, so it reloads. */
  reset?: true
}

export type CoordinatedTurnSubscription = {
  turnId: string
  events: AsyncIterable<SequencedTurnEvent>
  close(): void
}

export type SessionCoordinatorOptions = {
  engine: ServerTurnEngine
  /** Reads a Session's context window and model catalog for its reporters. */
  readings: Pick<ServerRuntime, "context" | "models">
  maxActiveExecutions: number
  maxGuestActiveExecutions: number
  maxSubscriberEvents: number
  maxSubscriberBytes: number
  maxReplayEvents: number
  maxReplayBytes: number
}

/** What one subscriber takes of its Session's readings. */
export type SessionReadingListeners = {
  usage: ReadingListener<SessionContextResponse>
  /** The model options, once the subscriber reads that the model switched. */
  model: ReadingListener<SessionModelsResponse>
}

/**
 * What an unreadable context window waits before each re-read, in order. The
 * budget is bounded: a provider that has not built its agent within half a
 * minute is not building one, and the next turn owes a reading anyway.
 */
const USAGE_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
]

/** One journaled event and the memory its raw form occupies. */
type JournalEntry = { value: SequencedTurnEvent; bytes: number }

/**
 * The one replay store of a turn segment: every event it delivered, keyed by turn
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
   * First turn sequence this journal still holds contiguously, or zero while
   * nothing has been pruned and every cursor of the turn is answerable.
   */
  firstSequence: number
  /**
   * The compacted trailing event of the journal. A delta that merges into it
   * replaces its bytes instead of adding a whole event, so both bounds measure
   * the replay a subscriber actually receives.
   */
  tail?: { event: TurnEvent; bytes: number }
  /** The journal holds the turn from its first event, so a reload replays it. */
  fromStart: boolean
}

type Segment = {
  cacheKey: string
  turnId: string
  handle: ServerTurnHandle
  fanout: SubscriberFanout<SequencedTurnEvent>
  journal?: SegmentJournal
  nextSequence: number
  terminal: boolean
  requests: PendingRequest[]
  /** The answers given so far to `requests`, by requestId: first one wins. */
  answers: Map<string, RequestReply>
  onTerminal?: (event: TurnEvent) => void | Promise<void>
  /**
   * Epoch ms the turn's replay starts from: its admission, the answer that
   * continued it, or the native start an adopted turn reported. Absent for a
   * turn joined midway, or adopted without a start.
   */
  startedAt?: number
  /**
   * Resolves once the provider has spoken for this segment: its first event, or
   * the outcome this coordinator applied when its stream ended. An uncertain
   * turn waits for that signal instead of for a timer.
   */
  spoken: Promise<void>
  announce: () => void
}

/** How a segment relates to the replayable history of its turn. */
type SegmentHistory =
  /**
   * First segment of a turn, which began at `at` when that is known: its own
   * journal and sequence.
   */
  | { journal: "start"; at: number | undefined }
  /** Later segment of the same turn: continues the replaced segment's journal. */
  | { journal: "continue"; previous?: Segment }
  /** A provider turn AOS never streamed from its beginning. */
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
 * A segment inherits the journal of the segment it replaces, so one turn keeps
 * one replayable history and one monotonic sequence. A segment that joins a turn
 * already in progress starts an empty journal a reload must not replay as the
 * beginning of that turn.
 */
function segmentJournal(history: SegmentHistory): SegmentJournal {
  if (history.journal === "continue" && history.previous)
    return history.previous.journal ?? freshJournal(false)
  return freshJournal(history.journal !== "none")
}

type SegmentInit = {
  cacheKey: string
  turnId: string
  handle: ServerTurnHandle
  history: SegmentHistory
  onTerminal?: (event: TurnEvent) => void | Promise<void>
}

type Execution = {
  scope: SessionScope
  state: SessionExecutionState
  admissionId: string
  admissionFingerprint: string
  startedByLane: "operator" | "guest"
  /**
   * The controller whose admission started this turn, kept across every
   * segment whoever answers. A turn this proxy recovered or adopted without
   * holding it has no starter.
   */
  startedBy?: string
  controllers: Set<string>
  segment: Segment
  control: Promise<void>
  steeringRequests: Map<
    string,
    { fingerprint: string; result: Promise<TurnSteerResponse> }
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
  turnId: string
  /** Exact admission request this turn is fingerprinted from. */
  request: unknown
  segment: Segment
}

type ExecutionInit = TurnInit & {
  scope: SessionScope
  startedByLane: "operator" | "guest"
  startedBy?: string
  controllers?: readonly string[]
}

/**
 * One place decides what admitting a turn means, so a field can never be
 * threaded at three construction sites and forgotten at the fourth.
 */
function admittedTurn(init: TurnInit): AdmittedTurn {
  return {
    state: init.state,
    admissionId: init.turnId,
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

function safeEventBytes(event: TurnEvent) {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The only events a journal merges; everything else replays as it arrived. */
const MERGED_CHUNK_KINDS = [
  TurnEventKind.MessageChunk,
  TurnEventKind.ThoughtChunk,
  TurnEventKind.ToolCallInputChunk,
  TurnEventKind.ToolCallOutputChunk,
] as const

type ChunkEvent = TurnEventOf<(typeof MERGED_CHUNK_KINDS)[number]>

function isChunkEvent(event: TurnEvent): event is ChunkEvent {
  return (MERGED_CHUNK_KINDS as readonly TurnEventKind[]).includes(event.kind)
}

/** Two adjacent chunks of one stream of text as the one chunk they amount to. */
function compactedEvent(
  previous: TurnEvent,
  next: TurnEvent
): TurnEvent | undefined {
  if (!isChunkEvent(previous) || !isChunkEvent(next)) return undefined
  if (
    previous.kind === TurnEventKind.ToolCallInputChunk &&
    next.kind === TurnEventKind.ToolCallInputChunk
  )
    return previous.toolCallId === next.toolCallId
      ? { ...previous, delta: previous.delta + next.delta }
      : undefined
  if (
    previous.kind === TurnEventKind.ToolCallOutputChunk &&
    next.kind === TurnEventKind.ToolCallOutputChunk
  )
    return previous.toolCallId === next.toolCallId
      ? { ...previous, text: previous.text + next.text }
      : undefined
  if (
    (previous.kind === TurnEventKind.MessageChunk ||
      previous.kind === TurnEventKind.ThoughtChunk) &&
    previous.kind === next.kind &&
    previous.messageId === next.messageId &&
    previous.subagentId === next.subagentId
  )
    return { ...previous, text: previous.text + next.text }
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
): SequencedTurnEvent[] {
  const replay: SequencedTurnEvent[] = []
  let turnStarted = false
  for (const { value } of entries) {
    if (value.sequence <= after) continue
    // One turn replays as one turn: a recovered segment repeats its start, and
    // a second one would report the turn as starting again mid-stream.
    if (value.event.kind === TurnEventKind.TurnStarted) {
      if (turnStarted) continue
      turnStarted = true
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
  /** The browser owns the turn so far, so its live events alone answer it. */
  | "live"
  /** Only authoritative history can answer this cursor. */
  | "reset"

/**
 * How one journal answers a subscriber positioned at `after`.
 *
 * A cursorless reload owns no part of the turn, so only a journal that holds the
 * turn from its first event answers it. Any other cursor needs the journal to
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

/** The requests a paused segment still waits on: those nobody has answered. */
function openRequests(segment: Segment) {
  return segment.requests.filter(
    ({ requestId }) => !segment.answers.has(requestId)
  )
}

/**
 * A provider stream can end without a terminal turn event. The provider's own
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

export class SessionCoordinator {
  readonly #executions = new Map<string, Execution>()
  readonly #journals = new Map<string, Segment>()
  readonly #admissions = new Set<string>()
  readonly #recoveries = new Map<string, Promise<Execution>>()
  readonly #discoveries = new Map<string, Promise<Execution | undefined>>()
  readonly #observers = new Set<{
    key?: string
    listener: (event: ExecutionEvent) => void
  }>()
  #closed = false
  /** Owed after every turn, on joining, and after a config change. */
  readonly #usage: SessionReporter<SessionContextResponse>
  /** Owed when the provider switches a Session's model mid-turn. */
  readonly #models: SessionReporter<SessionModelsResponse, string>

  constructor(private readonly options: SessionCoordinatorOptions) {
    const { readings } = options
    this.#usage = new SessionReporter({
      read: async (scope) =>
        SessionContextResponseSchema.parse(
          await readings.context(scope.agentId, scope.threadId)
        ),
      retryDelaysMs: USAGE_RETRY_DELAYS_MS,
    })
    // An unreadable catalog leaves the options the client holds standing.
    this.#models = new SessionReporter({
      read: async (scope, selectedId: string) => ({
        ...SessionModelsResponseSchema.parse(
          await readings.models(scope.agentId, scope.threadId)
        ),
        selectedId,
      }),
      retryDelaysMs: [],
    })
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

  /** Subscribes one subscriber to its Session's readings, until it closes. */
  subscribeReadings(
    scope: SessionScope,
    subscriberId: string,
    listeners: SessionReadingListeners
  ) {
    const key = scopeKey(scope)
    const leaveUsage = this.#usage.subscribe(
      key,
      scope,
      subscriberId,
      listeners.usage
    )
    const leaveModels = this.#models.subscribe(
      key,
      scope,
      subscriberId,
      listeners.model
    )
    return () => {
      leaveUsage()
      leaveModels()
    }
  }

  /**
   * Owes one subscriber, or every one, a current usage reading: the one a
   * joining subscriber takes, or the one a config change moves. Resolves once
   * the first attempt has delivered or deferred it.
   */
  reportUsage(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    subscriberId?: string
  ) {
    return this.#usage.report(
      scopeKey(scope),
      undefined,
      subscriberId === undefined ? undefined : [subscriberId]
    )
  }

  state(scope: Pick<SessionScope, "agentId" | "sessionId">) {
    return this.#executions.get(scopeKey(scope))?.state ?? "idle"
  }

  snapshot(
    scope: Pick<SessionScope, "agentId" | "sessionId">
  ): SessionSnapshot {
    const execution = this.#executions.get(scopeKey(scope))
    if (!execution) return { state: "idle", requests: [] }
    return {
      state: execution.state,
      turnId: execution.segment.turnId,
      requests: structuredClone(openRequests(execution.segment)),
      ...(execution.startedBy === undefined
        ? {}
        : { startedBy: execution.startedBy }),
    }
  }

  /**
   * The live turn a cursorless follow replays from its first event, and when
   * that start was if it is known: a view rebuilt from history reads the turn
   * from there.
   */
  replayStart(scope: Pick<SessionScope, "agentId" | "sessionId">) {
    const segment = this.#executions.get(scopeKey(scope))?.segment
    if (!segment || replayPlan(segment, undefined) !== "history")
      return undefined
    return { turnId: segment.turnId, at: segment.startedAt }
  }

  /**
   * Workspace-wide execution feed: one listener sees the lifecycle of every
   * Session this coordinator drives, independent of the per-segment turn
   * subscriptions and their replay.
   */
  observe(listener: (event: ExecutionEvent) => void) {
    return this.#addObserver({ listener })
  }

  /**
   * One Session's execution feed, matched on its provider scope, so a member can
   * follow the requests its own Session resolves without the event naming them.
   */
  observeScope(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    listener: (event: ExecutionEvent) => void
  ) {
    return this.#addObserver({ key: scopeKey(scope), listener })
  }

  #addObserver(observer: {
    key?: string
    listener: (event: ExecutionEvent) => void
  }) {
    this.#observers.add(observer)
    return () => {
      this.#observers.delete(observer)
    }
  }

  /**
   * Asks the provider for a turn this coordinator is not already streaming: one
   * it lost to a restart, a wait to refresh, or a turn the runtime started by
   * itself after an earlier one finished. `lane` is the lane that turn is
   * counted under.
   */
  async discover(
    scope: SessionScope,
    lane: Execution["startedByLane"] = "operator"
  ) {
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (
      !this.options.engine.discover ||
      (existing &&
        existing.state !== "waiting-for-input" &&
        existing.state !== "idle")
    )
      return existing
    const inFlight = this.#discoveries.get(key)
    if (inFlight) return inFlight
    const discovery = this.#discover(
      scope,
      key,
      lane,
      existing?.state === "waiting-for-input" ? existing : undefined
    )
    this.#discoveries.set(key, discovery)
    void discovery
      .finally(() => {
        if (this.#discoveries.get(key) === discovery)
          this.#discoveries.delete(key)
      })
      .catch(() => undefined)
    return discovery
  }

  /** `existing` is a waiting record to refresh; any other turn is new. */
  async #discover(
    scope: SessionScope,
    key: string,
    lane: Execution["startedByLane"],
    existing: Execution | undefined
  ) {
    if (this.#admissions.has(key)) throw new ServerTurnConflictError()
    this.#assertCapacity(lane, existing)
    this.#admissions.add(key)
    try {
      const turnId =
        existing?.segment.turnId ?? `aos-recovered-${crypto.randomUUID()}`
      const discovered = await this.options.engine.discover!(scope, turnId)
      if (!discovered) {
        if (existing && this.#executions.get(key) === existing) {
          this.#resolveAttention(existing)
          this.#forgetJournal(existing.segment)
          existing.segment.fanout.close()
          this.#executions.delete(key)
        }
        return undefined
      }
      const segment = this.#createSegment({
        cacheKey: key,
        turnId,
        handle: discovered.handle,
        // Only a stream that begins at the native turn's start can replay it;
        // any other joined the turn midway and has nothing a reload can trust.
        history: discovered.fromStart
          ? { journal: "start", at: discovered.startedAt }
          : { journal: "none" },
      })
      this.#trackJournal(segment)
      segment.requests = structuredClone(discovered.requests ?? [])
      const execution: Execution =
        existing ??
        this.#createExecution({
          scope,
          state: discovered.state,
          turnId,
          request: { turnId },
          startedByLane: lane,
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
    input: PromptTurnInput,
    access: CoordinatorAccess,
    attachments?: ServerAttachmentStage
  ): Promise<CoordinatedTurnSubscription> {
    if (this.#closed) throw new Error("Session coordinator is closed")
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (existing?.segment.turnId === input.turnId) {
      if (existing.admissionFingerprint !== admissionFingerprint(input))
        throw new ServerTurnConflictError()
      if (access.canControl) existing.controllers.add(access.controllerId)
      // A retried admission reads the turn from its beginning, so a journal that
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

    if (existing && existing.state !== "idle") {
      if (
        existing.state !== "uncertain" ||
        !(await this.#settleUncertain(scope, existing, access))
      )
        throw new ServerTurnConflictError()
    }
    this.#assertCapacity(access.lane)
    if (this.#admissions.has(key)) throw new ServerTurnConflictError()
    this.#admissions.add(key)
    try {
      const at = Date.now()
      const handle = await this.options.engine.start(
        scope,
        input,
        ...(attachments ? [attachments] : [])
      )
      const execution: Execution = this.#createExecution({
        scope,
        state: "running",
        turnId: input.turnId,
        request: input,
        startedByLane: access.lane,
        startedBy: access.controllerId,
        controllers: access.canControl ? [access.controllerId] : [],
        segment: this.#createSegment({
          cacheKey: key,
          turnId: input.turnId,
          handle,
          history: { journal: "start", at },
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

  /**
   * Answers one request a paused turn is waiting on, from whichever member
   * gives it. The first answer wins: a later one, or one to a request the turn
   * never asked, is stale. Each answer withdraws its request from every member
   * at once; the last one continues the turn as a fresh segment, whose turnId
   * this returns with the one it continues. Every member follows that segment
   * the way it follows any other.
   */
  async answer(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    reply: RequestReply
  ) {
    const execution = this.#executions.get(scopeKey(scope))
    const segment = execution?.segment
    if (
      !execution ||
      !segment ||
      execution.state !== "waiting-for-input" ||
      !openRequests(segment).some(
        ({ requestId }) => requestId === reply.requestId
      )
    )
      throw new ServerRequestStaleError()
    segment.answers.set(reply.requestId, reply)
    this.#announce(execution.scope, {
      ...this.#origin(execution.scope, segment.turnId),
      kind: "attention-resolved",
      requestId: reply.requestId,
    })
    if (openRequests(segment).length > 0) return undefined
    const replies = segment.requests.flatMap(
      ({ requestId }) => segment.answers.get(requestId) ?? []
    )
    const turnId = crypto.randomUUID()
    try {
      await this.#startSegment(execution, { turnId, replies })
    } catch (cause) {
      // Nothing continued the turn, so its requests are open again for the
      // next resume to reissue, exactly as before anyone answered.
      if (execution.segment === segment) segment.answers.clear()
      throw cause
    }
    return { from: segment.turnId, turnId }
  }

  async recover(
    scope: SessionScope,
    request: CoordinatorRecoveryRequest,
    access: CoordinatorAccess
  ): Promise<CoordinatedTurnSubscription> {
    if (this.#closed) throw new Error("Session coordinator is closed")
    if (request.threadId !== scope.threadId)
      throw new Error("Recovery scope does not match this Session")
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (
      existing?.segment.turnId === request.turnId &&
      existing.state !== "uncertain"
    ) {
      const plan = request.reset
        ? "reset"
        : replayPlan(existing.segment, request.after)
      if (plan === "reset") return this.#resetSubscription(existing.segment)
      if (access.canControl) existing.controllers.add(access.controllerId)
      this.#touchJournal(existing.segment)
      return this.#subscribe(existing.segment, request.after ?? 0, access, plan)
    }

    if (existing && existing.segment.turnId !== request.turnId)
      throw new ServerTurnConflictError()
    const recovered = await this.#recovery(scope, request, access, existing)
    if (recovered.segment.turnId !== request.turnId)
      throw new ServerTurnConflictError()
    // A recovery that replaced a known execution continues its sequence, so the
    // browser cursor still applies. A recovery of a turn this coordinator never
    // streamed numbers the segment from one, and that cursor means nothing.
    const after = existing ? request.after : undefined
    const plan = request.reset ? "reset" : replayPlan(recovered.segment, after)
    if (plan === "reset") return this.#resetSubscription(recovered.segment)
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
    if (this.#admissions.has(key)) throw new ServerTurnConflictError()
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
   * The provider decides whether an uncertain turn is over. A recovery that
   * settles it clears the way for this turn; a turn that keeps streaming, and a
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
        { threadId: scope.threadId, turnId: execution.segment.turnId },
        access,
        execution
      )
    } catch {
      return false
    }
    // The provider answers this: the recovered segment either reports the
    // outcome of the turn or speaks as a turn that is still streaming. Waiting on
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
        turnId: request.turnId,
        ...(position ? { position } : {}),
      }
      const handle = await this.options.engine.recover(scope, providerRequest)
      const replaced = existing?.segment
      const segment = this.#createSegment({
        cacheKey: key,
        turnId: request.turnId,
        handle,
        // One turn keeps one journal and one monotonic sequence across its
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
          turnId: request.turnId,
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

  /**
   * Whether a control answer still speaks for the execution it was issued
   * against. The turn stream is the one place a turn ends, so an answer that
   * arrives after the stream reported the outcome — `idle` or `uncertain`, the
   * two states nothing more arrives for — or after the next turn replaced the
   * segment, is reported to its caller without reopening a Session that is
   * already over.
   */
  #answerApplies(execution: Execution, segment: Segment) {
    return (
      execution.segment === segment &&
      execution.state !== "idle" &&
      execution.state !== "uncertain"
    )
  }

  async stop(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    controllerId: string
  ) {
    const execution = this.#executions.get(scopeKey(scope))
    if (!execution || execution.state === "idle") return "idle" as const
    return this.#withControl(execution, async () => {
      if (!execution.controllers.has(controllerId))
        throw new ServerTurnControlError()
      const stopped = execution.segment
      try {
        const status = await stopped.handle.stop()
        if (this.#answerApplies(execution, stopped)) {
          execution.state = status === "idle" ? "idle" : "stopping"
          // Stopping a wait ends it without an answer.
          if (status === "idle") this.#resolveAttention(execution)
        }
        return status
      } catch (error) {
        if (error instanceof ServerTurnStopNotDispatchedError) {
          if (this.#answerApplies(execution, stopped))
            execution.state = "running"
          throw error.failure
        }
        if (this.#answerApplies(execution, stopped))
          execution.state = "uncertain"
        throw error
      }
    })
  }

  async steer(
    scope: Pick<SessionScope, "agentId" | "sessionId">,
    request: TurnSteerRequest,
    controllerId: string
  ): Promise<TurnSteerResponse> {
    const execution = this.#executions.get(scopeKey(scope))
    if (
      !execution ||
      execution.state !== "running" ||
      execution.segment.turnId !== request.expectedTurnId
    )
      throw new ServerTurnConflictError()
    if (!execution.controllers.has(controllerId))
      throw new ServerTurnControlError()

    const fingerprint = admissionFingerprint({
      expectedTurnId: request.expectedTurnId,
      text: request.text,
    })
    const existing = execution.steeringRequests.get(request.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ServerTurnConflictError()
      return existing.result
    }

    const result = this.#withControl(execution, async () => {
      if (
        execution.state !== "running" ||
        execution.segment.turnId !== request.expectedTurnId
      )
        throw new ServerTurnConflictError()
      const steer = execution.segment.handle.steer
      if (!steer) throw new ServerTurnSteerUnavailableError()
      const delivery = await steer({
        requestId: request.requestId,
        text: request.text,
      })
      this.#publish(execution.segment, {
        kind: TurnEventKind.SteerAccepted,
        requestId: request.requestId,
        text: request.text,
        delivery,
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

  async #startSegment(execution: Execution, input: RepliesTurnInput) {
    const key = scopeKey(execution.scope)
    if (this.#admissions.has(key)) throw new ServerTurnConflictError()
    this.#admissions.add(key)
    try {
      const at = Date.now()
      const handle = await this.options.engine.start(execution.scope, input)
      const segment = this.#createSegment({
        cacheKey: key,
        turnId: input.turnId,
        handle,
        history: { journal: "start", at },
      })
      this.#forgetJournal(execution.segment)
      // A continued turn is a fresh admission on the same execution record.
      Object.assign(
        execution,
        admittedTurn({
          state: "running",
          turnId: input.turnId,
          request: input,
          segment,
        })
      )
      this.#trackJournal(segment)
      this.#consume(execution, segment)
    } finally {
      this.#admissions.delete(key)
    }
  }

  #createExecution(init: ExecutionInit): Execution {
    return {
      scope: init.scope,
      startedByLane: init.startedByLane,
      ...(init.startedBy === undefined ? {} : { startedBy: init.startedBy }),
      controllers: new Set(init.controllers ?? []),
      ...admittedTurn(init),
    }
  }

  /** Scope and clock every observed `ExecutionEvent` carries. */
  #origin(scope: SessionScope, turnId: string) {
    return {
      agentId: scope.agentId,
      // Observers project to the browser, which knows only public identity.
      sessionId: scope.threadId,
      turnId,
      occurredAt: new Date().toISOString(),
    }
  }

  #announce(scope: SessionScope, event: ExecutionEvent) {
    const key = scopeKey(scope)
    for (const { key: observed, listener } of [...this.#observers])
      if (observed === undefined || observed === key)
        try {
          listener(event)
        } catch {
          // An observer must not rewrite the provider outcome.
        }
  }

  /** A wait ended or cleared resolves the requests nobody answered. */
  #resolveAttention(execution: Execution) {
    const requests = openRequests(execution.segment)
    if (requests.length === 0) return
    const origin = this.#origin(execution.scope, execution.segment.turnId)
    for (const { requestId } of requests)
      this.#announce(execution.scope, {
        ...origin,
        kind: "attention-resolved",
        requestId,
      })
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
      turnId: init.turnId,
      handle: init.handle,
      fanout: new SubscriberFanout<SequencedTurnEvent>({
        maxEvents: this.options.maxSubscriberEvents,
        maxBytes: this.options.maxSubscriberBytes,
        sizeOf: ({ event }) => safeEventBytes(event),
      }),
      journal: segmentJournal(init.history),
      ...(init.history.journal === "start"
        ? init.history.at === undefined
          ? {}
          : { startedAt: init.history.at }
        : previous?.startedAt === undefined
          ? {}
          : { startedAt: previous.startedAt }),
      nextSequence: previous?.nextSequence ?? 0,
      terminal: false,
      requests: [],
      answers: new Map(),
      ...(init.onTerminal ? { onTerminal: init.onTerminal } : {}),
    }
  }

  #consume(execution: Execution, segment: Segment) {
    // One start per consumed segment: a new turn, a reply, or a recovered
    // turn. A rediscovered wait is not a start, so it announces nothing here.
    if (execution.state === "running")
      this.#announce(execution.scope, {
        ...this.#origin(execution.scope, segment.turnId),
        kind: "turn-started",
      })
    void (async () => {
      let terminal = false
      try {
        for await (const raw of segment.handle.events) {
          if (execution.segment !== segment) return
          // Dated where the replay starts, so a reload counts from there.
          const event =
            raw.kind === TurnEventKind.TurnStarted && segment.startedAt
              ? { ...raw, startedAt: new Date(segment.startedAt).toISOString() }
              : raw
          // A failure awaiting Stop leaves the turn active: its settlement, not
          // this event, is the terminal one.
          const awaitingStop = isAwaitingStopFailure(event)
          const ended =
            event.kind === TurnEventKind.TurnEnded ||
            event.kind === TurnEventKind.TurnRequiresAction
          if (
            ended ||
            (event.kind === TurnEventKind.TurnFailed && !awaitingStop)
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
          // A recoverable interrupt is not part of the turn: journaling it would
          // replay a failure the provider never reported.
          const interrupted = isRedialableFailure(event)
          if (!interrupted) this.#remember(segment, sequenced)
          segment.fanout.publish(sequenced)
          segment.announce()
          if (ended) {
            this.#forgetJournal(segment)
            terminal = true
            segment.terminal = true
            segment.requests = pendingRequestsOf(event)
            execution.state = segment.requests.length
              ? "waiting-for-input"
              : "idle"
            const origin = this.#origin(execution.scope, segment.turnId)
            if (segment.requests.length)
              for (const request of segment.requests)
                this.#announce(execution.scope, {
                  ...origin,
                  kind: "attention-requested",
                  request: structuredClone(request),
                  ...(execution.startedBy === undefined
                    ? {}
                    : { startedBy: execution.startedBy }),
                })
            else
              this.#announce(execution.scope, {
                ...origin,
                kind: "turn-finished",
              })
            break
          }
          if (event.kind === TurnEventKind.TurnFailed && !awaitingStop) {
            // The journal outlives an interrupt so a reload after recovery
            // still replays this turn from its beginning.
            if (!interrupted) this.#forgetJournal(segment)
            terminal = true
            segment.terminal = true
            // Only a turn the provider may still be working on is uncertain. A
            // reset is definite: its journal cannot serve the browser's cursor,
            // so the execution settles and the next turn is admitted, which the
            // adapter still refuses if the native Session is busy.
            execution.state = interrupted ? "uncertain" : "idle"
            this.#announce(execution.scope, {
              ...this.#origin(execution.scope, segment.turnId),
              kind: "turn-failed",
            })
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
   * A turn that outgrows either replay bound loses its journal. A subscriber the
   * rest of the segment cannot answer is then sent one reset instead of a
   * partial history.
   */
  #remember(segment: Segment, value: SequencedTurnEvent) {
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
    // One Session streams one turn at a time and every journal is bounded on its
    // own, so the execution limit bounds the journals a browser can still be
    // reading. A live turn is journaling events, which keeps it recently used,
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

  #publish(segment: Segment, event: TurnEvent) {
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
   * browser that already owns the turn so far reads the live stream alone.
   */
  #subscribe(
    segment: Segment,
    after: number,
    access: CoordinatorAccess,
    plan: Exclude<ReplayPlan, "reset"> = "history"
  ) {
    const live = segment.fanout.subscribe(access.onDetach)
    const replay =
      plan === "history"
        ? compactedReplay(segment.journal?.entries ?? [], after)
        : []
    const { subscriberId } = access
    const usage = this.#usage
    const models = this.#models
    // A reading follows what the subscriber has read, never overtakes it: the
    // code after a `yield` runs once the reader asks for the next event.
    const read = ({ event }: SequencedTurnEvent) => {
      if (event.kind === TurnEventKind.ModelChanged)
        void models.report(segment.cacheKey, event.modelId, [subscriberId])
    }
    let closed = false
    const events: AsyncIterable<SequencedTurnEvent> = {
      [Symbol.asyncIterator]: async function* () {
        let last = after
        try {
          for (const value of replay) {
            last = value.sequence
            yield value
            read(value)
          }
          for await (const value of live.events) {
            if (value.sequence <= last) continue
            last = value.sequence
            yield value
            read(value)
          }
          // Read to its end, failed or not, the segment moved the window. A
          // stream its reader closed, or dropped for falling behind, is owed
          // nothing: the reader follows another or resyncs.
          if (!closed)
            void usage.report(segment.cacheKey, undefined, [subscriberId])
        } finally {
          live.close()
        }
      },
    }
    return {
      turnId: segment.turnId,
      events,
      close: () => {
        closed = true
        live.close()
      },
    }
  }

  #resetSubscription(segment: Segment) {
    const candidate: SequencedTurnEvent = {
      sequence: segment.nextSequence + 1,
      event: {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_RESET_REQUIRED",
        message: "AOS turn history must be reloaded before continuing.",
      },
    }
    const events: AsyncIterable<SequencedTurnEvent> = {
      async *[Symbol.asyncIterator]() {
        yield candidate
      },
    }
    return { turnId: segment.turnId, events, close: () => undefined }
  }

  #assertCapacity(lane: "operator" | "guest", existing?: Execution) {
    if (existing) return
    const active = [...this.#executions.values()].filter(
      ({ state }) => state !== "idle"
    )
    if (active.length >= this.options.maxActiveExecutions)
      throw new ServerTurnCapacityError("global")
    if (
      lane === "guest" &&
      active.filter(({ startedByLane }) => startedByLane === "guest").length >=
        this.options.maxGuestActiveExecutions
    )
      throw new ServerTurnCapacityError("guest")
  }
}
