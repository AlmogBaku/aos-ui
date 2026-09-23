import {
  CompactionStatus,
  TurnEventKind,
  type StopReason,
  aggregateTokenUsage,
  type TokenUsage,
  type TurnEvent,
} from "../../core/events"
import type { McpToolNameResolver } from "../../core/aos-tool-names"

import { projectTodos, type Todo } from "../todos"

import type { OpenCodeDurableEvent } from "./client"
import { openCodeArtifactReceipt } from "./content"
import {
  openCodeModelOptionId,
  openCodeStopReason,
  openCodeTimestamp,
} from "./native-schemas"
import { OPENCODE_TODO_STATUS_ALIASES, OPENCODE_TODO_TOOL } from "./todos"
import {
  OPENCODE_SHELL_TOOL,
  canonicalOpenCodeToolCall,
  canonicalOpenCodeToolName,
  openCodeToolKind,
} from "./tool-names"

const MAX_ID_LENGTH = 512
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_EVENT_BYTES = 2 * 1024 * 1024
const MAX_DUPLICATE_FINGERPRINTS = 256
const MAX_JSON_DEPTH = 64
/** The latest instant a JavaScript `Date` can name, in milliseconds. */
const MAX_DATE_MS = 8.64e15

type Projection = Readonly<{
  events: TurnEvent[]
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
  /** The progress text already streamed, which each snapshot extends. */
  output: string
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
      cachedWriteTokens: written,
      totalTokens: input + output + reasoning,
    },
  ]
}

type ModelRef = { id: string; providerID: string }

/** When a validated event happened, unless its timestamp names no real date. */
function occurredAt(data: Record<string, unknown>) {
  const timestamp = data.timestamp as number
  return timestamp <= MAX_DATE_MS ? openCodeTimestamp(timestamp) : undefined
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
  readonly #sessionId: string
  readonly #epoch: string
  readonly #tools = new Map<string, ToolState>()
  readonly #fingerprints = new Map<number, string>()
  readonly #admissionId?: string
  #admissionMatched: boolean
  /**
   * The live id of the prompt the admission saves. OpenCode stores the user
   * message under the admission's own id, so a matched admission proves it.
   */
  readonly #userMessageId?: string
  #lastSeen: number
  #closed = false
  #stopping = false
  /**
   * The last plan this projector published, so an unchanged list is silent. A
   * projector lives for one turn segment, and a suppressed replay rebuilds this
   * without emitting.
   */
  #plan?: string
  readonly #usage: TokenUsage[] = []
  /** The turn's price so far, summed over every step that ended. */
  #cost?: number
  /** How the last step that ended stopped. */
  #stopReason?: StopReason
  /** The model the latest step ran on. */
  #model?: ModelRef

  readonly #resolveMcpTool?: McpToolNameResolver

  constructor(
    sessionId: string,
    lastSeen: number,
    options: Readonly<{
      admissionId?: string
      userMessageId?: string
      resolveMcpTool?: McpToolNameResolver
    }> = {}
  ) {
    if (
      !identifier(sessionId) ||
      (lastSeen !== -1 && integer(lastSeen) === undefined) ||
      (options.admissionId !== undefined && !identifier(options.admissionId))
    )
      throw new OpenCodeEventValidationError()
    this.#sessionId = sessionId
    this.#epoch = `opencode:${sessionId}`
    this.#lastSeen = lastSeen
    this.#admissionId = options.admissionId
    this.#admissionMatched = options.admissionId === undefined
    this.#userMessageId = options.userMessageId
    this.#resolveMcpTool = options.resolveMcpTool
  }

  recoveryPosition() {
    return { epoch: this.#epoch, lastSeen: this.#lastSeen }
  }

  markStopping() {
    this.#stopping = true
  }

  accept(value: OpenCodeDurableEvent): Projection {
    return this.acceptValidated(
      validateOpenCodeLiveEvent(value, this.#sessionId)
    )
  }

  acceptHistory(value: unknown): Projection {
    return this.acceptValidated(
      validateOpenCodeHistoryEvent(value, this.#sessionId)
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
    const events = this.#closeOpenTools(
      this.#stopping ? "stopped" : "completed"
    )
    const savedId = this.#admissionMatched ? this.#admissionId : undefined
    events.push({
      kind: TurnEventKind.TurnEnded,
      // A stop the operator asked for outranks how the last step ended.
      ...(this.#stopReason && !this.#stopping
        ? { stopReason: this.#stopReason }
        : {}),
      ...(this.#usage.length
        ? { usage: aggregateTokenUsage(this.#usage) }
        : {}),
      ...(this.#cost === undefined
        ? {}
        : { cost: { amount: this.#cost, currency: "USD" } }),
      ...(savedId && this.#userMessageId
        ? { saved: { user: { messageId: this.#userMessageId, savedId } } }
        : {}),
    })
    return { events, terminal: "finished" }
  }

  fail(code: string, message: string): Projection {
    if (this.#closed) return { events: [] }
    this.#closed = true
    const events = this.#closeOpenTools()
    events.push({
      kind: TurnEventKind.TurnFailed,
      code,
      message,
      ...(this.#model
        ? { provider: this.#model.providerID, model: this.#model.id }
        : {}),
    })
    return { events, terminal: "error" }
  }

  #project(event: ValidatedOpenCodeEvent): Projection {
    const { type, data } = event
    const events: TurnEvent[] = []
    if (type === "session.next.prompt.admitted") {
      const id = data.messageID as string
      if (!this.#admissionMatched) {
        if (id !== this.#admissionId) throw new OpenCodeEventValidationError()
        this.#admissionMatched = true
        return { events, admissionId: id }
      }
      return { events, admissionId: id, admissionBoundary: true }
    }
    if (
      type === "session.next.reasoning.ended" ||
      type === "session.next.text.ended"
    ) {
      const text = data.text as string
      if (text)
        events.push({
          kind:
            type === "session.next.text.ended"
              ? TurnEventKind.MessageChunk
              : TurnEventKind.ThoughtChunk,
          messageId: data.assistantMessageID as string,
          text,
        })
    } else if (type === "session.next.tool.input.started") {
      this.#openTool(
        events,
        data.callID as string,
        data.assistantMessageID as string,
        data.name as string,
        occurredAt(data)
      )
    } else if (type === "session.next.tool.input.ended") {
      const callId = data.callID as string
      const tool = this.#tools.get(callId)
      if (!tool || tool.messageId !== data.assistantMessageID)
        throw new OpenCodeEventValidationError()
      const text = data.text as string
      if (text) {
        events.push({
          kind: TurnEventKind.ToolCallInputChunk,
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
        data.tool as string,
        occurredAt(data)
      )
      if (tool.name === OPENCODE_TODO_TOOL)
        tool.todoInput = data.input as Record<string, unknown>
      if (!tool.args) {
        const args = JSON.stringify(data.input)
        events.push({
          kind: TurnEventKind.ToolCallInputChunk,
          toolCallId: callId,
          delta: args,
        })
        tool.args = args
      }
    } else if (type === "session.next.tool.progress") {
      const callId = data.callID as string
      const tool = this.#tools.get(callId)
      if (!tool) throw new OpenCodeEventValidationError()
      // Each report restates the call's whole output so far, so only text that
      // extends what already streamed is new; the settled output replaces it.
      const text = safeTextContent(data.content)
      if (
        !tool.ended &&
        text.length > tool.output.length &&
        text.startsWith(tool.output)
      ) {
        events.push({
          kind: TurnEventKind.ToolCallOutputChunk,
          toolCallId: callId,
          text: text.slice(tool.output.length),
        })
        tool.output = text
      }
    } else if (type === "session.next.shell.started") {
      this.#startShell(events, data)
    } else if (type === "session.next.shell.ended") {
      this.#endShell(events, data)
    } else if (
      type === "session.next.tool.success" ||
      type === "session.next.tool.failed"
    ) {
      const callId = data.callID as string
      const tool = this.#tools.get(callId)
      if (!tool || tool.ended) throw new OpenCodeEventValidationError()
      tool.ended = true
      const failed = type === "session.next.tool.failed"
      const completedAt = occurredAt(data)
      const text = failed ? undefined : safeTextContent(data.content)
      const artifact =
        text !== undefined &&
        canonicalOpenCodeToolName(tool.name) === "present_artifact"
          ? openCodeArtifactReceipt(callId, text)
          : undefined
      events.push(
        { kind: TurnEventKind.ToolCallInputEnded, toolCallId: callId },
        {
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: callId,
          output: artifact
            ? JSON.stringify(artifact.result)
            : text === undefined
              ? JSON.stringify({ status: "error" })
              : toolResultContent(tool.name, text),
          failed,
          ...(completedAt ? { completedAt } : {}),
        }
      )
      if (artifact)
        events.push({
          kind: TurnEventKind.ArtifactPublished,
          artifact: artifact.descriptor,
        })
      // A written list is authoritative; a failed write left the plan alone.
      if (!failed && tool.todoInput) {
        const todos = projectTodos(tool.todoInput, OPENCODE_TODO_STATUS_ALIASES)
        if (todos) this.#emitPlan(events, todos)
      }
    } else if (type === "session.next.step.started") {
      const { id, providerID } = data.model as ModelRef
      this.#model = { id, providerID }
    } else if (type === "session.next.step.ended") {
      this.#usage.push(...tokenUsage(data.tokens))
      this.#cost = (this.#cost ?? 0) + (data.cost as number)
      this.#stopReason = openCodeStopReason(data.finish as string)
    } else if (type === "session.next.model.switched") {
      events.push({
        kind: TurnEventKind.ModelChanged,
        modelId: openCodeModelOptionId(data.model as ModelRef),
      })
    } else if (type === "session.next.compaction.started") {
      events.push({
        kind: TurnEventKind.CompactionUpdated,
        compactionId: data.messageID as string,
        status: CompactionStatus.Started,
      })
    } else if (type === "session.next.compaction.ended") {
      // The recent tail OpenCode keeps verbatim stays native: only the
      // summary is what the compaction wrote.
      const summary = data.text as string
      events.push({
        kind: TurnEventKind.CompactionUpdated,
        compactionId: data.messageID as string,
        status: CompactionStatus.Completed,
        ...(summary ? { summary } : {}),
      })
    } else if (type === "session.next.step.failed") {
      return this.fail(
        "AOS_PROVIDER_RUN_FAILED",
        "OpenCode could not complete this turn."
      )
    }
    return { events }
  }

  /** Publishes this Session's whole plan, and nothing when it did not change. */
  #emitPlan(events: TurnEvent[], todos: Todo[]) {
    const plan = JSON.stringify(todos)
    if (this.#plan === plan) return
    events.push({ kind: TurnEventKind.PlanUpdated, todos })
    this.#plan = plan
  }

  /**
   * A command the operator ran in the Session's shell, told as a call that
   * runs a terminal: OpenCode reports it apart from the model's tools.
   */
  #startShell(events: TurnEvent[], data: Record<string, unknown>) {
    const callId = data.callID as string
    const command = data.command as string
    const tool = this.#openTool(
      events,
      callId,
      data.messageID as string,
      OPENCODE_SHELL_TOOL,
      occurredAt(data)
    )
    if (tool.args) return
    tool.args = JSON.stringify({ command })
    events.push(
      {
        kind: TurnEventKind.ToolCallInputChunk,
        toolCallId: callId,
        delta: tool.args,
      },
      {
        kind: TurnEventKind.TerminalOutput,
        terminalId: callId,
        toolCallId: callId,
        command,
      }
    )
  }

  /** OpenCode reports a shell's output whole, and never its exit code. */
  #endShell(events: TurnEvent[], data: Record<string, unknown>) {
    const callId = data.callID as string
    const tool = this.#tools.get(callId)
    // A shell that started before this segment has no call here to end.
    if (!tool || tool.ended || tool.name !== OPENCODE_SHELL_TOOL) return
    tool.ended = true
    const output = data.output as string
    const completedAt = occurredAt(data)
    events.push(
      {
        kind: TurnEventKind.TerminalOutput,
        terminalId: callId,
        toolCallId: callId,
        ...(output ? { data: output } : {}),
        exit: {},
      },
      { kind: TurnEventKind.ToolCallInputEnded, toolCallId: callId },
      {
        kind: TurnEventKind.ToolCallFinished,
        toolCallId: callId,
        output: output || JSON.stringify({ status: "completed" }),
        failed: false,
        ...(completedAt ? { completedAt } : {}),
      }
    )
  }

  #openTool(
    events: TurnEvent[],
    callId: string,
    messageId: string,
    name: string,
    startedAt: string | undefined
  ) {
    const existing = this.#tools.get(callId)
    if (existing) {
      if (existing.messageId !== messageId || existing.name !== name)
        throw new OpenCodeEventValidationError()
      return existing
    }
    const tool: ToolState = {
      messageId,
      name,
      args: "",
      ended: false,
      output: "",
    }
    this.#tools.set(callId, tool)
    const canonical = canonicalOpenCodeToolName(name, this.#resolveMcpTool)
    const toolKind = openCodeToolKind(canonical)
    events.push({
      kind: TurnEventKind.ToolCallStarted,
      toolCallId: callId,
      title: canonical,
      name: canonical,
      ...(toolKind ? { toolKind } : {}),
      ...(startedAt ? { startedAt } : {}),
      parentMessageId: messageId,
    })
    return tool
  }

  /** Ends every open call; a settled turn also finishes each with `status`. */
  #closeOpenTools(status?: "completed" | "stopped") {
    const events: TurnEvent[] = []
    for (const [callId, tool] of this.#tools) {
      if (tool.ended) continue
      tool.ended = true
      events.push({
        kind: TurnEventKind.ToolCallInputEnded,
        toolCallId: callId,
      })
      if (status)
        events.push({
          kind: TurnEventKind.ToolCallFinished,
          toolCallId: callId,
          output: JSON.stringify({ status }),
          failed: false,
        })
    }
    return events
  }
}
