"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { useAuiState, useRemoteThreadListRuntime } from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { AosAuthGate, AuthGateFailure } from "./aos-auth-gate"
import { AosAttachmentAdapter } from "./aos-attachment-adapter"
import { AosArtifactAdapter } from "./aos-artifacts"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
} from "./aos-composer-features"
import { createAosInteractions } from "./aos-interactions"
import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import { AosReconciler } from "./aos-reconciliation"
import { AosThreadListAdapter } from "./aos-thread-list"

function ReadyAosRuntimeProvider({
  children,
  config,
  locale,
  onReconnect,
  onAuthRequired,
}: RuntimeAdapterProps<"aos"> & {
  onReconnect(): Promise<void>
  onAuthRequired(): void
}) {
  const reconciler = useMemo(
    () => new AosReconciler({ onReconnect }),
    [onReconnect]
  )
  useEffect(() => () => reconciler.close(), [reconciler])
  const client = useMemo(
    () => new AosRemoteClient({ reconciler, onAuthRequired }),
    [onAuthRequired, reconciler]
  )
  const threadList = useMemo(() => new AosThreadListAdapter(client), [client])
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const artifacts = useMemo(() => new AosArtifactAdapter(client), [client])
  const interactions = useMemo(() => createAosInteractions(client), [client])
  const media = useMemo(() => new VoiceMediaController(), [])
  const runtimeHook = useCallback(
    function useAosThreadRuntime() {
      const remoteId = useAuiState((state) => state.threadListItem.remoteId)
      const agentId = useAuiState((state) => {
        const value = state.threadListItem.custom?.agentId
        return typeof value === "string" ? value : undefined
      })
      const agent = useMemo(
        () =>
          createAosRunAgent({
            agentId: agentId ?? "",
            threadId: remoteId ?? "",
            stageAttachments: client.stageAttachments.bind(client),
          }),
        [agentId, client, remoteId]
      )
      const history = useMemo(
        () => (remoteId ? threadList.historyFor(remoteId) : undefined),
        [remoteId]
      )
      const mediaAdapters = useMemo(
        () =>
          remoteId
            ? media.createAdapters(remoteId, {
                transcribe: (recording, signal) =>
                  client.transcribe(remoteId, recording, signal),
                synthesize: (text, signal) =>
                  client.speak(remoteId, text, signal),
                projectText: (text) => projectSpeechText(text, locale),
              })
            : undefined,
        [client, media, remoteId]
      )
      return useAgUiRuntime({
        agent,
        isDisabled: !remoteId || !agentId,
        adapters: { history, attachments, ...mediaAdapters },
        onCancel: () => {
          if (remoteId) void client.stopRun(remoteId).catch(() => undefined)
        },
      })
    },
    [attachments, client, locale, media, threadList]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadList,
    runtimeHook,
  })
  const selectedThreadId = useSyncExternalStore(
    assistantRuntime.threads.subscribe,
    () => {
      const state = assistantRuntime.threads.getState()
      const item = state.threadItems[state.mainThreadId]
      return item?.remoteId ?? item?.externalId
    },
    () => undefined
  )
  const capabilities = useAosSessionCapabilities(client, selectedThreadId)
  const composer = useAosComposerFeatures(
    client,
    config.composerFeatures,
    selectedThreadId,
    capabilities
  )
  useEffect(() => {
    media.setScope(selectedThreadId)
    media.setSafelyIdle(false)
    if (!selectedThreadId || !capabilities) return
    const transcriptionAvailable =
      capabilities.content.transcription.status === "available"
    const speechAvailable = capabilities.content.speech.status === "available"
    const activityAvailable =
      capabilities.workspace.activity.status === "available"
    if (!transcriptionAvailable && !speechAvailable) {
      media.setAvailability(selectedThreadId, {
        transcription: "unavailable",
        speech: "unavailable",
      })
      return
    }
    const operation = new AbortController()
    void Promise.all([
      client.audioAvailability(selectedThreadId),
      activityAvailable ? client.activity(selectedThreadId) : undefined,
    ]).then(
      ([availability, activity]) => {
        if (operation.signal.aborted) return
        media.setAvailability(selectedThreadId, {
          transcription: transcriptionAvailable
            ? availability.transcription
            : "unavailable",
          speech: speechAvailable ? availability.speech : "unavailable",
        })
        media.setSafelyIdle(
          activity?.status === "available" && activity.state === "idle"
        )
      },
      () => {
        if (!operation.signal.aborted)
          media.setAvailability(selectedThreadId, {
            transcription: "unavailable",
            speech: "unavailable",
          })
      }
    )
    return () => operation.abort()
  }, [capabilities, client, media, selectedThreadId])

  return children({
    assistantRuntime,
    workspace: client,
    artifacts: { resolver: artifacts },
    composer,
    media,
    interactions,
    activityCoverage: "workspace",
  })
}

export function AosRuntimeProvider(props: RuntimeAdapterProps<"aos">) {
  const startupClient = useMemo(() => new AosRemoteClient(), [])
  const [gateGeneration, setGateGeneration] = useState(0)
  const onAuthRequired = useCallback(
    () => setGateGeneration((generation) => generation + 1),
    []
  )
  const operatorAuth = useCallback(
    async (signal: AbortSignal) => {
      const state = await startupClient.operatorAuth(signal)
      return state.status === "authenticated"
        ? ({ status: "authenticated" } as const)
        : ({ status: "authentication-required" } as const)
    },
    [startupClient]
  )
  const runtimeAuth = useCallback(
    (signal: AbortSignal) => startupClient.runtimeAuth(signal),
    [startupClient]
  )
  const startup = useCallback(
    async (signal: AbortSignal) => {
      const runtime = await startupClient.runtimeInfo(signal)
      if (runtime.status === "unavailable")
        throw new AuthGateFailure("provider-unavailable")
      await startupClient.listAgentCatalog(signal)
      await startupClient.listSessionCatalog(50, 0, signal)
    },
    [startupClient]
  )
  const onReconnect = useCallback(async () => {
    try {
      const signal = new AbortController().signal
      const operator = await operatorAuth(signal)
      if (operator.status !== "authenticated") throw new Error()
      const runtime = await runtimeAuth(signal)
      if (runtime.status !== "authenticated") throw new Error()
      await startup(signal)
    } catch (error) {
      setGateGeneration((generation) => generation + 1)
      throw error
    }
  }, [operatorAuth, runtimeAuth, startup])

  return (
    <AosAuthGate
      key={gateGeneration}
      locale={props.locale}
      operatorAuth={operatorAuth}
      runtimeAuth={runtimeAuth}
      startup={startup}
    >
      <ReadyAosRuntimeProvider
        {...props}
        onReconnect={onReconnect}
        onAuthRequired={onAuthRequired}
      />
    </AosAuthGate>
  )
}

export const runtimeAdapter: RuntimeAdapterDefinition<"aos"> = {
  mode: "aos",
  Provider: AosRuntimeProvider,
}
