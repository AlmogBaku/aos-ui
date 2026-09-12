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

const TOOL_ARG_FIELDS = new Map<string, ReadonlySet<string>>([
  ["delegate_subagent", new Set()],
  ["question", new Set(["multiple", "allowFreeform"])],
  ["todo", new Set(["status"])],
  ["search", new Set(["offset", "limit"])],
  ["read_file", new Set(["offset", "limit", "line", "start", "end"])],
])
const DEFAULT_TOOL_ARG_FIELDS = new Set([
  "end",
  "limit",
  "line",
  "multiple",
  "offset",
  "start",
  "status",
])
const DEFAULT_TOOL_RESULT_FIELDS = new Set([
  "count",
  "end",
  "exitCode",
  "language",
  "line",
  "ok",
  "start",
  "status",
])

const SAFE_CREDENTIAL_LIKE_KEYS = new Set([
  "accesskeyrotation",
  "authmode",
  "authorizationmode",
  "oauth",
  "oauthmode",
  "secretary",
  "tokencount",
  "tokenlimit",
  "tokenusage",
])
const CREDENTIAL_WRAPPERS = new Set([
  "b64",
  "base64",
  "ciphertext",
  "digest",
  "encoded",
  "encrypted",
  "file",
  "hash",
  "hashed",
  "path",
  "salt",
  "sha256",
  "value",
])

function credentialToolKey(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean)
  const normalized = words.join("")
  if (SAFE_CREDENTIAL_LIKE_KEYS.has(normalized)) return false
  while (words.length > 1 && CREDENTIAL_WRAPPERS.has(words.at(-1) ?? ""))
    words.pop()
  const core = words.join("")
  const credentialTerms = [
    "pwd",
    "pass",
    "passcode",
    "password",
    "passwd",
    "passphrase",
    "privatekey",
    "secret",
    "secretkey",
    "token",
    "apikey",
    "accesskey",
    "accesskeyid",
    "auth",
    "authorization",
    "cookie",
    "cookiejar",
    "credential",
    "credentials",
  ]
  const prefix = words.slice(0, 2).join("")
  const suffix = words.slice(-2).join("")
  return (
    core === "npmconfiguserconfig" ||
    credentialTerms.some(
      (term) =>
        core === term ||
        core.endsWith(term) ||
        words[0] === term ||
        prefix === term ||
        suffix === term
    )
  )
}

function sensitiveToolKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase()
  return (
    credentialToolKey(key) ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("liveid") ||
    normalized.endsWith("metadata") ||
    normalized.endsWith("url") ||
    normalized.endsWith("uri") ||
    normalized === "origin" ||
    normalized === "host" ||
    normalized === "cwd" ||
    normalized.endsWith("directory") ||
    normalized.endsWith("directories") ||
    normalized.includes("filesystem") ||
    normalized.endsWith("path")
  )
}

const SAFE_TOOL_STATUSES = new Set([
  "cancelled",
  "canceled",
  "complete",
  "completed",
  "done",
  "error",
  "failed",
  "ok",
  "pending",
  "running",
  "stopped",
  "success",
])

function safeToolMetadata(key: string, value: unknown) {
  if (key === "ok" || key === "multiple" || key === "allowFreeform")
    return typeof value === "boolean" ? value : undefined
  if (
    key === "count" ||
    key === "end" ||
    key === "exitCode" ||
    key === "limit" ||
    key === "line" ||
    key === "offset" ||
    key === "start"
  )
    return typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : undefined
  if (key === "status")
    return typeof value === "string" && SAFE_TOOL_STATUSES.has(value)
      ? value
      : undefined
  if (key === "language")
    return typeof value === "string" &&
      /^[a-z0-9][a-z0-9+_.-]{0,31}$/u.test(value)
      ? value
      : undefined
  return undefined
}

function safeToolArgs(name: string, value: Record<string, unknown>) {
  const allowed = TOOL_ARG_FIELDS.get(name) ?? DEFAULT_TOOL_ARG_FIELDS
  const projected: Record<string, unknown> = {}
  let inspected = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    inspected += 1
    if (inspected > MAX_GRAPH_ENTRIES) break
    if (!allowed.has(key) || sensitiveToolKey(key)) continue
    let item: unknown
    try {
      item = value[key]
    } catch {
      continue
    }
    const safe = safeToolMetadata(key, item)
    if (safe !== undefined) projected[key] = safe
  }
  return JSON.stringify(projected)
}

function resultContent(_name: string, value: unknown) {
  const projected: Record<string, unknown> = {}
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    let inspected = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      inspected += 1
      if (inspected > MAX_GRAPH_ENTRIES) break
      if (!DEFAULT_TOOL_RESULT_FIELDS.has(key) || sensitiveToolKey(key))
        continue
      let item: unknown
      try {
        item = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const safe = safeToolMetadata(key, item)
      if (safe !== undefined) projected[key] = safe
    }
  }
  if (Object.keys(projected).length === 0) projected.status = "completed"
  return JSON.stringify(projected)
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
    const key = scopeKey(active.scope)
    if (this.#active.get(key) === active) this.#active.delete(key)
  }
}
