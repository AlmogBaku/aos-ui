import type { AssistantRuntime } from "@assistant-ui/react"
import { useCallback, useMemo, useState, useSyncExternalStore } from "react"

import type {
  ComposerFeatureViewModel,
  ComposerModelCurrent,
  ComposerModelFeed,
  ComposerModelUpdate,
} from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import { FIXTURE_SLASH_COMMANDS } from "./fixture-slash-commands"

const FIXTURE_MODEL_OPTIONS = [
  {
    id: "fixture-balanced",
    label: "Fixture Balanced",
    group: "Fixture",
    efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  },
  { id: "fixture-fast", label: "Fixture Fast", group: "Fixture" },
] as const

const DEFAULT_MODEL_ID = FIXTURE_MODEL_OPTIONS[0].id
const FIXTURE_MAX_TOKENS = new Map<string, number>([
  ["fixture-balanced", 65_536],
  ["fixture-fast", 32_768],
])
const FIXTURE_USED_TOKENS = new Map<string, number>([
  ["thread-aster-market", 12_288],
  ["thread-mica-quarterly", 4_096],
])

/** What the preview reports its last turn used and the Session has cost. */
const FIXTURE_LAST_TURN = {
  inputTokens: 12_480,
  outputTokens: 1_236,
  cachedReadTokens: 8_192,
  totalTokens: 13_716,
} as const
const FIXTURE_SESSION_COST = { amount: 0.42, currency: "USD" } as const

function initialMessageCount(threadId: string) {
  return threadId === "thread-aster-interviews" ? 64 : 2
}

function contextFor(threadId: string, messageCount: number, modelId: string) {
  const configured = FIXTURE_USED_TOKENS.get(threadId)
  const hash = [...threadId].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) % 24_576,
    0
  )
  const initialUsedTokens = configured ?? 2_048 + hash
  const messages =
    initialUsedTokens +
    Math.max(0, messageCount - initialMessageCount(threadId)) * 256
  return {
    usage: {
      system: 2,
      tools: 1,
      messages: Math.round(Math.max(0, messages - 3_000) / 1_000),
      total: Math.round((FIXTURE_MAX_TOKENS.get(modelId) ?? 65_536) / 1_000),
    },
    lastTurn: FIXTURE_LAST_TURN,
    cost: FIXTURE_SESSION_COST,
  }
}

const DEFAULT_EFFORT_ID = "medium"

/**
 * The preview's provider side of the model choice: each Session's reading is
 * one value until a write replaces it, so the composer can follow it.
 */
function createFixtureModelStore() {
  const readings = new Map<string, ComposerModelCurrent>()
  const listeners = new Set<() => void>()
  const read = (threadId: string) => {
    let reading = readings.get(threadId)
    if (!reading) {
      reading = { selectedId: DEFAULT_MODEL_ID, effortId: DEFAULT_EFFORT_ID }
      readings.set(threadId, reading)
    }
    return reading
  }
  return {
    read,
    write(threadId: string, patch: Partial<ComposerModelCurrent>) {
      readings.set(threadId, { ...read(threadId), ...patch })
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useFixtureComposerFeatures({
  threadId,
  config,
  runtime,
}: {
  threadId: string | undefined
  config: ComposerFeatureConfig
  runtime: AssistantRuntime
}): ComposerFeatureViewModel {
  const [models] = useState(createFixtureModelStore)
  const reading = useSyncExternalStore(
    models.subscribe,
    () => (threadId ? models.read(threadId) : undefined),
    () => undefined
  )
  const follow = useMemo<ComposerModelFeed | undefined>(
    () =>
      threadId
        ? { current: () => models.read(threadId), subscribe: models.subscribe }
        : undefined,
    [models, threadId]
  )
  // The preview settles a pick synchronously: it has no provider to wait for,
  // so it never shows a pending state.
  const update = useCallback(
    async (patch: ComposerModelUpdate) => {
      if (!threadId) return
      const selectedId =
        patch.selectedId !== undefined &&
        FIXTURE_MODEL_OPTIONS.some((option) => option.id === patch.selectedId)
          ? patch.selectedId
          : undefined
      const option = FIXTURE_MODEL_OPTIONS.find(
        (candidate) =>
          candidate.id === (selectedId ?? models.read(threadId).selectedId)
      )
      const effortId =
        patch.effortId !== undefined && option && "efforts" in option
          ? patch.effortId
          : undefined
      if (selectedId === undefined && effortId === undefined) return
      models.write(threadId, {
        ...(selectedId ? { selectedId } : {}),
        ...(effortId ? { effortId } : {}),
      })
    },
    [models, threadId]
  )
  const subscribe = useCallback(
    (listener: () => void) => runtime.thread.subscribe(listener),
    [runtime]
  )
  const getMessageCount = useCallback(
    () => runtime.thread.getState().messages.length,
    [runtime]
  )
  const messageCount = useSyncExternalStore(
    subscribe,
    getMessageCount,
    getMessageCount
  )
  const selectedId = reading?.selectedId ?? DEFAULT_MODEL_ID
  const effortId = reading?.effortId ?? DEFAULT_EFFORT_ID

  return useMemo(() => {
    if (!threadId) return {}
    const selectedOption = FIXTURE_MODEL_OPTIONS.find(
      (option) => option.id === selectedId
    )
    return {
      slashCommands: FIXTURE_SLASH_COMMANDS,
      ...(config.modelSelectorEnabled
        ? {
            model: {
              options: FIXTURE_MODEL_OPTIONS,
              selectedId,
              selection: { status: "idle" },
              update,
              ...(follow ? { follow } : {}),
              ...(selectedOption && "efforts" in selectedOption
                ? { effortId }
                : {}),
            },
          }
        : {}),
      ...(config.contextEnabled
        ? { context: contextFor(threadId, messageCount, selectedId) }
        : {}),
    }
  }, [
    config.contextEnabled,
    config.modelSelectorEnabled,
    effortId,
    follow,
    messageCount,
    selectedId,
    threadId,
    update,
  ])
}
