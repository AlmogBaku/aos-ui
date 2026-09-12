import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type RunAgentInput,
} from "@ag-ui/core"

const MAX_NATIVE_TEXT_DELTA_BYTES = 1_048_576
const MAX_USER_TURN_BYTES = 1_048_576
const MAX_RECOVERY_EVENTS = 4_096
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
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else this.#values.push(value)
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

function resultContent(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return "null"
  }
}

function boundedText(value: unknown) {
  return typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= MAX_NATIVE_TEXT_DELTA_BYTES
    ? value
    : undefined
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
    const buffered: unknown[] = []
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
          if (!accepting) buffered.push(event)
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
        lastSeen: baseline.lastSeen,
        textStarted: false,
        reasoningStarted: false,
        reasoningEnded: false,
        tools: new Map(),
        stopping: false,
        uncertain: false,
        detached: false,
        terminal: false,
      }
      this.#active.set(key, active)
    } catch (reason) {
      unsubscribe?.()
      throw reason
    } finally {
      this.#admissions.delete(key)
    }
    if (
      baseline.truncated === true ||
      baseline.events.length > MAX_RECOVERY_EVENTS
    ) {
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "Hermes history must be reconciled before this run can continue."
      )
      return this.#handle(active)
    }
    if (connectionInterrupted) {
      this.#markInterrupted(active)
      return this.#handle(active)
    }
    let status: "running" | "waiting" | "idle"
    try {
      status = await this.#native.status(liveSessionId)
    } catch (reason) {
      this.#settle(active)
      throw reason
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
    accepting = true
    for (const event of buffered) this.#accept(active, event)
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
    const buffered: unknown[] = []
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
          if (!accepting) buffered.push(event)
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
      }
      this.#active.set(key, active)
    } catch (reason) {
      unsubscribe?.()
      throw reason
    } finally {
      this.#admissions.delete(key)
    }
    if (
      recovery.truncated === true ||
      recovery.events.length > MAX_RECOVERY_EVENTS ||
      recovery.epoch !== request.position.epoch
    ) {
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "Hermes history must be reconciled before this run can continue."
      )
      return this.#handle(active)
    }
    if (connectionInterrupted) {
      this.#markInterrupted(active)
      return this.#handle(active)
    }
    for (const event of recovery.events) this.#accept(active, event)
    active.lastSeen = Math.max(active.lastSeen, recovery.lastSeen)
    accepting = true
    for (const event of buffered) this.#accept(active, event)
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
    active.unsubscribe()
    active.queue = queue
    active.uncertain = false
    active.detached = false
    active.lastSeen = request.position.lastSeen
    const buffered: unknown[] = []
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
          if (!accepting) buffered.push(event)
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
    } catch (reason) {
      nextUnsubscribe?.()
      active.uncertain = true
      active.detached = true
      queue.close()
      throw reason
    }
    active.epoch = recovery.epoch
    if (
      recovery.truncated === true ||
      recovery.events.length > MAX_RECOVERY_EVENTS ||
      recovery.epoch !== request.position.epoch
    ) {
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "Hermes history must be reconciled before this run can continue."
      )
      return this.#handle(active)
    }
    if (connectionInterrupted) {
      this.#markInterrupted(active)
      return this.#handle(active)
    }
    for (const event of recovery.events) this.#accept(active, event)
    active.lastSeen = Math.max(active.lastSeen, recovery.lastSeen)
    accepting = true
    for (const event of buffered) this.#accept(active, event)
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
    if (event.type === "message.start") {
      if (!active.textStarted) {
        active.messageId =
          stableNativeId(payload.message_id ?? payload.id) ??
          `${active.runId}:assistant`
        active.textStarted = true
        active.queue.push({
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
      active.queue.push({
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
        active.queue.push({
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningId,
          role: "reasoning",
        })
      }
      active.queue.push({
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
      active.queue.push({ type: EventType.TOOL_CALL_END, toolCallId })
      active.queue.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${active.messageId}:tool:${toolCallId}`,
        toolCallId,
        content: resultContent(payload.result),
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
    active.queue.push({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: tool.name,
      parentMessageId: active.messageId,
    })
    active.queue.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(normalized.args),
    })
    return tool
  }

  #endReasoning(active: ActiveRun) {
    if (!active.reasoningStarted || active.reasoningEnded || !active.messageId)
      return
    active.reasoningEnded = true
    active.queue.push({
      type: EventType.REASONING_MESSAGE_END,
      messageId: `${active.messageId}:reasoning`,
    })
  }

  async #stop(active: ActiveRun): Promise<"stopping" | "idle"> {
    if (active.terminal) return "idle"
    active.stopping = true
    await this.#native.interrupt(active.liveSessionId)
    if ((await this.#native.status(active.liveSessionId)) === "idle") {
      this.#finish(active, { stopped: true })
      return "idle"
    }
    return "stopping"
  }

  #finish(active: ActiveRun, result?: unknown) {
    if (active.terminal) return
    this.#endReasoning(active)
    if (active.textStarted && active.messageId)
      active.queue.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: active.messageId,
      })
    active.queue.push({
      type: EventType.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      ...(result === undefined ? {} : { result }),
      outcome: { type: "success" },
    })
    this.#settle(active)
  }

  #fail(active: ActiveRun, code: string, message: string) {
    if (active.terminal) return
    this.#endReasoning(active)
    if (active.textStarted && active.messageId)
      active.queue.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: active.messageId,
      })
    active.queue.push({ type: EventType.RUN_ERROR, message, code })
    this.#settle(active)
  }

  #markUncertain(active: ActiveRun) {
    active.uncertain = true
    active.queue.push({
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
    active.queue.push({
      type: EventType.RUN_ERROR,
      message:
        "The Hermes connection was interrupted; reconnect to reconcile this run.",
      code: "AOS_CONNECTION_INTERRUPTED",
    })
    active.queue.close()
  }

  #settle(active: ActiveRun) {
    if (active.terminal) return
    active.terminal = true
    active.unsubscribe()
    active.queue.close()
    this.#active.delete(scopeKey(active.scope))
  }
}
