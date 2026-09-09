import type { AssistantRuntime } from "@assistant-ui/react"
import { useEffect, useSyncExternalStore } from "react"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import {
  DEFAULT_COMPOSER_FEATURE_CONFIG,
  type ComposerFeatureConfig,
} from "@shared/runtime-config"
import type { HermesNativeClient } from "./hermes-native-client"
import { toHermesComposerUsage } from "./hermes-composer-state"

function selectedThread(runtime: AssistantRuntime) {
  const state = runtime.threads.getState()
  const item = state.threadItems[state.mainThreadId]
  return item?.remoteId ?? item?.externalId
}

export function useHermesComposerFeatures(
  client: HermesNativeClient,
  runtime: AssistantRuntime,
  config: ComposerFeatureConfig = DEFAULT_COMPOSER_FEATURE_CONFIG,
  onError?: (error: Error) => void
): ComposerFeatureViewModel {
  const threadId = useSyncExternalStore(
    runtime.threads.subscribe,
    () => selectedThread(runtime),
    () => selectedThread(runtime)
  )
  useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  const session = threadId ? client.session(threadId) : undefined
  const liveSessionId = session?.liveSessionId
  const { modelSelectorEnabled, contextEnabled } = config
  useEffect(() => {
    if (!threadId || !liveSessionId) return
    let active = true
    void client
      .refreshComposer(threadId, { modelSelectorEnabled, contextEnabled })
      .catch((reason) => {
        if (active && selectedThread(runtime) === threadId)
          onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
      })
    return () => {
      active = false
    }
  }, [
    client,
    runtime,
    threadId,
    liveSessionId,
    modelSelectorEnabled,
    contextEnabled,
    onError,
  ])

  const model = session?.composer?.model
  return {
    context:
      contextEnabled && session?.composer?.context
        ? {
            usage: toHermesComposerUsage(session.composer.context),
            segments: session.composer.context.breakdown
              ? (["system", "tools", "messages"] as const)
              : [],
          }
        : undefined,
    model:
      modelSelectorEnabled &&
      model &&
      threadId &&
      model.options.some((option) => option.id === model.selectedId)
        ? {
            selectedId: model.selectedId,
            options: model.options.map(({ id, label, group }) => ({
              id,
              label,
              group,
            })),
            async select(id) {
              try {
                await client.selectModel(threadId, id)
              } catch (reason) {
                if (selectedThread(runtime) === threadId)
                  onError?.(
                    reason instanceof Error ? reason : new Error(String(reason))
                  )
              }
            },
          }
        : undefined,
  }
}
