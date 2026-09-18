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
        source: "session.info"
      }
    | { status: "unavailable"; reason: "session-info-unavailable" }
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
  efforts?: readonly string[]
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

export type HermesTodo = {
  id: string
  label: string
  status: "pending" | "active" | "completed" | "failed"
}

export type HermesActivity =
  | {
      status: "unavailable"
      reason:
        "session-not-attached" | "session-idle" | "session-info-unavailable"
    }
  | {
      status: "available"
      scope: "attached-active-session"
      coverage: "active-session-only"
      state: "running" | "waiting-for-input" | "idle" | "unknown"
    }

type HermesActivityState = "running" | "waiting-for-input" | "idle" | "unknown"

function isRecord(value: unknown): value is NativeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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

function parseJson(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
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
 * unknown model reports no efforts rather than an assumed ladder.
 */
function projectEfforts(capability: unknown) {
  if (!isRecord(capability) || capability.reasoning !== true) return undefined
  return [
    ...(capability.can_disable_reasoning === true
      ? [HERMES_REASONING_DISABLED]
      : []),
    ...HERMES_REASONING_EFFORTS,
  ]
}

function projectEffortId(value: unknown) {
  const effort = stringValue(value, 64)
  if (!effort) return undefined
  return effort === HERMES_REASONING_DISABLED ||
    (HERMES_REASONING_EFFORTS as readonly string[]).includes(effort)
    ? effort
    : undefined
}

function projectModels(
  value: unknown
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
    const provider = stringValue(row.slug, 256)
    if (!provider || !/^[\w.-]+$/u.test(provider)) continue
    const group = stringValue(row.name, 256) ?? provider
    const capabilities = isRecord(row.capabilities)
      ? row.capabilities
      : undefined
    for (const rawModel of row.models) {
      const model = stringValue(rawModel, 256)
      if (!model || /\s|^[-\u2012-\u2015]/u.test(model)) continue
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
  const selectedProvider = stringValue(value.provider, 256)
  const selectedModel = stringValue(value.model, 256)
  if (!selectedProvider || !selectedModel)
    throw new HermesWorkspaceUnavailableError()
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

function nativeToolName(value: unknown) {
  if (!isRecord(value)) return undefined
  const functionValue = isRecord(value.function) ? value.function : undefined
  return stringValue(functionValue?.name, 256)
}

function todoCallIds(rows: readonly unknown[]) {
  const calls = new Map<string, string>()
  for (const row of rows) {
    if (
      !isRecord(row) ||
      row.role !== "assistant" ||
      !Array.isArray(row.tool_calls)
    )
      continue
    for (const call of row.tool_calls) {
      if (!isRecord(call)) continue
      const id = stringValue(call.id, 256)
      const name = nativeToolName(call)
      if (id && name) calls.set(id, name)
    }
  }
  return calls
}

function recognizedTodoTool(name: string | undefined) {
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

export function projectHermesTodos(value: unknown): HermesTodo[] | undefined {
  const payload = parseJson(value)
  if (!isRecord(payload) || !Array.isArray(payload.todos)) return undefined
  const seen = new Set<string>()
  return payload.todos.flatMap((raw, index) => {
    if (!isRecord(raw)) return []
    const id = stringValue(raw.id, 256) ?? String(index)
    const label = stringValue(raw.label ?? raw.content, 4_096)
    if (!label || seen.has(id)) return []
    seen.add(id)
    const rawStatus = stringValue(raw.status, 64)
    const status =
      rawStatus === "active" ||
      rawStatus === "completed" ||
      rawStatus === "failed" ||
      rawStatus === "pending"
        ? rawStatus
        : "pending"
    return [{ id, label, status }]
  })
}

export function latestHermesTodos(
  rows: readonly unknown[]
): HermesTodo[] | undefined {
  const calls = todoCallIds(rows)
  let latest: HermesTodo[] | undefined
  for (const row of rows) {
    if (
      !isRecord(row) ||
      row.role !== "tool" ||
      row.is_error === true ||
      !completedToolRow(row)
    )
      continue
    const callId = stringValue(row.tool_call_id ?? row.toolCallId, 256)
    const invokedName = callId ? calls.get(callId) : undefined
    const resultName = stringValue(row.tool_name ?? row.toolName, 256)
    if (
      !callId ||
      !recognizedTodoTool(invokedName) ||
      (resultName !== undefined && resultName !== invokedName)
    )
      continue
    latest = projectHermesTodos(row.content ?? row.result)
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
  selectModel(
    agentId: string,
    sessionId: string,
    selectedId: string
  ): Promise<{ selectedId: string }>
  selectEffort(
    agentId: string,
    sessionId: string,
    effortId: string
  ): Promise<{ effortId: string }>
  context(agentId: string, sessionId: string): Promise<HermesContext>
  todos(agentId: string, sessionId: string): Promise<HermesTodo[]>
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
    } catch {
      throw new HermesWorkspaceScopeError()
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
    const projected = projectModels(value)
    const info = await input.transport
      .sessionInfo?.(session)
      .catch(() => undefined)
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
              source: "session.info",
            }
          : { status: "unavailable", reason: "session-info-unavailable" },
      }
    },
    models,
    async selectModel(agentId, sessionId, selectedId) {
      const session = await requireScope(agentId, sessionId)
      if (!session.attached) throw new HermesWorkspaceUnavailableError()
      const catalog = await request("model.options", {
        session_id: session.liveSessionId,
        profile: session.agentId,
      })
      const selected = projectModels(catalog).native.find(
        (option) => option.id === selectedId
      )
      if (!selected) throw new HermesWorkspaceUnavailableError()
      const apply = (confirmed: boolean) =>
        request("config.set", {
          session_id: session.liveSessionId,
          key: "model",
          value: `${selected.model} --provider ${selected.provider} --session`,
          ...(confirmed ? { confirm_expensive_model: true } : {}),
        })
      let applied = await apply(false)
      // Hermes guards some picks — priced models, data-training tiers, leaving a
      // large cached context — with a confirm round-trip written for its own
      // interactive surfaces, and switches nothing until it is answered.
      // Choosing the model from the offered catalog is that answer here, so the
      // request repeats as confirmed instead of reporting a failed switch.
      if (isRecord(applied) && applied.confirm_required === true)
        applied = await apply(true)
      if (
        !isRecord(applied) ||
        applied.key !== "model" ||
        applied.scope !== "session" ||
        applied.confirm_required === true
      )
        throw new HermesWorkspaceUnavailableError()
      // Hermes resolves a pick to its own canonical model name, which need not
      // be the catalog label that was chosen; its answer is authoritative.
      const value = stringValue(applied.value, 256)
      if (!value) throw new HermesWorkspaceUnavailableError()
      return { selectedId: JSON.stringify([selected.provider, value]) }
    },
    async selectEffort(agentId, sessionId, effortId) {
      const session = await requireScope(agentId, sessionId)
      if (!session.attached) throw new HermesWorkspaceUnavailableError()
      const catalog = projectModels(
        await request("model.options", {
          session_id: session.liveSessionId,
          profile: session.agentId,
        })
      )
      const selected = catalog.native.find(
        (option) => option.id === catalog.selectedId
      )
      if (!selected?.efforts?.includes(effortId))
        throw new HermesWorkspaceUnavailableError()
      // Hermes scopes the `reasoning` key to the given Session by default.
      const confirmation = await request("config.set", {
        session_id: session.liveSessionId,
        key: "reasoning",
        value: effortId,
      })
      if (
        !isRecord(confirmation) ||
        confirmation.key !== "reasoning" ||
        confirmation.value !== effortId
      )
        throw new HermesWorkspaceUnavailableError()
      return { effortId }
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
        return { status: "unavailable", reason: "session-info-unavailable" }
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
