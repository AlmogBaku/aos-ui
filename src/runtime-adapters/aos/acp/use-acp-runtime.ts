import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
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
  CompleteAttachment,
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
  AosComposerPrefillNotificationSchema,
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
 * stays an ordinary external store, as `useAgUiRuntime` composes it. The Session
 * binding is mutable, so a local draft keeps one store across the `session/new`
 * its first turn performs.
 */

type PromptMeta = z.infer<typeof AosPromptMetaSchema>

export type AcpRuntimeExtras = {
  readonly execution: ProjectorExecution
  readonly todos: readonly TodoItem[]
  readonly usage?: { readonly used: number; readonly size: number }
  readonly configOptions?: readonly SessionConfigOption[]
  readonly commands?: readonly AvailableCommand[]
}

/** One attachment of a staged batch, as the prompt links it. */
export type AcpStagedAttachment = {
  readonly id: string
  readonly name: string
  readonly contentType?: string
}

/** The server-owned batch a prompt references by id. */
export type AcpAttachmentStage = {
  readonly stageId: string
  readonly attachments: readonly AcpStagedAttachment[]
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
  /**
   * Attaches the Session instead of resuming it directly, so a caller that
   * already records what an attach reports stays the one that performs it.
   */
  attach?: (sessionId: string) => Promise<unknown>
  /**
   * Resolves the Session a local draft's turn belongs to, creating it when the
   * thread has none yet. The controller binds what it resolves before prompting.
   */
  resolveSessionId?: () => Promise<string | undefined>
  /** Uploads the composer's bytes; the prompt links the batch this staged. */
  stageAttachments?: (
    sessionId: string,
    attachments: readonly CompleteAttachment[]
  ) => Promise<AcpAttachmentStage>
  /** Resolves the provider turn a rewind replaces before Edit or Retry. */
  messageRewind?: (
    sourceUserId: string
  ) => { rewindSourceId: string } | undefined
  onStateChange?: (state: ProjectorState) => void
  /** The next turn the provider suggests for this Session's composer. */
  onComposerPrefill?: (text: string) => void
}

export const acpExtras = createRuntimeExtras<AcpRuntimeExtras>("useAcpRuntime")
export const useAcpExecution = () => acpExtras.use((extras) => extras.execution)
export const useAcpTodos = () => acpExtras.use((extras) => extras.todos)

const EMPTY_QUEUE_ITEMS: ExternalThreadQueueAdapter["items"] = Object.freeze([])
const subscribeNoop = () => () => {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Text the user wrote, plus links to the batch the proxy staged for it. */
function promptBlocks(
  message: AppendMessage,
  stage: AcpAttachmentStage | undefined
) {
  const text = message.content.flatMap((part) =>
    part.type === "text" && part.text.length > 0
      ? [{ type: "text" as const, text: part.text }]
      : []
  )
  if (stage === undefined) return text
  const links = stage.attachments.map((attachment) => ({
    type: "resource_link" as const,
    uri: `${AOS_ATTACHMENT_URI_SCHEME}${stage.stageId}/${attachment.id}`,
    name: attachment.name,
    ...(attachment.contentType === undefined
      ? {}
      : { mimeType: attachment.contentType }),
  }))
  return [...text, ...links]
}

type ControllerOptions = {
  connection: AcpConnection
  /** The Session this thread opened with; a local draft has none yet. */
  sessionId: string | undefined
  attach?: UseAcpRuntimeOptions["attach"]
  resolveSessionId?: UseAcpRuntimeOptions["resolveSessionId"]
  stageAttachments?: UseAcpRuntimeOptions["stageAttachments"]
}

/** The callers' latest callbacks, handed over each render like AG-UI's core. */
type ControllerCallbacks = Pick<
  UseAcpRuntimeOptions,
  "messageRewind" | "onStateChange" | "onComposerPrefill"
>

function createAcpController({
  sessionId: openedWith,
  connection,
  attach,
  resolveSessionId,
  stageAttachments,
}: ControllerOptions) {
  const resume =
    attach ??
    ((id: string) => connection.resumeSession(id, { replayFromStart: true }))
  let callbacks: ControllerCallbacks = {}
  let state = initialProjectorState
  /** unbound → bound: the Session this controller observes and prompts. */
  let bound: string | undefined
  let unsubscribe: (() => void) | undefined
  /** Whether the Session the thread opened with has replayed its history. */
  let loading = openedWith !== undefined
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
    if (!isRecord(params) || params.sessionId !== bound) return
    commit(applyNotification(state, method, params))
  }

  /** The provider's suggested next turn, for the bound Session's composer. */
  const observePrefill = (params: unknown) => {
    const parsed = AosComposerPrefillNotificationSchema.safeParse(params)
    if (!parsed.success || parsed.data.sessionId !== bound) return
    callbacks.onComposerPrefill?.(parsed.data.text)
  }

  /** The provider turn a rewind replaces, paired with its projected id. */
  const rewindFor = (sourceId: string | null) => {
    const resolved = sourceId ? callbacks.messageRewind?.(sourceId) : undefined
    return resolved && sourceId ? { meta: resolved, sourceId } : undefined
  }

  /**
   * Subscribes to one Session and replays it from the start. Attaching is what
   * binds a Session, so a draft's first turn attaches the Session it creates.
   */
  const bind = (next: string) => {
    if (next === bound) return
    unsubscribe?.()
    bound = next
    const { artifact, steerAccepted, composerPrefill } = AOS_METHODS.notify
    const subscriptions = [
      connection.onSessionUpdate(next, (update, meta) => {
        commit(applyUpdate(state, update, meta))
      }),
      connection.onNotification(artifact, (params) => {
        observe(params, artifact)
      }),
      connection.onNotification(steerAccepted, (params) => {
        observe(params, steerAccepted)
      }),
      connection.onNotification(composerPrefill, observePrefill),
    ]
    unsubscribe = () => {
      for (const off of subscriptions) off()
    }
    // A resume rejection surfaces through the connection's status and
    // `_aos/error`; the thread only stops waiting for its history.
    void resume(next)
      .catch(() => undefined)
      .finally(() => {
        if (!loading) return
        loading = false
        notify()
      })
  }

  /** The bound Session, creating one for a local draft's first turn. */
  const boundSession = async () => {
    if (bound !== undefined) return bound
    const resolved = await resolveSessionId?.()
    if (resolved === undefined)
      throw new Error("The ACP Session is not initialized")
    bind(resolved)
    return resolved
  }

  /** Uploads the turn's bytes so the prompt can link them by stage id. */
  const stage = async (sessionId: string, message: AppendMessage) => {
    const attachments = message.attachments ?? []
    if (attachments.length === 0) return undefined
    if (!stageAttachments)
      throw new Error("AOS attachment staging is unavailable")
    return stageAttachments(sessionId, attachments)
  }

  const prompt = async (
    sessionId: string,
    blocks: readonly ContentBlock[],
    meta: PromptMeta,
    rewoundFrom?: string
  ) => {
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
    /**
     * Binds the Session the thread list reports. A draft reports none, and its
     * own first turn has already bound the Session it created, so an absent one
     * never unbinds what is already observed.
     */
    bindSession: (next: string | undefined) => {
      if (next !== undefined) bind(next)
    },
    /** Leaves the Session unobserved, so a remount can attach it again. */
    unbindSession: () => {
      unsubscribe?.()
      unsubscribe = undefined
      bound = undefined
    },
    send: async (message: AppendMessage) => {
      const sessionId = await boundSession()
      const staged = await stage(sessionId, message)
      const rewound = rewindFor(message.sourceId)
      await prompt(
        sessionId,
        promptBlocks(message, staged),
        {
          ...rewound?.meta,
          ...(staged === undefined
            ? {}
            : { attachmentStageId: staged.stageId }),
        },
        rewound?.sourceId
      )
    },
    reload: async (parentId: string | null) => {
      const blocks = parentId ? messageBlocks(state, parentId) : []
      if (!parentId || blocks.length === 0)
        throw new Error("An ACP retry needs the user turn it replaces")
      const rewound = rewindFor(parentId)
      await prompt(
        await boundSession(),
        blocks,
        { ...rewound?.meta },
        rewound?.sourceId
      )
    },
    cancel: () => {
      if (bound !== undefined) connection.cancel(bound)
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
  const {
    attach,
    connection,
    sessionId,
    enableMessageQueue,
    isDisabled,
    resolveSessionId,
    stageAttachments,
  } = options
  // One controller per mounted thread: a local draft gains its Session while
  // this thread stays mounted, so keying the store on that Session would
  // discard the very turn that created it, mid-prompt. Only the Session the
  // thread opened with has history to wait for, so the controller is built
  // around that one and the later binding moves underneath it.
  const [openedWith] = useState(sessionId)
  const controller = useMemo(
    () =>
      createAcpController({
        connection,
        sessionId: openedWith,
        attach,
        resolveSessionId,
        stageAttachments,
      }),
    [attach, connection, openedWith, resolveSessionId, stageAttachments]
  )
  // Ordered before the subscription so a replayed update already reports.
  useEffect(() => {
    controller.setCallbacks({
      messageRewind: options.messageRewind,
      onStateChange: options.onStateChange,
      onComposerPrefill: options.onComposerPrefill,
    })
  })
  useEffect(() => {
    controller.bindSession(sessionId)
  }, [controller, sessionId])
  useEffect(() => () => controller.unbindSession(), [controller])

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
