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
  type ComposerModelSelectionState,
  type ComposerModelUpdate,
  type ComposerSessionCost,
} from "@/components/assistant-ui/composer-features"
import type {
  ComposerModelFeed,
  ComposerTurnUsage,
} from "@/runtime-adapters/contracts"
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

/**
 * The Session's projection as its updates folded it so far. Every read
 * returns the same reference until what it reads changes, which is what lets
 * the composer read it without re-rendering forever.
 */
type SessionCapabilityClient = {
  /** What the Session supports, absent until it reports it. */
  workspaceCapabilities(sessionId: string): AosWorkspaceCapabilities | undefined
  /** Told of every change to anything the composer reads for the Session. */
  subscribeComposer(sessionId: string, listener: () => void): () => void
}

type ComposerClient = SessionCapabilityClient & {
  /** The models the Session offers, absent until it reports them. */
  models(sessionId: string): AosModelChoices | undefined
  /** The newest usage the provider reported, absent until it reports one. */
  context(sessionId: string): AosContext | undefined
  /** What the Session's settled turns spent. */
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

/** One read of the Session's projection, re-read as the Session reports. */
function useSessionRead<Value>(
  client: SessionCapabilityClient,
  sessionId: string | undefined,
  read: (sessionId: string) => Value | undefined
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId
        ? client.subscribeComposer(sessionId, listener)
        : () => undefined,
    [client, sessionId]
  )
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? read(sessionId) : undefined),
    () => undefined
  )
}

/** Reads one authoritative capability projection for the selected Session. */
export function useAosSessionCapabilities(
  client: SessionCapabilityClient,
  sessionId: string | undefined
) {
  return useSessionRead(client, sessionId, (id) =>
    client.workspaceCapabilities(id)
  )
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
  // Everything here is pushed, not polled: the provider restates it on every
  // replay, settled turn, and model change, so the composer reads the newest.
  const reported = useSessionRead(client, sessionId, (id) => client.models(id))
  const context = useSessionRead(client, sessionId, (id) => client.context(id))
  const turnUsage = useSessionRead(client, sessionId, (id) =>
    client.turnUsage?.(id)
  )
  const follow = sessionId ? client.modelFeed?.(sessionId) : undefined
  // In-flight switch state is tagged with its Session so a switch that settles
  // after the selected Session changed neither shows nor lands in the new one.
  const [selectionRecord, setSelectionRecord] = useState<SelectionRecord>()
  const selection = selectionFor(selectionRecord, sessionId)
  // The picked half shows at once; the Session's projection, which the
  // write's own answer settles, decides what it ends up on.
  const models = useMemo(
    () =>
      reported && selection.status === "pending"
        ? { ...reported, ...selection.target }
        : reported,
    [reported, selection]
  )
  // Only a Session's newest update may settle the selection: two rapid picks
  // would otherwise let the first one's late answer end the second's wait. The
  // keys are provider-opaque Session ids, so the record carries no prototype.
  const updateSerials = useRef<Record<string, number>>(Object.create(null))
  const currentThreadId = useRef(sessionId)
  useEffect(() => {
    currentThreadId.current = sessionId
  }, [sessionId])
  const modelsAvailable = capabilities?.workspace.models.status === "available"
  const steeringAvailable =
    capabilities?.interactions.steering.status === "available"

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
        const update = async (patch: ComposerModelUpdate) => {
          const target: ComposerModelUpdate = {
            ...(patch.selectedId === undefined
              ? {}
              : { selectedId: patch.selectedId }),
            ...(patch.effortId === undefined
              ? {}
              : { effortId: patch.effortId }),
          }
          const serial = (updateSerials.current[sessionId] ?? 0) + 1
          updateSerials.current[sessionId] = serial
          const latest = () => updateSerials.current[sessionId] === serial
          setSelection({ status: "pending", target })
          try {
            await client.updateModel(sessionId, target)
            // An answer overtaken by a newer pick leaves that pick pending.
            if (!latest()) return
            setSelection({ status: "idle" })
          } catch (reason) {
            const error =
              reason instanceof Error ? reason : new Error(String(reason))
            // A superseded failure reports nothing: the newer pick is still
            // the one in flight. A failed pick shows the projection again.
            if (!latest()) return
            if (currentThreadId.current === sessionId) onError?.(error)
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
