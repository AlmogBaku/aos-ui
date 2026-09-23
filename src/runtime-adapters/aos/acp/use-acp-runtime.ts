import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
  createMessageQueue,
  ExportedMessageRepository,
  isMessageNotSentError,
  MessageNotSentError,
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
  ThreadMessageLike,
} from "@assistant-ui/core"
import {
  createRuntimeExtras,
  useExternalStoreRuntime,
} from "@assistant-ui/core/react"
import type { z } from "zod"

import {
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AosComposerPrefillNotificationSchema,
  type AosPromptMetaSchema,
} from "@aos/protocol/acp"

import type { TodoItem } from "@/runtime-adapters/contracts"

import type { AcpConnection } from "./types"
import {
  applyNotification,
  applyUpdate,
  clearTranscript,
  failedWithoutReply,
  failLatestTurn,
  initialProjectorState,
  LOCAL_PROMPT_PREFIX,
  messageBlocks,
  renameMessage,
  retainMessages,
  toThreadMessages,
  type ProjectorExecution,
  type ProjectorState,
  type TurnFailure,
} from "./session-projector"

/**
 * The Assistant UI runtime over one ACP Session. A closure owns the projected
 * state, the connection subscriptions, and the prompt writes; the thread itself
 * stays an ordinary Assistant UI external store. The Session binding is
 * mutable, so a local draft keeps one store across the `session/new` its first
 * turn performs.
 */

type PromptMeta = z.infer<typeof AosPromptMetaSchema>

export type AcpRuntimeExtras = {
  readonly execution: ProjectorExecution
  readonly todos: readonly TodoItem[]
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
  /**
   * Localizes a normalized failure code, keeping the proxy's own description
   * for a code this build does not know.
   */
  describeRunError?: (code: string | undefined, fallback: string) => string
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

/**
 * Keeps the turns before the one the provider replaced, plus the turn just
 * echoed for it, which the rewind's own span would otherwise take with it.
 */
function rewound(
  state: ProjectorState,
  rewoundFrom: string | undefined,
  localId: string
) {
  if (rewoundFrom === undefined) return state
  const ids = state.messages.map((message) => message.id)
  const at = ids.indexOf(rewoundFrom)
  return at < 0 ? state : retainMessages(state, [...ids.slice(0, at), localId])
}

/** The normalized failure behind a refusal the operator can act on. */
const REFUSAL_CODES: Readonly<Record<number, string>> = {
  [AOS_JSONRPC_ERRORS.turnInProgress]: "AOS_SESSION_BUSY",
  [AOS_JSONRPC_ERRORS.temporarilyUnavailable]: "AOS_PROVIDER_UNAVAILABLE",
}

/** How long a refused resume waits before each further attempt. */
const RESUME_RETRY_DELAYS_MS = [500, 1000, 2000]

/** Whether the provider refused only because it is not ready yet. */
const isTemporarilyUnavailable = (error: unknown) =>
  isRecord(error) && error.code === AOS_JSONRPC_ERRORS.temporarilyUnavailable

/**
 * What the proxy refused a turn with, as copy the operator can read. The
 * normalized code carries the workspace's own wording; anything else keeps the
 * proxy's description rather than inventing one.
 */
function refusalText(
  error: unknown,
  describe: ControllerCallbacks["describeRunError"]
) {
  const code =
    isRecord(error) && typeof error.code === "number"
      ? REFUSAL_CODES[error.code]
      : undefined
  const reported = error instanceof Error ? error.message : String(error)
  return describe?.(code, reported) ?? reported
}

type ControllerOptions = {
  connection: AcpConnection
  /** The Session this thread opened with; a local draft has none yet. */
  sessionId: string | undefined
}

/**
 * The callers' latest callbacks, handed over on each render. Everything the
 * caller supplies belongs here rather than in the controller's identity: a
 * callback that changes identity mid-thread — one closing over the
 * `AssistantClient`, which a thread-list switch replaces — would otherwise
 * rebuild the controller and replay the whole Session a second time.
 */
type ControllerCallbacks = Pick<
  UseAcpRuntimeOptions,
  | "attach"
  | "resolveSessionId"
  | "stageAttachments"
  | "messageRewind"
  | "onStateChange"
  | "onComposerPrefill"
  | "describeRunError"
>

function createAcpController({
  sessionId: openedWith,
  connection,
}: ControllerOptions) {
  let callbacks: ControllerCallbacks = {}
  const resume = (id: string) =>
    callbacks.attach
      ? callbacks.attach(id)
      : connection.resumeSession(id, { replayFromStart: true })
  let state = initialProjectorState
  /** unbound → bound: the Session this controller observes and prompts. */
  let bound: string | undefined
  let unsubscribe: (() => void) | undefined
  /** Whether the Session the thread opened with has replayed its history. */
  let loading = openedWith !== undefined
  /** Rises with every binding, so an abandoned resume stops retrying. */
  let bindings = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let version = 0
  let locals = 0
  let repository = ExportedMessageRepository.fromArray([])
  let repositoryOf: ProjectorState | undefined
  const listeners = new Set<() => void>()

  const notify = () => {
    version += 1
    for (const listener of listeners) listener()
  }

  /**
   * A replay arrives as one update per stored part, so a Session with hundreds
   * of them would rebuild the thread and repaint once per part for a transcript
   * the reader only ever sees whole. Every update still applies in arrival
   * order; only the telling waits for the replay that carries them.
   */
  let replaying = 0
  let untold = false

  const announce = () => {
    untold = false
    notify()
    callbacks.onStateChange?.(state)
  }

  const commit = (next: ProjectorState) => {
    if (next === state) return
    state = next
    if (replaying > 0) {
      untold = true
      return
    }
    announce()
  }

  /** Holds a replay's updates back until the replay itself settles. */
  const whileReplaying = async (run: () => Promise<unknown>) => {
    replaying += 1
    try {
      return await run()
    } finally {
      replaying -= 1
      if (replaying === 0 && untold) announce()
    }
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
   * The replays asked for, in order. Two in flight at once would each clear the
   * transcript the other is still filling, so a resync waits for the replay it
   * arrived during rather than racing it.
   */
  let resumes: Promise<unknown> = Promise.resolve()

  /** Whether a resume still belongs to the binding that started it. */
  const isBound = (session: string, generation: number) =>
    bound === session && generation === bindings

  /**
   * Resumes one Session until its history is on its way. A rejection otherwise
   * surfaces through the connection's status and `_aos/error`; the thread only
   * stops waiting for its history. A `temporarily_unavailable` refusal is the
   * exception: the provider is still bringing the Session up, so the resume is
   * worth another try shortly, as long as this binding is still the live one.
   */
  const attemptResume = async (
    session: string,
    generation: number,
    retry = 0
  ) => {
    try {
      await whileReplaying(() => resume(session))
    } catch (error) {
      if (
        isTemporarilyUnavailable(error) &&
        retry < RESUME_RETRY_DELAYS_MS.length &&
        isBound(session, generation)
      ) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          void attemptResume(session, generation, retry + 1)
        }, RESUME_RETRY_DELAYS_MS[retry])
        return
      }
    }
    if (!loading) return
    loading = false
    notify()
  }

  const queueResume = (session: string, generation: number) => {
    const run = () =>
      isBound(session, generation)
        ? attemptResume(session, generation)
        : undefined
    // Either outcome of the resume ahead releases this one; a rejection there is
    // already reported where it happened.
    resumes = resumes.then(run, run)
    return resumes
  }

  /**
   * A run that failed before it wrote a reply has no turn to show the failure
   * on, and an edit it carried has already dropped turns the provider may still
   * hold. The failure reads where a refusal does, and the Session reloads so the
   * thread matches what the provider kept; the reload rebuilds the thread, so
   * the failure is shown again on the thread it rebuilt.
   */
  const failUnanswered = (
    session: string,
    generation: number,
    error: TurnFailure | undefined
  ) => {
    commit(failLatestTurn(state, error))
    void queueResume(session, generation).then(() => {
      if (isBound(session, generation)) commit(failLatestTurn(state, error))
    })
  }

  /**
   * Subscribes to one Session and replays it from the start. Attaching is what
   * binds a Session, so a draft's first turn attaches the Session it creates.
   */
  const bind = (next: string) => {
    if (next === bound) return
    unsubscribe?.()
    bound = next
    bindings += 1
    const generation = bindings
    const { steerAccepted, composerPrefill, sessionInvalidated } =
      AOS_METHODS.notify
    const subscriptions = [
      connection.onSessionUpdate(next, (update, meta) => {
        const before = state
        commit(applyUpdate(state, update, meta))
        // A replayed failure is already what the provider holds.
        if (replaying === 0 && failedWithoutReply(before, state))
          failUnanswered(next, generation, state.execution.error)
      }),
      // The replay that follows carries the Session whole, so the transcript it
      // replaces goes first.
      connection.onSessionReplay(next, () => {
        commit(clearTranscript(state))
      }),
      connection.onNotification(steerAccepted, (params) => {
        observe(params, steerAccepted)
      }),
      connection.onNotification(composerPrefill, observePrefill),
      // The proxy has dropped this Session's live subscriber, so whatever it
      // streamed while unobserved is missing: only a replay from the start can
      // say what the Session holds now.
      connection.onNotification(sessionInvalidated, (params) => {
        if (isRecord(params) && params.sessionId === bound)
          queueResume(next, generation)
      }),
    ]
    unsubscribe = () => {
      clearTimeout(retryTimer)
      retryTimer = undefined
      for (const off of subscriptions) off()
    }
    queueResume(next, generation)
  }

  /** The bound Session, creating one for a local draft's first turn. */
  const boundSession = async () => {
    if (bound !== undefined) return bound
    const resolved = await callbacks.resolveSessionId?.()
    if (resolved === undefined)
      throw new Error("The ACP Session is not initialized")
    bind(resolved)
    return resolved
  }

  /** Uploads the turn's bytes so the prompt can link them by stage id. */
  const stage = async (sessionId: string, message: AppendMessage) => {
    const attachments = message.attachments ?? []
    if (attachments.length === 0) return undefined
    const { stageAttachments } = callbacks
    if (!stageAttachments)
      throw new Error("AOS attachment staging is unavailable")
    return stageAttachments(sessionId, attachments)
  }

  /**
   * Reports a turn that never ran. Nothing is recoverable from the thread, so
   * the error is the signal Assistant UI hands back to the composer with the
   * operator's text and attachments.
   */
  const refuse = (error: unknown) => {
    const reported = refusalText(error, callbacks.describeRunError)
    // The refusal arrives already worded for the operator, so it fills the
    // description half of the one failure shape every failed turn carries.
    commit(failLatestTurn(state, { message: reported }))
    return new MessageNotSentError(reported)
  }

  const prompt = async (
    sessionId: string,
    blocks: readonly ContentBlock[],
    meta: PromptMeta,
    rewoundFrom?: string
  ) => {
    locals += 1
    const localId = `${LOCAL_PROMPT_PREFIX}${locals}`
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
      // Only an accepted turn replaces anything: the provider has dropped the
      // turns this one replaces, so the projection follows it here and the
      // rewound tail stops lingering beside the resent one. A refused prompt
      // leaves the transcript exactly as the provider still holds it.
      commit(
        renameMessage(rewound(state, rewoundFrom, localId), localId, messageId)
      )
    } catch (error) {
      const kept = state.messages
        .filter((message) => message.id !== localId)
        .map((message) => message.id)
      commit(retainMessages(state, kept))
      throw refuse(error)
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
        repository = toRepository(toThreadMessages(state))
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
      // A Session the provider could not create, or bytes it could not stage,
      // sent nothing either.
      let sessionId: string
      let staged: AcpAttachmentStage | undefined
      try {
        sessionId = await boundSession()
        staged = await stage(sessionId, message)
      } catch (error) {
        throw refuse(error)
      }
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
      const sessionId = await boundSession()
      // Assistant UI's Retry is fire-and-forget, so no caller can observe a
      // rejection here. The refusal reaches the operator on the turn the prompt
      // reported it on; rethrowing would only raise an unobserved rejection.
      await prompt(
        sessionId,
        blocks,
        { ...rewound?.meta },
        rewound?.sourceId
      ).catch((error: unknown) => {
        if (!isMessageNotSentError(error)) throw error
      })
    },
    cancel: () => {
      if (bound !== undefined) connection.cancel(bound)
    },
    importMessages: (messages: readonly ThreadMessage[]) => {
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

/** Holds the queue while a turn owns the Session. */
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

const threadMessages = new WeakMap<ThreadMessageLike, ThreadMessage>()

/**
 * The linear repository of a projected transcript. Each turn converts once per
 * projected revision, so a live update re-renders only the turns it changed:
 * `fromArray` would hand Assistant UI a fresh copy of every turn instead.
 */
function toRepository(
  messages: readonly ThreadMessageLike[]
): ExportedMessageRepository {
  let parentId: string | null = null
  return {
    messages: messages.map((like) => {
      let message = threadMessages.get(like)
      if (!message) {
        message = ExportedMessageRepository.fromArray([like]).messages[0]!
          .message
        threadMessages.set(like, message)
      }
      const item = { parentId, message }
      parentId = message.id
      return item
    }),
  }
}

export function useAcpRuntime(options: UseAcpRuntimeOptions): AssistantRuntime {
  const { connection, sessionId, enableMessageQueue, isDisabled } = options
  // One controller per mounted thread: a local draft gains its Session while
  // this thread stays mounted, so keying the store on that Session would
  // discard the very turn that created it, mid-prompt. Only the Session the
  // thread opened with has history to wait for, so the controller is built
  // around that one and the later binding moves underneath it.
  const [openedWith] = useState(sessionId)
  const controller = useMemo(
    () => createAcpController({ connection, sessionId: openedWith }),
    [connection, openedWith]
  )
  // Ordered before the binding so the first resume already reaches the caller's
  // `attach`, and before the subscription so a replayed update already reports.
  useEffect(() => {
    controller.setCallbacks({
      attach: options.attach,
      resolveSessionId: options.resolveSessionId,
      stageAttachments: options.stageAttachments,
      messageRewind: options.messageRewind,
      onStateChange: options.onStateChange,
      onComposerPrefill: options.onComposerPrefill,
      describeRunError: options.describeRunError,
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
      // No `setMessages`: with it, Stop before any reply unsends the prompt
      // into the composer, but the provider has already saved it.
      onImport: (messages) => controller.importMessages(messages),
      ...(adapters && { adapters }),
      ...(queue && { queue: queue.adapter }),
    }
  }, [adapters, controller, isDisabled, queue, queueItems, steerItems, version])

  return useExternalStoreRuntime(store)
}
