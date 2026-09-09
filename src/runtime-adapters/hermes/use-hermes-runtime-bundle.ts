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
import { HermesMediaBinding } from "./hermes-media-binding"

import type { RuntimeBundle, RuntimeInteractionAdapter } from "../contracts"
import {
  HermesNativeClient,
  type HermesNativeClientOptions,
} from "./hermes-native-client"
import { HermesThreadListAdapter } from "./hermes-thread-list"
import { createHermesMessageQueue } from "./hermes-message-queue"
import { messageText } from "./hermes-native-codec"
import { createHermesWorkspace } from "./hermes-workspace"

const EMPTY_MESSAGES: readonly ThreadMessageLike[] = []
const COMPLETE_STATUS: MessageStatus = { type: "complete", reason: "unknown" }

export function createHermesInteractions(
  client: Pick<
    HermesNativeClient,
    "answerClarification" | "rejectClarification" | "answerApproval"
  >
): RuntimeInteractionAdapter {
  return {
    async respond(request, response) {
      if (request.kind === "question" && response.kind === "question") {
        await client.answerClarification(
          request.sessionId,
          request.requestId,
          response.answers
        )
        return
      }
      if (request.kind === "approval" && response.kind === "approval") {
        if (
          response.option !== "once" &&
          response.option !== "session" &&
          response.option !== "always" &&
          response.option !== "deny"
        )
          throw new Error("Hermes approval option is not supported")
        await client.answerApproval(
          request.sessionId,
          request.requestId,
          response.option
        )
        return
      }
      throw new Error("Hermes interaction response does not match its request")
    },
    async reject(request) {
      await client.rejectClarification(request.sessionId, request.requestId)
    },
  }
}

function useHermesThreadRuntime(
  client: HermesNativeClient,
  voice: HermesMediaBinding,
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
    () => (threadId && profile ? voice.adapters(threadId, profile) : undefined),
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
    messages: session?.messages ?? EMPTY_MESSAGES,
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
      await client.submit(threadId, message)
    },
    async onEdit(message: AppendMessage) {
      if (!threadId) throw new Error("No Hermes Session is selected")
      if (!message.sourceId)
        throw new Error("Hermes edit is missing its source message")
      const text = messageText(message)
      await client.editMessage(threadId, message.sourceId, text)
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
      return useHermesThreadRuntime(client, voice, onError)
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
      client,
      media: voice.media,
    }),
    [assistantRuntime, client, interactions, workspace, voice]
  )
}
