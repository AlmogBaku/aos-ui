import { createHash } from "node:crypto"

import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type ResumeEntry,
} from "@ag-ui/core"

import type {
  NewTurnRunInput,
  RecoveryRequest,
  ResumeRunInput,
  ServerRunEngine,
  ServerRunHandle,
  SessionScope,
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
  validateOpenCodeHistoryEvent,
  validateOpenCodeLiveEvent,
  type ValidatedOpenCodeEvent,
} from "./events"

const MAX_HISTORY_PAGES = 1_000
const MAX_USER_TURN_BYTES = 1024 * 1024
const DEFAULT_MAX_QUEUE_EVENTS = 2_048
const DEFAULT_MAX_BUFFERED_EVENTS = 1_024
const DEFAULT_WAIT_RETRY_MS = 250

export type OpenCodeBoundResume = Readonly<{
  /** Must prove every response is still bound to a pending native interaction. */
  validate(scope: SessionScope, resume: readonly ResumeEntry[]): Promise<void>
  /** Performs exactly one native 204 mutation after observation is attached. */
  dispatch(scope: SessionScope, resume: readonly ResumeEntry[]): Promise<void>
}>

export type OpenCodeRunEngineOptions = Readonly<{
  resume?: OpenCodeBoundResume
  maxQueueEvents?: number
  maxBufferedEvents?: number
  waitRetryMs?: number
}>

type ActiveRun = {
  key: string
  scope: SessionScope
  runId: string
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
  waiting: boolean
  waitFailures: number
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
  monitoring: boolean
  waitFailures: number
  stopRequested: boolean
}

class EventQueue implements AsyncIterable<AGUIEvent> {
  readonly #values: AGUIEvent[] = []
  readonly #waiters: Array<() => void> = []
  readonly #maximum: number
  #closed = false

  constructor(maximum: number) {
    this.#maximum = maximum
  }

  push(event: AGUIEvent) {
    if (this.#closed) return true
    if (this.#values.length >= this.#maximum) return false
    this.#values.push(event)
    this.#waiters.shift()?.()
    return true
  }

  resetWith(event: AGUIEvent) {
    if (this.#closed) return
    const started = this.#values.find(
      (value) => value.type === EventType.RUN_STARTED
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

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

function isEmptyAuthority(value: unknown) {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === "object" && Object.keys(value).length === 0
}

function userText(input: ReturnType<typeof RunAgentInputSchema.parse>) {
  const message = input.messages[0]
  if (!message || message.role !== "user") return
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return
  let text = ""
  for (const part of message.content) {
    if (part.type !== "text") return
    text += part.text
  }
  return text
}

function validateInput(
  scope: SessionScope,
  candidate: NewTurnRunInput | ResumeRunInput
) {
  const input = RunAgentInputSchema.parse(candidate)
  if (input.threadId !== scope.threadId)
    throw new Error("AOS run scope does not match this Session")
  if (
    !isEmptyAuthority(input.state) ||
    input.tools.length > 0 ||
    input.context.length > 0 ||
    !isEmptyAuthority(input.forwardedProps)
  )
    throw new Error("AOS does not accept browser authority as OpenCode input")
  if ("rewindSourceId" in candidate && candidate.rewindSourceId !== undefined)
    throw new Error(
      "OpenCode Edit and Retry are not handled by this run engine"
    )
  const resume = input.resume?.length ? input.resume : undefined
  const text = userText(input)
  if (resume) {
    if (input.messages.length !== 0)
      throw new Error("AOS interrupt responses are not new user prompts")
  } else if (input.messages.length !== 1 || !text) {
    throw new Error("AOS runs require exactly one authorized user turn")
  }
  if (text && new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES)
    throw new Error("The AOS user turn is too large")
  return { input, resume, text }
}

function admissionId(scope: SessionScope, runId: string) {
  const digest = createHash("sha256")
    .update(scope.sessionId)
    .update("\0")
    .update(runId)
    .digest("hex")
  return `aos_${digest}`
}

function validateSessionOwner(value: unknown, scope: SessionScope) {
  const envelope = record(value)
  const session = record(envelope?.data)
  if (!session || typeof session.id !== "string")
    throw new OpenCodeClientError("invalid_response")
  if (session.id !== scope.sessionId || session.agent !== scope.agentId)
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

function runKey(scope: SessionScope) {
  return `${scope.agentId}\0${scope.sessionId}`
}

export class OpenCodeRunEngine implements ServerRunEngine {
  readonly #client: OpenCodeClient
  readonly #options: OpenCodeRunEngineOptions
  readonly #runs = new Map<string, ActiveRun>()
  readonly #nativeSettlements = new Map<string, ScopedNativeSettlement>()
  readonly #maxQueueEvents: number
  readonly #maxBufferedEvents: number
  readonly #waitRetryMs: number

  constructor(client: OpenCodeClient, options: OpenCodeRunEngineOptions = {}) {
    this.#client = client
    this.#options = options
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

  async start(
    scope: SessionScope,
    candidate: NewTurnRunInput | ResumeRunInput
  ): Promise<ServerRunHandle> {
    const { input, resume, text } = validateInput(scope, candidate)
    await this.#verifyOwnership(scope)

    if (resume) {
      if (!this.#options.resume)
        throw new Error("OpenCode interaction resume is unavailable")
      await this.#options.resume.validate(scope, resume)
    } else if (await this.#active(scope.sessionId)) {
      throw new Error("OpenCode is already running this Session")
    }

    const before = await this.#readHistory(scope.sessionId)
    const baseline = before.at(-1)?.seq ?? -1
    const expectedAdmission = resume
      ? undefined
      : admissionId(scope, input.runId)
    const run = this.#createRun(scope, input.runId, baseline, expectedAdmission)

    try {
      await this.#attach(run, baseline)

      // Observation is already draining while this second authoritative read
      // closes the history-to-subscription window.
      const caughtUp = await this.#readHistory(scope.sessionId, baseline)
      if (caughtUp.length) {
        if (!resume)
          throw new Error("OpenCode became active before prompt admission")
        const next = caughtUp.at(-1)!.seq
        run.projector = this.#projector(run, next)
        this.#discardBufferedThrough(run, next)
      }
      if (run.segmentClosed)
        throw new Error("OpenCode observation failed before run mutation")

      const after = run.projector.recoveryPosition().lastSeen
      if (resume) {
        await this.#options.resume!.dispatch(scope, resume)
      } else {
        const acknowledgement = await this.#client.sessions.prompt(
          scope.sessionId,
          { id: expectedAdmission!, prompt: { text: text! }, resume: true }
        )
        validateAdmission(acknowledgement, {
          id: expectedAdmission!,
          sessionId: scope.sessionId,
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
  ): Promise<ServerRunHandle> {
    if (request.threadId !== scope.threadId)
      throw new Error(
        "The reconnect position is not authorized for this Session"
      )
    await this.#verifyOwnership(scope)
    const expectedEpoch = `opencode:${scope.sessionId}`
    if (
      request.position &&
      (request.position.epoch !== expectedEpoch ||
        integer(request.position.lastSeen) === undefined)
    )
      throw new Error("The reconnect position is invalid")

    const requestedAfter = request.position?.lastSeen ?? -1
    const expectedAdmission = admissionId(scope, request.runId)
    const run = this.#createRun(
      scope,
      request.runId,
      requestedAfter,
      expectedAdmission
    )

    try {
      // Start consuming immediately. The bounded buffer remains live while the
      // complete authoritative log is read and the requested interval located.
      await this.#attach(run, requestedAfter)
      const all = await this.#readHistory(scope.sessionId)
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
      const projectionStart = request.position
        ? request.position.lastSeen
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
    runId: string,
    after: number,
    expectedAdmission?: string
  ): ActiveRun {
    const queue = new EventQueue(this.#maxQueueEvents)
    const segmentSettlement = settlement()
    const key = runKey(scope)
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
        monitoring: false,
        waitFailures: 0,
        stopRequested: false,
      }
      this.#nativeSettlements.set(key, nativeSettlement)
    }
    queue.push({ type: EventType.RUN_STARTED, threadId: scope.threadId, runId })
    return {
      key,
      scope,
      runId,
      projector: new OpenCodeEventProjector(
        { sessionId: scope.sessionId, threadId: scope.threadId, runId },
        after,
        { admissionId: expectedAdmission }
      ),
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
      waiting: false,
      waitFailures: 0,
      expectedAdmission,
      admissionObserved: expectedAdmission === undefined,
      settled: segmentSettlement.settled,
      settle: segmentSettlement.settle,
      nativeSettlement,
    }
  }

  #projector(run: ActiveRun, after: number, expectedAdmission?: string) {
    return new OpenCodeEventProjector(
      {
        sessionId: run.scope.sessionId,
        threadId: run.scope.threadId,
        runId: run.runId,
      },
      after,
      { admissionId: expectedAdmission }
    )
  }

  async #attach(run: ActiveRun, after: number) {
    const prior = this.#runs.get(run.key)
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
    this.#runs.set(run.key, run)
    run.source = await this.#client.sessions.events(
      run.scope.sessionId,
      after < 0 ? {} : { after: String(after) }
    )
    this.#pump(run)
  }

  #pump(run: ActiveRun) {
    void (async () => {
      try {
        for await (const value of run.source!) {
          if (run.abandoned || run.nativeTerminal) return
          const event = validateOpenCodeLiveEvent(value, run.scope.sessionId)
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
            "The OpenCode connection was interrupted; reconnect to reconcile this run."
          )
      } catch (error) {
        if (run.sourceAborted || run.abandoned || run.nativeTerminal) return
        this.#segmentFail(
          run,
          error instanceof OpenCodeEventValidationError
            ? "AOS_RESET_REQUIRED"
            : "AOS_CONNECTION_INTERRUPTED",
          error instanceof OpenCodeEventValidationError
            ? "OpenCode history must be reconciled before this run can continue."
            : "The OpenCode connection was interrupted; reconnect to reconcile this run."
        )
      }
    })()
  }

  #scheduleReconcile(run: ActiveRun) {
    if (run.reconciling) {
      run.reconcileAgain = true
      return
    }
    void this.#reconcile(run).catch((error) =>
      this.#reconciliationFailed(run, error)
    )
  }

  async #reconcile(run: ActiveRun) {
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
            run.scope.sessionId,
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

  async #mergeAuthoritative(run: ActiveRun) {
    const after = run.projector.recoveryPosition().lastSeen
    const history = await this.#readHistory(
      run.scope.sessionId,
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

  #watchWait(run: ActiveRun) {
    if (run.waiting || run.nativeTerminal || run.abandoned) return
    run.waiting = true
    void this.#client.sessions
      .wait(run.scope.sessionId, run.controller.signal)
      .then(async () => {
        run.waiting = false
        run.waitFailures = 0
        if (run.abandoned || run.nativeTerminal) return
        await this.#reconcile(run)
        if (!run.nativeTerminal) this.#scheduleWaitRetry(run)
      })
      .catch(() => {
        run.waiting = false
        if (
          run.controller.signal.aborted ||
          run.abandoned ||
          run.nativeTerminal
        )
          return
        run.waitFailures += 1
        this.#scheduleWaitRetry(run)
      })
  }

  #scheduleWaitRetry(run: ActiveRun) {
    const multiplier = Math.min(2 ** run.waitFailures, 16)
    const timer = setTimeout(() => {
      void this.#reconcile(run)
        .catch((error) => this.#reconciliationFailed(run, error))
        .finally(() => this.#watchWait(run))
    }, this.#waitRetryMs * multiplier)
    timer.unref?.()
  }

  #reconciliationFailed(run: ActiveRun, error: unknown) {
    this.#segmentFail(
      run,
      error instanceof OpenCodeEventValidationError
        ? "AOS_RESET_REQUIRED"
        : "AOS_CONNECTION_INTERRUPTED",
      error instanceof OpenCodeEventValidationError
        ? "OpenCode history must be reconciled before this run can continue."
        : "The OpenCode connection was interrupted; reconnect to reconcile this run."
    )
  }

  #handle(run: ActiveRun): ServerRunHandle {
    return {
      events: run.queue,
      settled: run.settled,
      stop: () => this.#stop(run),
      recoveryPosition: () => run.projector.recoveryPosition(),
    }
  }

  #publish(
    run: ActiveRun,
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
          "The OpenCode event buffer was exceeded; reconnect to reconcile this run.",
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
    }
  }

  #finish(run: ActiveRun, authoritativeNativeIdle = true) {
    if (run.nativeTerminal) return
    run.nativeTerminal = true
    if (authoritativeNativeIdle) this.#settleNative(run.nativeSettlement)
    run.controller.abort()
    this.#abortSource(run)
    if (!run.admissionObserved) {
      this.#segmentFail(
        run,
        "AOS_RESET_REQUIRED",
        "OpenCode became idle before its stable prompt admission could be reconciled."
      )
      if (this.#runs.get(run.key) === run) this.#runs.delete(run.key)
      return
    }
    if (!run.segmentClosed) {
      this.#publish(run, run.projector.finish())
      run.queue.close()
      run.segmentClosed = true
    }
    run.settle()
    if (this.#runs.get(run.key) === run) this.#runs.delete(run.key)
  }

  #segmentFail(run: ActiveRun, code: string, message: string, reset = false) {
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

  #abortSource(run: ActiveRun) {
    if (run.sourceAborted) return
    run.sourceAborted = true
    run.source?.abort()
  }

  #abandon(run: ActiveRun) {
    run.abandoned = true
    run.controller.abort()
    this.#abortSource(run)
    run.queue.close()
    run.settle()
    if (run.nativeSettlement.stopRequested)
      this.#monitorNativeSettlement(run.nativeSettlement)
    if (this.#runs.get(run.key) === run) this.#runs.delete(run.key)
  }

  #discardBufferedThrough(run: ActiveRun, seq: number) {
    for (const value of run.buffer.keys())
      if (value <= seq) run.buffer.delete(value)
  }

  async #stop(run: ActiveRun): Promise<"stopping" | "idle"> {
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    if (run.nativeSettlement.stopRequested) return this.#recheckStop(run)
    await this.#client.sessions.interrupt(run.scope.sessionId)
    run.nativeSettlement.stopRequested = true
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    run.projector.markStopping()
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

  async #recheckStop(run: ActiveRun): Promise<"stopping" | "idle"> {
    if (run.nativeTerminal || run.nativeSettlement.done) return "idle"
    try {
      if (!(await this.#active(run.scope.sessionId))) {
        const current = this.#runs.get(run.key)
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

  async #verifyOwnership(scope: SessionScope) {
    validateSessionOwner(
      await this.#client.sessions.get(scope.sessionId),
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
    if (this.#nativeSettlements.get(settlement.key) === settlement)
      this.#nativeSettlements.delete(settlement.key)
  }

  #monitorNativeSettlement(settlement: ScopedNativeSettlement) {
    if (settlement.done || settlement.monitoring) return
    settlement.monitoring = true
    const reconcile = async () => {
      if (settlement.done) return
      try {
        const current = this.#runs.get(settlement.key)
        if (current && !current.abandoned) {
          await this.#reconcile(current)
        } else if (!(await this.#active(settlement.scope.sessionId))) {
          this.#settleNative(settlement)
          return
        }
        settlement.waitFailures = 0
      } catch {
        settlement.waitFailures += 1
      }
      if (settlement.done) return
      const multiplier = Math.min(2 ** settlement.waitFailures, 16)
      const timer = setTimeout(reconcile, this.#waitRetryMs * multiplier)
      timer.unref?.()
    }
    void reconcile()
  }
}
