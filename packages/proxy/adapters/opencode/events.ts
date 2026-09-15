import { EventType, type AGUIEvent, type TokenUsage } from "@ag-ui/core"

import type { OpenCodeDurableEvent } from "./client"

const MAX_ID_LENGTH = 512
const MAX_TEXT_BYTES = 1024 * 1024

type ProjectorScope = Readonly<{
  sessionId: string
  threadId: string
  runId: string
}>

type Projection = Readonly<{
  events: AGUIEvent[]
  terminal?: "finished" | "error"
}>

type NativeEvent = Readonly<{
  seq: number
  type: string
  properties: Record<string, unknown>
}>

type ToolState = {
  messageId: string
  name: string
  args: string
  ended: boolean
}

export class OpenCodeEventValidationError extends Error {
  constructor() {
    super("OpenCode returned an invalid Session event")
    this.name = "OpenCodeEventValidationError"
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function boundedString(value: unknown, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) return
  return value
}

function identifier(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
    ? value
    : undefined
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function requireIdentifier(value: unknown) {
  const parsed = identifier(value)
  if (!parsed) throw new OpenCodeEventValidationError()
  return parsed
}

function requireString(value: unknown, allowEmpty = false) {
  const parsed = boundedString(value, allowEmpty)
  if (parsed === undefined) throw new OpenCodeEventValidationError()
  return parsed
}

function requireTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new OpenCodeEventValidationError()
}

function liveEvent(
  value: OpenCodeDurableEvent,
  expectedSessionId: string
): NativeEvent | undefined {
  if (value.event !== "session") throw new OpenCodeEventValidationError()
  const seq = Number(value.id)
  if (!Number.isSafeInteger(seq) || seq < 0 || String(seq) !== value.id)
    throw new OpenCodeEventValidationError()
  const data = record(value.data)
  const type = identifier(data?.type)
  const properties = record(data?.properties)
  if (!type || !properties) throw new OpenCodeEventValidationError()
  if (properties.sessionID !== expectedSessionId) return
  return { seq, type, properties }
}

function historyEvent(
  value: unknown,
  expectedSessionId: string
): NativeEvent | undefined {
  const event = record(value)
  const type = identifier(event?.type)
  const data = record(event?.data)
  const durable = record(event?.durable)
  if (!type || !data || !durable) throw new OpenCodeEventValidationError()
  if (data.sessionID !== expectedSessionId) return
  if (durable.aggregateID !== expectedSessionId)
    throw new OpenCodeEventValidationError()
  const seq = integer(durable.seq)
  const version = integer(durable.version)
  if (seq === undefined || version === undefined)
    throw new OpenCodeEventValidationError()
  requireIdentifier(event?.id)
  return { seq, type, properties: data }
}

function eventMessageId(properties: Record<string, unknown>) {
  requireTimestamp(properties.timestamp)
  return requireIdentifier(properties.assistantMessageID)
}

function safeTextContent(value: unknown) {
  if (!Array.isArray(value)) throw new OpenCodeEventValidationError()
  const parts: string[] = []
  for (const item of value) {
    const content = record(item)
    if (!content || (content.type !== "text" && content.type !== "file"))
      throw new OpenCodeEventValidationError()
    if (content.type === "text") parts.push(requireString(content.text, true))
    else {
      requireString(content.uri)
      requireString(content.mime)
      if (content.name !== undefined) requireString(content.name)
    }
  }
  return parts.join("\n")
}

function tokenUsage(value: unknown): TokenUsage[] | undefined {
  const tokens = record(value)
  const cache = record(tokens?.cache)
  if (!tokens || !cache) throw new OpenCodeEventValidationError()
  const input = integer(tokens.input)
  const output = integer(tokens.output)
  const reasoning = integer(tokens.reasoning)
  const cached = integer(cache.read)
  const written = integer(cache.write)
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cached === undefined ||
    written === undefined
  )
    throw new OpenCodeEventValidationError()
  return [
    {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cachedInputTokens: cached,
      totalTokens: input + output + reasoning,
    },
  ]
}

function validateSessionError(value: unknown) {
  const error = record(value)
  const data = record(error?.data)
  const names = new Set([
    "ProviderAuthError",
    "UnknownError",
    "MessageOutputLengthError",
    "MessageAbortedError",
    "StructuredOutputError",
    "ContextOverflowError",
    "ContentFilterError",
    "APIError",
  ])
  if (
    !error ||
    !data ||
    typeof error.name !== "string" ||
    !names.has(error.name)
  )
    throw new OpenCodeEventValidationError()
  if (data.message !== undefined) requireString(data.message)
}

function validateStepError(value: unknown) {
  const error = record(value)
  if (!error || error.type !== "unknown")
    throw new OpenCodeEventValidationError()
  requireString(error.message)
}

export class OpenCodeEventProjector {
  readonly #scope: ProjectorScope
  readonly #epoch: string
  readonly #tools = new Map<string, ToolState>()
  #lastSeen: number
  #terminal = false
  #stopping = false
  #messageId?: string
  #textId?: string
  #text = ""
  #textOpen = false
  #reasoningId?: string
  #reasoning = ""
  #reasoningOpen = false
  #usage?: TokenUsage[]

  constructor(scope: ProjectorScope, lastSeen: number) {
    if (
      !identifier(scope.sessionId) ||
      !identifier(scope.threadId) ||
      !identifier(scope.runId) ||
      integer(lastSeen) === undefined
    )
      throw new OpenCodeEventValidationError()
    this.#scope = scope
    this.#epoch = `opencode:${scope.sessionId}`
    this.#lastSeen = lastSeen
  }

  recoveryPosition() {
    return { epoch: this.#epoch, lastSeen: this.#lastSeen }
  }

  markStopping() {
    this.#stopping = true
  }

  accept(value: OpenCodeDurableEvent): Projection {
    if (this.#terminal) return { events: [] }
    const event = liveEvent(value, this.#scope.sessionId)
    return event ? this.#accept(event) : { events: [] }
  }

  acceptHistory(value: unknown): Projection {
    if (this.#terminal) return { events: [] }
    const event = historyEvent(value, this.#scope.sessionId)
    return event ? this.#accept(event) : { events: [] }
  }

  finish(): Projection {
    if (this.#terminal) return { events: [] }
    this.#terminal = true
    const events = this.#closeOpenContent(
      this.#stopping ? "stopped" : "completed"
    )
    events.push({
      type: EventType.RUN_FINISHED,
      threadId: this.#scope.threadId,
      runId: this.#scope.runId,
      ...(this.#stopping ? { result: { stopped: true } } : {}),
      ...(this.#usage ? { usage: this.#usage } : {}),
      outcome: { type: "success" },
    })
    return { events, terminal: "finished" }
  }

  fail(code: string, message: string): Projection {
    if (this.#terminal) return { events: [] }
    this.#terminal = true
    const events = this.#closeOpenContent()
    events.push({ type: EventType.RUN_ERROR, code, message })
    return { events, terminal: "error" }
  }

  #accept(event: NativeEvent): Projection {
    if (event.seq <= this.#lastSeen) return { events: [] }
    const projection = this.#project(event)
    this.#lastSeen = event.seq
    return projection
  }

  #project(event: NativeEvent): Projection {
    const { type, properties } = event
    const events: AGUIEvent[] = []

    if (type === "session.next.reasoning.started") {
      const messageId = eventMessageId(properties)
      const reasoningId = requireIdentifier(properties.reasoningID)
      this.#openReasoning(events, messageId, reasoningId)
    } else if (type === "session.next.reasoning.delta") {
      const messageId = eventMessageId(properties)
      const reasoningId = requireIdentifier(properties.reasoningID)
      const delta = requireString(properties.delta, true)
      this.#openReasoning(events, messageId, reasoningId)
      if (delta) {
        events.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningId,
          delta,
        })
        this.#reasoning += delta
      }
    } else if (type === "session.next.reasoning.ended") {
      const messageId = eventMessageId(properties)
      const reasoningId = requireIdentifier(properties.reasoningID)
      const text = requireString(properties.text, true)
      this.#openReasoning(events, messageId, reasoningId)
      this.#appendCompleted(events, "reasoning", reasoningId, text)
      this.#closeReasoning(events)
    } else if (type === "session.next.text.started") {
      const messageId = eventMessageId(properties)
      const textId = requireIdentifier(properties.textID)
      this.#closeReasoning(events)
      this.#openText(events, messageId, textId)
    } else if (type === "session.next.text.delta") {
      const messageId = eventMessageId(properties)
      const textId = requireIdentifier(properties.textID)
      const delta = requireString(properties.delta, true)
      this.#closeReasoning(events)
      this.#openText(events, messageId, textId)
      if (delta) {
        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
        })
        this.#text += delta
      }
    } else if (type === "session.next.text.ended") {
      const messageId = eventMessageId(properties)
      const textId = requireIdentifier(properties.textID)
      const text = requireString(properties.text, true)
      this.#closeReasoning(events)
      this.#openText(events, messageId, textId)
      this.#appendCompleted(events, "text", messageId, text)
      this.#closeText(events)
    } else if (type === "session.next.tool.input.started") {
      const messageId = eventMessageId(properties)
      const callId = requireIdentifier(properties.callID)
      const name = requireIdentifier(properties.name)
      this.#openTool(events, callId, messageId, name)
    } else if (type === "session.next.tool.input.delta") {
      const messageId = eventMessageId(properties)
      const callId = requireIdentifier(properties.callID)
      const delta = requireString(properties.delta, true)
      const tool = this.#tools.get(callId)
      if (!tool || tool.messageId !== messageId)
        throw new OpenCodeEventValidationError()
      if (delta) {
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta,
        })
        tool.args += delta
      }
    } else if (type === "session.next.tool.input.ended") {
      const messageId = eventMessageId(properties)
      const callId = requireIdentifier(properties.callID)
      const text = requireString(properties.text, true)
      const tool = this.#tools.get(callId)
      if (!tool || tool.messageId !== messageId || !text.startsWith(tool.args))
        throw new OpenCodeEventValidationError()
      const delta = text.slice(tool.args.length)
      if (delta)
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta,
        })
      tool.args = text
    } else if (type === "session.next.tool.called") {
      const messageId = eventMessageId(properties)
      const callId = requireIdentifier(properties.callID)
      const name = requireIdentifier(properties.tool)
      const input = record(properties.input)
      if (!input || !record(properties.provider))
        throw new OpenCodeEventValidationError()
      const tool = this.#openTool(events, callId, messageId, name)
      const args = JSON.stringify(input)
      if (!tool.args && args) {
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta: args,
        })
        tool.args = args
      }
    } else if (type === "session.next.tool.progress") {
      eventMessageId(properties)
      const callId = requireIdentifier(properties.callID)
      if (!record(properties.structured) || !this.#tools.has(callId))
        throw new OpenCodeEventValidationError()
      const progress = safeTextContent(properties.content)
      events.push({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `${this.#scope.runId}:progress:${callId}`,
        activityType: "PROGRESS",
        content: {
          callId,
          status: "running",
          ...(progress ? { text: progress } : {}),
        },
        replace: true,
      })
    } else if (
      type === "session.next.tool.success" ||
      type === "session.next.tool.failed"
    ) {
      eventMessageId(properties)
      const callId = requireIdentifier(properties.callID)
      const tool = this.#tools.get(callId)
      if (!tool || tool.ended || !record(properties.provider))
        throw new OpenCodeEventValidationError()
      if (!record(properties.structured))
        throw new OpenCodeEventValidationError()
      const content = safeTextContent(properties.content)
      tool.ended = true
      events.push({ type: EventType.TOOL_CALL_END, toolCallId: callId })
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${tool.messageId}:tool:${callId}`,
        toolCallId: callId,
        content:
          type === "session.next.tool.failed"
            ? JSON.stringify({ status: "error" })
            : content || JSON.stringify({ status: "completed" }),
        role: "tool",
      })
    } else if (type === "session.next.step.ended") {
      eventMessageId(properties)
      requireString(properties.finish)
      if (typeof properties.cost !== "number" || properties.cost < 0)
        throw new OpenCodeEventValidationError()
      this.#usage = tokenUsage(properties.tokens)
    } else if (
      type === "session.next.step.failed" ||
      type === "session.error"
    ) {
      if (type === "session.next.step.failed") {
        eventMessageId(properties)
        validateStepError(properties.error)
      } else validateSessionError(properties.error)
      return this.fail(
        "AOS_PROVIDER_RUN_FAILED",
        "OpenCode could not complete this run."
      )
    } else if (type === "session.status") {
      const status = record(properties.status)
      if (!status || !["idle", "busy", "retry"].includes(String(status.type)))
        throw new OpenCodeEventValidationError()
      if (status.type === "idle") return this.finish()
    } else if (type === "session.idle") {
      return this.finish()
    }

    return { events }
  }

  #openReasoning(events: AGUIEvent[], messageId: string, reasoningId: string) {
    if (this.#reasoningOpen) {
      if (this.#messageId !== messageId || this.#reasoningId !== reasoningId)
        throw new OpenCodeEventValidationError()
      return
    }
    this.#messageId = messageId
    this.#reasoningId = reasoningId
    this.#reasoning = ""
    this.#reasoningOpen = true
    events.push({
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoningId,
      role: "reasoning",
    })
  }

  #openText(events: AGUIEvent[], messageId: string, textId: string) {
    if (this.#textOpen) {
      if (this.#messageId !== messageId || this.#textId !== textId)
        throw new OpenCodeEventValidationError()
      return
    }
    this.#messageId = messageId
    this.#textId = textId
    this.#text = ""
    this.#textOpen = true
    events.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    })
  }

  #openTool(
    events: AGUIEvent[],
    callId: string,
    messageId: string,
    name: string
  ) {
    const existing = this.#tools.get(callId)
    if (existing) {
      if (existing.messageId !== messageId || existing.name !== name)
        throw new OpenCodeEventValidationError()
      return existing
    }
    const tool = { messageId, name, args: "", ended: false }
    this.#tools.set(callId, tool)
    events.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: callId,
      toolCallName: name,
      parentMessageId: messageId,
    })
    return tool
  }

  #appendCompleted(
    events: AGUIEvent[],
    kind: "text" | "reasoning",
    messageId: string,
    completed: string
  ) {
    const streamed = kind === "text" ? this.#text : this.#reasoning
    if (!completed.startsWith(streamed))
      throw new OpenCodeEventValidationError()
    const delta = completed.slice(streamed.length)
    if (!delta) return
    events.push({
      type:
        kind === "text"
          ? EventType.TEXT_MESSAGE_CONTENT
          : EventType.REASONING_MESSAGE_CONTENT,
      messageId,
      delta,
    })
    if (kind === "text") this.#text = completed
    else this.#reasoning = completed
  }

  #closeReasoning(events: AGUIEvent[]) {
    if (!this.#reasoningOpen || !this.#reasoningId) return
    events.push({
      type: EventType.REASONING_MESSAGE_END,
      messageId: this.#reasoningId,
    })
    this.#reasoningOpen = false
  }

  #closeText(events: AGUIEvent[]) {
    if (!this.#textOpen || !this.#messageId) return
    events.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.#messageId,
    })
    this.#textOpen = false
  }

  #closeOpenContent(toolStatus?: "completed" | "stopped") {
    const events: AGUIEvent[] = []
    this.#closeReasoning(events)
    this.#closeText(events)
    for (const [callId, tool] of this.#tools) {
      if (tool.ended) continue
      tool.ended = true
      events.push({ type: EventType.TOOL_CALL_END, toolCallId: callId })
      if (toolStatus)
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `${tool.messageId}:tool:${callId}`,
          toolCallId: callId,
          content: JSON.stringify({ status: toolStatus }),
          role: "tool",
        })
    }
    return events
  }
}
