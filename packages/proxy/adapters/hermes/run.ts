/**
 * The Hermes run engine.
 *
 * This shell owns the public run surface (start, recover, discover, the handle
 * it returns) and the projection of native frames into AG-UI events. Everything
 * a frame may then decide lives beside it: `run-attach` binds a run to a live
 * Session and keeps its frames contiguous, `run-settlement` decides when and how
 * a run ends, `run-failures` holds every public failure, `run-frames` reads
 * native frames and `event-queue` bounds what the run publishes.
 */
import {
  RunEventKind,
  TurnInputSchema,
  type RunEvent,
  type TurnInput,
  type RunInterruptOutcome,
} from "../../core/events"
import {
  ServerRunConflictError,
  type RecoveryRequest,
  type ServerRunHandle,
} from "../../core/runtime"
import { projectTodos, type Todo } from "../todos"
import { projectHermesToolCall, projectHermesToolOutcome } from "./tool-data"
import { boundedNativeBytes, isRecord, sessionKey } from "./native"
import { startedQueue } from "./event-queue"
import { attachRun, scheduleCatchUp } from "./run-attach"
import {
  HermesRunRewindConflictError,
  nativeFailure,
  providerUnavailable,
  RUN_FAILURES,
  type RunFailure,
} from "./run-failures"
import {
  boundedText,
  bufferNativeEvent,
  nativeEvent,
  nativeEventSessionId,
  payloadOf,
  stableNativeId,
  tokenUsage,
  type HermesNativeEvent,
} from "./run-frames"
import {
  observeSettling,
  reconcileNativeError,
  settleFrom,
  settleStale,
  steerRun,
  stopRun,
  turnOutcome,
  watchSettling,
} from "./run-settlement"
import {
  createActiveRun,
  generationState,
  readStatus,
  safelyUnsubscribe,
  type ActiveRun,
  type HermesRunScope,
  type RunEngineHost,
  type SettlingWatcher,
} from "./run-state"
import type { HermesLog } from "./gateway"
import type { HermesRunNative, HermesSubmitPrompt } from "./run-native"

export {
  HermesRunPublicError,
  HermesRunRewindConflictError,
} from "./run-failures"
export type { HermesNativeEvent, HermesRecovery } from "./run-frames"
export type { HermesRunScope } from "./run-state"

export type HermesRunHandle = ServerRunHandle

export type HermesReconnectRequest = RecoveryRequest

const MAX_USER_TURN_BYTES = 1_048_576
const MAX_NATIVE_EVENT_BYTES = 4_194_304
const RUN_INPUT_FIELDS = new Set([
  "threadId",
  "runId",
  "parentRunId",
  "state",
  "messages",
  "tools",
  "context",
  "forwardedProps",
  "resume",
  "rewindSourceId",
])

function userText(input: TurnInput) {
  const message = input.messages[0]
  if (!message || message.role !== "user") return undefined
  if (typeof message.content === "string") return message.content.trim()
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text || undefined
}

function isEmptyAuthority(value: unknown) {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value !== "object") return false
  return Object.keys(value).length === 0
}

export class HermesRunEngine {
  readonly #native: HermesRunNative
  readonly #log: HermesLog
  readonly #active = new Map<string, ActiveRun>()
  readonly #admissions = new Set<string>()
  readonly #settling = new Map<string, SettlingWatcher>()
  readonly #plans = new Map<string, { messageId: string; todos: Todo[] }>()
  readonly #host: RunEngineHost

  constructor(native: HermesRunNative, options: { log?: HermesLog } = {}) {
    this.#native = native
    this.#log = options.log ?? { warn: () => undefined }
    this.#host = {
      native: this.#native,
      log: this.#log,
      runs: this.#active,
      settling: this.#settling,
      accept: (active, value, replayed) =>
        this.#accept(active, value, replayed),
      sealGeneration: (active) => this.#sealGeneration(active),
      finish: (active, result, confirmedIdle) =>
        this.#finish(active, result, confirmedIdle),
      finishInterrupt: (active, outcome) =>
        this.#finishInterrupt(active, outcome),
      fail: (active, failure) => this.#fail(active, failure),
      detach: (active, failure) => this.#detach(active, failure),
      settle: (active) => this.#settle(active),
    }
  }

  async start(
    scope: HermesRunScope,
    candidate: unknown
  ): Promise<HermesRunHandle> {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      Object.keys(candidate).some((key) => !RUN_INPUT_FIELDS.has(key))
    )
      throw new Error("AOS received unsupported run fields")
    const input = TurnInputSchema.parse(candidate)
    const rewindSourceId = (candidate as { rewindSourceId?: unknown })
      .rewindSourceId
    if (
      rewindSourceId !== undefined &&
      (typeof rewindSourceId !== "string" ||
        rewindSourceId.length === 0 ||
        rewindSourceId.length > 256)
    )
      throw new Error("AOS received an invalid rewind source")
    if (!isEmptyAuthority(input.state))
      throw new Error("AOS does not accept browser state as Hermes input")
    if (input.tools.length > 0)
      throw new Error("AOS does not accept browser tools as Hermes input")
    if (input.context.length > 0)
      throw new Error("AOS does not accept browser context as Hermes input")
    if (!isEmptyAuthority(input.forwardedProps))
      throw new Error(
        "AOS does not accept browser forwarded properties as Hermes input"
      )
    const interactionResume =
      input.resume && input.resume.length > 0 ? input.resume : undefined
    // Unstaged multimodal content never reaches an adapter: the turn input
    // schema admits text parts only, so staged media arrives appended as text.
    const text = userText(input)
    if (input.threadId !== scope.threadId)
      throw new Error("AOS run scope does not match this Session")
    if (
      interactionResume
        ? input.messages.length !== 0
        : input.messages.length !== 1 || !text
    )
      throw new Error(
        interactionResume
          ? "AOS interrupt responses require one bound native interaction"
          : "AOS runs require exactly one authorized user turn"
      )
    if (text && new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES)
      throw new Error("The AOS user turn is too large")

    const key = sessionKey(scope)
    const stale = this.#active.get(key)
    if (this.#admissions.has(key) || (stale && !stale.uncertain))
      throw new ServerRunConflictError()
    this.#admissions.add(key)

    let active: ActiveRun
    try {
      // An uncertain run holds the Session until Hermes says its turn is over.
      if (stale) await settleStale(this.#host, stale)
      active = createActiveRun(scope, input.runId)
      await attachRun(this.#host, active, { kind: "barrier" })
    } finally {
      this.#admissions.delete(key)
    }
    if (active.terminal) return this.#handle(active)
    if (interactionResume) {
      // The answer resumes a native turn whose completion frame already passed,
      // so settlement may end this run on Hermes' own idle edge.
      active.resumedInteraction = true
      let results: readonly { status: string }[]
      try {
        results = await this.#native.respondInteractions(
          { ...scope, runId: input.runId },
          interactionResume
        )
      } catch {
        this.#fail(active, RUN_FAILURES.interactionFailed)
        return this.#handle(active)
      }
      if (active.terminal) return this.#handle(active)
      if (results.some(({ status }) => status === "uncertain"))
        this.#detach(active, RUN_FAILURES.interactionUncertain)
      else if (results.some(({ status }) => status === "in-use"))
        this.#fail(active, RUN_FAILURES.sessionInUse)
      else if (results.some(({ status }) => status === "expired"))
        this.#fail(active, RUN_FAILURES.interactionExpired)
      return this.#handle(active)
    }
    // The Session stays busy for AOS while Hermes finishes the previous turn.
    await this.#settling.get(key)?.done
    const status = await readStatus(this.#host, active.liveSessionId)
    if (!this.#isSubmitEligible(active)) return this.#handle(active)
    if (status === undefined) {
      this.#settle(active)
      throw providerUnavailable()
    }
    // Only a Session running a turn is authoritatively busy; one that is still
    // building its Agent, or that Hermes does not list, accepts the turn.
    if (status === "working" || status === "waiting") {
      this.#fail(active, RUN_FAILURES.sessionBusy)
      return this.#handle(active)
    }
    await this.#submit(
      active,
      {
        scope,
        text: text!,
        runId: input.runId,
        ...(rewindSourceId === undefined
          ? {}
          : { rewindSourceId: rewindSourceId as string }),
      },
      false
    )
    return this.#handle(active)
  }

  async recover(
    scope: HermesRunScope,
    request: HermesReconnectRequest
  ): Promise<HermesRunHandle> {
    if (request.threadId !== scope.threadId)
      throw new Error(
        "The reconnect position is not authorized for this Session"
      )
    const key = sessionKey(scope)
    const existing = this.#active.get(key)
    if (existing) {
      if (
        existing.runId !== request.runId ||
        (!existing.uncertain && !existing.detached)
      )
        throw new ServerRunConflictError()
      return this.#reattach(
        existing,
        request.position ?? {
          epoch: existing.epoch,
          lastSeen: existing.lastSeen,
        }
      )
    }
    if (this.#admissions.has(key)) throw new ServerRunConflictError()
    this.#admissions.add(key)

    const active = createActiveRun(scope, request.runId)
    try {
      await attachRun(
        this.#host,
        active,
        request.position
          ? {
              kind: "position",
              epoch: request.position.epoch,
              after: request.position.lastSeen,
            }
          : // Nothing published a cursor for this run: only Hermes' own open
            // turn identifies it.
            { kind: "discover" }
      )
    } finally {
      this.#admissions.delete(key)
    }
    return this.#handle(active)
  }

  async discover(scope: HermesRunScope, runId: string) {
    const snapshot = await this.#native.inspectExecution({ ...scope, runId })
    const outcome = snapshot.outcome
    if (snapshot.status === "waiting-for-input" && outcome) {
      const events: RunEvent[] = [
        { type: RunEventKind.RUN_STARTED, threadId: scope.threadId, runId },
        {
          type: RunEventKind.RUN_FINISHED,
          threadId: scope.threadId,
          runId,
          outcome,
        },
      ]
      return {
        state: "waiting-for-input" as const,
        interrupts: outcome.interrupts,
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
    }
    if (snapshot.status !== "running") return undefined
    return {
      state: "running" as const,
      handle: await this.recover(scope, { threadId: scope.threadId, runId }),
    }
  }

  /** The same run continues on a new stream from the browser's own cursor. */
  async #reattach(
    active: ActiveRun,
    position: { epoch: string; lastSeen: number }
  ): Promise<HermesRunHandle> {
    active.queue = startedQueue(active.scope, active.runId)
    active.uncertain = false
    active.detached = false
    await attachRun(this.#host, active, {
      kind: "position",
      epoch: position.epoch,
      after: position.lastSeen,
    })
    return this.#handle(active)
  }

  /**
   * Submit the authorized user turn. `retried` records the single re-send a
   * "that live Session is gone" rejection allows: it rejected the write, so
   * nothing ran and rebinding the durable Session repeats no mutation. The
   * re-send carries the refused write itself, so a command whose expansion was
   * the part Hermes refused is never executed twice.
   */
  async #submit(
    active: ActiveRun,
    prompt: HermesSubmitPrompt,
    retried: boolean
  ) {
    if (!this.#isSubmitEligible(active)) return
    let outcome: Awaited<ReturnType<HermesRunNative["submit"]>>
    try {
      outcome = await this.#native.submit(active.liveSessionId, prompt)
    } catch (error) {
      if (error instanceof HermesRunRewindConflictError) {
        this.#fail(active, RUN_FAILURES.rewindConflict)
        return
      }
      // Nothing was written, so this run never began: it settles silently and
      // the caller learns Hermes is unavailable.
      this.#settle(active)
      throw providerUnavailable()
    }
    if (active.terminal) return
    if (outcome.acknowledgement === "uncertain") {
      if (!active.messageId) this.#detach(active, RUN_FAILURES.sendUncertain)
      return
    }
    if (outcome.acknowledgement === "accepted") {
      // Only a queued admission puts this turn behind another one, so its first
      // frame is a `message.start`, not the current turn's idle boundary; an
      // in-place `steered`/`redirected` prompt joins the turn already running.
      if (outcome.status === "queued") active.awaitingStart = true
      if (!outcome.completion) return
      if (outcome.completion.output) {
        active.messageId = `aos-command:${prompt.runId}`
        this.#startText(active)
        this.#emit(active, {
          type: RunEventKind.TEXT_MESSAGE_CONTENT,
          messageId: active.messageId,
          delta: outcome.completion.output,
        })
      }
      this.#finish(
        active,
        outcome.completion.composerPrefill === undefined
          ? undefined
          : { "aos.composerPrefill": outcome.completion.composerPrefill }
      )
      return
    }
    if (outcome.reason === "command-with-attachments")
      return this.#fail(active, RUN_FAILURES.commandWithAttachments)
    if (outcome.reason === "busy")
      return this.#fail(active, RUN_FAILURES.sessionBusy)
    if (outcome.reason !== "session-gone")
      return this.#fail(active, RUN_FAILURES.commandRejected)
    if (retried) return this.#fail(active, RUN_FAILURES.resetRequired)
    const refused = outcome.refused
    try {
      await attachRun(this.#host, active, { kind: "barrier" })
    } catch (error) {
      this.#settle(active)
      throw error
    }
    if (active.terminal) return
    // A refusal of the `prompt.submit` itself repeats only that write; a
    // refusal from the command execution ran nothing at all, so the whole
    // command path may be dispatched again against the rebound Session.
    await this.#submit(active, refused ? { ...prompt, refused } : prompt, true)
  }

  #handle(active: ActiveRun): HermesRunHandle {
    return {
      events: active.queue,
      settled: active.settled,
      stop: () => stopRun(this.#host, active),
      steer: (request) => steerRun(this.#host, active, request.text),
      recoveryPosition: () => ({
        epoch: active.epoch,
        lastSeen: active.lastSeen,
      }),
    }
  }

  /**
   * `replayed` marks a frame from a replayed page or a buffer drained behind
   * one: only there is a frame at or before the watermark a plain duplicate.
   */
  #accept(active: ActiveRun, value: unknown, replayed = false) {
    if (active.terminal) {
      observeSettling(this.#host, active, value)
      return
    }
    if (nativeEventSessionId(value) !== active.liveSessionId) return
    if (boundedNativeBytes(value, MAX_NATIVE_EVENT_BYTES) === undefined) {
      this.#overflow(active)
      return
    }
    const event = nativeEvent(value)
    if (!event || event.session_id !== active.liveSessionId) return
    if (
      event.seq !== undefined &&
      !this.#advance(active, event.seq, value, replayed)
    )
      return
    this.#dispatch(active, event, payloadOf(event))
  }

  /** Whether this sequence is the frame the run must deliver next. */
  #advance(active: ActiveRun, seq: number, value: unknown, replayed: boolean) {
    if (seq === active.lastSeen) return false
    if (seq < active.lastSeen) {
      // Hermes restarted this Session's counter inside the same epoch, so its
      // ring can no longer address the rest of the turn.
      if (!replayed) this.#fail(active, RUN_FAILURES.resetRequired)
      return false
    }
    if (active.catchUp) {
      bufferNativeEvent(active.catchUp, value)
      return false
    }
    // A frame is missing: hold this one and read the ring once. Hermes stamps
    // `seq` per Session before routing, so the successor is always the next.
    if (seq !== active.lastSeen + 1) {
      scheduleCatchUp(this.#host, active, value)
      return false
    }
    active.lastSeen = seq
    return true
  }

  /** One branch per native frame type; an unknown frame is ignored. */
  #dispatch(
    active: ActiveRun,
    event: HermesNativeEvent,
    payload: Record<string, unknown>
  ) {
    switch (event.type) {
      case "session.info":
      case "session.usage": {
        const usage = tokenUsage(payload.usage)
        if (usage) active.usage = usage
        if (event.type === "session.info" && payload.running === false)
          settleFrom(this.#host, active, "idle")
        return
      }
      case "message.start": {
        // A native turn is running again, so no earlier outcome describes this
        // run any more, including an error the superseded turn left behind.
        active.awaitingStart = false
        active.turn = "open"
        active.failure = undefined
        active.errorObserved = false
        if (active.messageId) return
        const messageId = stableNativeId(payload.message_id ?? payload.id)
        if (messageId && active.sealedMessageIds.has(messageId)) return
        active.messageId = messageId ?? this.#fallbackMessageId(active)
        return
      }
      case "message.delta": {
        const delta = boundedText(payload.text)
        if (delta) this.#appendText(active, delta)
        return
      }
      case "message.interim": {
        const delta = boundedText(payload.text)
        if (!delta) return
        this.#ensureMessageId(active)
        if (
          !this.#appendSuffix(active, delta) &&
          payload.already_streamed !== true
        )
          this.#appendText(active, delta)
        // Interim commentary is a message boundary inside the native turn:
        // more tools and text may follow, and only message.complete settles.
        this.#sealGeneration(active)
        return
      }
      // Hermes uses thinking.delta for transient spinner/status copy. It is not
      // model reasoning and must not be persisted into the reasoning message.
      case "thinking.delta":
        return
      case "reasoning.delta":
      case "reasoning.available": {
        // Reasoning is model thought, so it belongs only ahead of any assistant
        // text, and an available frame only where nothing streamed already.
        const delta = boundedText(payload.text)
        if (
          delta === undefined ||
          active.textStarted ||
          (event.type === "reasoning.available" &&
            active.streamedReasoning.length > 0)
        )
          return
        this.#ensureMessageId(active)
        this.#appendReasoning(active, delta)
        return
      }
      case "tool.start":
      case "tool.progress":
        this.#startTool(active, payload)
        return
      case "tool.complete":
        return this.#acceptToolComplete(active, payload)
      case "error": {
        // Hermes also uses `error` for advisory failures (a rejected pending
        // model switch): reconcile liveness before any terminal AG-UI state.
        active.errorObserved = true
        const failure = nativeFailure(payload)
        active.failure ??= failure
        void reconcileNativeError(this.#host, active, failure)
        return
      }
      case "message.complete":
        return this.#acceptComplete(active, payload)
    }
  }

  #acceptToolComplete(active: ActiveRun, payload: Record<string, unknown>) {
    const tool = this.#startTool(active, payload)
    if (!tool || tool.ended) return
    tool.ended = true
    const toolCallId = stableNativeId(payload.tool_id)
    if (!toolCallId) return
    const outcome = projectHermesToolOutcome(
      toolCallId,
      tool.name,
      payload.result,
      payload.is_error === true
    )
    this.#emit(active, { type: RunEventKind.TOOL_CALL_END, toolCallId })
    this.#emit(active, {
      type: RunEventKind.TOOL_CALL_RESULT,
      messageId: `${tool.messageId}:tool:${toolCallId}`,
      toolCallId,
      content: JSON.stringify(outcome.result),
      role: "tool",
    })
    if (tool.name === "todo") {
      const todos = projectTodos(payload.result)
      if (todos !== undefined) this.#emitPlan(active, todos)
    }
    for (const reference of outcome.trustedMedia)
      active.mediaFilter.trust(reference)
    for (const artifact of outcome.parts)
      this.#emit(active, {
        type: RunEventKind.CUSTOM,
        name: artifact.name,
        value: artifact.data,
      })
  }

  /**
   * Hermes ends the turn a queued prompt waits behind before it reports idle, so
   * a completion arriving before this run's turn started describes the
   * superseded turn: neither its text, its usage nor its outcome is this run's.
   */
  #acceptComplete(active: ActiveRun, payload: Record<string, unknown>) {
    if (active.awaitingStart) return this.#sealGeneration(active)
    const usage = tokenUsage(payload.usage)
    if (usage) active.usage = usage
    const completedMessageId = stableNativeId(payload.message_id ?? payload.id)
    // Hermes ended the turn; how it ended decides what settlement does.
    active.turn = turnOutcome(payload.status)
    if (active.turn === "failed") active.failure = nativeFailure(payload)
    const redirecting = active.redirect.chain || active.redirect.pending
    // A completion for a generation this run already sealed belongs to the turn
    // a correction superseded, not to the text the run is streaming.
    if (
      redirecting &&
      completedMessageId &&
      active.sealedMessageIds.has(completedMessageId)
    )
      return
    if (!active.messageId && completedMessageId)
      active.messageId = completedMessageId
    const finalText = boundedText(payload.text)
    // A failed turn's `text` is the model's own prose only while `partial` marks
    // it as such. Without that flag Hermes composed the copy explaining the
    // failure, which AOS publishes as a failure and never as an assistant
    // message.
    if (finalText && (active.turn !== "failed" || payload.partial === true)) {
      this.#ensureMessageId(active)
      this.#appendSuffix(active, finalText)
    }
    // A failed turn is not settled from its own frame: seal the assistant
    // message and wait for Hermes' idle edge, still accepting later frames in
    // source order. A correction keeps the run open for the turn it lands in.
    if (active.turn === "failed" || redirecting) this.#sealGeneration(active)
    else if (active.turn === "interrupted")
      this.#finish(active, { stopped: true })
    else this.#finish(active)
  }

  /** Stream a text delta: recorded for suffix matching, then media-filtered. */
  #appendText(active: ActiveRun, delta: string) {
    this.#appendStreamedText(active, delta)
    this.#emitMediaFilteredText(active, active.mediaFilter.write(delta))
  }

  /**
   * Stream only the part of a full-text frame this run has not streamed yet;
   * false when the frame does not continue the streamed text at all.
   */
  #appendSuffix(active: ActiveRun, text: string) {
    const streamed = active.streamedText
    if (streamed === undefined || !text.startsWith(streamed)) return false
    const remaining = text.slice(streamed.length)
    if (remaining) this.#appendText(active, remaining)
    return true
  }

  #appendStreamedText(active: ActiveRun, delta: string) {
    if (active.streamedText === undefined) return
    active.streamedText = boundedText(active.streamedText + delta)
  }

  #emitMediaFilteredText(active: ActiveRun, delta: string) {
    if (!delta) return
    const messageId = this.#ensureMessageId(active)
    this.#endReasoning(active)
    this.#startText(active)
    this.#emit(active, {
      type: RunEventKind.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
    })
  }

  /**
   * Close whatever the current generation opened, in publication order. `tools`
   * is what a call Hermes never finished reports; without it it is only ended.
   */
  #closeGeneration(
    active: ActiveRun,
    options: {
      media?: boolean
      tools?: "completed" | "stopped" | "unresolved"
    } = {}
  ) {
    if (options.media)
      this.#emitMediaFilteredText(active, active.mediaFilter.finish())
    this.#endReasoning(active)
    if (options.tools)
      this.#settleOpenTools(
        active,
        options.tools === "unresolved" ? undefined : options.tools
      )
    this.#endText(active)
  }

  #emitPlan(active: ActiveRun, todos: Todo[]) {
    const key = sessionKey(active.scope)
    const messageId = `aos-plan:${active.scope.threadId}`
    const previous = this.#plans.get(key)
    if (previous && JSON.stringify(previous.todos) === JSON.stringify(todos))
      return
    const emitted = previous
      ? this.#emit(active, {
          type: RunEventKind.ACTIVITY_DELTA,
          messageId,
          activityType: "PLAN",
          patch: [{ op: "replace", path: "/todos", value: todos }],
        })
      : this.#emit(active, {
          type: RunEventKind.ACTIVITY_SNAPSHOT,
          messageId,
          activityType: "PLAN",
          content: { todos },
          replace: true,
        })
    if (emitted)
      this.#plans.set(key, { messageId, todos: structuredClone(todos) })
  }

  #startText(active: ActiveRun) {
    if (active.textStarted || !active.messageId) return
    active.textStarted = true
    this.#emit(active, {
      type: RunEventKind.TEXT_MESSAGE_START,
      messageId: active.messageId,
      role: "assistant",
    })
  }

  /** Close the assistant text message this generation opened, if any. */
  #endText(active: ActiveRun) {
    if (!active.textStarted || !active.messageId) return
    this.#emit(active, {
      type: RunEventKind.TEXT_MESSAGE_END,
      messageId: active.messageId,
    })
  }

  #ensureMessageId(active: ActiveRun) {
    active.messageId ??= this.#fallbackMessageId(active)
    return active.messageId
  }

  #fallbackMessageId(active: ActiveRun) {
    return active.generation === 0
      ? `${active.runId}:assistant`
      : `${active.runId}:assistant:${active.generation + 1}`
  }

  #startTool(active: ActiveRun, payload: Record<string, unknown>) {
    const toolCallId = stableNativeId(payload.tool_id)
    if (!toolCallId) return undefined
    const existing = active.tools.get(toolCallId)
    if (existing) return existing
    const messageId = this.#ensureMessageId(active)
    const nativeName = stableNativeId(payload.name)
    if (!nativeName) return undefined
    const projected = projectHermesToolCall(nativeName, payload.args)
    const tool = { name: projected.toolName, ended: false, messageId }
    active.tools.set(toolCallId, tool)
    this.#emit(active, {
      type: RunEventKind.TOOL_CALL_START,
      toolCallId,
      toolCallName: tool.name,
      parentMessageId: messageId,
    })
    this.#emit(active, {
      type: RunEventKind.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(projected.args),
    })
    return tool
  }

  #appendReasoning(active: ActiveRun, delta: string) {
    if (delta.length === 0 || !active.messageId || active.reasoningEnded) return
    const reasoningId = `${active.messageId}:reasoning`
    if (!active.reasoningStarted) {
      active.reasoningStarted = true
      this.#emit(active, {
        type: RunEventKind.REASONING_MESSAGE_START,
        messageId: reasoningId,
        role: "reasoning",
      })
    }
    if (
      this.#emit(active, {
        type: RunEventKind.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta,
      })
    )
      active.streamedReasoning += delta
  }

  #settleOpenTools(active: ActiveRun, status?: "completed" | "stopped") {
    for (const [toolCallId, tool] of active.tools) {
      if (tool.ended) continue
      tool.ended = true
      this.#emit(active, { type: RunEventKind.TOOL_CALL_END, toolCallId })
      if (status)
        this.#emit(active, {
          type: RunEventKind.TOOL_CALL_RESULT,
          messageId: `${tool.messageId}:tool:${toolCallId}`,
          toolCallId,
          content: JSON.stringify({ status }),
          role: "tool",
        })
    }
  }

  #endReasoning(active: ActiveRun) {
    if (!active.reasoningStarted || active.reasoningEnded || !active.messageId)
      return
    active.reasoningEnded = true
    this.#emit(active, {
      type: RunEventKind.REASONING_MESSAGE_END,
      messageId: `${active.messageId}:reasoning`,
    })
  }

  #sealGeneration(active: ActiveRun) {
    this.#closeGeneration(active, { media: true })
    if (active.messageId) active.sealedMessageIds.add(active.messageId)
    active.messageId = undefined
    active.generation += 1
    Object.assign(active, generationState())
  }

  /**
   * `confirmedIdle` records that Hermes already reported the Session settled, so
   * the next Send needs no settling watcher.
   */
  #finish(active: ActiveRun, result?: unknown, confirmedIdle = false) {
    if (active.terminal) return
    this.#closeGeneration(active, {
      media: true,
      tools:
        isRecord(result) && result.stopped === true ? "stopped" : "completed",
    })
    this.#emit(active, {
      type: RunEventKind.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      ...(result === undefined ? {} : { result }),
      ...(active.usage ? { usage: active.usage } : {}),
      outcome: { type: "success" },
    })
    if (!confirmedIdle) watchSettling(this.#host, active)
    this.#settle(active)
  }

  #finishInterrupt(active: ActiveRun, outcome: RunInterruptOutcome) {
    if (active.terminal) return
    this.#closeGeneration(active, { tools: "unresolved" })
    this.#emit(active, {
      type: RunEventKind.RUN_FINISHED,
      threadId: active.scope.threadId,
      runId: active.runId,
      outcome,
    })
    this.#settle(active)
  }

  #fail(active: ActiveRun, failure: RunFailure) {
    if (active.terminal) return
    this.#closeGeneration(active)
    this.#emit(active, {
      type: RunEventKind.RUN_ERROR,
      message: failure.message,
      code: failure.code,
    })
    this.#settle(active)
  }

  /**
   * Stop consuming without settling: the run may still be alive in Hermes, so
   * the browser reconciles. Releasing the native observer freezes the watermark
   * at the last delivered frame, so a reconnect replays from there.
   */
  #detach(active: ActiveRun, failure: RunFailure) {
    if (active.terminal || active.detached) return
    this.#emit(active, {
      type: RunEventKind.RUN_ERROR,
      message: failure.message,
      code: failure.code,
    })
    active.uncertain = true
    active.detached = true
    active.catchUp = undefined
    active.queue.close()
    safelyUnsubscribe(active.unsubscribe)
  }

  #emit(active: ActiveRun, event: RunEvent) {
    if (active.terminal) return false
    // An uncertain run's stream is no longer authoritative: publishing fills a
    // queue nobody reads, and an overflow there would settle it unreconciled.
    if (active.uncertain) return true
    if (active.queue.push(event)) return true
    this.#overflow(active)
    return false
  }

  #overflow(active: ActiveRun) {
    if (active.terminal) return
    active.queue.terminal({
      type: RunEventKind.RUN_ERROR,
      message: RUN_FAILURES.streamOverflow.message,
      code: RUN_FAILURES.streamOverflow.code,
    })
    this.#settle(active)
  }

  #isSubmitEligible(active: ActiveRun) {
    return (
      this.#active.get(sessionKey(active.scope)) === active &&
      !active.terminal &&
      !active.uncertain &&
      !active.detached &&
      !active.stopping
    )
  }

  #settle(active: ActiveRun) {
    if (active.terminal) return
    active.terminal = true
    // A settling watcher keeps the native observation until Hermes reports the
    // Session idle; without one nothing observes this Session any more.
    if (this.#settling.get(sessionKey(active.scope))?.active !== active)
      safelyUnsubscribe(active.unsubscribe)
    active.queue.close()
    active.resolveSettled()
    const key = sessionKey(active.scope)
    if (this.#active.get(key) === active) this.#active.delete(key)
  }
}
