import {
  SessionConfigOption,
  SessionUpdate,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type Usage,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import type { SlashCommand } from "@aos/protocol"
import {
  AosStateMetaSchema,
  AosUsageMetaSchema,
  type AosCost,
  type AosSessionResumeResponseMetaSchema,
} from "@aos/protocol/acp"

import type {
  ComposerModelCurrent,
  ComposerModelFeed,
  ComposerTurnUsage,
} from "@/components/assistant-ui/composer-features"

import type {
  AosContext,
  AosModelChoices,
  AosWorkspaceCapabilities,
} from "../aos-client"
import type { AcpConnection } from "./types"

/**
 * The composer's provider-authoritative Session projection over ACP config
 * options, usage, and commands. ACP config options describe the Session's
 * current configuration, so reasoning efforts belong to the model the Session
 * runs: the proxy re-sends the config options after every model change, which
 * is the only moment the effort list can change.
 */

/** `SessionConfigOption.category` of the two options the composer drives. */
const MODEL_CATEGORY = "model"
const EFFORT_CATEGORY = "thought_level"

type AcpCapabilities = z.infer<
  typeof AosSessionResumeResponseMetaSchema
>["capabilities"]

type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>

function selectOf(option: SessionConfigOption, category: string) {
  return SessionConfigOption.isSelect(option) && option.category === category
    ? option
    : undefined
}

type SelectConfigOption = NonNullable<ReturnType<typeof selectOf>>

export type AcpModelProjection = {
  models?: AosModelChoices
  modelConfigId?: string
  effortConfigId?: string
}

/** What the Session's settled turns spent, read from their `idle` updates. */
export type AcpTurnUsage = {
  readonly lastTurn?: ComposerTurnUsage
  readonly cost?: AosCost
}

type SessionEntry = {
  capabilities: AcpCapabilities
  projection: AcpModelProjection
  /** The model the projection names, the same reference until it changes. */
  current?: ComposerModelCurrent
  context?: AosContext
  turns?: AcpTurnUsage
  commands?: SlashCommand[]
}

function firstSelect(
  options: readonly SessionConfigOption[],
  category: string
) {
  for (const option of options) {
    const select = selectOf(option, category)
    if (select) return select
  }
  return undefined
}

/** `options` is either a flat list or groups; groups name their own models. */
function entriesOf(
  option: SelectConfigOption
): readonly (SessionConfigSelectOption | SessionConfigSelectGroup)[] {
  return option.options
}

function modelOptionsOf(
  option: SelectConfigOption
): AosModelChoices["options"] {
  return entriesOf(option).flatMap((entry) =>
    "groupId" in entry
      ? entry.options.map((item) => ({
          id: item.value,
          label: item.name,
          group: entry.name,
        }))
      : [{ id: entry.value, label: entry.name, group: option.name }]
  )
}

function valueIdsOf(option: SelectConfigOption) {
  return entriesOf(option).flatMap((entry) =>
    "groupId" in entry ? entry.options.map((item) => item.value) : [entry.value]
  )
}

/** Translates ACP config options back into the composer's model projection. */
export function projectModels(
  options: readonly SessionConfigOption[]
): AcpModelProjection {
  const model = firstSelect(options, MODEL_CATEGORY)
  if (!model) return {}
  const effort = firstSelect(options, EFFORT_CATEGORY)
  const efforts = effort ? valueIdsOf(effort) : []
  return {
    models: {
      selectedId: model.currentValue,
      ...(effort ? { effortId: effort.currentValue } : {}),
      options: modelOptionsOf(model).map((option) =>
        option.id === model.currentValue && efforts.length
          ? { ...option, efforts }
          : option
      ),
    },
    modelConfigId: model.configId,
    ...(effort ? { effortConfigId: effort.configId } : {}),
  }
}

/**
 * Translates one `usage_update` into the composer's context projection. ACP's
 * own fields carry the two counts; `_meta.aos` carries what the provider
 * attributed them to and how it arrived at them, and a meta this build cannot
 * read degrades to the counts alone rather than to nothing.
 */
function projectContext(
  update: UsageUpdate,
  meta: unknown
): AosContext | undefined {
  if (update.size <= 0) return undefined
  const aos = AosUsageMetaSchema.safeParse(meta)
  return {
    usedTokens: update.used,
    maxTokens: update.size,
    source: aos.success ? aos.data.source : "provider-usage",
    ...(aos.success && aos.data.estimated
      ? { estimated: aos.data.estimated }
      : {}),
    ...(aos.success && aos.data.breakdown
      ? { breakdown: aos.data.breakdown }
      : {}),
  }
}

/** The model a projection names; an equal one keeps the previous reference. */
function currentOf(
  projection: AcpModelProjection,
  previous: ComposerModelCurrent | undefined
): ComposerModelCurrent | undefined {
  const models = projection.models
  if (!models) return undefined
  if (
    previous?.selectedId === models.selectedId &&
    previous.effortId === models.effortId
  )
    return previous
  return {
    selectedId: models.selectedId,
    ...(models.effortId === undefined ? {} : { effortId: models.effortId }),
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && value >= 0

/** The three counts ACP requires; a usage without them reports nothing. */
const isUsage = (value: unknown): value is Usage =>
  typeof value === "object" &&
  value !== null &&
  "inputTokens" in value &&
  "outputTokens" in value &&
  "totalTokens" in value &&
  isCount(value.inputTokens) &&
  isCount(value.outputTokens) &&
  isCount(value.totalTokens)

function turnUsageOf({
  inputTokens,
  outputTokens,
  totalTokens,
  thoughtTokens,
  cachedReadTokens,
  cachedWriteTokens,
}: Usage): ComposerTurnUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(isCount(thoughtTokens) ? { thoughtTokens } : {}),
    ...(isCount(cachedReadTokens) ? { cachedReadTokens } : {}),
    ...(isCount(cachedWriteTokens) ? { cachedWriteTokens } : {}),
  }
}

/**
 * Folds one settled turn into the Session's spend: its usage becomes the last
 * turn's, and its cost adds to the total while the currency holds. Amounts in
 * two currencies cannot be summed, so a switch restarts the total there.
 */
export function foldTurnUsage(
  previous: AcpTurnUsage | undefined,
  usage: Usage | undefined,
  cost: AosCost | undefined
): AcpTurnUsage | undefined {
  if (!usage && !cost) return previous
  const total =
    cost && previous?.cost?.currency === cost.currency
      ? { amount: previous.cost.amount + cost.amount, currency: cost.currency }
      : (cost ?? previous?.cost)
  const lastTurn = usage ? turnUsageOf(usage) : previous?.lastTurn
  return {
    ...(lastTurn ? { lastTurn } : {}),
    ...(total ? { cost: total } : {}),
  }
}

/** Slash commands stay part of the capability projection the composer reads. */
function capabilitiesOf(entry: SessionEntry): AosWorkspaceCapabilities {
  if (!entry.commands) return entry.capabilities
  return {
    ...entry.capabilities,
    workspace: {
      ...entry.capabilities.workspace,
      slashCommands: {
        status: "available",
        scope: "attached-session",
        commands: entry.commands,
      },
    },
  }
}

export function createAcpComposerStore(connection: AcpConnection) {
  const sessions = new Map<string, SessionEntry>()
  const observed = new Set<string>()
  /** Updates that land between subscribing and the attach they belong to. */
  const early = new Map<string, [SessionUpdate, unknown][]>()
  const contextListeners = new Map<string, Set<() => void>>()
  const modelListeners = new Map<string, Set<() => void>>()
  const feeds = new Map<string, ComposerModelFeed>()

  function listen(
    registry: Map<string, Set<() => void>>,
    threadId: string,
    listener: () => void
  ) {
    const listeners = registry.get(threadId) ?? new Set()
    listeners.add(listener)
    registry.set(threadId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) registry.delete(threadId)
    }
  }

  function notify(registry: Map<string, Set<() => void>>, threadId: string) {
    for (const listener of registry.get(threadId) ?? []) listener()
  }

  /** Every projection change goes through here, so the feed follows each one. */
  function project(
    known: SessionEntry,
    threadId: string,
    next: AcpModelProjection
  ) {
    known.projection = next
    const current = currentOf(next, known.current)
    if (current === known.current) return
    known.current = current
    notify(modelListeners, threadId)
  }

  function entry(threadId: string) {
    const known = sessions.get(threadId)
    if (!known)
      throw new Error("The Session's workspace projection is unavailable")
    return known
  }

  function accept(threadId: string, update: SessionUpdate, meta: unknown) {
    const known = sessions.get(threadId)
    if (!known) {
      early.get(threadId)?.push([update, meta])
      return
    }
    if (SessionUpdate.isConfigOptionUpdate(update))
      project(known, threadId, projectModels(update.configOptions))
    else if (SessionUpdate.isAvailableCommandsUpdate(update))
      known.commands = update.availableCommands.map(
        ({ name, description }) => ({ name, description })
      )
    else if (SessionUpdate.isUsageUpdate(update)) {
      const context = projectContext(update, meta)
      if (!context) return
      known.context = context
      notify(contextListeners, threadId)
    } else if (SessionUpdate.isStateUpdate(update) && update.state === "idle") {
      const aos = AosStateMetaSchema.safeParse(meta)
      const turns = foldTurnUsage(
        known.turns,
        isUsage(update.usage) ? update.usage : undefined,
        aos.success ? aos.data.cost : undefined
      )
      if (turns === known.turns) return
      known.turns = turns
      notify(contextListeners, threadId)
    }
  }

  /** Records what `session/new` and `session/resume` reported for a Session. */
  function attach(
    threadId: string,
    attached: {
      configOptions: readonly SessionConfigOption[]
      capabilities: AcpCapabilities
    }
  ) {
    const previous = sessions.get(threadId)
    const known: SessionEntry = {
      capabilities: attached.capabilities,
      projection: {},
      ...(previous?.current ? { current: previous.current } : {}),
      ...(previous?.context ? { context: previous.context } : {}),
      ...(previous?.turns ? { turns: previous.turns } : {}),
      ...(previous?.commands ? { commands: previous.commands } : {}),
    }
    sessions.set(threadId, known)
    project(known, threadId, projectModels(attached.configOptions))
    observe(threadId)
    const held = early.get(threadId) ?? []
    early.delete(threadId)
    for (const [update, meta] of held) accept(threadId, update, meta)
  }

  /**
   * Subscribes before the attach that reports the Session, so an update the
   * proxy sends right behind its `session/resume` answer is held, not lost.
   */
  function observe(threadId: string) {
    if (!sessions.has(threadId) && !early.has(threadId)) early.set(threadId, [])
    if (observed.has(threadId)) return
    observed.add(threadId)
    connection.onSessionUpdate(threadId, (update, meta) =>
      accept(threadId, update, meta)
    )
    // A from-start replay restates every settled turn, so the spend it folds
    // starts over rather than counting each turn twice.
    connection.onSessionReplay(threadId, () => {
      const replayed = sessions.get(threadId)
      if (replayed) delete replayed.turns
    })
  }

  /** One feed per Session, so the composer subscribes to a stable value. */
  function modelFeed(threadId: string): ComposerModelFeed {
    const known = feeds.get(threadId)
    if (known) return known
    const feed: ComposerModelFeed = {
      current: () => sessions.get(threadId)?.current,
      subscribe: (listener) => listen(modelListeners, threadId, listener),
    }
    feeds.set(threadId, feed)
    return feed
  }

  function models(threadId: string) {
    const projected = entry(threadId).projection.models
    if (!projected) throw new Error("The Session reports no models")
    return projected
  }

  async function select(
    threadId: string,
    category: typeof MODEL_CATEGORY | typeof EFFORT_CATEGORY,
    valueId: string
  ) {
    const known = entry(threadId)
    const configId =
      (category === MODEL_CATEGORY
        ? known.projection.modelConfigId
        : known.projection.effortConfigId) ?? category
    project(
      known,
      threadId,
      projectModels(
        await connection.setConfigOption(threadId, configId, valueId)
      )
    )
    return models(threadId)
  }

  return {
    observe,
    attach,
    capabilities: (threadId: string) => capabilitiesOf(entry(threadId)),
    models,
    /** The newest reading, or none while the provider has reported none. */
    context: (threadId: string) => sessions.get(threadId)?.context,
    /** The settled turns' spend, notified with the context. */
    turnUsage: (threadId: string) => sessions.get(threadId)?.turns,
    subscribeContext: (threadId: string, listener: () => void) =>
      listen(contextListeners, threadId, listener),
    modelFeed,
    selectModel: (threadId: string, selectedId: string) =>
      select(threadId, MODEL_CATEGORY, selectedId),
    selectEffort: (threadId: string, effortId: string) =>
      select(threadId, EFFORT_CATEGORY, effortId),
  }
}
