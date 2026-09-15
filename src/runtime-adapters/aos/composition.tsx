"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"
import {
  useAuiState,
  useRemoteThreadListRuntime,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { AosAttachmentAdapter } from "./aos-attachment-adapter"
import { AosArtifactAdapter } from "./aos-artifacts"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
} from "./aos-composer-features"
import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import { AosDraftRegistry, createAosSessionDraft } from "./aos-drafts"
import { AosReconciler } from "./aos-reconciliation"
import { AosThreadListAdapter } from "./aos-thread-list"

function ReadyAosRuntimeProvider({
  children,
  config,
  locale,
}: RuntimeAdapterProps<"aos">) {
  const reconciler = useMemo(() => new AosReconciler(), [])
  const assistantRuntimeRef = useRef<AssistantRuntime | null>(null)
  const reconcilerMounted = useRef(false)
  useEffect(() => {
    reconcilerMounted.current = true
    return () => {
      reconcilerMounted.current = false
      // Strict Mode immediately replays effects while preserving hook state.
      // Dispose only if this instance is still unmounted after that replay.
      queueMicrotask(() => {
        if (!reconcilerMounted.current) reconciler.close()
      })
    }
  }, [reconciler])
  const client = useMemo(
    () => new AosRemoteClient({ reconciler }),
    [reconciler]
  )
  const drafts = useMemo(() => new AosDraftRegistry(), [])
  const threadList = useMemo(
    () => new AosThreadListAdapter(client, drafts),
    [client, drafts]
  )
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const artifacts = useMemo(() => new AosArtifactAdapter(client), [client])
  const media = useMemo(() => new VoiceMediaController(), [])
  const runtimeHook = useCallback(
    function useAosThreadRuntime() {
      const remoteId = useAuiState((state) => state.threadListItem.remoteId)
      const localId = useAuiState((state) => state.threadListItem.id)
      const metadataAgentId = useAuiState((state) => {
        const value = state.threadListItem.custom?.agentId
        return typeof value === "string" ? value : undefined
      })
      const draftAgentId = useSyncExternalStore(
        (listener) => drafts.subscribe(listener),
        () => (localId ? drafts.agentFor(localId) : undefined),
        () => undefined
      )
      const agentId = remoteId
        ? (threadList.agentFor(remoteId) ?? metadataAgentId)
        : (draftAgentId ?? metadataAgentId)
      if (remoteId && agentId) client.adoptSessionOwnership(remoteId, agentId)
      const agent = useMemo(
        () =>
          createAosRunAgent({
            agentId: agentId ?? "",
            threadId: remoteId ?? "",
            stageAttachments: client.stageAttachments.bind(client),
            resolveRewindSourceId: remoteId
              ? (sourceId, replacement, sourceText) =>
                  client.resolveRewindSourceId(
                    remoteId,
                    sourceId,
                    replacement,
                    sourceText
                  )
              : undefined,
            onRewindCompleted: remoteId
              ? async (replacement) => {
                  const history = await client.reconcileRewindReplacement(
                    remoteId,
                    replacement
                  )
                  const runtime = assistantRuntimeRef.current
                  if (!runtime) return
                  const messages: ThreadMessageLike[] = history.messages.map(
                    (message) => ({
                      ...message,
                      createdAt: new Date(message.createdAt),
                    })
                  )
                  let unsubscribe: () => void = () => undefined
                  const resetWhenIdle = () => {
                    const threads = runtime.threads.getState()
                    const selected = threads.threadItems[threads.mainThreadId]
                    if (
                      (selected?.remoteId ?? selected?.externalId) !== remoteId
                    ) {
                      unsubscribe()
                      return
                    }
                    if (runtime.thread.getState().isRunning) return
                    unsubscribe()
                    runtime.thread.reset(messages)
                  }
                  unsubscribe = runtime.thread.subscribe(resetWhenIdle)
                  queueMicrotask(resetWhenIdle)
                }
              : undefined,
            onRunFinished:
              remoteId && localId
                ? async () => {
                    if (!client.needsSteeringReconciliation(remoteId)) return
                    const history = await client.loadHistory(remoteId)
                    const runtime = assistantRuntimeRef.current
                    if (!runtime) return
                    const messages: ThreadMessageLike[] = history.messages.map(
                      (message) => ({
                        ...message,
                        createdAt: new Date(message.createdAt),
                      })
                    )
                    const target = runtime.threads.getById(localId)
                    let unsubscribe: () => void = () => undefined
                    const resetWhenIdle = () => {
                      if (target.getState().isRunning) return
                      unsubscribe()
                      target.reset(messages)
                      client.completeSteeringReconciliation(remoteId)
                    }
                    unsubscribe = target.subscribe(resetWhenIdle)
                    queueMicrotask(resetWhenIdle)
                  }
                : undefined,
            onEvent: remoteId
              ? (event) => client.acceptRunEvent(remoteId, event)
              : undefined,
            getCapabilities:
              remoteId && agentId
                ? () =>
                    client
                      .workspaceCapabilities(remoteId)
                      .then((value) => value.agent)
                : undefined,
          }),
        [agentId, localId, remoteId]
      )
      const history = useMemo(
        () =>
          remoteId && agentId ? threadList.historyFor(remoteId) : undefined,
        [agentId, remoteId]
      )
      const mediaAdapters = useMemo(
        () =>
          remoteId && agentId
            ? media.createAdapters(remoteId, {
                transcribe: (recording, signal) =>
                  client.transcribe(remoteId, recording, signal),
                synthesize: (text, signal) =>
                  client.speak(remoteId, text, signal),
                projectText: (text) => projectSpeechText(text, locale),
              })
            : undefined,
        [agentId, remoteId]
      )
      return useAgUiRuntime({
        agent,
        // A locally-created draft has an Agent before it has a remote Session.
        // RemoteThreadResource initializes it before the queued first run.
        isDisabled: !agentId,
        unstable_enableMessageQueue: true,
        adapters: { history, attachments, ...mediaAdapters },
        onCancel: () => {
          if (remoteId && agentId)
            void client.stopRun(remoteId).catch(() => undefined)
        },
      })
    },
    [attachments, client, drafts, locale, media, threadList]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadList,
    runtimeHook,
  })
  useEffect(() => {
    assistantRuntimeRef.current = assistantRuntime
    return () => {
      if (assistantRuntimeRef.current === assistantRuntime)
        assistantRuntimeRef.current = null
    }
  }, [assistantRuntime])
  const createSessionDraft = useCallback(
    (agentId: string) =>
      createAosSessionDraft(assistantRuntime, drafts, agentId),
    [assistantRuntime, drafts]
  )
  const selectedScopeKey = useSyncExternalStore(
    assistantRuntime.threads.subscribe,
    () => {
      const state = assistantRuntime.threads.getState()
      const item = state.threadItems[state.mainThreadId]
      const sessionId = item?.remoteId ?? item?.externalId
      const agentId = item?.custom?.agentId
      return sessionId && typeof agentId === "string"
        ? JSON.stringify([sessionId, agentId])
        : undefined
    },
    () => undefined
  )
  const selectedScope = selectedScopeKey
    ? (JSON.parse(selectedScopeKey) as [string, string])
    : undefined
  const selectedSessionId = selectedScope?.[0]
  if (selectedScope)
    client.adoptSessionOwnership(selectedScope[0], selectedScope[1])
  const capabilities = useAosSessionCapabilities(client, selectedSessionId)
  const selectedSessionStatus = useSyncExternalStore(
    useCallback(
      (listener) =>
        selectedSessionId
          ? client.subscribeSessionStatus(selectedSessionId, listener)
          : () => undefined,
      [client, selectedSessionId]
    ),
    () =>
      selectedSessionId ? client.sessionStatus(selectedSessionId) : "unknown",
    () => "unknown"
  )
  const composer = useAosComposerFeatures(
    client,
    config.composerFeatures,
    selectedSessionId,
    capabilities
  )
  const messageRewind = useMemo(
    () => ({
      runConfig(sourceUserId: string) {
        const source = assistantRuntime.thread
          .getMessageById(sourceUserId)
          .getState()
        const sourceText =
          source?.role === "user"
            ? source.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")
            : undefined
        return {
          custom: {
            "aos.rewindSourceId": sourceUserId,
            ...(sourceText === undefined
              ? {}
              : { "aos.rewindSourceText": sourceText }),
          },
        }
      },
    }),
    [assistantRuntime]
  )
  const capabilitiesReady = capabilities !== undefined
  const transcriptionAvailable =
    capabilities?.content.transcription.status === "available"
  const speechAvailable = capabilities?.content.speech.status === "available"
  useEffect(() => {
    media.setScope(selectedSessionId)
    media.setSafelyIdle(
      Boolean(selectedSessionId) && selectedSessionStatus === "idle"
    )
    if (!selectedSessionId || !capabilitiesReady) return
    media.setAvailability(selectedSessionId, {
      transcription: transcriptionAvailable ? "unverified" : "unavailable",
      speech: speechAvailable ? "unverified" : "unavailable",
    })
  }, [
    capabilitiesReady,
    media,
    selectedSessionId,
    selectedSessionStatus,
    speechAvailable,
    transcriptionAvailable,
  ])

  return children({
    assistantRuntime,
    workspace: client,
    createSessionDraft,
    agUiInterrupts: true,
    artifacts: { resolver: artifacts },
    composer,
    messageRewind,
    media,
    activityCoverage: "active-session",
  })
}

export function AosRuntimeProvider(props: RuntimeAdapterProps<"aos">) {
  return <ReadyAosRuntimeProvider {...props} />
}

export const runtimeAdapter: RuntimeAdapterDefinition<"aos"> = {
  mode: "aos",
  Provider: AosRuntimeProvider,
}
