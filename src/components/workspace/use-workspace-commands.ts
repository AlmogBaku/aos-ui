"use client"

import type { AssistantRuntime, ThreadState } from "@assistant-ui/react"
import { useCallback, useMemo, useSyncExternalStore } from "react"

import { answerText } from "@/components/assistant-ui/elements/turn-fold"
import { useVoiceState } from "@/components/assistant-ui/voice/voice-context"
import {
  canAttemptSpeech,
  type VoiceMediaState,
} from "@/components/assistant-ui/voice/voice-media"
import { awaitsApproval } from "@/components/runtime-interactions/pending-interaction-context"
import { useHasPendingInteraction } from "@/components/runtime-interactions/use-has-pending-interaction"
import { copyMarkdownToClipboard } from "@/lib/clipboard"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { childSessionExtras } from "@/runtime-adapters/child-sessions"
import type {
  HarnessRuntime,
  SessionActionCapabilities,
} from "@/runtime-adapters/contracts"

import type { WorkspaceSurfaceRequests } from "./surface-requests"
import {
  buildWorkspaceCommands,
  type CommandSession,
  type WorkspaceCommand,
} from "./workspace-commands"

/** The workspace navigation the commands open, rename, and make Sessions with. */
export type WorkspaceCommandNavigation = {
  readonly selectedAgentId: string | null
  readonly selectedAgentIsDraft: boolean
  readonly visibleThreadId: string | null
  readonly loadedSessions: readonly CommandSession[]
  readonly sessionActions: SessionActionCapabilities | null
  readonly openSession: (sessionId: string, agentId?: string) => Promise<void>
  readonly renameSession: (sessionId: string, title: string) => Promise<void>
  readonly createSession: (agentId: string) => Promise<void>
  readonly forkSession: (sessionId: string) => Promise<string>
}

/**
 * One reading of the thread as a primitive, so a change re-renders and the
 * snapshot stays stable between changes.
 */
function useThreadValue<T extends boolean | number>(
  runtime: AssistantRuntime,
  select: (state: ThreadState) => T
): T {
  const subscribe = useCallback(
    (onChange: () => void) => runtime.thread.subscribe(onChange),
    [runtime]
  )
  return useSyncExternalStore(subscribe, () =>
    select(runtime.thread.getState())
  )
}

const childSessionsOf = (state: ThreadState) =>
  childSessionExtras.tryGet(state.extras)?.childSessions
const isEmpty = (state: ThreadState) => state.messages.length === 0
const isRunning = (state: ThreadState) => state.isRunning
const canQueue = (state: ThreadState) => state.capabilities.queue === true
const canDictate = (state: ThreadState) => state.capabilities.dictation
const awaitsOperator = (state: ThreadState) => awaitsApproval(state.messages)
const runningChildrenOf = (state: ThreadState) =>
  childSessionsOf(state)?.runningCount() ?? 0
const transcribes = (state: VoiceMediaState | undefined) =>
  canAttemptSpeech(state?.availability.transcription)

/** Centers a message the thread has mounted; the editor's focus did the rest. */
function revealMessage(messageId: string) {
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      ?.scrollIntoView?.({ block: "center" })
  )
}

/**
 * The workspace's slash command registry for the Session in view, built from
 * the workspace's own actions; none while no Agent, or a draft Agent, is
 * selected.
 */
export function useWorkspaceCommands({
  bundle,
  dictionary,
  navigation,
  surface,
  reportActionError,
}: {
  bundle: HarnessRuntime
  dictionary: Dictionary
  navigation: WorkspaceCommandNavigation
  surface: WorkspaceSurfaceRequests
  reportActionError: (error: unknown) => void
}): readonly WorkspaceCommand[] | undefined {
  const {
    assistantRuntime: runtime,
    workspace,
    forkSession: forkSessionInBackground,
    startTurn,
    messageRewind,
    media,
    composer,
  } = bundle
  const isThreadEmpty = useThreadValue(runtime, isEmpty)
  const running = useThreadValue(runtime, isRunning)
  const queues = useThreadValue(runtime, canQueue)
  const dictates = useThreadValue(runtime, canDictate)
  const awaitingApproval = useThreadValue(runtime, awaitsOperator)
  const runningChildren = useThreadValue(runtime, runningChildrenOf)
  const pendingQuestion = useHasPendingInteraction(
    bundle.interactions,
    navigation.visibleThreadId ?? undefined
  )
  const transcriptionReady = useVoiceState(transcribes)
  const voiceAvailable =
    dictates && transcriptionReady && Boolean(media?.recordingSupported)
  const {
    selectedAgentId,
    selectedAgentIsDraft,
    visibleThreadId,
    loadedSessions,
    sessionActions,
    openSession,
    renameSession,
    createSession,
    forkSession,
  } = navigation

  return useMemo(() => {
    if (!selectedAgentId || selectedAgentIsDraft) return undefined
    return buildWorkspaceCommands({
      dictionary,
      selectedAgentId,
      visibleThreadId,
      isThreadEmpty,
      isRunning: running,
      hasPendingInteraction: pendingQuestion || awaitingApproval,
      canQueue: queues,
      loadedSessions,
      searchSessions: workspace.searchSessions,
      openSession,
      canRename: sessionActions?.rename === true,
      renameSession,
      createSession,
      createSessionInBackground: (agentId) =>
        workspace.createSession(agentId, {
          title: dictionary.actions.newSession,
        }),
      // Navigation's fork always exists and refuses where the runtime cannot.
      forkSession: forkSessionInBackground ? forkSession : undefined,
      forkSessionInBackground,
      startTurn,
      reportActionError,
      cancelRun: () => runtime.thread.cancelRun(),
      runningChildren,
      cancelRunningChildren: () => {
        childSessionsOf(runtime.thread.getState())?.cancelRunning()
      },
      messages: () => runtime.thread.getState().messages,
      rewindAvailable: messageRewind !== false,
      // As the message's own Retry does: a rewinding runtime replays from the
      // user turn the answer came from, and reading aloud stops.
      reloadMessage: (messageId) => {
        if (messageRewind === false) return
        const message = runtime.thread.getMessageById(messageId)
        const sourceId = message.getState().parentId
        if (!messageRewind) message.reload()
        else if (sourceId)
          message.reload({ runConfig: messageRewind.runConfig(sourceId) })
        media?.stopSpeech()
        media?.disarm()
      },
      beginEdit: (messageId) => {
        runtime.thread.getMessageById(messageId).composer.beginEdit()
        revealMessage(messageId)
      },
      copyMessage: async (messageId) => {
        const { content } = runtime.thread.getMessageById(messageId).getState()
        await copyMarkdownToClipboard(answerText(content))
      },
      // Sent through Assistant UI's own send, so the text is never read as a
      // command again: `/queue /reset` reaches the runtime as written.
      queueText: (text) => {
        runtime.thread.composer.setText(text)
        runtime.thread.composer.send({ steer: false })
      },
      model: composer?.model,
      contextAvailable: composer?.context !== undefined,
      voiceAvailable,
      surface,
    })
  }, [
    awaitingApproval,
    composer?.context,
    composer?.model,
    createSession,
    dictionary,
    forkSession,
    forkSessionInBackground,
    isThreadEmpty,
    loadedSessions,
    media,
    messageRewind,
    openSession,
    pendingQuestion,
    queues,
    renameSession,
    reportActionError,
    running,
    runningChildren,
    runtime,
    selectedAgentId,
    selectedAgentIsDraft,
    sessionActions?.rename,
    startTurn,
    surface,
    visibleThreadId,
    voiceAvailable,
    workspace,
  ])
}
