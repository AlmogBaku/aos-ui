"use client"

import type {
  OpencodeClient,
  OpenCodeRuntimeExtras,
} from "@assistant-ui/react-opencode"
import { useEffect, useRef, useState } from "react"
import type {
  ComposerFeatureViewModel,
  ComposerModelSelectionState,
} from "@/components/assistant-ui/composer-features"
import {
  DEFAULT_COMPOSER_FEATURE_CONFIG,
  type ComposerFeatureConfig,
} from "@shared/runtime-config"
import { aosOpenCodeExtras } from "./opencode-runtime-extras"
import { readOpenCodeComposerContext } from "./opencode-context-usage"

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
  return useOpenCodeComposerState(client, extras, config, onError)
}

export function useOpenCodeComposerState(
  client: OpencodeClient,
  extras: OpenCodeRuntimeExtras | undefined,
  config: ComposerFeatureConfig = DEFAULT_COMPOSER_FEATURE_CONFIG,
  onError?: (error: Error, sessionId: string) => void
): ComposerFeatureViewModel {
  const selections = useRef(new Map<string, Promise<void>>())
  const requests = useRef(new Map<string, symbol>())
  const [selectionBySession, setSelectionBySession] = useState<
    ReadonlyMap<string, ComposerModelSelectionState>
  >(() => new Map())
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
  const selection = sessionId
    ? (selectionBySession.get(sessionId) ?? { status: "idle" })
    : { status: "idle" as const }
  const context = selected?.maxTokens
    ? readOpenCodeComposerContext(state, selected.maxTokens)
    : undefined
  const select = async (id: string) => {
    if (!sessionId) return
    const request = Symbol(id)
    requests.current.set(sessionId, request)
    setSelectionBySession((current) => {
      const next = new Map(current)
      next.set(sessionId, { status: "pending", targetId: id })
      return next
    })
    const model = models.find((candidate) => candidate.id === id)
    const previous = selections.current.get(sessionId) ?? Promise.resolve()
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        if (!model) throw new Error("OpenCode model is unavailable")
        await client.v2.session.switchModel(
          { sessionID: sessionId, model: model.native },
          REQUEST_OPTIONS
        )
        await refresh()
      })
    selections.current.set(sessionId, pending)
    try {
      await pending
      if (requests.current.get(sessionId) === request)
        setSelectionBySession((current) => {
          const next = new Map(current)
          next.set(sessionId, { status: "idle" })
          return next
        })
    } catch (reason) {
      if (requests.current.get(sessionId) !== request) return
      const error = modelChangeError(reason)
      setSelectionBySession((current) => {
        const next = new Map(current)
        next.set(sessionId, {
          status: "error",
          targetId: id,
          error: error.message,
        })
        return next
      })
      onError?.(error, sessionId)
    } finally {
      if (selections.current.get(sessionId) === pending)
        selections.current.delete(sessionId)
    }
  }
  return {
    context: config.contextEnabled && sessionId ? context : undefined,
    model:
      config.modelSelectorEnabled && selected && sessionId
        ? {
            options: models.map(({ id, label, group }) => ({
              id,
              label,
              group,
            })),
            selectedId: selected.id,
            selection,
            select,
            retry:
              selection.status === "error"
                ? () => select(selection.targetId)
                : undefined,
          }
        : undefined,
  }
}
