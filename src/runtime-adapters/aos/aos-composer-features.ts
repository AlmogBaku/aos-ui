"use client"

import { useEffect, useMemo, useState } from "react"

import {
  composerUsageFromTokens,
  type ComposerFeatureViewModel,
} from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import type {
  AosContext,
  AosModelChoices,
  AosWorkspaceCapabilities,
} from "./aos-client"

type SessionCapabilityClient = {
  workspaceCapabilities(threadId: string): Promise<AosWorkspaceCapabilities>
  subscribeSessionInvalidation?: (
    threadId: string,
    listener: () => void
  ) => () => void
}

type ComposerClient = SessionCapabilityClient & {
  models(threadId: string): Promise<AosModelChoices>
  context(threadId: string): Promise<AosContext>
  selectModel(
    threadId: string,
    selectedId: string
  ): Promise<{ selectedId: string }>
}

/** Reads one authoritative capability projection for the selected Session. */
export function useAosSessionCapabilities(
  client: SessionCapabilityClient,
  threadId: string | undefined,
  onError?: (error: Error) => void
) {
  const [snapshot, setSnapshot] = useState<
    { threadId: string; capabilities: AosWorkspaceCapabilities } | undefined
  >()

  useEffect(() => {
    let active = true
    if (!threadId)
      return () => {
        active = false
      }
    const refresh = () => {
      void client.workspaceCapabilities(threadId).then(
        (capabilities) => {
          if (active) setSnapshot({ threadId, capabilities })
        },
        (reason) => {
          if (active)
            onError?.(
              reason instanceof Error ? reason : new Error(String(reason))
            )
        }
      )
    }
    refresh()
    const unsubscribe = client.subscribeSessionInvalidation?.(threadId, refresh)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [client, onError, threadId])

  return snapshot && snapshot.threadId === threadId
    ? snapshot.capabilities
    : undefined
}

/** Reads the normalized Session projection; selection remains provider-authoritative. */
export function useAosComposerFeatures(
  client: ComposerClient,
  config: ComposerFeatureConfig,
  threadId: string | undefined,
  capabilities: AosWorkspaceCapabilities | undefined,
  onError?: (error: Error) => void
): ComposerFeatureViewModel {
  const [models, setModels] = useState<AosModelChoices>()
  const [context, setContext] = useState<AosContext>()
  const [selection, setSelection] = useState<
    | { status: "idle" }
    | { status: "pending"; targetId: string }
    | { status: "error"; targetId: string; error: string }
  >({ status: "idle" })
  const modelsAvailable = capabilities?.workspace.models.status === "available"
  const contextAvailable =
    capabilities?.workspace.context.status === "available"

  useEffect(() => {
    let active = true
    if (!threadId)
      return () => {
        active = false
      }
    if (config.modelSelectorEnabled && modelsAvailable)
      void client.models(threadId).then(
        (next) => active && setModels(next),
        (reason) =>
          active &&
          onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
      )
    if (config.contextEnabled && contextAvailable)
      void client.context(threadId).then(
        (next) => active && setContext(next),
        (reason) =>
          active &&
          onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
      )
    return () => {
      active = false
    }
  }, [
    client,
    config.contextEnabled,
    config.modelSelectorEnabled,
    contextAvailable,
    modelsAvailable,
    onError,
    threadId,
  ])

  return useMemo(
    () => ({
      model:
        config.modelSelectorEnabled && modelsAvailable && models && threadId
          ? {
              selectedId: models.selectedId,
              selection,
              options: models.options,
              async select(selectedId: string) {
                setSelection({ status: "pending", targetId: selectedId })
                try {
                  const result = await client.selectModel(threadId, selectedId)
                  setModels((previous) =>
                    previous
                      ? { ...previous, selectedId: result.selectedId }
                      : previous
                  )
                  setSelection({ status: "idle" })
                } catch (reason) {
                  const error =
                    reason instanceof Error ? reason : new Error(String(reason))
                  setSelection({
                    status: "error",
                    targetId: selectedId,
                    error: error.message,
                  })
                  onError?.(error)
                }
              },
            }
          : undefined,
      context:
        config.contextEnabled && contextAvailable && context
          ? {
              usage: composerUsageFromTokens({
                systemTokens: context.breakdown?.systemTokens ?? 0,
                toolTokens: context.breakdown?.toolTokens ?? 0,
                messageTokens:
                  context.breakdown?.messageTokens ?? context.usedTokens,
                usedTokens: context.usedTokens,
                maxTokens: context.maxTokens,
              }),
              segments: context.breakdown
                ? ["system", "tools", "messages"]
                : [],
            }
          : undefined,
    }),
    [
      client,
      config.contextEnabled,
      config.modelSelectorEnabled,
      context,
      contextAvailable,
      models,
      modelsAvailable,
      onError,
      selection,
      threadId,
    ]
  )
}
