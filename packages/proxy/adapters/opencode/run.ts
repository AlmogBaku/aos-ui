import { createHash } from "node:crypto"
import { z } from "zod"

import {
  backoffDelay,
  createOwner,
  defaultClock,
  fromAbortable,
  ownerSetup,
  type Clock,
  type Logger,
  type Owner,
} from "../../../lifecycle"
import {
  TurnEventKind,
  TurnInputSchema,
  isRepliesTurn,
  type PendingRequest,
  type RequestReply,
  type TurnEvent,
  type TurnInput,
} from "../../core/events"
import type { McpToolNames } from "../../mcp-apps/tool-names"

import {
  ServerTurnConflictError,
  type RecoveryRequest,
  type ServerTurnEngine,
  type ServerTurnHandle,
  type ServerTurnListener,
  type ServerAttachmentStage,
  type SessionScope,
} from "../../core/runtime"
import {
  OpenCodeClientError,
  OpenCodeMutationUncertainError,
  type OpenCodeClient,
  type OpenCodeSessionEvents,
} from "./client"
import {
  OpenCodeEventProjector,
  OpenCodeEventValidationError,
  occurredAt,
  validateOpenCodeHistoryEvent,
  validateOpenCodeLiveEvent,
  type ValidatedOpenCodeEvent,
} from "./events"
import { openCodePromptFiles } from "./content"
import { OpenCodeLink } from "./link"

const MAX_HISTORY_PAGES = 1_000
const MAX_USER_TURN_BYTES = 1024 * 1024
const DEFAULT_MAX_QUEUE_EVENTS = 2_048
const DEFAULT_MAX_BUFFERED_EVENTS = 1_024
const DEFAULT_WAIT_RETRY_MS = 250

export type OpenCodeBoundReplies = Readonly<{
  /** Reads and binds the complete authoritative pending interaction batch. */
  discover?(scope: SessionScope): Promise<readonly PendingRequest[] | undefined>
  /** Must prove every reply is still bound to a pending native interaction. */
  validate(scope: SessionScope, replies: readonly RequestReply[]): Promise<void>
  /** Performs exactly one native 204 mutation after observation is attached. */
  dispatch(scope: SessionScope, replies: readonly RequestReply[]): Promise<void>
}>

type OpenCodeTurnClient = Readonly<{
  sessions: Pick<
    OpenCodeClient["sessions"],
    "get" | "active" | "history" | "events" | "prompt" | "interrupt" | "wait"
  >
  credentialRefused: OpenCodeClient["credentialRefused"]
}>

export type OpenCodeTurnEngineOptions = Readonly<{
  logger: Logger
  clock?: Clock
  replies?: OpenCodeBoundReplies
  maxQueueEvents?: number
  maxBufferedEvents?: number
  waitRetryMs?: number
  /** Keyed by Agent; a turn reads the names its Agent last loaded. */
  mcpToolNames?: McpToolNames
}>

type ActiveTurn = {
  key: string
  scope: SessionScope
  projector: OpenCodeEventProjector
  queue: EventQueue
  controller: AbortController
  source?: OpenCodeSessionEvents
  sourceAborted: boolean
  buffer: Map<number, ValidatedOpenCodeEvent>
  ready: boolean
  segmentClosed: boolean
  nativeTerminal: boolean
  abandoned: boolean
  reconciling: boolean
  reconcileAgain: boolean
  expectedAdmission?: string
  admissionObserved: boolean
  settle(): void
  settled: Promise<void>
  nativeSettlement: ScopedNativeSettlement
}

type Settlement = Readonly<{
  settled: Promise<void>
  settle(): void
  readonly done: boolean
}>

type ScopedNativeSettlement = Settlement & {
  key: string
  scope: SessionScope
  /** Polls until the native Session idles, once a Stop left it running. */
  monitor?: RetryOwner
  stopRequested: boolean
}

/** One retry loop's steps. */
type RetryLoop = Readonly<{
  /** One try; `recovered` restarts the backoff once it has made progress. */
  attempt(signal: AbortSignal, recovered: () => void): Promise<void>
  /** Runs when each backoff ends, before the next attempt; never rejects. */
  poll?(): Promise<void>
}>

/**
 * Runs `loop` until disposed, backing off after every attempt: `baseMs` once
 * it recovered, doubling with each failure since up to 16 times that, with
 * full jitter.
 */
function retryMachine(
  id: string,
  loop: RetryLoop,
  logger: Logger,
  clock: Clock,
  baseMs: number
) {
  let failures = 0
  const actors = {
    attempt: fromAbortable((signal) =>
      loop.attempt(signal, () => {
        failures = 0
      })
    ),
    poll: fromAbortable(async () => loop.poll?.()),
  }
  return ownerSetup("turn", logger, clock, actors)
    .extend({
      delays: {
        retry: () => backoffDelay(failures, { baseMs, capMs: baseMs * 16 }),
      },
    })
    .createMachine({
      id,
      context: { generation: 0 },
      initial: "attempting",
      states: {
        attempting: {
          invoke: {
            src: "attempt",
            onDone: "backing-off",
            onError: {
              target: "backing-off",
              actions: () => {
                failures += 1
              },
            },
          },
        },
        "backing-off": {
          after: {
            retry: [
              { guard: () => loop.poll !== undefined, target: "polling" },
              { target: "attempting" },
            ],
          },
        },
        polling: {
          invoke: { src: "poll", onDone: "attempting", onError: "attempting" },
        },
      },
    })
}

type RetryOwner = Owner<ReturnType<typeof retryMachine>>

class EventQueue implements AsyncIterable<TurnEvent> {
  readonly #values: TurnEvent[] = []
  readonly #waiters: Array<() => void> = []
  readonly #maximum: number
  #closed = false

  constructor(maximum: number) {
    this.#maximum = maximum
  }

  push(event: TurnEvent) {
    if (this.#closed) return true
    if (this.#values.length >= this.#maximum) return false
    this.#values.push(event)
    this.#waiters.shift()?.()
    return true
  }

  resetWith(event: TurnEvent) {
    if (this.#closed) return
    const started = this.#values.find(
      (value) => value.kind === TurnEventKind.TurnStarted
    )
    this.#values.length = 0
    if (started && this.#maximum > 1) this.#values.push(started)
    this.#values.push(event)
    this.close()
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const wake of this.#waiters.splice(0)) wake()
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const value = this.#values.shift()
      if (value) {
        yield value
        continue
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => this.#waiters.push(resolve))
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/** Where a recovery continues an OpenCode run: its epoch and last event seen. */
const OpenCodePositionSchema = z.object({
  epoch: z.string(),
  lastSeen: z.number().int().nonnegative(),
})
type OpenCodePosition = z.infer<typeof OpenCodePositionSchema>

/** The opaque token a handle names its position by; only this adapter reads it. */
export const openCodeRecoveryToken = {
  mint: (position: OpenCodePosition) => JSON.stringify(position),
  read: (token: string | undefined) =>
    token === undefined
      ? undefined
      : OpenCodePositionSchema.parse(JSON.parse(token)),
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

function validateInput(scope: SessionScope, candidate: TurnInput) {
  const input = TurnInputSchema.parse(candidate)
  if (isRepliesTurn(input)) return { input, replies: input.replies }
  // OpenCode has no Edit or Retry, and a turn is one bounded prompt: anything
  // else is the caller's mistake, not an outage.
  const text = input.prompt
  if (
    input.rewindSourceId !== undefined ||
    !text ||
    new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES
  )
    throw new OpenCodeClientError("invalid_request")
  return { input, text }
}

function admissionId(scope: SessionScope, turnId: string) {
  const digest = createHash("sha256")
    .update(scope.providerSessionId)
    .update("\0")
    .update(turnId)
    .digest("hex")
  return `aos_${digest}`
}

function validateSessionOwner(value: unknown, scope: SessionScope) {
  const envelope = record(value)
  const session = record(envelope?.data)
  if (!session || typeof session.id !== "string")
    throw new OpenCodeClientError("invalid_response")
  if (session.id !== scope.providerSessionId || session.agent !== scope.agentId)
    throw new Error("Session does not belong to this Agent")
}

function isSessionActive(value: unknown, sessionId: string) {
  const envelope = record(value)
  const active = record(envelope?.data)
  if (!active) throw new OpenCodeClientError("invalid_response")
  if (!Object.hasOwn(active, sessionId)) return false
  const status = record(active[sessionId])
  if (!status || status.type !== "running")
    throw new OpenCodeClientError("invalid_response")
  return true
}

function validateAdmission(
  value: unknown,
  expected: Readonly<{
    id: string
    sessionId: string
    text: string
    after: number
  }>
) {
  const envelope = record(value)
  const admission = record(envelope?.data)
  const prompt = record(admission?.prompt)
  const admittedSeq = integer(admission?.admittedSeq)
  if (
    !admission ||
    admittedSeq === undefined ||
    admittedSeq <= expected.after ||
    admission.id !== expected.id ||
    admission.sessionID !== expected.sessionId ||
    (admission.delivery !== "queue" && admission.delivery !== "steer") ||
    typeof admission.timeCreated !== "number" ||
    !Number.isFinite(admission.timeCreated) ||
    !prompt ||
    prompt.text !== expected.text
  )
    throw new OpenCodeMutationUncertainError()
  return admittedSeq
}

function historyPage(value: unknown) {
  const page = record(value)
  if (!page || !Array.isArray(page.data) || typeof page.hasMore !== "boolean")
    throw new OpenCodeClientError("invalid_response")
  return { data: page.data, hasMore: page.hasMore }
}

function settlement(): Settlement {
  let resolve!: () => void
  let done = false
  const settled = new Promise<void>((next) => {
    resolve = next
  })
  return {
    settled,
    get done() {
      return done
    },
    settle: () => {
      if (done) return
      done = true
      resolve()
    },
  }
}

function turnKey(scope: SessionScope) {
  return `${scope.agentId}\0${scope.providerSessionId}`
}

function isAdmission(event: ValidatedOpenCodeEvent) {
  return event.type === "session.next.prompt.admitted"
}

/** The admission that started the log's latest native turn. */
function latestAdmission(history: readonly ValidatedOpenCodeEvent[]) {
  return history.findLast(isAdmission)
}

export class OpenCodeTurnEngine implements ServerTurnEngine {
  readonly #client: OpenCodeTurnClient
  readonly #options: OpenCodeTurnEngineOptions
  readonly #turns = new Map<string, ActiveTurn>()
  readonly #nativeSettlements = new Map<string, ScopedNativeSettlement>()
  /**
   * The admission each Session's latest AOS start submits, recorded before the
   * submit so neither a turn subscription nor a discovery takes it for a
   * foreign turn.
   */
  readonly #ownAdmissions = new Map<string, string>()
  /** The foreign admission each Session's latest discovered turn adopted. */
  readonly #adoptedAdmissions = new Map<
    string,
    Readonly<{ turnId: string; admissionId: string }>
  >()
  readonly #maxQueueEvents: number
  readonly #maxBufferedEvents: number
  readonly #waitRetryMs: number
  readonly #logger: Logger
  readonly #clock: Clock
  /** Every retry loop still running, which close disposes. */
  readonly #owners = new Set<RetryOwner>()
  #closed = false
  /** OpenCode's link, as each Session's foreign-turn watch meets it. */
  readonly link: OpenCodeLink

  constructor(client: OpenCodeTurnClient, options: OpenCodeTurnEngineOptions) {
    this.#client = client
    this.#options = options
    this.#logger = options.logger
    this.#clock = options.clock ?? defaultClock
    this.link = new OpenCodeLink({
      logger: this.#logger,
      clock: this.#clock,
      credentialRefused: () => client.credentialRefused(),
    })
    this.#maxQueueEvents = positiveInteger(
      options.maxQueueEvents,
      DEFAULT_MAX_QUEUE_EVENTS
    )
    this.#maxBufferedEvents = positiveInteger(
      options.maxBufferedEvents,
      DEFAULT_MAX_BUFFERED_EVENTS
    )
    this.#waitRetryMs = positiveInteger(
      options.waitRetryMs,
      DEFAULT_WAIT_RETRY_MS
    )
  }

  /** The per-Session records held; none once every turn has settled. */
  get retainedRecords() {
    return (
      this.#turns.size +
      this.#nativeSettlements.size +
      this.#ownAdmissions.size +
      this.#adoptedAdmissions.size
    )
  }

  /** Stops every watch and retry loop, so no timer of this engine fires again. */
  close() {
    this.#closed = true
    this.link.close()
    for (const owner of [...this.#owners]) owner.dispose()
  }

  /** Starts one retry loop owned by this engine; none once it is closed. */
  #retry(scope: SessionScope, id: string, loop: RetryLoop) {
    if (this.#closed) return undefined
    const owner = createOwner(
      retryMachine(id, loop, this.#logger, this.#clock, this.#waitRetryMs),
      {
        logger: this.#logger,
        clock: this.#clock,
        bindings: { agentId: scope.agentId, sessionId: scope.sessionId },
      }
    )
    this.#owners.add(owner)
    owner.stack.defer(() => this.#owners.delete(owner))
    return owner
  }

  async discover(scope: SessionScope, turnId: string) {
    await this.#verifyOwnership(scope)
    return (
      (await this.#discoverWait(scope)) ??
      (await this.#discoverRun(scope, turnId))
    )
  }

  /**
   * Adopts the running turn a foreign admission started. It is projected from
   * that admission, so its events begin at the native turn's first event.
   */
  async #discoverRun(scope: SessionScope, turnId: string) {
    if (!(await this.#active(scope.providerSessionId))) return undefined
    const key = turnKey(scope)
    const admission = latestAdmission(
      await this.#readHistory(scope.providerSessionId)
    )
    const id = admission?.data.messageID as string | undefined
    if (!admission || id === undefined || id === this.#ownAdmissions.get(key))
      return undefined
    this.#adoptedAdmissions.set(key, { turnId, admissionId: id })
    const handle = await this.#recoverRun(scope, undefined, id)
    const startedAt = occurredAt(admission.data)
    return {
      handle,
      state: "running" as const,
      fromStart: true,
      ...(startedAt === undefined ? {} : { startedAt: Date.parse(startedAt) }),
    }
  }

  /**
   * Watches one Session's native log from its tail on OpenCode's link, which
   * redials it after a drop and stops once the Session is gone or OpenCode
   * refuses the password. A turn is foreign when its admission is not the one
   * this engine last submitted for the Session.
   */
  subscribeTurns(scope: SessionScope, listener: ServerTurnListener) {
    const key = turnKey(scope)
    const sessionId = scope.providerSessionId
    // Admissions only grow, so the last one considered dedupes repeats.
    let considered = -1
    const consider = (admission: ValidatedOpenCodeEvent | undefined) => {
      if (!admission || !isAdmission(admission) || admission.seq <= considered)
        return
      considered = admission.seq
      if (admission.data.messageID !== this.#ownAdmissions.get(key))
        listener.onTurn()
    }
    const dial = async (
      signal: AbortSignal,
      lost: (cause: unknown) => void
    ) => {
      const history = await this.#readHistory(sessionId, undefined, signal)
      const tail = history.at(-1)?.seq ?? -1
      const source = await this.#client.sessions.events(sessionId, {
        ...(tail < 0 ? {} : { after: String(tail) }),
        signal,
      })
      let released = false
      const release = () => {
        released = true
        source.abort()
      }
      try {
        // A turn that started while the watch was down is announced now.
        if (await this.#active(sessionId, signal)) {
          const caughtUp = await this.#readHistory(sessionId, tail, signal)
          signal.throwIfAborted()
          consider(latestAdmission([...history, ...caughtUp]))
        }
      } catch (error) {
        release()
        throw error
      }
      void (async () => {
        for await (const value of source) {
          if (released) return
          consider(validateOpenCodeLiveEvent(value, sessionId))
        }
        // A lost read stream: nothing it asked of OpenCode happened.
        throw new OpenCodeClientError("unavailable")
      })().catch((cause: unknown) => {
        if (!released) lost(cause)
      })
      return release
    }
    return this.link.watch({
      dial,
      onError: (cause) => listener.onError(cause),
      bindings: {
        link: "turn-subscription",
        agentId: scope.agentId,
        sessionId: scope.sessionId,
      },
    })
  }

  async #discoverWait(scope: SessionScope) {
    const discover = this.#options.replies?.discover
    if (!discover) return undefined
    const history = await this.#readHistory(scope.providerSessionId)
    const after = history.at(-1)?.seq ?? -1
    const controller = new AbortController()
    let source: OpenCodeSessionEvents | undefined
    let observation: Promise<void> | undefined
    let observationFailed = false
    let observationFailure: unknown
    let reading = false
    let dirty = false
    try {
      source = await this.#client.sessions.events(scope.providerSessionId, {
        ...(after < 0 ? {} : { after: String(after) }),
        signal: controller.signal,
      })
      observation = (async () => {
        try {
          for await (const value of source!) {
            validateOpenCodeLiveEvent(value, scope.providerSessionId)
            if (reading) dirty = true
          }
          if (!controller.signal.aborted)
            throw new OpenCodeClientError("unavailable")
        } catch (error) {
          if (controller.signal.aborted) return
          observationFailed = true
          observationFailure = error
        }
      })()
      let discovered: readonly PendingRequest[] | undefined
      do {
        dirty = false
        reading = true
        try {
          discovered = await discover(scope)
        } finally {
          reading = false
        }
        if (observationFailed) throw observationFailure
      } while (dirty)
      if (!discovered?.length) return undefined
      const requests = structuredClone([...discovered])
      const events: TurnEvent[] = [
        { kind: TurnEventKind.TurnStarted },
        { kind: TurnEventKind.TurnRequiresAction, requests },
      ]
      return {
        state: "waiting-for-input" as const,
        requests,
        handle: {
          events: (async function* () {
            yield* events
          })(),
          settled: Promise.resolve(),
          stop: async () => "idle" as const,
          // A restored wait was never streamed, so it holds no native position
          // a later recovery could continue from.
          recoveryPosition: () => undefined,
        },
      }
    } finally {
      controller.abort()
      source?.abort()
      await observation
    }
  }

  async start(
    scope: SessionScope,
    candidate: TurnInput,
    stage?: ServerAttachmentStage,
    signal?: AbortSignal
  ): Promise<ServerTurnHandle> {
    const { input, replies, text } = validateInput(scope, candidate)
    // Warm the MCP tool names while the turn is admitted, so its first tool
    // call already reads under its canonical name.
    void this.#options.mcpToolNames
      ?.load(scope.agentId)
      .catch((err: unknown) =>
        this.#logger.warn(
          { err, agentId: scope.agentId },
          "opencode.mcp-tool-names.load_failed"
        )
      )
    let files: readonly { uri: string; name?: string }[] | undefined
    if (stage) {
      try {
        files = openCodePromptFiles(stage)
      } catch {
        throw new Error("OpenCode attachment stage is invalid")
      }
    }
    await this.#verifyOwnership(scope, signal)

    if (replies) {
      if (!this.#options.replies)
        throw new Error("OpenCode interaction replies are unavailable")
      await this.#options.replies.validate(scope, replies)
    } else if (await this.#active(scope.providerSessionId, signal)) {
      // The native Session owns a turn AOS did not admit, which the browser
      // resolves by reloading this run rather than by reading a failure.
      throw new ServerTurnConflictError()
    }

    const before = await this.#readHistory(
      scope.providerSessionId,
      undefined,
      signal
    )
    const baseline = before.at(-1)?.seq ?? -1
    const expectedAdmission = replies
      ? undefined
      : admissionId(scope, input.turnId)
    const run = this.#createRun(
      scope,
      baseline,
      expectedAdmission,
      isRepliesTurn(input) ? undefined : input.messageId
    )

    try {
      await this.#attach(run, baseline)

      // Observation is already draining while this second authoritative read
      // closes the history-to-subscription window.
      const caughtUp = await this.#readHistory(
        scope.providerSessionId,
        baseline,
        signal
      )
      if (caughtUp.length) {
        if (!replies)
          throw new Error("OpenCode became active before prompt admission")
        const next = caughtUp.at(-1)!.seq
        run.projector = this.#projector(run, next)
        this.#discardBufferedThrough(run, next)
      }
      if (run.segmentClosed)
        throw new Error("OpenCode observation failed before turn mutation")

      const after = run.projector.recoveryPosition().lastSeen
      if (replies) {
        await this.#options.replies!.dispatch(scope, replies)
      } else {
        this.#ownAdmissions.set(run.key, expectedAdmission!)
        const acknowledgement = await this.#client.sessions.prompt(
          scope.providerSessionId,
          {
            id: expectedAdmission!,
            prompt: { text: text!, ...(files ? { files: [...files] } : {}) },
            resume: true,
          },
          signal
        )
        validateAdmission(acknowledgement, {
          id: expectedAdmission!,
          sessionId: scope.providerSessionId,
          text: text!,
          after,
        })
      }
      run.ready = true
      await this.#reconcile(run)
      if (!run.nativeTerminal) this.#watchWait(run)
      return this.#handle(run)
    } catch (error) {
      this.#abandon(run)
      throw error
    }
  }

  async recover(
    scope: SessionScope,
    request: RecoveryRequest
  ): Promise<ServerTurnHandle> {
    if (request.sessionId !== scope.sessionId)
      throw new Error(
        "The reconnect position is not authorized for this Session"
      )
    await this.#verifyOwnership(scope)
    const expectedEpoch = `opencode:${scope.providerSessionId}`
    const position = openCodeRecoveryToken.read(request.position)
    if (position && position.epoch !== expectedEpoch)
      throw new Error("The reconnect position is invalid")

    const adopted = this.#adoptedAdmissions.get(turnKey(scope))
    return this.#recoverRun(
      scope,
      position,
      adopted?.turnId === request.turnId
        ? adopted.admissionId
        : admissionId(scope, request.turnId)
    )
  }

  async #recoverRun(
    scope: SessionScope,
    position: OpenCodePosition | undefined,
    expectedAdmission: string
  ): Promise<ServerTurnHandle> {
    const requestedAfter = position?.lastSeen ?? -1
    const run = this.#createRun(scope, requestedAfter, expectedAdmission)

    try {
      // Start consuming immediately. The bounded buffer remains live while the
      // complete authoritative log is read and the requested interval located.
      await this.#attach(run, requestedAfter)
      const all = await this.#readHistory(scope.providerSessionId)
      const admissionIndex = all.findIndex(
        (event) =>
          event.type === "session.next.prompt.admitted" &&
          event.data.messageID === expectedAdmission
      )
      if (admissionIndex < 0)
        throw new Error("OpenCode stable prompt admission was not found")
      const admissionEvent = all[admissionIndex]!
      const nextAdmissionIndex = all.findIndex(
        (event, index) =>
          index > admissionIndex &&
          event.type === "session.next.prompt.admitted"
      )
      const intervalEnd =
        nextAdmissionIndex < 0
          ? (all.at(-1)?.seq ?? admissionEvent.seq)
          : all[nextAdmissionIndex]!.seq - 1
      const projectionStart = position
        ? position.lastSeen
        : admissionEvent.seq - 1
      if (
        projectionStart < admissionEvent.seq - 1 ||
        projectionStart > intervalEnd
      )
        throw new Error("The reconnect position is outside this native run")

      run.projector = this.#projector(
        run,
        admissionEvent.seq - 1,
        expectedAdmission
      )
      run.admissionObserved = projectionStart >= admissionEvent.seq
      for (const event of all) {
        if (event.seq < admissionEvent.seq || event.seq > intervalEnd) continue
        if (event.seq <= projectionStart) {
          this.#publish(run, run.projector.reconstructValidated(event))
          continue
        }
        this.#publish(run, run.projector.acceptValidated(event))
      }
      this.#discardBufferedThrough(run, intervalEnd)
      run.ready = true

      if (nextAdmissionIndex >= 0) {
        this.#finish(run, false)
      } else {
        await this.#reconcile(run)
        if (!run.nativeTerminal) this.#watchWait(run)
      }
      return this.#handle(run)
    } catch (error) {
      this.#abandon(run)
      throw error
    }
  }

  #createRun(
    scope: SessionScope,
    after: number,
    expectedAdmission?: string,
    /** The live id of the prompt the admission saves. */
    userMessageId?: string
  ): ActiveTurn {
    const queue = new EventQueue(this.#maxQueueEvents)
    const segmentSettlement = settlement()
    const key = turnKey(scope)
    let nativeSettlement = this.#nativeSettlements.get(key)
    if (!nativeSettlement) {
      const pending = settlement()
      nativeSettlement = {
        settled: pending.settled,
        settle: pending.settle,
        get done() {
          return pending.done
        },
        key,
        scope,
        stopRequested: false,
      }
      this.#nativeSettlements.set(key, nativeSettlement)
    }
    queue.push({ kind: TurnEventKind.TurnStarted })
    const projector = new OpenCodeEventProjector(
      scope.providerSessionId,
      after,
      {
        admissionId: expectedAdmission,
        userMessageId,
        resolveMcpTool: this.#options.mcpToolNames?.resolver(scope.agentId),
      }
    )
    if (nativeSettlement.stopRequested) projector.markStopping()
    return {
      key,
      scope,
      projector,
      queue,
      controller: new AbortController(),
      sourceAborted: false,
      buffer: new Map(),
      ready: false,
      segmentClosed: false,
      nativeTerminal: false,
      abandoned: false,
      reconciling: false,
      reconcileAgain: false,
      expectedAdmission,
      admissionObserved: expectedAdmission === undefined,
      settled: segmentSettlement.settled,
      settle: segmentSettlement.settle,
      nativeSettlement,
    }
  }

  #projector(run: ActiveTurn, after: number, expectedAdmission?: string) {
    const projector = new OpenCodeEventProjector(
      run.scope.providerSessionId,
      after,
      {
        admissionId: expectedAdmission,
        resolveMcpTool: this.#options.mcpToolNames?.resolver(run.scope.agentId),
      }
    )
    if (run.nativeSettlement.stopRequested) projector.markStopping()
    return projector
  }

  async #attach(run: ActiveTurn, after: number) {
    const prior = this.#turns.get(run.key)
    if (prior && prior !== run) {
      prior.abandoned = true
      prior.controller.abort()
      this.#abortSource(prior)
      this.#segmentFail(
        prior,
        "AOS_CONNECTION_INTERRUPTED",
        "This OpenCode observation was replaced by a newer scoped connection."
      )
    }
    this.#turns.set(run.key, run)
    run.source = await this.#client.sessions.events(
      run.scope.providerSessionId,
      after < 0 ? {} : { after: String(after) }
    )
    this.#pump(run)
  }

  #pump(run: ActiveTurn) {
    void (async () => {
      try {
        for await (const value of run.source!) {
          if (run.abandoned || run.nativeTerminal) return
          const event = validateOpenCodeLiveEvent(
            value,
            run.scope.providerSessionId
          )
          const existing = run.buffer.get(event.seq)
          if (existing && existing.fingerprint !== event.fingerprint)
            throw new OpenCodeEventValidationError()
          run.buffer.set(event.seq, event)
          if (run.buffer.size > this.#maxBufferedEvents)
            throw new OpenCodeEventValidationError()
          if (run.ready) this.#scheduleReconcile(run)
        }
        if (!run.sourceAborted && !run.abandoned && !run.nativeTerminal)
          this.#segmentFail(
            run,
            "AOS_CONNECTION_INTERRUPTED",
            "The OpenCode connection was interrupted; reconnect to reconcile this turn."
          )
      } catch (error) {
        if (run.sourceAborted || run.abandoned || run.nativeTerminal) return
        this.#segmentFail(
          run,
          error instanceof OpenCodeEventValidationError
            ? "AOS_RESET_REQUIRED"
            : "AOS_CONNECTION_INTERRUPTED",
          error instanceof OpenCodeEventValidationError
            ? "OpenCode history must be reconciled before this turn can continue."
            : "The OpenCode connection was interrupted; reconnect to reconcile this turn."
        )
      }
    })().catch((err: unknown) =>
      this.#logger.error(
        { err, agentId: run.scope.agentId, sessionId: run.scope.sessionId },
        "opencode.turn.pump_failed"
      )
    )
  }

  #scheduleReconcile(run: ActiveTurn) {
    if (run.reconciling) {
      run.reconcileAgain = true
      return
    }
    void this.#reconcile(run).catch((error) =>
      this.#reconciliationFailed(run, error)
    )
  }

  async #reconcile(run: ActiveTurn) {
    if (run.abandoned || run.nativeTerminal || !run.ready) return
    if (run.reconciling) {
      run.reconcileAgain = true
      return
    }
    run.reconciling = true
    try {
      do {
        run.reconcileAgain = false
        let cleanIdlePasses = 0
        for (let pass = 0; pass < 3; pass += 1) {
          const before = run.projector.recoveryPosition().lastSeen
          await this.#mergeAuthoritative(run)
          const active = await this.#active(
            run.scope.providerSessionId,
            run.controller.signal
          )
          await this.#mergeAuthoritative(run)
          const after = run.projector.recoveryPosition().lastSeen
          const clean = after === before && run.buffer.size === 0
          cleanIdlePasses = !active && clean ? cleanIdlePasses + 1 : 0
          if (cleanIdlePasses >= 2) {
            this.#finish(run)
            return
          }
          if (active && clean) break
        }
      } while (run.reconcileAgain && !run.nativeTerminal && !run.abandoned)
    } finally {
      run.reconciling = false
    }
  }

  async #mergeAuthoritative(run: ActiveTurn) {
    const after = run.projector.recoveryPosition().lastSeen
    const history = await this.#readHistory(
      run.scope.providerSessionId,
      after,
      run.controller.signal
    )
    const merged = new Map<number, ValidatedOpenCodeEvent>()
    for (const event of history) merged.set(event.seq, event)
    for (const [seq, event] of run.buffer) {
      const existing = merged.get(seq)
      if (existing && existing.fingerprint !== event.fingerprint)
        throw new OpenCodeEventValidationError()
      merged.set(seq, event)
    }
    for (const event of [...merged.values()].sort(
      (left, right) => left.seq - right.seq
    )) {
      this.#publish(run, run.projector.acceptValidated(event))
      run.buffer.delete(event.seq)
    }
  }

  async #readHistory(sessionId: string, after?: number, signal?: AbortSignal) {
    const events: ValidatedOpenCodeEvent[] = []
    let cursor = after ?? -1
    for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
      const page = historyPage(
        await this.#client.sessions.history(sessionId, {
          ...(cursor < 0 ? {} : { after: cursor }),
          limit: 100,
          ...(signal ? { signal } : {}),
        })
      )
      for (const value of page.data) {
        const event = validateOpenCodeHistoryEvent(value, sessionId)
        if (event.seq !== cursor + 1) throw new OpenCodeEventValidationError()
        events.push(event)
        cursor = event.seq
      }
      if (!page.hasMore) return events
      if (page.data.length === 0 || pageNumber === MAX_HISTORY_PAGES - 1)
        throw new OpenCodeClientError("invalid_response")
    }
    throw new OpenCodeClientError("invalid_response")
  }

  /**
   * Waits natively for the Session to idle, then reconciles, until the run
   * ends; a wait that fails is not trusted, so each backoff ends in another
   * reconcile before the next wait.
   */
  #watchWait(run: ActiveTurn) {
    if (run.nativeTerminal || run.abandoned) return
    const watch = this.#retry(run.scope, "turn-wait", {
      attempt: async (signal, recovered) => {
        await this.#client.sessions.wait(run.scope.providerSessionId, signal)
        recovered()
        await this.#reconcile(run)
      },
      poll: () =>
        this.#reconcile(run).catch((error) =>
          this.#reconciliationFailed(run, error)
        ),
    })
    // A run ends by aborting its controller, which ends its watch too.
    run.controller.signal.addEventListener("abort", () => watch?.dispose(), {
      once: true,
    })
  }

  #reconciliationFailed(run: ActiveTurn, error: unknown) {
    this.#segmentFail(
      run,
      error instanceof OpenCodeEventValidationError
        ? "AOS_RESET_REQUIRED"
        : "AOS_CONNECTION_INTERRUPTED",
      error instanceof OpenCodeEventValidationError
        ? "OpenCode history must be reconciled before this turn can continue."
        : "The OpenCode connection was interrupted; reconnect to reconcile this turn."
    )
  }

  #handle(run: ActiveTurn): ServerTurnHandle {
    return {
      events: run.queue,
      settled: run.settled,
      stop: () => this.#stop(run),
      recoveryPosition: () =>
        openCodeRecoveryToken.mint(run.projector.recoveryPosition()),
    }
  }

  #publish(
    run: ActiveTurn,
    projection: ReturnType<OpenCodeEventProjector["acceptValidated"]>
  ) {
    if (run.segmentClosed) return
    if (projection.admissionId !== undefined) {
      if (
        run.expectedAdmission !== undefined &&
        !run.admissionObserved &&
        projection.admissionId !== run.expectedAdmission
      )
        throw new OpenCodeEventValidationError()
      run.admissionObserved = true
    }
    if (projection.admissionBoundary) {
      this.#finish(run, false)
      return
    }
    for (const event of projection.events) {
      if (!run.queue.push(event)) {
        this.#segmentFail(
          run,
          "AOS_RESET_REQUIRED",
          "The OpenCode event buffer was exceeded; reconnect to reconcile this turn.",
          true
        )
        return
      }
    }
    if (projection.terminal === "error") {
      this.#abortSource(run)
      run.queue.close()
      run.segmentClosed = true
      run.settle()
      this.#forgetAdoption(run)
    }
  }

  #finish(run: ActiveTurn, authoritativeNativeIdle = true) {
    if (run.nativeTerminal) return
    run.nativeTerminal = true
    if (authoritativeNativeIdle) this.#settleNative(run.nativeSettlement)
    // Once idle or superseded, its admission cannot pass for a foreign turn.
    if (this.#ownAdmissions.get(run.key) === run.expectedAdmission)
      this.#ownAdmissions.delete(run.key)
    // An open segment ends here, so no redial asks for its adoption again.
    if (!run.segmentClosed) this.#forgetAdoption(run)
    run.controller.abort()
    this.#abortSource(run)
    if (!run.admissionObserved) {
      this.#segmentFail(
        run,
        "AOS_RESET_REQUIRED",
        "OpenCode became idle before its stable prompt admission could be reconciled."
      )
      if (this.#turns.get(run.key) === run) this.#turns.delete(run.key)
      return
    }
    if (!run.segmentClosed) {
      this.#publish(run, run.projector.finish())
      run.queue.close()
      run.segmentClosed = true
    }
    run.settle()
    if (this.#turns.get(run.key) === run) this.#turns.delete(run.key)
  }

  /**
   * Frees the adoption `run` recovers once its end is delivered. A turn whose
   * stream failed keeps it, since the redial that recovers it still needs it.
   */
  #forgetAdoption(run: ActiveTurn) {
    if (
      this.#adoptedAdmissions.get(run.key)?.admissionId ===
      run.expectedAdmission
    )
      this.#adoptedAdmissions.delete(run.key)
  }

  #segmentFail(run: ActiveTurn, code: string, message: string, reset = false) {
    if (run.segmentClosed) return
    this.#abortSource(run)
    const events = run.projector.fail(code, message).events
    const failure = events.at(-1)!
    if (reset) {
      run.queue.resetWith(failure)
    } else {
      for (const event of events) {
        if (run.queue.push(event)) continue
        run.queue.resetWith(failure)
        break
      }
      run.queue.close()
    }
    run.segmentClosed = true
    run.settle()
  }

  #abortSource(run: ActiveTurn) {
    if (run.sourceAborted) return
    run.sourceAborted = true
    run.source?.abort()
  }

  #abandon(run: ActiveTurn) {
    run.abandoned = true
    run.controller.abort()
    this.#abortSource(run)
    run.queue.close()
    run.settle()
    if (run.nativeSettlement.stopRequested)
      this.#monitorNativeSettlement(run.nativeSettlement)
    if (this.#turns.get(run.key) === run) this.#turns.delete(run.key)
  }

  #discardBufferedThrough(run: ActiveTurn, seq: number) {
    for (const value of run.buffer.keys())
      if (value <= seq) run.buffer.delete(value)
  }

  async #stop(run: ActiveTurn): Promise<"stopping" | "idle"> {
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    if (run.nativeSettlement.stopRequested) return this.#recheckStop(run)
    await this.#client.sessions.interrupt(run.scope.providerSessionId)
    run.nativeSettlement.stopRequested = true
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    const current = this.#turns.get(run.key)
    if (current?.nativeSettlement === run.nativeSettlement)
      current.projector.markStopping()
    else run.projector.markStopping()
    try {
      await this.#reconcile(run)
    } catch {
      // The interrupt acknowledgement is authoritative. A failed read cannot
      // make this Stop safe to retry or prove the native Session idle.
    }
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    this.#monitorNativeSettlement(run.nativeSettlement)
    return "stopping"
  }

  async #recheckStop(run: ActiveTurn): Promise<"stopping" | "idle"> {
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    try {
      if (!(await this.#active(run.scope.providerSessionId))) {
        const current = this.#turns.get(run.key)
        if (current && !current.abandoned) this.#finish(current)
        else this.#settleNative(run.nativeSettlement)
        return "idle"
      }
    } catch {
      // An unavailable status read cannot prove idle or justify another
      // interrupt after the original mutation was acknowledged.
    }
    this.#monitorNativeSettlement(run.nativeSettlement)
    return "stopping"
  }

  async #verifyOwnership(scope: SessionScope, signal?: AbortSignal) {
    validateSessionOwner(
      await this.#client.sessions.get(scope.providerSessionId, signal),
      scope
    )
  }

  async #active(sessionId: string, signal?: AbortSignal) {
    return isSessionActive(
      await this.#client.sessions.active(signal),
      sessionId
    )
  }

  #settleNative(settlement: ScopedNativeSettlement) {
    settlement.settle()
    settlement.monitor?.dispose()
    if (this.#nativeSettlements.get(settlement.key) === settlement)
      this.#nativeSettlements.delete(settlement.key)
  }

  #monitorNativeSettlement(settlement: ScopedNativeSettlement) {
    if (settlement.done || settlement.monitor) return
    settlement.monitor = this.#retry(settlement.scope, "turn-settlement", {
      attempt: async (signal, recovered) => {
        const current = this.#turns.get(settlement.key)
        if (current && !current.abandoned) await this.#reconcile(current)
        else if (
          !(await this.#active(settlement.scope.providerSessionId, signal))
        )
          this.#settleNative(settlement)
        recovered()
      },
    })
  }
}
