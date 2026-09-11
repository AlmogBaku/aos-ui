import {
  fromThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"
import {
  composerUsageFromTokens,
  type ComposerModelOption,
} from "@/components/assistant-ui/composer-features"
import type { HarnessRuntime } from "@/runtime-adapters/contracts"
import type { Locale } from "@/lib/i18n/config"
import {
  DEFAULT_COMPOSER_FEATURE_CONFIG,
  type ComposerFeatureConfig,
} from "@shared/runtime-config"
import { OpenClawClient, type OpenClawClientOptions } from "./openclaw-client"
import {
  createOpenClawInteractions,
  createOpenClawQueue,
  createOpenClawWorkspace,
  OpenClawArtifactAdapter,
  OpenClawAttachmentAdapter,
  OpenClawThreadListAdapter,
  projectOpenClawApprovals,
  projectOpenClawArtifacts,
  submitOpenClawMessage,
} from "./openclaw-adapters"

const EMPTY_MESSAGES: readonly ThreadMessageLike[] = []
function useOpenClawThread(
  client: OpenClawClient,
  media: VoiceMediaController,
  locale: Locale
) {
  const threadId = useAuiState((state) => state.threadListItem.remoteId)
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot
  )
  const session = threadId ? client.session(threadId) : undefined
  const queue = useMemo(
    () =>
      threadId
        ? createOpenClawQueue(client, threadId, client.options.onError)
        : undefined,
    [client, threadId]
  )
  const adapters = useMemo(() => {
    const speech = threadId
      ? media.createAdapters(threadId, {
          transcribe: async () => {
            throw new Error("OpenClaw transcription is unavailable")
          },
          synthesize: (text, signal) => client.synthesize(text, signal),
          projectText: (text) => projectSpeechText(text, locale),
        }).speech
      : undefined
    return {
      attachments: new OpenClawAttachmentAdapter(),
      ...(snapshot.connection === "ready" &&
      (client.supports("talk.speak") || client.supports("tts.speak"))
        ? { speech }
        : {}),
    }
  }, [client, locale, media, threadId, snapshot.connection])
  useEffect(() => {
    if (!threadId || snapshot.connection !== "ready") return
    void client
      .loadHistory(threadId)
      .catch((reason: unknown) =>
        client.options.onError?.(
          reason instanceof Error ? reason : new Error(String(reason))
        )
      )
  }, [client, threadId, snapshot.connection])
  useEffect(() => {
    queue?.sync()
  }, [queue, snapshot.revision])
  const messages = projectOpenClawApprovals(
    session?.messages ?? EMPTY_MESSAGES,
    threadId ? client.pendingApprovals(threadId) : [],
    locale
  )
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    adapters,
    convertMessage: (message, index) =>
      fromThreadMessageLike(message, `openclaw:${threadId}:${index}`, {
        type: "complete",
        reason: "unknown",
      }),
    isRunning: session?.running ?? false,
    isLoading: session?.loading ?? false,
    isDisabled: !session || snapshot.connection !== "ready",
    async onNew(message) {
      if (!threadId) throw new Error("No OpenClaw Session selected")
      await submitOpenClawMessage(client, threadId, message)
    },
    async onCancel() {
      if (threadId) await client.stopRun(threadId)
    },
    async onRefetchThread() {
      if (threadId) await client.loadHistory(threadId)
    },
    async onRespondToToolApproval(response) {
      if (!threadId) throw new Error("No OpenClaw Session selected")
      const decision =
        response.optionId ?? (response.approved ? "allow-once" : "deny")
      if (
        decision !== "allow-once" &&
        decision !== "allow-always" &&
        decision !== "deny"
      )
        throw new Error("Unsupported OpenClaw approval choice")
      if (response.approved === (decision === "deny"))
        throw new Error("OpenClaw approval choice conflicts with decision")
      await client.answerApproval(threadId, response.approvalId, decision)
    },
    queue: queue?.controller.adapter,
  })
}

export function useOpenClawRuntime(
  options: OpenClawClientOptions,
  locale: Locale,
  composerConfig: ComposerFeatureConfig = DEFAULT_COMPOSER_FEATURE_CONFIG
): { runtime: HarnessRuntime; client: OpenClawClient } {
  const {
    gatewayUrl,
    token,
    password,
    creatorAgentId,
    createSocket,
    deviceAuth,
    onError,
  } = options
  const client = useMemo(
    () =>
      new OpenClawClient({
        gatewayUrl,
        token,
        password,
        creatorAgentId,
        createSocket,
        deviceAuth,
        onError,
      }),
    [
      gatewayUrl,
      token,
      password,
      creatorAgentId,
      createSocket,
      deviceAuth,
      onError,
    ]
  )
  const media = useMemo(() => new VoiceMediaController(), [])
  const adapter = useMemo(() => new OpenClawThreadListAdapter(client), [client])
  const workspace = useMemo(() => createOpenClawWorkspace(client), [client])
  const interactions = useMemo(
    () => createOpenClawInteractions(client),
    [client]
  )
  const resolver = useMemo(() => new OpenClawArtifactAdapter(client), [client])
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter,
    allowNesting: true,
    runtimeHook: function useRuntime() {
      return useOpenClawThread(client, media, locale)
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
  useEffect(
    () =>
      client.subscribeCatalog(() => {
        void assistantRuntime.threads
          .reload()
          .catch((reason: unknown) =>
            onError?.(
              reason instanceof Error ? reason : new Error(String(reason))
            )
          )
      }),
    [assistantRuntime, client, onError]
  )
  const [models, setModels] = useState<ComposerModelOption[]>([])
  useEffect(() => {
    void client
      .start()
      .catch((reason: unknown) =>
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      )
    return () => client.stop()
  }, [client, onError])
  useEffect(() => {
    if (
      snapshot.connection !== "ready" ||
      !composerConfig.modelSelectorEnabled ||
      !client.supports("models.list")
    )
      return
    let active = true
    void client
      .listModels()
      .then((result) => {
        if (active) setModels(result)
      })
      .catch((reason: unknown) =>
        onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      )
    return () => {
      active = false
    }
  }, [
    client,
    composerConfig.modelSelectorEnabled,
    onError,
    snapshot.connection,
  ])
  useLayoutEffect(() => {
    media.setScope(selectedThread)
  }, [media, selectedThread])
  useEffect(() => () => media.dispose(), [media])
  useEffect(() => {
    const session = selectedThread ? client.session(selectedThread) : undefined
    media.setSafelyIdle(
      snapshot.connection === "ready" &&
        session?.status === "idle" &&
        !session.running &&
        !session.loading &&
        !client.pendingApprovals(selectedThread ?? "").length &&
        !client.pendingQuestions(selectedThread ?? "").length
    )
    if (selectedThread)
      media.setAvailability(selectedThread, {
        transcription: "unavailable",
        speech:
          snapshot.connection === "ready" &&
          (client.supports("talk.speak") || client.supports("tts.speak"))
            ? "unverified"
            : "unavailable",
      })
    if (snapshot.connection !== "ready") {
      media.cancelCapture()
      media.stopSpeech()
    }
  }, [client, media, selectedThread, snapshot.revision, snapshot.connection])
  const selected = selectedThread ? client.session(selectedThread) : undefined
  const composer = {
    model:
      composerConfig.modelSelectorEnabled &&
      selectedThread &&
      selected?.model &&
      client.supports("sessions.patch") &&
      models.some((model) => model.id === selected.model)
        ? {
            options: models,
            selectedId: selected.model,
            select: (id: string) => client.selectModel(selectedThread, id),
          }
        : undefined,
    context:
      composerConfig.contextEnabled &&
      selected?.contextTokens &&
      selected.totalTokens !== undefined
        ? {
            usage: composerUsageFromTokens({
              systemTokens: 0,
              toolTokens: 0,
              messageTokens: 0,
              usedTokens: selected.totalTokens,
              maxTokens: selected.contextTokens,
            }),
            segments: [],
          }
        : undefined,
  }
  return {
    client,
    runtime: {
      assistantRuntime,
      workspace,
      interactions,
      artifacts: { resolver, projectMessages: projectOpenClawArtifacts },
      composer,
      media,
      activityCoverage: "active-session",
      environmentLabel: "OpenClaw",
    },
  }
}
