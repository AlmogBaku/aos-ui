import type { AssistantRuntime } from "@assistant-ui/react"
import { useCallback, useMemo, useState, useSyncExternalStore } from "react"

import type {
  ComposerFeatureViewModel,
  ComposerModelUpdate,
} from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import { FIXTURE_SLASH_COMMANDS } from "./fixture-slash-commands"

const FIXTURE_MODEL_OPTIONS = [
  {
    id: "fixture-balanced",
    label: "Fixture Balanced",
    group: "Fixture",
    efforts: ["low", "medium", "high"] as readonly string[],
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
  }
}

const DEFAULT_EFFORT_ID = "medium"

export function useFixtureComposerFeatures({
  threadId,
  config,
  runtime,
}: {
  threadId: string | undefined
  config: ComposerFeatureConfig
  runtime: AssistantRuntime
}): ComposerFeatureViewModel {
  const [selectedByThread, setSelectedByThread] = useState<
    ReadonlyMap<string, string>
  >(() => new Map())
  const [effortByThread, setEffortByThread] = useState<
    ReadonlyMap<string, string>
  >(() => new Map())
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
      if (selectedId)
        setSelectedByThread((current) => {
          const next = new Map(current)
          next.set(threadId, selectedId)
          return next
        })
      if (patch.effortId === undefined) return
      const option = FIXTURE_MODEL_OPTIONS.find(
        (candidate) =>
          candidate.id ===
          (selectedId ?? selectedByThread.get(threadId) ?? DEFAULT_MODEL_ID)
      )
      if (!option || !("efforts" in option)) return
      const effortId = patch.effortId
      setEffortByThread((current) => {
        const next = new Map(current)
        next.set(threadId, effortId)
        return next
      })
    },
    [threadId, selectedByThread]
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
  const selectedId = threadId
    ? (selectedByThread.get(threadId) ?? DEFAULT_MODEL_ID)
    : DEFAULT_MODEL_ID
  const effortId = threadId
    ? (effortByThread.get(threadId) ?? DEFAULT_EFFORT_ID)
    : DEFAULT_EFFORT_ID

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
    messageCount,
    selectedId,
    threadId,
    update,
  ])
}
