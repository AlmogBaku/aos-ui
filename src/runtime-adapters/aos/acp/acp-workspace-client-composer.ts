import {
  SessionConfigOption,
  SessionUpdate,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { z } from "zod"

import type { SlashCommand } from "@aos/protocol"
import {
  AosUsageMetaSchema,
  type AosSessionResumeResponseMetaSchema,
} from "@aos/protocol/acp"

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

type SessionEntry = {
  capabilities: AcpCapabilities
  projection: AcpModelProjection
  context?: AosContext
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
  const contextListeners = new Map<string, Set<() => void>>()

  function entry(threadId: string) {
    const known = sessions.get(threadId)
    if (!known)
      throw new Error("The Session's workspace projection is unavailable")
    return known
  }

  function accept(threadId: string, update: SessionUpdate, meta: unknown) {
    const known = sessions.get(threadId)
    if (!known) return
    if (SessionUpdate.isConfigOptionUpdate(update))
      known.projection = projectModels(update.configOptions)
    else if (SessionUpdate.isAvailableCommandsUpdate(update))
      known.commands = update.availableCommands.map(
        ({ name, description }) => ({ name, description })
      )
    else if (SessionUpdate.isUsageUpdate(update)) {
      const context = projectContext(update, meta)
      if (!context) return
      known.context = context
      for (const listener of contextListeners.get(threadId) ?? []) listener()
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
    sessions.set(threadId, {
      capabilities: attached.capabilities,
      projection: projectModels(attached.configOptions),
      ...(previous?.context ? { context: previous.context } : {}),
      ...(previous?.commands ? { commands: previous.commands } : {}),
    })
    if (observed.has(threadId)) return
    observed.add(threadId)
    connection.onSessionUpdate(threadId, (update, meta) =>
      accept(threadId, update, meta)
    )
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
    known.projection = projectModels(
      await connection.setConfigOption(threadId, configId, valueId)
    )
    return models(threadId)
  }

  return {
    attach,
    capabilities: (threadId: string) => capabilitiesOf(entry(threadId)),
    models,
    /** The newest reading, or none while the provider has reported none. */
    context: (threadId: string) => sessions.get(threadId)?.context,
    subscribeContext(threadId: string, listener: () => void) {
      const listeners = contextListeners.get(threadId) ?? new Set()
      listeners.add(listener)
      contextListeners.set(threadId, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) contextListeners.delete(threadId)
      }
    },
    selectModel: (threadId: string, selectedId: string) =>
      select(threadId, MODEL_CATEGORY, selectedId),
    selectEffort: (threadId: string, effortId: string) =>
      select(threadId, EFFORT_CATEGORY, effortId),
  }
}
