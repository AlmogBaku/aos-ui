import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
} from "@agentclientprotocol/sdk/experimental/v2"
import {
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
  HGW_ATTACHMENT_URI_SCHEME,
  HGW_JSONRPC_ERRORS,
  HGW_METHODS,
  HgwComposerPrefillNotificationSchema,
  HgwErrorNotificationSchema,
  type HgwHistoryCursor,
  type HgwPromptMetaSchema,
} from "@harness-gw/sdk/protocol"
import {
  type Logger,
  type AcpApprovals,
  subscribeHgwNotification,
  type AcpConnection,
} from "@harness-gw/sdk"
import { tabAcpLogger } from "@/runtime-adapters/aos/acp/tab"

import type { TodoItem } from "@/runtime-adapters/contracts"
import {
  queueControlsExtras,
  type QueueControlsExtras,
} from "@/runtime-adapters/queue-controls"
import {
  threadHistoryExtras,
  type ThreadHistoryState,
} from "@/runtime-adapters/thread-history"

import { createQueue, isBusyRefusal } from "./acp-message-queue"

// Lazy logger for background error reporting.
let _runtimeLog: Logger | undefined
const runtimeLog = () => (_runtimeLog ??= tabAcpLogger())
import {
  applyApprovals,
  applyUpdate,
  clearTranscript,
  failedWithoutReply,
  failLatestTurn,
  failSession,
  initialProjectorState,
  LOCAL_PROMPT_PREFIX,
  messageBlocks,
  prependMessages,
  renameMessage,
  replacedTurns,
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

type PromptMeta = z.infer<typeof HgwPromptMetaSchema>

export type AcpRuntimeExtras = {
  readonly execution: ProjectorExecution
  readonly todos: readonly TodoItem[]
  readonly configOptions?: readonly SessionConfigOption[]
  readonly commands?: readonly AvailableCommand[]
  /** The Session's older history, once a replay has said where it stands. */
  readonly history?: ThreadHistoryState
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
  /**
   * The connection's permission requests, shown and answered as tool
   * approvals. They outlive the thread, since the proxy sends each one once.
   */
  approvals?: AcpApprovals
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
   * Holds whatever else projects the Session for as long as the thread binds
   * it, joined before the replay so the projection sees all of it.
   */
  subscribeSession?: (sessionId: string) => () => void
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
    uri: `${HGW_ATTACHMENT_URI_SCHEME}${stage.stageId}/${attachment.id}`,
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
  [HGW_JSONRPC_ERRORS.turnInProgress]: "HGW_SESSION_BUSY",
  [HGW_JSONRPC_ERRORS.temporarilyUnavailable]: "HGW_PROVIDER_UNAVAILABLE",
}

/** How a resume ended: replayed, refused for good, or left behind by a rebinding. */
type ResumeOutcome = "replayed" | "refused" | "abandoned"

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
  approvals: AcpApprovals | undefined
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
  | "subscribeSession"
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
  approvals,
}: ControllerOptions) {
  let callbacks: ControllerCallbacks = {}
  let state = initialProjectorState
  /** unbound → bound: the Session this controller subscribes to and prompts. */
  let bound: string | undefined
  let unsubscribe: (() => void) | undefined
  /** Whether the Session the thread opened with has replayed its history. */
  let loading = openedWith !== undefined
  /** Rises with every binding, so a resume a rebinding left behind shows. */
  let bindings = 0
  let version = 0
  let locals = 0
  let repository = ExportedMessageRepository.fromArray([])
  let repositoryOf: ProjectorState | undefined
  const listeners = new Set<() => void>()

  /**
   * Older history. The cursor is what the latest replay reported, then what
   * each page after it did; `undefined` means no replay has said yet. A page
   * belongs to the transcript it was asked for: every replay start and settle,
   * binding, and accepted rewind bumps `transcripts`, and a page that lands
   * under another one is dropped. A page waits for any replay under way.
   */
  let pagesEnabled = false
  let cursor: HgwHistoryCursor | undefined
  /** An accepted rewind moved the provider's history under the cursor. */
  let cursorStale = false
  let olderLoading = false
  let olderFailed = false
  let transcripts = 0
  /** Accepted rewinds, so a replay that started before one leaves it stale. */
  let rewinds = 0
  /** The load that owns `olderLoading`, so a rebinding can release it. */
  let loads = 0

  const notify = () => {
    version += 1
    for (const listener of listeners) listener()
  }

  /**
   * A from-start replay arrives as one update per stored part, so a Session
   * with hundreds of them would rebuild the thread and repaint once per part
   * for a transcript the reader only ever sees whole. Every update still
   * applies in arrival order; only the telling waits until no replay is under
   * way, and until then the reader keeps the transcript it was last told.
   */
  let replaying = 0
  let untold = false
  let shown = state
  /**
   * The turns the latest replay replaces, until it drops them: at its first
   * update, or as it completes if it carried none. A refused replay drops
   * nothing, and one that fails partway is discarded, so the transcript stays
   * as the provider last replayed it until a later replay settles.
   */
  let replacing: ReadonlySet<string> | undefined

  const announce = () => {
    shown = state
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

  /** The provider's suggested next turn, for the bound Session's composer. */
  const observePrefill = (params: unknown) => {
    const parsed = HgwComposerPrefillNotificationSchema.safeParse(params)
    if (!parsed.success || parsed.data.sessionId !== bound) return
    callbacks.onComposerPrefill?.(parsed.data.text)
  }

  /** The provider turn a rewind replaces, paired with its projected id. */
  const rewindFor = (sourceId: string | null) => {
    const resolved = sourceId ? callbacks.messageRewind?.(sourceId) : undefined
    return resolved && sourceId ? { meta: resolved, sourceId } : undefined
  }

  /** Whether a resume still belongs to the binding that started it. */
  const isBound = (session: string, generation: number) =>
    bound === session && generation === bindings

  /**
   * Replays the Session from the start and says how that went. The
   * connection runs one replay at a time and waits out a refused join
   * itself, so only a Session gone at its provider is refused. The outcome
   * ends the thread's wait for its history, unless a rebinding left it
   * behind.
   */
  const replaySession = async (
    session: string,
    generation: number
  ): Promise<ResumeOutcome> => {
    let outcome: ResumeOutcome = "replayed"
    try {
      await connection.replay(session)
    } catch {
      outcome = isBound(session, generation) ? "refused" : "abandoned"
    }
    if (outcome !== "abandoned" && loading) {
      loading = false
      notify()
    }
    return outcome
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
    replaySession(session, generation).then(
      () => {
        if (isBound(session, generation)) commit(failLatestTurn(state, error))
      },
      (err: unknown) => runtimeLog().warn({ err }, "session.replay_failed")
    )
  }

  /**
   * Subscribes to one Session and replays it from the start. Resuming is what
   * binds a Session, so a draft's first turn resumes the Session it creates.
   */
  const bind = (next: string) => {
    if (next === bound) return
    unsubscribe?.()
    bound = next
    bindings += 1
    transcripts += 1
    cursor = undefined
    cursorStale = false
    olderLoading = false
    olderFailed = false
    const generation = bindings
    /** The provider reported the Session gone, so a restored transcript is. */
    let gone = false
    // What is already pending was sent before this thread bound the Session.
    const takeApprovals = () => {
      if (approvals) commit(applyApprovals(state, approvals.list(next)))
    }
    takeApprovals()
    const subscriptions = [
      callbacks.subscribeSession?.(next) ?? (() => {}),
      approvals?.subscribe(next, takeApprovals) ?? (() => {}),
      connection.subscribe(next, {
        update: (update, meta) => {
          const before = state
          const base =
            replacing === undefined ? state : clearTranscript(state, replacing)
          replacing = undefined
          commit(applyUpdate(base, update, meta))
          // A replayed failure is already what the provider holds.
          if (replaying === 0 && failedWithoutReply(before, state))
            failUnanswered(next, generation, state.execution.error)
        },
        // The replay carries the Session whole: it replaces the transcript,
        // and a fresh cursor comes with it.
        replay: () => {
          const prior = state
          const replaced = replacedTurns(state)
          replacing = replaced
          replaying += 1
          transcripts += 1
          const before = connection.history(next)
          const rewound = rewinds
          return (replayed) => {
            if (replacing === replaced) {
              replacing = undefined
              if (replayed) commit(clearTranscript(state, replaced))
            } else if (!replayed && isBound(next, generation)) {
              // Only part of the Session arrived. The approvals the replay
              // outlived, and a report that the Session is gone, lay over the
              // transcript it began from.
              commit(gone ? failSession(prior, { code: "not_found" }) : prior)
              takeApprovals()
            }
            transcripts += 1
            const after = connection.history(next)
            const moved = bound === next && after !== before
            if (moved) {
              cursor = after
              // A rewind accepted mid-replay may have moved what it already
              // read.
              if (rewinds === rewound) cursorStale = false
            }
            replaying -= 1
            if (replaying === 0 && untold) announce()
            else if (moved) notify()
          }
        },
      }),
      connection.subscribeNotification(
        HGW_METHODS.notify.composerPrefill,
        observePrefill
      ),
      // The provider no longer holds the Session, so nothing runs in it again.
      subscribeHgwNotification(
        connection,
        HGW_METHODS.notify.error,
        HgwErrorNotificationSchema,
        ({ sessionId, code }) => {
          if (sessionId !== bound || code !== "not_found") return
          gone = true
          commit(failSession(state, { code }))
        }
      ),
    ]
    unsubscribe = () => {
      for (const off of subscriptions) off()
    }
    replaySession(next, generation).catch((err: unknown) =>
      runtimeLog().warn({ err }, "session.replay_failed")
    )
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
    rewoundFrom?: string,
    holdBusy = false
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
      // The provider's positions moved under the cursor: the next page first
      // rebuilds the newest one, and a page still in flight is dropped.
      if (rewoundFrom !== undefined) {
        rewinds += 1
        cursorStale = true
        transcripts += 1
      }
    } catch (error) {
      const kept = state.messages
        .filter((message) => message.id !== localId)
        .map((message) => message.id)
      commit(retainMessages(state, kept))
      // A caller that sends again later is handed the busy refusal unshown.
      if (holdBusy && isBusyRefusal(error)) throw error
      throw refuse(error)
    }
  }

  /**
   * Reads the page before the cursor into a scratch projection and places its
   * messages first. Its turns are long over, so none of their state reaches
   * the live execution. One read at a time; a failure, of the page or of the
   * rebuild a stale cursor needs first, waits to be asked again.
   */
  const loadOlder = async () => {
    const session = bound
    if (
      !pagesEnabled ||
      session === undefined ||
      olderLoading ||
      replaying > 0 ||
      cursor?.nextCursor === undefined
    )
      return
    const load = (loads += 1)
    olderLoading = true
    olderFailed = false
    notify()
    try {
      if (cursorStale) {
        const generation = bindings
        if ((await replaySession(session, generation)) !== "replayed") {
          if (isBound(session, generation)) olderFailed = true
          return
        }
      }
      const from = cursor?.nextCursor
      if (bound !== session || cursorStale || from === undefined) return
      const transcript = transcripts
      try {
        const page = await connection.resumePage(session, from)
        if (transcript !== transcripts) return
        const older = page.updates.reduce(
          (scratch, { update, meta }) => applyUpdate(scratch, update, meta),
          initialProjectorState
        )
        cursor = page.history
        commit(prependMessages(state, older.messages))
      } catch {
        if (transcript === transcripts) olderFailed = true
      }
    } finally {
      if (load === loads) {
        olderLoading = false
        notify()
      }
    }
  }

  connection.initialized.then(
    ({ extensions }) => {
      pagesEnabled = extensions.historyPages
      notify()
    },
    // A failed handshake surfaces through the connection's status.
    (err: unknown) =>
      runtimeLog().warn({ err }, "acp.connection.initialized_failed")
  )

  return {
    getHistory: (): ThreadHistoryState | undefined =>
      pagesEnabled && cursor !== undefined
        ? {
            hasOlder: cursor.nextCursor !== undefined,
            truncated: cursor.truncated === true,
            loading: olderLoading,
            failed: olderFailed,
            loadOlder,
          }
        : undefined,
    setCallbacks: (next: ControllerCallbacks) => {
      callbacks = next
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    getState: () => shown,
    isLoading: () => loading,
    getRepository: () => {
      if (repositoryOf !== shown) {
        repository = toRepository(toThreadMessages(shown))
        repositoryOf = shown
      }
      return repository
    },
    /**
     * Binds the Session the thread list reports. A draft reports none, and its
     * own first turn has already bound the Session it created, so an absent one
     * never unbinds what is already subscribed.
     */
    bindSession: (next: string | undefined) => {
      if (next !== undefined) bind(next)
    },
    /** Unsubscribes from the Session, so a remount can resume it again. */
    unbindSession: () => {
      unsubscribe?.()
      unsubscribe = undefined
      bound = undefined
    },
    /** `holdBusy` hands a busy refusal back unshown, for a caller that retries. */
    send: async (message: AppendMessage, { holdBusy = false } = {}) => {
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
      // Every send carries a fresh clientId, so the proxy can recognize the
      // same turn delivered twice.
      const clientId = crypto.randomUUID()
      const rewound = rewindFor(message.sourceId)
      await prompt(
        sessionId,
        promptBlocks(message, staged),
        {
          ...rewound?.meta,
          ...(staged === undefined
            ? {}
            : { attachmentStageId: staged.stageId }),
          clientId,
        },
        rewound?.sourceId,
        holdBusy
      )
    },
    reload: async (parentId: string | null) => {
      // Only the turn's text is resent: its uploads were consumed when it was
      // first sent, so the provider re-attaches the turn's images itself from
      // the row the rewind replaces.
      const blocks = parentId
        ? messageBlocks(shown, parentId).filter(
            (block) => block.type === "text"
          )
        : []
      const rewound = rewindFor(parentId)
      if (!parentId || (blocks.length === 0 && rewound === undefined))
        throw new Error("An ACP retry needs the user turn it replaces")
      const sessionId = await boundSession()
      // Assistant UI's Retry is fire-and-forget, so no caller can observe a
      // rejection here. The refusal reaches the operator on the turn the prompt
      // reported it on; rethrowing would only raise an unobserved rejection.
      const clientId = crypto.randomUUID()
      await prompt(
        sessionId,
        blocks,
        { ...rewound?.meta, clientId },
        rewound?.sourceId
      ).catch((error: unknown) => {
        if (!isMessageNotSentError(error)) throw error
      })
    },
    cancel: () => {
      if (bound !== undefined) connection.cancel(bound)
    },
    respondToApproval: (
      approvalId: string,
      optionId: string,
      approved: boolean
    ) => {
      if (!approvals || bound === undefined)
        throw new Error("The ACP Session has no pending permission")
      return approvals.respond(bound, approvalId, optionId, approved)
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
  // Opted out of React Compiler: the store below reads the controller's
  // mutable state, keyed on the `version` token it subscribes to. The compiler
  // would drop that unread token from the keys and serve a stale store.
  "use no memo"
  const { connection, approvals, sessionId, enableMessageQueue, isDisabled } =
    options
  // One controller per mounted thread: a local draft gains its Session while
  // this thread stays mounted, so keying the store on that Session would
  // discard the very turn that created it, mid-prompt. Only the Session the
  // thread opened with has history to wait for, so the controller is built
  // around that one and the later binding moves underneath it.
  const [openedWith] = useState(sessionId)
  const controller = useMemo(
    () => createAcpController({ connection, approvals, sessionId: openedWith }),
    [approvals, connection, openedWith]
  )
  // Ordered before the binding so the first binding already holds the
  // caller's projection, and before the subscription so a replayed update
  // already reports.
  useEffect(() => {
    controller.setCallbacks({
      subscribeSession: options.subscribeSession,
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

  useEffect(() => binding?.watch(), [binding])

  const adapters = options.adapters
  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(() => {
    void version
    void queueItems
    void steerItems
    const state = controller.getState()
    const history = controller.getHistory()
    const extras: AcpRuntimeExtras & QueueControlsExtras = {
      execution: state.execution,
      todos: state.todos,
      ...(state.configOptions === undefined
        ? {}
        : { configOptions: state.configOptions }),
      ...(state.commands === undefined ? {} : { commands: state.commands }),
      ...(history === undefined ? {} : { history }),
      ...(binding && { queueControls: binding.controls }),
    }
    // The thread reads older history and queue controls through their
    // provider-neutral channels, stamped on the same object.
    threadHistoryExtras.provide(extras)
    queueControlsExtras.provide(extras)
    return {
      messageRepository: controller.getRepository(),
      isRunning: state.execution.status === "running",
      isLoading: controller.isLoading(),
      isDisabled: isDisabled ?? false,
      extras: acpExtras.provide(extras),
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
      // A permission answers with one of its own options, never a bare verdict.
      onRespondToToolApproval: ({ approvalId, optionId, approved }) => {
        if (optionId === undefined)
          throw new Error("A permission answer must choose one of its options")
        return controller.respondToApproval(approvalId, optionId, approved)
      },
      // No `setMessages`: with it, Stop before any reply unsends the prompt
      // into the composer, but the provider has already saved it.
      onImport: (messages) => controller.importMessages(messages),
      ...(adapters && { adapters }),
      ...(queue && { queue: queue.adapter }),
    }
  }, [
    adapters,
    binding,
    controller,
    isDisabled,
    queue,
    queueItems,
    steerItems,
    version,
  ])

  return useExternalStoreRuntime(store)
}
