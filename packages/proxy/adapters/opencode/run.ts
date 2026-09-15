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
import { OpenCodeEventProjector, OpenCodeEventValidationError } from "./events"

const MAX_HISTORY_PAGES = 1_000
const MAX_USER_TURN_BYTES = 1024 * 1024

export type OpenCodeBoundResume = (
  scope: SessionScope,
  resume: readonly ResumeEntry[]
) => Promise<{ admittedSeq: number }>

export type OpenCodeRunEngineOptions = Readonly<{
  resume?: OpenCodeBoundResume
}>

type ActiveRun = {
  scope: SessionScope
  projector: OpenCodeEventProjector
  queue: EventQueue
  source?: OpenCodeSessionEvents
  terminal: boolean
  settle(): void
  settled: Promise<void>
}

class EventQueue implements AsyncIterable<AGUIEvent> {
  readonly #values: AGUIEvent[] = []
  readonly #waiters: Array<() => void> = []
  #closed = false

  push(event: AGUIEvent) {
    if (this.#closed) return
    this.#values.push(event)
    this.#waiters.shift()?.()
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
    text?: string
  }>
) {
  const envelope = record(value)
  const admission = record(envelope?.data)
  const prompt = record(admission?.prompt)
  const admittedSeq = integer(admission?.admittedSeq)
  if (
    !admission ||
    admittedSeq === undefined ||
    admission.id !== expected.id ||
    admission.sessionID !== expected.sessionId ||
    (admission.delivery !== "queue" && admission.delivery !== "steer") ||
    typeof admission.timeCreated !== "number" ||
    !Number.isFinite(admission.timeCreated) ||
    !prompt ||
    (expected.text !== undefined && prompt.text !== expected.text)
  )
    throw new OpenCodeMutationUncertainError()
  return admittedSeq
}

function validateResumeAdmission(value: unknown) {
  const result = record(value)
  const admittedSeq = integer(result?.admittedSeq)
  if (admittedSeq === undefined) throw new OpenCodeMutationUncertainError()
  return admittedSeq
}

function historyPage(value: unknown) {
  const page = record(value)
  if (!page || !Array.isArray(page.data) || typeof page.hasMore !== "boolean")
    throw new OpenCodeClientError("invalid_response")
  return { data: page.data, hasMore: page.hasMore }
}

function settlement() {
  let resolve!: () => void
  let done = false
  const settled = new Promise<void>((next) => {
    resolve = next
  })
  return {
    settled,
    settle: () => {
      if (done) return
      done = true
      resolve()
    },
  }
}

export class OpenCodeRunEngine implements ServerRunEngine {
  readonly #client: OpenCodeClient
  readonly #options: OpenCodeRunEngineOptions

  constructor(client: OpenCodeClient, options: OpenCodeRunEngineOptions = {}) {
    this.#client = client
    this.#options = options
  }

  async start(
    scope: SessionScope,
    candidate: NewTurnRunInput | ResumeRunInput
  ): Promise<ServerRunHandle> {
    const { input, resume, text } = validateInput(scope, candidate)
    await this.#verifyOwnership(scope)
    if (await this.#active(scope.sessionId))
      throw new Error("OpenCode is already running this Session")

    let after: number
    if (resume) {
      if (!this.#options.resume)
        throw new Error("OpenCode interaction resume is unavailable")
      after = validateResumeAdmission(await this.#options.resume(scope, resume))
    } else {
      const id = admissionId(scope, input.runId)
      const acknowledgement = await this.#client.sessions.prompt(
        scope.sessionId,
        { id, prompt: { text: text! }, resume: true }
      )
      after = validateAdmission(acknowledgement, {
        id,
        sessionId: scope.sessionId,
        text,
      })
    }

    return await this.#observe(scope, input.runId, after)
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
    const after =
      request.position?.epoch === expectedEpoch ? request.position.lastSeen : 0
    if (integer(after) === undefined)
      throw new Error("The reconnect position is invalid")

    const run = this.#createRun(scope, request.runId, after)
    run.source = await this.#client.sessions.events(scope.sessionId, {
      after: String(after),
    })

    try {
      let cursor = after
      for (
        let pageNumber = 0;
        pageNumber < MAX_HISTORY_PAGES;
        pageNumber += 1
      ) {
        const page = historyPage(
          await this.#client.sessions.history(scope.sessionId, {
            after: cursor,
            limit: 100,
          })
        )
        for (const value of page.data)
          this.#publish(run, run.projector.acceptHistory(value))
        const next = run.projector.recoveryPosition().lastSeen
        if (!page.hasMore) break
        if (next <= cursor || pageNumber === MAX_HISTORY_PAGES - 1)
          throw new OpenCodeClientError("invalid_response")
        cursor = next
      }

      if (run.terminal) return this.#handle(run)
      if (!(await this.#active(scope.sessionId))) {
        this.#publish(run, run.projector.finish())
        return this.#handle(run)
      }
    } catch (error) {
      run.source.abort()
      run.queue.close()
      throw error
    }
    this.#pump(run)
    return this.#handle(run)
  }

  async #observe(scope: SessionScope, runId: string, after: number) {
    const run = this.#createRun(scope, runId, after)
    try {
      run.source = await this.#client.sessions.events(scope.sessionId, {
        after: String(after),
      })
      this.#pump(run)
    } catch {
      this.#publish(
        run,
        run.projector.fail(
          "AOS_CONNECTION_INTERRUPTED",
          "The OpenCode connection was interrupted; reconnect to reconcile this run."
        ),
        false
      )
    }
    return this.#handle(run)
  }

  #createRun(scope: SessionScope, runId: string, after: number): ActiveRun {
    const queue = new EventQueue()
    queue.push({ type: EventType.RUN_STARTED, threadId: scope.threadId, runId })
    return {
      scope,
      projector: new OpenCodeEventProjector(
        { sessionId: scope.sessionId, threadId: scope.threadId, runId },
        after
      ),
      queue,
      terminal: false,
      ...settlement(),
    }
  }

  #handle(run: ActiveRun): ServerRunHandle {
    return {
      events: run.queue,
      settled: run.settled,
      stop: () => this.#stop(run),
      recoveryPosition: () => run.projector.recoveryPosition(),
    }
  }

  #pump(run: ActiveRun) {
    void (async () => {
      try {
        for await (const value of run.source!) {
          this.#publish(run, run.projector.accept(value))
          if (run.terminal) return
        }
        if (!run.terminal)
          this.#publish(
            run,
            run.projector.fail(
              "AOS_CONNECTION_INTERRUPTED",
              "The OpenCode connection was interrupted; reconnect to reconcile this run."
            ),
            false
          )
      } catch (error) {
        if (run.terminal) return
        this.#publish(
          run,
          run.projector.fail(
            error instanceof OpenCodeEventValidationError
              ? "AOS_RESET_REQUIRED"
              : "AOS_CONNECTION_INTERRUPTED",
            error instanceof OpenCodeEventValidationError
              ? "OpenCode history must be reconciled before this run can continue."
              : "The OpenCode connection was interrupted; reconnect to reconcile this run."
          ),
          false
        )
      }
    })()
  }

  #publish(
    run: ActiveRun,
    projection: ReturnType<OpenCodeEventProjector["accept"]>,
    settle = true
  ) {
    for (const event of projection.events) run.queue.push(event)
    if (!projection.terminal) return
    run.terminal = true
    run.source?.abort()
    run.queue.close()
    if (settle) run.settle()
  }

  async #stop(run: ActiveRun): Promise<"stopping" | "idle"> {
    if (run.terminal) return "idle"
    await this.#client.sessions.interrupt(run.scope.sessionId)
    if (run.terminal) return "idle"
    run.projector.markStopping()
    try {
      if (!(await this.#active(run.scope.sessionId))) {
        this.#publish(run, run.projector.finish())
        return "idle"
      }
    } catch {
      // The interrupt acknowledgement is authoritative. A failed status read
      // cannot turn that acknowledged mutation into a retryable Stop.
    }
    return "stopping"
  }

  async #verifyOwnership(scope: SessionScope) {
    validateSessionOwner(
      await this.#client.sessions.get(scope.sessionId),
      scope
    )
  }

  async #active(sessionId: string) {
    return isSessionActive(await this.#client.sessions.active(), sessionId)
  }
}
