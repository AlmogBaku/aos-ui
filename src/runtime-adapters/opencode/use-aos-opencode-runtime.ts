"use client"

import {
  ExportedMessageRepository,
  pickExternalStoreSharedOptions,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type RespondToToolApprovalOptions,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import {
  OpenCodeAttachmentAdapter,
  OpenCodeEventSource,
  OpenCodeThreadController,
  createOpenCodeThreadState,
  projectOpenCodeThreadMessages,
  useOpenCodeStreamingTiming,
  type OpenCodeRuntimeOptions,
  type OpenCodeServerEvent,
  type OpenCodeThreadControllerLike,
  type OpenCodeThreadState,
  type OpenCodeUserMessageOptions,
  type OpencodeClient,
} from "@assistant-ui/react-opencode"
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { aosOpenCodeExtras } from "./opencode-runtime-extras"
import {
  createOpenCodeSessionQueue,
  type OpenCodeSessionQueue,
} from "./opencode-runtime-queue"
import { createAosOpenCodeThreadListAdapter } from "./opencode-thread-list"

const REQUEST_OPTIONS = { throwOnError: true } as const
const EMPTY_ITEMS = [] as const
const EMPTY_THREAD_STATE = createOpenCodeThreadState("")
const subscribeNoop = () => () => undefined

export type AosOpenCodeRuntimeOptions = OpenCodeRuntimeOptions & {
  /** Native undo only: reload's scoped-client undo also replays the old input. */
  revertForEdit?: (sessionId: string, messageId: string) => Promise<void>
}

type EventListener = (event: OpenCodeServerEvent) => void

export class AosOpenCodeEventHub {
  readonly #source: OpenCodeEventSource
  readonly #listeners = new Set<EventListener>()
  #unsubscribe: (() => void) | undefined

  constructor(client: OpencodeClient) {
    this.#source = new OpenCodeEventSource(client)
  }

  readonly subscribe = (listener: EventListener) => {
    this.#listeners.add(listener)
    this.#unsubscribe ??= this.#source.subscribe(this.emit)
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) {
        this.#unsubscribe?.()
        this.#unsubscribe = undefined
      }
    }
  }

  readonly emit = (event: OpenCodeServerEvent) => {
    for (const listener of this.#listeners) listener(event)
  }

  dispose() {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#source.dispose()
    this.#listeners.clear()
  }
}

type QueueEntry = {
  queue: OpenCodeSessionQueue
  options: OpenCodeRuntimeOptions
}

type Registry = {
  hub: AosOpenCodeEventHub
  controllers: Map<string, OpenCodeThreadController>
  controllerStops: Map<string, () => void>
  queues: Map<OpenCodeThreadControllerLike, QueueEntry>
  hydrated: Set<string>
  dispose(): void
}

function createRegistry(hub: AosOpenCodeEventHub): Registry {
  const controllers = new Map<string, OpenCodeThreadController>()
  const controllerStops = new Map<string, () => void>()
  const queues = new Map<OpenCodeThreadControllerLike, QueueEntry>()
  const hydrated = new Set<string>()
  return {
    hub,
    controllers,
    controllerStops,
    queues,
    hydrated,
    dispose() {
      hub.dispose()
      for (const stop of controllerStops.values()) stop()
      controllerStops.clear()
      for (const controller of controllers.values()) controller.dispose()
      for (const entry of queues.values()) entry.queue.clear()
      queues.clear()
      hydrated.clear()
    },
  }
}

function getController(
  registry: Registry,
  client: OpencodeClient,
  sessionId: string
) {
  const existing = registry.controllers.get(sessionId)
  if (existing) return existing
  const controller = new OpenCodeThreadController(
    client,
    () => ({ subscribe: registry.hub.subscribe }) as OpenCodeEventSource,
    sessionId
  )
  registry.controllers.set(sessionId, controller)
  registry.controllerStops.set(
    sessionId,
    controller.subscribe(() => undefined)
  )
  return controller
}

export async function hydrateOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  emit: (event: OpenCodeServerEvent) => void
) {
  const [statuses, permissions, questions] = await Promise.all([
    client.session.status({}, REQUEST_OPTIONS),
    client.permission.list(undefined, REQUEST_OPTIONS),
    client.question.list(undefined, REQUEST_OPTIONS),
  ])
  const status = statuses.data?.[sessionId]
  emit({
    type: status ? "session.status" : "session.idle",
    sessionId,
    properties: status
      ? { sessionID: sessionId, status }
      : { sessionID: sessionId },
    raw: status,
  })
  for (const item of permissions.data ?? []) {
    if (item.sessionID !== sessionId) continue
    emit({
      type: "permission.asked",
      sessionId,
      properties: item as unknown as Record<string, unknown>,
      raw: item,
    })
  }
  for (const item of questions.data ?? []) {
    if (item.sessionID !== sessionId) continue
    emit({
      type: "question.asked",
      sessionId,
      properties: item as unknown as Record<string, unknown>,
      raw: item,
    })
  }
}

async function hydrateNativeState(
  registry: Registry,
  client: OpencodeClient,
  sessionId: string
) {
  if (registry.hydrated.has(sessionId)) return
  registry.hydrated.add(sessionId)
  try {
    await hydrateOpenCodeSession(client, sessionId, registry.hub.emit)
  } catch (error) {
    registry.hydrated.delete(sessionId)
    throw error
  }
}

const NOOP_CONTROLLER: OpenCodeThreadControllerLike = {
  getState: () => EMPTY_THREAD_STATE,
  subscribe: subscribeNoop,
  load: async () => undefined,
  refresh: async () => undefined,
  sendMessage: async () => undefined,
  stageMessage: async () => undefined,
  sendStagedMessage: async () => false,
  cancel: async () => undefined,
  revert: async () => undefined,
  unrevert: async () => undefined,
  fork: async () => "",
  replyToPermission: async () => undefined,
  replyToQuestion: async () => undefined,
  rejectQuestion: async () => undefined,
}

function isBlocked(state: OpenCodeThreadState) {
  return (
    state.runState.type === "streaming" ||
    state.runState.type === "cancelling" ||
    state.runState.type === "reverting" ||
    state.sessionStatus?.type === "busy" ||
    state.sessionStatus?.type === "retry" ||
    Object.keys(state.interactions.permissions.pending).length > 0 ||
    Object.keys(state.interactions.questions.pending).length > 0
  )
}

function sendOptions(
  options: OpenCodeRuntimeOptions,
  controller: OpenCodeThreadControllerLike
): OpenCodeUserMessageOptions {
  const selected = controller.getState().session?.model
  return {
    model:
      typeof selected?.id === "string" &&
      selected.id &&
      typeof selected.providerID === "string" &&
      selected.providerID
        ? { modelID: selected.id, providerID: selected.providerID }
        : options.defaultModel,
    agent: options.defaultAgent,
  }
}

function reportError(options: OpenCodeRuntimeOptions, error: unknown) {
  void Promise.resolve(options.onError?.(error)).catch((callbackError) => {
    console.error("OpenCode error callback failed", callbackError)
  })
}

function sendMessage(
  controller: OpenCodeThreadControllerLike,
  message: AppendMessage,
  options: OpenCodeRuntimeOptions
) {
  return (message.startRun ?? message.role === "user")
    ? controller.sendMessage(message, sendOptions(options, controller))
    : controller.stageMessage(message, sendOptions(options, controller))
}

function toPermissionResponse({
  approved,
  optionId,
}: RespondToToolApprovalOptions) {
  if (optionId === undefined)
    return approved ? ("once" as const) : ("reject" as const)
  if (optionId === "once" || optionId === "always") {
    if (!approved)
      throw new Error(`OpenCode permission ${optionId} must approve`)
    return optionId
  }
  if (optionId === "reject") {
    if (approved) throw new Error("OpenCode reject permission must reject")
    return optionId
  }
  throw new Error(`Unknown OpenCode permission option: ${optionId}`)
}

function getQueue(
  registry: Registry,
  controller: OpenCodeThreadControllerLike,
  options: OpenCodeRuntimeOptions
) {
  const existing = registry.queues.get(controller)
  if (existing) {
    existing.options = options
    return existing.queue
  }
  const entry = {} as QueueEntry
  entry.options = options
  entry.queue = createOpenCodeSessionQueue(
    controller,
    () => sendOptions(entry.options, controller),
    (error) => reportError(entry.options, error)
  )
  registry.queues.set(controller, entry)
  return entry.queue
}

function useThreadStore(
  registry: Registry,
  client: OpencodeClient,
  controller: OpenCodeThreadControllerLike,
  options: AosOpenCodeRuntimeOptions,
  queue: OpenCodeSessionQueue | undefined,
  sessionId: string | undefined
): ExternalStoreAdapter<ThreadMessage> {
  const onLoadError = useEffectEvent((error: unknown) =>
    reportError(options, error)
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  )
  useEffect(() => {
    if (controller === NOOP_CONTROLLER || !sessionId) return
    void controller
      .load()
      .then(() => hydrateNativeState(registry, client, sessionId))
      .catch(onLoadError)
  }, [client, controller, registry, sessionId])

  const blocked = isBlocked(state)
  useEffect(() => queue?.syncBlocked(blocked), [blocked, queue])
  const queueItems = useSyncExternalStore(
    queue?.subscribe ?? subscribeNoop,
    () => queue?.adapter.items ?? EMPTY_ITEMS,
    () => EMPTY_ITEMS
  )
  const steerItems = useSyncExternalStore(
    queue?.subscribe ?? subscribeNoop,
    () => queue?.adapter.steerItems ?? EMPTY_ITEMS,
    () => EMPTY_ITEMS
  )
  const timing = useOpenCodeStreamingTiming(state, blocked)
  const messages = useMemo(
    () =>
      ExportedMessageRepository.fromArray(
        projectOpenCodeThreadMessages(state, timing)
      ),
    [state, timing]
  )
  const extras = useMemo(
    () =>
      aosOpenCodeExtras.provide({
        session: state.session,
        state,
        permissions: state.interactions.permissions.pending,
        questions: state.interactions.questions.pending,
        fork: (id) => controller.fork(id),
        revert: (id) => controller.revert(id),
        unrevert: () => controller.unrevert(),
        cancel: () => controller.cancel(),
        refresh: () => controller.refresh(),
        replyToPermission: (id, response) =>
          controller.replyToPermission(id, response),
        replyToQuestion: (id, answers) =>
          controller.replyToQuestion(id, answers),
        rejectQuestion: (id) => controller.rejectQuestion(id),
      }),
    [controller, state]
  )
  const queueAdapter = useMemo(
    () =>
      queue
        ? {
            ...queue.adapter,
            items: queueItems,
            steerItems,
          }
        : undefined,
    [queue, queueItems, steerItems]
  )

  return useMemo(
    () => ({
      ...pickExternalStoreSharedOptions(options),
      isLoading: state.loadState.type === "loading",
      isRunning: blocked,
      messageRepository: messages,
      extras,
      ...(options.adapters && { adapters: options.adapters }),
      ...(queueAdapter && { queue: queueAdapter }),
      onNew: async (message: AppendMessage) => {
        try {
          await sendMessage(controller, message, options)
        } catch (error) {
          reportError(options, error)
          throw error
        }
      },
      ...(options.revertForEdit && {
        onEdit: async (message: AppendMessage) => {
          if (!sessionId || !message.sourceId)
            throw new Error(
              "OpenCode edit requires an existing Session message"
            )
          const releaseQueue = queue?.hold()
          try {
            try {
              await options.revertForEdit!(sessionId, message.sourceId)
              queue?.clear()
            } finally {
              releaseQueue?.()
            }
            try {
              await controller.sendMessage(
                message,
                sendOptions(options, controller)
              )
            } catch (error) {
              // Undo already succeeded. Reconcile native history even if the
              // replacement failed, without masking that original send error.
              await controller.refresh().catch(() => undefined)
              throw error
            }
            await controller.refresh()
          } catch (error) {
            reportError(options, error)
            throw error
          }
        },
      }),
      onCancel: async () => {
        try {
          await (queue ? queue.cancel() : controller.cancel())
        } catch (error) {
          reportError(options, error)
          throw error
        }
      },
      onRespondToToolApproval: async (response: RespondToToolApprovalOptions) =>
        controller.replyToPermission(
          response.approvalId,
          toPermissionResponse(response)
        ),
      onReload: async (parentId: string | null) => {
        if (!parentId) return
        queue?.clear()
        if (
          await controller.sendStagedMessage(
            parentId,
            sendOptions(options, controller)
          )
        )
          return
        await controller.revert(parentId)
      },
    }),
    [
      blocked,
      controller,
      extras,
      messages,
      options,
      queue,
      queueAdapter,
      state.loadState.type,
      sessionId,
    ]
  )
}

function optimisticMessage(
  message: AppendMessage,
  index: number
): ThreadMessageLike {
  return {
    id: `opencode-new-user:${index}`,
    role: "user",
    createdAt: message.createdAt,
    content: message.content,
    attachments: message.attachments,
  }
}

function useNewThreadStore(
  client: OpencodeClient,
  registry: Registry,
  options: OpenCodeRuntimeOptions,
  extras: unknown
): ExternalStoreAdapter<ThreadMessage> {
  const aui = useAui()
  const [pending, setPending] = useState<readonly ThreadMessageLike[]>([])
  const index = useRef(0)
  const initializing = useRef<
    ReturnType<typeof aui.threadListItem.initialize> | undefined
  >(undefined)
  const serial = useRef(Promise.resolve())
  const repository = useMemo(
    () => ExportedMessageRepository.fromArray(pending),
    [pending]
  )
  return useMemo(
    () => ({
      ...pickExternalStoreSharedOptions(options),
      isDisabled: options.isDisabled ?? false,
      isLoading: false,
      isRunning: false,
      messageRepository: repository,
      extras,
      ...(options.adapters && { adapters: options.adapters }),
      onNew: async (message: AppendMessage) => {
        const optimistic = optimisticMessage(message, index.current++)
        setPending((items) => [...items, optimistic])
        const task = serial.current.then(async () => {
          try {
            initializing.current ??= aui.threadListItem.initialize()
            const { remoteId, externalId } = await initializing.current
            const controller = getController(
              registry,
              client,
              externalId ?? remoteId
            )
            setPending((items) => items.filter((item) => item !== optimistic))
            await sendMessage(controller, message, options)
          } catch (error) {
            setPending((items) => items.filter((item) => item !== optimistic))
            reportError(options, error)
            throw error
          } finally {
            initializing.current = undefined
          }
        })
        serial.current = task.catch(() => undefined)
        return task
      },
    }),
    [aui, client, extras, options, registry, repository]
  )
}

function useRuntimeHook(
  registry: Registry,
  client: OpencodeClient,
  options: AosOpenCodeRuntimeOptions
) {
  const item = useAuiState((state) => state.threadListItem)
  const sessionId = item.externalId ?? item.remoteId
  const controller = sessionId
    ? getController(registry, client, sessionId)
    : NOOP_CONTROLLER
  const queue = sessionId ? getQueue(registry, controller, options) : undefined
  const store = useThreadStore(
    registry,
    client,
    controller,
    options,
    queue,
    sessionId
  )
  const newStore = useNewThreadStore(client, registry, options, store.extras)
  return useExternalStoreRuntime(sessionId ? store : newStore)
}

export function useAosOpenCodeRuntime(
  client: OpencodeClient,
  options: AosOpenCodeRuntimeOptions,
  eventHub: AosOpenCodeEventHub
): AssistantRuntime {
  const runtimeOptions = useMemo(
    () => ({
      ...options,
      adapters: {
        attachments: new OpenCodeAttachmentAdapter(),
        ...options.adapters,
      },
    }),
    [options]
  )
  const registry = useMemo(() => createRegistry(eventHub), [eventHub])
  useEffect(() => () => registry.dispose(), [registry])
  const adapter = useMemo(
    () => createAosOpenCodeThreadListAdapter(client),
    [client]
  )
  return useRemoteThreadListRuntime({
    allowNesting: true,
    adapter,
    initialThreadId: options.initialSessionId,
    onThreadIdChange: options.onThreadIdChange,
    // eslint-disable-next-line react-hooks/rules-of-hooks -- assistant-ui invokes this callback at a stable hook position.
    runtimeHook: () => useRuntimeHook(registry, client, runtimeOptions),
  })
}
