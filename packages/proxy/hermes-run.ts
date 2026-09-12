import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type RunAgentInput,
  type TokenUsage,
} from "@ag-ui/core"

const MAX_NATIVE_TEXT_DELTA_BYTES = 1_048_576
const MAX_USER_TURN_BYTES = 1_048_576
const MAX_RECOVERY_EVENTS = 4_096
const MAX_QUEUED_EVENTS = 4_096
const MAX_PREACTIVE_EVENTS = 4_096
const MAX_PREACTIVE_BYTES = 4_194_304
const MAX_TOOL_DEPTH = 6
const MAX_TOOL_ENTRIES = 64
const MAX_TOOL_STRING_BYTES = 16_384
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
])

export type HermesRunScope = {
  agentId: string
  sessionId: string
  threadId: string
}

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
    prompt: { text: string; runId: string }
  ): Promise<{ acknowledgement: "accepted" | "uncertain" }>
  interrupt(liveSessionId: string): Promise<void>
  status(liveSessionId: string): Promise<"running" | "waiting" | "idle">
}

export type HermesRunHandle = {
  events: AsyncIterable<AGUIEvent>
  stop(): Promise<"stopping" | "idle">
  disconnect(): void
  recoveryPosition(): { epoch: string; lastSeen: number }
}

export type HermesReconnectRequest = {
  threadId: string
  runId: string
  position: { epoch: string; lastSeen: number }
}

type QueueWaiter = {
  resolve(result: IteratorResult<AGUIEvent>): void
}

class EventQueue implements AsyncIterable<AGUIEvent> {
  readonly #values: AGUIEvent[] = []
  readonly #waiters: QueueWaiter[] = []
  #closed = false

  push(value: AGUIEvent) {
    if (this.#closed) return false
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else {
      if (this.#values.length >= MAX_QUEUED_EVENTS) return false
      this.#values.push(value)
    }
    return true
  }

  terminal(value: AGUIEvent) {
    if (this.#closed) return
    const started =
      this.#values[0]?.type === EventType.RUN_STARTED
        ? this.#values[0]
        : undefined
    this.#values.splice(0, this.#values.length)
    if (started) this.#values.push(started)
    this.#values.push(value)
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
        if (value) return Promise.resolve({ done: false, value })
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
  textStarted: boolean
  reasoningStarted: boolean
  reasoningEnded: boolean
  tools: Map<string, { name: string; ended: boolean }>
  stopping: boolean
  uncertain: boolean
  detached: boolean
  terminal: boolean
  overflowed: boolean
  usage?: TokenUsage[]
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
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    buffer.overflow = true
    return
  }
  if (
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
  for (const raw of recovery.events) {
    const event = nativeEvent(raw)
    if (
      !event ||
      event.session_id !== liveSessionId ||
      event.seq === undefined ||
      (previous !== undefined && event.seq <= previous) ||
      event.seq > recovery.lastSeen
    )
      return undefined
    events.push(event)
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
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
    ? value
    : undefined
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
  if (
    name === "delegate_task" &&
    typeof args.description !== "string" &&
    typeof args.goal === "string" &&
    args.goal.trim()
  )
    return { ...args, description: args.goal.trim() }
  return args
}

function normalizedTool(name: string, value: unknown) {
  const args = toolArgs(name, value)
  if (
    name !== "tool_call" ||
    typeof args.name !== "string" ||
    typeof args.arguments !== "string"
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

const TOOL_ARG_FIELDS = new Map<string, ReadonlySet<string>>([
  ["delegate_subagent", new Set(["description", "goal", "task", "name"])],
  [
    "question",
    new Set([
      "question",
      "questions",
      "options",
      "choices",
      "multiple",
      "allowFreeform",
    ]),
  ],
  ["todo", new Set(["todos", "items", "id", "content", "status"])],
  ["search", new Set(["query", "pattern", "path", "offset", "limit"])],
  ["read_file", new Set(["path", "offset", "limit", "line", "start", "end"])],
])
const DEFAULT_TOOL_ARG_FIELDS = new Set([
  "command",
  "content",
  "description",
  "end",
  "filename",
  "id",
  "language",
  "limit",
  "line",
  "message",
  "name",
  "offset",
  "pattern",
  "query",
  "start",
  "status",
  "summary",
  "text",
  "title",
])
const TOOL_RESULT_FIELDS = new Map<string, ReadonlySet<string>>([
  [
    "search",
    new Set(["ok", "status", "summary", "matches", "results", "count"]),
  ],
  [
    "read_file",
    new Set([
      "ok",
      "status",
      "summary",
      "content",
      "text",
      "filename",
      "line",
      "start",
      "end",
      "language",
    ]),
  ],
  [
    "delegate_subagent",
    new Set(["ok", "status", "summary", "message", "result", "output"]),
  ],
  ["question", new Set(["ok", "status", "answer", "answers", "response"])],
  ["todo", new Set(["ok", "status", "todos", "items", "summary"])],
])
const DEFAULT_TOOL_RESULT_FIELDS = new Set([
  "answer",
  "answers",
  "content",
  "count",
  "end",
  "exitCode",
  "filename",
  "items",
  "language",
  "line",
  "matches",
  "message",
  "name",
  "ok",
  "output",
  "response",
  "result",
  "results",
  "start",
  "status",
  "stderr",
  "stdout",
  "summary",
  "text",
  "title",
  "todos",
  "value",
])

function sensitiveToolKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase()
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("cookie") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized.includes("sessionid") ||
    normalized.includes("liveid") ||
    normalized.includes("metadata") ||
    normalized.includes("url") ||
    normalized.includes("uri") ||
    normalized === "origin" ||
    normalized === "host" ||
    normalized === "cwd" ||
    normalized.includes("directory") ||
    normalized.includes("filesystem") ||
    normalized.endsWith("path")
  )
}

function safeToolText(value: string) {
  const redacted = value
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .replace(/file:\/\/[^\s]+/giu, "[redacted-path]")
    .replace(/\b[a-z]:\\[^\s]+/giu, "[redacted-path]")
    .replace(
      /(^|\s)\/(?:[^\s/]+\/)*[^\s]*/gu,
      (_match, prefix: string) => `${prefix}[redacted-path]`
    )
    .replace(
      /\b(?:bearer|token|api[_-]?key)\s*(?::|=|\s)\s*[^\s,;]+/giu,
      "[redacted-secret]"
    )
  const encoder = new TextEncoder()
  if (encoder.encode(redacted).byteLength <= MAX_TOOL_STRING_BYTES)
    return redacted
  let bytes = 0
  let truncated = ""
  for (const character of redacted) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > MAX_TOOL_STRING_BYTES - 3) break
    bytes += size
    truncated += character
  }
  return `${truncated}…`
}

function filenameOf(value: string) {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)
}

function safeToolValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_TOOL_DEPTH) return "[truncated]"
  if (typeof value === "string") return safeToolText(value)
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null) return value
  if (Array.isArray(value))
    return value
      .slice(0, MAX_TOOL_ENTRIES)
      .map((item) => safeToolValue(item, depth + 1))
  if (typeof value !== "object") return undefined
  const projected: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_TOOL_ENTRIES)) {
    if (sensitiveToolKey(key)) continue
    const safe = safeToolValue(item, depth + 1)
    if (safe !== undefined) projected[key] = safe
  }
  return projected
}

function safeToolArgs(name: string, value: Record<string, unknown>) {
  const allowed = TOOL_ARG_FIELDS.get(name) ?? DEFAULT_TOOL_ARG_FIELDS
  const projected: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue
    if (key === "path" && typeof item === "string") {
      const filename = filenameOf(item)
      if (filename) projected.filename = safeToolText(filename)
      continue
    }
    if (sensitiveToolKey(key)) continue
    const safe = safeToolValue(item)
    if (safe !== undefined) projected[key] = safe
  }
  const serialized = JSON.stringify(projected)
  return new TextEncoder().encode(serialized).byteLength <=
    MAX_TOOL_PAYLOAD_BYTES
    ? serialized
    : '{"truncated":true}'
}

function resultContent(name: string, value: unknown) {
  const projected =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) =>
              (TOOL_RESULT_FIELDS.get(name) ?? DEFAULT_TOOL_RESULT_FIELDS).has(
                key
              )
            )
            .slice(0, MAX_TOOL_ENTRIES)
            .flatMap(([key, item]) => {
              if (sensitiveToolKey(key)) return []
              const safe = safeToolValue(item, 1)
              return safe === undefined ? [] : [[key, safe]]
            })
        )
      : safeToolValue(value)
  const serialized =
    typeof projected === "string"
      ? projected
      : JSON.stringify(projected ?? null)
  return new TextEncoder().encode(serialized).byteLength <=
    MAX_TOOL_PAYLOAD_BYTES
    ? serialized
    : '{"truncated":true}'
}

function boundedText(value: unknown) {
  return typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= MAX_NATIVE_TEXT_DELTA_BYTES
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
    if (input.resume && input.resume.length > 0)
      throw new Error("AOS new turns cannot contain a bound interrupt response")
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
    if (
      input.threadId !== scope.threadId ||
      input.messages.length !== 1 ||
      !text
    )
      throw new Error("AOS runs require exactly one authorized user turn")
    if (new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES)
      throw new Error("The AOS user turn is too large")

    const key = scopeKey(scope)
    if (this.#active.has(key) || this.#admissions.has(key))
      throw new Error("An AOS run is already active for this Session")
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
        textStarted: false,
        reasoningStarted: false,
        reasoningEnded: false,
        tools: new Map(),
        stopping: false,
        uncertain: false,
        detached: false,
        terminal: false,
        overflowed: false,
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
    active.lastSeen = replay.initialLastSeen
    for (const event of replay.events) this.#accept(active, event)
    active.lastSeen = Math.max(active.lastSeen, baseline.lastSeen)
    accepting = true
    for (const event of drainBufferedEvents(buffered))
      this.#accept(active, event)
    if (active.terminal) return this.#handle(active)
    let status: "running" | "waiting" | "idle"
    try {
      status = await this.#native.status(liveSessionId)
    } catch {
      this.#settle(active)
      throw providerUnavailable()
    }
    if (status !== "idle") {
      this.#fail(
        active,
        "AOS_SESSION_BUSY",
        "Hermes is already running this Session."
      )
      return this.#handle(active)
    }
    let acknowledgement: "accepted" | "uncertain"
    try {
      ;({ acknowledgement } = await this.#native.submit(liveSessionId, {
        text,
        runId: input.runId,
      }))
    } catch {
      acknowledgement = "uncertain"
    }
    if (
      acknowledgement === "uncertain" &&
      !active.terminal &&
      !active.textStarted
    )
      this.#markUncertain(active)

    return this.#handle(active)
  }

  async reconnect(
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
        throw new Error("An AOS run is already active for this Session")
      return this.#reattach(existing, request)
    }
    if (this.#admissions.has(key))
      throw new Error("An AOS run is already active for this Session")
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
        request.position.lastSeen
      )
      active = {
        scope,
        runId: request.runId,
        liveSessionId,
        queue,
        unsubscribe,
        epoch: recovery.epoch,
        lastSeen: request.position.lastSeen,
        textStarted: false,
        reasoningStarted: false,
        reasoningEnded: false,
        tools: new Map(),
        stopping: false,
        uncertain: false,
        detached: false,
        terminal: false,
        overflowed: false,
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

  async #reattach(
    active: ActiveRun,
    request: HermesReconnectRequest
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
      stop: () => this.#stop(active),
      disconnect: () => {
        if (active.terminal) return
        active.detached = true
        active.queue.close()
      },
      recoveryPosition: () => ({
        epoch: active.epoch,
        lastSeen: active.lastSeen,
      }),
    }
  }

  #accept(active: ActiveRun, value: unknown) {
    if (active.terminal) return
    const event = nativeEvent(value)
    if (!event || event.session_id !== active.liveSessionId) return
    if (event.seq !== undefined) {
      if (event.seq <= active.lastSeen) return
      active.lastSeen = event.seq
    }
    const payload = payloadOf(event)
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
      if (!active.textStarted) {
        active.messageId =
          stableNativeId(payload.message_id ?? payload.id) ??
          `${active.runId}:assistant`
        active.textStarted = true
        this.#emit(active, {
          type: EventType.TEXT_MESSAGE_START,
          messageId: active.messageId,
          role: "assistant",
        })
      }
      return
    }
    const textDelta = boundedText(payload.text)
    if (event.type === "message.delta" && textDelta !== undefined) {
      if (!active.textStarted || !active.messageId) return
      this.#endReasoning(active)
      this.#emit(active, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: active.messageId,
        delta: textDelta,
      })
      return
    }
    if (
      (event.type === "thinking.delta" || event.type === "reasoning.delta") &&
      textDelta !== undefined &&
      active.messageId
    ) {
      const reasoningId = `${active.messageId}:reasoning`
      if (!active.reasoningStarted) {
        active.reasoningStarted = true
        this.#emit(active, {
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningId,
          role: "reasoning",
        })
      }
      this.#emit(active, {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta: textDelta,
      })
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
      if (!toolCallId || !active.messageId) return
      this.#emit(active, { type: EventType.TOOL_CALL_END, toolCallId })
      this.#emit(active, {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${active.messageId}:tool:${toolCallId}`,
        toolCallId,
        content: resultContent(tool.name, payload.result),
        role: "tool",
      })
      return
    }
    if (
      event.type === "session.info" &&
      (active.stopping || active.uncertain) &&
      payload.running === false
    ) {
      if (active.stopping) this.#finish(active, { stopped: true })
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
      if (payload.status === "error")
        this.#fail(
          active,
          "AOS_PROVIDER_RUN_FAILED",
          "Hermes could not complete this run."
        )
      else this.#finish(active)
    }
  }

  #startTool(active: ActiveRun, payload: Record<string, unknown>) {
    const toolCallId = stableNativeId(payload.tool_id)
    if (!toolCallId || !active.messageId) return undefined
    const existing = active.tools.get(toolCallId)
    if (existing) return existing
    const nativeName = stableNativeId(payload.name)
    if (!nativeName) return undefined
    const normalized = normalizedTool(nativeName, payload.args)
    const tool = { name: canonicalToolName(normalized.name), ended: false }
    active.tools.set(toolCallId, tool)
    this.#emit(active, {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: tool.name,
      parentMessageId: active.messageId,
    })
    this.#emit(active, {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: safeToolArgs(tool.name, normalized.args),
    })
    return tool
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

  #finish(active: ActiveRun, result?: unknown) {
    if (active.terminal) return
    this.#endReasoning(active)
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
    if (active.queue.push(event)) return true
    active.queue.terminal({
      type: EventType.RUN_ERROR,
      message: "Hermes produced more events than AOS can safely buffer.",
      code: "AOS_STREAM_OVERFLOW",
    })
    active.uncertain = true
    active.detached = true
    active.overflowed = true
    safelyUnsubscribe(active.unsubscribe)
    return false
  }

  #settle(active: ActiveRun) {
    if (active.terminal) return
    active.terminal = true
    safelyUnsubscribe(active.unsubscribe)
    active.queue.close()
    this.#active.delete(scopeKey(active.scope))
  }
}
