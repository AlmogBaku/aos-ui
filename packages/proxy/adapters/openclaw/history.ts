import type {
  Session,
  SessionHistoryResponse,
  SessionMessage,
} from "../../../protocol"

import {
  canonicalAosToolName,
  canonicalToolName,
  type McpToolNameResolver,
} from "../../core/aos-tool-names"
import {
  openClawArtifactReceipt,
  openClawMediaArtifact,
  publicArtifactArgs,
  type OpenClawArtifactDescriptor,
} from "./artifacts"
import { mcpAppViewId } from "./mcp-apps"
import { mayBeMcpToolName, type OpenClawMcpToolNames } from "./mcp-tool-names"
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
/** How far back a history lookup reads before it calls its target absent. */
const HISTORY_SCAN_MAX_ROWS = 10_000

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

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One native tool outcome, from the `toolResult` row that answers a call. */
type ToolOutcome = Readonly<{
  result?: JsonValue
  isError: boolean
  artifact?: ReturnType<typeof openClawArtifactReceipt>
  /** The MCP server and tool OpenClaw records on an MCP tool's result. */
  mcp?: Readonly<{ server: string; tool: string }>
}>

/** A bounded JSON copy of a native value, or `undefined` when it has none. */
function publicJson(value: unknown): JsonValue | undefined {
  try {
    const json = JSON.stringify(value)
    return json === undefined || json.length > 262_144
      ? undefined
      : (JSON.parse(json) as JsonValue)
  } catch {
    return undefined
  }
}

/** The AOS tool a native tool name refers to. */
function aosToolName(value: unknown) {
  const name = identifier(value)
  return name && canonicalAosToolName(name)
}

function mcpTool(details: unknown) {
  const server = record(details) ? identifier(details.mcpServer) : undefined
  const tool = record(details) ? identifier(details.mcpTool) : undefined
  return server && tool ? { server, tool } : undefined
}

/**
 * The canonical name of an AOS or MCP tool call; OpenClaw's native tools are
 * not history.
 */
function historyToolName(
  value: unknown,
  outcome: ToolOutcome | undefined,
  resolve: McpToolNameResolver
) {
  const name = identifier(value)
  if (!name) return undefined
  const canonical = canonicalToolName(
    name,
    (rawName) => outcome?.mcp ?? resolve(rawName)
  )
  return canonical === name ? undefined : canonical
}

/**
 * Each `toolResult` row's outcome by call id. A `present_artifact` receipt
 * yields its published artifact and a result without the native path.
 */
function toolOutcomes(rows: readonly unknown[]) {
  const outcomes = new Map<string, ToolOutcome>()
  for (const row of rows) {
    if (!record(row) || row.role !== "toolResult") continue
    const toolCallId = identifier(row.toolCallId)
    if (!toolCallId) continue
    const artifact =
      aosToolName(row.toolName) === "present_artifact"
        ? openClawArtifactReceipt(toolCallId, row)
        : undefined
    const mcp = mcpTool(row.details)
    const result = artifact
      ? artifact.result
      : publicJson({
          content: row.content,
          ...(row.details === undefined ? {} : { details: row.details }),
        })
    outcomes.set(toolCallId, {
      ...(result === undefined ? {} : { result }),
      isError: row.isError === true,
      ...(artifact ? { artifact } : {}),
      ...(mcp ? { mcp } : {}),
    })
  }
  return outcomes
}

function artifactPart(descriptor: OpenClawArtifactDescriptor) {
  return { type: "data" as const, name: "aos.artifact", data: descriptor }
}

function toolCallParts(
  block: Record<string, unknown>,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  resolve: McpToolNameResolver
): SessionMessage["content"] {
  const toolCallId = identifier(block.id)
  const outcome = toolCallId ? outcomes.get(toolCallId) : undefined
  const name = historyToolName(block.name, outcome, resolve)
  const args = publicJson(
    name === "present_artifact"
      ? publicArtifactArgs(block.arguments)
      : block.arguments
  )
  if (!toolCallId || !name || !record(args)) return []
  const argsRecord = args as { [key: string]: JsonValue }
  return [
    {
      type: "tool-call",
      toolCallId,
      toolName: name,
      args: argsRecord,
      argsText: JSON.stringify(argsRecord),
      ...(outcome?.result === undefined ? {} : { result: outcome.result }),
      ...(outcome?.isError ? { isError: true } : {}),
    },
    ...(outcome?.artifact ? [artifactPart(outcome.artifact.descriptor)] : []),
  ]
}

function messageParts(
  value: unknown,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  resolve: McpToolNameResolver
): SessionMessage["content"] {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) return []
  const parts: SessionMessage["content"] = []
  for (const part of value) {
    if (!record(part)) continue
    if (part.type === "text") {
      const text = boundedString(part.text)
      if (text !== undefined) parts.push({ type: "text", text })
      continue
    }
    if (part.type === "toolCall") {
      parts.push(...toolCallParts(part, outcomes, resolve))
      continue
    }
    const media = openClawMediaArtifact(part)
    if (media) parts.push(artifactPart(media))
  }
  return parts
}

/** Tool call names no stored result names; only these need the MCP catalog. */
function unresolvedToolNames(rows: readonly unknown[]) {
  const outcomes = toolOutcomes(rows)
  const names = new Set<string>()
  for (const row of rows) {
    if (!record(row) || row.role !== "assistant" || !Array.isArray(row.content))
      continue
    for (const block of row.content) {
      if (!record(block) || block.type !== "toolCall") continue
      const name = identifier(block.name)
      const toolCallId = identifier(block.id)
      if (
        name &&
        mayBeMcpToolName(name) &&
        !(toolCallId && outcomes.get(toolCallId)?.mcp)
      )
        names.add(name)
    }
  }
  return [...names]
}

function projectMessages(
  rows: readonly unknown[],
  resolve: McpToolNameResolver
): SessionMessage[] {
  const outcomes = toolOutcomes(rows)
  const messages: Array<{
    message: SessionMessage
    sequence: number
    index: number
  }> = []
  for (const [index, raw] of rows.entries()) {
    if (!record(raw)) continue
    if (raw.role !== "user" && raw.role !== "assistant") continue
    const id = nativeMessageId(raw)
    if (!id) continue
    const message: SessionMessage = {
      id,
      role: raw.role,
      content: messageParts(raw.content, outcomes, resolve),
      createdAt: timestamp(raw, index),
    }
    messages.push({ message, sequence: nativeSequence(raw, index), index })
  }
  return messages
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.index - right.index
    )
    .map(({ message }) => message)
}

/** The MCP App view the `toolCallId` result among these rows opened. */
function storedMcpAppView(rows: readonly unknown[], toolCallId: string) {
  for (const row of rows)
    if (
      record(row) &&
      row.role === "toolResult" &&
      identifier(row.toolCallId) === toolCallId
    )
      return mcpAppViewId(row)
  return undefined
}

/** The published receipt artifact `artifactId` names among these rows. */
function publishedReceipt(rows: readonly unknown[], artifactId: string) {
  for (const outcome of toolOutcomes(rows).values())
    if (outcome.artifact?.descriptor.id === artifactId) return outcome.artifact
  return undefined
}

function verifyRowOwnership(
  agentId: string,
  sessionKey: string,
  row: OpenClawSession
) {
  if (row.key !== sessionKey || row.agentId !== agentId)
    throw new OpenClawHistoryUnavailableError()
}

function execution(history: ReturnType<typeof parseOpenClawHistory>) {
  if (history.inFlightRun?.runId)
    return { status: "running" as const, turnId: history.inFlightRun.runId }
  const active = history.sessionInfo?.activeRunIds ?? []
  if (active.length === 1)
    return { status: "running" as const, turnId: active[0] }
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
  /** The receipt artifact `artifactId` names anywhere in this Session. */
  publishedArtifact(
    agentId: string,
    sessionKey: string,
    artifactId: string
  ): Promise<
    { path: string; descriptor: OpenClawArtifactDescriptor } | undefined
  >
  /** The MCP App view this Session's own `toolCallId` result opened. */
  mcpAppViewId(
    agentId: string,
    sessionKey: string,
    toolCallId: string
  ): Promise<string | undefined>
}>

export function createOpenClawHistory(input: {
  client: OpenClawWorkspaceClient
  authority: OpenClawHistoryAuthority
  subscribeSession?: OpenClawHistorySubscription
  mcpToolNames?: OpenClawMcpToolNames
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
      ),
      100
    )
    const matches = rows.filter((row) => row.key === sessionKey)
    if (matches.length !== 1) throw new OpenClawHistoryUnavailableError()
    verifyRowOwnership(agentId, sessionKey, matches[0]!)
    return matches[0]!
  }
  const authoritativeHistory = async (
    agentId: string,
    sessionKey: string,
    limit: number,
    offset: number
  ) => {
    await requireScope(agentId, sessionKey)
    if (!input.subscribeSession) throw new OpenClawHistoryUnavailableError()
    for (let attempt = 0; attempt < 2; attempt++) {
      let dirty = false
      const unsubscribe = await input.subscribeSession(
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
          ),
          limit
        )
        if (!dirty) return native
      } finally {
        unsubscribe()
      }
    }
    throw new OpenClawHistoryUnavailableError()
  }
  /** The first match `find` reports, reading this Session's history a page at a time. */
  const scanHistory = async <T>(
    agentId: string,
    sessionKey: string,
    find: (rows: readonly unknown[]) => T | undefined
  ) => {
    for (let offset = 0; offset < HISTORY_SCAN_MAX_ROWS;) {
      const page = await authoritativeHistory(
        agentId,
        sessionKey,
        HISTORY_DEFAULT_PAGE,
        offset
      )
      const found = find(page.messages)
      if (found !== undefined) return found
      if (page.messages.length < HISTORY_DEFAULT_PAGE) return undefined
      offset += page.messages.length
    }
    return undefined
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
      const native = await authoritativeHistory(
        agentId,
        sessionKey,
        limit,
        offset
      )
      const unresolved = unresolvedToolNames(native.messages)
      if (unresolved.length > 0)
        await input.mcpToolNames?.load(agentId, sessionKey, unresolved)
      const messages = projectMessages(
        native.messages,
        input.mcpToolNames?.resolver(agentId, sessionKey) ?? (() => undefined)
      )
      const rawCount = native.messages.length
      return {
        sessionId: sessionKey,
        messages,
        total: offset + rawCount + (rawCount === limit ? 1 : 0),
        limit,
        offset,
        nextOffset: offset + rawCount,
        execution: execution(native),
      }
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
    publishedArtifact: (agentId, sessionKey, artifactId) =>
      scanHistory(agentId, sessionKey, (rows) =>
        publishedReceipt(rows, artifactId)
      ),
    mcpAppViewId: (agentId, sessionKey, toolCallId) =>
      scanHistory(agentId, sessionKey, (rows) =>
        storedMcpAppView(rows, toolCallId)
      ),
    async activity(agentId, sessionKey) {
      const history = await authoritativeHistory(agentId, sessionKey, 1, 0)
      return {
        state: execution(history).status === "running" ? "running" : "idle",
      }
    },
  }
}
