import {
  AgentsListParamsSchema,
  AgentsListResultSchema,
  ChatHistoryParamsSchema,
  ModelsListParamsSchema,
  SessionsCreateParamsSchema,
  SessionsCreateResultSchema,
  SessionsDeleteParamsSchema,
  SessionsListParamsSchema,
  SessionsPatchParamsSchema,
} from "@openclaw/gateway-protocol"
import { Value } from "typebox/value"

const MAX_NATIVE_COLLECTION = 1_000
const MAX_NATIVE_STRING = 1_000_000
const MAX_NATIVE_BYTES = 2_000_000
const MAX_NATIVE_NODES = 20_000
const MAX_NATIVE_DEPTH = 32

export class OpenClawNativePayloadError extends Error {
  constructor() {
    super("OpenClaw returned an invalid native payload")
    this.name = "OpenClawNativePayloadError"
  }
}

export type OpenClawAgent = Readonly<{
  id: string
  name?: string
  kind?: "agent" | "system"
  createdVia?: "operator" | "agent" | "claw"
  creatorAgentId?: string | null
  identity?: Readonly<{ name?: string }>
}>

export type OpenClawSession = Readonly<{
  key: string
  agentId?: string
  label?: string
  displayName?: string
  archived?: boolean
  pinned?: boolean
  updatedAt?: number
  lastInteractionAt?: number
  hasActiveRun?: boolean
  activeRunIds?: readonly string[] | null
  sessionId?: string
  model?: string
  modelProvider?: string
  totalTokens?: number
  contextTokens?: number
}>

export type OpenClawCreatedSession = Readonly<{
  key: string
  sessionId?: string
  runStarted?: boolean
}>

export type OpenClawHistory = Readonly<{
  messages: readonly unknown[]
  inFlightRun?: Readonly<{ runId: string; text?: string }> | null
  sessionInfo?: Readonly<{
    hasActiveRun?: boolean
    activeRunIds?: readonly string[]
  }>
}>

export type OpenClawModels = Readonly<{
  models: readonly Readonly<{
    id: string
    name: string
    provider: string
    available?: boolean
    contextWindow?: number
    contextTokens?: number
  }>[]
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function string(value: unknown, max = 4_096) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function stringList(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_NATIVE_COLLECTION) return
  const values = value.map((candidate) => string(candidate, 4_096))
  return values.every((candidate) => candidate !== undefined)
    ? (values as string[])
    : undefined
}

function official<T>(schema: object, value: T): T {
  if (!Value.Check(schema, value)) throw new OpenClawNativePayloadError()
  return value
}

function boundedNativeValue(value: unknown, maxRows: number) {
  if (!Number.isInteger(maxRows) || maxRows < 1)
    throw new OpenClawNativePayloadError()
  let bytes = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_NATIVE_DEPTH || ++nodes > MAX_NATIVE_NODES)
      throw new OpenClawNativePayloadError()
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8")
      if (bytes > MAX_NATIVE_BYTES) throw new OpenClawNativePayloadError()
      return
    }
    if (value === null || typeof value !== "object") return
    if (seen.has(value)) throw new OpenClawNativePayloadError()
    seen.add(value)
    if (Array.isArray(value)) {
      if (value.length > Math.max(maxRows, MAX_NATIVE_COLLECTION))
        throw new OpenClawNativePayloadError()
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      bytes += Buffer.byteLength(key, "utf8")
      if (bytes > MAX_NATIVE_BYTES) throw new OpenClawNativePayloadError()
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
}

export function openClawAgentsParams() {
  return official(AgentsListParamsSchema, {})
}

export function openClawSessionsParams(
  agentId: string,
  limit: number,
  offset: number
) {
  return official(SessionsListParamsSchema, {
    agentId,
    limit,
    offset,
    sortBy: "updatedAt" as const,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
  })
}

export function openClawCreateSessionParams(agentId: string) {
  return official(SessionsCreateParamsSchema, { agentId })
}

/** Exactly one proven native Session flag; the gateway owns its side effects. */
export type OpenClawSessionPatch =
  | Readonly<{ label: string }>
  | Readonly<{ archived: boolean }>
  | Readonly<{ pinned: boolean }>

export function openClawPatchSessionParams(
  agentId: string,
  sessionKey: string,
  patch: OpenClawSessionPatch
) {
  return official(SessionsPatchParamsSchema, {
    agentId,
    key: sessionKey,
    ...patch,
  })
}

export function openClawDeleteSessionParams(
  agentId: string,
  sessionKey: string
) {
  return official(SessionsDeleteParamsSchema, { agentId, key: sessionKey })
}

export function openClawInvitedSessionsParams(
  agentId: string,
  sessionKey: string
) {
  return official(SessionsListParamsSchema, {
    agentId,
    search: sessionKey,
    limit: 100,
    offset: 0,
    sortBy: "updatedAt" as const,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
  })
}

export function openClawHistoryParams(
  agentId: string,
  sessionKey: string,
  limit: number,
  offset: number
) {
  return official(ChatHistoryParamsSchema, {
    agentId,
    sessionKey,
    limit,
    offset,
  })
}

export function openClawModelsParams(agentId: string, sessionKey: string) {
  return official(ModelsListParamsSchema, { agentId, sessionKey })
}

export function parseOpenClawAgents(value: unknown): readonly OpenClawAgent[] {
  boundedNativeValue(value, MAX_NATIVE_COLLECTION)
  official(AgentsListResultSchema, value)
  const agents = (value as { agents: readonly OpenClawAgent[] }).agents
  if (agents.length > MAX_NATIVE_COLLECTION)
    throw new OpenClawNativePayloadError()
  return agents
}

export function parseOpenClawSessions(
  value: unknown,
  maxRows: number
): readonly OpenClawSession[] {
  boundedNativeValue(value, maxRows)
  if (!isRecord(value) || !Array.isArray(value.sessions))
    throw new OpenClawNativePayloadError()
  if (value.sessions.length > maxRows) throw new OpenClawNativePayloadError()
  return value.sessions.map((value) => {
    if (!isRecord(value)) throw new OpenClawNativePayloadError()
    const key = string(value.key)
    if (!key) throw new OpenClawNativePayloadError()
    const activeRunIds =
      value.activeRunIds === null ? null : stringList(value.activeRunIds)
    if (value.activeRunIds !== undefined && activeRunIds === undefined)
      throw new OpenClawNativePayloadError()
    const number = (value: unknown) => {
      if (value === undefined) return undefined
      const parsed = integer(value)
      if (parsed === undefined) throw new OpenClawNativePayloadError()
      return parsed
    }
    const optionalString = (value: unknown) => {
      if (value === undefined) return undefined
      const parsed = string(value)
      if (!parsed) throw new OpenClawNativePayloadError()
      return parsed
    }
    if (value.agentId !== undefined && !optionalString(value.agentId))
      throw new OpenClawNativePayloadError()
    if (value.archived !== undefined && typeof value.archived !== "boolean")
      throw new OpenClawNativePayloadError()
    if (value.pinned !== undefined && typeof value.pinned !== "boolean")
      throw new OpenClawNativePayloadError()
    if (
      value.hasActiveRun !== undefined &&
      typeof value.hasActiveRun !== "boolean"
    )
      throw new OpenClawNativePayloadError()
    return {
      key,
      ...(optionalString(value.agentId)
        ? { agentId: value.agentId as string }
        : {}),
      ...(optionalString(value.label) ? { label: value.label as string } : {}),
      ...(optionalString(value.displayName)
        ? { displayName: value.displayName as string }
        : {}),
      ...(typeof value.archived === "boolean"
        ? { archived: value.archived }
        : {}),
      ...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}),
      ...(number(value.updatedAt) !== undefined
        ? { updatedAt: number(value.updatedAt) }
        : {}),
      ...(number(value.lastInteractionAt) !== undefined
        ? { lastInteractionAt: number(value.lastInteractionAt) }
        : {}),
      ...(typeof value.hasActiveRun === "boolean"
        ? { hasActiveRun: value.hasActiveRun }
        : {}),
      ...(activeRunIds !== undefined ? { activeRunIds } : {}),
      ...(optionalString(value.sessionId)
        ? { sessionId: value.sessionId as string }
        : {}),
      ...(optionalString(value.model) ? { model: value.model as string } : {}),
      ...(optionalString(value.modelProvider)
        ? { modelProvider: value.modelProvider as string }
        : {}),
      ...(number(value.totalTokens) !== undefined
        ? { totalTokens: number(value.totalTokens) }
        : {}),
      ...(number(value.contextTokens) !== undefined
        ? { contextTokens: number(value.contextTokens) }
        : {}),
    }
  })
}

export function parseOpenClawCreatedSession(
  value: unknown
): OpenClawCreatedSession {
  boundedNativeValue(value, 1)
  official(SessionsCreateResultSchema, value)
  const created = value as OpenClawCreatedSession
  if (created.runStarted === true) throw new OpenClawNativePayloadError()
  return {
    key: created.key,
    ...(created.sessionId === undefined
      ? {}
      : { sessionId: created.sessionId }),
    ...(created.runStarted === undefined
      ? {}
      : { runStarted: created.runStarted }),
  }
}

export function parseOpenClawHistory(
  value: unknown,
  maxRows: number
): OpenClawHistory {
  boundedNativeValue(value, maxRows)
  if (!isRecord(value) || !Array.isArray(value.messages))
    throw new OpenClawNativePayloadError()
  if (value.messages.length > maxRows) throw new OpenClawNativePayloadError()
  let inFlightRun: OpenClawHistory["inFlightRun"]
  if (value.inFlightRun !== undefined && value.inFlightRun !== null) {
    if (!isRecord(value.inFlightRun)) throw new OpenClawNativePayloadError()
    const runId = string(value.inFlightRun.runId)
    const text =
      value.inFlightRun.text === undefined
        ? undefined
        : string(value.inFlightRun.text, MAX_NATIVE_STRING)
    if (!runId || (value.inFlightRun.text !== undefined && text === undefined))
      throw new OpenClawNativePayloadError()
    inFlightRun = { runId, ...(text === undefined ? {} : { text }) }
  } else inFlightRun = value.inFlightRun === null ? null : undefined
  let sessionInfo: OpenClawHistory["sessionInfo"]
  if (value.sessionInfo !== undefined) {
    if (!isRecord(value.sessionInfo)) throw new OpenClawNativePayloadError()
    const activeRunIds =
      value.sessionInfo.activeRunIds === undefined
        ? undefined
        : stringList(value.sessionInfo.activeRunIds)
    if (
      activeRunIds === undefined &&
      value.sessionInfo.activeRunIds !== undefined
    )
      throw new OpenClawNativePayloadError()
    if (
      value.sessionInfo.hasActiveRun !== undefined &&
      typeof value.sessionInfo.hasActiveRun !== "boolean"
    )
      throw new OpenClawNativePayloadError()
    sessionInfo = {
      ...(typeof value.sessionInfo.hasActiveRun === "boolean"
        ? { hasActiveRun: value.sessionInfo.hasActiveRun }
        : {}),
      ...(activeRunIds === undefined ? {} : { activeRunIds }),
    }
  }
  return {
    messages: value.messages,
    ...(inFlightRun === undefined ? {} : { inFlightRun }),
    ...(sessionInfo === undefined ? {} : { sessionInfo }),
  }
}

export function parseOpenClawModels(value: unknown): OpenClawModels {
  boundedNativeValue(value, MAX_NATIVE_COLLECTION)
  if (!isRecord(value) || !Array.isArray(value.models))
    throw new OpenClawNativePayloadError()
  if (value.models.length > MAX_NATIVE_COLLECTION)
    throw new OpenClawNativePayloadError()
  return {
    models: value.models.map((value) => {
      if (!isRecord(value)) throw new OpenClawNativePayloadError()
      const id = string(value.id)
      const name = string(value.name)
      const provider = string(value.provider)
      if (!id || !name || !provider) throw new OpenClawNativePayloadError()
      if (value.available !== undefined && typeof value.available !== "boolean")
        throw new OpenClawNativePayloadError()
      const contextWindow =
        value.contextWindow === undefined
          ? undefined
          : integer(value.contextWindow)
      const contextTokens =
        value.contextTokens === undefined
          ? undefined
          : integer(value.contextTokens)
      if (
        (value.contextWindow !== undefined && contextWindow === undefined) ||
        (value.contextTokens !== undefined && contextTokens === undefined)
      )
        throw new OpenClawNativePayloadError()
      return {
        id,
        name,
        provider,
        ...(typeof value.available === "boolean"
          ? { available: value.available }
          : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
      }
    }),
  }
}
