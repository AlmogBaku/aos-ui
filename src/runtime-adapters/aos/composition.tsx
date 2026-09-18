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
  useAui,
  useRemoteThreadListRuntime,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"
import { useRunErrorResolver } from "@/lib/i18n/bundled"

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
import { reconcileComposerPrefill } from "./aos-composer-prefill"
import { AosDraftRegistry, createAosSessionDraft } from "./aos-drafts"
import { AosReconciler } from "./aos-reconciliation"
import { AosThreadListAdapter } from "./aos-thread-list"

const SESSION_TITLE_REFRESH_DEBOUNCE_MS = 100

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
  const resolveRunError = useRunErrorResolver(locale)
  const client = useMemo(
    () => new AosRemoteClient({ reconciler, resolveRunError }),
    [reconciler, resolveRunError]
  )
  const drafts = useMemo(() => new AosDraftRegistry(), [])
  const threadList = useMemo(
    () => new AosThreadListAdapter(client, drafts, resolveRunError),
    [client, drafts, resolveRunError]
  )
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const artifacts = useMemo(() => new AosArtifactAdapter(client), [client])
  const media = useMemo(() => new VoiceMediaController(), [])
  const runtimeHook = useCallback(
    function useAosThreadRuntime() {
      const aui = useAui()
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
            threadId: remoteId ?? localId ?? "",
            resolveThreadId: remoteId
              ? undefined
              : async () => (await aui.threadListItem.initialize()).remoteId,
            stageAttachments: client.stageAttachments.bind(client),
            onComposerPrefill: remoteId
              ? async (text) => {
                  const runtime = assistantRuntimeRef.current
                  if (!runtime) return
                  await reconcileComposerPrefill(
                    runtime.threads.getById(localId),
                    () => client.loadHistory(remoteId),
                    text
                  )
                }
              : undefined,
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
            onRunFinished: localId
              ? async () => {
                  const runtime = assistantRuntimeRef.current
                  if (!runtime) return
                  const target = runtime.threads.getById(localId)
                  const item = runtime.threads.getItemById(localId)
                  if (drafts.agentFor(localId)) {
                    let unsubscribeTitle: () => void = () => undefined
                    const refreshTitleWhenIdle = () => {
                      if (target.getState().isRunning) return
                      unsubscribeTitle()
                      void item.generateTitle().catch(() => {
                        // A later native invalidation retries the provider title.
                      })
                    }
                    unsubscribeTitle = target.subscribe(refreshTitleWhenIdle)
                    queueMicrotask(refreshTitleWhenIdle)
                  }
                  if (!remoteId) return
                  if (!client.needsSteeringReconciliation(remoteId)) return
                  const history = await client.loadHistory(remoteId)
                  const messages: ThreadMessageLike[] = history.messages.map(
                    (message) => ({
                      ...message,
                      createdAt: new Date(message.createdAt),
                    })
                  )
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
            // A promoting draft streams its first turn through this agent, so
            // the callback is bound before the remote Session id exists and
            // receives the id the run resolved.
            onEvent: (threadId, event) =>
              client.acceptRunEvent(threadId, event),
            resolveRunError,
            reloadHistory: remoteId
              ? () => client.loadHistory(remoteId)
              : undefined,
            getCapabilities:
              remoteId && agentId
                ? () =>
                    client
                      .workspaceCapabilities(remoteId)
                      .then((value) => value.agent)
                : undefined,
          }),
        [agentId, aui, localId, remoteId]
      )
      const history = useMemo(
        () =>
          remoteId && agentId ? threadList.historyFor(remoteId) : undefined,
        [agentId, remoteId]
      )
      const mediaAdapters = useMemo(() => {
        const scopeId = remoteId ?? localId
        return scopeId && agentId
          ? media.createAdapters(scopeId, {
              transcribe: (recording, signal) =>
                client.transcribeForAgent(agentId, recording, signal),
              synthesize: (text, signal) =>
                client.speakForAgent(agentId, text, signal),
              projectText: (text) => projectSpeechText(text, locale),
            })
          : undefined
      }, [agentId, localId, remoteId])
      return useAgUiRuntime({
        agent,
        // A locally-created draft has an Agent before it has a remote Session.
        // Its run transport awaits thread-list initialization, while leaving
        // the first user turn optimistic and immediately visible.
        isDisabled: !agentId,
        unstable_enableMessageQueue: Boolean(remoteId),
        adapters: { history, attachments, ...mediaAdapters },
        onCancel: () => {
          if (remoteId && agentId)
            void client.stopRun(remoteId).catch(() => undefined)
        },
      })
    },
    [attachments, client, drafts, locale, media, resolveRunError, threadList]
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
      const metadataAgentId = item?.custom?.agentId
      const agentId =
        typeof metadataAgentId === "string"
          ? metadataAgentId
          : sessionId
            ? threadList.agentFor(sessionId)
            : undefined
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
  useEffect(() => {
    if (!selectedSessionId) return
    const selectedItem = Object.values(
      assistantRuntime.threads.getState().threadItems
    ).find(
      (candidate) =>
        (candidate.remoteId ?? candidate.externalId) === selectedSessionId
    )
    if (!selectedItem || !drafts.agentFor(selectedItem.id)) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let refreshing = false
    let refreshAgain = false

    const refreshTitle = async () => {
      if (!active) return
      if (refreshing) {
        refreshAgain = true
        return
      }
      refreshing = true
      try {
        do {
          refreshAgain = false
          const state = assistantRuntime.threads.getState()
          const item = Object.values(state.threadItems).find(
            (candidate) =>
              (candidate.remoteId ?? candidate.externalId) === selectedSessionId
          )
          if (!item) return
          await assistantRuntime.threads.getItemById(item.id).generateTitle()
        } while (active && refreshAgain)
      } catch {
        // The next native invalidation retries the authoritative title read.
      } finally {
        refreshing = false
      }
    }

    const scheduleRefresh = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void refreshTitle()
      }, SESSION_TITLE_REFRESH_DEBOUNCE_MS)
    }
    const unsubscribe = client.subscribeSessionInvalidation(
      selectedSessionId,
      scheduleRefresh
    )
    scheduleRefresh()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [assistantRuntime, client, drafts, selectedSessionId])
  const selectedDraftKey = useSyncExternalStore(
    (listener) => {
      const unsubscribeDrafts = drafts.subscribe(listener)
      const unsubscribeThreads = assistantRuntime.threads.subscribe(listener)
      return () => {
        unsubscribeDrafts()
        unsubscribeThreads()
      }
    },
    () => {
      const state = assistantRuntime.threads.getState()
      const item = state.threadItems[state.mainThreadId]
      const agentId =
        item && !item.remoteId && !item.externalId
          ? drafts.agentFor(item.id)
          : undefined
      return item && agentId ? JSON.stringify([item.id, agentId]) : undefined
    },
    () => undefined
  )
  const selectedDraft = selectedDraftKey
    ? (JSON.parse(selectedDraftKey) as [string, string])
    : undefined
  const selectedDraftId = selectedDraft?.[0]
  const mediaScopeId = selectedSessionId ?? selectedDraftId
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
    media.setScope(mediaScopeId)
    media.setSafelyIdle(
      Boolean(selectedDraftId) ||
        (Boolean(selectedSessionId) && selectedSessionStatus === "idle")
    )
    if (selectedDraftId) {
      media.setAvailability(selectedDraftId, {
        transcription: "unverified",
        speech: "unverified",
      })
      return
    }
    if (!selectedSessionId || !capabilitiesReady) return
    media.setAvailability(selectedSessionId, {
      transcription: transcriptionAvailable ? "unverified" : "unavailable",
      speech: speechAvailable ? "unverified" : "unavailable",
    })
  }, [
    capabilitiesReady,
    media,
    mediaScopeId,
    selectedDraftId,
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
