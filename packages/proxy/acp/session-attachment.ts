import {
  methods,
  SessionUpdate,
  StateUpdate,
  type AgentContext,
} from "@agentclientprotocol/sdk/experimental/v2"

import type {
  SessionContextResponse,
  SessionModelsResponse,
} from "../../protocol"
import {
  AOS_METHODS,
  AOS_META_KEY,
  AOS_STOP_REASONS,
  AosStateMetaSchema,
} from "../../protocol/acp"
import type {
  PendingRequest,
  PromptTurnInput,
  RequestReply,
} from "../core/events"
import type { ServerAttachmentStage, SessionScope } from "../core/runtime"
import type { CoordinatedRunSubscription } from "../core/session-coordinator"
import { FanoutOverflowError } from "../core/subscriber-fanout"
import { redactForLog } from "../redaction"
import { answeredQuestionOutbound } from "./translate/requests"
import {
  initialTranslateState,
  type AcpConnectionContext,
  type AcpOutbound,
} from "./types"
import { errorNotificationOf, staleRequest } from "./validation"

/**
 * One Session as one ACP connection observes it: at most one coordinator
 * subscription, the reducer state that subscription's run segment carries, and
 * the one server→client request its pending interaction is waiting on.
 *
 * The attachment owns only the browser subscriber lifetime. Detaching releases
 * the subscription and nothing else: the native Session, the coordinator's
 * logical execution, and a pending interaction all outlive it.
 */

type RequestOutbound = Extract<
  AcpOutbound,
  { kind: "request-permission" | "elicitation" }
>

type ElicitationRequest = Extract<
  AcpOutbound,
  { kind: "elicitation" }
>["request"]

/**
 * Subtracting `sessionId` cannot reach inside the custom-mode variant's index
 * signature, so the outbound elicitation type carries one degenerate branch
 * that has lost its `mode`. Selecting the modes a translator actually produces
 * keeps the request assignable without widening what is sent.
 */
type ModedElicitation = Extract<ElicitationRequest, { mode: string }>

function hasMode(request: ElicitationRequest): request is ModedElicitation {
  return typeof request.mode === "string"
}

/** The vendor stop reasons that mean the run failed rather than finished. */
const AOS_STOP_CODES: ReadonlySet<string> = new Set(
  Object.values(AOS_STOP_REASONS)
)

/** How much of a provider sentence one log line carries. */
const MAX_LOGGED_FAILURE_CHARS = 200

/**
 * The failure an idle `state_update` reports, when it reports one. Every other
 * update — including every streamed chunk — falls out on the first check. A
 * stop reason names the class of failure and nothing else, so the machine code
 * and the provider's sentence travel with it: they are what an operator
 * diagnoses one run by. `errorCode` is the name `acp.error` already logs the
 * same classification under.
 */
function runFailureOf(update: SessionUpdate) {
  if (!SessionUpdate.isStateUpdate(update) || !StateUpdate.isIdle(update))
    return undefined
  const stopReason = update.stopReason
  if (typeof stopReason !== "string" || !AOS_STOP_CODES.has(stopReason))
    return undefined
  const meta = AosStateMetaSchema.safeParse(update._meta?.[AOS_META_KEY])
  if (!meta.success) return { stopReason }
  const { turnId, code, message } = meta.data
  return {
    stopReason,
    turnId,
    ...(code === undefined ? {} : { errorCode: code }),
    ...(message === undefined
      ? {}
      : { message: message.slice(0, MAX_LOGGED_FAILURE_CHARS) }),
  }
}

/**
 * One `usage_update`. ACP's own fields carry the two token counts; everything
 * the provider reported about them travels in `_meta.aos`, which is what lets
 * the composer attribute the window instead of showing one opaque total.
 */
function usageUpdate(usage: SessionContextResponse): SessionUpdate {
  return {
    sessionUpdate: "usage_update",
    used: usage.usedTokens,
    size: usage.maxTokens,
    _meta: {
      [AOS_META_KEY]: {
        source: usage.source,
        ...(usage.estimated ? { estimated: usage.estimated } : {}),
        ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
      },
    },
  }
}

/**
 * What a deferred usage report waits before each re-read, in order. The budget
 * is bounded: a provider that has not built its agent within half a minute is
 * not building one, and the next turn owes the client a reading anyway.
 */
const USAGE_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
]

export type SessionAttachmentOptions = {
  context: AcpConnectionContext
  /** The Session's Agent, provider identity, and public `threadId`. */
  scope: SessionScope
  /** The connection's send port for client-side ACP methods. */
  client: AgentContext
  /** The Session's context usage, as the workspace reads and validates it. */
  readUsage: () => Promise<SessionContextResponse>
  /** The Session's model catalog, as the workspace reads and validates it. */
  readModels: () => Promise<SessionModelsResponse>
}

class SessionAttachment {
  readonly #context: AcpConnectionContext
  readonly #scope: SessionScope
  readonly #client: AgentContext
  readonly #readUsage: () => Promise<SessionContextResponse>
  readonly #readModels: () => Promise<SessionModelsResponse>
  #subscription: CoordinatedRunSubscription | undefined
  #pending: { requestId: string; promise: Promise<void> } | undefined
  readonly #replies = new Map<string, RequestReply>()
  #state = initialTranslateState
  #sequence = 0
  #stopRequested = false
  #detached = false
  #usageRetry: ReturnType<typeof setTimeout> | undefined
  /** Which usage report is live; a chain a newer trigger replaced stops. */
  #usageChain = 0

  constructor(options: SessionAttachmentOptions) {
    this.#context = options.context
    this.#scope = options.scope
    this.#client = options.client
    this.#readUsage = options.readUsage
    this.#readModels = options.readModels
  }

  /**
   * Subscribes to the Session's live run, if one is still in flight.
   * `replayedCorrections` names the steer acknowledgements this subscription
   * must drop because the history it follows already carried them.
   */
  async attach(after?: number, replayedCorrections = 0) {
    if (this.#detached || this.#subscription) return
    const { state, runId } = this.#coordinator.snapshot(this.#scope)
    if (state === "idle" || runId === undefined) return
    this.#consume(
      await this.#coordinator.recover(
        this.#scope,
        {
          threadId: this.#scope.threadId,
          runId,
          ...(after === undefined ? {} : { after }),
        },
        this.#access()
      ),
      replayedCorrections
    )
  }

  /** Admits one user turn and subscribes to the segment it starts. */
  async startTurn(input: PromptTurnInput, stage?: ServerAttachmentStage) {
    this.#consume(
      await this.#coordinator.start(
        this.#scope,
        input,
        this.#access(),
        ...(stage ? [stage] : [])
      ),
      0
    )
  }

  /** Requests Stop, reporting an unsettled provider as `execution: stopping`. */
  async cancel() {
    const status = await this.#coordinator.stop(this.#scope, this.#controllerId)
    if (status !== "stopping") return
    this.#stopRequested = true
    await this.reportExecution()
  }

  /**
   * Reports the Session's execution as one `state_update`. A run segment's
   * `state_update`s come from the translator; this is the out-of-band one a
   * resume or an acknowledged Stop owes the client.
   */
  reportExecution() {
    const { state, runId } = this.#coordinator.snapshot(this.#scope)
    const meta =
      runId === undefined
        ? {}
        : {
            _meta: {
              [AOS_META_KEY]: {
                sequence: this.#sequence,
                turnId: runId,
                ...(state === "stopping"
                  ? { execution: "stopping" as const }
                  : {}),
              },
            },
          }
    if (state === "waiting-for-input")
      return this.update({
        sessionUpdate: "state_update",
        state: "requires_action",
        ...meta,
      })
    if (state === "running" || state === "stopping")
      return this.update({
        sessionUpdate: "state_update",
        state: "running",
        ...meta,
      })
    return this.update({
      sessionUpdate: "state_update",
      state: "idle",
      ...(state === "uncertain"
        ? { stopReason: AOS_STOP_REASONS.uncertain }
        : {}),
      ...meta,
    })
  }

  /**
   * Reports the Session's context usage. Every attach and every settled turn
   * owes the client one of these, because the window moves with the
   * conversation and its size moves with the model the Session runs.
   *
   * A window that is unreadable right after an attach is usually the provider's
   * agent still being built, so the report is deferred through a bounded
   * backoff rather than dropped. Each trigger replaces whatever the previous one
   * left deferred, so one Session never has two reports in flight.
   *
   * A provider that cannot answer at all leaves the last reading standing: an
   * unreadable window is not an outcome the operator is owed a notice about,
   * and clearing the gauge would claim an empty context instead of an unknown
   * one.
   */
  async reportUsage() {
    this.#cancelUsageRetry()
    this.#usageChain += 1
    await this.#sendUsage(this.#usageChain, 0)
  }

  /** Re-issues the requests a recovered wait is still holding. */
  async reissuePending() {
    const { pendingRequestToOutbound } = this.#context.translators
    for (const request of this.#coordinator.snapshot(this.#scope).requests) {
      if (this.#pending?.requestId === request.requestId) continue
      if (this.#replies.has(request.requestId)) continue
      this.#ask(pendingRequestToOutbound(request, this.#context.lane))
    }
  }

  /**
   * Sends one translated item outside a run segment, which is what a replay is:
   * the same `session/update` and `_aos/*` notifications the run pump sends,
   * under the sequence this attachment has reached.
   */
  send(outbound: AcpOutbound) {
    return this.#send(outbound, this.#sequence)
  }

  update(update: SessionUpdate) {
    // Nothing to tell a client that has gone. A resolved promise rather than
    // `undefined`, because callers chain on what this returns.
    if (this.#detached) return Promise.resolve()
    const failure = runFailureOf(update)
    if (failure) this.#log("error", "acp.turn.failed", failure)
    return this.#client.notify(methods.client.session.update, {
      sessionId: this.#scope.threadId,
      update,
    })
  }

  /**
   * Reports a failure that has no request to answer.
   *
   * A detached attachment reports nothing. Its deferred work outlives the
   * client by a task or two, so whatever it was carrying fails on a socket the
   * browser already closed: that is the operator navigating away, not a fault
   * this deployment has to answer for. Logging it as one buries the failures
   * that are real.
   */
  async report(cause: unknown) {
    if (this.#detached) return
    const { runtime } = this.#context.runtimeInstance
    const failure = errorNotificationOf(runtime, cause)
    this.#log("error", "acp.error", {
      errorCode: failure.code,
      message: failure.message,
    })
    await this.#client
      .notify(AOS_METHODS.notify.error, {
        sessionId: this.#scope.threadId,
        ...failure,
      })
      .catch(() => undefined)
  }

  detach() {
    this.#detached = true
    this.#cancelUsageRetry()
    this.#subscription?.close()
    this.#subscription = undefined
    this.#replies.clear()
  }

  /**
   * One reading of the window, or one deferred attempt at the next. A chain a
   * newer trigger replaced stops here rather than sending a reading the client
   * has already moved past.
   */
  async #sendUsage(chain: number, attempt: number) {
    if (this.#detached || chain !== this.#usageChain) return
    const usage = await this.#readUsage().catch(() => undefined)
    if (this.#detached || chain !== this.#usageChain) return
    if (!usage) {
      this.#scheduleUsageRetry(chain, attempt)
      return
    }
    await this.update(usageUpdate(usage))
  }

  /** Defers one chain's next attempt, while its backoff budget lasts. */
  #scheduleUsageRetry(chain: number, attempt: number) {
    if (attempt >= USAGE_RETRY_DELAYS_MS.length) return
    this.#usageRetry = setTimeout(() => {
      this.#usageRetry = undefined
      // Nothing awaits a deferred report, so it reports its own failure rather
      // than rejecting into nowhere, exactly as the run pump's report does.
      void this.#sendUsage(chain, attempt + 1).catch((cause: unknown) =>
        this.report(cause)
      )
    }, USAGE_RETRY_DELAYS_MS[attempt])
  }

  #cancelUsageRetry() {
    clearTimeout(this.#usageRetry)
    this.#usageRetry = undefined
  }

  get #coordinator() {
    return this.#context.runtimeInstance.sessions
  }

  /** One structured, redacted line per Session-level ACP event. */
  #log(
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>
  ) {
    this.#context.logger?.[level](
      redactForLog({
        event,
        connectionId: this.#context.connectionId,
        sessionId: this.#scope.threadId,
        ...fields,
      })
    )
  }

  /**
   * Whether Stop was acknowledged for the segment being translated. The
   * coordinator clears its own `stopping` state as soon as the provider
   * settles, which is the same event the translator has to report as
   * cancelled, so the acknowledgement is latched until the next segment.
   */
  get #stopping() {
    return (
      this.#stopRequested ||
      this.#coordinator.snapshot(this.#scope).state === "stopping"
    )
  }

  /** The subscriber the coordinator knows this attachment's stream by. */
  get #subscriberId() {
    return `${this.#context.connectionId}:${this.#scope.threadId}`
  }

  /** The controller the coordinator knows this connection by. */
  get #controllerId() {
    return (
      this.#context.guest?.grant()?.principalId ?? this.#context.principalId
    )
  }

  /**
   * How the coordinator sees one subscription of this attachment. The guest
   * projection replaces the run stream with its allowlisted events and restates
   * the same controller identity, so a guest may Stop only its own run.
   */
  #access() {
    const { lane, guest } = this.#context
    const base = {
      subscriberId: this.#subscriberId,
      controllerId: this.#controllerId,
      lane,
      canControl: lane === "operator",
    }
    return guest ? guest.project.access(base, this.#scope) : base
  }

  #consume(
    subscription: CoordinatedRunSubscription,
    replayedCorrections: number
  ) {
    this.#subscription = subscription
    this.#state = { ...initialTranslateState, replayedCorrections }
    this.#stopRequested = false
    void this.#pump(subscription)
  }

  async #pump(subscription: CoordinatedRunSubscription) {
    const { translateTurnEvent } = this.#context.translators
    let overflow: FanoutOverflowError | undefined
    try {
      for await (const { sequence, event } of subscription.events) {
        this.#sequence = sequence
        const translated = translateTurnEvent(this.#state, event, {
          turnId: subscription.runId,
          sequence,
          lane: this.#context.lane,
          stopping: this.#stopping,
        })
        this.#state = translated.state
        for (const outbound of translated.outbound)
          await this.#send(outbound, sequence)
      }
    } catch (cause) {
      if (cause instanceof FanoutOverflowError) overflow = cause
      else await this.report(cause)
    } finally {
      if (this.#subscription === subscription) this.#subscription = undefined
    }
    if (overflow) return this.#resync(subscription.runId, overflow)
    // The turn this segment carried has settled, so the window it grew is now
    // readable. A failed or cancelled turn still consumed context, so this
    // follows the drain rather than a successful outcome. Nothing awaits the
    // pump, so this reports its own failure rather than rejecting into nowhere.
    await this.reportUsage().catch((cause: unknown) => this.report(cause))
  }

  /**
   * Tells the client that what it holds of this Session is incomplete, because
   * the stream it was reading was dropped for falling behind its bounds.
   *
   * The run itself is unharmed and may still be going, so this is not a run
   * failure and the segment did not settle: reporting either would leave the
   * client believing a turn it only saw part of had ended. The client owes
   * itself the Session from the start, which is what invalidation asks for.
   */
  async #resync(turnId: string, overflow: FanoutOverflowError) {
    this.#log("error", "acp.fanout.detached", {
      subscriberId: this.#subscriberId,
      turnId,
      events: overflow.events,
      bytes: overflow.bytes,
    })
    // A detached attachment has no client left to resync, exactly as it has
    // none to report a failure to.
    if (this.#detached) return
    await this.#client
      .notify(AOS_METHODS.notify.sessionInvalidated, {
        sessionId: this.#scope.threadId,
      })
      .catch(() => undefined)
  }

  async #send(outbound: AcpOutbound, sequence: number) {
    const sessionId = this.#scope.threadId
    switch (outbound.kind) {
      case "update":
        return this.update(outbound.update)
      case "artifact":
        return this.#client.notify(AOS_METHODS.notify.artifact, {
          sessionId,
          sequence,
          turnId: outbound.turnId,
          ...(outbound.messageId === undefined
            ? {}
            : { messageId: outbound.messageId }),
          artifact: outbound.artifact,
        })
      case "steer-accepted":
        return this.#client.notify(AOS_METHODS.notify.steerAccepted, {
          sessionId,
          sequence,
          turnId: outbound.turnId,
          requestId: outbound.requestId,
          text: outbound.text,
          delivery: outbound.delivery,
        })
      case "composer-prefill":
        return this.#client.notify(AOS_METHODS.notify.composerPrefill, {
          sessionId,
          turnId: outbound.turnId,
          text: outbound.text,
        })
      case "model-changed":
        return this.#reportModel(outbound.modelId)
      case "request-permission":
      case "elicitation":
        return this.#ask(outbound)
    }
  }

  /** Issues one server→client request and settles it as a resume reply. */
  /**
   * ACP restates the whole option set on a model switch, so the catalog is
   * read and the model the provider reported is selected in it. An unreadable
   * catalog leaves the options the client holds standing, as usage does.
   */
  async #reportModel(modelId: string) {
    const models = await this.#readModels().catch(() => undefined)
    if (!models) return
    await this.update({
      sessionUpdate: "config_option_update",
      configOptions: this.#context.translators.configOptionsOf({
        ...models,
        selectedId: modelId,
      }),
    })
  }

  #ask(outbound: RequestOutbound) {
    const promise = (
      outbound.kind === "request-permission"
        ? this.#askPermission(outbound)
        : this.#askElicitation(outbound)
    ).catch((cause: unknown) => this.report(cause))
    this.#pending = { requestId: outbound.requestId, promise }
  }

  async #askPermission(
    outbound: Extract<AcpOutbound, { kind: "request-permission" }>
  ) {
    const response = await this.#client.request(
      methods.client.session.requestPermission,
      { ...outbound.request, sessionId: this.#scope.threadId }
    )
    const request = this.#pendingRequest(outbound.requestId)
    const { guest, translators } = this.#context
    const reply = translators.replyFromPermission(request, response)
    // A guest may answer only within the scope it was offered, so its
    // projection refuses a widened grant the way the guest run route does.
    await this.#settle(
      request,
      guest ? guest.project.permissionReply(request, reply) : reply
    )
  }

  async #askElicitation(
    outbound: Extract<AcpOutbound, { kind: "elicitation" }>
  ) {
    if (!hasMode(outbound.request))
      throw new Error("The elicitation carries no mode")
    // An elicitation is scoped to a Session or to one request; this one is
    // both, so a client that reads either scope can still route it.
    const response = await this.#client.request(
      methods.client.elicitation.create,
      {
        ...outbound.request,
        sessionId: this.#scope.threadId,
        requestId: outbound.requestId,
      }
    )
    const request = this.#pendingRequest(outbound.requestId)
    const { replyFromElicitation } = this.#context.translators
    // The answered question reaches the transcript before the run resumes, so
    // the call that asked it stops reading as unanswered while the next segment
    // streams.
    const lane = this.#context.lane
    const record = answeredQuestionOutbound(request, response, lane)
    if (record) await this.send(record)
    await this.#settle(request, replyFromElicitation(request, response, lane))
  }

  /** The request an answer belongs to; a settled one can no longer be answered. */
  #pendingRequest(requestId: string) {
    const request = this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
    if (!request) throw staleRequest()
    return request
  }

  /** Starts the next run segment once every pending request is answered. */
  async #settle(request: PendingRequest, reply: RequestReply) {
    this.#log("info", "acp.request.answered", {
      requestId: request.requestId,
      status: reply.status,
    })
    if (this.#pending?.requestId === request.requestId)
      this.#pending = undefined
    this.#replies.set(request.requestId, reply)
    const { requests } = this.#coordinator.snapshot(this.#scope)
    if (!requests.every(({ requestId }) => this.#replies.has(requestId))) return
    const replies = requests.flatMap(({ requestId }) => {
      const entry = this.#replies.get(requestId)
      return entry ? [entry] : []
    })
    this.#replies.clear()
    const turnId = crypto.randomUUID()
    this.#consume(
      await this.#coordinator.start(
        this.#scope,
        { turnId, replies },
        this.#access()
      ),
      0
    )
  }
}

export function createSessionAttachment(options: SessionAttachmentOptions) {
  return new SessionAttachment(options)
}

export type { SessionAttachment }
