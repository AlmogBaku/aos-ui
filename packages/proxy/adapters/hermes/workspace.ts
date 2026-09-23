import type {
  SessionModelUpdateRequest,
  SessionModelUpdateResponse,
} from "../../../protocol"
import { projectTodos, type Todo } from "../todos"
import { HermesAgentNotFoundError, HermesSessionNotFoundError } from "./adapter"
import { isRecord, parseJson } from "./native"
import {
  nativeModelName,
  nativeProviderSlug,
  projectSessionModel,
} from "./session-model"
import { HERMES_TODO_STATUS_ALIASES } from "./todos"
import { toolCallSelections } from "./tool-data"

type NativeRecord = Record<string, unknown>

export type HermesWorkspaceSession = {
  agentId: string
  sessionId: string
  /** Server-only Hermes identifier for an already attached Session. */
  liveSessionId: string
  attached: boolean
  active: boolean
  /** The latest trusted `session.info`/`session.usage` payload, if observed. */
  usage?: unknown
}

export interface HermesWorkspaceAuthority {
  requireSession(
    agentId: string,
    sessionId: string
  ): Promise<HermesWorkspaceSession>
}

export interface HermesWorkspaceTransport {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  /** Server-side, ownership-scoped durable history read. */
  history?(scope: HermesWorkspaceSession): Promise<readonly unknown[]>
  /** A server-side current Session-info reader when the connection retains one. */
  sessionInfo?(scope: HermesWorkspaceSession): Promise<unknown>
  /**
   * Writes a Session-info change this server just applied back into the
   * retained record, so a read taken before Hermes pushes its own
   * `session.info` still reports the state the write settled on.
   */
  recordSessionInfo?(
    scope: HermesWorkspaceSession,
    patch: Readonly<Record<string, unknown>>
  ): void
}

export class HermesWorkspaceScopeError extends Error {
  constructor() {
    super("Session is not available in this Agent scope")
    this.name = "HermesWorkspaceScopeError"
  }
}

export class HermesWorkspaceUnavailableError extends Error {
  constructor() {
    super("Hermes workspace operation is temporarily unavailable")
    this.name = "HermesWorkspaceUnavailableError"
  }
}

export type HermesWorkspaceCapabilities = {
  models: {
    status: "available"
    scope: "attached-session"
    selection: "native-session"
    choices: "provider-reported"
  }
  context: {
    status: "available"
    scope: "attached-session"
    source: "provider-usage-or-estimate"
    breakdown: "provider-categories"
  }
  todos:
    | {
        status: "available"
        scope: "session"
        mode: "read-only-projection"
        source: "latest-completed-todo-tool-result"
      }
    | { status: "unavailable"; reason: "history-unavailable" }
  activity:
    | {
        status: "available"
        scope: "attached-active-session"
        coverage: "active-session-only"
        source: "provider-session-state"
      }
    | { status: "unavailable"; reason: "session-state-unavailable" }
}

/** Hermes' native reasoning-effort ladder, weakest to strongest. */
const HERMES_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const
/** Hermes' native value for a model whose reasoning can be turned off. */
const HERMES_REASONING_DISABLED = "none"

export type HermesModelChoice = {
  id: string
  label: string
  group: string
  efforts?: readonly { id: string }[]
}

export type HermesModelChoices = {
  selectedId: string
  effortId?: string
  options: HermesModelChoice[]
}

export type HermesContext = {
  usedTokens: number
  maxTokens: number
  estimated?: true
  source: "provider-usage" | "provider-usage-plus-estimate" | "local-estimate"
  breakdown?: {
    systemTokens: number
    toolTokens: number
    messageTokens: number
  }
}

export type HermesActivity =
  | {
      status: "unavailable"
      reason:
        "session-not-attached" | "session-idle" | "session-state-unavailable"
    }
  | {
      status: "available"
      scope: "attached-active-session"
      coverage: "active-session-only"
      state: "running" | "waiting-for-input" | "idle" | "unknown"
    }

type HermesActivityState = "running" | "waiting-for-input" | "idle" | "unknown"

function stringValue(value: unknown, max = 4_096) {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined
}

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

const systemCategories = new Set(["system_prompt", "rules", "skills", "memory"])
const toolCategories = new Set([
  "tool_definitions",
  "mcp",
  "subagent_definitions",
])

function projectBreakdown(value: unknown): HermesContext["breakdown"] {
  if (!Array.isArray(value)) return undefined
  let systemTokens = 0
  let toolTokens = 0
  let messageTokens = 0
  let recognized = false
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const id = stringValue(raw.id, 256)
    const tokens = tokenCount(raw.tokens)
    if (!id || tokens === undefined) continue
    if (systemCategories.has(id)) systemTokens += tokens
    else if (toolCategories.has(id)) toolTokens += tokens
    else if (id === "conversation") messageTokens += tokens
    else continue
    recognized = true
  }
  return recognized ? { systemTokens, toolTokens, messageTokens } : undefined
}

function projectContext(value: unknown): HermesContext | undefined {
  if (!isRecord(value)) return undefined
  const source = value.context_source
  const estimated = value.context_estimated
  if (
    (source !== "provider_usage" &&
      source !== "provider_usage_plus_estimate" &&
      source !== "local_estimate") ||
    typeof estimated !== "boolean" ||
    (source === "provider_usage" ? estimated : !estimated)
  )
    return undefined
  const usedTokens = tokenCount(value.context_used)
  const maxTokens = tokenCount(value.context_max)
  if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
    return undefined
  return {
    usedTokens,
    maxTokens,
    ...(estimated ? { estimated: true as const } : {}),
    source: source.replaceAll("_", "-") as HermesContext["source"],
    ...(projectBreakdown(value.categories)
      ? { breakdown: projectBreakdown(value.categories) }
      : {}),
  }
}

type NativeModel = HermesModelChoice & { provider: string; model: string }

/**
 * Hermes reports reasoning support per model but never sends the ladder, so an
 * unknown model reports no efforts rather than an assumed ladder. Nor does it
 * name a level, so each effort is its id alone.
 */
function projectEfforts(capability: unknown) {
  if (!isRecord(capability) || capability.reasoning !== true) return undefined
  return [
    ...(capability.can_disable_reasoning === true
      ? [HERMES_REASONING_DISABLED]
      : []),
    ...HERMES_REASONING_EFFORTS,
  ].map((id) => ({ id }))
}

function projectEffortId(value: unknown) {
  const effort = stringValue(value, 64)
  if (!effort) return undefined
  return effort === HERMES_REASONING_DISABLED ||
    (HERMES_REASONING_EFFORTS as readonly string[]).includes(effort)
    ? effort
    : undefined
}

/**
 * Reads back the `[provider, model]` pair this module mints as a model id. A
 * write that splits the id itself never pays for Hermes' catalog handler, and
 * the pair is held to the same shape the catalog projection accepts.
 */
function parseModelId(selectedId: string) {
  const parsed = parseJson(selectedId)
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const provider = nativeProviderSlug(parsed[0])
  const model = nativeModelName(parsed[1])
  return provider && model ? { provider, model } : undefined
}

function projectModels(
  value: unknown,
  /** Overrides the catalog's own idea of the current model, when reported. */
  current?: { provider: string; model: string } | undefined
): HermesModelChoices & { native: NativeModel[] } {
  if (!isRecord(value) || !Array.isArray(value.providers))
    throw new HermesWorkspaceUnavailableError()
  const native: NativeModel[] = []
  for (const row of value.providers) {
    if (
      !isRecord(row) ||
      !Array.isArray(row.models) ||
      row.authenticated === false
    )
      continue
    const provider = nativeProviderSlug(row.slug)
    if (!provider) continue
    const group = stringValue(row.name, 256) ?? provider
    const capabilities = isRecord(row.capabilities)
      ? row.capabilities
      : undefined
    for (const rawModel of row.models) {
      const model = nativeModelName(rawModel)
      if (!model) continue
      const id = JSON.stringify([provider, model])
      if (native.some((choice) => choice.id === id)) continue
      const efforts = capabilities
        ? projectEfforts(capabilities[model])
        : undefined
      native.push({
        id,
        label: model,
        group,
        ...(efforts ? { efforts } : {}),
        provider,
        model,
      })
    }
  }
  const catalogProvider = stringValue(value.provider, 256)
  const catalogModel = stringValue(value.model, 256)
  if (!catalogProvider || !catalogModel)
    throw new HermesWorkspaceUnavailableError()
  const selectedProvider = current?.provider ?? catalogProvider
  const selectedModel = current?.model ?? catalogModel
  const selectedId = JSON.stringify([selectedProvider, selectedModel])
  // The selected model must be one of the offered options. A picker holding a
  // value no item carries renders an empty selection, so publish the Session's
  // own model as a choice even when Hermes leaves it out of the catalog it
  // advertises. An unlisted model reports no capabilities, so it gets no
  // efforts: unknown is not the same as supported.
  if (!native.some((choice) => choice.id === selectedId))
    native.unshift({
      id: selectedId,
      label: selectedModel,
      group: selectedProvider,
      provider: selectedProvider,
      model: selectedModel,
    })
  return {
    selectedId,
    options: native.map(({ id, label, group, efforts }) => ({
      id,
      label,
      group,
      ...(efforts ? { efforts } : {}),
    })),
    native,
  }
}

function nativeFunction(value: unknown) {
  if (!isRecord(value)) return undefined
  return isRecord(value.function) ? value.function : undefined
}

/**
 * Every name that legitimately identifies the result row of each durable tool
 * call. Hermes invokes a tool either by name or through its `tool_call` batch
 * envelope, and a batched result row names the tool the envelope selected
 * rather than the envelope itself, so both names stand for the same call.
 */
function toolCallNames(rows: readonly unknown[]) {
  const calls = new Map<string, Set<string>>()
  for (const row of rows) {
    if (
      !isRecord(row) ||
      row.role !== "assistant" ||
      !Array.isArray(row.tool_calls)
    )
      continue
    for (const call of row.tool_calls) {
      const invoked = nativeFunction(call)
      const id = isRecord(call) ? stringValue(call.id, 256) : undefined
      const name = stringValue(invoked?.name, 256)
      if (!id || !name) continue
      const selected = toolCallSelections(name, invoked?.arguments)
      calls.set(id, new Set([name, ...selected.map((tool) => tool.name)]))
    }
  }
  return calls
}

function recognizedTodoTool(name: string) {
  return (
    name === "todo" ||
    name === "todos" ||
    name === "todo_write" ||
    name === "todo_list"
  )
}

function completedToolRow(row: NativeRecord) {
  return (
    row.status === undefined ||
    row.status === "complete" ||
    row.status === "completed" ||
    row.status === "success"
  )
}

export function latestHermesTodos(
  rows: readonly unknown[]
): Todo[] | undefined {
  const calls = toolCallNames(rows)
  let latest: Todo[] | undefined
  for (const row of rows) {
    if (
      !isRecord(row) ||
      row.role !== "tool" ||
      row.is_error === true ||
      !completedToolRow(row)
    )
      continue
    const callId = stringValue(row.tool_call_id ?? row.toolCallId, 256)
    const names = callId ? calls.get(callId) : undefined
    const resultName = stringValue(row.tool_name ?? row.toolName, 256)
    if (
      !names ||
      ![...names].some(recognizedTodoTool) ||
      (resultName !== undefined && !names.has(resultName))
    )
      continue
    const todos = projectTodos(
      row.content ?? row.result,
      HERMES_TODO_STATUS_ALIASES
    )
    // A batched call may settle a Todo tool beside another one, and a row that
    // carries no Todo list at all leaves the plan the last one published
    // standing rather than emptying it.
    if (todos) latest = todos
  }
  return latest
}

function activityState(value: unknown): HermesActivityState {
  if (!isRecord(value)) return "unknown"
  if (value.running === true) return "running"
  if (value.running === false) return "idle"
  if (value.status === "waiting") return "waiting-for-input"
  if (value.status === "working" || value.status === "starting")
    return "running"
  if (value.status === "idle") return "idle"
  return "unknown"
}

export type HermesWorkspaceOperations = {
  capabilities(): HermesWorkspaceCapabilities
  models(agentId: string, sessionId: string): Promise<HermesModelChoices>
  updateModel(
    agentId: string,
    sessionId: string,
    patch: SessionModelUpdateRequest
  ): Promise<SessionModelUpdateResponse>
  context(agentId: string, sessionId: string): Promise<HermesContext>
  todos(agentId: string, sessionId: string): Promise<Todo[]>
  activity(agentId: string, sessionId: string): Promise<HermesActivity>
}

export function createHermesWorkspaceOperations(input: {
  authority: HermesWorkspaceAuthority
  transport: HermesWorkspaceTransport
}): HermesWorkspaceOperations {
  const requireScope = async (agentId: string, sessionId: string) => {
    let scope: HermesWorkspaceSession
    try {
      scope = await input.authority.requireSession(agentId, sessionId)
    } catch (cause) {
      // Only the authority's own verdict that the Agent or the Session does not
      // exist is a scope failure. Every other cause — a refused transport, an
      // attach that did not settle — is an outage, and reporting it as "not
      // found" would tell the browser to stop asking for a Session that is
      // merely unreachable.
      throw cause instanceof HermesAgentNotFoundError ||
        cause instanceof HermesSessionNotFoundError
        ? new HermesWorkspaceScopeError()
        : new HermesWorkspaceUnavailableError()
    }
    if (
      scope.agentId !== agentId ||
      scope.sessionId !== sessionId ||
      !stringValue(scope.liveSessionId, 4_096) ||
      typeof scope.attached !== "boolean" ||
      typeof scope.active !== "boolean"
    )
      throw new HermesWorkspaceScopeError()
    return scope
  }
  const request = async (
    method: string,
    params: Readonly<Record<string, unknown>>
  ) => {
    try {
      return await input.transport.request(method, params)
    } catch {
      throw new HermesWorkspaceUnavailableError()
    }
  }
  const models = async (
    agentId: string,
    sessionId: string
  ): Promise<HermesModelChoices> => {
    const session = await requireScope(agentId, sessionId)
    if (!session.attached) throw new HermesWorkspaceUnavailableError()
    const value = await request("model.options", {
      session_id: session.liveSessionId,
      profile: session.agentId,
    })
    const info = await input.transport
      .sessionInfo?.(session)
      .catch(() => undefined)
    // The Session's own model leads the catalog's: a client that trusted the
    // catalog would show a pick stashed mid-turn settling back to the model the
    // Session is leaving, and would keep doing so until that turn ended.
    const projected = projectModels(value, projectSessionModel(info))
    const effortId = isRecord(info)
      ? projectEffortId(info.reasoning_effort)
      : undefined
    return {
      selectedId: projected.selectedId,
      ...(effortId ? { effortId } : {}),
      options: projected.options,
    }
  }

  return {
    capabilities() {
      return {
        models: {
          status: "available",
          scope: "attached-session",
          selection: "native-session",
          choices: "provider-reported",
        },
        context: {
          status: "available",
          scope: "attached-session",
          source: "provider-usage-or-estimate",
          breakdown: "provider-categories",
        },
        todos: input.transport.history
          ? {
              status: "available",
              scope: "session",
              mode: "read-only-projection",
              source: "latest-completed-todo-tool-result",
            }
          : { status: "unavailable", reason: "history-unavailable" },
        activity: input.transport.sessionInfo
          ? {
              status: "available",
              scope: "attached-active-session",
              coverage: "active-session-only",
              source: "provider-session-state",
            }
          : { status: "unavailable", reason: "session-state-unavailable" },
      }
    },
    models,
    async updateModel(agentId, sessionId, patch) {
      const session = await requireScope(agentId, sessionId)
      if (!session.attached) throw new HermesWorkspaceUnavailableError()
      // Both halves are validated before either is written: the id is the pair
      // this module minted, so splitting it here keeps a write off Hermes'
      // catalog handler, and the ladder is Hermes' own constant one.
      const requested =
        patch.selectedId === undefined
          ? undefined
          : parseModelId(patch.selectedId)
      if (patch.selectedId !== undefined && !requested)
        throw new HermesWorkspaceUnavailableError()
      const effortId =
        patch.effortId === undefined
          ? undefined
          : projectEffortId(patch.effortId)
      if (patch.effortId !== undefined && !effortId)
        throw new HermesWorkspaceUnavailableError()

      let applied: { provider: string; model: string } | undefined
      if (requested) {
        const apply = (confirmed: boolean) =>
          request("config.set", {
            session_id: session.liveSessionId,
            key: "model",
            value: `${requested.model} --provider ${requested.provider} --session`,
            ...(confirmed ? { confirm_expensive_model: true } : {}),
          })
        let answer = await apply(false)
        // Hermes guards some picks — priced models, data-training tiers, leaving
        // a large cached context — with a confirm round-trip written for its own
        // interactive surfaces, and switches nothing until it is answered.
        // Choosing the model from the offered catalog is that answer here, so
        // the request repeats as confirmed instead of reporting a failed switch.
        if (isRecord(answer) && answer.confirm_required === true)
          answer = await apply(true)
        if (
          !isRecord(answer) ||
          answer.key !== "model" ||
          answer.scope !== "session" ||
          answer.confirm_required === true
        )
          throw new HermesWorkspaceUnavailableError()
        // Hermes resolves a pick to its own canonical model name, which need not
        // be the label that was chosen; its answer is authoritative. A pick made
        // mid-turn is answered as deferred and names the model Hermes stashed
        // for the next turn, which is the model the Session is on from here.
        const model = stringValue(answer.value, 256)
        if (!model) throw new HermesWorkspaceUnavailableError()
        applied = { provider: requested.provider, model }
        input.transport.recordSessionInfo?.(session, applied)
      }
      if (effortId) {
        // Hermes scopes the `reasoning` key to the given Session by default.
        const answer = await request("config.set", {
          session_id: session.liveSessionId,
          key: "reasoning",
          value: effortId,
        })
        if (
          !isRecord(answer) ||
          answer.key !== "reasoning" ||
          answer.value !== effortId
        )
          throw new HermesWorkspaceUnavailableError()
        input.transport.recordSessionInfo?.(session, {
          reasoning_effort: effortId,
        })
      }
      // Each write's own answer is the authority for the half it applied: a
      // `session.info` push for an unrelated event can land between the two
      // writes still carrying the model the Session is leaving, so a re-read
      // here would report the very state this write replaced. Only the half the
      // patch left alone comes from the retained record, which the
      // write-throughs above keep current until Hermes pushes its own.
      const info = await input.transport
        .sessionInfo?.(session)
        .catch(() => undefined)
      const current = applied ?? projectSessionModel(info)
      const currentEffort =
        effortId ??
        projectEffortId(isRecord(info) ? info.reasoning_effort : undefined)
      return {
        // An effort-only write still reports the pair, so a Session whose info
        // names no model reads the catalog rather than failing a write Hermes
        // has already accepted.
        selectedId: current
          ? JSON.stringify([current.provider, current.model])
          : (await models(agentId, sessionId)).selectedId,
        ...(currentEffort ? { effortId: currentEffort } : {}),
      }
    },
    async context(agentId, sessionId) {
      const session = await requireScope(agentId, sessionId)
      if (!session.attached) throw new HermesWorkspaceUnavailableError()
      const observed = projectContext(session.usage)
      if (observed) return observed
      const context = projectContext(
        await request("session.context_breakdown", {
          session_id: session.liveSessionId,
        })
      )
      if (!context) throw new HermesWorkspaceUnavailableError()
      return context
    },
    async todos(agentId, sessionId) {
      const session = await requireScope(agentId, sessionId)
      if (!input.transport.history) throw new HermesWorkspaceUnavailableError()
      let rows: readonly unknown[]
      try {
        rows = await input.transport.history(session)
      } catch {
        throw new HermesWorkspaceUnavailableError()
      }
      return latestHermesTodos(rows) ?? []
    },
    async activity(agentId, sessionId) {
      const session = await requireScope(agentId, sessionId)
      if (!session.attached)
        return { status: "unavailable", reason: "session-not-attached" }
      if (!session.active)
        return {
          status: "available",
          scope: "attached-active-session",
          coverage: "active-session-only",
          state: "idle",
        }
      if (!input.transport.sessionInfo)
        return { status: "unavailable", reason: "session-state-unavailable" }
      const info = await input.transport.sessionInfo(session).catch(() => {
        throw new HermesWorkspaceUnavailableError()
      })
      return {
        status: "available",
        scope: "attached-active-session",
        coverage: "active-session-only",
        state: activityState(info),
      }
    },
  }
}
