import type { AssistantRuntime } from "@assistant-ui/react"
import { useCallback, useMemo, useState, useSyncExternalStore } from "react"

import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"

const FIXTURE_MODEL_OPTIONS = [
  { id: "fixture-balanced", label: "Fixture Balanced", group: "Fixture" },
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

function contextFor(
  threadId: string,
  messageCount: number,
  modelId: string
) {
  const configured = FIXTURE_USED_TOKENS.get(threadId)
  const hash = [...threadId].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) % 24_576,
    0
  )
  const initialUsedTokens = configured ?? 2_048 + hash
  return {
    usedTokens:
      initialUsedTokens +
      Math.max(0, messageCount - initialMessageCount(threadId)) * 256,
    maxTokens: FIXTURE_MAX_TOKENS.get(modelId) ?? 65_536,
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
  const [selectedByThread, setSelectedByThread] = useState<
    ReadonlyMap<string, string>
  >(() => new Map())
  const select = useCallback(
    async (id: string) => {
      if (
        !threadId ||
        !FIXTURE_MODEL_OPTIONS.some((option) => option.id === id)
      )
        return
      setSelectedByThread((current) => {
        const next = new Map(current)
        next.set(threadId, id)
        return next
      })
    },
    [threadId]
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

  return useMemo(() => {
    if (!threadId) return {}
    return {
      ...(config.modelSelectorEnabled
        ? {
            model: {
              options: FIXTURE_MODEL_OPTIONS,
              selectedId,
              select,
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
    messageCount,
    select,
    selectedId,
    threadId,
  ])
}
