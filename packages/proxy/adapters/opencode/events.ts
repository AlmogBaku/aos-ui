import {
  RunEventKind,
  aggregateTokenUsage,
  type TokenUsage,
} from "../../core/events"
import type { RunEvent } from "../../core/events"

import { projectTodos, type Todo } from "../todos"

import type { OpenCodeDurableEvent } from "./client"
import { OPENCODE_TODO_STATUS_ALIASES, OPENCODE_TODO_TOOL } from "./todos"
import {
  canonicalOpenCodeToolCall,
  canonicalOpenCodeToolName,
} from "./tool-names"

const MAX_ID_LENGTH = 512
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_EVENT_BYTES = 2 * 1024 * 1024
const MAX_DUPLICATE_FINGERPRINTS = 256
const MAX_JSON_DEPTH = 64

type ProjectorScope = Readonly<{
  sessionId: string
  threadId: string
  runId: string
}>

type Projection = Readonly<{
  events: RunEvent[]
  terminal?: "finished" | "error"
  admissionId?: string
  admissionBoundary?: boolean
}>

export type ValidatedOpenCodeEvent = Readonly<{
  id: string
  seq: number
  version: number
  type: string
  data: Record<string, unknown>
  fingerprint: string
}>

type ToolState = {
  messageId: string
  /** The native name, so later native-tool recognition still works. */
  name: string
  args: string
  ended: boolean
  /**
   * The native Todo tool's own call input, kept only for that tool. The input
   * is the list OpenCode is about to write, so the plan needs no second read.
   */
  todoInput?: Record<string, unknown>
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

function stableJson(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): string {
  if (depth > MAX_JSON_DEPTH) throw new OpenCodeEventValidationError()
  if (value === null || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value)
  if (!value || typeof value !== "object")
    throw new OpenCodeEventValidationError()
  if (seen.has(value)) throw new OpenCodeEventValidationError()
  seen.add(value)
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, depth + 1, seen)).join(",")}]`
    : `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${stableJson(
              (value as Record<string, unknown>)[key],
              depth + 1,
              seen
            )}`
        )
        .join(",")}}`
  seen.delete(value)
  if (
    depth === 0 &&
    new TextEncoder().encode(result).byteLength > MAX_EVENT_BYTES
  )
    throw new OpenCodeEventValidationError()
  return result
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

function requireRecord(value: unknown) {
  const parsed = record(value)
  if (!parsed) throw new OpenCodeEventValidationError()
  return parsed
}

function optionalStrings(value: unknown) {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new OpenCodeEventValidationError()
  for (const item of value) requireString(item)
}

function validateSource(value: unknown) {
  const source = requireRecord(value)
  if (
    typeof source.start !== "number" ||
    !Number.isFinite(source.start) ||
    typeof source.end !== "number" ||
    !Number.isFinite(source.end)
  )
    throw new OpenCodeEventValidationError()
  requireString(source.text, true)
}

function validateStringRecord(value: unknown) {
  const entries = requireRecord(value)
  for (const [key, item] of Object.entries(entries)) {
    requireString(key)
    requireString(item, true)
  }
}

function validateProviderMetadata(value: unknown) {
  const metadata = requireRecord(value)
  for (const nested of Object.values(metadata)) requireRecord(nested)
}

function validateModel(value: unknown) {
  const model = requireRecord(value)
  requireIdentifier(model.id)
  requireIdentifier(model.providerID)
  if (model.variant !== undefined) requireIdentifier(model.variant)
}

function validateLocation(value: unknown) {
  const location = requireRecord(value)
  requireString(location.directory)
  if (location.workspaceID !== undefined)
    requireIdentifier(location.workspaceID)
}

function validatePrompt(value: unknown) {
  const prompt = requireRecord(value)
  requireString(prompt.text, true)
  if (prompt.files !== undefined) {
    if (!Array.isArray(prompt.files)) throw new OpenCodeEventValidationError()
    for (const value of prompt.files) {
      const file = requireRecord(value)
      requireString(file.uri)
      requireString(file.mime)
      if (file.name !== undefined) requireString(file.name)
      if (file.description !== undefined) requireString(file.description)
      if (file.source !== undefined) validateSource(file.source)
    }
  }
  if (prompt.agents !== undefined) {
    if (!Array.isArray(prompt.agents)) throw new OpenCodeEventValidationError()
    for (const value of prompt.agents) {
      const agent = requireRecord(value)
      requireIdentifier(agent.name)
      if (agent.source !== undefined) validateSource(agent.source)
    }
  }
}

function validateProvider(value: unknown) {
  const provider = requireRecord(value)
  if (typeof provider.executed !== "boolean")
    throw new OpenCodeEventValidationError()
  if (provider.metadata !== undefined)
    validateProviderMetadata(provider.metadata)
}

function validateStepError(value: unknown) {
  const error = requireRecord(value)
  if (error.type !== "unknown") throw new OpenCodeEventValidationError()
  requireString(error.message)
}

function safeTextContent(value: unknown) {
  if (!Array.isArray(value)) throw new OpenCodeEventValidationError()
  const parts: string[] = []
  for (const item of value) {
    const content = requireRecord(item)
    if (content.type === "text") parts.push(requireString(content.text, true))
    else if (content.type === "file") {
      requireString(content.uri)
      requireString(content.mime)
      if (content.name !== undefined) requireString(content.name)
    } else throw new OpenCodeEventValidationError()
  }
  return parts.join("\n")
}

/** The canonical text or JSON outcome AOS emits for one native tool call. */
function toolResultContent(nativeName: string, text: string) {
  const { result } = canonicalOpenCodeToolCall(nativeName, undefined, text)
  if (typeof result === "string")
    return result || JSON.stringify({ status: "completed" })
  return JSON.stringify(result)
}

function tokenUsage(value: unknown): TokenUsage[] {
  const tokens = requireRecord(value)
  const cache = requireRecord(tokens.cache)
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

function validateRetryError(value: unknown) {
  const error = requireRecord(value)
  requireString(error.message)
  if (typeof error.isRetryable !== "boolean")
    throw new OpenCodeEventValidationError()
  if (
    error.statusCode !== undefined &&
    (typeof error.statusCode !== "number" || !Number.isFinite(error.statusCode))
  )
    throw new OpenCodeEventValidationError()
  if (error.responseHeaders !== undefined)
    validateStringRecord(error.responseHeaders)
  if (error.responseBody !== undefined) requireString(error.responseBody, true)
  if (error.metadata !== undefined) validateStringRecord(error.metadata)
}

function validateRevert(value: unknown) {
  const revert = requireRecord(value)
  requireIdentifier(revert.messageID)
  if (revert.partID !== undefined) requireIdentifier(revert.partID)
  if (revert.snapshot !== undefined) requireString(revert.snapshot, true)
  if (revert.diff !== undefined) requireString(revert.diff, true)
  if (revert.files === undefined) return
  if (!Array.isArray(revert.files)) throw new OpenCodeEventValidationError()
  for (const value of revert.files) {
    const file = requireRecord(value)
    requireString(file.path)
    if (
      file.status !== "added" &&
      file.status !== "modified" &&
      file.status !== "deleted"
    )
      throw new OpenCodeEventValidationError()
    if (
      integer(file.additions) === undefined ||
      integer(file.deletions) === undefined
    )
      throw new OpenCodeEventValidationError()
    requireString(file.patch, true)
  }
}

function validateData(type: string, data: Record<string, unknown>) {
  requireIdentifier(data.sessionID)
  requireTimestamp(data.timestamp)

  switch (type) {
    case "session.next.agent.switched":
      requireIdentifier(data.messageID)
      requireIdentifier(data.agent)
      break
    case "session.next.model.switched":
      requireIdentifier(data.messageID)
      validateModel(data.model)
      break
    case "session.next.moved":
      validateLocation(data.location)
      if (data.subdirectory !== undefined) requireString(data.subdirectory)
      break
    case "session.next.prompted":
    case "session.next.prompt.admitted":
      requireIdentifier(data.messageID)
      validatePrompt(data.prompt)
      if (data.delivery !== "steer" && data.delivery !== "queue")
        throw new OpenCodeEventValidationError()
      break
    case "session.next.context.updated":
    case "session.next.synthetic":
      requireIdentifier(data.messageID)
      requireString(data.text, true)
      break
    case "session.next.shell.started":
      requireIdentifier(data.messageID)
      requireIdentifier(data.callID)
      requireString(data.command)
      break
    case "session.next.shell.ended":
      requireIdentifier(data.callID)
      requireString(data.output, true)
      break
    case "session.next.step.started":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.agent)
      validateModel(data.model)
      if (data.snapshot !== undefined) requireString(data.snapshot)
      break
    case "session.next.step.ended":
      requireIdentifier(data.assistantMessageID)
      requireString(data.finish)
      if (
        typeof data.cost !== "number" ||
        !Number.isFinite(data.cost) ||
        data.cost < 0
      )
        throw new OpenCodeEventValidationError()
      tokenUsage(data.tokens)
      if (data.snapshot !== undefined) requireString(data.snapshot, true)
      optionalStrings(data.files)
      break
    case "session.next.step.failed":
      requireIdentifier(data.assistantMessageID)
      validateStepError(data.error)
      break
    case "session.next.text.started":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.textID)
      break
    case "session.next.text.ended":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.textID)
      requireString(data.text, true)
      break
    case "session.next.reasoning.started":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.reasoningID)
      if (data.providerMetadata !== undefined)
        validateProviderMetadata(data.providerMetadata)
      break
    case "session.next.reasoning.ended":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.reasoningID)
      requireString(data.text, true)
      if (data.providerMetadata !== undefined)
        validateProviderMetadata(data.providerMetadata)
      break
    case "session.next.tool.input.started":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.callID)
      requireIdentifier(data.name)
      break
    case "session.next.tool.input.ended":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.callID)
      requireString(data.text, true)
      break
    case "session.next.tool.called":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.callID)
      requireIdentifier(data.tool)
      requireRecord(data.input)
      validateProvider(data.provider)
      break
    case "session.next.tool.progress":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.callID)
      requireRecord(data.structured)
      safeTextContent(data.content)
      break
    case "session.next.tool.success":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.callID)
      requireRecord(data.structured)
      safeTextContent(data.content)
      optionalStrings(data.outputPaths)
      validateProvider(data.provider)
      break
    case "session.next.tool.failed":
      requireIdentifier(data.assistantMessageID)
      requireIdentifier(data.callID)
      validateStepError(data.error)
      validateProvider(data.provider)
      break
    case "session.next.retried":
      if (integer(data.attempt) === undefined)
        throw new OpenCodeEventValidationError()
      validateRetryError(data.error)
      break
    case "session.next.compaction.started":
      requireIdentifier(data.messageID)
      if (data.reason !== "auto" && data.reason !== "manual")
        throw new OpenCodeEventValidationError()
      break
    case "session.next.compaction.ended":
      requireIdentifier(data.messageID)
      if (data.reason !== "auto" && data.reason !== "manual")
        throw new OpenCodeEventValidationError()
      requireString(data.text, true)
      requireString(data.recent, true)
      break
    case "session.next.revert.staged":
      validateRevert(data.revert)
      break
    case "session.next.revert.cleared":
      break
    case "session.next.revert.committed":
      requireIdentifier(data.messageID)
      break
    default:
      throw new OpenCodeEventValidationError()
  }
}

export function validateOpenCodeHistoryEvent(
  value: unknown,
  expectedSessionId: string
): ValidatedOpenCodeEvent {
  const event = requireRecord(value)
  const id = requireIdentifier(event.id)
  const type = requireIdentifier(event.type)
  const durable = requireRecord(event.durable)
  const data = requireRecord(event.data)
  const seq = integer(durable.seq)
  const version = integer(durable.version)
  const expectedVersion =
    type === "session.next.step.ended" || type === "session.next.step.failed"
      ? 2
      : 1
  if (
    durable.aggregateID !== expectedSessionId ||
    seq === undefined ||
    version !== expectedVersion ||
    data.sessionID !== expectedSessionId
  )
    throw new OpenCodeEventValidationError()
  if (event.metadata !== undefined) requireRecord(event.metadata)
  if (event.location !== undefined) validateLocation(event.location)
  validateData(type, data)
  const fingerprint = stableJson(event)
  return {
    id,
    seq,
    version,
    type,
    data,
    fingerprint,
  }
}

export function validateOpenCodeLiveEvent(
  value: OpenCodeDurableEvent,
  expectedSessionId: string
) {
  if (value.event !== "session") throw new OpenCodeEventValidationError()
  const seq = Number(value.id)
  if (!Number.isSafeInteger(seq) || seq < 0 || String(seq) !== value.id)
    throw new OpenCodeEventValidationError()
  const event = validateOpenCodeHistoryEvent(value.data, expectedSessionId)
  if (event.seq !== seq) throw new OpenCodeEventValidationError()
  return event
}

export class OpenCodeEventProjector {
  readonly #scope: ProjectorScope
  readonly #epoch: string
  readonly #tools = new Map<string, ToolState>()
  readonly #fingerprints = new Map<number, string>()
  readonly #admissionId?: string
  #admissionMatched: boolean
  #lastSeen: number
  #closed = false
  #stopping = false
  #messageId?: string
  #textOpen = false
  #reasoningId?: string
  #reasoningOpen = false
  /**
   * The last plan this projector published, so an unchanged list is silent and
   * the first change after one is a patch. A projector lives for one run
   * segment, and a suppressed replay rebuilds this without emitting.
   */
  #plan?: string
  readonly #usage: TokenUsage[] = []

  constructor(
    scope: ProjectorScope,
    lastSeen: number,
    options: Readonly<{ admissionId?: string }> = {}
  ) {
    if (
      !identifier(scope.sessionId) ||
      !boundedString(scope.threadId) ||
      !boundedString(scope.runId) ||
      (lastSeen !== -1 && integer(lastSeen) === undefined) ||
      (options.admissionId !== undefined && !identifier(options.admissionId))
    )
      throw new OpenCodeEventValidationError()
    this.#scope = scope
    this.#epoch = `opencode:${scope.sessionId}`
    this.#lastSeen = lastSeen
    this.#admissionId = options.admissionId
    this.#admissionMatched = options.admissionId === undefined
  }

  recoveryPosition() {
    return { epoch: this.#epoch, lastSeen: this.#lastSeen }
  }

  markStopping() {
    this.#stopping = true
  }

  accept(value: OpenCodeDurableEvent): Projection {
    return this.acceptValidated(
      validateOpenCodeLiveEvent(value, this.#scope.sessionId)
    )
  }

  acceptHistory(value: unknown): Projection {
    return this.acceptValidated(
      validateOpenCodeHistoryEvent(value, this.#scope.sessionId)
    )
  }

  acceptValidated(event: ValidatedOpenCodeEvent): Projection {
    return this.#acceptValidated(event, false)
  }

  reconstructValidated(event: ValidatedOpenCodeEvent) {
    return this.#acceptValidated(event, true)
  }

  #acceptValidated(
    event: ValidatedOpenCodeEvent,
    suppressEvents: boolean
  ): Projection {
    const prior = this.#fingerprints.get(event.seq)
    if (prior !== undefined) {
      if (prior !== event.fingerprint) throw new OpenCodeEventValidationError()
      return { events: [] }
    }
    if (event.seq <= this.#lastSeen) return { events: [] }
    if (event.seq !== this.#lastSeen + 1)
      throw new OpenCodeEventValidationError()
    const projection = this.#closed ? { events: [] } : this.#project(event)
    this.#lastSeen = event.seq
    this.#fingerprints.set(event.seq, event.fingerprint)
    if (this.#fingerprints.size > MAX_DUPLICATE_FINGERPRINTS) {
      const oldest = this.#fingerprints.keys().next().value
      if (oldest !== undefined) this.#fingerprints.delete(oldest)
    }
    if (!suppressEvents) return projection
    if (!projection.terminal) return { events: [] }
    const terminal = projection.events.at(-1)
    return {
      events: terminal ? [terminal] : [],
      terminal: projection.terminal,
    }
  }

  finish(): Projection {
    if (this.#closed) return { events: [] }
    this.#closed = true
    const events = this.#closeOpenContent(
      this.#stopping ? "stopped" : "completed"
    )
    events.push({
      type: RunEventKind.RUN_FINISHED,
      threadId: this.#scope.threadId,
      runId: this.#scope.runId,
      ...(this.#stopping ? { result: { stopped: true } } : {}),
      ...(this.#usage.length
        ? { usage: aggregateTokenUsage(this.#usage) }
        : {}),
      outcome: { type: "success" },
    })
    return { events, terminal: "finished" }
  }

  fail(code: string, message: string): Projection {
    if (this.#closed) return { events: [] }
    this.#closed = true
    const events = this.#closeOpenContent()
    events.push({ type: RunEventKind.RUN_ERROR, code, message })
    return { events, terminal: "error" }
  }

  #project(event: ValidatedOpenCodeEvent): Projection {
    const { type, data } = event
    const events: RunEvent[] = []
    if (type === "session.next.prompt.admitted") {
      const id = data.messageID as string
      if (!this.#admissionMatched) {
        if (id !== this.#admissionId) throw new OpenCodeEventValidationError()
        this.#admissionMatched = true
        return { events, admissionId: id }
      }
      return { events, admissionId: id, admissionBoundary: true }
    }
    if (type === "session.next.reasoning.started") {
      this.#openReasoning(
        events,
        data.assistantMessageID as string,
        data.reasoningID as string
      )
    } else if (type === "session.next.reasoning.ended") {
      const messageId = data.assistantMessageID as string
      const reasoningId = data.reasoningID as string
      this.#openReasoning(events, messageId, reasoningId)
      const text = data.text as string
      if (text)
        events.push({
          type: RunEventKind.REASONING_MESSAGE_CONTENT,
          messageId: reasoningId,
          delta: text,
        })
      this.#closeReasoning(events)
    } else if (type === "session.next.text.started") {
      this.#closeReasoning(events)
      this.#openText(events, data.assistantMessageID as string)
    } else if (type === "session.next.text.ended") {
      const messageId = data.assistantMessageID as string
      this.#closeReasoning(events)
      this.#openText(events, messageId)
      const text = data.text as string
      if (text)
        events.push({
          type: RunEventKind.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: text,
        })
      this.#closeText(events)
    } else if (type === "session.next.tool.input.started") {
      this.#openTool(
        events,
        data.callID as string,
        data.assistantMessageID as string,
        data.name as string
      )
    } else if (type === "session.next.tool.input.ended") {
      const callId = data.callID as string
      const tool = this.#tools.get(callId)
      if (!tool || tool.messageId !== data.assistantMessageID)
        throw new OpenCodeEventValidationError()
      const text = data.text as string
      if (text) {
        events.push({
          type: RunEventKind.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta: text,
        })
        tool.args = text
      }
    } else if (type === "session.next.tool.called") {
      const callId = data.callID as string
      const tool = this.#openTool(
        events,
        callId,
        data.assistantMessageID as string,
        data.tool as string
      )
      if (tool.name === OPENCODE_TODO_TOOL)
        tool.todoInput = data.input as Record<string, unknown>
      if (!tool.args) {
        const args = JSON.stringify(data.input)
        events.push({
          type: RunEventKind.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta: args,
        })
        tool.args = args
      }
    } else if (type === "session.next.tool.progress") {
      const callId = data.callID as string
      if (!this.#tools.has(callId)) throw new OpenCodeEventValidationError()
      const text = safeTextContent(data.content)
      events.push({
        type: RunEventKind.ACTIVITY_SNAPSHOT,
        messageId: `${this.#scope.runId}:progress:${callId}`,
        activityType: "PROGRESS",
        content: { callId, status: "running", ...(text ? { text } : {}) },
        replace: true,
      })
    } else if (
      type === "session.next.tool.success" ||
      type === "session.next.tool.failed"
    ) {
      const callId = data.callID as string
      const tool = this.#tools.get(callId)
      if (!tool || tool.ended) throw new OpenCodeEventValidationError()
      tool.ended = true
      events.push({ type: RunEventKind.TOOL_CALL_END, toolCallId: callId })
      events.push({
        type: RunEventKind.TOOL_CALL_RESULT,
        messageId: `${tool.messageId}:tool:${callId}`,
        toolCallId: callId,
        content:
          type === "session.next.tool.failed"
            ? JSON.stringify({ status: "error" })
            : toolResultContent(tool.name, safeTextContent(data.content)),
        role: "tool",
      })
      // A written list is authoritative; a failed write left the plan alone.
      if (type === "session.next.tool.success" && tool.todoInput) {
        const todos = projectTodos(tool.todoInput, OPENCODE_TODO_STATUS_ALIASES)
        if (todos) this.#emitPlan(events, todos)
      }
    } else if (type === "session.next.step.ended") {
      this.#usage.push(...tokenUsage(data.tokens))
    } else if (type === "session.next.step.failed") {
      return this.fail(
        "AOS_PROVIDER_RUN_FAILED",
        "OpenCode could not complete this run."
      )
    }
    return { events }
  }

  /**
   * Publishes this Session's plan on the one standard Todo channel: a snapshot
   * the first time, a patch for every later change, and nothing at all when the
   * list did not change.
   */
  #emitPlan(events: RunEvent[], todos: Todo[]) {
    const plan = JSON.stringify(todos)
    if (this.#plan === plan) return
    const messageId = `aos-plan:${this.#scope.threadId}`
    events.push(
      this.#plan === undefined
        ? {
            type: RunEventKind.ACTIVITY_SNAPSHOT,
            messageId,
            activityType: "PLAN",
            content: { todos },
            replace: true,
          }
        : {
            type: RunEventKind.ACTIVITY_DELTA,
            messageId,
            activityType: "PLAN",
            patch: [{ op: "replace", path: "/todos", value: todos }],
          }
    )
    this.#plan = plan
  }

  #openReasoning(events: RunEvent[], messageId: string, reasoningId: string) {
    if (this.#reasoningOpen) {
      if (this.#messageId !== messageId || this.#reasoningId !== reasoningId)
        throw new OpenCodeEventValidationError()
      return
    }
    this.#messageId = messageId
    this.#reasoningId = reasoningId
    this.#reasoningOpen = true
    events.push({
      type: RunEventKind.REASONING_MESSAGE_START,
      messageId: reasoningId,
      role: "reasoning",
    })
  }

  #openText(events: RunEvent[], messageId: string) {
    if (this.#textOpen) {
      if (this.#messageId !== messageId)
        throw new OpenCodeEventValidationError()
      return
    }
    this.#messageId = messageId
    this.#textOpen = true
    events.push({
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    })
  }

  #openTool(
    events: RunEvent[],
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
    const tool: ToolState = { messageId, name, args: "", ended: false }
    this.#tools.set(callId, tool)
    events.push({
      type: RunEventKind.TOOL_CALL_START,
      toolCallId: callId,
      toolCallName: canonicalOpenCodeToolName(name),
      parentMessageId: messageId,
    })
    return tool
  }

  #closeReasoning(events: RunEvent[]) {
    if (!this.#reasoningOpen || !this.#reasoningId) return
    events.push({
      type: RunEventKind.REASONING_MESSAGE_END,
      messageId: this.#reasoningId,
    })
    this.#reasoningOpen = false
  }

  #closeText(events: RunEvent[]) {
    if (!this.#textOpen || !this.#messageId) return
    events.push({
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: this.#messageId,
    })
    this.#textOpen = false
  }

  #closeOpenContent(toolStatus?: "completed" | "stopped") {
    const events: RunEvent[] = []
    this.#closeReasoning(events)
    this.#closeText(events)
    for (const [callId, tool] of this.#tools) {
      if (tool.ended) continue
      tool.ended = true
      events.push({ type: RunEventKind.TOOL_CALL_END, toolCallId: callId })
      if (toolStatus)
        events.push({
          type: RunEventKind.TOOL_CALL_RESULT,
          messageId: `${tool.messageId}:tool:${callId}`,
          toolCallId: callId,
          content: JSON.stringify({ status: toolStatus }),
          role: "tool",
        })
    }
    return events
  }
}
