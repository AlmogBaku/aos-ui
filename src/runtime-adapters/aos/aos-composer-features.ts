"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import {
  composerUsageFromTokens,
  type ComposerFeatureViewModel,
} from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import type { SlashCommand } from "@aos/protocol"
import type {
  AosContext,
  AosModelChoices,
  AosWorkspaceCapabilities,
} from "./aos-client"

type SessionCapabilityClient = {
  workspaceCapabilities(threadId: string): Promise<AosWorkspaceCapabilities>
}

type ComposerClient = SessionCapabilityClient & {
  models(threadId: string): Promise<AosModelChoices>
  context(threadId: string): Promise<AosContext>
  selectModel(
    threadId: string,
    selectedId: string
  ): Promise<{ selectedId: string }>
  selectEffort(
    threadId: string,
    effortId: string
  ): Promise<{ effortId: string }>
  steerRun(
    threadId: string,
    request: { requestId: string; text: string }
  ): Promise<{ status: "steered" | "queued" }>
}

const EMPTY_SLASH_COMMANDS: readonly SlashCommand[] = []

type SelectionState =
  | { status: "idle" }
  | { status: "pending"; targetId: string }
  | { status: "error"; targetId: string; error: string }

type SelectionRecord = { threadId: string; state: SelectionState }

const IDLE_SELECTION: SelectionState = { status: "idle" }

function selectionFor(
  record: SelectionRecord | undefined,
  threadId: string | undefined
): SelectionState {
  return record && record.threadId === threadId ? record.state : IDLE_SELECTION
}

export function useAosSlashCommands(
  capabilities: AosWorkspaceCapabilities | undefined,
  enabled = true
): readonly SlashCommand[] | undefined {
  if (!enabled) return undefined
  const capability = capabilities?.workspace.slashCommands
  return capability?.status === "available"
    ? capability.commands
    : EMPTY_SLASH_COMMANDS
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
    return () => {
      active = false
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
  const slashCommands = useAosSlashCommands(capabilities)
  const [models, setModels] = useState<AosModelChoices>()
  const [context, setContext] = useState<AosContext>()
  // In-flight switch state is tagged with its Session so a switch that settles
  // after the selected Session changed neither shows nor lands in the new one.
  const [selectionRecord, setSelectionRecord] = useState<SelectionRecord>()
  const [effortSelectionRecord, setEffortSelectionRecord] =
    useState<SelectionRecord>()
  const selection = selectionFor(selectionRecord, threadId)
  const effortSelection = selectionFor(effortSelectionRecord, threadId)
  const currentThreadId = useRef(threadId)
  useEffect(() => {
    currentThreadId.current = threadId
  }, [threadId])
  const modelsAvailable = capabilities?.workspace.models.status === "available"
  const contextAvailable =
    capabilities?.workspace.context.status === "available"
  const steeringAvailable =
    capabilities?.interactions.steering.status === "available"

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
      slashCommands,
      steer:
        steeringAvailable && threadId
          ? (request: { requestId: string; text: string }) =>
              client.steerRun(threadId, request)
          : undefined,
      model: (() => {
        if (
          !config.modelSelectorEnabled ||
          !modelsAvailable ||
          !models ||
          !threadId
        )
          return undefined
        const selectedOption = models.options.find(
          (o) => o.id === models.selectedId
        )
        const setSelection = (state: SelectionState) =>
          setSelectionRecord({ threadId, state })
        const setEffortSelection = (state: SelectionState) =>
          setEffortSelectionRecord({ threadId, state })
        const select = async (selectedId: string) => {
          setSelection({ status: "pending", targetId: selectedId })
          try {
            const result = await client.selectModel(threadId, selectedId)
            if (currentThreadId.current === threadId)
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
        }
        const selectEffort = async (effortId: string) => {
          setEffortSelection({ status: "pending", targetId: effortId })
          try {
            const result = await client.selectEffort(threadId, effortId)
            if (currentThreadId.current === threadId)
              setModels((previous) =>
                previous ? { ...previous, effortId: result.effortId } : previous
              )
            setEffortSelection({ status: "idle" })
          } catch (reason) {
            const error =
              reason instanceof Error ? reason : new Error(String(reason))
            setEffortSelection({
              status: "error",
              targetId: effortId,
              error: error.message,
            })
            onError?.(error)
          }
        }
        return {
          selectedId: models.selectedId,
          selection,
          options: models.options,
          select,
          // Retry repeats only the request that failed; stale failures have none.
          ...(selection.status === "error"
            ? { retry: () => select(selection.targetId) }
            : {}),
          effortId: models.effortId,
          effortSelection,
          ...(selectedOption?.efforts
            ? {
                selectEffort,
                ...(effortSelection.status === "error"
                  ? {
                      retryEffort: () => selectEffort(effortSelection.targetId),
                    }
                  : {}),
              }
            : {}),
        }
      })(),
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
      effortSelection,
      models,
      modelsAvailable,
      onError,
      selection,
      slashCommands,
      steeringAvailable,
      threadId,
    ]
  )
}
