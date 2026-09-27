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
  AosAvailableCommandsMetaSchema,
  AosStateMetaSchema,
  AosUsageMetaSchema,
  type AosCost,
} from "@aos/protocol/acp"

import type {
  ComposerModelCurrent,
  ComposerModelFeed,
  ComposerTurnUsage,
} from "@/runtime-adapters/contracts"

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
  typeof AosAvailableCommandsMetaSchema
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
  /** What the Session reports it supports, with its commands folded in. */
  capabilities?: AosWorkspaceCapabilities
  reported?: AcpCapabilities
  commands?: SlashCommand[]
  projection: AcpModelProjection
  /** The model the projection names, the same reference until it changes. */
  current?: ComposerModelCurrent
  context?: AosContext
  turns?: AcpTurnUsage
  /** Rises with every config option write, so only the newest one projects. */
  writes: number
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

/** Each effort with the name its provider gave it. */
function effortsOf(option: SelectConfigOption) {
  return entriesOf(option).flatMap((entry) =>
    ("groupId" in entry ? entry.options : [entry]).map((item) => ({
      id: item.value,
      name: item.name,
    }))
  )
}

/** Translates ACP config options back into the composer's model projection. */
export function projectModels(
  options: readonly SessionConfigOption[]
): AcpModelProjection {
  const model = firstSelect(options, MODEL_CATEGORY)
  if (!model) return {}
  const effort = firstSelect(options, EFFORT_CATEGORY)
  const efforts = effort ? effortsOf(effort) : []
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
function capabilitiesOf(
  capabilities: AcpCapabilities,
  commands: SlashCommand[] | undefined
): AosWorkspaceCapabilities {
  if (!commands) return capabilities
  return {
    ...capabilities,
    workspace: {
      ...capabilities.workspace,
      slashCommands: { status: "available", scope: "session", commands },
    },
  }
}

/**
 * Folds what each subscribed Session reports into the composer's projection.
 * A Session's entry starts with the first update it sends and goes when the
 * last hold on it is released; the reads are synchronous, so a surface shows
 * whatever the Session has reported so far.
 */
export function createAcpComposerStore(connection: AcpConnection) {
  const sessions = new Map<string, SessionEntry>()
  /** Told of every change to a Session's capabilities, models, or usage. */
  const listeners = new Map<string, Set<() => void>>()
  /** Told only when the model the Session runs changes. */
  const modelListeners = new Map<string, Set<() => void>>()
  const feeds = new Map<string, ComposerModelFeed>()

  function listen(
    registry: Map<string, Set<() => void>>,
    sessionId: string,
    listener: () => void
  ) {
    const registered = registry.get(sessionId) ?? new Set()
    registered.add(listener)
    registry.set(sessionId, registered)
    return () => {
      registered.delete(listener)
      if (!registered.size) registry.delete(sessionId)
    }
  }

  function notify(registry: Map<string, Set<() => void>>, sessionId: string) {
    for (const listener of registry.get(sessionId) ?? []) listener()
  }

  /** Every projection change goes through here, so the feed follows each one. */
  function project(
    known: SessionEntry,
    sessionId: string,
    next: AcpModelProjection
  ) {
    known.projection = next
    notify(listeners, sessionId)
    const current = currentOf(next, known.current)
    if (current === known.current) return
    known.current = current
    notify(modelListeners, sessionId)
  }

  function accept(sessionId: string, update: SessionUpdate, meta: unknown) {
    const known = sessions.get(sessionId) ?? { projection: {}, writes: 0 }
    sessions.set(sessionId, known)
    if (SessionUpdate.isConfigOptionUpdate(update)) {
      project(known, sessionId, projectModels(update.configOptions))
    } else if (SessionUpdate.isAvailableCommandsUpdate(update)) {
      known.commands = update.availableCommands.map(
        ({ name, description }) => ({ name, description })
      )
      const aos = AosAvailableCommandsMetaSchema.safeParse(meta)
      if (aos.success) known.reported = aos.data.capabilities
      if (known.reported)
        known.capabilities = capabilitiesOf(known.reported, known.commands)
      notify(listeners, sessionId)
    } else if (SessionUpdate.isUsageUpdate(update)) {
      const context = projectContext(update, meta)
      if (!context) return
      known.context = context
      notify(listeners, sessionId)
    } else if (SessionUpdate.isStateUpdate(update) && update.state === "idle") {
      const aos = AosStateMetaSchema.safeParse(meta)
      const turns = foldTurnUsage(
        known.turns,
        isUsage(update.usage) ? update.usage : undefined,
        aos.success ? aos.data.cost : undefined
      )
      if (turns === known.turns) return
      known.turns = turns
      notify(listeners, sessionId)
    }
  }

  /** Folds the Session's updates until the returned release. */
  function subscribe(sessionId: string) {
    const leave = connection.subscribe(sessionId, {
      update: (update, meta) => accept(sessionId, update, meta),
      // A from-start replay restates every settled turn, so the spend it
      // folds starts over rather than counting each turn twice.
      replay: () => {
        const replayed = sessions.get(sessionId)
        if (replayed) delete replayed.turns
      },
    })
    return () => {
      leave()
      sessions.delete(sessionId)
      feeds.delete(sessionId)
    }
  }

  /** One feed per Session, so the composer subscribes to a stable value. */
  function modelFeed(sessionId: string): ComposerModelFeed {
    const known = feeds.get(sessionId)
    if (known) return known
    const feed: ComposerModelFeed = {
      current: () => sessions.get(sessionId)?.current,
      subscribe: (listener) => listen(modelListeners, sessionId, listener),
    }
    feeds.set(sessionId, feed)
    return feed
  }

  /**
   * A write's answer is stale once a newer write to the Session started or the
   * Session was released: projecting it would undo what came after it.
   */
  function stale(sessionId: string, known: SessionEntry, generation: number) {
    return sessions.get(sessionId) !== known || known.writes !== generation
  }

  async function select(
    sessionId: string,
    category: typeof MODEL_CATEGORY | typeof EFFORT_CATEGORY,
    valueId: string
  ) {
    const known = sessions.get(sessionId)
    if (!known?.projection.models)
      throw new Error("The Session reports no models")
    const generation = ++known.writes
    const configId =
      (category === MODEL_CATEGORY
        ? known.projection.modelConfigId
        : known.projection.effortConfigId) ?? category
    const next = projectModels(
      await connection.setConfigOption(sessionId, configId, valueId)
    )
    if (!stale(sessionId, known, generation)) project(known, sessionId, next)
    if (!next.models) throw new Error("The Session reports no models")
    return next.models
  }

  return {
    subscribe,
    capabilities: (sessionId: string) => sessions.get(sessionId)?.capabilities,
    models: (sessionId: string) => sessions.get(sessionId)?.projection.models,
    /** The newest reading, or none while the provider has reported none. */
    context: (sessionId: string) => sessions.get(sessionId)?.context,
    /** The settled turns' spend. */
    turnUsage: (sessionId: string) => sessions.get(sessionId)?.turns,
    listen: (sessionId: string, listener: () => void) =>
      listen(listeners, sessionId, listener),
    modelFeed,
    selectModel: (sessionId: string, selectedId: string) =>
      select(sessionId, MODEL_CATEGORY, selectedId),
    selectEffort: (sessionId: string, effortId: string) =>
      select(sessionId, EFFORT_CATEGORY, effortId),
  }
}
