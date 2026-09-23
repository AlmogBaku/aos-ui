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
  useAui,
  useAuiState,
  useRemoteThreadListRuntime,
  type AssistantRuntime,
  type CompleteAttachment,
  type ThreadRuntime,
} from "@assistant-ui/react"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { runErrorMessage } from "@/lib/i18n/run-errors"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { createAcpInteractions } from "./acp/acp-interactions"
import { createAcpThreadListAdapter } from "./acp/acp-thread-list"
import { createAcpWorkspaceClient } from "./acp/acp-workspace-client"
import { createAcpConnection } from "./acp/connection"
import { useAcpRuntime } from "./acp/use-acp-runtime"
import {
  AosAttachmentAdapter,
  stagedAttachmentOf,
} from "./aos-attachment-adapter"
import { AosArtifactAdapter } from "./aos-artifacts"
import { AosMcpAppAdapter } from "./aos-mcp-apps"
import {
  useAosComposerFeatures,
  useAosSessionCapabilities,
} from "./aos-composer-features"
import { AosRemoteClient } from "./aos-client"
import {
  createBrowserPushPlatform,
  createPushSubscriptionManager,
} from "@/lib/notifications/push-subscription"
import { AosDraftRegistry, createAosSessionDraft } from "./aos-drafts"

/**
 * The operator surface over one ACP connection to the proxy. The connection
 * owns the wire, the workspace client owns Agent and Session ownership, and the
 * Session projector owns the thread; REST carries only bytes.
 */

const SESSION_TITLE_REFRESH_DEBOUNCE_MS = 100

const CLIENT_INFO = { name: "aos-ui", version: "1" }

/**
 * Both locales ship with the runtime, so a failure raised before the workspace
 * has loaded its dictionary — a refused turn on a deep link — is already
 * localized.
 */
const runtimeDictionaries = { en, he }

/**
 * Shows the next turn the provider suggested, once the run that suggested it has
 * settled. Text the operator has already composed outranks the suggestion.
 */
function applyComposerPrefill(thread: ThreadRuntime, text: string) {
  let unsubscribe = () => {}
  const applyWhenIdle = () => {
    if (thread.getState().isRunning) return
    unsubscribe()
    if (thread.composer.getState().isEmpty) thread.composer.setText(text)
  }
  unsubscribe = thread.subscribe(applyWhenIdle)
  applyWhenIdle()
}

function ReadyAosRuntimeProvider({
  children,
  config,
  locale,
}: RuntimeAdapterProps<"aos">) {
  const rest = useMemo(() => new AosRemoteClient(), [])
  // Only an operator workspace with the real proxy client can subscribe this
  // device; every other surface simply has no manager.
  const push = useMemo(
    () =>
      createPushSubscriptionManager({
        client: rest,
        platform: createBrowserPushPlatform(),
      }),
    [rest]
  )
  useEffect(() => () => push.stop(), [push])
  const connection = useMemo(
    () => createAcpConnection({ clientInfo: CLIENT_INFO }),
    []
  )
  const connectionMounted = useRef(false)
  // Connecting is an effect, never a render side effect: React discards whole
  // renders (a Suspense retry from the lazy provider, a replayed mount), and a
  // socket opened by one of those would stay open for the tab's lifetime.
  useEffect(() => {
    connectionMounted.current = true
    connection.start()
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
        // Pages go through the workspace client, which shares each read and
        // keeps its rows, so no Session metadata read repeats a page.
        connection: {
          listSessions: client.readSessionPage,
          newSession: connection.newSession,
          updateSession: connection.updateSession,
          deleteSession: connection.deleteSession,
        },
        drafts,
        titleFor: client.sessionTitle,
        agentIdFor: client.knownAgentIdOf,
        agentScope: client.sessionCatalogScope,
      }),
    [client, connection, drafts]
  )
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const artifacts = useMemo(() => new AosArtifactAdapter(rest), [rest])
  const mcpApps = useMemo(() => new AosMcpAppAdapter(rest), [rest])
  const interactions = useMemo(
    () => createAcpInteractions({ connection, agentOf: client.knownAgentIdOf }),
    [client, connection]
  )
  const media = useMemo(() => new VoiceMediaController(), [])
  const describeRunError = useCallback(
    (code: string | undefined, fallback: string) =>
      runErrorMessage(runtimeDictionaries[locale], code, fallback),
    [locale]
  )
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
  // The Session owns the batch, so staging waits for the Session a draft's
  // first turn creates; the prompt then links what the proxy accepted.
  const stageAttachments = useCallback(
    async (sessionId: string, attachments: readonly CompleteAttachment[]) => {
      const { stageId } = await client.stageAttachments(
        sessionId,
        attachments.map(stagedAttachmentOf)
      )
      return {
        stageId,
        attachments: attachments.map(({ id, name, contentType }) => ({
          id,
          name,
          ...(contentType === undefined ? {} : { contentType }),
        })),
      }
    },
    [client]
  )
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
      // The thread list owns Session creation, so a draft's first turn resolves
      // its Session through the same initialization the list already dedupes.
      const resolveSessionId = useCallback(
        async () => (await aui.threadListItem.initialize()).remoteId,
        [aui]
      )
      const threadRuntime = useRef<AssistantRuntime | undefined>(undefined)
      const onComposerPrefill = useCallback((text: string) => {
        const thread = threadRuntime.current?.thread
        if (thread) applyComposerPrefill(thread, text)
      }, [])
      const runtime = useAcpRuntime({
        connection,
        sessionId: remoteId,
        agentId: agentId ?? "",
        // A locally-created draft has an Agent before it has a remote Session.
        isDisabled: !agentId,
        enableMessageQueue: Boolean(remoteId),
        adapters: { attachments, ...mediaAdapters },
        attach,
        resolveSessionId,
        stageAttachments,
        messageRewind: (sourceUserId) => ({ rewindSourceId: sourceUserId }),
        onComposerPrefill,
        describeRunError,
      })
      useEffect(() => {
        threadRuntime.current = runtime
      }, [runtime])
      return runtime
    },
    [
      attach,
      attachments,
      client,
      connection,
      describeRunError,
      drafts,
      locale,
      media,
      stageAttachments,
      threadList,
    ]
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
    if (!selectedItem) return
    // Only a draft may hold a title it has not read yet; any Session re-reads
    // one the provider changes or invalidates.
    const isDraft = drafts.agentFor(selectedItem.id) !== undefined
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
    if (isDraft) scheduleRefresh()
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
    mcpApps,
    composer,
    messageRewind,
    media,
    activityCoverage: "workspace",
    push,
  })
}

export function AosRuntimeProvider(props: RuntimeAdapterProps<"aos">) {
  return <ReadyAosRuntimeProvider {...props} />
}

export const runtimeAdapter: RuntimeAdapterDefinition<"aos"> = {
  mode: "aos",
  Provider: AosRuntimeProvider,
}
