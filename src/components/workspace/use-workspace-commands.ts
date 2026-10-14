"use client"

import type { ThreadRuntimeState } from "@assistant-ui/react"
import { useCallback, useMemo, useState, useSyncExternalStore } from "react"

import {
  copyMessage,
  retryMessage,
} from "@/components/assistant-ui/elements/message-actions"
import type { WorkspaceSurfaceRequests } from "@/components/assistant-ui/surface-requests"
import { useVoiceState } from "@/components/assistant-ui/voice/voice-context"
import {
  canAttemptSpeech,
  type VoiceMediaState,
} from "@/components/assistant-ui/voice/voice-media"
import { awaitsApproval } from "@/components/runtime-interactions/pending-interaction-context"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { sameData } from "@/lib/utils"
import { childSessionExtras } from "@/runtime-adapters/child-sessions"
import type {
  HarnessRuntime,
  SessionActionCapabilities,
} from "@/runtime-adapters/contracts"

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

const childSessionsOf = (state: ThreadRuntimeState) =>
  childSessionExtras.tryGet(state.extras)?.childSessions

/** The thread facts the commands' availability reads, one bit each. */
const EMPTY = 1
const RUNNING = 2
const QUEUES = 4
const DICTATES = 8
const CHILDREN_RUNNING = 16

/**
 * One cheap reading per thread change, packed into a number so the snapshot
 * is stable between changes and the workspace re-renders only when a fact
 * flips. Nothing here scans the messages.
 */
function threadFacts(state: ThreadRuntimeState) {
  return (
    (state.messages.length === 0 ? EMPTY : 0) |
    (state.isRunning ? RUNNING : 0) |
    (state.capabilities.queue === true ? QUEUES : 0) |
    (state.capabilities.dictation ? DICTATES : 0) |
    ((childSessionsOf(state)?.runningCount() ?? 0) > 0 ? CHILDREN_RUNNING : 0)
  )
}

const transcribes = (state: VoiceMediaState | undefined) =>
  canAttemptSpeech(state?.availability.transcription)

const sessionNames = (sessions: readonly CommandSession[]) =>
  sessions.map(({ sessionId, title, agentId }) => [sessionId, title, agentId])

/**
 * The Sessions `/resume` names, held while their ids and titles stay the
 * same: the workspace lists them afresh on every render, and the registry
 * would be rebuilt, and the composer re-rendered, with each list.
 */
function useNamedSessions(sessions: readonly CommandSession[]) {
  const [held, setHeld] = useState(sessions)
  if (
    held !== sessions &&
    !sameData(sessionNames(held), sessionNames(sessions))
  )
    setHeld(sessions)
  return held
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
    interactions,
    forkSession: forkSessionInBackground,
    startTurn,
    messageRewind,
    media,
    composer,
  } = bundle
  const subscribeThread = useCallback(
    (onChange: () => void) => runtime.thread.subscribe(onChange),
    [runtime]
  )
  const facts = useSyncExternalStore(subscribeThread, () =>
    threadFacts(runtime.thread.getState())
  )
  const transcriptionReady = useVoiceState(transcribes)
  const voiceAvailable =
    (facts & DICTATES) !== 0 &&
    transcriptionReady &&
    Boolean(media?.recordingSupported)
  const loadedSessions = useNamedSessions(navigation.loadedSessions)
  const {
    selectedAgentId,
    selectedAgentIsDraft,
    visibleThreadId,
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
      isThreadEmpty: (facts & EMPTY) !== 0,
      isRunning: (facts & RUNNING) !== 0,
      // The pending request the composer follows, read once as a command runs.
      hasPendingInteraction: () =>
        (visibleThreadId !== null &&
          interactions?.getPending(visibleThreadId) !== undefined) ||
        awaitsApproval(runtime.thread.getState().messages),
      canQueue: (facts & QUEUES) !== 0,
      canSteer: composer?.steer !== undefined,
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
      childrenRunning: (facts & CHILDREN_RUNNING) !== 0,
      cancelRunningChildren: () => {
        childSessionsOf(runtime.thread.getState())?.cancelRunning()
      },
      messages: () => runtime.thread.getState().messages,
      rewindAvailable: messageRewind !== false,
      // The message's own Retry and Copy, run on the message the command names.
      reloadMessage: (messageId) =>
        retryMessage(
          runtime.thread.getMessageById(messageId),
          messageRewind,
          media
        ),
      beginEdit: (messageId) => {
        runtime.thread.getMessageById(messageId).composer.beginEdit()
        surface.request({ kind: "revealMessage", messageId })
      },
      copyMessage: async (messageId) => {
        await copyMessage(runtime.thread.getMessageById(messageId).getState())
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
    composer?.context,
    composer?.model,
    composer?.steer,
    createSession,
    dictionary,
    facts,
    forkSession,
    forkSessionInBackground,
    interactions,
    loadedSessions,
    media,
    messageRewind,
    openSession,
    renameSession,
    reportActionError,
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
