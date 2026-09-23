/**
 * The Hermes run engine.
 *
 * This shell owns the public run surface (start, recover, discover, the handle
 * it returns) and the projection of native frames into turn events. Everything
 * a frame may then decide lives beside it: `run-attach` binds a run to a live
 * Session and keeps its frames contiguous, `run-settlement` decides when and how
 * a run ends, `run-failures` holds every public failure, `run-frames` reads
 * native frames and `event-queue` bounds what the run publishes.
 */
import {
  CompactionStatus,
  isRepliesTurn,
  PendingRequestKind,
  StopReason,
  TurnEventKind,
  TurnInputSchema,
  type PendingRequest,
  type TurnEvent,
} from "../../core/events"
import {
  ServerTurnConflictError,
  type RecoveryRequest,
  type ServerTurnHandle,
} from "../../core/runtime"
import { projectTodos, type Todo } from "../todos"
import type { McpToolNames } from "../../mcp-apps/tool-names"
import {
  hermesToolDiffs,
  hermesToolKind,
  hermesToolLocations,
  projectHermesToolCall,
  projectHermesToolOutcome,
  redactedText,
} from "./tool-data"
import { boundedNativeBytes, sessionKey } from "./native"
import { startedTurnQueue } from "./event-queue"
import { HERMES_TODO_STATUS_ALIASES } from "./todos"
import { attachTurn, scheduleCatchUp } from "./run-attach"
import {
  HermesTurnRewindConflictError,
  nativeFailure,
  providerUnavailable,
  TURN_FAILED_LOG,
  TURN_FAILURES,
  withDetail,
  type TurnFailure,
} from "./run-failures"
import {
  backgroundProcessId,
  boundedText,
  bufferNativeEvent,
  durationMs,
  nativeEvent,
  nativeEventSessionId,
  payloadOf,
  stableNativeId,
  subagentPatch,
  terminalText,
  tokenUsage,
  usageCost,
  type HermesNativeEvent,
} from "./run-frames"
import {
  observeSettling,
  reconcileNativeError,
  settleFrom,
  settleStale,
  steerTurn,
  stopTurn,
  turnOutcome,
  watchSettling,
} from "./run-settlement"
import {
  createActiveTurn,
  failReset,
  generationState,
  readStatus,
  safelyUnsubscribe,
  type ActiveTurn,
  type HermesTurnScope,
  type TurnEnding,
  type TurnEngineHost,
  type SettlingWatcher,
} from "./run-state"
import { sessionModelChoice } from "./session-model"
import type { HermesLog } from "./gateway"
import type {
  HermesTurnNative,
  HermesSubmitPrompt,
  HermesSubmitRejection,
} from "./run-native"

export {
  HermesTurnPublicError,
  HermesTurnRewindConflictError,
} from "./run-failures"
export type { HermesNativeEvent, HermesRecovery } from "./run-frames"
export type { HermesTurnScope } from "./run-state"

export type HermesTurnHandle = ServerTurnHandle

export type HermesReconnectRequest = RecoveryRequest

/** The public failure each refused submit reports, with Hermes' own words. */
const REFUSAL_FAILURES: Record<
  Exclude<HermesSubmitRejection, "command-with-attachments" | "session-gone">,
  TurnFailure
> = {
  busy: TURN_FAILURES.sessionBusy,
  "in-use": TURN_FAILURES.sessionInUse,
  "session-limit": TURN_FAILURES.sessionLimit,
  storage: TURN_FAILURES.commandRejected,
  invalid: TURN_FAILURES.commandRejected,
  unknown: TURN_FAILURES.commandRejected,
}

/**
 * How long a discovered turn Hermes reports `waiting` has for its open request
 * to be re-delivered before AOS reports the question lost.
 */
const LOST_INTERACTION_GRACE_MS = 2_000
const MAX_USER_TURN_BYTES = 1_048_576
const MAX_NATIVE_EVENT_BYTES = 4_194_304
const MAX_REWIND_SOURCE_LENGTH = 256

export class HermesTurnEngine {
  readonly #native: HermesTurnNative
  readonly #log: HermesLog
  readonly #active = new Map<string, ActiveTurn>()
  readonly #admissions = new Set<string>()
  readonly #settling = new Map<string, SettlingWatcher>()
  readonly #plans = new Map<string, Todo[]>()
  readonly #host: TurnEngineHost
  readonly #lostInteractionGraceMs: number
  readonly #mcpToolNames?: McpToolNames

  constructor(
    native: HermesTurnNative,
    options: {
      log?: HermesLog
      lostInteractionGraceMs?: number
      /** Keyed by profile; a turn reads the names its profile last loaded. */
      mcpToolNames?: McpToolNames
    } = {}
  ) {
    this.#native = native
    this.#mcpToolNames = options.mcpToolNames
    this.#log = options.log ?? { warn: () => undefined }
    this.#lostInteractionGraceMs =
      options.lostInteractionGraceMs ?? LOST_INTERACTION_GRACE_MS
    this.#host = {
      native: this.#native,
      log: this.#log,
      turns: this.#active,
      settling: this.#settling,
      accept: (active, value, replayed) =>
        this.#accept(active, value, replayed),
      sealGeneration: (active) => this.#sealGeneration(active),
      finish: (active, ending, confirmedIdle) =>
        this.#finish(active, ending, confirmedIdle),
      requireAction: (active, requests) =>
        this.#requireAction(active, requests),
      fail: (active, failure) => this.#fail(active, failure),
      detach: (active, failure) => this.#detach(active, failure),
      settle: (active) => this.#settle(active),
    }
  }

  async start(
    scope: HermesTurnScope,
    candidate: unknown
  ): Promise<HermesTurnHandle> {
    const input = TurnInputSchema.parse(candidate)
    const replies = isRepliesTurn(input) ? input.replies : undefined
    const prompt = isRepliesTurn(input) ? undefined : input
    // Staged content arrives already appended to the prompt as text.
    const text = prompt?.prompt.trim()
    const rewindSourceId = prompt?.rewindSourceId
    if (
      rewindSourceId !== undefined &&
      (rewindSourceId.length === 0 ||
        rewindSourceId.length > MAX_REWIND_SOURCE_LENGTH)
    )
      throw new Error("AOS received an invalid rewind source")
    if (!replies && !text)
      throw new Error("AOS turns require exactly one authorized user turn")
    if (text && new TextEncoder().encode(text).byteLength > MAX_USER_TURN_BYTES)
      throw new Error("The AOS user turn is too large")

    // Warm the profile's MCP tool names while the turn is admitted, so its
    // first tool call already reads under its canonical name.
    void this.#mcpToolNames?.load(scope.agentId).catch(() => undefined)
    const key = sessionKey(scope)
    const stale = this.#active.get(key)
    if (this.#admissions.has(key) || (stale && !stale.uncertain))
      throw new ServerTurnConflictError()
    this.#admissions.add(key)

    let active: ActiveTurn
    try {
      // An uncertain run holds the Session until Hermes says its turn is over.
      if (stale) await settleStale(this.#host, stale)
      active = createActiveTurn(scope, input.turnId)
      await attachTurn(this.#host, active, { kind: "barrier" })
    } finally {
      this.#admissions.delete(key)
    }
    if (active.terminal) return this.#handle(active)
    if (replies) {
      // The answer resumes a native turn whose completion frame already passed,
      // so settlement may end this run on Hermes' own idle edge.
      active.resumedInteraction = true
      let results: readonly { status: string }[]
      try {
        results = await this.#native.respondInteractions(
          { ...scope, turnId: input.turnId },
          replies
        )
      } catch {
        this.#fail(active, TURN_FAILURES.interactionFailed)
        return this.#handle(active)
      }
      if (active.terminal) return this.#handle(active)
      if (results.some(({ status }) => status === "uncertain"))
        this.#detach(active, TURN_FAILURES.interactionUncertain)
      else if (results.some(({ status }) => status === "expired"))
        this.#fail(active, TURN_FAILURES.interactionExpired)
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
      this.#fail(active, TURN_FAILURES.sessionBusy)
      return this.#handle(active)
    }
    await this.#submit(
      active,
      {
        scope,
        text: text!,
        turnId: input.turnId,
        ...(rewindSourceId === undefined ? {} : { rewindSourceId }),
      },
      false
    )
    return this.#handle(active)
  }

  async recover(
    scope: HermesTurnScope,
    request: HermesReconnectRequest
  ): Promise<HermesTurnHandle> {
    if (request.threadId !== scope.threadId)
      throw new Error(
        "The reconnect position is not authorized for this Session"
      )
    const key = sessionKey(scope)
    const existing = this.#active.get(key)
    if (existing) {
      if (
        existing.turnId !== request.turnId ||
        (!existing.uncertain && !existing.detached)
      )
        throw new ServerTurnConflictError()
      return this.#reattach(
        existing,
        request.position ?? {
          epoch: existing.epoch,
          lastSeen: existing.lastSeen,
        }
      )
    }
    if (this.#admissions.has(key)) throw new ServerTurnConflictError()
    this.#admissions.add(key)

    const active = createActiveTurn(scope, request.turnId)
    try {
      await attachTurn(
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

  async discover(scope: HermesTurnScope, turnId: string) {
    const snapshot = await this.#native.inspectExecution({ ...scope, turnId })
    const requests = snapshot.requests
    if (snapshot.status === "waiting-for-input" && requests?.length) {
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
    }
    if (snapshot.status !== "running") return undefined
    const handle = await this.recover(scope, {
      threadId: scope.threadId,
      turnId,
    })
    this.#watchLostInteraction(scope)
    return { state: "running" as const, handle }
  }

  /**
   * A discovered turn Hermes holds `waiting` is blocked on a request. Hermes
   * re-delivers every open request on resume, so one that has not arrived
   * within the grace, while the Session did nothing else, is one AOS can no
   * longer answer: only Stop ends that turn, and the failure says so.
   */
  #watchLostInteraction(scope: HermesTurnScope) {
    const active = this.#active.get(sessionKey(scope))
    if (!active || active.terminal) return
    const { liveSessionId, lastSeen } = active
    const unchanged = () =>
      this.#active.get(sessionKey(scope)) === active &&
      !active.terminal &&
      !active.stopping &&
      !active.uncertain &&
      !active.detached &&
      active.liveSessionId === liveSessionId &&
      active.lastSeen === lastSeen
    const timer = setTimeout(async () => {
      if (!unchanged()) return
      const status = await readStatus(this.#host, liveSessionId)
      if (status !== "waiting" || !unchanged()) return
      const { code, message } = TURN_FAILURES.interactionLost
      this.#log.warn(TURN_FAILED_LOG, { publicCode: code })
      this.#emit(active, {
        kind: TurnEventKind.TurnFailed,
        message,
        code,
        awaitingStop: true,
      })
    }, this.#lostInteractionGraceMs)
    // Detection is reconciliation, never a reason to keep the process alive.
    if (typeof timer !== "number") timer.unref()
  }

  /** The same run continues on a new stream from the browser's own cursor. */
  async #reattach(
    active: ActiveTurn,
    position: { epoch: string; lastSeen: number }
  ): Promise<HermesTurnHandle> {
    active.queue = startedTurnQueue()
    active.uncertain = false
    active.detached = false
    await attachTurn(this.#host, active, {
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
    active: ActiveTurn,
    prompt: HermesSubmitPrompt,
    retried: boolean
  ) {
    if (!this.#isSubmitEligible(active)) return
    let outcome: Awaited<ReturnType<HermesTurnNative["submit"]>>
    try {
      outcome = await this.#native.submit(active.liveSessionId, prompt)
    } catch (error) {
      if (error instanceof HermesTurnRewindConflictError) {
        this.#fail(active, TURN_FAILURES.rewindConflict)
        return
      }
      // Nothing was written, so this run never began: it settles silently and
      // the caller learns Hermes is unavailable.
      this.#settle(active)
      throw providerUnavailable()
    }
    if (active.terminal) return
    if (outcome.acknowledgement === "uncertain") {
      if (!active.messageId) this.#detach(active, TURN_FAILURES.sendUncertain)
      return
    }
    if (outcome.acknowledgement === "accepted") {
      // Only a queued admission puts this turn behind another one, so its first
      // frame is a `message.start`, not the current turn's idle boundary; an
      // in-place `steered`/`redirected` prompt joins the turn already running.
      if (outcome.status === "queued") active.awaitingStart = true
      if (!outcome.completion) return
      if (outcome.completion.output) {
        active.messageId = `aos-command:${prompt.turnId}`
        active.textStarted = true
        this.#emit(active, {
          kind: TurnEventKind.MessageChunk,
          messageId: active.messageId,
          text: outcome.completion.output,
        })
      }
      const { composerPrefill } = outcome.completion
      this.#finish(
        active,
        composerPrefill === undefined ? undefined : { composerPrefill }
      )
      return
    }
    if (outcome.reason === "command-with-attachments")
      return this.#fail(active, TURN_FAILURES.commandWithAttachments)
    if (outcome.reason !== "session-gone")
      return this.#fail(
        active,
        withDetail(REFUSAL_FAILURES[outcome.reason], outcome.detail)
      )
    if (retried) return failReset(this.#host, active, "session-gone-on-retry")
    const refused = outcome.refused
    try {
      await attachTurn(this.#host, active, { kind: "barrier" })
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

  #handle(active: ActiveTurn): HermesTurnHandle {
    return {
      events: active.queue,
      settled: active.settled,
      stop: () => stopTurn(this.#host, active),
      steer: (request) => steerTurn(this.#host, active, request.text),
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
  #accept(active: ActiveTurn, value: unknown, replayed = false) {
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
  #advance(active: ActiveTurn, seq: number, value: unknown, replayed: boolean) {
    if (seq === active.lastSeen) return false
    if (seq < active.lastSeen) {
      // Hermes restarted this Session's counter inside the same epoch, so its
      // ring can no longer address the rest of the turn.
      if (!replayed) failReset(this.#host, active, "sequence-restarted")
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
    active: ActiveTurn,
    event: HermesNativeEvent,
    payload: Record<string, unknown>
  ) {
    switch (event.type) {
      case "session.info":
      case "session.usage":
        this.#acceptUsage(active, payload.usage)
        if (event.type !== "session.info") return
        this.#observeModel(active, payload)
        if (payload.running === false) settleFrom(this.#host, active, "idle")
        return
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
      case "agent.terminal.output":
      case "terminal.close":
        return this.#acceptTerminal(active, event.type, payload)
      case "status.update":
        return this.#acceptStatus(active, payload)
      case "subagent.spawn_requested":
      case "subagent.start":
      case "subagent.complete":
        return this.#acceptSubagent(active, event.type, payload)
      case "error": {
        // Hermes also uses `error` for advisory failures (a rejected pending
        // model switch): reconcile liveness before any terminal turn event.
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

  #acceptToolComplete(active: ActiveTurn, payload: Record<string, unknown>) {
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
    if (tool.name === "terminal" && !outcome.isError)
      this.#announceTerminal(active, toolCallId, payload)
    const diffs = outcome.isError
      ? undefined
      : hermesToolDiffs(tool.name, payload.result)
    const duration = durationMs(payload.duration_s)
    this.#emit(active, {
      kind: TurnEventKind.ToolCallFinished,
      toolCallId,
      output: JSON.stringify(outcome.result),
      failed: outcome.isError,
      ...(diffs ? { diffs } : {}),
      ...(duration === undefined ? {} : { durationMs: duration }),
    })
    if (tool.name === "todo") {
      const todos = projectTodos(payload.result, HERMES_TODO_STATUS_ALIASES)
      if (todos !== undefined) this.#emitPlan(active, todos)
    }
    for (const reference of outcome.trustedMedia)
      active.mediaFilter.trust(reference)
    for (const part of outcome.parts)
      this.#emit(active, {
        kind: TurnEventKind.ArtifactPublished,
        artifact: part.data,
      })
  }

  /**
   * A background process the terminal tool started streams its output apart
   * from the call. Hermes' process id is its own, so the terminal is named
   * after the call that owns it.
   */
  #announceTerminal(
    active: ActiveTurn,
    toolCallId: string,
    payload: Record<string, unknown>
  ) {
    const processId = backgroundProcessId(payload.result)
    if (!processId) return
    const terminalId = `${toolCallId}:terminal`
    active.terminals.set(processId, { toolCallId, terminalId })
    const command = projectHermesToolCall("terminal", payload.args).args.command
    this.#emit(active, {
      kind: TurnEventKind.TerminalOutput,
      terminalId,
      toolCallId,
      ...(typeof command === "string" && command ? { command } : {}),
    })
  }

  #acceptTerminal(
    active: ActiveTurn,
    type: string,
    payload: Record<string, unknown>
  ) {
    const processId = stableNativeId(payload.process_id)
    const terminal = processId && active.terminals.get(processId)
    if (!terminal) return
    if (type === "terminal.close") {
      active.terminals.delete(processId)
      this.#emit(active, {
        kind: TurnEventKind.TerminalOutput,
        ...terminal,
        exit: {},
      })
      return
    }
    const chunk = boundedText(payload.chunk)
    const data = chunk && terminalText(chunk)
    if (data)
      this.#emit(active, {
        kind: TurnEventKind.TerminalOutput,
        ...terminal,
        data: redactedText(data),
      })
  }

  /**
   * Hermes restates `compacting` while a compaction runs and ends it with one
   * `compacted`; it reports no failure of its own, and only status text. Its
   * gateway also tags any lifecycle notice that mentions compaction as
   * `compacting` (a threshold notice on a Session's first turn), and Hermes'
   * own client clears that indicator when the turn ends.
   */
  #acceptStatus(active: ActiveTurn, payload: Record<string, unknown>) {
    const { compaction } = active
    if (payload.kind === "compacting" && !compaction.open) {
      compaction.count += 1
      compaction.open = `${active.turnId}:compaction:${compaction.count}`
      this.#emit(active, {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: compaction.open,
        status: CompactionStatus.Started,
      })
    } else if (payload.kind === "compacted" && compaction.open) {
      this.#emit(active, {
        kind: TurnEventKind.CompactionUpdated,
        compactionId: compaction.open,
        status: CompactionStatus.Completed,
      })
      compaction.open = undefined
    }
  }

  /** A compaction Hermes never confirmed by the turn's end did not happen. */
  #settleCompaction(active: ActiveTurn) {
    const { compaction } = active
    if (!compaction.open) return
    this.#emit(active, {
      kind: TurnEventKind.CompactionUpdated,
      compactionId: compaction.open,
      status: CompactionStatus.Cancelled,
    })
    compaction.open = undefined
  }

  /**
   * Hermes names no call on a subagent frame, and `delegate_task` runs its
   * children while the call is open: a subagent belongs to the latest open
   * delegation when first seen, and to that call from then on.
   */
  #acceptSubagent(
    active: ActiveTurn,
    type: string,
    payload: Record<string, unknown>
  ) {
    const subagent = subagentPatch(type, payload)
    if (!subagent) return
    const toolCallId =
      active.subagents.get(subagent.id) ?? this.#openDelegation(active)
    if (!toolCallId) return
    active.subagents.set(subagent.id, toolCallId)
    this.#emit(active, {
      kind: TurnEventKind.SubagentUpdated,
      toolCallId,
      subagent,
    })
  }

  #openDelegation(active: ActiveTurn) {
    let open: string | undefined
    for (const [toolCallId, tool] of active.tools)
      if (tool.name === "delegate_subagent" && !tool.ended) open = toolCallId
    return open
  }

  #acceptUsage(active: ActiveTurn, value: unknown) {
    const usage = tokenUsage(value)
    if (usage) active.usage = usage
    const cost = usageCost(value)
    if (cost) active.cost = cost
  }

  /** Every `session.info` names the Session's model; a new one is a change. */
  #observeModel(active: ActiveTurn, info: Record<string, unknown>) {
    const model = sessionModelChoice(info)
    if (!model) return
    const previous = active.model
    active.model = model
    if (previous && previous.id !== model.id)
      this.#emit(active, {
        kind: TurnEventKind.ModelChanged,
        modelId: model.id,
      })
  }

  /**
   * Hermes ends the turn a queued prompt waits behind before it reports idle, so
   * a completion arriving before this run's turn started describes the
   * superseded turn: neither its text, its usage nor its outcome is this run's.
   */
  #acceptComplete(active: ActiveTurn, payload: Record<string, unknown>) {
    if (active.awaitingStart) return this.#sealGeneration(active)
    this.#acceptUsage(active, payload.usage)
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
  #appendText(active: ActiveTurn, delta: string) {
    this.#appendStreamedText(active, delta)
    this.#emitMediaFilteredText(active, active.mediaFilter.write(delta))
  }

  /**
   * Stream only the part of a full-text frame this run has not streamed yet;
   * false when the frame does not continue the streamed text at all.
   */
  #appendSuffix(active: ActiveTurn, text: string) {
    const streamed = active.streamedText
    if (streamed === undefined || !text.startsWith(streamed)) return false
    const remaining = text.slice(streamed.length)
    if (remaining) this.#appendText(active, remaining)
    return true
  }

  #appendStreamedText(active: ActiveTurn, delta: string) {
    if (active.streamedText === undefined) return
    active.streamedText = boundedText(active.streamedText + delta)
  }

  /** Publish filtered prose, then the artifacts its MEDIA lines delivered. */
  #emitMediaFilteredText(active: ActiveTurn, delta: string) {
    if (delta) {
      const messageId = this.#ensureMessageId(active)
      active.textStarted = true
      this.#emit(active, {
        kind: TurnEventKind.MessageChunk,
        messageId,
        text: delta,
      })
    }
    for (const { descriptor } of active.mediaFilter.takeArtifacts())
      this.#emit(active, {
        kind: TurnEventKind.ArtifactPublished,
        artifact: descriptor,
      })
  }

  /**
   * Close whatever the current generation left open, in publication order.
   * `tools` is what a call Hermes never finished reports; without it its input
   * is only ended.
   */
  #closeGeneration(
    active: ActiveTurn,
    options: {
      media?: boolean
      tools?: "completed" | "stopped" | "unresolved"
    } = {}
  ) {
    if (options.media)
      this.#emitMediaFilteredText(active, active.mediaFilter.finish())
    if (options.tools)
      this.#settleOpenTools(
        active,
        options.tools === "unresolved" ? undefined : options.tools
      )
  }

  /** Publish the Session's whole Todo list whenever it changed. */
  #emitPlan(active: ActiveTurn, todos: Todo[]) {
    const key = sessionKey(active.scope)
    const previous = this.#plans.get(key)
    if (previous && JSON.stringify(previous) === JSON.stringify(todos)) return
    if (this.#emit(active, { kind: TurnEventKind.PlanUpdated, todos }))
      this.#plans.set(key, structuredClone(todos))
  }

  #ensureMessageId(active: ActiveTurn) {
    active.messageId ??= this.#fallbackMessageId(active)
    return active.messageId
  }

  #fallbackMessageId(active: ActiveTurn) {
    return active.generation === 0
      ? `${active.turnId}:assistant`
      : `${active.turnId}:assistant:${active.generation + 1}`
  }

  #startTool(active: ActiveTurn, payload: Record<string, unknown>) {
    const toolCallId = stableNativeId(payload.tool_id)
    if (!toolCallId) return undefined
    const existing = active.tools.get(toolCallId)
    if (existing) return existing
    const messageId = this.#ensureMessageId(active)
    const nativeName = stableNativeId(payload.name)
    if (!nativeName) return undefined
    const projected = projectHermesToolCall(
      nativeName,
      payload.args,
      this.#mcpToolNames?.resolver(active.scope.agentId)
    )
    const tool = { name: projected.toolName, ended: false }
    active.tools.set(toolCallId, tool)
    const locations = hermesToolLocations(tool.name, projected.args)
    this.#emit(active, {
      kind: TurnEventKind.ToolCallStarted,
      toolCallId,
      title: tool.name,
      name: tool.name,
      toolKind: hermesToolKind(tool.name),
      ...(locations ? { locations } : {}),
      parentMessageId: messageId,
    })
    this.#emit(active, {
      kind: TurnEventKind.ToolCallInputChunk,
      toolCallId,
      delta: JSON.stringify(projected.args),
    })
    // Hermes' tool.start carries the call's full arguments and nothing later
    // adds to them, so they are final while the call still runs.
    this.#emit(active, { kind: TurnEventKind.ToolCallInputEnded, toolCallId })
    return tool
  }

  #appendReasoning(active: ActiveTurn, delta: string) {
    if (delta.length === 0 || !active.messageId) return
    if (
      this.#emit(active, {
        kind: TurnEventKind.ThoughtChunk,
        messageId: active.messageId,
        text: delta,
      })
    )
      active.streamedReasoning += delta
  }

  #settleOpenTools(active: ActiveTurn, status?: "completed" | "stopped") {
    for (const [toolCallId, tool] of active.tools) {
      if (tool.ended) continue
      tool.ended = true
      if (status)
        this.#emit(active, {
          kind: TurnEventKind.ToolCallFinished,
          toolCallId,
          output: JSON.stringify({ status }),
          failed: false,
        })
    }
  }

  #sealGeneration(active: ActiveTurn) {
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
  #finish(active: ActiveTurn, ending: TurnEnding = {}, confirmedIdle = false) {
    if (active.terminal) return
    this.#closeGeneration(active, {
      media: true,
      tools: ending.stopped ? "stopped" : "completed",
    })
    this.#settleCompaction(active)
    // Hermes reports only a completed or an interrupted turn; a turn that
    // settled without saying how goes unsaid.
    const stopReason =
      ending.stopped || active.turn === "interrupted"
        ? StopReason.Cancelled
        : active.turn === "complete"
          ? StopReason.EndTurn
          : undefined
    this.#emit(active, {
      kind: TurnEventKind.TurnEnded,
      ...(stopReason ? { stopReason } : {}),
      ...(active.usage ? { usage: active.usage } : {}),
      ...(active.cost ? { cost: active.cost } : {}),
      ...(ending.composerPrefill === undefined
        ? {}
        : { composerPrefill: ending.composerPrefill }),
    })
    if (!confirmedIdle) watchSettling(this.#host, active)
    this.#settle(active)
  }

  #requireAction(active: ActiveTurn, requests: PendingRequest[]) {
    if (active.terminal) return
    // Hermes names no tool call on an approval; the one call still running is
    // the one waiting on it, and with none or several the approval stays
    // unlinked.
    const running = [...active.tools].filter(([, tool]) => !tool.ended)
    const toolCallId = running.length === 1 ? running[0]![0] : undefined
    const linked = requests.map((request) =>
      toolCallId &&
      request.kind === PendingRequestKind.Permission &&
      !request.toolCallId
        ? { ...request, toolCallId }
        : request
    )
    this.#closeGeneration(active, { tools: "unresolved" })
    this.#emit(active, {
      kind: TurnEventKind.TurnRequiresAction,
      requests: linked,
    })
    this.#settle(active)
  }

  #fail(active: ActiveTurn, failure: TurnFailure) {
    if (active.terminal) return
    this.#closeGeneration(active)
    this.#settleCompaction(active)
    this.#emit(active, this.#failed(active, failure))
    this.#settle(active)
  }

  /**
   * Stop consuming without settling: the run may still be alive in Hermes, so
   * the browser reconciles. Releasing the native observer freezes the watermark
   * at the last delivered frame, so a reconnect replays from there.
   */
  #detach(active: ActiveTurn, failure: TurnFailure) {
    if (active.terminal || active.detached) return
    this.#emit(active, this.#failed(active, failure))
    active.uncertain = true
    active.detached = true
    active.catchUp = undefined
    active.queue.close()
    safelyUnsubscribe(active.unsubscribe)
  }

  /** A public failure, on the model the Session last reported. */
  #failed(active: ActiveTurn, failure: TurnFailure): TurnEvent {
    return {
      kind: TurnEventKind.TurnFailed,
      message: failure.message,
      code: failure.code,
      ...(active.model
        ? { provider: active.model.provider, model: active.model.model }
        : {}),
    }
  }

  #emit(active: ActiveTurn, event: TurnEvent) {
    if (active.terminal) return false
    // An uncertain run's stream is no longer authoritative: publishing fills a
    // queue nobody reads, and an overflow there would settle it unreconciled.
    if (active.uncertain) return true
    if (active.queue.push(event)) return true
    this.#overflow(active)
    return false
  }

  #overflow(active: ActiveTurn) {
    if (active.terminal) return
    active.queue.terminal(this.#failed(active, TURN_FAILURES.streamOverflow))
    this.#settle(active)
  }

  #isSubmitEligible(active: ActiveTurn) {
    return (
      this.#active.get(sessionKey(active.scope)) === active &&
      !active.terminal &&
      !active.uncertain &&
      !active.detached &&
      !active.stopping
    )
  }

  #settle(active: ActiveTurn) {
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
