"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useAuiState, useRemoteThreadListRuntime } from "@assistant-ui/react"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { createAcpInteractions } from "./acp/acp-interactions"
import { createAcpThreadListAdapter } from "./acp/acp-thread-list"
import { createAcpWorkspaceClient } from "./acp/acp-workspace-client"
import { createAcpConnection } from "./acp/connection"
import { useAcpRuntime } from "./acp/use-acp-runtime"
import { AosAttachmentAdapter } from "./aos-attachment-adapter"
import { AosArtifactAdapter } from "./aos-artifacts"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
} from "./aos-composer-features"
import { AosRemoteClient } from "./aos-client"
import { AosDraftRegistry, createAosSessionDraft } from "./aos-drafts"

/**
 * The operator surface over one ACP connection to the proxy. The connection
 * owns the wire, the workspace client owns Agent and Session ownership, and the
 * Session projector owns the thread; REST carries only bytes.
 */

const SESSION_TITLE_REFRESH_DEBOUNCE_MS = 100

const CLIENT_INFO = { name: "aos-ui", version: "1" }

function ReadyAosRuntimeProvider({
  children,
  config,
  locale,
}: RuntimeAdapterProps<"aos">) {
  const rest = useMemo(() => new AosRemoteClient(), [])
  const connection = useMemo(
    () => createAcpConnection({ clientInfo: CLIENT_INFO }),
    []
  )
  const connectionMounted = useRef(false)
  useEffect(() => {
    connectionMounted.current = true
    return () => {
      connectionMounted.current = false
      // Strict Mode immediately replays effects while preserving hook state.
      // Dispose only if this instance is still unmounted after that replay.
      queueMicrotask(() => {
        if (!connectionMounted.current) connection.close()
      })
    }
  }, [connection])
  const client = useMemo(
    () => createAcpWorkspaceClient({ connection, rest }),
    [connection, rest]
  )
  const drafts = useMemo(() => new AosDraftRegistry(), [])
  const threadList = useMemo(
    () =>
      createAcpThreadListAdapter({
        connection,
        drafts,
        titleFor: client.sessionTitle,
        agentIdFor: client.knownAgentIdOf,
      }),
    [client, connection, drafts]
  )
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const artifacts = useMemo(() => new AosArtifactAdapter(rest), [rest])
  const interactions = useMemo(
    () => createAcpInteractions({ connection }),
    [connection]
  )
  const media = useMemo(() => new VoiceMediaController(), [])
  // A Session's capabilities, config options, and usage exist only once it is
  // attached, so the composition reads them from the Session it has attached.
  const [attachedSessions, setAttachedSessions] = useState<ReadonlySet<string>>(
    new Set()
  )
  // The workspace client records what an attach reports, so it performs it.
  const attach = useCallback(
    async (sessionId: string) => {
      const attached = await client.attachSession(sessionId, {
        replayFromStart: true,
      })
      setAttachedSessions((previous) =>
        previous.has(sessionId) ? previous : new Set(previous).add(sessionId)
      )
      return attached
    },
    [client]
  )
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
      return useAcpRuntime({
        connection,
        sessionId: remoteId,
        agentId: agentId ?? "",
        // A locally-created draft has an Agent before it has a remote Session.
        isDisabled: !agentId,
        enableMessageQueue: Boolean(remoteId),
        adapters: { attachments, ...mediaAdapters },
        attach,
        messageRewind: (sourceUserId) => ({ rewindSourceId: sourceUserId }),
      })
    },
    [attach, attachments, client, connection, drafts, locale, media, threadList]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadList,
    runtimeHook,
  })
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
  const attachedSessionId =
    selectedSessionId && attachedSessions.has(selectedSessionId)
      ? selectedSessionId
      : undefined
  const capabilities = useAosSessionCapabilities(client, attachedSessionId)
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
    attachedSessionId,
    capabilities
  )
  // The Session projector rewinds locally from the `messageRewind` option; the
  // run config is what the Thread carries into Edit and Retry.
  const messageRewind = useMemo(
    () => ({
      runConfig(sourceUserId: string) {
        return { custom: { "aos.rewindSourceId": sourceUserId } }
      },
    }),
    []
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
    interactions,
    artifacts: { resolver: artifacts },
    composer,
    messageRewind,
    media,
    activityCoverage: "workspace",
  })
}

export function AosRuntimeProvider(props: RuntimeAdapterProps<"aos">) {
  return <ReadyAosRuntimeProvider {...props} />
}

export const runtimeAdapter: RuntimeAdapterDefinition<"aos"> = {
  mode: "aos",
  Provider: AosRuntimeProvider,
}
