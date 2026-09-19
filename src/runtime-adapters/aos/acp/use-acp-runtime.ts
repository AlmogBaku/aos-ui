import { useEffect, useMemo, useSyncExternalStore } from "react"
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
  createMessageQueue,
  ExportedMessageRepository,
} from "@assistant-ui/core"
import type {
  AppendMessage,
  AssistantRuntime,
  AttachmentAdapter,
  DictationAdapter,
  ExternalStoreAdapter,
  ExternalThreadQueueAdapter,
  FeedbackAdapter,
  MessageQueueController,
  RealtimeVoiceAdapter,
  SpeechSynthesisAdapter,
  ThreadMessage,
} from "@assistant-ui/core"
import {
  createRuntimeExtras,
  useExternalStoreRuntime,
} from "@assistant-ui/core/react"
import type { z } from "zod"

import {
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_METHODS,
  type AosPromptMetaSchema,
} from "@aos/protocol/acp"

import type { TodoItem } from "@/runtime-adapters/contracts"

import type { AcpConnection } from "./types"
import {
  applyNotification,
  applyUpdate,
  initialProjectorState,
  messageBlocks,
  renameMessage,
  retainBefore,
  retainMessages,
  toThreadMessages,
  type ProjectorExecution,
  type ProjectorState,
} from "./session-projector"

/**
 * The Assistant UI runtime over one ACP Session. A closure owns the projected
 * state, the connection subscriptions, and the prompt writes; the thread itself
 * stays an ordinary external store, as `useAgUiRuntime` composes it.
 */

type PromptMeta = z.infer<typeof AosPromptMetaSchema>

export type AcpRuntimeExtras = {
  readonly execution: ProjectorExecution
  readonly todos: readonly TodoItem[]
  readonly usage?: { readonly used: number; readonly size: number }
  readonly configOptions?: readonly SessionConfigOption[]
  readonly commands?: readonly AvailableCommand[]
}

export type UseAcpRuntimeOptions = {
  connection: AcpConnection
  sessionId: string | undefined
  agentId: string
  isDisabled?: boolean
  enableMessageQueue?: boolean
  adapters?: {
    attachments?: AttachmentAdapter
    speech?: SpeechSynthesisAdapter
    dictation?: DictationAdapter
    voice?: RealtimeVoiceAdapter
    feedback?: FeedbackAdapter
  }
  /** Resolves the provider turn a rewind replaces before Edit or Retry. */
  messageRewind?: (
    sourceUserId: string
  ) => { rewindSourceId: string } | undefined
  onStateChange?: (state: ProjectorState) => void
}

export const acpExtras = createRuntimeExtras<AcpRuntimeExtras>("useAcpRuntime")
export const useAcpExecution = () => acpExtras.use((extras) => extras.execution)
export const useAcpTodos = () => acpExtras.use((extras) => extras.todos)

const EMPTY_QUEUE_ITEMS: ExternalThreadQueueAdapter["items"] = Object.freeze([])
const subscribeNoop = () => () => {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const attachmentStageId = (message: AppendMessage) => {
  const value = message.runConfig?.custom?.["aosAttachmentStageId"]
  return typeof value === "string" ? value : undefined
}

/** Text the user wrote, plus references to the batch the adapter staged. */
function promptBlocks(message: AppendMessage, stageId: string | undefined) {
  const text = message.content.flatMap((part) =>
    part.type === "text" && part.text.length > 0
      ? [{ type: "text" as const, text: part.text }]
      : []
  )
  if (stageId === undefined) return text
  const links = (message.attachments ?? []).map((attachment) => ({
    type: "resource_link" as const,
    uri: `${AOS_ATTACHMENT_URI_SCHEME}${stageId}/${attachment.id}`,
    name: attachment.name,
    ...(attachment.contentType === undefined
      ? {}
      : { mimeType: attachment.contentType }),
  }))
  return [...text, ...links]
}

type ControllerOptions = {
  connection: AcpConnection
  sessionId: string | undefined
}

/** The callers' latest callbacks, handed over each render like AG-UI's core. */
type ControllerCallbacks = Pick<
  UseAcpRuntimeOptions,
  "messageRewind" | "onStateChange"
>

function createAcpController({ connection, sessionId }: ControllerOptions) {
  let callbacks: ControllerCallbacks = {}
  let state = initialProjectorState
  let loading = sessionId !== undefined
  let version = 0
  let locals = 0
  let repository = ExportedMessageRepository.fromArray([])
  let repositoryOf: ProjectorState | undefined
  const listeners = new Set<() => void>()

  const notify = () => {
    version += 1
    for (const listener of listeners) listener()
  }

  const commit = (next: ProjectorState) => {
    if (next === state) return
    state = next
    notify()
    callbacks.onStateChange?.(state)
  }

  const observe = (params: unknown, method: string) => {
    if (!isRecord(params) || params.sessionId !== sessionId) return
    commit(applyNotification(state, method, params))
  }

  /** The provider turn a rewind replaces, paired with its projected id. */
  const rewindFor = (sourceId: string | null) => {
    const resolved = sourceId ? callbacks.messageRewind?.(sourceId) : undefined
    return resolved && sourceId ? { meta: resolved, sourceId } : undefined
  }

  const prompt = async (
    blocks: readonly ContentBlock[],
    meta: PromptMeta,
    rewoundFrom?: string
  ) => {
    if (sessionId === undefined)
      throw new Error("The ACP Session is not initialized")
    // The provider drops the replaced turns; the projection follows it here so
    // the rewound tail does not linger beside the resent one.
    if (rewoundFrom !== undefined) commit(retainBefore(state, rewoundFrom))
    locals += 1
    const localId = `aos-local-${locals}`
    const content = [...blocks]
    commit(
      applyUpdate(
        state,
        { sessionUpdate: "user_message", messageId: localId, content },
        undefined
      )
    )
    try {
      const { messageId } = await connection.prompt(sessionId, content, meta)
      commit(renameMessage(state, localId, messageId))
    } catch (error) {
      const kept = state.messages
        .filter((message) => message.id !== localId)
        .map((message) => message.id)
      commit(retainMessages(state, kept))
      throw error
    }
  }

  return {
    setCallbacks: (next: ControllerCallbacks) => {
      callbacks = next
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getVersion: () => version,
    getState: () => state,
    isLoading: () => loading,
    getRepository: () => {
      if (repositoryOf !== state) {
        repository = ExportedMessageRepository.fromArray(
          toThreadMessages(state)
        )
        repositoryOf = state
      }
      return repository
    },
    /** Subscribes and replays the Session from the start; returns the teardown. */
    attach: () => {
      if (sessionId === undefined) return undefined
      const { artifact, steerAccepted } = AOS_METHODS.notify
      const off = [
        connection.onSessionUpdate(sessionId, (update, meta) => {
          commit(applyUpdate(state, update, meta))
        }),
        connection.onNotification(artifact, (params) => {
          observe(params, artifact)
        }),
        connection.onNotification(steerAccepted, (params) => {
          observe(params, steerAccepted)
        }),
      ]
      // A resume rejection surfaces through the connection's status and
      // `_aos/error`; the thread only stops waiting for its history.
      void connection
        .resumeSession(sessionId, { replayFromStart: true })
        .catch(() => undefined)
        .finally(() => {
          loading = false
          notify()
        })
      return () => {
        for (const unsubscribe of off) unsubscribe()
      }
    },
    send: async (message: AppendMessage) => {
      const stageId = attachmentStageId(message)
      const rewound = rewindFor(message.sourceId)
      await prompt(
        promptBlocks(message, stageId),
        {
          ...rewound?.meta,
          ...(stageId === undefined ? {} : { attachmentStageId: stageId }),
        },
        rewound?.sourceId
      )
    },
    reload: async (parentId: string | null) => {
      const blocks = parentId ? messageBlocks(state, parentId) : []
      if (!parentId || blocks.length === 0)
        throw new Error("An ACP retry needs the user turn it replaces")
      const rewound = rewindFor(parentId)
      await prompt(blocks, { ...rewound?.meta }, rewound?.sourceId)
    },
    cancel: () => {
      if (sessionId !== undefined) connection.cancel(sessionId)
    },
    setMessages: (messages: readonly ThreadMessage[]) => {
      commit(
        retainMessages(
          state,
          messages.map((message) => message.id)
        )
      )
    },
  }
}

type AcpController = ReturnType<typeof createAcpController>

/** Holds the queue while a run owns the Session, as `useAgUiRuntime` does. */
function createQueue(controller: AcpController) {
  let busyEdges = 0
  const queue: MessageQueueController = createMessageQueue({
    run: (message) => {
      const edgesAtDispatch = busyEdges
      // The queue drops the item before dispatching and stays busy until an
      // idle edge releases it. A send that never becomes busy — a rejection,
      // or a run the provider refused — has to be released here instead.
      const releaseIfNoRun = () => {
        if (busyEdges === edgesAtDispatch) queue.notifyIdle()
      }
      void controller.send(message).then(releaseIfNoRun, releaseIfNoRun)
    },
  })
  return { queue, markBusy: () => (busyEdges += 1) }
}

export function useAcpRuntime(options: UseAcpRuntimeOptions): AssistantRuntime {
  const { connection, sessionId, enableMessageQueue, isDisabled } = options
  const controller = useMemo(
    () => createAcpController({ connection, sessionId }),
    [connection, sessionId]
  )
  // Ordered before the subscription so a replayed update already reports.
  useEffect(() => {
    controller.setCallbacks({
      messageRewind: options.messageRewind,
      onStateChange: options.onStateChange,
    })
  })
  useEffect(() => controller.attach(), [controller])

  const binding = useMemo(
    () => (enableMessageQueue ? createQueue(controller) : undefined),
    [controller, enableMessageQueue]
  )
  const queue = binding?.queue

  const version = useSyncExternalStore(
    controller.subscribe,
    controller.getVersion
  )
  const queueItems = useSyncExternalStore(
    queue?.subscribe ?? subscribeNoop,
    () => queue?.adapter.items ?? EMPTY_QUEUE_ITEMS,
    () => EMPTY_QUEUE_ITEMS
  )
  const steerItems = useSyncExternalStore(
    queue?.subscribe ?? subscribeNoop,
    () => queue?.adapter.steerItems ?? EMPTY_QUEUE_ITEMS,
    () => EMPTY_QUEUE_ITEMS
  )

  const status = controller.getState().execution.status
  const busy = status === "running" || status === "waiting-for-input"
  useEffect(() => {
    if (!binding) return
    if (busy) {
      binding.markBusy()
      binding.queue.notifyBusy()
    } else {
      binding.queue.notifyIdle()
    }
  }, [binding, busy])

  const adapters = options.adapters
  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(() => {
    void version
    void queueItems
    void steerItems
    const state = controller.getState()
    return {
      messageRepository: controller.getRepository(),
      isRunning: state.execution.status === "running",
      isLoading: controller.isLoading(),
      isDisabled: isDisabled ?? false,
      extras: acpExtras.provide({
        execution: state.execution,
        todos: state.todos,
        ...(state.usage === undefined ? {} : { usage: state.usage }),
        ...(state.configOptions === undefined
          ? {}
          : { configOptions: state.configOptions }),
        ...(state.commands === undefined ? {} : { commands: state.commands }),
      }),
      onNew: (message) => controller.send(message),
      onEdit: (message) => {
        queue?.clear()
        return controller.send(message)
      },
      onReload: (parentId) => {
        queue?.clear()
        return controller.reload(parentId)
      },
      onCancel: async () => {
        queue?.notifyCancelled()
        controller.cancel()
      },
      setMessages: (messages) => controller.setMessages(messages),
      onImport: (messages) => controller.setMessages(messages),
      ...(adapters && { adapters }),
      ...(queue && { queue: queue.adapter }),
    }
  }, [adapters, controller, isDisabled, queue, queueItems, steerItems, version])

  return useExternalStoreRuntime(store)
}
