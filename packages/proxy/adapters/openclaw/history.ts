import type {
  Session,
  SessionHistoryResponse,
  SessionMessage,
} from "../../../protocol"

import {
  openClawHistoryParams,
  openClawModelsParams,
  openClawSessionsParams,
  parseOpenClawHistory,
  parseOpenClawModels,
  parseOpenClawSessions,
  type OpenClawSession,
} from "./native-schemas"
import type { OpenClawWorkspaceClient } from "./workspace"

const HISTORY_DEFAULT_PAGE = 200
const HISTORY_MAX_PAGE = 500
const MAX_MESSAGE_PARTS = 2_000

export interface OpenClawHistoryAuthority {
  getSession(agentId: string, sessionKey: string): Promise<Session>
}

/**
 * This is deliberately an OpenClaw-private subscription hook. The official
 * Gateway client owns its Session subscription coordinator; there is no shared
 * transport or synthetic live Session identity here.
 */
export type OpenClawHistorySubscription = (
  agentId: string,
  sessionKey: string,
  onInvalidate: () => void
) => Promise<() => void>

export class OpenClawHistoryUnavailableError extends Error {
  constructor() {
    super("OpenClaw history is temporarily unavailable")
    this.name = "OpenClawHistoryUnavailableError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max = 1_000_000) {
  return typeof value === "string" && value.length <= max ? value : undefined
}

function identifier(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
    ? value
    : undefined
}

function timestamp(row: Record<string, unknown>, index: number) {
  const candidate = row.createdAt ?? row.timestamp
  if (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
  )
    return new Date(candidate).toISOString()
  return new Date(index).toISOString()
}

function nativeMessageId(row: Record<string, unknown>) {
  const envelope = record(row.__openclaw) ? row.__openclaw : undefined
  return identifier(envelope?.id) ?? identifier(row.id)
}

function nativeSequence(row: Record<string, unknown>, index: number) {
  const envelope = record(row.__openclaw) ? row.__openclaw : undefined
  const seq = envelope?.seq
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
    ? seq
    : index
}

interface JsonObject {
  readonly [key: string]: JsonValue
}

interface JsonArray extends ReadonlyArray<JsonValue> {
  readonly __jsonArray?: never
}

type JsonValue = null | boolean | number | string | JsonArray | JsonObject

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items = value.map(jsonValue)
    return items.some((item) => item === undefined)
      ? undefined
      : (items as JsonValue[])
  }
  if (!record(value)) return undefined
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    const parsed = jsonValue(item)
    if (parsed === undefined) return undefined
    result[key] = parsed
  }
  return result
}

type ToolCall = Extract<
  SessionMessage["content"][number],
  { type: "tool-call" }
>

function jsonRecord(value: unknown): ToolCall["args"] {
  const parsed = jsonValue(value)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as ToolCall["args"])
    : {}
}

function messageParts(value: unknown): SessionMessage["content"] {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_PARTS) return []
  const parts: SessionMessage["content"] = []
  for (const part of value) {
    if (!record(part)) return []
    if (part.type === "text") {
      const text = boundedString(part.text)
      if (text !== undefined) parts.push({ type: "text", text })
      continue
    }
    if (part.type === "thinking") {
      const text = boundedString(part.thinking)
      if (text !== undefined) parts.push({ type: "reasoning", text })
      continue
    }
    if (part.type === "toolCall") {
      const toolCallId = identifier(part.id)
      const toolName = identifier(part.name)
      if (!toolCallId || !toolName) continue
      const args = jsonRecord(part.arguments)
      const argsText = JSON.stringify(args)
      if (argsText.length <= 1_000_000)
        parts.push({ type: "tool-call", toolCallId, toolName, args, argsText })
    }
  }
  return parts
}

function projectMessages(rows: readonly unknown[]): SessionMessage[] {
  const messages: Array<{
    message: SessionMessage
    sequence: number
    index: number
  }> = []
  const toolCalls = new Map<
    string,
    { message: SessionMessage; index: number }
  >()
  for (const [index, raw] of rows.entries()) {
    if (!record(raw)) continue
    if (raw.role === "toolResult") {
      const toolCallId = identifier(raw.toolCallId)
      const target = toolCallId ? toolCalls.get(toolCallId) : undefined
      if (!target) continue
      const part = target.message.content[target.index]
      if (part?.type !== "tool-call") continue
      target.message.content[target.index] = {
        ...part,
        result: typeof raw.content === "string" ? raw.content : null,
        ...(raw.isError === true ? { isError: true } : {}),
      }
      continue
    }
    if (
      raw.role !== "user" &&
      raw.role !== "assistant" &&
      raw.role !== "system"
    )
      continue
    const id = nativeMessageId(raw)
    if (!id) continue
    const message: SessionMessage = {
      id,
      role: raw.role,
      content: messageParts(raw.content),
      createdAt: timestamp(raw, index),
    }
    for (const [partIndex, part] of message.content.entries())
      if (part.type === "tool-call")
        toolCalls.set(part.toolCallId, { message, index: partIndex })
    messages.push({ message, sequence: nativeSequence(raw, index), index })
  }
  return messages
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.index - right.index
    )
    .map(({ message }) => message)
}

function verifyRowOwnership(
  agentId: string,
  sessionKey: string,
  row: OpenClawSession
) {
  const embedded = /^agent:([^:]+):/u.exec(row.key)?.[1]
  if (
    row.key !== sessionKey ||
    (embedded !== undefined && embedded !== agentId) ||
    (row.agentId !== undefined && row.agentId !== agentId)
  )
    throw new OpenClawHistoryUnavailableError()
}

function execution(history: ReturnType<typeof parseOpenClawHistory>) {
  if (history.inFlightRun?.runId)
    return { status: "running" as const, runId: history.inFlightRun.runId }
  const active = history.sessionInfo?.activeRunIds ?? []
  if (active.length === 1)
    return { status: "running" as const, runId: active[0] }
  if (history.sessionInfo?.hasActiveRun || active.length > 0)
    return { status: "running" as const }
  return { status: "idle" as const }
}

export type OpenClawHistoryOperations = Readonly<{
  history(
    agentId: string,
    sessionKey: string,
    limit?: number,
    offset?: number
  ): Promise<SessionHistoryResponse>
  models(
    agentId: string,
    sessionKey: string
  ): Promise<{
    selectedId: string
    options: Array<{ id: string; label: string; group: string }>
  }>
  context(
    agentId: string,
    sessionKey: string
  ): Promise<{
    usedTokens: number
    maxTokens: number
    source: "provider-usage"
  }>
  activity(
    agentId: string,
    sessionKey: string
  ): Promise<{ state: "running" | "idle" }>
}>

export function createOpenClawHistory(input: {
  client: OpenClawWorkspaceClient
  authority: OpenClawHistoryAuthority
  subscribeSession?: OpenClawHistorySubscription
}): OpenClawHistoryOperations {
  const requireScope = async (agentId: string, sessionKey: string) => {
    const session = await input.authority.getSession(agentId, sessionKey)
    if (session.agentId !== agentId || session.id !== sessionKey)
      throw new OpenClawHistoryUnavailableError()
  }
  const nativeSession = async (agentId: string, sessionKey: string) => {
    await requireScope(agentId, sessionKey)
    const rows = parseOpenClawSessions(
      await input.client.request(
        "sessions.list",
        openClawSessionsParams(agentId, 100, 0)
      )
    )
    const matches = rows.filter((row) => row.key === sessionKey)
    if (matches.length !== 1) throw new OpenClawHistoryUnavailableError()
    verifyRowOwnership(agentId, sessionKey, matches[0]!)
    return matches[0]!
  }
  return {
    async history(
      agentId,
      sessionKey,
      limit = HISTORY_DEFAULT_PAGE,
      offset = 0
    ) {
      if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_PAGE)
        throw new OpenClawHistoryUnavailableError()
      if (!Number.isInteger(offset) || offset < 0)
        throw new OpenClawHistoryUnavailableError()
      await requireScope(agentId, sessionKey)
      for (let attempt = 0; attempt < 2; attempt++) {
        let dirty = false
        const unsubscribe = await input.subscribeSession?.(
          agentId,
          sessionKey,
          () => {
            dirty = true
          }
        )
        try {
          const native = parseOpenClawHistory(
            await input.client.request(
              "chat.history",
              openClawHistoryParams(agentId, sessionKey, limit, offset)
            )
          )
          if (dirty) continue
          const messages = projectMessages(native.messages)
          return {
            sessionId: sessionKey,
            messages,
            total: offset + messages.length,
            limit,
            offset,
            nextOffset: offset + messages.length,
            execution: execution(native),
          }
        } finally {
          unsubscribe?.()
        }
      }
      throw new OpenClawHistoryUnavailableError()
    },
    async models(agentId, sessionKey) {
      await requireScope(agentId, sessionKey)
      const catalog = parseOpenClawModels(
        await input.client.request(
          "models.list",
          openClawModelsParams(agentId, sessionKey)
        )
      )
      const selected = await nativeSession(agentId, sessionKey)
      const options = catalog.models.map((model) => ({
        id: JSON.stringify([model.provider, model.id]),
        label: model.name,
        group: model.provider,
      }))
      const selectedId = JSON.stringify([
        selected.modelProvider ?? "",
        selected.model ?? "",
      ])
      if (!options.some((option) => option.id === selectedId))
        throw new OpenClawHistoryUnavailableError()
      return { selectedId, options }
    },
    async context(agentId, sessionKey) {
      const session = await nativeSession(agentId, sessionKey)
      if (
        session.totalTokens === undefined ||
        session.contextTokens === undefined ||
        session.contextTokens < 1
      )
        throw new OpenClawHistoryUnavailableError()
      return {
        usedTokens: session.totalTokens,
        maxTokens: session.contextTokens,
        source: "provider-usage" as const,
      }
    },
    async activity(agentId, sessionKey) {
      await requireScope(agentId, sessionKey)
      const history = parseOpenClawHistory(
        await input.client.request(
          "chat.history",
          openClawHistoryParams(agentId, sessionKey, 1, 0)
        )
      )
      return {
        state: execution(history).status === "running" ? "running" : "idle",
      }
    },
  }
}
