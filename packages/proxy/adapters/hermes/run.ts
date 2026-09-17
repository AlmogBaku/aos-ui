import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type RunFinishedInterruptOutcome,
  type RunAgentInput,
  type TokenUsage,
} from "@ag-ui/core"
import {
  ServerRunConflictError,
  ServerRunSteerUncertainError,
  type RecoveryRequest,
  type ServerRunHandle,
  type SessionScope,
} from "../../core/runtime"
import {
  projectHermesQuestionArgs,
  projectHermesQuestionResult,
} from "./history"
import {
  HermesMediaTextFilter,
  projectHermesArtifactReceipt,
  projectHermesMediaArtifacts,
} from "./media-artifacts"
import {
  hermesToolResultIsError,
  projectHermesToolArgs,
  projectHermesToolResult,
} from "./tool-data"
import { projectHermesTodos, type HermesTodo } from "./workspace"
import {
  boundedGraphBytes,
  nativeId,
  sessionKey,
  utf8BytesWithin,
} from "./native"
import type { HermesLog } from "./gateway"
import type {
  HermesNativeStatus,
  HermesRunNative,
  HermesSubmitPrompt,
} from "./run-native"
import { redactForLog } from "../../redaction"

const MAX_NATIVE_TEXT_DELTA_BYTES = 1_048_576
const MAX_USER_TURN_BYTES = 1_048_576
const MAX_RECOVERY_EVENTS = 4_096
const MAX_RECOVERY_BYTES = 4_194_304
const MAX_QUEUED_EVENTS = 4_096
const MAX_QUEUED_BYTES = 4_194_304
const MAX_PREACTIVE_EVENTS = 4_096
const MAX_PREACTIVE_BYTES = 4_194_304
const MAX_NATIVE_EVENT_BYTES = 4_194_304
const MAX_TOOL_PAYLOAD_BYTES = 65_536
const MAX_LOGGED_NATIVE_CHARS = 200
/** How long Hermes may keep a Session running after its completion frame. */
const SETTLING_WINDOW_MS = 5_000
const SETTLING_POLL_MS = 1_000
/** How long a turn Hermes admitted behind another one has to start. */
const QUEUED_START_GRACE_MS = 1_000
/** How many further bounded reads a turn that has not started may take. */
const QUEUED_START_REREADS = 4
const RUN_INPUT_FIELDS = new Set([
  "threadId",
  "runId",
  "parentRunId",
  "state",
  "messages",
  "tools",
  "context",
  "forwardedProps",
  "resume",
  "rewindSourceId",
])

export type HermesRunScope = SessionScope

export type HermesNativeEvent = {
  type: string
  session_id: string
  seq?: number
  payload?: unknown
}

export type HermesRecovery = {
  epoch: string
  lastSeen: number
  truncated?: boolean
  events: readonly unknown[]
}

export type HermesRunHandle = ServerRunHandle

/**
 * Where a run's cursor comes from when it attaches to a live Hermes Session.
 *
 * `barrier` is a new turn: only frames newer than Hermes' current watermark
 * belong to it. `position` is a browser reconnect: the run continues from the
 * cursor it already published. `discover` is a proxy restart with no cursor at
 * all, where only the still-open native turn in Hermes' ring is this run's.
 */
type AttachMode =
  | { kind: "barrier" }
  | { kind: "position"; epoch: string; after: number }
  | { kind: "discover" }

export type HermesReconnectRequest = RecoveryRequest

type QueueWaiter = {
  resolve(result: IteratorResult<AGUIEvent>): void
}

class EventQueue implements AsyncIterable<AGUIEvent> {
  readonly #values: { event: AGUIEvent; bytes: number }[] = []
  readonly #waiters: QueueWaiter[] = []
  #bytes = 0
  #closed = false

  push(value: AGUIEvent) {
    if (this.#closed) return false
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else {
      if (this.#values.length >= MAX_QUEUED_EVENTS) return false
      const bytes = boundedGraphBytes(value, MAX_QUEUED_BYTES - this.#bytes)
      if (bytes === undefined) return false
      this.#values.push({ event: value, bytes })
      this.#bytes += bytes
    }
    return true
  }

  terminal(value: AGUIEvent) {
    if (this.#closed) return
    const started =
      this.#values[0]?.event.type === EventType.RUN_STARTED
        ? this.#values[0]
        : undefined
    this.#values.splice(0, this.#values.length)
    this.#bytes = 0
    if (started) this.#values.push(started)
    if (started) this.#bytes += started.bytes
    const terminalBytes = boundedGraphBytes(
      value,
      MAX_QUEUED_BYTES - this.#bytes
    )
    if (terminalBytes !== undefined) {
      this.#values.push({ event: value, bytes: terminalBytes })
      this.#bytes += terminalBytes
    }
    this.close()
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AGUIEvent> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value) {
          this.#bytes -= value.bytes
          return Promise.resolve({ done: false, value: value.event })
        }
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.#waiters.push({ resolve }))
      },
    }
  }
}

type ActiveRun = {
  scope: HermesRunScope
  runId: string
  liveSessionId: string
  queue: EventQueue
  unsubscribe: () => void
  epoch: string
  lastSeen: number
  messageId?: string
  generation: number
  sealedMessageIds: Set<string>
  textStarted: boolean
  streamedText?: string
  mediaFilter: HermesMediaTextFilter
  reasoningStarted: boolean
  reasoningEnded: boolean
  streamedReasoning: string
  tools: Map<string, { name: string; ended: boolean; messageId: string }>
  /** How the native turn this run follows ended, as Hermes reported it. */
  turn: TurnOutcome
  /** Hermes' own client-safe classification of a terminal failure. */
  failure?: NativeFailure
  /** A bare `error` frame arrived; only a status read says whether it settled. */
  errorObserved: boolean
  /** `chain`: a correction was accepted. `pending`: one is in flight. */
  redirect: { chain: boolean; pending: boolean }
  stopping: boolean
  uncertain: boolean
  /** The queue is closed and the native observer released; nothing may emit. */
  detached: boolean
  terminal: boolean
  /** Hermes accepted this turn but has not started it yet (queue, steer). */
  awaitingStart: boolean
  /** Live frames waiting behind the one in-flight `session.events.since`. */
  catchUp?: BufferedNativeEvents
  /** A settlement edge a catch-up deferred; re-decided once the page drained. */
  deferredEdge?: SettlementEdge
  usage?: TokenUsage[]
  settled: Promise<void>
  resolveSettled(): void
}

type BufferedNativeEvents = {
  events: unknown[]
  bytes: number
  overflow: boolean
}

/** The native turn outcome; `open` means Hermes has not ended the turn yet. */
type TurnOutcome = "open" | "complete" | "failed" | "interrupted"

/**
 * What proved Hermes has nothing left to run for this turn: its own idle
 * `session.info` frame, an authoritative status read, or such a read taken while
 * a turn Hermes admitted behind another one had still not started.
 */
type SettlementEdge = "idle" | "status" | "unstarted"

/**
 * The parts of a terminal Hermes failure AOS may act on. `nativeMessage` is
 * kept only for the redacted server log and never reaches the browser.
 */
type NativeFailure = {
  layer?: string
  code?: string
  retryable?: boolean
  failureReason?: string
  nativeMessage?: string
}

/**
 * Hermes keeps the Session running while its turn thread finishes bookkeeping
 * after the completion frame. Until it reports idle the Session is still busy
 * for AOS, so the next Send waits here instead of reading "busy".
 */
type SettlingWatcher = {
  readonly active: ActiveRun
  readonly done: Promise<void>
  settled: boolean
  settle(): void
}

export class HermesRunPublicError extends Error {
  readonly code: "AOS_PROVIDER_UNAVAILABLE" | "AOS_STOP_UNCERTAIN"

  constructor(
    code: "AOS_PROVIDER_UNAVAILABLE" | "AOS_STOP_UNCERTAIN",
    message: string
  ) {
    super(message)
    this.name = "HermesRunPublicError"
    this.code = code
  }
}

/** The requested rewind point no longer exists in authoritative Hermes history. */
export class HermesRunRewindConflictError extends Error {
  constructor() {
    super("The Hermes Session can no longer be rewound to that message")
    this.name = "HermesRunRewindConflictError"
  }
}

const RESET_REQUIRED_MESSAGE =
  "Hermes history must be reconciled before this run can continue."
const CONNECTION_INTERRUPTED_MESSAGE =
  "The Hermes connection was interrupted; reconnect to reconcile this run."
const SEND_UNCERTAIN_MESSAGE =
  "Hermes may have accepted this turn; reconcile before sending again."
const INTERACTION_UNCERTAIN_MESSAGE =
  "Hermes may have applied this interaction response; reconcile before responding again."
const SESSION_BUSY_MESSAGE = "Hermes is already running this Session."
const RUN_FAILED_MESSAGE = "Hermes could not complete this run."

function providerUnavailable() {
  return new HermesRunPublicError(
    "AOS_PROVIDER_UNAVAILABLE",
    "Hermes is temporarily unavailable."
  )
}

function stopUncertain() {
  return new HermesRunPublicError(
    "AOS_STOP_UNCERTAIN",
    "Hermes could not confirm Stop; reconcile before sending again."
  )
}

function bufferNativeEvent(buffer: BufferedNativeEvents, value: unknown) {
  if (buffer.overflow) return
  const bytes = boundedGraphBytes(value, MAX_PREACTIVE_BYTES - buffer.bytes)
  if (
    bytes === undefined ||
    buffer.events.length >= MAX_PREACTIVE_EVENTS ||
    bytes > MAX_PREACTIVE_BYTES - buffer.bytes
  ) {
    buffer.overflow = true
    buffer.events.splice(0, buffer.events.length)
    buffer.bytes = 0
    return
  }
  buffer.events.push(value)
  buffer.bytes += bytes
}

function drainBufferedEvents(buffer: BufferedNativeEvents) {
  const events = buffer.events.splice(0, buffer.events.length)
  buffer.bytes = 0
  return events
}

/**
 * The sequence a catch-up has to reach for the held frames to continue the run.
 * Nothing held (an ordinary heal that missed no frame) demands nothing.
 */
function firstBufferedSeq(events: readonly unknown[]) {
  for (const value of events) {
    const seq = nativeEvent(value)?.seq
    if (seq !== undefined) return seq
  }
  return 0
}

function safelyUnsubscribe(unsubscribe: (() => void) | undefined) {
  try {
    unsubscribe?.()
  } catch {
    // Native cleanup errors are intentionally not exposed across the proxy.
  }
}

function settlingWatcher(active: ActiveRun): SettlingWatcher {
  let resolve!: () => void
  const done = new Promise<void>((settled) => {
    resolve = settled
  })
  const watcher: SettlingWatcher = {
    active,
    done,
    settled: false,
    settle() {
      watcher.settled = true
      resolve()
    },
  }
  return watcher
}

/** Whether `done` resolved before `ms` elapsed. */
function resolvedWithin(done: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function runSettlement() {
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  return { settled, resolveSettled }
}

function userText(input: RunAgentInput) {
  const message = input.messages[0]
  if (!message || message.role !== "user") return undefined
  if (typeof message.content === "string") return message.content.trim()
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || undefined
}

function nativeEvent(value: unknown): HermesNativeEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const event = value as Record<string, unknown>
  if (typeof event.type !== "string" || typeof event.session_id !== "string")
    return undefined
  if (
    event.seq !== undefined &&
    (typeof event.seq !== "number" ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0)
  )
    return undefined
  return {
    type: event.type,
    session_id: event.session_id,
    ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
    ...(event.payload !== undefined ? { payload: event.payload } : {}),
  }
}

function nativeEventSessionId(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  try {
    return stableNativeId((value as Record<string, unknown>).session_id)
  } catch {
    return undefined
  }
}

/**
 * Every replayed frame must belong to this live Session, carry a sequence, and
 * arrive in increasing order inside the page Hermes reported. An unusable page
 * is never partially accepted: the caller reconciles instead.
 */
function validatedReplay(
  recovery: HermesRecovery,
  liveSessionId: string,
  after?: number
) {
  if (
    !stableNativeId(recovery.epoch) ||
    !Number.isSafeInteger(recovery.lastSeen) ||
    recovery.lastSeen < (after ?? 0) ||
    !Array.isArray(recovery.events) ||
    recovery.events.length > MAX_RECOVERY_EVENTS
  )
    return undefined
  const events: HermesNativeEvent[] = []
  let previous = after
  let recoveryBytes = 0
  for (const raw of recovery.events) {
    const bytes = boundedGraphBytes(raw, MAX_RECOVERY_BYTES - recoveryBytes)
    const event = nativeEvent(raw)
    if (
      bytes === undefined ||
      !event ||
      event.session_id !== liveSessionId ||
      event.seq === undefined ||
      (previous !== undefined && event.seq <= previous) ||
      event.seq > recovery.lastSeen
    )
      return undefined
    events.push(event)
    recoveryBytes += bytes
    previous = event.seq
  }
  return events
}

/**
 * The frames of the last native turn Hermes has not closed. A turn is closed by
 * its `message.complete` or by an idle `session.info`; everything before the
 * last unclosed `message.start` belongs to an earlier turn and to authoritative
 * history, never to the run being attached.
 */
function openTurnFrames(events: readonly HermesNativeEvent[]) {
  let start = -1
  for (const [index, event] of events.entries()) {
    if (event.type === "message.start") start = index
    else if (
      event.type === "message.complete" ||
      (event.type === "session.info" && payloadOf(event).running === false)
    )
      start = -1
  }
  if (start === -1) return undefined
  const frames = events.slice(start)
  return frames[0]?.seq === undefined ? undefined : frames
}

function payloadOf(event: HermesNativeEvent) {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {}
}

function stableNativeId(value: unknown) {
  return nativeId(value, 512)
}

function canonicalToolName(name: string) {
  return name === "delegate_task"
    ? "delegate_subagent"
    : name === "skill_view"
      ? "use_skill"
      : name === "todo_list"
        ? "todo"
        : name === "clarify"
          ? "question"
          : name
}

function toolArgs(name: string, value: unknown) {
  const args =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}
  return args
}

function normalizedTool(name: string, value: unknown) {
  const args = toolArgs(name, value)
  if (
    name !== "tool_call" ||
    typeof args.name !== "string" ||
    typeof args.arguments !== "string" ||
    utf8BytesWithin(args.arguments, MAX_TOOL_PAYLOAD_BYTES) === undefined
  )
    return { name, args }
  try {
    const selectedArgs = JSON.parse(args.arguments) as unknown
    if (typeof selectedArgs !== "object" || selectedArgs === null)
      return { name, args }
    return {
      name: args.name,
      args: toolArgs(args.name, selectedArgs),
    }
  } catch {
    return { name, args }
  }
}

function safeToolArgs(_name: string, value: Record<string, unknown>) {
  const projected = projectHermesToolArgs(value)
  if (_name !== "present_artifact") return JSON.stringify(projected)
  const receipt: Record<string, unknown> = {}
  for (const key of ["id", "title", "filename", "mimeType", "sizeBytes"])
    if (key in projected) receipt[key] = projected[key]
  return JSON.stringify(receipt)
}

function resultContent(_name: string, value: unknown, isError = false) {
  return JSON.stringify(projectHermesToolResult(value, isError))
}

function boundedText(value: unknown) {
  return typeof value === "string" &&
    utf8BytesWithin(value, MAX_NATIVE_TEXT_DELTA_BYTES) !== undefined
    ? value
    : undefined
}

function tokenUsage(value: unknown): TokenUsage[] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const native = value as Record<string, unknown>
  const numeric = ["input", "output", "reasoning", "total"] as const
  if (
    (native.model !== undefined && !stableNativeId(native.model)) ||
    numeric.some(
      (key) =>
        native[key] !== undefined &&
        (typeof native[key] !== "number" ||
          !Number.isSafeInteger(native[key]) ||
          native[key] < 0)
    )
  )
    return undefined
  const model = stableNativeId(native.model)
  const usage: TokenUsage = {
    ...(model ? { model } : {}),
    ...(typeof native.input === "number" ? { inputTokens: native.input } : {}),
    ...(typeof native.output === "number"
      ? { outputTokens: native.output }
      : {}),
    ...(typeof native.reasoning === "number"
      ? { reasoningTokens: native.reasoning }
      : {}),
    ...(typeof native.total === "number" ? { totalTokens: native.total } : {}),
  }
  return Object.keys(usage).length > 0 ? [usage] : undefined
}

/**
 * Hermes has no turn left to run: either it reports the Session idle or it no
 * longer lists it at all. An absent Session is never evidence of anything else.
 */
function settledStatus(status: HermesNativeStatus) {
  return status === "idle" || status === "absent"
}

/** Hermes' native turn status; anything unknown is read as a plain completion. */
function turnOutcome(status: unknown): TurnOutcome {
  return status === "error"
    ? "failed"
    : status === "interrupted"
      ? "interrupted"
      : "complete"
}

/**
 * Hermes' own classification of a failure (`error_surface`, `failure_reason`)
 * plus the native text, which only the server log may see.
 */
function nativeFailure(payload: Record<string, unknown>): NativeFailure {
  const surface = payload.error_surface
  const fields =
    typeof surface === "object" && surface !== null
      ? (surface as Record<string, unknown>)
      : {}
  const native = payload.error ?? payload.message
  return loggedFields({
    layer: stableNativeId(fields.layer),
    code: stableNativeId(fields.code),
    retryable:
      typeof fields.retryable === "boolean" ? fields.retryable : undefined,
    failureReason: stableNativeId(payload.failure_reason),
    nativeMessage:
      typeof native === "string" && native
        ? native.slice(0, MAX_LOGGED_NATIVE_CHARS)
        : undefined,
  })
}

/** Drop absent fields so nothing is recorded or logged as `undefined`. */
function loggedFields<T extends Record<string, unknown>>(fields: T) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

/** Native text is diagnosable only in the server log, and only redacted. */
function loggedNativeMessage(failure: NativeFailure | undefined) {
  return failure?.nativeMessage === undefined
    ? undefined
    : redactForLog(failure.nativeMessage)
}

/**
 * The public explanation of a failed native turn. Hermes' classification picks
 * the message; its own error text never leaves the server.
 */
function publicRunFailure(failure: NativeFailure) {
  const code = failure.code?.toLowerCase() ?? ""
  if (code === "agent_init_failed")
    return {
      code: "AOS_PROVIDER_AGENT_UNAVAILABLE",
      message: "Hermes could not start the agent for this Session.",
    }
  if (failure.layer === "billing" || /billing|quota|insufficient/u.test(code))
    return {
      code: "AOS_PROVIDER_BILLING_FAILED",
      message: "Hermes reported a billing or quota problem.",
    }
  if (failure.retryable === true)
    return {
      code: "AOS_PROVIDER_RETRYABLE_FAILURE",
      message: "Hermes hit a temporary provider error. Retry the message.",
    }
  return { code: "AOS_PROVIDER_RUN_FAILED", message: RUN_FAILED_MESSAGE }
}

function isEmptyAuthority(value: unknown) {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value !== "object") return false
  return Object.keys(value).length === 0
}

export class HermesRunEngine {
  readonly #native: HermesRunNative
  readonly #log: HermesLog
  readonly #active = new Map<string, ActiveRun>()
  readonly #admissions = new Set<string>()
  readonly #settling = new Map<string, SettlingWatcher>()
  readonly #plans = new Map<
    string,
    { messageId: string; todos: HermesTodo[] }
  >()

  constructor(native: HermesRunNative, options: { log?: HermesLog } = {}) {
    this.#native = native
    this.#log = options.log ?? { warn: () => undefined }
  }

  async start(
    scope: HermesRunScope,
    candidate: unknown
  ): Promise<HermesRunHandle> {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      Object.keys(candidate).some((key) => !RUN_INPUT_FIELDS.has(key))
    )
      throw new Error("AOS received unsupported run fields")
    const input = RunAgentInputSchema.parse(candidate)
    const rewindSourceId = (candidate as { rewindSourceId?: unknown })
      .rewindSourceId
    if (
      rewindSourceId !== undefined &&
      (typeof rewindSourceId !== "string" ||
        rewindSourceId.length === 0 ||
        rewindSourceId.length > 256)
    )
      throw new Error("AOS received an invalid rewind source")
    if (!isEmptyAuthority(input.state))
      throw new Error("AOS does not accept browser state as Hermes input")
    if (input.tools.length > 0)
      throw new Error("AOS does not accept browser tools as Hermes input")
    if (input.context.length > 0)
      throw new Error("AOS does not accept browser context as Hermes input")
    if (!isEmptyAuthority(input.forwardedProps))
      throw new Error(
        "AOS does not accept browser forwarded properties as Hermes input"
      )
    const interactionResume =
      input.resume && input.resume.length > 0 ? input.resume : undefined
    const newMessage = input.messages[0]
    if (
      newMessage?.role === "user" &&
      Array.isArray(newMessage.content) &&
      newMessage.content.some((part) => part.type !== "text")
    )
      throw new Error(
        "AOS multimodal content must be staged through an authorized workspace operation"
      )
    const text = userText(input)
    if (input.threadId !== scope.threadId)
      throw new Error("AOS run scope does not match this Session")
    if (
      interactionResume
        ? input.messages.length !== 0
        : input.messages.length !== 1 || !text
    )
      throw new Error(
        interactionResume
          ? "AOS interrupt responses require one bound native interaction"
          : "AOS runs require exactly one authorized user turn"
      )
    if (text && new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES)
      throw new Error("The AOS user turn is too large")

    const key = sessionKey(scope)
    const stale = this.#active.get(key)
    if (this.#admissions.has(key) || (stale && !stale.uncertain))
      throw new ServerRunConflictError()
    this.#admissions.add(key)

    let active: ActiveRun
    try {
      // An uncertain run holds the Session until Hermes says its turn is over.
      if (stale) await this.#settleStale(stale)
      active = this.#createActive(scope, input.runId)
      await this.#attach(active, { kind: "barrier" })
    } finally {
      this.#admissions.delete(key)
    }
    if (active.terminal) return this.#handle(active)
    if (interactionResume) {
      let results: readonly { status: string }[]
      try {
        results = await this.#native.respondInteractions(
          { ...scope, runId: input.runId },
          interactionResume
        )
      } catch {
        this.#fail(
          active,
          "AOS_INTERACTION_FAILED",
          "Hermes could not apply this interaction response."
        )
        return this.#handle(active)
      }
      if (active.terminal) return this.#handle(active)
      if (results.some(({ status }) => status === "uncertain")) {
        this.#detach(
          active,
          "AOS_INTERACTION_UNCERTAIN",
          INTERACTION_UNCERTAIN_MESSAGE
        )
      } else if (results.some(({ status }) => status === "expired")) {
        this.#fail(
          active,
          "AOS_INTERACTION_EXPIRED",
          "This Hermes interaction is no longer pending."
        )
      }
      return this.#handle(active)
    }
    // The Session stays busy for AOS while Hermes finishes the previous turn.
    await this.#settling.get(key)?.done
    let status: HermesNativeStatus
    try {
      status = await this.#native.status(active.liveSessionId)
    } catch {
      if (!this.#isSubmitEligible(active)) return this.#handle(active)
      this.#settle(active)
      throw providerUnavailable()
    }
    if (!this.#isSubmitEligible(active)) return this.#handle(active)
    // Only a Session running a turn is authoritatively busy; one that is still
    // building its Agent, or that Hermes does not list, accepts the turn.
    if (status === "working" || status === "waiting") {
      this.#fail(active, "AOS_SESSION_BUSY", SESSION_BUSY_MESSAGE)
      return this.#handle(active)
    }
    await this.#submit(
      active,
      {
        scope,
        text: text!,
        runId: input.runId,
        ...(rewindSourceId === undefined
          ? {}
          : { rewindSourceId: rewindSourceId as string }),
      },
      false
    )
    return this.#handle(active)
  }

  async recover(
    scope: HermesRunScope,
    request: HermesReconnectRequest
  ): Promise<HermesRunHandle> {
    if (request.threadId !== scope.threadId)
      throw new Error(
        "The reconnect position is not authorized for this Session"
      )
    const key = sessionKey(scope)
    const existing = this.#active.get(key)
    if (existing) {
      if (
        existing.runId !== request.runId ||
        (!existing.uncertain && !existing.detached)
      )
        throw new ServerRunConflictError()
      return this.#reattach(
        existing,
        request.position ?? {
          epoch: existing.epoch,
          lastSeen: existing.lastSeen,
        }
      )
    }
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#admissions.add(key)

    const active = this.#createActive(scope, request.runId)
    try {
      await this.#attach(
        active,
        request.position
          ? {
              kind: "position",
              epoch: request.position.epoch,
              after: request.position.lastSeen,
            }
          : // Nothing published a cursor for this run: only Hermes' own open
            // turn identifies it.
            { kind: "discover" }
      )
    } finally {
      this.#admissions.delete(key)
    }
    return this.#handle(active)
  }

  async discover(scope: HermesRunScope, runId: string) {
    const snapshot = await this.#native.inspectExecution({ ...scope, runId })
    if (snapshot.status === "waiting-for-input" && snapshot.outcome) {
      const events: AGUIEvent[] = [
        { type: EventType.RUN_STARTED, threadId: scope.threadId, runId },
        {
          type: EventType.RUN_FINISHED,
          threadId: scope.threadId,
          runId,
          outcome: snapshot.outcome,
        },
      ]
      return {
        state: "waiting-for-input" as const,
        interrupts: snapshot.outcome.interrupts,
        handle: {
          events: (async function* () {
            yield* events
          })(),
          settled: Promise.resolve(),
          stop: async () => "idle" as const,
          recoveryPosition: () => ({
            epoch: "restored-interrupt",
            lastSeen: 0,
          }),
        },
      }
    }
    if (snapshot.status !== "running") return undefined
    return {
      state: "running" as const,
      handle: await this.recover(scope, { threadId: scope.threadId, runId }),
    }
  }

  /** The same run continues on a new stream from the browser's own cursor. */
  async #reattach(
    active: ActiveRun,
    position: { epoch: string; lastSeen: number }
  ): Promise<HermesRunHandle> {
    const queue = new EventQueue()
    queue.push({
      type: EventType.RUN_STARTED,
      threadId: active.scope.threadId,
      runId: active.runId,
    })
    active.queue = queue
    active.uncertain = false
    active.detached = false
    await this.#attach(active, {
      kind: "position",
      epoch: position.epoch,
      after: position.lastSeen,
    })
    return this.#handle(active)
  }

  #createActive(scope: HermesRunScope, runId: string): ActiveRun {
    const queue = new EventQueue()
    queue.push({
      type: EventType.RUN_STARTED,
      threadId: scope.threadId,
      runId,
    })
    return {
      scope,
      runId,
      liveSessionId: "",
      queue,
      unsubscribe: () => undefined,
      epoch: "",
      lastSeen: 0,
      generation: 0,
      sealedMessageIds: new Set(),
      textStarted: false,
      streamedText: "",
      mediaFilter: new HermesMediaTextFilter(),
      reasoningStarted: false,
      reasoningEnded: false,
      streamedReasoning: "",
      tools: new Map(),
      turn: "open",
      errorObserved: false,
      redirect: { chain: false, pending: false },
      stopping: false,
      uncertain: false,
      detached: false,
      terminal: false,
      awaitingStart: false,
      ...runSettlement(),
    }
  }

  /**
   * The one path that binds a run to a live Hermes Session: a new turn, a
   * browser reconnect, discovery after a proxy restart and an in-place reattach
   * differ only in `mode`, so the cursor rule lives here once.
   */
  async #attach(active: ActiveRun, mode: AttachMode) {
    const buffered: BufferedNativeEvents = {
      events: [],
      bytes: 0,
      overflow: false,
    }
    let accepting = false
    let reattached = false
    let lost: "disconnected" | "rebound" | "restart" | undefined
    let unsubscribe: (() => void) | undefined
    let liveSessionId: string
    let epoch: string
    let barrier: number
    let head: number | undefined
    let replayed: readonly HermesNativeEvent[] | undefined
    let reconcile = false
    safelyUnsubscribe(active.unsubscribe)
    try {
      ;({ liveSessionId } = await this.#native.resume(active.scope))
      unsubscribe = await this.#native.observe(liveSessionId, (signal) => {
        if (signal.kind === "event") {
          if (nativeEventSessionId(signal.event) !== liveSessionId) return
          if (!accepting) bufferNativeEvent(buffered, signal.event)
          else this.#accept(active, signal.event)
          return
        }
        if (signal.kind === "reattached") {
          // Hermes kept this live Session across the heal; its ring holds
          // whatever the socket missed.
          if (accepting) this.#scheduleCatchUp(active)
          else reattached = true
          return
        }
        if (signal.kind !== "lost") return
        lost = signal.reason
        if (accepting) this.#lost(active, signal.reason)
      })
      if (mode.kind === "barrier") {
        // A new turn needs only Hermes' current epoch and watermark: retained
        // frames belong to earlier turns and to authoritative history.
        const cursor = await this.#native.cursor(liveSessionId)
        epoch = cursor.epoch
        barrier = cursor.latestSeq
      } else if (mode.kind === "position") {
        const recovery = await this.#native.replay(liveSessionId, mode.after)
        const events = validatedReplay(recovery, liveSessionId, mode.after)
        epoch = recovery.epoch
        barrier = mode.after
        head = recovery.lastSeen
        if (recovery.truncated === true || !events || epoch !== mode.epoch)
          reconcile = true
        else replayed = events
      } else {
        const recovery = await this.#native.replay(liveSessionId, 0)
        const events = validatedReplay(recovery, liveSessionId, 0)
        const open = events && openTurnFrames(events)
        epoch = recovery.epoch
        barrier = recovery.lastSeen
        if (!events) reconcile = true
        else if (open) {
          replayed = open
          head = recovery.lastSeen
          barrier = open[0]!.seq! - 1
        } else {
          const status = await this.#native.status(liveSessionId)
          if (settledStatus(status)) reconcile = true
          else {
            // Hermes is working but its ring no longer holds this turn's start;
            // authoritative history restores the earlier frames.
            const cursor = await this.#native.cursor(liveSessionId)
            epoch = cursor.epoch
            barrier = cursor.latestSeq
          }
        }
      }
    } catch {
      safelyUnsubscribe(unsubscribe)
      active.uncertain = true
      active.detached = true
      active.queue.close()
      throw providerUnavailable()
    }
    active.liveSessionId = liveSessionId
    active.unsubscribe = unsubscribe
    active.epoch = epoch
    active.lastSeen = barrier
    active.catchUp = undefined
    active.deferredEdge = undefined
    this.#active.set(sessionKey(active.scope), active)
    if (reconcile || buffered.overflow) {
      drainBufferedEvents(buffered)
      this.#fail(active, "AOS_RESET_REQUIRED", RESET_REQUIRED_MESSAGE)
      return
    }
    if (lost) {
      drainBufferedEvents(buffered)
      this.#lost(active, lost)
      return
    }
    if (replayed && !this.#acceptReplayed(active, replayed)) {
      drainBufferedEvents(buffered)
      this.#fail(active, "AOS_RESET_REQUIRED", RESET_REQUIRED_MESSAGE)
      return
    }
    // Hermes reported a watermark past the last frame this page carried, so the
    // sequences in between are missing rather than delivered: read the ring once
    // more instead of skipping over them.
    if (head !== undefined && head > active.lastSeen)
      this.#scheduleCatchUp(active)
    accepting = true
    for (const event of drainBufferedEvents(buffered))
      this.#accept(active, event, true)
    if (reattached) this.#scheduleCatchUp(active)
  }

  /**
   * Accept a replayed page. Replayed frames must continue the run's own
   * sequence: a gap means Hermes dropped frames this run already needs, which
   * only authoritative history can reconcile.
   */
  #acceptReplayed(active: ActiveRun, events: readonly HermesNativeEvent[]) {
    for (const event of events) {
      if (active.terminal) return true
      if (event.seq === undefined) {
        this.#accept(active, event, true)
        continue
      }
      if (event.seq <= active.lastSeen) continue
      if (event.seq !== active.lastSeen + 1) return false
      this.#accept(active, event, true)
    }
    return true
  }

  /** Hold a live frame behind the single in-flight catch-up for this run. */
  #scheduleCatchUp(active: ActiveRun, value?: unknown) {
    if (active.terminal) return
    const running = active.catchUp !== undefined
    const buffer = (active.catchUp ??= {
      events: [],
      bytes: 0,
      overflow: false,
    })
    if (value !== undefined) bufferNativeEvent(buffer, value)
    if (!running) void this.#catchUp(active)
  }

  /**
   * A catch-up page belongs to the attachment it was read for. A detach or a
   * later attach replaces that attachment, so a page that arrives afterwards can
   * neither advance the frozen watermark nor fail whoever holds the run now.
   */
  #ownsCatchUp(active: ActiveRun, buffer: BufferedNativeEvents) {
    if (active.catchUp !== buffer) return false
    if (!active.terminal && !active.detached) return true
    active.catchUp = undefined
    return false
  }

  async #catchUp(active: ActiveRun) {
    const buffer = active.catchUp
    if (!buffer || active.terminal) return
    let recovery: HermesRecovery
    try {
      recovery = await this.#native.replay(
        active.liveSessionId,
        active.lastSeen
      )
    } catch {
      if (!this.#ownsCatchUp(active, buffer)) return
      active.catchUp = undefined
      // The run cannot be made contiguous while Hermes is unreachable; the
      // browser reconnects and replays from the frozen cursor.
      this.#detach(
        active,
        "AOS_CONNECTION_INTERRUPTED",
        CONNECTION_INTERRUPTED_MESSAGE
      )
      return
    }
    if (!this.#ownsCatchUp(active, buffer)) return
    const events = validatedReplay(
      recovery,
      active.liveSessionId,
      active.lastSeen
    )
    active.catchUp = undefined
    const held = drainBufferedEvents(buffer)
    if (
      recovery.epoch !== active.epoch ||
      recovery.truncated === true ||
      !events ||
      buffer.overflow ||
      !this.#acceptReplayed(active, events) ||
      // A held frame the page never reached means Hermes' ring no longer holds
      // the gap. An empty page with nothing held is an ordinary heal, where the
      // socket missed no frame at all.
      (!active.terminal && firstBufferedSeq(held) > active.lastSeen + 1)
    ) {
      this.#fail(active, "AOS_RESET_REQUIRED", RESET_REQUIRED_MESSAGE)
      return
    }
    for (const event of held) this.#accept(active, event, true)
    const deferred = active.deferredEdge
    active.deferredEdge = undefined
    if (deferred) this.#settleFrom(active, deferred)
  }

  /** Hermes' authoritative answer to "is this Session's turn over?". */
  async #settleStale(active: ActiveRun) {
    let status: HermesNativeStatus
    try {
      status = await this.#native.status(active.liveSessionId)
    } catch {
      throw new ServerRunConflictError()
    }
    if (!settledStatus(status)) throw new ServerRunConflictError()
    this.#settle(active)
  }

  /**
   * Submit the authorized user turn. `retried` records the single re-send
   * Hermes' own "that live Session is gone" allows: it rejected the write, so
   * nothing ran and rebinding the durable Session is not a repeated mutation.
   */
  async #submit(
    active: ActiveRun,
    prompt: HermesSubmitPrompt,
    retried: boolean
  ) {
    if (!this.#isSubmitEligible(active)) return
    let outcome: Awaited<ReturnType<HermesRunNative["submit"]>>
    try {
      outcome = await this.#native.submit(active.liveSessionId, prompt)
    } catch (error) {
      if (error instanceof HermesRunRewindConflictError) {
        this.#fail(
          active,
          "AOS_REWIND_CONFLICT",
          "This response can no longer be regenerated because Hermes history changed."
        )
        return
      }
      // Nothing was written, so this run never began: it settles silently and
      // the caller learns Hermes is unavailable.
      this.#settle(active)
      throw providerUnavailable()
    }
    if (active.terminal) return
    if (outcome.acknowledgement === "uncertain") {
      if (!active.messageId)
        this.#detach(active, "AOS_SEND_UNCERTAIN", SEND_UNCERTAIN_MESSAGE)
      return
    }
    if (outcome.acknowledgement === "accepted") {
      // Only a queued admission puts this turn behind another one, so its first
      // frame is a `message.start`, not the current turn's idle boundary. An
      // in-place `steered`/`redirected` admission merged the prompt into the
      // turn already running: that turn's completion is this run's outcome.
      if (outcome.status === "queued") active.awaitingStart = true
      if (!outcome.completion) return
      if (outcome.completion.output) {
        active.messageId = `aos-command:${prompt.runId}`
        this.#startText(active)
        this.#emit(active, {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: active.messageId,
          delta: outcome.completion.output,
        })
      }
      this.#finish(
        active,
        outcome.completion.composerPrefill === undefined
          ? undefined
          : { "aos.composerPrefill": outcome.completion.composerPrefill }
      )
      return
    }
    if (outcome.reason === "command-with-attachments") {
      this.#fail(
        active,
        "AOS_COMMAND_WITH_ATTACHMENTS",
        "Slash commands cannot be sent with attachments."
      )
      return
    }
    if (outcome.reason === "busy") {
      this.#fail(active, "AOS_SESSION_BUSY", SESSION_BUSY_MESSAGE)
      return
    }
    if (outcome.reason !== "session-gone" || retried) {
      this.#fail(
        active,
        outcome.reason === "session-gone"
          ? "AOS_RESET_REQUIRED"
          : "AOS_PROVIDER_RUN_FAILED",
        outcome.reason === "session-gone"
          ? RESET_REQUIRED_MESSAGE
          : "Hermes rejected this command."
      )
      return
    }
    try {
      await this.#attach(active, { kind: "barrier" })
    } catch (error) {
      this.#settle(active)
      throw error
    }
    if (active.terminal) return
    await this.#submit(active, prompt, true)
  }

  #handle(active: ActiveRun): HermesRunHandle {
    return {
      events: active.queue,
      settled: active.settled,
      stop: () => this.#stop(active),
      steer: (request) => this.#steer(active, request.text),
      recoveryPosition: () => ({
        epoch: active.epoch,
        lastSeen: active.lastSeen,
      }),
    }
  }

  /**
   * `replayed` marks a frame that came from a replayed page or from a buffer
   * drained behind one: only there can a frame at or before the watermark be an
   * ordinary duplicate.
   */
  #accept(active: ActiveRun, value: unknown, replayed = false) {
    if (active.terminal) {
      this.#observeSettling(active, value)
      return
    }
    if (nativeEventSessionId(value) !== active.liveSessionId) return
    if (boundedGraphBytes(value, MAX_NATIVE_EVENT_BYTES) === undefined) {
      this.#overflow(active)
      return
    }
    const event = nativeEvent(value)
    if (!event || event.session_id !== active.liveSessionId) return
    if (event.seq !== undefined) {
      if (event.seq === active.lastSeen) return
      if (event.seq < active.lastSeen) {
        if (replayed) return
        // Hermes restarted this Session's counter inside the same epoch, so its
        // ring can no longer address the rest of the turn.
        this.#fail(active, "AOS_RESET_REQUIRED", RESET_REQUIRED_MESSAGE)
        return
      }
      if (active.catchUp) {
        bufferNativeEvent(active.catchUp, value)
        return
      }
      if (event.seq !== active.lastSeen + 1) {
        // A frame is missing: hold this one and read the ring once. Hermes
        // stamps `seq` per Session before routing, so the watermark's successor
        // is always the next frame this run must deliver, whether the watermark
        // came from a barrier read or from a frame this run delivered.
        this.#scheduleCatchUp(active, value)
        return
      }
      active.lastSeen = event.seq
    }
    const payload = payloadOf(event)
    let interaction:
      RunFinishedInterruptOutcome | { status: string } | undefined
    try {
      interaction = this.#native.acceptInteraction(
        { ...active.scope, runId: active.runId },
        active.liveSessionId,
        value
      )
    } catch {
      this.#fail(
        active,
        "AOS_PROVIDER_RUN_FAILED",
        "Hermes returned invalid interaction data."
      )
      return
    }
    if (interaction && "interrupts" in interaction) {
      this.#finishInterrupt(active, interaction)
      return
    }
    if (event.type === "session.info" || event.type === "session.usage") {
      const usage = tokenUsage(payload.usage)
      if (usage) active.usage = usage
    }
    if (event.type === "message.start") {
      // A native turn is running again: the turn Hermes admitted behind another
      // one has begun, and no earlier outcome describes this run any more,
      // including an error frame the superseded turn left unreconciled.
      active.awaitingStart = false
      active.turn = "open"
      active.failure = undefined
      active.errorObserved = false
      if (!active.messageId) {
        const messageId = stableNativeId(payload.message_id ?? payload.id)
        if (messageId && active.sealedMessageIds.has(messageId)) return
        active.messageId = messageId ?? this.#fallbackMessageId(active)
      }
      return
    }
    const textDelta = boundedText(payload.text)
    if (event.type === "message.delta" && textDelta !== undefined) {
      if (textDelta.length === 0) return
      this.#appendStreamedText(active, textDelta)
      this.#emitMediaFilteredText(active, active.mediaFilter.write(textDelta))
      return
    }
    if (event.type === "message.interim" && textDelta !== undefined) {
      if (textDelta.length === 0) return
      this.#ensureMessageId(active)
      const streamedText = active.streamedText
      if (streamedText !== undefined && textDelta.startsWith(streamedText)) {
        const remaining = textDelta.slice(streamedText.length)
        if (remaining) {
          this.#appendStreamedText(active, remaining)
          this.#emitMediaFilteredText(
            active,
            active.mediaFilter.write(remaining)
          )
        }
      } else if (payload.already_streamed !== true) {
        this.#appendStreamedText(active, textDelta)
        this.#emitMediaFilteredText(active, active.mediaFilter.write(textDelta))
      }
      // Interim assistant commentary is a message boundary inside the native
      // turn. Hermes may continue with more tools and another text message;
      // only message.complete settles the run.
      this.#sealGeneration(active)
      return
    }
    // Hermes uses thinking.delta for transient spinner/status copy. It is not
    // model reasoning and must not be persisted into the reasoning message.
    if (event.type === "thinking.delta") return
    if (
      event.type === "reasoning.delta" &&
      textDelta !== undefined &&
      !active.textStarted
    ) {
      this.#ensureMessageId(active)
      this.#appendReasoning(active, textDelta)
      return
    }
    if (
      event.type === "reasoning.available" &&
      textDelta !== undefined &&
      !active.textStarted &&
      active.streamedReasoning.length === 0
    ) {
      this.#ensureMessageId(active)
      this.#appendReasoning(active, textDelta)
      return
    }
    if (event.type === "tool.start" || event.type === "tool.progress") {
      this.#startTool(active, payload)
      return
    }
    if (event.type === "tool.complete") {
      const tool = this.#startTool(active, payload)
      if (!tool || tool.ended) return
      tool.ended = true
      const toolCallId = stableNativeId(payload.tool_id)
      if (!toolCallId) return
      const isError = hermesToolResultIsError(
        payload.result,
        payload.is_error === true
      )
      const artifact =
        tool.name === "present_artifact" && !isError
          ? projectHermesArtifactReceipt(payload.result)
          : undefined
      const mediaArtifacts = isError
        ? []
        : projectHermesMediaArtifacts(toolCallId, tool.name, payload.result)
      const questionResult =
        tool.name === "question"
          ? projectHermesQuestionResult(payload.result)
          : undefined
      this.#emit(active, { type: EventType.TOOL_CALL_END, toolCallId })
      this.#emit(active, {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${tool.messageId}:tool:${toolCallId}`,
        toolCallId,
        content: artifact
          ? JSON.stringify(artifact.result)
          : tool.name === "text_to_speech"
            ? JSON.stringify({
                status: isError ? "failed" : "completed",
              })
            : questionResult
              ? JSON.stringify(questionResult)
              : resultContent(tool.name, payload.result, isError),
        role: "tool",
      })
      if (tool.name === "todo") {
        const todos = projectHermesTodos(payload.result)
        if (todos !== undefined) this.#emitPlan(active, todos)
      }
      if (artifact)
        this.#emit(active, {
          type: EventType.CUSTOM,
          name: artifact.part.name,
          value: artifact.part.data,
        })
      for (const media of mediaArtifacts) {
        active.mediaFilter.trust(media.reference)
        this.#emit(active, {
          type: EventType.CUSTOM,
          name: "aos.artifact",
          value: media.descriptor,
        })
      }
      return
    }
    if (event.type === "session.info" && payload.running === false) {
      this.#settleFrom(active, "idle")
      return
    }
    if (event.type === "error") {
      // Hermes also uses `error` for advisory failures such as a rejected
      // pending model switch, after which the current turn keeps running.
      // Reconcile native liveness before emitting terminal AG-UI state.
      active.errorObserved = true
      const failure = nativeFailure(payload)
      active.failure ??= failure
      void this.#reconcileNativeError(active, failure)
      return
    }
    if (event.type === "message.complete") {
      // Hermes ends the turn a queued prompt waits behind before it reports
      // idle, so a completion that arrives before this run's own turn started
      // describes the superseded turn: neither its text, its usage nor its
      // outcome belongs here. Seal what is open and wait for this run's turn.
      if (active.awaitingStart) {
        this.#sealGeneration(active)
        return
      }
      const usage = tokenUsage(payload.usage)
      if (usage) active.usage = usage
      const completedMessageId = stableNativeId(
        payload.message_id ?? payload.id
      )
      // Hermes ended the turn; how it ended decides what settlement does.
      active.turn = turnOutcome(payload.status)
      if (active.turn === "failed") active.failure = nativeFailure(payload)
      const redirecting = active.redirect.chain || active.redirect.pending
      // A completion for a generation this run already sealed belongs to the
      // turn a correction superseded, not to the text the run is streaming.
      if (
        redirecting &&
        completedMessageId &&
        active.sealedMessageIds.has(completedMessageId)
      )
        return
      if (!active.messageId && completedMessageId)
        active.messageId = completedMessageId
      const finalText = boundedText(payload.text)
      if (finalText) this.#ensureMessageId(active)
      if (
        finalText !== undefined &&
        active.messageId &&
        active.streamedText !== undefined &&
        finalText.startsWith(active.streamedText)
      ) {
        const remaining = finalText.slice(active.streamedText.length)
        if (remaining) {
          this.#appendStreamedText(active, remaining)
          this.#emitMediaFilteredText(
            active,
            active.mediaFilter.write(remaining)
          )
        }
      }
      // A failed turn is not settled from its own frame: seal its assistant
      // message and wait for Hermes' idle edge, while still accepting later
      // buffered tool/message frames in source order. A correction in the chain
      // keeps the run open for the turn that correction lands in.
      if (active.turn === "failed" || redirecting) this.#sealGeneration(active)
      else if (active.turn === "interrupted")
        this.#finish(active, { stopped: true })
      else this.#finish(active)
    }
  }

  /** After the turn ended, the only frame left that matters is Hermes idling. */
  #observeSettling(active: ActiveRun, value: unknown) {
    const watcher = this.#settling.get(sessionKey(active.scope))
    if (watcher?.active !== active) return
    const event = nativeEvent(value)
    if (event?.session_id !== active.liveSessionId) return
    if (event.type === "session.info" && payloadOf(event).running === false)
      watcher.settle()
  }

  #appendStreamedText(active: ActiveRun, delta: string) {
    if (active.streamedText === undefined) return
    active.streamedText = boundedText(active.streamedText + delta)
  }

  #emitMediaFilteredText(active: ActiveRun, delta: string) {
    if (!delta) return
    const messageId = this.#ensureMessageId(active)
    this.#endReasoning(active)
    this.#startText(active)
    this.#emit(active, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
    })
  }

  #flushMediaText(active: ActiveRun) {
    this.#emitMediaFilteredText(active, active.mediaFilter.finish())
  }

  #emitPlan(active: ActiveRun, todos: HermesTodo[]) {
    const key = sessionKey(active.scope)
    const messageId = `aos-plan:${active.scope.threadId}`
    const previous = this.#plans.get(key)
    if (previous && JSON.stringify(previous.todos) === JSON.stringify(todos))
      return
    const emitted = previous
      ? this.#emit(active, {
          type: EventType.ACTIVITY_DELTA,
          messageId,
          activityType: "PLAN",
          patch: [{ op: "replace", path: "/todos", value: todos }],
        })
      : this.#emit(active, {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId,
          activityType: "PLAN",
          content: { todos },
          replace: true,
        })
    if (emitted)
      this.#plans.set(key, { messageId, todos: structuredClone(todos) })
  }

  #startText(active: ActiveRun) {
    if (active.textStarted || !active.messageId) return
    active.textStarted = true
    this.#emit(active, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: active.messageId,
      role: "assistant",
    })
  }

  /** Close the assistant text message this generation opened, if any. */
  #endText(active: ActiveRun) {
    if (!active.textStarted || !active.messageId) return
    this.#emit(active, {
      type: EventType.TEXT_MESSAGE_END,
      messageId: active.messageId,
    })
  }

  #ensureMessageId(active: ActiveRun) {
    active.messageId ??= this.#fallbackMessageId(active)
    return active.messageId
  }

  #fallbackMessageId(active: ActiveRun) {
    return active.generation === 0
      ? `${active.runId}:assistant`
      : `${active.runId}:assistant:${active.generation + 1}`
  }

  #startTool(active: ActiveRun, payload: Record<string, unknown>) {
    const toolCallId = stableNativeId(payload.tool_id)
    if (!toolCallId) return undefined
    const existing = active.tools.get(toolCallId)
    if (existing) return existing
    const messageId = this.#ensureMessageId(active)
    const nativeName = stableNativeId(payload.name)
    if (!nativeName) return undefined
    const normalized = normalizedTool(nativeName, payload.args)
    const tool = {
      name: canonicalToolName(normalized.name),
      ended: false,
      messageId,
    }
    active.tools.set(toolCallId, tool)
    this.#emit(active, {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: tool.name,
      parentMessageId: messageId,
    })
    this.#emit(active, {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta:
        tool.name === "question"
          ? JSON.stringify(projectHermesQuestionArgs(normalized.args) ?? {})
          : safeToolArgs(tool.name, normalized.args),
    })
    return tool
  }

  #appendReasoning(active: ActiveRun, delta: string) {
    if (delta.length === 0 || !active.messageId || active.reasoningEnded) return
    const reasoningId = `${active.messageId}:reasoning`
    if (!active.reasoningStarted) {
      active.reasoningStarted = true
      this.#emit(active, {
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningId,
        role: "reasoning",
      })
    }
    if (
      this.#emit(active, {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta,
      })
    )
      active.streamedReasoning += delta
  }

  #settleOpenTools(active: ActiveRun, status?: "completed" | "stopped") {
    for (const [toolCallId, tool] of active.tools) {
      if (tool.ended) continue
      tool.ended = true
      this.#emit(active, { type: EventType.TOOL_CALL_END, toolCallId })
      if (status)
        this.#emit(active, {
          type: EventType.TOOL_CALL_RESULT,
          messageId: `${tool.messageId}:tool:${toolCallId}`,
          toolCallId,
          content: JSON.stringify({ status }),
          role: "tool",
        })
    }
  }

  #endReasoning(active: ActiveRun) {
    if (!active.reasoningStarted || active.reasoningEnded || !active.messageId)
      return
    active.reasoningEnded = true
    this.#emit(active, {
      type: EventType.REASONING_MESSAGE_END,
      messageId: `${active.messageId}:reasoning`,
    })
  }

  async #stop(active: ActiveRun): Promise<"stopping" | "idle"> {
    if (active.terminal) return "idle"
    if (!active.stopping) {
      active.stopping = true
      let outcome: "interrupted" | "gone"
      try {
        outcome = await this.#native.interrupt(active.liveSessionId)
      } catch {
        active.uncertain = true
        throw stopUncertain()
      }
      // Hermes stating it has no live Session left is a confirmed Stop.
      if (outcome === "gone") {
        this.#finish(active, { stopped: true }, true)
        return "idle"
      }
    }
    try {
      // Only idle or absent confirms Stop. A Session that is still building its
      // Agent has merely latched the cancel request.
      if (settledStatus(await this.#native.status(active.liveSessionId))) {
        this.#finish(active, { stopped: true }, true)
        return "idle"
      }
    } catch {
      // Stop was already acknowledged. An unavailable status read cannot make
      // the mutation safe to retry or prove that Hermes is idle.
    }
    return "stopping"
  }

  /**
   * A bare `error` frame is not a terminal contract: Hermes emits it for
   * advisory failures too. One authoritative status read decides, and the
   * verdict is logged once per frame.
   */
  async #reconcileNativeError(active: ActiveRun, failure: NativeFailure) {
    let status: HermesNativeStatus | undefined
    try {
      status = await this.#native.status(active.liveSessionId)
    } catch {
      // A failed read cannot prove termination; later frames stay authoritative.
    }
    const verdict =
      status === undefined
        ? "unconfirmed"
        : settledStatus(status)
          ? "terminal"
          : "advisory"
    this.#log.warn(
      "hermes.run.native_error",
      loggedFields({
        verdict,
        status,
        nativeMessage: loggedNativeMessage(failure),
      })
    )
    if (active.terminal || verdict === "unconfirmed") return
    if (verdict === "advisory") {
      active.errorObserved = false
      // The turn kept running, so this frame is not the cause of any later
      // failure and must not be logged as one.
      if (active.failure === failure) active.failure = undefined
      return
    }
    this.#settleFrom(active, "status")
  }

  async #steer(active: ActiveRun, text: string) {
    if (
      active.terminal ||
      active.stopping ||
      active.uncertain ||
      active.redirect.pending
    )
      throw new ServerRunConflictError()
    const generation = active.generation
    const previousChain = active.redirect.chain
    active.redirect.pending = true
    try {
      const status = await this.#native.redirect(active.liveSessionId, text)
      this.#steerAcknowledged(active, generation, status === "queued")
      return status === "redirected"
        ? ("steered" as const)
        : ("queued" as const)
    } catch (error) {
      active.redirect.pending = false
      // Hermes may have applied a correction whose acknowledgement was lost, so
      // the run keeps following the chain; a rejected correction never landed.
      if (error instanceof ServerRunSteerUncertainError)
        this.#steerAcknowledged(active, generation, true)
      else {
        active.redirect.chain = previousChain
        if (active.turn !== "open" || active.errorObserved)
          this.#recheckSettlement(active, 0)
      }
      throw error
    }
  }

  /** The correction is Hermes' now: this run follows the turn it lands in. */
  #steerAcknowledged(active: ActiveRun, generation: number, queued: boolean) {
    active.redirect.pending = false
    active.redirect.chain = true
    if (active.generation === generation) this.#sealGeneration(active)
    // A queued correction runs only after the current turn's idle edge.
    if (queued) active.awaitingStart = true
    // A turn boundary may have passed while the correction was in flight, and a
    // queued correction may never be drained; only Hermes can say which.
    if (queued || active.turn !== "open" || active.errorObserved)
      this.#recheckSettlement(active, queued ? QUEUED_START_GRACE_MS : 0)
  }

  #sealGeneration(active: ActiveRun) {
    this.#flushMediaText(active)
    this.#endReasoning(active)
    this.#endText(active)
    if (active.messageId) active.sealedMessageIds.add(active.messageId)
    active.messageId = undefined
    active.generation += 1
    active.textStarted = false
    active.streamedText = ""
    active.mediaFilter = new HermesMediaTextFilter()
    active.reasoningStarted = false
    active.reasoningEnded = false
    active.streamedReasoning = ""
  }

  /**
   * The one place a terminal outcome is decided once the native turn is over.
   * `edge` records what proved Hermes has nothing left to run for this turn.
   */
  #settleFrom(active: ActiveRun, edge: SettlementEdge) {
    if (active.terminal) return
    // A page read for a hole is authoritative about what this turn still
    // contains, so a status read taken while it is in flight cannot terminalize
    // the run ahead of the frames the page is about to deliver.
    if (active.catchUp) {
      active.deferredEdge = edge
      return
    }
    // A detached run publishes nothing; a confirmed idle edge only releases the
    // fence it holds on the Session.
    if (active.detached) {
      this.#settle(active)
      return
    }
    // Either a correction is deciding whether this turn continues, or the turn
    // Hermes admitted behind another one has not started, so this edge is not
    // this run's outcome yet. An authoritative read that already found Hermes
    // idle is still evidence: Hermes may be about to start the turn it admitted,
    // so one bounded re-read decides instead of the read being discarded.
    if (active.redirect.pending || active.awaitingStart) {
      if (edge === "idle" || (edge === "status" && active.awaitingStart))
        this.#recheckSettlement(
          active,
          active.awaitingStart ? QUEUED_START_GRACE_MS : 0
        )
      return
    }
    if (active.stopping || active.turn === "interrupted")
      this.#finish(active, { stopped: true }, true)
    // Hermes admitted this turn and then went idle without ever running it, so
    // no assistant turn exists: the run reports a failure the user can retry
    // rather than an empty success. Nothing this turn produced can describe it —
    // an outcome or error observed while it waited belongs to the turn it waited
    // behind — so the failure is AOS' own rather than a native classification.
    else if (edge === "unstarted")
      this.#failTurn(active, { failureReason: "queued-turn-not-started" })
    else if (active.turn === "failed" || active.errorObserved)
      this.#failTurn(active)
    else if (active.turn === "complete") this.#finish(active, undefined, true)
    // A correction chain has no completion frame of its own to wait for, so
    // Hermes' own idle frame ends it.
    else if (edge === "idle" && active.redirect.chain)
      this.#finish(active, undefined, true)
    // Otherwise this is a mid-turn heartbeat: a bounded status read is too weak
    // to end a turn that is still open.
  }

  /** The only producer of a public run failure from a native turn outcome. */
  #failTurn(active: ActiveRun, override?: NativeFailure) {
    const failure = override ?? active.failure ?? {}
    const { code, message } = publicRunFailure(failure)
    this.#log.warn(
      "hermes.run.failed",
      loggedFields({
        publicCode: code,
        code: failure.code,
        layer: failure.layer,
        retryable: failure.retryable,
        failureReason: failure.failureReason,
        nativeMessage: loggedNativeMessage(failure),
      })
    )
    this.#fail(active, code, message)
  }

  /**
   * Re-read Hermes after something that could have ended the turn without a
   * usable edge: a correction that was in flight at the boundary, or a turn
   * Hermes admitted behind another one that may never start.
   */
  #recheckSettlement(
    active: ActiveRun,
    delayMs: number,
    rereads = QUEUED_START_REREADS
  ) {
    setTimeout(() => void this.#settleIfIdle(active, rereads), delayMs)
  }

  async #settleIfIdle(active: ActiveRun, rereads: number) {
    if (active.terminal || active.redirect.pending) return
    let status: HermesNativeStatus | undefined
    try {
      status = await this.#native.status(active.liveSessionId)
    } catch {
      // A failed read proves nothing; the re-reads below still bound the wait.
    }
    if (active.terminal) return
    if (status !== undefined && settledStatus(status)) {
      // Hermes has no turn left, so nothing this run waits for can still
      // arrive. A turn still awaiting its start here was never run at all.
      const unstarted = active.awaitingStart
      active.awaitingStart = false
      this.#settleFrom(active, unstarted ? "unstarted" : "status")
      return
    }
    // Hermes is still busy, so this read cannot say whether the turn it admitted
    // behind another one is starting or was dropped. Bounded re-reads keep a
    // start that never comes from fencing the Session behind this run.
    if (active.awaitingStart && rereads > 0)
      this.#recheckSettlement(active, QUEUED_START_GRACE_MS, rereads - 1)
  }

  #watchSettling(active: ActiveRun) {
    const key = sessionKey(active.scope)
    this.#settling.get(key)?.settle()
    const watcher = settlingWatcher(active)
    this.#settling.set(key, watcher)
    void this.#awaitSettled(key, watcher)
  }

  async #awaitSettled(key: string, watcher: SettlingWatcher) {
    const { active } = watcher
    const deadline = Date.now() + SETTLING_WINDOW_MS
    // A retainer only keeps the native binding warm, so no Send waits past the
    // settling window for a slow native resume: it is released whenever it
    // arrives and the bounded wait below runs on its own deadline.
    const retainer = this.#native
      .retain(active.scope, "settling")
      .catch(() => undefined)
    await resolvedWithin(retainer, SETTLING_WINDOW_MS)
    while (!watcher.settled && Date.now() < deadline) {
      const read = this.#native
        .status(active.liveSessionId)
        .catch(() => undefined)
      // A slow native read may not hold the next Send past the window either.
      if (!(await resolvedWithin(read, deadline - Date.now()))) break
      const status = await read
      if (status === undefined || settledStatus(status)) break
      if (await resolvedWithin(watcher.done, SETTLING_POLL_MS)) break
    }
    watcher.settle()
    void retainer.then((release) => release?.())
    if (this.#settling.get(key) === watcher) this.#settling.delete(key)
    safelyUnsubscribe(active.unsubscribe)
  }

  /**
   * `confirmedIdle` records that Hermes already reported the Session settled, so
   * the next Send needs no settling watcher.
   */
  #finish(active: ActiveRun, result?: unknown, confirmedIdle = false) {
    if (active.terminal) return
    this.#flushMediaText(active)
    this.#endReasoning(active)
    this.#settleOpenTools(
      active,
      typeof result === "object" &&
        result !== null &&
        "stopped" in result &&
        result.stopped === true
        ? "stopped"
        : "completed"
    )
    this.#endText(active)
    this.#emit(active, {
      type: EventType.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      ...(result === undefined ? {} : { result }),
      ...(active.usage ? { usage: active.usage } : {}),
      outcome: { type: "success" },
    })
    this.#native.clearPendingInteraction(active.scope)
    if (!confirmedIdle) this.#watchSettling(active)
    this.#settle(active)
  }

  #finishInterrupt(active: ActiveRun, outcome: RunFinishedInterruptOutcome) {
    if (active.terminal) return
    this.#endReasoning(active)
    this.#settleOpenTools(active)
    this.#endText(active)
    this.#emit(active, {
      type: EventType.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      outcome,
    })
    this.#settle(active)
  }

  #fail(active: ActiveRun, code: string, message: string) {
    if (active.terminal) return
    this.#endReasoning(active)
    this.#endText(active)
    this.#emit(active, { type: EventType.RUN_ERROR, message, code })
    this.#native.clearPendingInteraction(active.scope)
    this.#settle(active)
  }

  /** The observed frame stream ended; how it ended decides what the run does. */
  #lost(active: ActiveRun, reason: "disconnected" | "rebound" | "restart") {
    if (reason === "disconnected")
      this.#detach(
        active,
        "AOS_CONNECTION_INTERRUPTED",
        CONNECTION_INTERRUPTED_MESSAGE
      )
    // A rebound or restarted live Session cannot answer for this run's cursor.
    else this.#fail(active, "AOS_RESET_REQUIRED", RESET_REQUIRED_MESSAGE)
  }

  /**
   * Stop consuming without settling: the run may still be alive in Hermes, so
   * the browser reconciles. Releasing the native observer freezes the watermark
   * at the last delivered frame, so a reconnect replays from there instead of
   * past a frame nobody received.
   */
  #detach(active: ActiveRun, code: string, message: string) {
    if (active.terminal || active.detached) return
    this.#emit(active, { type: EventType.RUN_ERROR, message, code })
    active.uncertain = true
    active.detached = true
    active.catchUp = undefined
    active.queue.close()
    safelyUnsubscribe(active.unsubscribe)
  }

  #emit(active: ActiveRun, event: AGUIEvent) {
    if (active.terminal) return false
    // An uncertain run's stream is no longer authoritative: the browser
    // reconciles it. Publishing into it would only fill a queue nobody reads,
    // and an overflow there would settle the run without that reconcile.
    if (active.uncertain) return true
    if (active.queue.push(event)) return true
    this.#overflow(active)
    return false
  }

  #overflow(active: ActiveRun) {
    if (active.terminal) return
    active.queue.terminal({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
    this.#settle(active)
  }

  #isSubmitEligible(active: ActiveRun) {
    return (
      this.#active.get(sessionKey(active.scope)) === active &&
      !active.terminal &&
      !active.uncertain &&
      !active.detached &&
      !active.stopping
    )
  }

  #settle(active: ActiveRun) {
    if (active.terminal) return
    active.terminal = true
    // A settling watcher keeps the native observation until Hermes reports the
    // Session idle; without one nothing observes this Session any more.
    if (this.#settling.get(sessionKey(active.scope))?.active !== active)
      safelyUnsubscribe(active.unsubscribe)
    active.queue.close()
    active.resolveSettled()
    const key = sessionKey(active.scope)
    if (this.#active.get(key) === active) this.#active.delete(key)
  }
}
