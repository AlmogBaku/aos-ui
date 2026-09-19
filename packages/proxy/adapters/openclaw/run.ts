import {
  EventType,
  RunAgentInputSchema,
  type ResumeEntry,
  type RunAgentInput,
  type RunFinishedInterruptOutcome,
  type TokenUsage,
} from "@ag-ui/core"
import type { RunEvent } from "../../core/events"
import { readSessionMessageIdentity } from "@openclaw/gateway-client"
import {
  AgentEventSchema,
  validateChatHistoryParams,
  validateChatSendParams,
  validateSessionsAbortParams,
  type EventFrame,
} from "@openclaw/gateway-protocol"
import { Check } from "typebox/value"

import {
  ServerRunConflictError,
  ServerRunStopNotDispatchedError,
  type RecoveryRequest,
  type ServerAttachmentStage,
  type ServerRunEngine,
  type ServerRunHandle,
  type SessionScope,
} from "../../core/runtime"
import { OpenClawClientRequestError } from "./client"
import {
  OpenClawContentPublicError,
  prepareOpenClawChatAttachments,
  readOpenClawChatAttachments,
} from "./content"
import {
  OpenClawSessionSubscriptions,
  type OpenClawReconciliationFence,
  type OpenClawSessionLease,
} from "./subscriptions"

const MAX_TURN_BYTES = 1_048_576
const MAX_TEXT_BYTES = 2_000_000
const MAX_QUEUE_EVENTS = 4_096
const MAX_QUEUE_BYTES = 8_000_000
const encoder = new TextEncoder()

export type OpenClawRunRequestOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: number | null
  expectFinal?: boolean
  onSent?: () => void
  onAccepted?: (payload: unknown) => void
}>

export interface OpenClawRunRequestClient {
  request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: OpenClawRunRequestOptions
  ): Promise<T>
}

export type OpenClawBoundResumeResult = Readonly<{
  status:
    "resolved" | "expired" | "already-resolved" | "uncertain" | "in-progress"
}>

export type OpenClawBoundResume = Readonly<{
  /** Proves the response belongs to one pending native run before observation. */
  validate(
    scope: SessionScope,
    resume: readonly ResumeEntry[]
  ): Promise<{ runId: string }>
  /** Rechecks native state and performs at most one response mutation. */
  dispatch(
    scope: SessionScope,
    resume: readonly ResumeEntry[]
  ): Promise<OpenClawBoundResumeResult>
  /** Reconstructs one exact native wait from current Gateway authority. */
  discover?(
    scope: SessionScope & { nativeRunId: string },
    approvalReplay: unknown
  ): Promise<{ outcome: RunFinishedInterruptOutcome } | undefined>
}>

export class OpenClawRunPublicError extends Error {
  constructor(
    readonly code:
      "AOS_PROVIDER_UNAVAILABLE" | "AOS_SEND_UNCERTAIN" | "AOS_STOP_UNCERTAIN",
    message: string
  ) {
    super(message)
    this.name = "OpenClawRunPublicError"
  }
}

type QueueWaiter = (value: IteratorResult<RunEvent>) => void

class EventQueue implements AsyncIterable<RunEvent> {
  readonly #events: Array<{ event: RunEvent; bytes: number }> = []
  readonly #waiters: QueueWaiter[] = []
  readonly #onOverflow?: () => void
  #bytes = 0
  #closed = false

  constructor(onOverflow?: () => void) {
    this.#onOverflow = onOverflow
  }

  push(event: RunEvent) {
    if (this.#closed) return false
    let bytes: number
    try {
      bytes = encoder.encode(JSON.stringify(event)).byteLength
    } catch {
      this.#onOverflow?.()
      return false
    }
    if (
      this.#events.length >= MAX_QUEUE_EVENTS ||
      bytes > MAX_QUEUE_BYTES - this.#bytes
    ) {
      this.#onOverflow?.()
      return false
    }
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else {
      this.#events.push({ event, bytes })
      this.#bytes += bytes
    }
    return true
  }

  terminal(event: RunEvent) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ done: false, value: event })
      this.#closed = true
      for (const pending of this.#waiters.splice(0))
        pending({ done: true, value: undefined })
      return
    }
    try {
      const bytes = encoder.encode(JSON.stringify(event)).byteLength
      if (
        this.#events.length < MAX_QUEUE_EVENTS &&
        bytes <= MAX_QUEUE_BYTES - this.#bytes
      ) {
        this.#events.push({ event, bytes })
        this.#bytes += bytes
      } else {
        const started =
          this.#events[0]?.event.type === EventType.RUN_STARTED
            ? this.#events[0]
            : undefined
        this.#events.splice(0)
        this.#bytes = 0
        if (started) {
          this.#events.push(started)
          this.#bytes = started.bytes
        }
        if (bytes <= MAX_QUEUE_BYTES - this.#bytes) {
          this.#events.push({ event, bytes })
          this.#bytes += bytes
        }
      }
    } catch {
      // A terminal event is provider-private and constructed from bounded data.
    }
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    return {
      next: () => {
        const entry = this.#events.shift()
        if (entry) {
          this.#bytes -= entry.bytes
          return Promise.resolve({ done: false, value: entry.event })
        }
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

type OpenTool = { name: string; messageId: string; ended: boolean }

type ActiveRun = {
  scope: SessionScope
  runId: string
  nativeRunId: string
  nativeSessionKey: string
  nativeSessionId: string
  queue: EventQueue
  lease: OpenClawSessionLease
  terminal: boolean
  stopping: boolean
  uncertain: boolean
  lastSeen: number
  lastAgentSeq: number
  lastChatSeq: number
  gapPending: boolean
  reconciling: boolean
  reconciliationDirty: boolean
  reconciliation?: Promise<void>
  text: string
  textBaseline?: string
  projectedText: string
  textGeneration: number
  textStarted: boolean
  reasoning: string
  reasoningStarted: boolean
  reasoningEnded: boolean
  tools: Map<string, OpenTool>
  planFingerprint?: string
  usage?: TokenUsage[]
  settled: Promise<void>
  resolveSettled(): void
}

type HistorySnapshot = {
  sessionKey: string
  sessionId: string
  messages: unknown[]
  hasActiveRun?: boolean
  activeRunIds?: string[]
  inFlightRun?: {
    runId: string
    text: string
    plan?: {
      steps: Array<{ step: string; status: string }>
      explanation?: string
    }
    events?: NativeAgentEvent[]
  }
}

type NativeAgentEvent = {
  runId: string
  seq: number
  stream: string
  ts: number
  spawnedBy?: string
  isHeartbeat?: boolean
  data: Record<string, unknown>
}

type NativePlan = NonNullable<HistorySnapshot["inFlightRun"]>["plan"]

type WaitingRun = {
  scope: SessionScope
  runId: string
  nativeRunId: string
  nativeInteractionSessionKey: string
  nativeSessionId: string
  lease: OpenClawSessionLease
  stopping: boolean
  terminal: boolean
}

function settlement() {
  let resolveSettled = () => {}
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  return { settled, resolveSettled }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function scopeKey(scope: SessionScope) {
  return `${scope.agentId}\u0000${scope.sessionId}`
}

function userText(input: RunAgentInput) {
  const message = input.messages[0]
  if (!message || message.role !== "user") return undefined
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return undefined
  let text = ""
  for (const part of message.content) {
    if (part.type !== "text") return undefined
    text += part.text
  }
  return text
}

function boundedText(value: unknown) {
  if (typeof value !== "string") return undefined
  return encoder.encode(value).byteLength <= MAX_TEXT_BYTES ? value : undefined
}

function safeJson(value: unknown, fallback = "{}") {
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" &&
      encoder.encode(json).byteLength <= 262_144
      ? json
      : fallback
  } catch {
    return fallback
  }
}

function safeClone(value: unknown) {
  const json = safeJson(value, "")
  if (!json) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function tokenUsage(value: unknown): TokenUsage[] | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const outputTokens = nonnegativeInteger(record.outputTokens)
  const inputTokens = nonnegativeInteger(record.inputTokens)
  const totalTokens = nonnegativeInteger(record.totalTokens)
  const reasoningTokens = nonnegativeInteger(record.reasoningTokens)
  const usage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
  return Object.keys(usage).length === 0 ? undefined : [usage]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

function messageText(value: unknown) {
  const message = record(value)
  if (!message) return undefined
  if (typeof message.content === "string") return boundedText(message.content)
  if (!Array.isArray(message.content)) return undefined
  let text = ""
  for (const part of message.content) {
    const item = record(part)
    if (item?.type !== "text" || typeof item.text !== "string") continue
    text += item.text
    if (encoder.encode(text).byteLength > MAX_TEXT_BYTES) return undefined
  }
  return text || undefined
}

function completedHistoryText(history: HistorySnapshot, runId: string) {
  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index]
    const identity = readSessionMessageIdentity(message)
    if (
      identity?.role !== "assistant" ||
      identity.runId !== runId ||
      identity.isImported
    )
      continue
    return messageText(message)
  }
  return undefined
}

function hasCompletedHistoryRun(history: HistorySnapshot, runId: string) {
  return history.messages.some((message) => {
    const identity = readSessionMessageIdentity(message)
    return (
      identity?.role === "assistant" &&
      identity.runId === runId &&
      !identity.isImported
    )
  })
}

function authoritativeRecoveryRunId(
  history: HistorySnapshot,
  normalizedRunId: string
) {
  const active = new Set(history.activeRunIds ?? [])
  if (history.inFlightRun) active.add(history.inFlightRun.runId)
  if (active.size === 1) return [...active][0]
  if (
    active.size === 0 &&
    authoritativelyIdle(history) &&
    hasCompletedHistoryRun(history, normalizedRunId)
  )
    return normalizedRunId
  return undefined
}

function uniqueActiveRunId(history: HistorySnapshot) {
  const active = new Set(history.activeRunIds ?? [])
  if (history.inFlightRun) active.add(history.inFlightRun.runId)
  return active.size === 1 ? [...active][0] : undefined
}

function authoritativelyIdle(history: HistorySnapshot) {
  return (
    history.hasActiveRun === false ||
    (history.activeRunIds !== undefined &&
      history.activeRunIds.length === 0 &&
      history.inFlightRun === undefined)
  )
}

function baselineAgentSequence(history: HistorySnapshot, nativeRunId: string) {
  if (history.inFlightRun?.runId !== nativeRunId) return -1
  return Math.max(
    -1,
    ...(history.inFlightRun.events ?? []).map(({ seq }) => seq)
  )
}

function planFingerprint(plan: NativePlan) {
  return plan === undefined ? undefined : safeJson(plan, "") || undefined
}

function validatedPlan(value: unknown) {
  const candidate = record(value)
  if (
    !candidate ||
    !Array.isArray(candidate.steps) ||
    candidate.steps.length > 100
  )
    return undefined
  const steps: Array<{ step: string; status: string }> = []
  for (const entry of candidate.steps) {
    const item = record(entry)
    const step = boundedText(item?.step)
    const status = item?.status
    if (
      !step ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed")
    )
      return undefined
    steps.push({ step, status })
  }
  const explanation =
    candidate.explanation === undefined
      ? undefined
      : boundedText(candidate.explanation)
  if (candidate.explanation !== undefined && explanation === undefined)
    return undefined
  return { steps, ...(explanation ? { explanation } : {}) }
}

function validatedProgressEvent(
  value: unknown,
  sessionKey: string,
  agentId: string
): NativeAgentEvent | undefined {
  const candidate = record(value)
  if (!candidate) return undefined
  const core = {
    runId: candidate.runId,
    seq: candidate.seq,
    stream: candidate.stream,
    ts: candidate.ts,
    ...(candidate.spawnedBy === undefined
      ? {}
      : { spawnedBy: candidate.spawnedBy }),
    ...(candidate.isHeartbeat === undefined
      ? {}
      : { isHeartbeat: candidate.isHeartbeat }),
    data: candidate.data,
  }
  if (
    !Check(AgentEventSchema, core) ||
    (candidate.sessionKey !== undefined &&
      candidate.sessionKey !== sessionKey) ||
    (candidate.agentId !== undefined && candidate.agentId !== agentId)
  )
    return undefined
  const data = safeClone(candidate.data)
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  return { ...core, data: data as Record<string, unknown> }
}

function validateHistory(
  value: unknown,
  expectedSessionKey: string,
  expectedAgentId: string,
  expectedSessionId?: string
): HistorySnapshot | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (
    record.sessionKey !== expectedSessionKey ||
    !validId(record.sessionId) ||
    (expectedSessionId !== undefined && record.sessionId !== expectedSessionId)
  )
    return undefined
  if (!Array.isArray(record.messages) || record.messages.length > 1_000)
    return undefined
  if (!record.sessionInfo || typeof record.sessionInfo !== "object")
    return undefined
  const info = record.sessionInfo as Record<string, unknown>
  const hasActiveRun = info.hasActiveRun
  if (hasActiveRun !== undefined && typeof hasActiveRun !== "boolean")
    return undefined
  const rawIds = info.activeRunIds
  if (
    rawIds !== undefined &&
    (!Array.isArray(rawIds) ||
      rawIds.length > 100 ||
      !rawIds.every(validId) ||
      new Set(rawIds).size !== rawIds.length)
  )
    return undefined
  let inFlightRun: HistorySnapshot["inFlightRun"]
  if (record.inFlightRun !== undefined) {
    if (!record.inFlightRun || typeof record.inFlightRun !== "object")
      return undefined
    const native = record.inFlightRun as Record<string, unknown>
    if (!validId(native.runId)) return undefined
    const text = boundedText(native.text)
    if (text === undefined) return undefined
    const plan =
      native.plan === undefined ? undefined : validatedPlan(native.plan)
    if (native.plan !== undefined && plan === undefined) return undefined
    let events: NativeAgentEvent[] | undefined
    if (native.events !== undefined) {
      if (!Array.isArray(native.events) || native.events.length > 200)
        return undefined
      events = []
      for (const event of native.events) {
        const validated = validatedProgressEvent(
          event,
          expectedSessionKey,
          expectedAgentId
        )
        if (!validated || validated.runId !== native.runId) return undefined
        events.push(validated)
      }
    }
    inFlightRun = {
      runId: native.runId,
      text,
      ...(plan ? { plan } : {}),
      ...(events ? { events } : {}),
    }
  }
  const activeRunIds = rawIds as string[] | undefined
  if (
    (hasActiveRun === false &&
      (inFlightRun !== undefined || (activeRunIds?.length ?? 0) > 0)) ||
    (hasActiveRun === true && activeRunIds?.length === 0) ||
    (inFlightRun !== undefined &&
      activeRunIds !== undefined &&
      !activeRunIds.includes(inFlightRun.runId))
  )
    return undefined
  return {
    sessionKey: expectedSessionKey,
    sessionId: record.sessionId,
    messages: record.messages,
    ...(hasActiveRun === undefined ? {} : { hasActiveRun }),
    ...(activeRunIds === undefined ? {} : { activeRunIds }),
    ...(inFlightRun ? { inFlightRun } : {}),
  }
}

function acceptedRunId(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return record.status === "accepted" && validId(record.runId)
    ? record.runId
    : undefined
}

function finalAcknowledgement(value: unknown) {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.status === "ok" &&
    (record.runId === undefined || validId(record.runId))
  )
}

function requestWasSent(error: unknown, callbackObserved: boolean) {
  return (
    callbackObserved ||
    (error instanceof OpenClawClientRequestError && error.requestSent)
  )
}

function providerUnavailable() {
  return new OpenClawRunPublicError(
    "AOS_PROVIDER_UNAVAILABLE",
    "OpenClaw is temporarily unavailable."
  )
}

export class OpenClawRunEngine implements ServerRunEngine {
  readonly #client: OpenClawRunRequestClient
  readonly #subscriptions: OpenClawSessionSubscriptions
  readonly #toolEvents: boolean
  readonly #resume?: OpenClawBoundResume
  readonly #active = new Map<string, ActiveRun>()
  readonly #waiting = new Map<string, WaitingRun>()

  constructor(options: {
    client: OpenClawRunRequestClient
    subscriptions: OpenClawSessionSubscriptions
    toolEvents?: boolean
    resume?: OpenClawBoundResume
  }) {
    this.#client = options.client
    this.#subscriptions = options.subscriptions
    this.#toolEvents = options.toolEvents === true
    this.#resume = options.resume
  }

  async start(
    scope: SessionScope,
    candidate: Parameters<ServerRunEngine["start"]>[1],
    attachmentStage?: ServerAttachmentStage
  ): Promise<ServerRunHandle> {
    const input = RunAgentInputSchema.parse(candidate)
    const text = userText(input)
    const resume = input.resume?.length ? input.resume : undefined
    const stagedAttachments = readOpenClawChatAttachments(attachmentStage)
    if (attachmentStage && !stagedAttachments)
      throw new Error(
        "The staged attachment payload does not belong to OpenClaw"
      )
    if (resume && stagedAttachments)
      throw new Error(
        "OpenClaw interrupt responses cannot include staged attachments"
      )
    if (
      !validId(scope.agentId) ||
      !validId(scope.sessionId) ||
      input.threadId !== scope.threadId
    )
      throw new Error("AOS run scope does not match this Session")
    if (
      input.tools.length > 0 ||
      input.context.length > 0 ||
      Object.keys(input.state).length > 0 ||
      Object.keys(input.forwardedProps).length > 0 ||
      ("rewindSourceId" in candidate && candidate.rewindSourceId !== undefined)
    )
      throw new Error("AOS runs require exactly one authorized plain-text turn")
    if (resume) {
      if (input.messages.length !== 0 || !this.#resume)
        throw new Error(
          "OpenClaw interrupt responses require one bound native interaction"
        )
    } else if (
      input.messages.length !== 1 ||
      text === undefined ||
      !text.trim()
    )
      throw new Error("AOS runs require exactly one authorized plain-text turn")
    if (text !== undefined && encoder.encode(text).byteLength > MAX_TURN_BYTES)
      throw new Error("The AOS user turn is too large")

    const key = scopeKey(scope)
    const waiting = this.#waiting.get(key)
    const interactionScope = waiting
      ? { ...scope, sessionId: waiting.nativeInteractionSessionKey }
      : scope
    const resumeBinding = resume
      ? await this.#resume!.validate(interactionScope, resume)
      : undefined
    if (resumeBinding && !validId(resumeBinding.runId))
      throw new Error("OpenClaw returned an invalid interaction binding")

    if (this.#active.has(key)) throw new ServerRunConflictError()
    if (waiting && resumeBinding?.runId !== waiting.nativeRunId)
      throw new ServerRunConflictError()

    let lease: OpenClawSessionLease | undefined
    try {
      const holder: { active?: ActiveRun } = {}
      let admissionDirty = false
      lease = await this.#subscriptions.acquire(
        { agentId: scope.agentId, sessionKey: scope.sessionId },
        (event) => {
          const current = holder.active
          if (!current) admissionDirty = true
          else if (current.reconciling) current.reconciliationDirty = true
          else this.#accept(current, event)
        },
        async (_reason, fence) => {
          const current = holder.active
          if (current) {
            current.lastSeen = 0
            current.lastAgentSeq = -1
            current.lastChatSeq = -1
            try {
              await this.#reconcile(current, fence)
            } catch (error) {
              this.#markInterrupted(current)
              throw error
            }
          }
        }
      )
      let baseline: HistorySnapshot
      do {
        admissionDirty = false
        const generation = this.#subscriptions.generation
        baseline = await this.#history(scope, lease)
        if (generation !== this.#subscriptions.generation) admissionDirty = true
      } while (admissionDirty)
      const boundRunActive =
        resumeBinding !== undefined &&
        (baseline.inFlightRun?.runId === resumeBinding.runId ||
          baseline.activeRunIds?.includes(resumeBinding.runId) === true)
      if (
        (!resume && !this.#authoritativelyIdle(baseline)) ||
        (resume && !boundRunActive && !this.#authoritativelyIdle(baseline))
      )
        throw new ServerRunConflictError()
      const resumeSnapshot =
        resume && baseline.inFlightRun?.runId === resumeBinding?.runId
          ? baseline.inFlightRun
          : undefined
      const sendParams = resume
        ? undefined
        : stagedAttachments
          ? prepareOpenClawChatAttachments(
              {
                sessionKey: baseline.sessionKey,
                agentId: scope.agentId,
                message: text!,
                idempotencyKey: input.runId,
                attachments: stagedAttachments.attachments,
              },
              stagedAttachments.policy
            ).native
          : {
              sessionKey: baseline.sessionKey,
              agentId: scope.agentId,
              message: text!,
              idempotencyKey: input.runId,
            }
      if (sendParams && !validateChatSendParams(sendParams))
        throw new Error("Invalid OpenClaw chat.send request")

      const queue = new EventQueue(() => {
        if (holder.active)
          this.#fail(
            holder.active,
            "AOS_RESET_REQUIRED",
            "OpenClaw produced more live output than AOS can safely buffer."
          )
      })
      queue.push({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      })
      const active: ActiveRun = {
        scope,
        runId: input.runId,
        nativeRunId: resumeBinding?.runId ?? input.runId,
        nativeSessionKey: baseline.sessionKey,
        nativeSessionId: baseline.sessionId,
        queue,
        lease,
        terminal: false,
        stopping: false,
        uncertain: false,
        lastSeen: 0,
        lastAgentSeq: resumeSnapshot
          ? baselineAgentSequence(baseline, resumeSnapshot.runId)
          : -1,
        lastChatSeq: -1,
        gapPending: false,
        reconciling: false,
        reconciliationDirty: false,
        text: resumeSnapshot?.text ?? "",
        ...(resume ? { textBaseline: resumeSnapshot?.text ?? "" } : {}),
        projectedText: "",
        textGeneration: 0,
        textStarted: false,
        reasoning: "",
        reasoningStarted: false,
        reasoningEnded: false,
        tools: new Map(),
        ...(resumeSnapshot?.plan
          ? { planFingerprint: planFingerprint(resumeSnapshot.plan) }
          : {}),
        ...settlement(),
      }
      holder.active = active
      this.#active.set(key, active)
      if (waiting) {
        this.#waiting.delete(key)
        waiting.terminal = true
        void waiting.lease.release().catch(() => {})
      }

      if (resume) {
        if (active.terminal) return this.#handle(active)
        let result: OpenClawBoundResumeResult
        try {
          result = await this.#resume!.dispatch(interactionScope, resume)
        } catch {
          this.#fail(
            active,
            "AOS_INTERACTION_FAILED",
            "OpenClaw could not apply this interaction response."
          )
          return this.#handle(active)
        }
        if (active.terminal) return this.#handle(active)
        if (result.status === "uncertain") {
          this.#markUncertain(
            active,
            "AOS_INTERACTION_UNCERTAIN",
            "OpenClaw may have accepted this interaction response."
          )
          return this.#handle(active)
        }
        if (result.status === "expired") {
          this.#fail(
            active,
            "AOS_INTERACTION_EXPIRED",
            "This OpenClaw interaction is no longer pending."
          )
          return this.#handle(active)
        }
        await this.#reconcile(active).catch(() => this.#markInterrupted(active))
        return this.#handle(active)
      }

      let sent = false
      let admitted = false
      let resolveAdmission = () => {}
      let rejectAdmission: (error: unknown) => void = () => {}
      const admission = new Promise<void>((resolve, reject) => {
        resolveAdmission = resolve
        rejectAdmission = reject
      })
      const request = this.#client
        .request<unknown>("chat.send", sendParams!, {
          expectFinal: true,
          onSent: () => {
            sent = true
          },
          onAccepted: (payload) => {
            sent = true
            const runId = acceptedRunId(payload)
            if (runId !== active?.nativeRunId) {
              rejectAdmission(
                new OpenClawRunPublicError(
                  "AOS_SEND_UNCERTAIN",
                  "OpenClaw may have accepted this turn."
                )
              )
              return
            }
            admitted = true
            resolveAdmission()
          },
        })
        .then((result) => {
          if (!finalAcknowledgement(result))
            throw new Error("Invalid OpenClaw final acknowledgement")
          const runId = (result as Record<string, unknown>).runId
          if (runId !== undefined && runId !== active?.nativeRunId)
            throw new Error("OpenClaw acknowledged a different run")
          if (!admitted) {
            admitted = true
            resolveAdmission()
          }
          if (active && !active.terminal)
            void this.#reconcile(active).catch(() =>
              this.#markInterrupted(active)
            )
        })
        .catch((error: unknown) => {
          if (!admitted) rejectAdmission(error)
          else if (active && !active.terminal)
            void this.#reconcile(active).catch(() =>
              this.#markInterrupted(active)
            )
        })
      void request

      try {
        await admission
      } catch (error) {
        if (requestWasSent(error, sent)) {
          active.uncertain = true
          this.#markUncertain(
            active,
            "AOS_SEND_UNCERTAIN",
            "OpenClaw may have accepted this turn."
          )
          return this.#handle(active)
        }
        this.#active.delete(key)
        await lease.release().catch(() => {})
        active.queue.close()
        active.resolveSettled()
        throw providerUnavailable()
      }
      return this.#handle(active)
    } catch (error) {
      if (lease && !this.#active.has(key)) await lease.release().catch(() => {})
      if (error instanceof ServerRunConflictError) throw error
      if (error instanceof OpenClawRunPublicError) throw error
      if (error instanceof OpenClawContentPublicError) throw error
      throw providerUnavailable()
    }
  }

  async recover(
    scope: SessionScope,
    request: RecoveryRequest
  ): Promise<ServerRunHandle> {
    if (
      !validId(scope.agentId) ||
      !validId(scope.sessionId) ||
      request.threadId !== scope.threadId ||
      !validId(request.runId)
    )
      throw new Error("AOS recovery scope does not match this Session")
    const key = scopeKey(scope)
    const existing = this.#active.get(key)
    if (existing) {
      if (existing.runId !== request.runId) throw new ServerRunConflictError()
      existing.queue.close()
      existing.queue = new EventQueue(() =>
        this.#fail(
          existing,
          "AOS_RESET_REQUIRED",
          "OpenClaw produced more live output than AOS can safely buffer."
        )
      )
      existing.queue.push({
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: request.runId,
      })
      await this.#reconcile(existing).catch(() =>
        this.#markInterrupted(existing)
      )
      return this.#handle(existing)
    }
    let lease: OpenClawSessionLease | undefined
    try {
      const holder: { active?: ActiveRun } = {}
      let recoveryDirty = false
      lease = await this.#subscriptions.acquire(
        { agentId: scope.agentId, sessionKey: scope.sessionId },
        (event) => {
          const current = holder.active
          if (!current) recoveryDirty = true
          else if (current.reconciling) current.reconciliationDirty = true
          else this.#accept(current, event)
        },
        async (_reason, fence) => {
          const current = holder.active
          if (current) {
            current.lastSeen = 0
            current.lastAgentSeq = -1
            current.lastChatSeq = -1
            try {
              await this.#reconcile(current, fence)
            } catch (error) {
              this.#markInterrupted(current)
              throw error
            }
          }
        }
      )
      let baseline: HistorySnapshot
      do {
        recoveryDirty = false
        const generation = this.#subscriptions.generation
        baseline = await this.#history(scope, lease)
        if (generation !== this.#subscriptions.generation) recoveryDirty = true
      } while (recoveryDirty)
      const nativeRunId = authoritativeRecoveryRunId(baseline, request.runId)
      const resumedSnapshot =
        nativeRunId !== undefined &&
        nativeRunId !== request.runId &&
        baseline.inFlightRun?.runId === nativeRunId
          ? baseline.inFlightRun
          : undefined
      const queue = new EventQueue(() => {
        if (holder.active)
          this.#fail(
            holder.active,
            "AOS_RESET_REQUIRED",
            "OpenClaw produced more live output than AOS can safely buffer."
          )
      })
      queue.push({
        type: EventType.RUN_STARTED,
        threadId: scope.threadId,
        runId: request.runId,
      })
      const active: ActiveRun = {
        scope,
        runId: request.runId,
        nativeRunId: nativeRunId ?? "",
        nativeSessionKey: baseline.sessionKey,
        nativeSessionId: baseline.sessionId,
        queue,
        lease,
        terminal: false,
        stopping: false,
        uncertain: false,
        lastSeen: request.position?.lastSeen ?? 0,
        lastAgentSeq: resumedSnapshot
          ? baselineAgentSequence(baseline, resumedSnapshot.runId)
          : -1,
        lastChatSeq: -1,
        gapPending: false,
        reconciling: false,
        reconciliationDirty: false,
        text: resumedSnapshot?.text ?? "",
        ...(resumedSnapshot ? { textBaseline: resumedSnapshot.text } : {}),
        projectedText: "",
        textGeneration: 0,
        textStarted: false,
        reasoning: "",
        reasoningStarted: false,
        reasoningEnded: false,
        tools: new Map(),
        ...(resumedSnapshot?.plan
          ? { planFingerprint: planFingerprint(resumedSnapshot.plan) }
          : {}),
        ...settlement(),
      }
      holder.active = active
      this.#active.set(key, active)
      if (!nativeRunId)
        this.#fail(
          active,
          "AOS_RESET_REQUIRED",
          "OpenClaw could not authoritatively bind this recovered run."
        )
      else this.#applyHistory(active, baseline)
      return this.#handle(active)
    } catch (error) {
      this.#active.delete(key)
      await lease?.release().catch(() => {})
      if (error instanceof ServerRunConflictError) throw error
      throw providerUnavailable()
    }
  }

  async discover(scope: SessionScope, runId: string) {
    const key = scopeKey(scope)
    const existingWaiting = this.#waiting.get(key)
    if (
      !this.#resume?.discover ||
      !validId(scope.agentId) ||
      !validId(scope.sessionId) ||
      !validId(runId) ||
      this.#active.has(key)
    )
      return undefined
    if (existingWaiting && existingWaiting.runId !== runId)
      throw new ServerRunConflictError()
    let lease: OpenClawSessionLease | undefined
    let discoveryDirty = false
    try {
      const retireExisting = async () => {
        if (!existingWaiting) return
        existingWaiting.terminal = true
        if (this.#waiting.get(key) === existingWaiting)
          this.#waiting.delete(key)
        await existingWaiting.lease.release().catch(() => {})
      }
      const notDiscovered = async () => {
        await lease?.release().catch(() => {})
        lease = undefined
        await retireExisting()
        return undefined
      }
      const holder: { waiting?: WaitingRun } = {}
      lease = await this.#subscriptions.acquire(
        { agentId: scope.agentId, sessionKey: scope.sessionId },
        (event) => {
          if (!holder.waiting) discoveryDirty = true
          else this.#acceptWaiting(holder.waiting, event)
        },
        async () => {
          discoveryDirty = true
        }
      )
      let refreshApprovalReplay = discoveryDirty || lease.takeApprovalDirty()
      for (;;) {
        discoveryDirty = false
        const generation = this.#subscriptions.generation
        if (refreshApprovalReplay) await lease.refreshApprovalReplay()
        if (discoveryDirty || generation !== this.#subscriptions.generation) {
          refreshApprovalReplay = true
          continue
        }
        const history = await this.#history(scope, lease)
        const approvalReplay = lease.approvalReplay()
        if (discoveryDirty || generation !== this.#subscriptions.generation) {
          refreshApprovalReplay = true
          continue
        }
        const approvalReplayKey = lease.approvalReplayKey
        if (
          !approvalReplay ||
          approvalReplay.generation !== generation ||
          approvalReplayKey !== approvalReplay.replay.sessionKey
        ) {
          return notDiscovered()
        }
        const nativeRunId = uniqueActiveRunId(history)
        if (!nativeRunId) return notDiscovered()
        const discovered = await this.#resume.discover(
          {
            ...scope,
            sessionId: approvalReplayKey,
            nativeRunId,
          },
          approvalReplay.replay
        )
        const currentApprovalReplay = lease.approvalReplay()
        const currentApprovalReplayKey = lease.approvalReplayKey
        if (discoveryDirty || generation !== this.#subscriptions.generation) {
          refreshApprovalReplay = true
          continue
        }
        if (
          !currentApprovalReplay ||
          currentApprovalReplay.generation !== generation ||
          currentApprovalReplayKey !== approvalReplayKey ||
          currentApprovalReplayKey !== currentApprovalReplay.replay.sessionKey
        ) {
          return notDiscovered()
        }
        if (!discovered) return notDiscovered()
        const waiting: WaitingRun = {
          scope,
          runId,
          nativeRunId,
          nativeInteractionSessionKey: approvalReplayKey,
          nativeSessionId: history.sessionId,
          lease,
          stopping: false,
          terminal: false,
        }
        holder.waiting = waiting
        this.#waiting.set(key, waiting)
        await retireExisting()
        lease = undefined
        const events: RunEvent[] = [
          { type: EventType.RUN_STARTED, threadId: scope.threadId, runId },
          {
            type: EventType.RUN_FINISHED,
            threadId: scope.threadId,
            runId,
            outcome: discovered.outcome,
          },
        ]
        return {
          state: "waiting-for-input" as const,
          interrupts: discovered.outcome.interrupts,
          handle: {
            events: (async function* () {
              yield* events
            })(),
            settled: Promise.resolve(),
            stop: () => this.#stopWaiting(waiting),
            recoveryPosition: () => ({
              epoch: String(generation),
              lastSeen: 0,
            }),
          },
        }
      }
    } catch (error) {
      await lease?.release().catch(() => {})
      if (error instanceof OpenClawRunPublicError) throw error
      throw providerUnavailable()
    }
  }

  async #history(
    scope: SessionScope,
    lease: OpenClawSessionLease,
    expectedSessionId?: string
  ) {
    const params = {
      sessionKey: lease.key,
      agentId: scope.agentId,
      limit: 200,
      maxBytes: 1_000_000,
    }
    if (!validateChatHistoryParams(params))
      throw new Error("Invalid OpenClaw chat.history request")
    const history = validateHistory(
      await this.#client.request<unknown>("chat.history", params),
      lease.key,
      scope.agentId,
      expectedSessionId
    )
    if (!history) throw new Error("Invalid OpenClaw chat.history response")
    return history
  }

  #authoritativelyIdle(history: HistorySnapshot) {
    return authoritativelyIdle(history)
  }

  #handle(active: ActiveRun): ServerRunHandle {
    return {
      events: active.queue,
      settled: active.settled,
      stop: () => this.#stop(active),
      recoveryPosition: () => ({
        epoch: String(this.#subscriptions.generation),
        lastSeen: active.lastSeen,
      }),
    }
  }

  #acceptWaiting(waiting: WaitingRun, event: EventFrame) {
    if (waiting.terminal || event.event !== "chat") return
    const payload = record(event.payload)
    if (
      payload?.runId !== waiting.nativeRunId ||
      (payload.sessionId !== undefined &&
        payload.sessionId !== waiting.nativeSessionId) ||
      (payload.state !== "final" &&
        payload.state !== "aborted" &&
        payload.state !== "error")
    )
      return
    this.#finishWaiting(waiting)
  }

  #finishWaiting(waiting: WaitingRun) {
    if (waiting.terminal) return
    waiting.terminal = true
    if (this.#waiting.get(scopeKey(waiting.scope)) === waiting)
      this.#waiting.delete(scopeKey(waiting.scope))
    void waiting.lease.release().catch(() => {})
  }

  async #waitingStatus(waiting: WaitingRun): Promise<"stopping" | "idle"> {
    if (waiting.terminal) return "idle"
    try {
      const history = await this.#history(
        waiting.scope,
        waiting.lease,
        waiting.nativeSessionId
      )
      if (authoritativelyIdle(history)) {
        this.#finishWaiting(waiting)
        return "idle"
      }
    } catch {
      // A failed status read cannot authorize another abort or an idle claim.
    }
    return "stopping"
  }

  async #stopWaiting(waiting: WaitingRun): Promise<"stopping" | "idle"> {
    if (waiting.terminal) return "idle"
    if (waiting.stopping) return this.#waitingStatus(waiting)
    waiting.stopping = true
    const params = {
      key: waiting.lease.key,
      agentId: waiting.scope.agentId,
      runId: waiting.nativeRunId,
    }
    if (!validateSessionsAbortParams(params))
      throw new Error("Invalid OpenClaw sessions.abort request")
    let sent = false
    try {
      const result = await this.#client.request<unknown>(
        "sessions.abort",
        params,
        {
          onSent: () => {
            sent = true
          },
        }
      )
      const acknowledgement = record(result)
      if (
        acknowledgement?.ok !== true ||
        (acknowledgement.status !== "aborted" &&
          acknowledgement.status !== "no-active-run") ||
        (acknowledgement.status === "aborted" &&
          acknowledgement.abortedRunId !== waiting.nativeRunId) ||
        (acknowledgement.status === "no-active-run" &&
          acknowledgement.abortedRunId !== null)
      )
        throw new Error("Invalid OpenClaw sessions.abort acknowledgement")
      if (acknowledgement.status === "no-active-run") {
        this.#finishWaiting(waiting)
        return "idle"
      }
    } catch (error) {
      if (requestWasSent(error, sent))
        throw new OpenClawRunPublicError(
          "AOS_STOP_UNCERTAIN",
          "OpenClaw may have accepted the Stop request."
        )
      waiting.stopping = false
      throw new ServerRunStopNotDispatchedError(providerUnavailable())
    }
    return this.#waitingStatus(waiting)
  }

  #accept(active: ActiveRun, event: EventFrame) {
    if (active.terminal) return
    const payload = record(event.payload)
    if (
      !payload ||
      payload.runId !== active.nativeRunId ||
      (payload.sessionId !== undefined &&
        payload.sessionId !== active.nativeSessionId)
    )
      return
    if (typeof event.seq === "number") active.lastSeen = event.seq

    const sequence = nonnegativeInteger(payload.seq)
    if (sequence === undefined) return
    const agentLike = event.event === "agent" || event.event === "session.tool"
    const previous = agentLike ? active.lastAgentSeq : active.lastChatSeq
    if (sequence <= previous) return
    if (previous >= 0 && sequence > previous + 1) {
      if (!active.gapPending) {
        active.gapPending = true
        void this.#subscriptions
          .replaceGeneration("gap")
          .catch(() => this.#markInterrupted(active))
          .finally(() => {
            active.gapPending = false
          })
      }
      return
    }
    if (agentLike) active.lastAgentSeq = sequence
    else if (event.event === "chat") active.lastChatSeq = sequence
    else return

    if (event.event === "chat") {
      this.#acceptChat(active, payload)
      return
    }
    this.#acceptAgent(active, payload)
  }

  #acceptChat(active: ActiveRun, payload: Record<string, unknown>) {
    const usage = tokenUsage(payload.usage)
    if (usage) active.usage = usage
    if (payload.state === "status") {
      const phase = boundedText(payload.phase)
      if (phase)
        this.#emitProgress(active, {
          phase,
          ...(safeClone(payload.retry) === undefined
            ? {}
            : { retry: safeClone(payload.retry) }),
        })
      return
    }
    if (payload.state === "delta") {
      const delta = boundedText(payload.deltaText)
      if (delta) {
        if (payload.replace === true) this.#replaceText(active, delta)
        else this.#appendText(active, delta)
      }
      return
    }
    if (payload.state === "final") {
      this.#flushTerminalText(active, payload.message)
      this.#finish(active)
      return
    }
    if (payload.state === "aborted") {
      this.#flushTerminalText(active, payload.message)
      this.#finish(active)
      return
    }
    if (payload.state === "error") {
      this.#flushTerminalText(active, payload.message)
      this.#fail(
        active,
        "AOS_PROVIDER_RUN_FAILED",
        "OpenClaw could not complete this run."
      )
    }
  }

  #flushTerminalText(active: ActiveRun, message: unknown) {
    const finalText = messageText(message)
    if (finalText === undefined) return
    const remaining = this.#remaining(active.text, finalText)
    if (remaining === undefined) this.#replaceText(active, finalText)
    else this.#appendText(active, remaining)
  }

  #acceptAgent(active: ActiveRun, payload: Record<string, unknown>) {
    const stream = payload.stream
    const data = record(payload.data)
    if (typeof stream !== "string" || !data) return
    if (stream === "thinking") {
      const delta = boundedText(data.delta)
      const cumulative = boundedText(data.text)
      this.#appendReasoning(
        active,
        delta ?? this.#remaining(active.reasoning, cumulative)
      )
      return
    }
    if (stream === "assistant") {
      const delta = boundedText(data.delta)
      const cumulative = boundedText(data.text)
      this.#appendText(
        active,
        delta ?? this.#remaining(active.text, cumulative)
      )
      return
    }
    if (stream === "run_status") {
      const phase = boundedText(data.phase)
      if (phase)
        this.#emitProgress(active, {
          phase,
          ...(safeClone(data.retry) === undefined
            ? {}
            : { retry: safeClone(data.retry) }),
        })
      return
    }
    if (stream === "plan") {
      const phase = boundedText(data.phase)
      if (!phase) return
      if (data.steps === undefined) this.#emitPlan(active, phase)
      else {
        const plan = validatedPlan(data)
        if (plan) this.#emitPlan(active, phase, plan)
      }
      return
    }
    if (stream === "item") {
      const progressText = boundedText(data.progressText)
      if (progressText) this.#emitProgress(active, { text: progressText })
      return
    }
    if (stream === "usage") {
      const usage = tokenUsage(data)
      if (usage) active.usage = usage
      return
    }
    if (stream === "tool") {
      this.#acceptTool(active, data)
      return
    }
    if (stream !== "lifecycle") return
    const phase = boundedText(data.phase)
    if (phase) this.#emitProgress(active, { phase })
  }

  #remaining(previous: string, cumulative: string | undefined) {
    if (cumulative === undefined || !cumulative.startsWith(previous))
      return undefined
    return cumulative.slice(previous.length)
  }

  #appendReasoning(active: ActiveRun, delta: string | undefined) {
    if (!delta) return
    if (encoder.encode(active.reasoning + delta).byteLength > MAX_TEXT_BYTES) {
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "OpenClaw reasoning exceeded the safe stream boundary."
      )
      return
    }
    if (!active.reasoningStarted) {
      active.reasoningStarted = true
      const messageId = `${active.runId}:reasoning`
      active.queue.push({ type: EventType.REASONING_START, messageId })
      active.queue.push({
        type: EventType.REASONING_MESSAGE_START,
        messageId,
        role: "reasoning",
      })
    }
    active.reasoning += delta
    active.queue.push({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: `${active.runId}:reasoning`,
      delta,
    })
  }

  #endReasoning(active: ActiveRun) {
    if (!active.reasoningStarted || active.reasoningEnded) return
    active.reasoningEnded = true
    const messageId = `${active.runId}:reasoning`
    active.queue.push({ type: EventType.REASONING_MESSAGE_END, messageId })
    active.queue.push({ type: EventType.REASONING_END, messageId })
  }

  #appendText(active: ActiveRun, delta: string | undefined) {
    if (!delta) return
    if (encoder.encode(active.text + delta).byteLength > MAX_TEXT_BYTES) {
      this.#fail(
        active,
        "AOS_RESET_REQUIRED",
        "OpenClaw text exceeded the safe stream boundary."
      )
      return
    }
    active.text += delta
    this.#appendProjectedText(active, delta)
  }

  #appendProjectedText(active: ActiveRun, delta: string) {
    this.#endReasoning(active)
    const messageId = this.#messageId(active)
    if (!active.textStarted) {
      active.textStarted = true
      active.queue.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      })
    }
    active.projectedText += delta
    active.queue.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
    })
  }

  #replaceText(active: ActiveRun, text: string) {
    if (text === active.text) return
    const projected =
      active.textBaseline !== undefined && text.startsWith(active.textBaseline)
        ? text.slice(active.textBaseline.length)
        : text
    active.text = text
    if (projected === active.projectedText) return
    if (active.textStarted)
      active.queue.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.#messageId(active),
      })
    if (active.textStarted) active.textGeneration += 1
    active.textStarted = false
    active.projectedText = ""
    if (projected) this.#appendProjectedText(active, projected)
  }

  #messageId(active: ActiveRun) {
    return active.textGeneration === 0
      ? `${active.runId}:assistant`
      : `${active.runId}:assistant:${active.textGeneration + 1}`
  }

  #emitProgress(active: ActiveRun, content: Record<string, unknown>) {
    active.queue.push({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: `${active.runId}:progress`,
      activityType: "OPENCLAW_PROGRESS",
      content,
      replace: true,
    })
  }

  #emitPlan(
    active: ActiveRun,
    phase: string,
    plan?: NonNullable<HistorySnapshot["inFlightRun"]>["plan"]
  ) {
    if (plan) {
      const fingerprint = planFingerprint(plan)
      if (fingerprint !== undefined && fingerprint === active.planFingerprint)
        return
      active.planFingerprint = fingerprint
    }
    active.queue.push({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: `${active.runId}:plan`,
      activityType: "PLAN",
      content: {
        phase,
        ...(plan ? plan : {}),
      },
      replace: true,
    })
  }

  #acceptTool(active: ActiveRun, data: Record<string, unknown>) {
    const toolCallId = validId(data.toolCallId) ? data.toolCallId : undefined
    if (!toolCallId) return
    if (data.phase === "start") {
      if (active.tools.has(toolCallId)) return
      const name = validId(data.name) ? data.name : "tool"
      const tool = {
        name,
        messageId: this.#messageId(active),
        ended: false,
      }
      active.tools.set(toolCallId, tool)
      active.queue.push({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: name,
        parentMessageId: tool.messageId,
      })
      active.queue.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: this.#toolEvents ? safeJson(data.args) : "{}",
      })
      return
    }
    if (
      data.phase === "input_delta" ||
      data.phase === "update" ||
      data.phase === "review"
    ) {
      const detail = this.#toolEvents
        ? safeClone(
            data.phase === "input_delta"
              ? data.diff
              : data.phase === "update"
                ? data.partialResult
                : data.review
          )
        : undefined
      active.queue.push({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `${active.runId}:tool-progress:${toolCallId}`,
        activityType: "OPENCLAW_TOOL_PROGRESS",
        content: {
          phase: data.phase,
          toolCallId,
          ...(validId(data.name) ? { name: data.name } : {}),
          ...(detail === undefined ? {} : { detail }),
        },
        replace: true,
      })
      return
    }
    if (data.phase !== "result") return
    let tool = active.tools.get(toolCallId)
    if (!tool) {
      const name = validId(data.name) ? data.name : "tool"
      tool = {
        name,
        messageId: this.#messageId(active),
        ended: false,
      }
      active.tools.set(toolCallId, tool)
      active.queue.push({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: name,
        parentMessageId: tool.messageId,
      })
      active.queue.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: "{}",
      })
    }
    if (tool.ended) return
    tool.ended = true
    active.queue.push({ type: EventType.TOOL_CALL_END, toolCallId })
    active.queue.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${active.runId}:tool:${toolCallId}`,
      toolCallId,
      content: this.#toolEvents
        ? safeJson(data.result)
        : safeJson({ status: "completed", isError: data.isError === true }),
      role: "tool",
    })
  }

  async #reconcile(
    active: ActiveRun,
    fence?: OpenClawReconciliationFence
  ): Promise<void> {
    if (active.terminal || this.#active.get(scopeKey(active.scope)) !== active)
      return
    while (active.reconciliation) await active.reconciliation
    if (active.terminal || this.#active.get(scopeKey(active.scope)) !== active)
      return
    const reconciliation = this.#reconcileClean(active, fence)
    active.reconciliation = reconciliation
    try {
      await reconciliation
    } finally {
      if (active.reconciliation === reconciliation)
        active.reconciliation = undefined
    }
  }

  async #reconcileClean(
    active: ActiveRun,
    fence?: OpenClawReconciliationFence
  ) {
    let history: HistorySnapshot
    do {
      const generation = this.#subscriptions.generation
      active.reconciliationDirty = false
      active.reconciling = true
      try {
        history = await this.#history(
          active.scope,
          active.lease,
          active.nativeSessionId
        )
      } finally {
        active.reconciling = false
      }
      if (
        active.terminal ||
        this.#active.get(scopeKey(active.scope)) !== active ||
        generation !== this.#subscriptions.generation ||
        fence?.dirty()
      )
        return
    } while (active.reconciliationDirty)
    this.#applyHistory(active, history)
  }

  #applyHistory(active: ActiveRun, history: HistorySnapshot) {
    if (active.terminal || this.#active.get(scopeKey(active.scope)) !== active)
      return
    const exactInFlight = history.inFlightRun?.runId === active.nativeRunId
    if (exactInFlight) {
      for (const event of history.inFlightRun?.events ?? []) {
        if (event.seq <= active.lastAgentSeq) continue
        active.lastAgentSeq = event.seq
        this.#acceptAgent(active, event)
      }
      if (history.inFlightRun?.plan)
        this.#emitPlan(active, "update", history.inFlightRun.plan)
      this.#appendText(
        active,
        this.#remaining(active.text, history.inFlightRun?.text)
      )
    }
    if (
      exactInFlight ||
      history.activeRunIds?.includes(active.nativeRunId) === true
    ) {
      active.uncertain = false
      return
    }
    if (history.hasActiveRun === false || history.activeRunIds !== undefined) {
      this.#appendText(
        active,
        this.#remaining(
          active.text,
          completedHistoryText(history, active.nativeRunId)
        )
      )
      this.#finish(active)
      return
    }
    this.#fail(
      active,
      "AOS_RESET_REQUIRED",
      "OpenClaw history could not authoritatively reconcile this run."
    )
  }

  async #stop(active: ActiveRun): Promise<"stopping" | "idle"> {
    if (active.terminal) return "idle"
    if (active.uncertain)
      throw new OpenClawRunPublicError(
        "AOS_STOP_UNCERTAIN",
        "OpenClaw may have accepted the Stop request."
      )
    if (active.stopping) {
      await this.#reconcile(active).catch(() => {})
      return active.terminal ? "idle" : "stopping"
    }
    active.stopping = true
    const params = {
      key: active.nativeSessionKey,
      agentId: active.scope.agentId,
      runId: active.nativeRunId,
    }
    if (!validateSessionsAbortParams(params))
      throw new Error("Invalid OpenClaw sessions.abort request")
    let sent = false
    let status: "aborted" | "no-active-run"
    try {
      const result = await this.#client.request<unknown>(
        "sessions.abort",
        params,
        {
          onSent: () => {
            sent = true
          },
        }
      )
      const acknowledgement = record(result)
      const acknowledgedStatus = acknowledgement?.status
      const abortedRunId = acknowledgement?.abortedRunId
      if (
        acknowledgement?.ok !== true ||
        (acknowledgedStatus !== "aborted" &&
          acknowledgedStatus !== "no-active-run") ||
        (acknowledgedStatus === "aborted" && !validId(abortedRunId)) ||
        (acknowledgedStatus === "no-active-run" && abortedRunId !== null)
      )
        throw new Error("Invalid OpenClaw sessions.abort acknowledgement")
      if (
        acknowledgedStatus === "aborted" &&
        abortedRunId !== active.nativeRunId
      )
        throw new Error("OpenClaw aborted a different run")
      status = acknowledgedStatus
    } catch (error) {
      if (requestWasSent(error, sent)) {
        active.uncertain = true
        throw new OpenClawRunPublicError(
          "AOS_STOP_UNCERTAIN",
          "OpenClaw may have accepted the Stop request."
        )
      }
      active.stopping = false
      throw new ServerRunStopNotDispatchedError(providerUnavailable())
    }
    if (active.terminal) return "idle"
    if (status === "no-active-run") {
      this.#finish(active)
      return "idle"
    }
    await this.#reconcile(active).catch(() => {})
    return active.terminal ? "idle" : "stopping"
  }

  #markInterrupted(active: ActiveRun) {
    if (active.terminal || active.uncertain) return
    this.#markUncertain(
      active,
      "AOS_CONNECTION_INTERRUPTED",
      "OpenClaw connection was interrupted."
    )
  }

  #markUncertain(active: ActiveRun, code: string, message: string) {
    if (active.terminal) return
    active.uncertain = true
    active.queue.push({ type: EventType.RUN_ERROR, code, message })
    active.queue.close()
  }

  #finish(active: ActiveRun) {
    if (active.terminal) return
    active.terminal = true
    this.#endReasoning(active)
    for (const [toolCallId, tool] of active.tools) {
      if (tool.ended) continue
      tool.ended = true
      active.queue.push({ type: EventType.TOOL_CALL_END, toolCallId })
      active.queue.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${active.runId}:tool:${toolCallId}`,
        toolCallId,
        content: safeJson({
          status: active.stopping ? "stopped" : "completed",
        }),
        role: "tool",
      })
    }
    if (active.textStarted)
      active.queue.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.#messageId(active),
      })
    active.queue.terminal({
      type: EventType.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      outcome: { type: "success" },
      ...(active.stopping ? { result: { stopped: true } } : {}),
      ...(active.usage ? { usage: active.usage } : {}),
    })
    this.#active.delete(scopeKey(active.scope))
    void active.lease.release().catch(() => {})
    active.resolveSettled()
  }

  #fail(active: ActiveRun, code: string, message: string) {
    if (active.terminal) return
    active.terminal = true
    this.#endReasoning(active)
    for (const [toolCallId, tool] of active.tools) {
      if (tool.ended) continue
      tool.ended = true
      active.queue.push({ type: EventType.TOOL_CALL_END, toolCallId })
      active.queue.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${active.runId}:tool:${toolCallId}`,
        toolCallId,
        content: safeJson({ status: "error" }),
        role: "tool",
      })
    }
    if (active.textStarted)
      active.queue.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.#messageId(active),
      })
    active.queue.terminal({
      type: EventType.RUN_ERROR,
      code,
      message,
      ...(active.usage ? { usage: active.usage } : {}),
    })
    this.#active.delete(scopeKey(active.scope))
    void active.lease.release().catch(() => {})
    active.resolveSettled()
  }
}
