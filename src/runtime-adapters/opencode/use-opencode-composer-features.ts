"use client"

import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { useEffect, useRef, useState } from "react"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import {
  DEFAULT_COMPOSER_FEATURE_CONFIG,
  type ComposerFeatureConfig,
} from "@shared/runtime-config"
import { aosOpenCodeExtras } from "./opencode-runtime-extras"

const REQUEST_OPTIONS = { throwOnError: true } as const
type ModelOption = {
  id: string
  label: string
  group: string
  native: { id: string; providerID: string }
  maxTokens?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function modelChangeError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const detail = record(reason)
  const message =
    typeof detail?.message === "string"
      ? detail.message
      : record(detail?.data)?.message
  return new Error(typeof message === "string" ? message : String(reason))
}

function readModels(value: unknown): ModelOption[] {
  const catalog = record(value)
  if (!Array.isArray(catalog?.all) || !Array.isArray(catalog.connected))
    return []
  const connected = catalog.connected
  return catalog.all.flatMap((value) => {
    const provider = record(value)
    const models = record(provider?.models)
    if (
      !provider ||
      typeof provider.id !== "string" ||
      !provider.id ||
      !connected.includes(provider.id) ||
      !models
    )
      return []
    const providerID = provider.id
    return Object.values(models).flatMap((value) => {
      const model = record(value)
      if (
        !model ||
        typeof model.id !== "string" ||
        !model.id ||
        typeof model.name !== "string" ||
        !model.name ||
        model.providerID !== providerID
      )
        return []
      const context = record(model.limit)?.context
      return [
        {
          id: JSON.stringify([providerID, model.id]),
          label: model.name,
          group: typeof provider.name === "string" ? provider.name : providerID,
          native: { id: model.id, providerID },
          ...(typeof context === "number" &&
            Number.isFinite(context) &&
            context > 0 && { maxTokens: context }),
        },
      ]
    })
  })
}

export function useOpenCodeComposerFeatures(
  client: OpencodeClient,
  config: ComposerFeatureConfig = DEFAULT_COMPOSER_FEATURE_CONFIG,
  onError?: (error: Error, sessionId: string) => void
): ComposerFeatureViewModel {
  const extras = aosOpenCodeExtras.use((extras) => extras, undefined)
  const selections = useRef(new Map<string, Promise<void>>())
  const [catalog, setCatalog] = useState<{
    client: OpencodeClient
    models: ModelOption[]
  }>()
  const enabled = config.modelSelectorEnabled || config.contextEnabled
  useEffect(() => {
    if (!enabled) return
    let active = true
    void client.provider
      .list({}, REQUEST_OPTIONS)
      .then((response) => {
        if (active) setCatalog({ client, models: readModels(response.data) })
      })
      .catch(() => {
        if (active) setCatalog({ client, models: [] })
      })
    return () => {
      active = false
    }
  }, [client, enabled])
  if (!extras) return {}
  const { state, refresh } = extras
  const models = catalog?.client === client ? catalog.models : []
  const selected = models.find(
    ({ native }) =>
      native.id === state.session?.model?.id &&
      native.providerID === state.session.model.providerID
  )
  const sessionId = state.session?.id
  const latestAssistant = state.messageOrder
    .map((id) => state.messagesById[id]?.info)
    .findLast((info) => info?.role === "assistant")
  const usedTokens =
    latestAssistant?.role === "assistant" &&
    latestAssistant.sessionID === sessionId
      ? latestAssistant.tokens?.total
      : undefined
  return {
    context:
      config.contextEnabled &&
      selected?.maxTokens !== undefined &&
      typeof usedTokens === "number" &&
      Number.isFinite(usedTokens) &&
      usedTokens >= 0
        ? { usedTokens, maxTokens: selected.maxTokens }
        : undefined,
    model:
      config.modelSelectorEnabled && selected && sessionId
        ? {
            options: models.map(({ id, label, group }) => ({
              id,
              label,
              group,
            })),
            selectedId: selected.id,
            select: async (id) => {
              const model = models.find((model) => model.id === id)
              const previous =
                selections.current.get(sessionId) ?? Promise.resolve()
              const selection = previous
                .catch(() => undefined)
                .then(async () => {
                  if (!model) throw new Error("OpenCode model is unavailable")
                  await client.v2.session.switchModel(
                    { sessionID: sessionId, model: model.native },
                    REQUEST_OPTIONS
                  )
                  await refresh()
                })
              selections.current.set(sessionId, selection)
              try {
                await selection
              } catch (reason) {
                onError?.(modelChangeError(reason), sessionId)
              } finally {
                if (selections.current.get(sessionId) === selection)
                  selections.current.delete(sessionId)
              }
            },
          }
        : undefined,
  }
}
