import { createHash } from "node:crypto"

import {
  backoffDelay,
  createOwner,
  Deadline,
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
  ServerTurnUncertainError,
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
  type SessionModelUpdateRequest,
  type TurnSteerRequest,
  type TurnSteerResponse,
} from "../../protocol"
import {
  ADMISSION_DEADLINE_MS,
  CLIENT_ADMISSIONS,
  RECONCILE_BACKOFF,
  RETRY_BUDGET,
  UNCERTAINTY_DEADLINE_MS,
} from "./limits"
import { coreFailure } from "./failures"
import { retryBudget } from "./link"
import { SessionReporter, type ReadingListener } from "./session-reporter"
import { SubscriberFanout } from "./subscriber-fanout"

export type SessionExecutionState =
  "idle" | "running" | "stopping" | "waiting-for-input" | "uncertain"

/** The Session status each execution state overlays on the provider's row. */
export const EXECUTION_STATUS: Record<
  SessionExecutionState,
  Session["status"]
> = {
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
export type SendInput = PromptTurnInput | ClientSend

/**
 * A send its client may repeat. A repeat carries the same `sent`, what the
 * client sent, and answers the first admission's result; only a first
 * admission runs `prepare`, so a repeat never takes what the first took.
 */
export type ClientSend = {
  clientId: string
  sent: unknown
  prepare(): Promise<PreparedSend>
}

/** A first admission's prompt, and the attachment stage it took. */
export type PreparedSend = Omit<PromptTurnInput, "turnId" | "messageId"> & {
  stage?: ServerAttachmentStage
}

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
  /** Aborts the start: one aborted once dispatched leaves its turn uncertain. */
  signal?: AbortSignal
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

/**
 * A resume cursor the journal no longer holds the events after, because it
 * pruned them or outgrew its bounds: only history can rebuild that reader.
 */
export class ReplayCursorLostError extends Error {
  constructor() {
    super("The replay journal no longer holds this cursor")
    this.name = "ReplayCursorLostError"
  }
}

export type SessionCoordinatorOptions = {
  engine: ServerTurnEngine
  /**
   * Reads a Session's context window and model catalog for its reporters,
   * writes the model choices a client makes, and creates the Sessions a
   * client asks for; `publicError` tells a recover that met a Session gone,
   * and `link` turning ready takes every failed reading again.
   */
  readings: Pick<
    ServerRuntime,
    | "context"
    | "models"
    | "updateModel"
    | "createSession"
    | "publicError"
    | "link"
  >
  maxActiveExecutions: number
  /** Bounds each subscriber's queue and, as the same limit, each turn's journal. */
  maxSubscriberEvents: number
  maxSubscriberBytes: number
  /** Where each turn owner writes its transitions. */
  logger: Logger
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
  /** The Session is gone: nothing more is read or streamed for it. */
  gone?: (cause: unknown) => void
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
  /** Clock time an uncertain turn no recover confirms running ends at. */
  uncertainUntil: number
  /**
   * The reconciles this turn has made: the first asks at once and each later
   * one waits on backoff, so a turn whose recovered stream keeps dropping never
   * spins against its provider.
   */
  reconciles: number
}

/**
 * What moves one Session's turn: an admission and how it lands, the outcome
 * its provider stream reports, and what a Stop answers.
 */
type TurnSignal =
  | { type: "admit" }
  | {
      type: "admitted"
      /** Uncertain for a start its provider never answered. */
      state: "running" | "waiting-for-input" | "uncertain"
      turnId: string
    }
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

/** What an uncertain turn asks its coordinator for, at its generation. */
type TurnHooks = {
  reconcile(generation: number): void
  outcomeUnknown(generation: number): void
}

/**
 * One Session's turn lifecycle. Only a landed admission bumps the generation,
 * so an outcome reported for an earlier segment is stale by construction.
 * Idle ignores the stream: a turn that Stop settled stays settled. An outcome
 * the stream reports while an admission is in flight moves where the turn
 * rests, as that resting state would take it, so a refused admission returns
 * to where the stream left the turn. An uncertain turn asks `hooks` to
 * reconcile it, and ends at its deadline with its outcome unknown.
 */
export function turnMachine(logger: Logger, clock: Clock, hooks: TurnHooks) {
  const turn = ownerSetup<TurnContext, TurnSignal>(
    "turn",
    logger,
    clock
  ).extend({
    delays: {
      outcomeUnknown: ({ context }) =>
        Math.max(0, context.uncertainUntil - clock.now()),
      reconcile: ({ context }) =>
        context.reconciles === 0
          ? 0
          : backoffDelay(context.reconciles - 1, RECONCILE_BACKOFF),
    },
  })
  const admit = (resting: RestingState) => ({
    target: "admitting" as const,
    // An admission from rest begins a new turn, whose reconciles start over.
    actions: turn.assign(
      resting === "idle" ? { resting, reconciles: 0 } : { resting }
    ),
  })
  const land = turn.assign({
    turnId: ({ event }) =>
      event.type === "admitted" ? event.turnId : undefined,
  })
  // Every move into uncertainty starts its deadline over.
  const doubt = turn.assign({
    uncertainUntil: () => clock.now() + UNCERTAINTY_DEADLINE_MS,
  })
  const unsure = { target: "uncertain" as const, actions: doubt }
  const rest = (from: RestingState[], resting: RestingState) => ({
    guard: ({ context }: { context: TurnContext }) =>
      from.includes(context.resting),
    actions: [
      turn.assign({ resting }),
      ...(resting === "uncertain" ? [doubt] : []),
    ],
  })
  return turn.createMachine({
    context: {
      generation: 0,
      resting: "idle",
      uncertainUntil: 0,
      reconciles: 0,
    },
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
            {
              guard: ({ event }) => event.state === "uncertain",
              target: "uncertain",
              actions: ["bumpGeneration", land, doubt],
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
          lost: unsure,
          stopped: "idle",
          stopping: "stopping",
          stopFailed: unsure,
        },
      },
      stopping: {
        on: {
          ended: "idle",
          paused: "waiting-for-input",
          lost: unsure,
          stopped: "idle",
          undispatched: "running",
          stopFailed: unsure,
        },
      },
      "waiting-for-input": {
        on: {
          admit: admit("waiting-for-input"),
          ended: "idle",
          lost: unsure,
          stopped: "idle",
          stopping: "stopping",
          stopFailed: unsure,
        },
      },
      // Reconciled at once, then on backoff, until a recover confirms the turn
      // running or its deadline ends it. A refused reconcile re-enters, which
      // arms both again.
      uncertain: {
        after: {
          outcomeUnknown: {
            target: "idle",
            actions: ({ context }) => hooks.outcomeUnknown(context.generation),
          },
          reconcile: {
            actions: [
              turn.assign({
                reconciles: ({ context }) => context.reconciles + 1,
              }),
              ({ context }) => hooks.reconcile(context.generation),
            ],
          },
        },
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
  /** The capability key for this session, used when evicting its cells. */
  capabilityKey: string
  /**
   * What a start its provider never answered staged, held while its turn is
   * uncertain, since the provider may be reading it; released if no reconcile
   * confirms the turn, and its adapter's once one does.
   */
  stage?: ServerAttachmentStage
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
  /**
   * Observers were told this turn started. A recovered segment continues the
   * same turn, so it announces no second start.
   */
  startAnnounced: boolean
}

/** Every field one admitted turn owns, shared by a new and a restarted one. */
type AdmittedTurn = Pick<
  Execution,
  | "admissionId"
  | "admissionFingerprint"
  | "segment"
  | "control"
  | "steeringRequests"
  | "startAnnounced"
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
    startAnnounced: false,
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
 * The admissions clients may repeat, each principal's apart, keyed by what
 * each client id derives: a repeat answers the first one's result, and one
 * asking for something else is refused. Bounded per principal, so no
 * principal's admissions push out another's, and expiring on the
 * coordinator's clock, apart from any Execution, so a repeat still finds its
 * admission once the turn is gone. A failed admission is forgotten, so its
 * repeat admits afresh.
 */
class ClientAdmissions<T> {
  /** Each principal's admissions, oldest first; an emptied one is dropped. */
  readonly #principals = new Map<string, Map<string, ClientAdmission<T>>>()

  constructor(private readonly clock: Clock) {}

  /** The first result `key` names while its principal remembers it. */
  repeated(
    principalId: string,
    key: string,
    fingerprint: string
  ): Promise<T> | undefined {
    const now = this.clock.now()
    for (const [principal, entries] of this.#principals) {
      // Entries expire in the order they were admitted.
      for (const [oldest, entry] of entries) {
        if (entry.expiresAt > now) break
        entries.delete(oldest)
      }
      if (entries.size === 0) this.#principals.delete(principal)
    }
    const first = this.#principals.get(principalId)?.get(key)
    if (first && first.fingerprint !== fingerprint)
      throw new ServerClientIdReusedError()
    return first?.result
  }

  remember(
    principalId: string,
    key: string,
    fingerprint: string,
    result: Promise<T>
  ) {
    const entries =
      this.#principals.get(principalId) ?? new Map<string, ClientAdmission<T>>()
    this.#principals.set(principalId, entries)
    const expiresAt = this.clock.now() + CLIENT_ADMISSIONS.ttlMs
    const entry = { fingerprint, expiresAt, result }
    entries.set(key, entry)
    if (entries.size > CLIENT_ADMISSIONS.entries) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    // The admission's own caller reports its failure; this only forgets it.
    void result.catch(() => {
      if (entries.get(key) !== entry) return
      entries.delete(key)
      if (entries.size === 0) this.#principals.delete(principalId)
    })
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

/** How an uncertain turn ends once no recover confirmed it by its deadline. */
const OUTCOME_UNKNOWN = {
  kind: TurnEventKind.TurnFailed,
  code: "AOS_OUTCOME_UNKNOWN",
} as const

export class SessionCoordinator {
  readonly #executions = new Map<string, Execution>()
  readonly #journals = new Map<string, Segment>()
  readonly #turns = new Map<string, Turn>()
  readonly #logger: Logger
  readonly #clock: Clock
  readonly #recoveries = new Map<string, Promise<Execution>>()
  /** Aborts at close, and with it every admission still waiting on a provider. */
  readonly #closing = new AbortController()
  readonly #discoveries = new Map<string, Promise<Execution | undefined>>()
  readonly #listeners = new Set<{
    key?: string
    listener: (event: ExecutionEvent) => void
  }>()
  #closed = false
  /** Active cell subscriber count per session key; zero means evict when idle. */
  readonly #subscribers = new Map<string, number>()
  /** Sessions their last subscriber left, evicted once their turn rests. */
  readonly #pendingEvictions = new Set<string>()
  /** Who hears a Session go, by its session key. */
  readonly #gone = new Set<{
    key: string
    listener: (cause: unknown) => void
  }>()
  /** The failures that ended a Session, which a second report ends no more. */
  readonly #ended = new WeakSet<object>()
  /** How many turns the uncertainty deadline ended with their outcome unknown. */
  #deadlinesFired = 0
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
    this.#logger = options.logger
    this.#clock = options.clock ?? defaultClock
    this.#sends = new ClientAdmissions(this.#clock)
    this.#creates = new ClientAdmissions(this.#clock)
    const cell = {
      link: readings.link,
      budget: retryBudget(RETRY_BUDGET, this.#clock),
      publicError: (err: unknown) => this.#failure(err),
      logger: this.#logger,
      clock: this.#clock,
    }
    // Past the reading's own move, which ending the Session releases.
    const gone = (scope: SessionScope, cause: unknown) =>
      queueMicrotask(() => this.endIfGone(scope, cause))
    this.#usage = new SessionReporter({
      name: "usage",
      read: async (scope) =>
        SessionContextResponseSchema.parse(
          await readings.context(scope.agentId, scope.sessionId)
        ),
      gone,
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
      gone,
      ...cell,
    })
    this.#execution = new SessionReporter({
      name: "execution",
      read: async (scope) => {
        const { state, turnId } = this.#turnExecution(scopeKey(scope))
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
    this.#addSubscriber(key)
    const gone = listeners.gone && { key, listener: listeners.gone }
    if (gone) this.#gone.add(gone)
    const leaves = [
      gone && (() => this.#gone.delete(gone)),
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
      this.#removeSubscriber(key)
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

  /**
   * Writes one model choice and answers the model options a read after it
   * shows. Every subscriber is then owed the readings the switch moves, each
   * read afresh: the model options, and the usage, whose window belongs to
   * the model. `deliver` runs that report, so a caller's answer can land
   * before its own subscription hears it.
   */
  switchModel(
    scope: SessionScope,
    write: SessionModelUpdateRequest,
    deliver: (report: () => void) => void = (report) => report()
  ): Promise<SessionModelsResponse> {
    return this.#command(scope, async () => {
      const { readings } = this.options
      await readings.updateModel(scope.agentId, scope.sessionId, write)
      const models = SessionModelsResponseSchema.parse(
        await readings.models(scope.agentId, scope.sessionId)
      )
      const key = scopeKey(scope)
      deliver(() => {
        this.#models.report(key)
        this.#usage.report(key)
      })
      return models
    })
  }

  state(scope: Pick<SessionScope, "agentId" | "providerSessionId">) {
    return this.#turnExecution(scopeKey(scope)).state
  }

  /**
   * Ends a Session a provider read, report or command found gone, when
   * `cause` says it is: every subscriber to its readings hears it once, then
   * its execution, journal and readings are dropped, so no later resume is
   * served from them and nothing reads it again. One failure ends it once,
   * however many layers report it. Returns whether it was gone.
   */
  endIfGone(scope: SessionScope, cause: unknown) {
    if (this.#closed || this.#failure(cause)?.kind !== "gone") return false
    if (typeof cause === "object" && cause !== null) {
      if (this.#ended.has(cause)) return true
      this.#ended.add(cause)
    }
    const key = scopeKey(scope)
    const { agentId, sessionId } = scope
    this.#logger.warn({ err: cause, agentId, sessionId }, "session.gone")
    // All taken first, so a listener that finds the Session gone again tells
    // nobody twice.
    const heard = [...this.#gone].filter((each) => each.key === key)
    for (const each of heard) this.#gone.delete(each)
    for (const { listener } of heard) listener(cause)
    const segment = this.#executions.get(key)?.segment
    if (segment) {
      segment.terminal = true
      segment.fanout.close()
    }
    this.#evict(key)
    return true
  }

  /** Diagnostic counters for this coordinator's live resources. */
  gauges(): {
    executions: number
    uncertain: number
    deadlinesFired: number
    journalBytes: number
  } {
    let uncertain = 0
    for (const turn of this.#turns.values())
      if (turnExecution(turn).state === "uncertain") uncertain++
    let journalBytes = 0
    for (const segment of this.#journals.values())
      journalBytes += segment.journal?.retained ?? 0
    return {
      executions: this.#executions.size,
      uncertain,
      deadlinesFired: this.#deadlinesFired,
      journalBytes,
    }
  }

  snapshot(
    scope: Pick<SessionScope, "agentId" | "providerSessionId">
  ): SessionSnapshot {
    const key = scopeKey(scope)
    const segment = this.#executions.get(key)?.segment
    const { state, turnId } = this.#turnExecution(key)
    // A start its provider never answered is an uncertain turn with no segment.
    if (!segment && (state !== "uncertain" || turnId === undefined))
      return { state, requests: [] }
    const startedBy = this.#turns.get(key)?.startedBy
    return {
      state,
      turnId: segment?.turnId ?? turnId,
      requests: segment ? structuredClone(openRequests(segment)) : [],
      ...(startedBy === undefined ? {} : { startedBy }),
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
   * How far the live turn has streamed, as the cursor of a view that holds it
   * that far; absent unless its journal still holds what streams on.
   */
  streamed(scope: Pick<SessionScope, "agentId" | "providerSessionId">) {
    const segment = this.#executions.get(scopeKey(scope))?.segment
    if (!segment?.journal || segment.terminal) return undefined
    return { turnId: segment.turnId, after: segment.nextSequence }
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
    // A turn in flight, or one being reconciled, is not the runtime's own.
    const { state } = this.#turnExecution(key)
    if (
      !this.options.engine.discover ||
      (state !== "waiting-for-input" && state !== "idle")
    )
      return existing
    const inFlight = this.#discoveries.get(key)
    if (inFlight) return inFlight
    const discovery = this.#discover(
      scope,
      key,
      state === "waiting-for-input" ? existing : undefined
    )
    this.#discoveries.set(key, discovery)
    // Its caller reports a failed discovery; this only forgets it.
    const forget = () => {
      if (this.#discoveries.get(key) === discovery)
        this.#discoveries.delete(key)
    }
    discovery.then(forget, forget)
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
      const discovered = await this.#deadline().run((signal) =>
        this.options.engine.discover!(scope, turnId, signal)
      )
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
    const repeated = this.#creates.repeated(principalId, key, fingerprint)
    if (repeated) return repeated
    const created = create()
    this.#creates.remember(principalId, key, fingerprint, created)
    return created
  }

  start(
    scope: SessionScope,
    input: SendInput,
    access: CoordinatorAccess,
    options: StartOptions = {}
  ): Promise<CoordinatedTurnSubscription> {
    return this.#command(scope, async () => {
      if (this.#closed) throw new Error("Session coordinator is closed")
      if (!("clientId" in input))
        return this.#startTurn(scope, input, access, options)
      const { clientId, sent, prepare } = input
      const { principalId } = access
      const ids = clientTurnIds(principalId, scope.sessionId, clientId)
      const fingerprint = admissionFingerprint(sent)
      const repeated = this.#sends.repeated(
        principalId,
        ids.turnId,
        fingerprint
      )
      if (!repeated) {
        const started = prepare().then(({ stage, ...prompt }) =>
          this.#startStaged(
            scope,
            { ...ids, ...prompt },
            access,
            options,
            stage
          )
        )
        this.#sends.remember(
          principalId,
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
    })
  }

  /**
   * Starts a first admission with the stage its `prepare` took. A start that
   * fails releases the stage, so its client stages its attachments anew; one
   * its provider may have taken holds it on its turn.
   */
  async #startStaged(
    scope: SessionScope,
    input: PromptTurnInput,
    access: CoordinatorAccess,
    options: StartOptions,
    stage: ServerAttachmentStage | undefined
  ) {
    try {
      return await this.#startTurn(scope, input, access, options, stage)
    } catch (error) {
      if (!(error instanceof ServerTurnUncertainError))
        await this.#releaseStage(scope, stage)
      throw error
    }
  }

  /**
   * Releases what a start staged. A release that fails is logged: the turn's
   * outcome stands.
   */
  async #releaseStage(
    scope: SessionScope,
    stage: ServerAttachmentStage | undefined
  ) {
    await stage
      ?.cleanup()
      .catch((err: unknown) =>
        this.#logger.warn(
          { err, agentId: scope.agentId, sessionId: scope.sessionId },
          "turn.stage.release.failed"
        )
      )
  }

  async #startTurn(
    scope: SessionScope,
    input: PromptTurnInput,
    access: CoordinatorAccess,
    { signal, quota }: StartOptions,
    stage?: ServerAttachmentStage
  ): Promise<CoordinatedTurnSubscription> {
    signal?.throwIfAborted()
    const key = scopeKey(scope)
    const existing = this.#executions.get(key)
    if (existing?.segment.turnId === input.turnId) {
      if (existing.admissionFingerprint !== admissionFingerprint(input))
        throw new ServerTurnConflictError()
      return this.#repeat(existing, access)
    }

    // An uncertain turn holds its Session until a reconcile settles it.
    if (this.state(scope) !== "idle") throw new ServerTurnConflictError()
    this.#assertCapacity(key, quota)
    const { turn, generation } = this.#admit(
      scope,
      input.turnId,
      access.principalId
    )
    const deadline = this.#deadline(signal)
    try {
      const at = Date.now()
      const handle = await this.#startNative(scope, input, stage, deadline)
      const execution: Execution = this.#createExecution({
        scope,
        turn,
        turnId: input.turnId,
        request: input,
        segment: this.#createSegment({
          cacheKey: key,
          turnId: input.turnId,
          generation: this.#landedStart(
            scope,
            turn,
            generation,
            handle,
            input.turnId
          ),
          handle,
          history: { journal: "start", at },
          onTerminal: access.onTerminal,
        }),
      })
      this.#executions.set(key, execution)
      this.#trackJournal(execution.segment)
      this.#consume(execution, execution.segment)
      return this.#subscribe(execution.segment, 0, access)
    } catch (error) {
      if (!deadline.signal.aborted) throw error
      throw this.#unanswered(key, turn, generation, input.turnId, stage)
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
      await this.#command(execution.scope, () =>
        this.#startSegment(execution, { turnId, replies })
      )
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
      if (plan === "reset") return this.#unreplayable(existing.segment, request)
      this.#touchJournal(existing.segment)
      return this.#subscribe(existing.segment, request.after ?? 0, access, plan)
    }

    // A start its provider never answered is a turn without a segment.
    const current = existing?.segment.turnId ?? this.#turnExecution(key).turnId
    if (current !== undefined && current !== request.turnId)
      throw new ServerTurnConflictError()
    const recovered = await this.#recovery(scope, request, existing)
    if (recovered.segment.turnId !== request.turnId)
      throw new ServerTurnConflictError()
    // A recovery that replaced a known execution continues its sequence, so the
    // browser cursor still applies. A recovery of a turn this coordinator never
    // streamed numbers the segment from one, and that cursor means nothing.
    const after = existing ? request.after : undefined
    const plan = request.reset ? "reset" : replayPlan(recovered.segment, after)
    if (plan === "reset") return this.#unreplayable(recovered.segment, request)
    return this.#subscribe(recovered.segment, after ?? 0, access, plan)
  }

  #recovery(
    scope: SessionScope,
    request: CoordinatorRecoveryRequest,
    existing: Execution | undefined
  ) {
    const key = scopeKey(scope)
    const inFlight = this.#recoveries.get(key)
    if (inFlight) return inFlight
    const recovery = this.#recoverExecution(
      scope,
      request,
      existing,
      this.#admit(scope, request.turnId)
    )
    this.#recoveries.set(key, recovery)
    // Its caller reports a failed recovery; this only forgets it.
    const forget = () => {
      if (this.#recoveries.get(key) === recovery) this.#recoveries.delete(key)
    }
    recovery.then(forget, forget)
    return recovery
  }

  /** What a failure is, whether the core or the runtime raised it. */
  #failure(err: unknown) {
    return coreFailure(err) ?? this.options.readings.publicError(err)
  }

  /**
   * Asks the provider how an uncertain turn stands. A recovery that lands
   * confirms the turn running, and its stream reports how the turn ends; one
   * that meets its Session gone ends the turn, since no later recover can
   * confirm it, and then the Session; any other failure leaves it uncertain
   * for the next reconcile.
   */
  async #reconcile(scope: SessionScope, turn: Turn, generation: number) {
    const { value, context } = turn.owner.actor.getSnapshot()
    const { turnId } = context
    if (
      this.#closed ||
      turn.owner.stale(generation) ||
      value !== "uncertain" ||
      turnId === undefined
    )
      return
    try {
      await this.#recovery(
        scope,
        { sessionId: scope.sessionId, turnId },
        this.#executions.get(scopeKey(scope))
      )
    } catch (err) {
      const failure = this.#failure(err)
      if (
        failure?.kind !== "gone" ||
        !this.#move(turn, generation, { type: "ended" })
      )
        throw err
      const { agentId, sessionId } = scope
      this.#logger.warn({ err, agentId, sessionId, turnId }, "turn.gone")
      await this.#failUncertain(scope, turn, turnId, {
        kind: TurnEventKind.TurnFailed,
        code: failure.code,
      })
      // Journaled first, so the turn's end is written before the Session goes.
      this.endIfGone(scope, err)
    }
  }

  /** Ends a turn no recover confirmed running by its deadline. */
  async #outcomeUnknown(scope: SessionScope, turn: Turn, generation: number) {
    const { turnId } = turnExecution(turn)
    if (this.#closed || turn.owner.stale(generation) || turnId === undefined)
      return
    this.#logger.warn(
      { agentId: scope.agentId, sessionId: scope.sessionId, turnId },
      "turn.outcome-unknown"
    )
    await this.#failUncertain(scope, turn, turnId, OUTCOME_UNKNOWN)
  }

  /**
   * Ends an uncertain turn with `failure`, once its owner rests idle. Its
   * readers and observers learn it failed, its journal keeps why for a
   * redial, and what a start it never confirmed staged is released.
   */
  async #failUncertain(
    scope: SessionScope,
    turn: Turn,
    turnId: string,
    failure: TurnEventOf<typeof TurnEventKind.TurnFailed>
  ) {
    const { stage } = turn
    turn.stage = undefined
    const segment = this.#executions.get(scopeKey(scope))?.segment
    const owned = segment?.turnId === turnId ? segment : undefined
    if (owned) {
      owned.terminal = true
      this.#publish(owned, failure)
      owned.fanout.close()
    }
    this.#announce(scope, {
      ...this.#origin(scope, turnId),
      kind: "turn-failed",
    })
    await owned?.onTerminal?.(failure)
    await this.#releaseStage(scope, stage)
  }

  async #recoverExecution(
    scope: SessionScope,
    request: CoordinatorRecoveryRequest,
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
      const handle = await this.#deadline().run((signal) =>
        this.options.engine.recover(scope, providerRequest, signal)
      )
      const replaced = existing?.segment
      const segment = this.#createSegment({
        cacheKey: key,
        turnId: request.turnId,
        // A recovery that cannot land drops its handle: the turn runs on.
        generation: this.#landed(turn, generation, "running", request.turnId),
        handle,
        // One turn keeps one journal and one monotonic sequence across its
        // segments: a browser cursor can never skip a recovered event.
        history: { journal: "continue", previous: replaced },
        onTerminal: replaced?.onTerminal,
      })
      // A turn confirmed running is its adapter's, and so is what it staged.
      turn.stage = undefined
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
    // A start no answer reached holds no execution, yet its turn is not over.
    if (!execution)
      return this.state(scope) === "idle"
        ? ("idle" as const)
        : ("stopping" as const)
    if (execution.state === "idle") return "idle" as const
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
    this.#closing.abort(new Error("Session coordinator is closed"))
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

  #addSubscriber(key: string) {
    this.#subscribers.set(key, (this.#subscribers.get(key) ?? 0) + 1)
    // A subscriber who returns keeps the Session.
    this.#pendingEvictions.delete(key)
  }

  #removeSubscriber(key: string) {
    const count = (this.#subscribers.get(key) ?? 0) - 1
    if (count > 0) {
      this.#subscribers.set(key, count)
      return
    }
    this.#subscribers.delete(key)
    this.#pendingEvictions.add(key)
    this.#evictIfSettled(key)
  }

  /**
   * Evicts a Session its last subscriber left once its turn rests idle with no
   * admission in flight; an admitting turn reads as idle but is not at rest.
   */
  #evictIfSettled(key: string) {
    if (this.#closed || !this.#pendingEvictions.has(key)) return
    const turn = this.#turns.get(key)
    if (
      turn &&
      (turn.admission !== undefined ||
        turn.owner.actor.getSnapshot().value !== "idle")
    )
      return
    this.#evict(key)
  }

  /** Releases a resting Session's turn owner, journal, and reporter cells. */
  #evict(key: string) {
    this.#pendingEvictions.delete(key)
    const turn = this.#turns.get(key)
    if (turn) {
      turn.owner.dispose()
      this.#turns.delete(key)
      this.#capabilities.release(turn.capabilityKey)
    }
    // Nothing resumes from a journal once its execution is gone.
    const journal = this.#journals.get(key)
    if (journal) this.#forgetJournal(journal)
    this.#executions.delete(key)
    for (const reporter of [this.#usage, this.#models, this.#execution])
      reporter.release(key)
  }

  /** One owner per Session, logging under its ids and the turn it moves. */
  #turn(scope: SessionScope): Turn {
    const key = scopeKey(scope)
    const known = this.#turns.get(key)
    if (known) return known
    const { agentId, sessionId } = scope
    // A hook runs once the move that asked for it has landed.
    const later = (message: string, work: () => Promise<void>) =>
      void Promise.resolve()
        .then(work)
        .catch((err: unknown) =>
          this.#logger.warn({ err, agentId, sessionId }, message)
        )
    const machine = turnMachine(this.#logger, this.#clock, {
      reconcile: (generation) =>
        later("turn.reconcile.failed", () =>
          this.#reconcile(scope, turn, generation)
        ),
      outcomeUnknown: (generation) => {
        // Increment synchronously when the machine fires the deadline, before any
        // async work or eviction can dispose the owner and prevent the count.
        this.#deadlinesFired += 1
        later("turn.outcome-unknown.failed", () =>
          this.#outcomeUnknown(scope, turn, generation)
        )
      },
    })
    const turn: Turn = {
      owner: createOwner(machine, {
        logger: namingTurn(
          this.#logger,
          () => turn.admission ?? turnExecution(turn).turnId
        ),
        clock: this.#clock,
        bindings: { agentId, sessionId },
      }),
      capabilityKey: capabilityKey(scope),
    }
    // The execution reading changes with each move the turn makes.
    let reported = turnExecution(turn)
    turn.owner.actor.subscribe((snapshot) => {
      // After the hooks this move queued, so an outcome is delivered first.
      if (snapshot.value === "idle" && this.#pendingEvictions.has(key))
        later("turn.evict.failed", async () => this.#evictIfSettled(key))
      const moved = turnExecution(turn)
      if (moved.state === reported.state && moved.turnId === reported.turnId)
        return
      reported = moved
      this.#execution.report(key)
    })
    this.#turns.set(key, turn)
    return turn
  }

  /** Where a Session's turn is: one no admission has reached is idle. */
  #turnExecution(key: string) {
    const turn = this.#turns.get(key)
    return turn
      ? turnExecution(turn)
      : { state: "idle" as const, turnId: undefined }
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
    state: "running" | "waiting-for-input" | "uncertain",
    turnId: string
  ) {
    if (!this.#move(turn, generation, { type: "admitted", state, turnId }))
      throw new Error(
        this.#closed
          ? "Session coordinator is closed"
          : "Admission displaced by a concurrent turn"
      )
    return turn.owner.generation
  }

  /**
   * Lands a turn this proxy started. One that can no longer land has nobody to
   * stop it later, so its handle is stopped here.
   */
  #landedStart(
    scope: SessionScope,
    turn: Turn,
    generation: number,
    handle: ServerTurnHandle,
    turnId: string
  ) {
    try {
      return this.#landed(turn, generation, "running", turnId)
    } catch (error) {
      this.#stopUnowned(scope, handle, turnId)
      throw error
    }
  }

  /**
   * An admission's deadline, given up early when its caller gives up or the
   * coordinator closes. The close signal is joined, never listened to, so no
   * number of admissions in flight piles listeners on it.
   */
  #deadline(signal?: AbortSignal) {
    const parent = AbortSignal.any(
      signal ? [signal, this.#closing.signal] : [this.#closing.signal]
    )
    return new Deadline(ADMISSION_DEADLINE_MS, this.#clock, parent)
  }

  /**
   * Starts a turn on its provider within `deadline`. A start that answers only
   * after close has nobody to stop it later, so its handle is stopped here.
   */
  #startNative(
    scope: SessionScope,
    input: PromptTurnInput | RepliesTurnInput,
    stage: ServerAttachmentStage | undefined,
    deadline: Deadline
  ) {
    return deadline.run(async (signal) => {
      const handle = await this.options.engine.start(
        scope,
        input,
        stage,
        signal
      )
      if (this.#closed) this.#stopUnowned(scope, handle, input.turnId)
      return handle
    })
  }

  #stopUnowned(scope: SessionScope, handle: ServerTurnHandle, turnId: string) {
    const { agentId, sessionId } = scope
    void handle
      .stop()
      .catch((err: unknown) =>
        this.#logger.warn(
          { err, agentId, sessionId, turnId },
          "turn.late-start.stop.failed"
        )
      )
  }

  /** An admission that did not land returns the turn to where it rested. */
  #endAdmission(turn: Turn, generation: number) {
    this.#move(turn, generation, { type: "refused" })
    turn.admission = undefined
  }

  /**
   * A start its provider never answered may have admitted its turn, so that
   * turn takes the Session from the one before it, and holds what the start
   * staged, uncertain until a reconcile settles it.
   */
  #unanswered(
    key: string,
    turn: Turn,
    generation: number,
    turnId: string,
    stage?: ServerAttachmentStage
  ) {
    this.#landed(turn, generation, "uncertain", turnId)
    turn.stage = stage
    const previous = this.#executions.get(key)
    if (previous) {
      this.#forgetJournal(previous.segment)
      this.#executions.delete(key)
    }
    return new ServerTurnUncertainError()
  }

  async #startSegment(execution: Execution, input: RepliesTurnInput) {
    const key = scopeKey(execution.scope)
    const { turn, generation } = this.#admit(execution.scope, input.turnId)
    const deadline = this.#deadline()
    try {
      const at = Date.now()
      const handle = await this.#startNative(
        execution.scope,
        input,
        undefined,
        deadline
      )
      const segment = this.#createSegment({
        cacheKey: key,
        turnId: input.turnId,
        generation: this.#landedStart(
          execution.scope,
          turn,
          generation,
          handle,
          input.turnId
        ),
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
    } catch (error) {
      if (!deadline.signal.aborted) throw error
      throw this.#unanswered(key, turn, generation, input.turnId)
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
    const { agentId, sessionId } = scope
    for (const { key: observed, listener } of [...this.#listeners])
      if (observed === undefined || observed === key)
        try {
          listener(event)
        } catch (err) {
          // A listener must not rewrite the provider outcome.
          this.#logger.warn(
            { err, agentId, sessionId },
            "execution.listener.failed"
          )
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
    return {
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
    // One start per turn: a new turn, a reply, or a turn this coordinator
    // first sees running. A rediscovered wait is not a start, and a segment
    // recovered from uncertainty continues a turn already announced.
    if (execution.state === "running" && !execution.startAnnounced) {
      execution.startAnnounced = true
      this.#announce(execution.scope, {
        ...this.#origin(execution.scope, segment.turnId),
        kind: "turn-started",
      })
    }
    const { agentId, sessionId } = execution.scope
    const readStream = async () => {
      try {
        for await (const raw of segment.handle.events) {
          // A turn whose outcome went unknown takes no more of its stream.
          if (execution.segment !== segment || segment.terminal) return
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
            } catch (err) {
              // Resource cleanup must not rewrite the provider outcome.
              this.#logger.warn(
                { err, agentId, sessionId },
                "turn.terminal.failed"
              )
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
          if (ended) {
            this.#forgetJournal(segment)
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
            segment.terminal = true
            // Only a turn the provider may still be working on is uncertain. A
            // reset is definite: its journal cannot serve the browser's cursor,
            // so the execution settles and the next turn is admitted, which the
            // adapter still refuses if the native Session is busy.
            const moved = outcome(interrupted ? "lost" : "ended")
            // An uncertain turn is not over: what settles it announces its end.
            if (!(interrupted && moved))
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
        if (!segment.terminal && !turn.owner.stale(segment.generation))
          outcome((await settledNow(segment.handle.settled)) ? "ended" : "lost")
      }
    }
    readStream().catch((err: unknown) =>
      this.#logger.error({ err, agentId, sessionId }, "turn.stream.failed")
    )
  }

  /**
   * A turn that outgrows either replay bound loses its journal. A subscriber the
   * rest of the segment cannot answer then rebuilds from history instead of
   * reading a partial one.
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

  /** Runs one command on a live execution, once the one before it settles. */
  #withControl<T>(execution: Execution, operation: () => Promise<T>) {
    const result = this.#command(execution.scope, () =>
      execution.control.then(operation, operation)
    )
    execution.control = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * Runs one Session command. One that finds its Session gone ends it for
   * every member first, so nothing retries it; its caller still hears why.
   */
  async #command<T>(scope: SessionScope, run: () => Promise<T>) {
    try {
      return await run()
    } catch (cause) {
      this.endIfGone(scope, cause)
      throw cause
    }
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

  /**
   * Answers a reader the journal cannot. One with a cursor is refused, and its
   * resume answers `resync`: that is its one signal to rebuild from history.
   * A cursorless reader, or one that holds part of the turn it cannot position,
   * is sent one reset instead, since nothing else tells it.
   */
  #unreplayable(segment: Segment, request: CoordinatorRecoveryRequest) {
    if (request.after !== undefined && !request.reset)
      throw new ReplayCursorLostError()
    return this.#resetSubscription(segment)
  }

  #resetSubscription(segment: Segment) {
    const candidate: SequencedTurnEvent = {
      sequence: segment.nextSequence + 1,
      event: {
        kind: TurnEventKind.TurnFailed,
        code: "AOS_RESET_REQUIRED",
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
