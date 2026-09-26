import { createHash } from "node:crypto"

import {
  createOwner,
  defaultClock,
  ownerSetup,
  type Clock,
  type LogFields,
  type Logger,
  type Owner,
  type OwnerContext,
} from "../../lifecycle"
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
  ServerTurnStopNotDispatchedError,
  ServerTurnSteerUnavailableError,
  type RecoveryRequest,
  type ServerAttachmentStage,
  type ServerRuntime,
  type ServerTurnEngine,
  type ServerTurnHandle,
  type SessionScope,
} from "./runtime"
import type { WorkspaceCapabilities } from "./member"
import {
  SessionContextResponseSchema,
  SessionModelsResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  type Session,
  type SessionContextResponse,
  type SessionModelsResponse,
  type TurnSteerRequest,
  type TurnSteerResponse,
} from "../../protocol"
import { CLIENT_ADMISSIONS } from "./limits"
import { SessionReporter, type ReadingListener } from "./session-reporter"
import { SubscriberFanout } from "./subscriber-fanout"

export type SessionExecutionState =
  "idle" | "running" | "stopping" | "waiting-for-input" | "uncertain"

/** The Session status each execution state overlays on the provider's row. */
const EXECUTION_STATUS: Record<SessionExecutionState, Session["status"]> = {
  idle: "idle",
  running: "running",
  stopping: "running",
  "waiting-for-input": "waiting-for-input",
  uncertain: "failed",
}

/** One Session's execution as its reading holds it, outside the turn stream. */
export type SessionExecution = {
  state: SessionExecutionState
  turnId?: string
  status: Session["status"]
}

/** One Session's execution as a member reads it, outside the turn stream. */
export type SessionSnapshot = {
  state: SessionExecutionState
  turnId?: string
  /** The requests the turn still waits on: those nobody has answered. */
  requests: PendingRequest[]
  /** The principal that admitted the turn, when this proxy admitted it. */
  startedBy?: string
}

export type SequencedTurnEvent = {
  sequence: number
  event: TurnEvent
}

export type CoordinatorAccess = {
  membershipId: string
  principalId: string
  onDetach?(): void
  /** Owns request-scoped resources until the provider outcome is known. */
  onTerminal?(event: TurnEvent): void | Promise<void>
}

export type CoordinatorRecoveryRequest = Pick<
  RecoveryRequest,
  "sessionId" | "turnId"
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

/**
 * A prompt to admit. A client id names a send its client may repeat, and the
 * turn and message ids derive from it; without one, the caller mints them.
 */
export type SendInput =
  | PromptTurnInput
  | (Omit<PromptTurnInput, "turnId" | "messageId"> & { clientId: string })

/**
 * A cap on the turns some principals hold at once: `predicate` picks, by its
 * starter, each held turn the cap counts.
 */
export type TurnQuota = {
  predicate(principalId: string): boolean
  limit: number
}

/** What a start carries beside its prompt. */
export type StartOptions = {
  stage?: ServerAttachmentStage
  /** Refuses the start while the turns it counts reach its limit. */
  quota?: TurnQuota
}

/** A Session to create; a client id names a create its client may repeat. */
export type CreateInput = { title?: string; clientId?: string }

/** A client id repeated for another request than the one it first named. */
export class ServerClientIdReusedError extends Error {
  constructor() {
    super("The client id names another request")
    this.name = "ServerClientIdReusedError"
  }
}

export type SessionCoordinatorOptions = {
  engine: ServerTurnEngine
  /**
   * Reads a Session's context window and model catalog for its reporters, and
   * creates the Sessions a client asks for.
   */
  readings: Pick<ServerRuntime, "context" | "models" | "createSession">
  maxActiveExecutions: number
  /** Bounds each subscriber's queue and, as the same limit, each turn's journal. */
  maxSubscriberEvents: number
  maxSubscriberBytes: number
  /** Where each turn owner writes its transitions; silent by default. */
  logger?: Logger
  clock?: Clock
}

/**
 * What one subscriber takes of its Session's readings; it is owed only these,
 * each the last value on subscribing and then each change.
 */
export type SessionReadingListeners = {
  usage?: ReadingListener<SessionContextResponse>
  /** The model options, and each switch the subscriber reads or a config makes. */
  model?: ReadingListener<SessionModelsResponse>
  execution?: ReadingListener<SessionExecution>
}

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

/** Where a turn rests between admissions, and where a refused one returns. */
type RestingState = "idle" | "waiting-for-input" | "uncertain"

type TurnContext = OwnerContext & {
  resting: RestingState
  /** The turn the latest landed admission admitted. */
  turnId?: string
}

/**
 * What moves one Session's turn: an admission and how it lands, the outcome
 * its provider stream reports, and what a Stop answers.
 */
type TurnSignal =
  | { type: "admit" }
  | { type: "admitted"; state: "running" | "waiting-for-input"; turnId: string }
  /** The admission did not land, so the turn returns to where it rested. */
  | { type: "refused" }
  /** The provider holds no turn for the wait this admission refreshed. */
  | { type: "cleared" }
  | { type: "ended" }
  | { type: "paused" }
  /** The provider may still be working on a turn this proxy lost sight of. */
  | { type: "lost" }
  | { type: "stopped" }
  | { type: "stopping" }
  | { type: "undispatched" }
  | { type: "stopFailed" }

/**
 * One Session's turn lifecycle. Only a landed admission bumps the generation,
 * so an outcome reported for an earlier segment is stale by construction.
 * Idle ignores the stream: a turn that Stop settled stays settled. An outcome
 * the stream reports while an admission is in flight moves where the turn
 * rests, as that resting state would take it, so a refused admission returns
 * to where the stream left the turn.
 */
function turnMachine(logger: Logger, clock: Clock) {
  const turn = ownerSetup<TurnContext, TurnSignal>("turn", logger, clock)
  const admit = (resting: RestingState) => ({
    target: "admitting" as const,
    actions: turn.assign({ resting }),
  })
  const land = turn.assign({
    turnId: ({ event }) =>
      event.type === "admitted" ? event.turnId : undefined,
  })
  const rest = (from: RestingState[], resting: RestingState) => ({
    guard: ({ context }: { context: TurnContext }) =>
      from.includes(context.resting),
    actions: turn.assign({ resting }),
  })
  return turn.createMachine({
    context: { generation: 0, resting: "idle" },
    initial: "idle",
    states: {
      idle: { on: { admit: admit("idle") } },
      admitting: {
        on: {
          admitted: [
            {
              guard: ({ event }) => event.state === "waiting-for-input",
              target: "waiting-for-input",
              actions: ["bumpGeneration", land],
            },
            { target: "running", actions: ["bumpGeneration", land] },
          ],
          refused: [
            {
              guard: ({ context }) => context.resting === "waiting-for-input",
              target: "waiting-for-input",
            },
            {
              guard: ({ context }) => context.resting === "uncertain",
              target: "uncertain",
            },
            { target: "idle" },
          ],
          cleared: "idle",
          ended: rest(["waiting-for-input", "uncertain"], "idle"),
          paused: rest(["uncertain"], "waiting-for-input"),
          lost: rest(["waiting-for-input"], "uncertain"),
        },
      },
      running: {
        on: {
          ended: "idle",
          paused: "waiting-for-input",
          lost: "uncertain",
          stopped: "idle",
          stopping: "stopping",
          stopFailed: "uncertain",
        },
      },
      stopping: {
        on: {
          ended: "idle",
          paused: "waiting-for-input",
          lost: "uncertain",
          stopped: "idle",
          undispatched: "running",
          stopFailed: "uncertain",
        },
      },
      "waiting-for-input": {
        on: {
          admit: admit("waiting-for-input"),
          ended: "idle",
          lost: "uncertain",
          stopped: "idle",
          stopping: "stopping",
          stopFailed: "uncertain",
        },
      },
      // A Stop that cannot be confirmed leaves the stream to report the outcome.
      uncertain: {
        on: {
          admit: admit("uncertain"),
          ended: "idle",
          paused: "waiting-for-input",
        },
      },
    },
  })
}

type Turn = {
  owner: Owner<ReturnType<typeof turnMachine>>
  /** The turnId an admission in flight admits. */
  admission?: string
  /**
   * The principal whose admission started the turn, kept across every segment
   * whoever answers. A turn this proxy recovered or adopted has no starter.
   */
  startedBy?: string
}

/**
 * Where a Session's turn is, as its actor holds it: an admission in flight
 * reads as the state its turn rests in.
 */
function turnExecution(turn: Turn) {
  const { value, context } = turn.owner.actor.getSnapshot()
  return {
    state: value === "admitting" ? context.resting : value,
    turnId: context.turnId,
  }
}

/** An admission in flight, and the generation it must land at. */
type Admission = { turn: Turn; generation: number }

const SILENT: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => SILENT,
}

/** A logger whose every line names the turn `turnId` reads when it writes. */
function namingTurn(logger: Logger, turnId: () => string | undefined): Logger {
  const at =
    (level: Exclude<keyof Logger, "child">) =>
    (fields: LogFields, message: string) => {
      const id = turnId()
      logger[level](
        id === undefined ? fields : { turnId: id, ...fields },
        message
      )
    }
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (bindings) => namingTurn(logger.child(bindings), turnId),
  }
}

type Segment = {
  cacheKey: string
  turnId: string
  /** The turn generation its admission landed as. */
  generation: number
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
  generation: number
  handle: ServerTurnHandle
  history: SegmentHistory
  onTerminal?: (event: TurnEvent) => void | Promise<void>
}

type Execution = {
  scope: SessionScope
  turn: Turn
  /** Read from the turn owner, the one place a turn's state lives. */
  readonly state: SessionExecutionState
  admissionId: string
  admissionFingerprint: string
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
  | "admissionId"
  | "admissionFingerprint"
  | "segment"
  | "control"
  | "steeringRequests"
>

type TurnInit = {
  turnId: string
  /** Exact admission request this turn is fingerprinted from. */
  request: unknown
  segment: Segment
}

type ExecutionInit = TurnInit & {
  scope: SessionScope
  turn: Turn
}

/**
 * One place decides what admitting a turn means, so a field can never be
 * threaded at three construction sites and forgotten at the fourth.
 */
function admittedTurn(init: TurnInit): AdmittedTurn {
  return {
    admissionId: init.turnId,
    admissionFingerprint: admissionFingerprint(init.request),
    segment: init.segment,
    control: Promise.resolve(),
    steeringRequests: new Map(),
  }
}

const MAX_STEERING_REQUESTS_PER_EXECUTION = 256

function scopeKey(scope: Pick<SessionScope, "agentId" | "providerSessionId">) {
  return `${scope.agentId}\u0000${scope.providerSessionId}`
}

/** A Session's capabilities are read by its public id. */
type CapabilityScope = Pick<SessionScope, "agentId" | "sessionId">

function capabilityKey(scope: CapabilityScope) {
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

/** A digest of an admission, so remembering it keeps no prompt text. */
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
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

/** The hex key a client id derives within its principal and its target. */
function clientKey(principalId: string, targetId: string, clientId: string) {
  return createHash("sha256")
    .update(principalId)
    .update("\0")
    .update(targetId)
    .update("\0")
    .update(clientId)
    .digest("hex")
}

/**
 * The ids a repeatable send derives from its client id, so the same send
 * repeated is the same turn and its prompt the same message.
 */
export function clientTurnIds(
  principalId: string,
  sessionId: string,
  clientId: string
) {
  const turnId = clientKey(principalId, sessionId, clientId)
  return { turnId, messageId: `${turnId}-message` }
}

/** What a repeatable admission answers while its client id is remembered. */
type ClientAdmission<T> = {
  fingerprint: string
  expiresAt: number
  result: Promise<T>
}

/**
 * The admissions clients may repeat, keyed by what each client id derives: a
 * repeat answers the first one's result, and one asking for something else is
 * refused. Bounded and expiring on the coordinator's clock, apart from any
 * Execution, so a repeat still finds its admission once the turn is gone. A
 * failed admission is forgotten, so its repeat admits afresh.
 */
class ClientAdmissions<T> {
  readonly #entries = new Map<string, ClientAdmission<T>>()

  constructor(private readonly clock: Clock) {}

  /** The first result `key` names while it is remembered. */
  repeated(key: string, fingerprint: string): Promise<T> | undefined {
    const now = this.clock.now()
    // Entries expire in the order they were admitted.
    for (const [oldest, entry] of this.#entries) {
      if (entry.expiresAt > now) break
      this.#entries.delete(oldest)
    }
    const first = this.#entries.get(key)
    if (first && first.fingerprint !== fingerprint)
      throw new ServerClientIdReusedError()
    return first?.result
  }

  remember(key: string, fingerprint: string, result: Promise<T>) {
    const expiresAt = this.clock.now() + CLIENT_ADMISSIONS.ttlMs
    const entry = { fingerprint, expiresAt, result }
    this.#entries.set(key, entry)
    if (this.#entries.size > CLIENT_ADMISSIONS.entries) {
      const oldest = this.#entries.keys().next().value
      if (oldest !== undefined) this.#entries.delete(oldest)
    }
    // The admission's own caller reports its failure; this only forgets it.
    void result.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key)
    })
    return result
  }
}

/** The stream of a turn nothing is left of. */
const ENDED: AsyncIterable<SequencedTurnEvent> = {
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true, value: undefined }),
  }),
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
  readonly #turns = new Map<string, Turn>()
  readonly #machine: ReturnType<typeof turnMachine>
  readonly #logger: Logger
  readonly #clock: Clock
  readonly #recoveries = new Map<string, Promise<Execution>>()
  readonly #discoveries = new Map<string, Promise<Execution | undefined>>()
  readonly #listeners = new Set<{
    key?: string
    listener: (event: ExecutionEvent) => void
  }>()
  #closed = false
  /** Changed by every turn, and by a model switch. */
  readonly #usage: SessionReporter<SessionContextResponse>
  /** Changed by a model switch; one the provider reports names its model. */
  readonly #models: SessionReporter<SessionModelsResponse, string>
  /** Changed by each move of the Session's turn. */
  readonly #execution: SessionReporter<SessionExecution>
  /** Read through the runtime the composition binds. */
  readonly #capabilities: SessionReporter<
    WorkspaceCapabilities,
    void,
    CapabilityScope
  >
  #workspace: Pick<ServerRuntime, "workspaceCapabilities"> | undefined
  /** Each send's landing alone: a repeat subscribes on its own. */
  readonly #sends: ClientAdmissions<void>
  readonly #creates: ClientAdmissions<unknown>

  constructor(private readonly options: SessionCoordinatorOptions) {
    const { readings } = options
    this.#logger = options.logger ?? SILENT
    this.#clock = options.clock ?? defaultClock
    this.#sends = new ClientAdmissions(this.#clock)
    this.#creates = new ClientAdmissions(this.#clock)
    this.#machine = turnMachine(this.#logger, this.#clock)
    const cell = { logger: this.#logger, clock: this.#clock }
    this.#usage = new SessionReporter({
      name: "usage",
      read: async (scope) =>
        SessionContextResponseSchema.parse(
          await readings.context(scope.agentId, scope.sessionId)
        ),
      ...cell,
    })
    // A switch reported mid-turn may name a model the catalog does not yet.
    this.#models = new SessionReporter({
      name: "models",
      read: async (scope, selectedId) => ({
        ...SessionModelsResponseSchema.parse(
          await readings.models(scope.agentId, scope.sessionId)
        ),
        ...(selectedId === undefined ? {} : { selectedId }),
      }),
      ...cell,
    })
    this.#execution = new SessionReporter({
      name: "execution",
      read: async (scope) => {
        const turn = this.#turns.get(scopeKey(scope))
        const { state, turnId } = turn
          ? turnExecution(turn)
          : { state: "idle" as const, turnId: undefined }
        return {
          state,
          ...(turnId === undefined ? {} : { turnId }),
          status: EXECUTION_STATUS[state],
        }
      },
      ...cell,
    })
    this.#capabilities = new SessionReporter({
      name: "capabilities",
      read: async (scope) => {
        const workspace = this.#workspace
        if (!workspace) throw new Error("Session capabilities are not bound")
        return SessionWorkspaceCapabilitiesResponseSchema.parse(
          await workspace.workspaceCapabilities(scope.agentId, scope.sessionId)
        )
      },
      ...cell,
    })
    for (const value of [
      options.maxActiveExecutions,
      options.maxSubscriberEvents,
      options.maxSubscriberBytes,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid Session coordinator limits")
  }

  /** Subscribes one subscriber to its Session's readings, until it closes. */
  subscribeReadings(
    scope: SessionScope,
    membershipId: string,
    listeners: SessionReadingListeners
  ) {
    const key = scopeKey(scope)
    const leaves = [
      listeners.usage &&
        this.#usage.subscribe(key, scope, membershipId, listeners.usage),
      listeners.model &&
        this.#models.subscribe(key, scope, membershipId, listeners.model),
      listeners.execution &&
        this.#execution.subscribe(
          key,
          scope,
          membershipId,
          listeners.execution
        ),
    ]
    return () => {
      for (const leave of leaves) leave?.()
    }
  }

  /**
   * Reads capabilities through `runtime` from here on: the one the listeners
   * serve, whose wrappers amend what the adapter reports.
   */
  bindCapabilities(runtime: Pick<ServerRuntime, "workspaceCapabilities">) {
    this.#workspace = runtime
  }

  /** Subscribes one subscriber to its Session's capabilities, until it leaves. */
  subscribeCapabilities(
    scope: CapabilityScope,
    membershipId: string,
    listener: ReadingListener<WorkspaceCapabilities>
  ) {
    return this.#capabilities.subscribe(
      capabilityKey(scope),
      scope,
      membershipId,
      listener
    )
  }

  /** Owes one subscriber a fresh usage reading: what a returning one takes. */
  reportUsage(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">,
    membershipId: string
  ) {
    this.#usage.report(scopeKey(scope), undefined, [membershipId])
  }

  /**
   * Owes every subscriber the readings a model switch moves: the model
   * options, and the usage, whose window belongs to the model.
   */
  reportModelSwitch(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">
  ) {
    const key = scopeKey(scope)
    this.#models.report(key)
    this.#usage.report(key)
  }

  state(scope: Pick<SessionScope, "agentId" | "providerSessionId">) {
    return this.#executions.get(scopeKey(scope))?.state ?? "idle"
  }

  snapshot(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">
  ): SessionSnapshot {
    const execution = this.#executions.get(scopeKey(scope))
    if (!execution) return { state: "idle", requests: [] }
    return {
      state: execution.state,
      turnId: execution.segment.turnId,
      requests: structuredClone(openRequests(execution.segment)),
      ...(execution.turn.startedBy === undefined
        ? {}
        : { startedBy: execution.turn.startedBy }),
    }
  }

  /**
   * The live turn a cursorless follow replays from its first event, and when
   * that start was if it is known: a view rebuilt from history reads the turn
   * from there.
   */
  replayStart(scope: Pick<SessionScope, "agentId" | "providerSessionId">) {
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
  subscribeExecutions(listener: (event: ExecutionEvent) => void) {
    return this.#addListener({ listener })
  }

  /**
   * One Session's execution feed, matched on its provider scope, so a member can
   * follow the requests its own Session resolves without the event naming them.
   */
  subscribeScope(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">,
    listener: (event: ExecutionEvent) => void
  ) {
    return this.#addListener({ key: scopeKey(scope), listener })
  }

  #addListener(entry: {
    key?: string
    listener: (event: ExecutionEvent) => void
  }) {
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  /**
   * Asks the provider for a turn this coordinator is not already streaming: one
   * it lost to a restart, a wait to refresh, or a turn the runtime started by
   * itself after an earlier one finished.
   */
  async discover(scope: SessionScope) {
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
    existing: Execution | undefined
  ) {
    const turnId =
      existing?.segment.turnId ?? `aos-recovered-${crypto.randomUUID()}`
    const { turn, generation } = this.#admit(scope, turnId)
    try {
      // Adopting a turn the runtime started after one this proxy ran is a
      // turn start; a turn lost to a restart, or a wait refreshed, is not.
      if (!existing && this.#executions.has(key)) this.#assertCapacity(key)
      const discovered = await this.options.engine.discover!(scope, turnId)
      if (!discovered) {
        if (existing && this.#move(turn, generation, { type: "cleared" })) {
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
        generation: this.#landed(turn, generation, discovered.state, turnId),
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
          turn,
          turnId,
          request: { turnId },
          segment,
        })
      if (existing) {
        this.#forgetJournal(existing.segment)
        existing.segment.fanout.close()
        execution.segment = segment
      }
      this.#executions.set(key, execution)
      this.#consume(execution, segment)
      return execution
    } finally {
      this.#endAdmission(turn, generation)
    }
  }

  /**
   * Creates a Session in `agentId`. A client id names a create its client may
   * repeat: a repeat answers the Session the first one created, so a retry
   * leaves no orphan.
   */
  async createSession(
    agentId: string,
    input: CreateInput,
    principalId: string
  ): Promise<unknown> {
    if (this.#closed) throw new Error("Session coordinator is closed")
    const create = () =>
      this.options.readings.createSession(agentId, input.title)
    if (input.clientId === undefined) return create()
    const key = clientKey(principalId, agentId, input.clientId)
    const fingerprint = admissionFingerprint({ title: input.title })
    return (
      this.#creates.repeated(key, fingerprint) ??
      this.#creates.remember(key, fingerprint, create())
    )
  }

  async start(
    scope: SessionScope,
    input: SendInput,
    access: CoordinatorAccess,
    options: StartOptions = {}
  ): Promise<CoordinatedTurnSubscription> {
    if (this.#closed) throw new Error("Session coordinator is closed")
    if (!("clientId" in input))
      return this.#startTurn(scope, input, access, options)
    const { clientId, ...prompt } = input
    const ids = clientTurnIds(access.principalId, scope.sessionId, clientId)
    const fingerprint = admissionFingerprint({
      ...prompt,
      attachments: options.stage?.artifactIds?.() ?? [],
    })
    const repeated = this.#sends.repeated(ids.turnId, fingerprint)
    if (!repeated) {
      const started = this.#startTurn(
        scope,
        { ...ids, ...prompt },
        access,
        options
      )
      this.#sends.remember(
        ids.turnId,
        fingerprint,
        started.then(() => undefined)
      )
      return started
    }
    await repeated
    const execution = this.#executions.get(scopeKey(scope))
    if (execution?.segment.turnId === ids.turnId)
      return this.#repeat(execution, access)
    // The Session no longer holds the turn, so nothing of it is left to replay;
    // the repeat's reader follows the Session from its history.
    return { turnId: ids.turnId, events: ENDED, close: () => undefined }
  }

  async #startTurn(
    scope: SessionScope,
    input: PromptTurnInput,
    access: CoordinatorAccess,
    { stage, quota }: StartOptions
  ): Promise<CoordinatedTurnSubscription> {
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (existing?.segment.turnId === input.turnId) {
      if (existing.admissionFingerprint !== admissionFingerprint(input))
        throw new ServerTurnConflictError()
      return this.#repeat(existing, access)
    }

    if (existing && existing.state !== "idle") {
      if (
        existing.state !== "uncertain" ||
        !(await this.#settleUncertain(scope, existing, access))
      )
        throw new ServerTurnConflictError()
    }
    this.#assertCapacity(key, quota)
    const { turn, generation } = this.#admit(
      scope,
      input.turnId,
      access.principalId
    )
    try {
      const at = Date.now()
      const handle = await this.options.engine.start(
        scope,
        input,
        ...(stage ? [stage] : [])
      )
      const execution: Execution = this.#createExecution({
        scope,
        turn,
        turnId: input.turnId,
        request: input,
        segment: this.#createSegment({
          cacheKey: key,
          turnId: input.turnId,
          generation: this.#landed(turn, generation, "running", input.turnId),
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
      this.#endAdmission(turn, generation)
    }
  }

  /**
   * Answers one request a paused turn is waiting on, from whichever member
   * gives it. The first answer wins: a later one, or one to a request the turn
   * never asked, is stale. Each answer withdraws its request from every member
   * at once; the last one continues the turn as a fresh segment, whose turnId
   * this returns with the one it continues. Every member follows that segment
   * the way it follows any other. A member answers through its Membership,
   * never here, so the membership's offered and delivered records stay in
   * step.
   */
  async answer(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">,
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
    if (request.sessionId !== scope.sessionId)
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
    const recovery = this.#recoverExecution(
      scope,
      request,
      access,
      existing,
      this.#admit(scope, request.turnId)
    )
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
        { sessionId: scope.sessionId, turnId: execution.segment.turnId },
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
    existing: Execution | undefined,
    { turn, generation }: Admission
  ) {
    const key = scopeKey(scope)
    try {
      // A handle that cannot name where this browser stopped reading recovers
      // without a position: a fabricated one would never match a real epoch.
      const position = existing?.segment.handle.recoveryPosition()
      const providerRequest: RecoveryRequest = {
        sessionId: request.sessionId,
        turnId: request.turnId,
        ...(position ? { position } : {}),
      }
      const handle = await this.options.engine.recover(scope, providerRequest)
      const replaced = existing?.segment
      const segment = this.#createSegment({
        cacheKey: key,
        turnId: request.turnId,
        generation: this.#landed(turn, generation, "running", request.turnId),
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
          turn,
          turnId: request.turnId,
          request: providerRequest,
          segment,
        })
      if (existing) existing.segment.fanout.close()
      execution.segment = segment
      this.#executions.set(key, execution)
      this.#trackJournal(segment)
      this.#consume(execution, segment)
      return execution
    } finally {
      this.#endAdmission(turn, generation)
    }
  }

  /**
   * The turn stream is the one place a turn ends, so a Stop that answers after
   * the stream reported the outcome, or after the next turn replaced the
   * segment, is reported to its caller without reopening a Session that is
   * already over: the turn owner no longer takes it.
   */
  async stop(scope: Pick<SessionScope, "agentId" | "providerSessionId">) {
    const execution = this.#executions.get(scopeKey(scope))
    if (!execution || execution.state === "idle") return "idle" as const
    return this.#withControl(execution, async () => {
      const { turn } = execution
      const { generation } = execution.segment
      try {
        const status = await execution.segment.handle.stop()
        const type = status === "idle" ? "stopped" : "stopping"
        // Stopping a wait ends it without an answer.
        if (this.#move(turn, generation, { type }) && status === "idle")
          this.#resolveAttention(execution)
        return status
      } catch (error) {
        if (error instanceof ServerTurnStopNotDispatchedError) {
          this.#move(turn, generation, { type: "undispatched" })
          throw error.failure
        }
        this.#move(turn, generation, { type: "stopFailed" })
        throw error
      }
    })
  }

  async steer(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">,
    request: TurnSteerRequest
  ): Promise<TurnSteerResponse> {
    const execution = this.#executions.get(scopeKey(scope))
    if (
      !execution ||
      execution.state !== "running" ||
      execution.segment.turnId !== request.expectedTurnId
    )
      throw new ServerTurnConflictError()

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
    for (const { owner } of this.#turns.values()) owner.dispose()
    for (const reporter of [
      this.#usage,
      this.#models,
      this.#execution,
      this.#capabilities,
    ])
      reporter.close()
  }

  /** One owner per Session, logging under its ids and the turn it moves. */
  #turn(scope: SessionScope): Turn {
    const key = scopeKey(scope)
    const known = this.#turns.get(key)
    if (known) return known
    const turn: Turn = {
      owner: createOwner(this.#machine, {
        logger: namingTurn(
          this.#logger,
          () => turn.admission ?? this.#executions.get(key)?.segment.turnId
        ),
        clock: this.#clock,
        bindings: { agentId: scope.agentId, sessionId: scope.sessionId },
      }),
    }
    // The execution reading changes with each move the turn makes.
    let reported = turnExecution(turn)
    turn.owner.actor.subscribe(() => {
      const moved = turnExecution(turn)
      if (moved.state === reported.state && moved.turnId === reported.turnId)
        return
      reported = moved
      this.#execution.report(key)
    })
    this.#turns.set(key, turn)
    return turn
  }

  /**
   * Moves a turn for the generation that asks, when that move still applies:
   * a stale generation or a move its state does not take changes nothing.
   */
  #move(turn: Turn, generation: number, event: TurnSignal) {
    if (
      turn.owner.stale(generation) ||
      !turn.owner.actor.getSnapshot().can(event)
    )
      return false
    turn.owner.actor.send(event)
    return true
  }

  /**
   * One admission at a time per Session: a second one conflicts. An admission
   * from rest begins a new turn, which `startedBy` started; any other continues
   * the turn it admits and keeps its starter.
   */
  #admit(scope: SessionScope, turnId: string, startedBy?: string): Admission {
    if (this.#closed) throw new Error("Session coordinator is closed")
    const turn = this.#turn(scope)
    const { generation } = turn.owner
    const fresh = turn.owner.actor.getSnapshot().value === "idle"
    turn.admission = turnId
    if (!this.#move(turn, generation, { type: "admit" })) {
      turn.admission = undefined
      throw new ServerTurnConflictError()
    }
    if (fresh) turn.startedBy = startedBy
    return { turn, generation }
  }

  /** Lands an admission as the turn it admitted, at that turn's generation. */
  #landed(
    turn: Turn,
    generation: number,
    state: "running" | "waiting-for-input",
    turnId: string
  ) {
    if (!this.#move(turn, generation, { type: "admitted", state, turnId }))
      throw new Error("Session coordinator is closed")
    return turn.owner.generation
  }

  /** An admission that did not land returns the turn to where it rested. */
  #endAdmission(turn: Turn, generation: number) {
    this.#move(turn, generation, { type: "refused" })
    turn.admission = undefined
  }

  async #startSegment(execution: Execution, input: RepliesTurnInput) {
    const key = scopeKey(execution.scope)
    const { turn, generation } = this.#admit(execution.scope, input.turnId)
    try {
      const at = Date.now()
      const handle = await this.options.engine.start(execution.scope, input)
      const segment = this.#createSegment({
        cacheKey: key,
        turnId: input.turnId,
        generation: this.#landed(turn, generation, "running", input.turnId),
        handle,
        history: { journal: "start", at },
      })
      this.#forgetJournal(execution.segment)
      // A continued turn is a fresh admission on the same execution record.
      Object.assign(
        execution,
        admittedTurn({
          turnId: input.turnId,
          request: input,
          segment,
        })
      )
      this.#trackJournal(segment)
      this.#consume(execution, segment)
    } finally {
      this.#endAdmission(turn, generation)
    }
  }

  #createExecution(init: ExecutionInit): Execution {
    return {
      scope: init.scope,
      turn: init.turn,
      get state() {
        return turnExecution(this.turn).state
      },
      ...admittedTurn(init),
    }
  }

  /** Scope and clock every observed `ExecutionEvent` carries. */
  #origin(scope: SessionScope, turnId: string) {
    return {
      agentId: scope.agentId,
      // Listeners project to the browser, which knows only public identity.
      sessionId: scope.sessionId,
      turnId,
      occurredAt: new Date().toISOString(),
    }
  }

  #announce(scope: SessionScope, event: ExecutionEvent) {
    const key = scopeKey(scope)
    for (const { key: observed, listener } of [...this.#listeners])
      if (observed === undefined || observed === key)
        try {
          listener(event)
        } catch {
          // A listener must not rewrite the provider outcome.
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
      generation: init.generation,
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
    const { turn } = execution
    const outcome = (type: "ended" | "paused" | "lost") =>
      this.#move(turn, segment.generation, { type })
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
            outcome(segment.requests.length ? "paused" : "ended")
            const origin = this.#origin(execution.scope, segment.turnId)
            if (segment.requests.length)
              for (const request of segment.requests)
                this.#announce(execution.scope, {
                  ...origin,
                  kind: "attention-requested",
                  request: structuredClone(request),
                  ...(execution.turn.startedBy === undefined
                    ? {}
                    : { startedBy: execution.turn.startedBy }),
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
            outcome(interrupted ? "lost" : "ended")
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
        if (!terminal && !turn.owner.stale(segment.generation))
          outcome((await settledNow(segment.handle.settled)) ? "ended" : "lost")
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
      events > this.options.maxSubscriberEvents ||
      bytes > this.options.maxSubscriberBytes
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
    while (journal.retained > this.options.maxSubscriberBytes) {
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
   * A retried admission reads the turn from its beginning, so a journal that no
   * longer holds that beginning answers it with its live events alone. For an
   * already-terminal segment that plan is `reset`, and this path deliberately
   * answers it as an empty live stream rather than a reset: the duplicate
   * admission is not the browser's live reader, and the reader's own redial is
   * where a reset is authoritative and acted upon.
   */
  #repeat(execution: Execution, access: CoordinatorAccess) {
    const plan = replayPlan(execution.segment, 0)
    return this.#subscribe(
      execution.segment,
      0,
      access,
      plan === "history" ? "history" : "live"
    )
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
    const { membershipId } = access
    const usage = this.#usage
    const models = this.#models
    // A reading follows what the subscriber has read, never overtakes it: the
    // code after a `yield` runs once the reader asks for the next event.
    const read = ({ event }: SequencedTurnEvent) => {
      if (event.kind === TurnEventKind.ModelChanged)
        models.report(segment.cacheKey, event.modelId, [membershipId])
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
          if (!closed) usage.report(segment.cacheKey, undefined, [membershipId])
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

  /**
   * Checked as a turn starts, an adopted one included, and never on recovery,
   * in the same step as its admission: every turn another Session holds counts,
   * one still admitting included, so two starts never take one last place; a
   * recovery or discovery still asking the runtime holds a place meanwhile.
   * `quota` counts, besides, the held turns whose starter it picks, so no quota
   * counts a turn this proxy recovered or adopted: it has no starter.
   */
  #assertCapacity(key: string, quota?: TurnQuota) {
    const held = [...this.#turns]
      .filter(
        ([other, { owner }]) =>
          other !== key && owner.actor.getSnapshot().value !== "idle"
      )
      .map(([, turn]) => turn)
    if (held.length >= this.options.maxActiveExecutions)
      throw new ServerTurnCapacityError()
    if (
      quota &&
      held.filter(
        ({ startedBy }) => startedBy !== undefined && quota.predicate(startedBy)
      ).length >= quota.limit
    )
      throw new ServerTurnCapacityError()
  }
}
