"use client"

import {
  fromThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type AppendMessage,
  type MessageStatus,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react"
import type { Locale } from "@/lib/i18n/config"
import type { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { HermesAudioClient } from "./hermes-audio-client"
import { HermesArtifactAdapter } from "./hermes-artifacts"
import { HermesMediaBinding } from "./hermes-media-binding"
import { HermesAttachmentAdapter } from "./hermes-attachment-adapter"

import type { RuntimeBundle, RuntimeInteractionActions } from "../contracts"
import {
  HermesNativeClient,
  type HermesNativeClientOptions,
} from "./hermes-native-client"
import { HermesThreadListAdapter } from "./hermes-thread-list"
import { createHermesMessageQueue } from "./hermes-message-queue"
import {
  projectHermesApprovalMessages,
  respondToHermesApproval,
} from "./hermes-approval"
import { createHermesWorkspace } from "./hermes-workspace"

const EMPTY_MESSAGES: readonly ThreadMessageLike[] = []
const COMPLETE_STATUS: MessageStatus = { type: "complete", reason: "unknown" }

export function createHermesInteractions(
  client: Pick<
    HermesNativeClient,
    "answerClarification" | "rejectClarification"
  >
): RuntimeInteractionActions {
  return {
    async respond(request, response) {
      await client.answerClarification(
        request.sessionId,
        request.requestId,
        response.answers
      )
    },
    async reject(request) {
      await client.rejectClarification(request.sessionId, request.requestId)
    },
  }
}

function useHermesThreadRuntime(
  client: HermesNativeClient,
  voice: HermesMediaBinding,
  locale: Locale,
  onError?: (error: Error) => void
) {
  const threadId = useAuiState((state) => state.threadListItem.remoteId)
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot
  )
  const session = threadId ? client.session(threadId) : undefined
  const profile = session?.profile
  const adapters = useMemo(
    () =>
      threadId && profile
        ? {
            ...voice.adapters(threadId, profile),
            attachments: new HermesAttachmentAdapter(),
          }
        : undefined,
    [profile, threadId, voice]
  )
  const queue = useMemo(
    () =>
      threadId
        ? createHermesMessageQueue(client, threadId, onError)
        : undefined,
    [client, onError, threadId]
  )

  useEffect(() => {
    if (!threadId) return
    let active = true
    void client
      .loadHistory(threadId)
      .then(() => (active ? client.attach(threadId) : undefined))
      .catch((reason) =>
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      )
    return () => {
      active = false
    }
  }, [client, onError, threadId])

  useEffect(() => {
    queue?.sync(session)
  }, [queue, session, snapshot.revision])

  return useExternalStoreRuntime<ThreadMessageLike>({
    adapters,
    messages: projectHermesApprovalMessages(
      session?.messages ?? EMPTY_MESSAGES,
      session?.approval,
      locale
    ),
    convertMessage: (message, index) =>
      fromThreadMessageLike(
        message,
        `hermes-message-${index}`,
        COMPLETE_STATUS
      ),
    isRunning: Boolean(session?.running),
    isLoading: Boolean(session?.loading),
    isDisabled: !threadId || !session,
    async onNew(message: AppendMessage) {
      if (!threadId) throw new Error("No Hermes Session is selected")
      try {
        await client.submit(threadId, message)
      } catch (reason) {
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
        throw reason
      }
    },
    async onEdit(message: AppendMessage) {
      if (!threadId) throw new Error("No Hermes Session is selected")
      try {
        await client.edit(threadId, message)
      } catch (reason) {
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
        throw reason
      }
    },
    async onReload(parentId: string | null) {
      if (!threadId || !parentId)
        throw new Error("Hermes regenerate is missing its user prompt")
      await client.regenerate(threadId, parentId)
    },
    async onCancel() {
      if (threadId) await client.stopRun(threadId)
    },
    async onRefetchThread() {
      if (threadId) await client.loadHistory(threadId)
    },
    async onRespondToToolApproval(response) {
      if (!threadId) throw new Error("No Hermes Session is selected")
      await respondToHermesApproval(client, threadId, response)
    },
    queue: queue?.controller.adapter,
  })
}

export type UseHermesRuntimeBundleOptions = HermesNativeClientOptions & {
  locale?: Locale
  onError?: (error: Error) => void
  onRecovered?: () => void
}

export function useHermesRuntimeBundle(
  options: UseHermesRuntimeBundleOptions
): RuntimeBundle & { client: HermesNativeClient; media: VoiceMediaController } {
  const onRecovered = options.onRecovered
  const client = useMemo(
    () =>
      new HermesNativeClient({
        baseUrl: options.baseUrl,
        fetcher: options.fetcher,
        socketFactory: options.socketFactory,
        pollIntervalMs: options.pollIntervalMs,
        reconnectDelayMs: options.reconnectDelayMs,
      }),
    [
      options.baseUrl,
      options.fetcher,
      options.pollIntervalMs,
      options.reconnectDelayMs,
      options.socketFactory,
    ]
  )
  const adapter = useMemo(() => new HermesThreadListAdapter(client), [client])
  const workspace = useMemo(() => createHermesWorkspace(client), [client])
  const interactions = useMemo(() => createHermesInteractions(client), [client])
  const artifacts = useMemo(
    () =>
      new HermesArtifactAdapter({
        baseUrl: options.baseUrl,
        client,
        fetcher: options.fetcher,
      }),
    [client, options.baseUrl, options.fetcher]
  )
  const audio = useMemo(
    () =>
      new HermesAudioClient({
        baseUrl: options.baseUrl,
        fetcher: options.fetcher,
      }),
    [options.baseUrl, options.fetcher]
  )
  const voice = useMemo(
    () =>
      new HermesMediaBinding(
        client,
        audio,
        options.locale ?? "en",
        options.onError
      ),
    [audio, client, options.locale, options.onError]
  )
  const onError = voice.handleNativeError
  useEffect(
    () => (onRecovered ? client.subscribeRecovery(onRecovered) : undefined),
    [client, onRecovered]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter,
    allowNesting: true,
    runtimeHook: function useRuntime() {
      return useHermesThreadRuntime(
        client,
        voice,
        options.locale ?? "en",
        onError
      )
    },
  })

  const selectedThread = useSyncExternalStore(
    assistantRuntime.threads.subscribe,
    () => {
      const state = assistantRuntime.threads.getState()
      const item = state.threadItems[state.mainThreadId]
      return item?.remoteId ?? item?.externalId
    }
  )
  useLayoutEffect(() => voice.connect(), [voice])
  useLayoutEffect(() => voice.select(selectedThread), [selectedThread, voice])

  useEffect(() => {
    const release = client.retain()
    void client
      .start()
      .catch((reason) =>
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      )
    return release
  }, [client, onError])

  useEffect(
    () =>
      client.subscribeCatalog(
        () => void assistantRuntime.threads.reload(),
        onError
      ),
    [assistantRuntime, client, onError]
  )

  return useMemo(
    () => ({
      assistantRuntime,
      workspace,
      interactions,
      artifacts,
      client,
      media: voice.media,
    }),
    [artifacts, assistantRuntime, client, interactions, workspace, voice]
  )
}
