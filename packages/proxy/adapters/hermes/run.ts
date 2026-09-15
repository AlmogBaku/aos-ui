import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type ResumeEntry,
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
  projectHermesArtifactReceipt,
  projectHermesQuestionArgs,
  projectHermesQuestionResult,
} from "./history"
import { projectHermesToolArgs, projectHermesToolResult } from "./tool-data"
import { projectHermesTodos, type HermesTodo } from "./workspace"

const MAX_NATIVE_TEXT_DELTA_BYTES = 1_048_576
const MAX_USER_TURN_BYTES = 1_048_576
const MAX_RECOVERY_EVENTS = 4_096
const MAX_RECOVERY_BYTES = 4_194_304
const MAX_QUEUED_EVENTS = 4_096
const MAX_QUEUED_BYTES = 4_194_304
const MAX_PREACTIVE_EVENTS = 4_096
const MAX_PREACTIVE_BYTES = 4_194_304
const MAX_NATIVE_EVENT_BYTES = 4_194_304
const MAX_GRAPH_ENTRIES = 1_024
const MAX_GRAPH_DEPTH = 12
const MAX_TOOL_PAYLOAD_BYTES = 65_536
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

export type HermesRunNative = {
  resume(scope: HermesRunScope): Promise<{ liveSessionId: string }>
  observe(
    liveSessionId: string,
    listener: (event: unknown) => void,
    disconnected?: (error?: Error) => void
  ): Promise<() => void>
  recover(liveSessionId: string, lastSeen?: number): Promise<HermesRecovery>
  submit(
    liveSessionId: string,
    prompt: {
      scope: HermesRunScope
      text: string
      runId: string
      rewindSourceId?: string
    }
  ): Promise<{
    acknowledgement: "accepted" | "rejected" | "uncertain"
    rejection?: "command-with-attachments"
    completion?: { output: string; composerPrefill?: string }
  }>
  redirect(
    liveSessionId: string,
    text: string
  ): Promise<"redirected" | "queued">
  interrupt(liveSessionId: string): Promise<void>
  status(liveSessionId: string): Promise<"running" | "waiting" | "idle">
  inspectExecution?(scope: HermesRunScope & { runId: string }): Promise<{
    status: "waiting-for-input" | "running" | "idle" | "unknown"
    outcome?: RunFinishedInterruptOutcome
  }>
  acceptInteraction?(
    scope: HermesRunScope & { runId: string },
    liveSessionId: string,
    event: unknown
  ): RunFinishedInterruptOutcome | { status: string } | undefined
  respondInteractions?(
    scope: HermesRunScope & { runId: string },
    resume: readonly ResumeEntry[]
  ): Promise<readonly { status: string }[]>
  clearPendingInteraction?(scope: HermesRunScope): void
}

export type HermesRunHandle = ServerRunHandle

export type HermesReconnectRequest = RecoveryRequest

type QueueWaiter = {
  resolve(result: IteratorResult<AGUIEvent>): void
}

function utf8CodePointBytes(codePoint: number) {
  return codePoint <= 0x7f
    ? 1
    : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
        ? 3
        : 4
}

function utf8BytesWithin(value: string, maximum: number) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes += utf8CodePointBytes(codePoint)
    if (bytes > maximum) return undefined
  }
  return bytes
}

function jsonStringBytesWithin(value: string, maximum: number) {
  let bytes = 2
  if (bytes > maximum) return undefined
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes +=
      character === '"' || character === "\\"
        ? 2
        : codePoint < 0x20
          ? character === "\b" ||
            character === "\f" ||
            character === "\n" ||
            character === "\r" ||
            character === "\t"
            ? 2
            : 6
          : codePoint >= 0xd800 && codePoint <= 0xdfff
            ? 6
            : utf8CodePointBytes(codePoint)
    if (bytes > maximum) return undefined
  }
  return bytes
}

function boundedGraphBytes(value: unknown, maximum: number) {
  const seen = new WeakSet<object>()
  let bytes = 0
  let entries = 0

  const addBytes = (amount: number) => {
    bytes += amount
    return bytes <= maximum
  }
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > MAX_GRAPH_DEPTH || entries > MAX_GRAPH_ENTRIES) return false
    if (typeof current === "string") {
      const size = jsonStringBytesWithin(current, maximum - bytes)
      return size !== undefined && addBytes(size)
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number"
    )
      return addBytes(32)
    if (typeof current !== "object") return false
    if (seen.has(current)) return false
    seen.add(current)
    if (!addBytes(2)) return false

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        entries += 1
        if (entries > MAX_GRAPH_ENTRIES || !addBytes(1)) return false
        let item: unknown
        try {
          item = current[index]
        } catch {
          return false
        }
        if (!visit(item, depth + 1)) return false
      }
      return true
    }

    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue
      entries += 1
      if (entries > MAX_GRAPH_ENTRIES) return false
      const keyBytes = jsonStringBytesWithin(key, maximum - bytes)
      if (keyBytes === undefined || !addBytes(keyBytes + 2)) return false
      let item: unknown
      try {
        item = (current as Record<string, unknown>)[key]
      } catch {
        return false
      }
      if (!visit(item, depth + 1)) return false
    }
    return true
  }

  return visit(value, 0) ? bytes : undefined
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
  reasoningStarted: boolean
  reasoningEnded: boolean
  streamedReasoning: string
  tools: Map<string, { name: string; ended: boolean; messageId: string }>
  redirectChainActive: boolean
  redirectDispatchPending: boolean
  redirectBoundaryObserved: boolean
  redirectIdleObserved: boolean
  stopping: boolean
  uncertain: boolean
  detached: boolean
  terminal: boolean
  overflowed: boolean
  usage?: TokenUsage[]
  settled: Promise<void>
  resolveSettled(): void
}

type BufferedNativeEvents = {
  events: unknown[]
  bytes: number
  overflow: boolean
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

function safelyUnsubscribe(unsubscribe: (() => void) | undefined) {
  try {
    unsubscribe?.()
  } catch {
    // Native cleanup errors are intentionally not exposed across the proxy.
  }
}

function runSettlement() {
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  return { settled, resolveSettled }
}

function scopeKey(scope: HermesRunScope) {
  return `${scope.agentId}\u0000${scope.sessionId}`
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

function validatedRecovery(
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
  return {
    events,
    initialLastSeen:
      after ??
      (events[0]?.seq !== undefined ? events[0].seq - 1 : recovery.lastSeen),
  }
}

function payloadOf(event: HermesNativeEvent) {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {}
}

function stableNativeId(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return undefined
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return undefined
  }
  return value
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

function isEmptyAuthority(value: unknown) {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value !== "object") return false
  return Object.keys(value).length === 0
}

export class HermesRunEngine {
  readonly #native: HermesRunNative
  readonly #active = new Map<string, ActiveRun>()
  readonly #admissions = new Set<string>()
  readonly #plans = new Map<
    string,
    { messageId: string; todos: HermesTodo[] }
  >()

  constructor(native: HermesRunNative) {
    this.#native = native
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
        ? input.messages.length !== 0 || !this.#native.respondInteractions
        : input.messages.length !== 1 || !text
    )
      throw new Error(
        interactionResume
          ? "AOS interrupt responses require one bound native interaction"
          : "AOS runs require exactly one authorized user turn"
      )
    if (text && new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES)
      throw new Error("The AOS user turn is too large")

    const key = scopeKey(scope)
    if (this.#active.has(key) || this.#admissions.has(key))
      throw new ServerRunConflictError()
    this.#admissions.add(key)

    const queue = new EventQueue()
    queue.push({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    })
    const buffered: BufferedNativeEvents = {
      events: [],
      bytes: 0,
      overflow: false,
    }
    let accepting = false
    let connectionInterrupted = false
    let unsubscribe: (() => void) | undefined
    let active: ActiveRun | undefined
    let baseline: HermesRecovery
    let liveSessionId: string
    try {
      ;({ liveSessionId } = await this.#native.resume(scope))
      unsubscribe = await this.#native.observe(
        liveSessionId,
        (event) => {
          if (nativeEventSessionId(event) !== liveSessionId) return
          if (!accepting) bufferNativeEvent(buffered, event)
          else if (active) this.#accept(active, event)
        },
        () => {
          connectionInterrupted = true
          if (active) this.#markInterrupted(active)
        }
      )
      baseline = await this.#native.recover(liveSessionId)
      active = {
        scope,
        runId: input.runId,
        liveSessionId,
        queue,
        unsubscribe,
        epoch: baseline.epoch,
        lastSeen: 0,
        generation: 0,
        sealedMessageIds: new Set(),
        textStarted: false,
        streamedText: "",
        reasoningStarted: false,
        reasoningEnded: false,
        streamedReasoning: "",
        tools: new Map(),
        redirectChainActive: false,
        redirectDispatchPending: false,
        redirectBoundaryObserved: false,
        redirectIdleObserved: false,
        stopping: false,
        uncertain: false,
        detached: false,
        terminal: false,
        overflowed: false,
        ...runSettlement(),
      }
      this.#active.set(key, active)
    } catch {
      safelyUnsubscribe(unsubscribe)
      queue.close()
      throw providerUnavailable()
    } finally {
      this.#admissions.delete(key)
    }
    const replay = validatedRecovery(baseline, liveSessionId)
    if (baseline.truncated === true || !replay || buffered.overflow) {
      drainBufferedEvents(buffered)
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "Hermes history must be reconciled before this run can continue."
      )
      return this.#handle(active)
    }
    if (connectionInterrupted) {
      drainBufferedEvents(buffered)
      this.#markInterrupted(active)
      return this.#handle(active)
    }
    // A new AOS run starts after Hermes' current replay cursor. Replaying the
    // previous completed turn here would terminally settle this new run before
    // its prompt is submitted. Live events that raced the baseline read remain
    // buffered and are accepted below only when their sequence is newer.
    active.lastSeen = baseline.lastSeen
    accepting = true
    for (const event of drainBufferedEvents(buffered))
      this.#accept(active, event)
    if (active.terminal) return this.#handle(active)
    if (interactionResume) {
      let results: readonly { status: string }[]
      try {
        results = await this.#native.respondInteractions!(
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
        this.#markUncertainInteraction(active)
      } else if (results.some(({ status }) => status === "expired")) {
        this.#fail(
          active,
          "AOS_INTERACTION_EXPIRED",
          "This Hermes interaction is no longer pending."
        )
      }
      return this.#handle(active)
    }
    let status: "running" | "waiting" | "idle"
    try {
      status = await this.#native.status(liveSessionId)
    } catch {
      if (!this.#isSubmitEligible(active)) return this.#handle(active)
      this.#settle(active)
      throw providerUnavailable()
    }
    if (!this.#isSubmitEligible(active)) return this.#handle(active)
    if (status !== "idle") {
      this.#fail(
        active,
        "AOS_SESSION_BUSY",
        "Hermes is already running this Session."
      )
      return this.#handle(active)
    }
    if (!this.#isSubmitEligible(active)) return this.#handle(active)
    let acknowledgement: "accepted" | "rejected" | "uncertain"
    let rejection: "command-with-attachments" | undefined
    try {
      const result = await this.#native.submit(liveSessionId, {
        scope,
        text: text!,
        runId: input.runId,
        ...(rewindSourceId === undefined
          ? {}
          : { rewindSourceId: rewindSourceId as string }),
      })
      acknowledgement = result.acknowledgement
      rejection = result.rejection
      if (result.completion && !active.terminal) {
        if (result.completion.output) {
          active.messageId = `aos-command:${input.runId}`
          this.#startText(active)
          this.#emit(active, {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: active.messageId,
            delta: result.completion.output,
          })
        }
        this.#finish(
          active,
          result.completion.composerPrefill === undefined
            ? undefined
            : {
                "aos.composerPrefill": result.completion.composerPrefill,
              }
        )
      }
    } catch (error) {
      if (error instanceof HermesRunRewindConflictError) {
        this.#fail(
          active,
          "AOS_REWIND_CONFLICT",
          "This response can no longer be regenerated because Hermes history changed."
        )
        return this.#handle(active)
      }
      acknowledgement = "uncertain"
    }
    if (acknowledgement === "rejected" && !active.terminal) {
      this.#fail(
        active,
        rejection === "command-with-attachments"
          ? "AOS_COMMAND_WITH_ATTACHMENTS"
          : "AOS_PROVIDER_RUN_FAILED",
        rejection === "command-with-attachments"
          ? "Slash commands cannot be sent with attachments."
          : "Hermes rejected this command."
      )
    }
    if (
      acknowledgement === "uncertain" &&
      !active.terminal &&
      !active.messageId
    )
      this.#markUncertain(active)

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
    const key = scopeKey(scope)
    const existing = this.#active.get(key)
    if (existing) {
      if (
        existing.runId !== request.runId ||
        (!existing.uncertain && !existing.detached)
      )
        throw new ServerRunConflictError()
      return this.#reattach(existing, {
        ...request,
        position: request.position ?? {
          epoch: existing.epoch,
          lastSeen: existing.lastSeen,
        },
      })
    }
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#admissions.add(key)

    const queue = new EventQueue()
    queue.push({
      type: EventType.RUN_STARTED,
      threadId: request.threadId,
      runId: request.runId,
    })
    const buffered: BufferedNativeEvents = {
      events: [],
      bytes: 0,
      overflow: false,
    }
    let accepting = false
    let connectionInterrupted = false
    let unsubscribe: (() => void) | undefined
    let active: ActiveRun | undefined
    let recovery: HermesRecovery
    let liveSessionId: string
    try {
      ;({ liveSessionId } = await this.#native.resume(scope))
      unsubscribe = await this.#native.observe(
        liveSessionId,
        (event) => {
          if (nativeEventSessionId(event) !== liveSessionId) return
          if (!accepting) bufferNativeEvent(buffered, event)
          else if (active) this.#accept(active, event)
        },
        () => {
          connectionInterrupted = true
          if (active) this.#markInterrupted(active)
        }
      )
      recovery = await this.#native.recover(
        liveSessionId,
        request.position?.lastSeen
      )
      active = {
        scope,
        runId: request.runId,
        liveSessionId,
        queue,
        unsubscribe,
        epoch: recovery.epoch,
        lastSeen: request.position?.lastSeen ?? 0,
        generation: 0,
        sealedMessageIds: new Set(),
        textStarted: false,
        streamedText: "",
        reasoningStarted: false,
        reasoningEnded: false,
        streamedReasoning: "",
        tools: new Map(),
        redirectChainActive: false,
        redirectDispatchPending: false,
        redirectBoundaryObserved: false,
        redirectIdleObserved: false,
        stopping: false,
        uncertain: false,
        detached: false,
        terminal: false,
        overflowed: false,
        ...runSettlement(),
      }
      this.#active.set(key, active)
    } catch {
      safelyUnsubscribe(unsubscribe)
      queue.close()
      throw providerUnavailable()
    } finally {
      this.#admissions.delete(key)
    }
    const replay = validatedRecovery(
      recovery,
      liveSessionId,
      request.position?.lastSeen
    )
    if (
      recovery.truncated === true ||
      !replay ||
      buffered.overflow ||
      (request.position !== undefined &&
        recovery.epoch !== request.position.epoch)
    ) {
      drainBufferedEvents(buffered)
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "Hermes history must be reconciled before this run can continue."
      )
      return this.#handle(active)
    }
    if (connectionInterrupted) {
      drainBufferedEvents(buffered)
      this.#markInterrupted(active)
      return this.#handle(active)
    }
    for (const event of replay.events) this.#accept(active, event)
    active.lastSeen = Math.max(active.lastSeen, recovery.lastSeen)
    accepting = true
    for (const event of drainBufferedEvents(buffered))
      this.#accept(active, event)
    return this.#handle(active)
  }

  async discover(scope: HermesRunScope, runId: string) {
    if (!this.#native.inspectExecution) return undefined
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

  async #reattach(
    active: ActiveRun,
    request: HermesReconnectRequest & {
      position: { epoch: string; lastSeen: number }
    }
  ): Promise<HermesRunHandle> {
    const queue = new EventQueue()
    queue.push({
      type: EventType.RUN_STARTED,
      threadId: request.threadId,
      runId: request.runId,
    })
    safelyUnsubscribe(active.unsubscribe)
    active.queue = queue
    active.uncertain = false
    active.detached = false
    active.overflowed = false
    active.lastSeen = request.position.lastSeen
    const buffered: BufferedNativeEvents = {
      events: [],
      bytes: 0,
      overflow: false,
    }
    let accepting = false
    let connectionInterrupted = false
    let nextUnsubscribe: (() => void) | undefined
    let recovery: HermesRecovery
    try {
      const { liveSessionId } = await this.#native.resume(active.scope)
      active.liveSessionId = liveSessionId
      nextUnsubscribe = await this.#native.observe(
        liveSessionId,
        (event) => {
          if (nativeEventSessionId(event) !== liveSessionId) return
          if (!accepting) bufferNativeEvent(buffered, event)
          else this.#accept(active, event)
        },
        () => {
          connectionInterrupted = true
          this.#markInterrupted(active)
        }
      )
      recovery = await this.#native.recover(
        liveSessionId,
        request.position.lastSeen
      )
      active.unsubscribe = nextUnsubscribe
    } catch {
      safelyUnsubscribe(nextUnsubscribe)
      active.uncertain = true
      active.detached = true
      queue.close()
      throw providerUnavailable()
    }
    active.epoch = recovery.epoch
    const replay = validatedRecovery(
      recovery,
      active.liveSessionId,
      request.position.lastSeen
    )
    if (
      recovery.truncated === true ||
      !replay ||
      buffered.overflow ||
      recovery.epoch !== request.position.epoch
    ) {
      drainBufferedEvents(buffered)
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "Hermes history must be reconciled before this run can continue."
      )
      return this.#handle(active)
    }
    if (connectionInterrupted) {
      drainBufferedEvents(buffered)
      this.#markInterrupted(active)
      return this.#handle(active)
    }
    for (const event of replay.events) this.#accept(active, event)
    active.lastSeen = Math.max(active.lastSeen, recovery.lastSeen)
    accepting = true
    for (const event of drainBufferedEvents(buffered))
      this.#accept(active, event)
    return this.#handle(active)
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

  #accept(active: ActiveRun, value: unknown) {
    if (active.terminal) return
    if (nativeEventSessionId(value) !== active.liveSessionId) return
    if (boundedGraphBytes(value, MAX_NATIVE_EVENT_BYTES) === undefined) {
      this.#overflow(active)
      return
    }
    const event = nativeEvent(value)
    if (!event || event.session_id !== active.liveSessionId) return
    if (event.seq !== undefined) {
      if (event.seq <= active.lastSeen) return
      active.lastSeen = event.seq
    }
    const payload = payloadOf(event)
    if (this.#native.acceptInteraction) {
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
    }
    if (active.overflowed) {
      if (
        event.type === "message.complete" ||
        event.type === "error" ||
        (event.type === "session.info" && payload.running === false)
      )
        this.#settle(active)
      return
    }
    if (event.type === "session.info" || event.type === "session.usage") {
      const usage = tokenUsage(payload.usage)
      if (usage) active.usage = usage
    }
    if (event.type === "message.start") {
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
      const messageId = this.#ensureMessageId(active)
      this.#endReasoning(active)
      this.#startText(active)
      if (
        this.#emit(active, {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: textDelta,
        })
      )
        this.#appendStreamedText(active, textDelta)
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
      const artifact =
        tool.name === "present_artifact"
          ? projectHermesArtifactReceipt(payload.result)
          : undefined
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
          : questionResult
            ? JSON.stringify(questionResult)
            : resultContent(
                tool.name,
                payload.result,
                payload.is_error === true
              ),
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
      return
    }
    if (event.type === "session.info" && payload.running === false) {
      if (active.redirectDispatchPending) {
        active.redirectIdleObserved = true
        return
      }
      if (!active.stopping && !active.uncertain && !active.redirectChainActive)
        return
      if (active.stopping) this.#finish(active, { stopped: true })
      else if (active.redirectChainActive) this.#finish(active)
      else this.#settle(active)
      return
    }
    if (event.type === "error") {
      this.#fail(
        active,
        "AOS_PROVIDER_RUN_FAILED",
        "Hermes could not complete this run."
      )
      return
    }
    if (event.type === "message.complete") {
      const usage = tokenUsage(payload.usage)
      if (usage) active.usage = usage
      const completedMessageId = stableNativeId(
        payload.message_id ?? payload.id
      )
      if (
        (active.redirectChainActive || active.redirectDispatchPending) &&
        completedMessageId &&
        active.sealedMessageIds.has(completedMessageId)
      ) {
        if (active.redirectDispatchPending)
          active.redirectBoundaryObserved = true
        return
      }
      if (payload.status === "error")
        this.#fail(
          active,
          "AOS_PROVIDER_RUN_FAILED",
          "Hermes could not complete this run."
        )
      else {
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
            this.#endReasoning(active)
            this.#startText(active)
            if (
              this.#emit(active, {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: active.messageId,
                delta: remaining,
              })
            )
              this.#appendStreamedText(active, remaining)
          }
        }
        if (active.redirectChainActive || active.redirectDispatchPending) {
          this.#sealGeneration(active)
          if (active.redirectDispatchPending)
            active.redirectBoundaryObserved = true
        } else this.#finish(active)
      }
    }
  }

  #appendStreamedText(active: ActiveRun, delta: string) {
    if (active.streamedText === undefined) return
    active.streamedText = boundedText(active.streamedText + delta)
  }

  #emitPlan(active: ActiveRun, todos: HermesTodo[]) {
    const key = scopeKey(active.scope)
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
    active.stopping = true
    try {
      await this.#native.interrupt(active.liveSessionId)
      if ((await this.#native.status(active.liveSessionId)) === "idle") {
        this.#finish(active, { stopped: true })
        return "idle"
      }
      return "stopping"
    } catch {
      active.uncertain = true
      throw stopUncertain()
    }
  }

  async #steer(active: ActiveRun, text: string) {
    if (
      active.terminal ||
      active.stopping ||
      active.uncertain ||
      active.redirectDispatchPending
    )
      throw new ServerRunConflictError()
    const generation = active.generation
    const previousRedirectChain = active.redirectChainActive
    active.redirectDispatchPending = true
    active.redirectBoundaryObserved = false
    active.redirectIdleObserved = false
    try {
      const status = await this.#native.redirect(active.liveSessionId, text)
      active.redirectDispatchPending = false
      active.redirectChainActive = true
      if (active.generation === generation) this.#sealGeneration(active)
      if (active.redirectIdleObserved)
        this.#finishAfterSteeringAcknowledgement(active)
      return status === "redirected"
        ? ("steered" as const)
        : ("queued" as const)
    } catch (error) {
      active.redirectDispatchPending = false
      if (error instanceof ServerRunSteerUncertainError) {
        active.redirectChainActive = true
        if (active.generation === generation) this.#sealGeneration(active)
        if (active.redirectIdleObserved)
          this.#finishAfterSteeringAcknowledgement(active)
      } else {
        active.redirectChainActive = previousRedirectChain
        if (
          active.redirectIdleObserved ||
          (!previousRedirectChain && active.redirectBoundaryObserved)
        )
          this.#finish(active)
      }
      throw error
    }
  }

  #finishAfterSteeringAcknowledgement(active: ActiveRun) {
    setTimeout(() => {
      if (!active.terminal && active.redirectChainActive) this.#finish(active)
    }, 0)
  }

  #sealGeneration(active: ActiveRun) {
    this.#endReasoning(active)
    if (active.textStarted && active.messageId)
      this.#emit(active, {
        type: EventType.TEXT_MESSAGE_END,
        messageId: active.messageId,
      })
    if (active.messageId) active.sealedMessageIds.add(active.messageId)
    active.messageId = undefined
    active.generation += 1
    active.textStarted = false
    active.streamedText = ""
    active.reasoningStarted = false
    active.reasoningEnded = false
    active.streamedReasoning = ""
  }

  #finish(active: ActiveRun, result?: unknown) {
    if (active.terminal) return
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
    if (active.textStarted && active.messageId)
      this.#emit(active, {
        type: EventType.TEXT_MESSAGE_END,
        messageId: active.messageId,
      })
    this.#emit(active, {
      type: EventType.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      ...(result === undefined ? {} : { result }),
      ...(active.usage ? { usage: active.usage } : {}),
      outcome: { type: "success" },
    })
    this.#native.clearPendingInteraction?.(active.scope)
    this.#settle(active)
  }

  #finishInterrupt(active: ActiveRun, outcome: RunFinishedInterruptOutcome) {
    if (active.terminal) return
    this.#endReasoning(active)
    this.#settleOpenTools(active)
    if (active.textStarted && active.messageId)
      this.#emit(active, {
        type: EventType.TEXT_MESSAGE_END,
        messageId: active.messageId,
      })
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
    if (active.textStarted && active.messageId)
      this.#emit(active, {
        type: EventType.TEXT_MESSAGE_END,
        messageId: active.messageId,
      })
    this.#emit(active, { type: EventType.RUN_ERROR, message, code })
    this.#native.clearPendingInteraction?.(active.scope)
    this.#settle(active)
  }

  #markUncertain(active: ActiveRun) {
    active.uncertain = true
    this.#emit(active, {
      type: EventType.RUN_ERROR,
      message:
        "Hermes may have accepted this turn; reconcile before sending again.",
      code: "AOS_SEND_UNCERTAIN",
    })
    active.queue.close()
  }

  #markUncertainInteraction(active: ActiveRun) {
    active.uncertain = true
    this.#emit(active, {
      type: EventType.RUN_ERROR,
      message:
        "Hermes may have applied this interaction response; reconcile before responding again.",
      code: "AOS_INTERACTION_UNCERTAIN",
    })
    active.queue.close()
  }

  #markInterrupted(active: ActiveRun) {
    if (active.terminal || active.uncertain) return
    active.uncertain = true
    this.#emit(active, {
      type: EventType.RUN_ERROR,
      message:
        "The Hermes connection was interrupted; reconnect to reconcile this run.",
      code: "AOS_CONNECTION_INTERRUPTED",
    })
    active.queue.close()
  }

  #emit(active: ActiveRun, event: AGUIEvent) {
    if (active.terminal || active.overflowed) return false
    if (active.detached) return true
    if (active.queue.push(event)) return true
    this.#overflow(active)
    return false
  }

  #overflow(active: ActiveRun) {
    if (active.terminal || active.overflowed) return
    active.queue.terminal({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
    active.uncertain = true
    active.detached = true
    active.overflowed = true
    safelyUnsubscribe(active.unsubscribe)
  }

  #isSubmitEligible(active: ActiveRun) {
    return (
      this.#active.get(scopeKey(active.scope)) === active &&
      !active.terminal &&
      !active.uncertain &&
      !active.detached &&
      !active.overflowed &&
      !active.stopping
    )
  }

  #settle(active: ActiveRun) {
    if (active.terminal) return
    active.terminal = true
    safelyUnsubscribe(active.unsubscribe)
    active.queue.close()
    active.resolveSettled()
    const key = scopeKey(active.scope)
    if (this.#active.get(key) === active) this.#active.delete(key)
  }
}
