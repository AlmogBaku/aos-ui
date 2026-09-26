"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  composerUsageFromTokens,
  type ComposerFeatureViewModel,
  type ComposerModelFeed,
  type ComposerModelSelectionState,
  type ComposerModelUpdate,
  type ComposerSessionCost,
  type ComposerTurnUsage,
} from "@/components/assistant-ui/composer-features"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import type {
  SessionModelUpdateRequest,
  SessionModelUpdateResponse,
  SlashCommand,
} from "@aos/protocol"
import type {
  AosContext,
  AosModelChoices,
  AosWorkspaceCapabilities,
} from "./aos-client"

type SessionCapabilityClient = {
  workspaceCapabilities(sessionId: string): Promise<AosWorkspaceCapabilities>
}

type ComposerClient = SessionCapabilityClient & {
  models(sessionId: string): Promise<AosModelChoices>
  /**
   * The newest usage the provider reported, absent until it reports one. One
   * reading is one value: the same reference until the next reading replaces
   * it, which is what lets the composer read it without re-rendering forever.
   */
  context(sessionId: string): AosContext | undefined
  subscribeContext(sessionId: string, listener: () => void): () => void
  /**
   * What the Session's settled turns spent, notified with the context: the
   * same reference until a settled turn replaces it.
   */
  turnUsage?(
    sessionId: string
  ): { lastTurn?: ComposerTurnUsage; cost?: ComposerSessionCost } | undefined
  /** The model the provider reports the Session on, one feed per Session. */
  modelFeed?(sessionId: string): ComposerModelFeed
  updateModel(
    sessionId: string,
    patch: SessionModelUpdateRequest
  ): Promise<SessionModelUpdateResponse>
  steerRun(
    sessionId: string,
    request: { requestId: string; text: string }
  ): Promise<{ status: "steered" | "queued" }>
}

const EMPTY_SLASH_COMMANDS: readonly SlashCommand[] = []

type SelectionRecord = {
  sessionId: string
  state: ComposerModelSelectionState
}

const IDLE_SELECTION: ComposerModelSelectionState = { status: "idle" }

function selectionFor(
  record: SelectionRecord | undefined,
  sessionId: string | undefined
): ComposerModelSelectionState {
  return record && record.sessionId === sessionId
    ? record.state
    : IDLE_SELECTION
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
  sessionId: string | undefined,
  onError?: (error: Error) => void
) {
  const [snapshot, setSnapshot] = useState<
    { sessionId: string; capabilities: AosWorkspaceCapabilities } | undefined
  >()

  useEffect(() => {
    let active = true
    if (!sessionId)
      return () => {
        active = false
      }
    void client.workspaceCapabilities(sessionId).then(
      (capabilities) => {
        if (active) setSnapshot({ sessionId, capabilities })
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
  }, [client, onError, sessionId])

  return snapshot && snapshot.sessionId === sessionId
    ? snapshot.capabilities
    : undefined
}

/** Reads the normalized Session projection; selection remains provider-authoritative. */
export function useAosComposerFeatures(
  client: ComposerClient,
  config: ComposerFeatureConfig,
  sessionId: string | undefined,
  capabilities: AosWorkspaceCapabilities | undefined,
  onError?: (error: Error) => void
): ComposerFeatureViewModel {
  const slashCommands = useAosSlashCommands(capabilities)
  const [models, setModels] = useState<AosModelChoices>()
  // Usage is pushed, not polled: the provider restates it on every resume, every
  // settled turn, and every model change, so the composer reads the newest one
  // rather than whatever a single read at resume time happened to catch.
  const subscribeContext = useCallback(
    (listener: () => void) =>
      sessionId
        ? client.subscribeContext(sessionId, listener)
        : () => undefined,
    [client, sessionId]
  )
  const context = useSyncExternalStore(
    subscribeContext,
    () => (sessionId ? client.context(sessionId) : undefined),
    () => undefined
  )
  const turnUsage = useSyncExternalStore(
    subscribeContext,
    () => (sessionId ? client.turnUsage?.(sessionId) : undefined),
    () => undefined
  )
  const follow = sessionId ? client.modelFeed?.(sessionId) : undefined
  // In-flight switch state is tagged with its Session so a switch that settles
  // after the selected Session changed neither shows nor lands in the new one.
  const [selectionRecord, setSelectionRecord] = useState<SelectionRecord>()
  const selection = selectionFor(selectionRecord, sessionId)
  // Only a Session's newest update may write: two rapid picks would otherwise
  // let the first one's late answer overwrite what the second settled on. The
  // keys are provider-opaque Session ids, so the record carries no prototype.
  const updateSerials = useRef<Record<string, number>>(Object.create(null))
  const currentThreadId = useRef(sessionId)
  useEffect(() => {
    currentThreadId.current = sessionId
  }, [sessionId])
  const modelsAvailable = capabilities?.workspace.models.status === "available"
  const steeringAvailable =
    capabilities?.interactions.steering.status === "available"

  useEffect(() => {
    let active = true
    if (!sessionId)
      return () => {
        active = false
      }
    if (config.modelSelectorEnabled && modelsAvailable)
      void client.models(sessionId).then(
        (next) => active && setModels(next),
        (reason) =>
          active &&
          onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
      )
    return () => {
      active = false
    }
  }, [client, config.modelSelectorEnabled, modelsAvailable, onError, sessionId])

  // A model the provider switched to brings its own efforts, so the choices
  // are re-read whenever the followed model changes.
  useEffect(() => {
    if (
      !follow ||
      !sessionId ||
      !config.modelSelectorEnabled ||
      !modelsAvailable
    )
      return undefined
    let active = true
    const unsubscribe = follow.subscribe(() => {
      void client.models(sessionId).then(
        (next) => active && setModels(next),
        () => undefined
      )
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [client, config.modelSelectorEnabled, follow, modelsAvailable, sessionId])

  return useMemo(
    () => ({
      slashCommands,
      steer:
        steeringAvailable && sessionId
          ? (request: { requestId: string; text: string }) =>
              client.steerRun(sessionId, request)
          : undefined,
      model: (() => {
        if (
          !config.modelSelectorEnabled ||
          !modelsAvailable ||
          !models ||
          !sessionId
        )
          return undefined
        const setSelection = (state: ComposerModelSelectionState) =>
          setSelectionRecord({ sessionId, state })
        const show = (state: { selectedId: string; effortId?: string }) =>
          setModels((previous) =>
            previous ? { ...previous, ...state } : previous
          )
        const update = async (patch: ComposerModelUpdate) => {
          const target: ComposerModelUpdate = {
            ...(patch.selectedId === undefined
              ? {}
              : { selectedId: patch.selectedId }),
            ...(patch.effortId === undefined
              ? {}
              : { effortId: patch.effortId }),
          }
          const previous = {
            selectedId: models.selectedId,
            effortId: models.effortId,
          }
          const serial = (updateSerials.current[sessionId] ?? 0) + 1
          updateSerials.current[sessionId] = serial
          const latest = () => updateSerials.current[sessionId] === serial
          // The picked half shows at once; the write's own response, not a
          // re-read of a projection the provider may not have settled yet,
          // decides what the Session ends up on.
          show({ ...previous, ...target })
          setSelection({ status: "pending", target })
          try {
            const result = await client.updateModel(sessionId, target)
            // An answer overtaken by a newer pick is dropped, and so is one
            // that settles after the Session changed: the projection on screen
            // belongs to the newest pick in the Session now selected.
            if (!latest()) return
            if (currentThreadId.current === sessionId)
              show({
                selectedId: result.selectedId,
                effortId: result.effortId,
              })
            setSelection({ status: "idle" })
          } catch (reason) {
            const error =
              reason instanceof Error ? reason : new Error(String(reason))
            // A superseded failure reverts nothing: the values on screen are
            // the newer pick's, not this one's to restore.
            if (!latest()) return
            if (currentThreadId.current === sessionId) {
              show(previous)
              onError?.(error)
            }
            setSelection({ status: "error", target, error: error.message })
          }
        }
        return {
          options: models.options,
          selectedId: models.selectedId,
          effortId: models.effortId,
          selection,
          update,
          ...(follow ? { follow } : {}),
          // Retry repeats only the patch that failed; a settled pick has none.
          ...(selection.status === "error"
            ? { retry: () => update(selection.target) }
            : {}),
        }
      })(),
      // A reading the provider pushed is its own evidence the window is
      // readable: a runtime that cannot report one never sends it.
      context:
        config.contextEnabled && context
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
              ...(turnUsage?.lastTurn ? { lastTurn: turnUsage.lastTurn } : {}),
              ...(turnUsage?.cost ? { cost: turnUsage.cost } : {}),
            }
          : undefined,
    }),
    [
      client,
      config.contextEnabled,
      config.modelSelectorEnabled,
      context,
      follow,
      models,
      modelsAvailable,
      onError,
      selection,
      slashCommands,
      steeringAvailable,
      sessionId,
      turnUsage,
    ]
  )
}
