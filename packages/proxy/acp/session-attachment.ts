import {
  methods,
  SessionUpdate,
  StateUpdate,
  type AgentContext,
} from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionContextResponse } from "../../protocol"
import {
  AOS_METHODS,
  AOS_META_KEY,
  AOS_STOP_REASONS,
  AosStateMetaSchema,
} from "../../protocol/acp"
import type { PendingRequest, RequestReply } from "../core/events"
import type {
  NewTurnRunInput,
  ServerAttachmentStage,
  SessionScope,
} from "../core/runtime"
import type { CoordinatedRunSubscription } from "../core/session-coordinator"
import { redactForLog } from "../redaction"
import { answeredQuestionOutbound } from "./translate/interrupts"
import {
  initialTranslateState,
  type AcpConnectionContext,
  type AcpOutbound,
} from "./types"
import { errorNotificationOf, staleInterrupt } from "./validation"

/**
 * One Session as one ACP connection observes it: at most one coordinator
 * subscription, the reducer state that subscription's run segment carries, and
 * the one server→client request its pending interaction is waiting on.
 *
 * The attachment owns only the browser subscriber lifetime. Detaching releases
 * the subscription and nothing else: the native Session, the coordinator's
 * logical execution, and a pending interaction all outlive it.
 */

type InterruptOutbound = Extract<
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

/**
 * The failure an idle `state_update` reports, when it reports one. Every other
 * update — including every streamed chunk — falls out on the first check.
 * `redactForLog` masks any field named `code`, so each logged machine code
 * travels under the protocol's own name for it.
 */
function runFailureOf(update: SessionUpdate) {
  if (!SessionUpdate.isStateUpdate(update) || !StateUpdate.isIdle(update))
    return undefined
  const stopReason = update.stopReason
  if (typeof stopReason !== "string" || !AOS_STOP_CODES.has(stopReason))
    return undefined
  const meta = AosStateMetaSchema.safeParse(update._meta?.[AOS_META_KEY])
  return { stopReason, ...(meta.success ? { runId: meta.data.runId } : {}) }
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
}

class SessionAttachment {
  readonly #context: AcpConnectionContext
  readonly #scope: SessionScope
  readonly #client: AgentContext
  readonly #readUsage: () => Promise<SessionContextResponse>
  #subscription: CoordinatedRunSubscription | undefined
  #pending: { interruptId: string; promise: Promise<void> } | undefined
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
  }

  /** Subscribes to the Session's live run, if one is still in flight. */
  async attach(after?: number) {
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
        this.#access(runId)
      )
    )
  }

  /** Admits one user turn and subscribes to the segment it starts. */
  async startTurn(input: NewTurnRunInput, stage?: ServerAttachmentStage) {
    this.#consume(
      await this.#coordinator.start(
        this.#scope,
        input,
        this.#access(input.runId),
        ...(stage ? [stage] : [])
      )
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
                runId,
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
    for (const request of this.#coordinator.snapshot(this.#scope).interrupts) {
      if (this.#pending?.interruptId === request.id) continue
      if (this.#replies.has(request.id)) continue
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
    const failure = runFailureOf(update)
    if (failure) this.#log("error", "acp.run.failed", failure)
    return this.#client.notify(methods.client.session.update, {
      sessionId: this.#scope.threadId,
      update,
    })
  }

  /** Reports a failure that has no request to answer. */
  async report(cause: unknown) {
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
  #access(runId: string) {
    const { connectionId, lane, guest } = this.#context
    const base = {
      subscriberId: `${connectionId}:${this.#scope.threadId}`,
      controllerId: this.#controllerId,
      lane,
      canControl: lane === "operator",
    }
    return guest ? guest.project.access(base, this.#scope, runId) : base
  }

  #consume(subscription: CoordinatedRunSubscription) {
    this.#subscription = subscription
    this.#state = initialTranslateState
    this.#stopRequested = false
    void this.#pump(subscription)
  }

  async #pump(subscription: CoordinatedRunSubscription) {
    const { translateRunEvent } = this.#context.translators
    try {
      for await (const { sequence, event } of subscription.events) {
        this.#sequence = sequence
        const translated = translateRunEvent(this.#state, event, {
          runId: subscription.runId,
          sequence,
          lane: this.#context.lane,
          stopping: this.#stopping,
        })
        this.#state = translated.state
        for (const outbound of translated.outbound)
          await this.#send(outbound, sequence)
      }
    } catch (cause) {
      await this.report(cause)
    } finally {
      if (this.#subscription === subscription) this.#subscription = undefined
    }
    // The turn this segment carried has settled, so the window it grew is now
    // readable. A failed or cancelled turn still consumed context, so this
    // follows the drain rather than a successful outcome. Nothing awaits the
    // pump, so this reports its own failure rather than rejecting into nowhere.
    await this.reportUsage().catch((cause: unknown) => this.report(cause))
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
          runId: outbound.runId,
          ...(outbound.messageId === undefined
            ? {}
            : { messageId: outbound.messageId }),
          artifact: outbound.artifact,
        })
      case "steer-accepted":
        return this.#client.notify(AOS_METHODS.notify.steerAccepted, {
          sessionId,
          sequence,
          runId: outbound.runId,
          requestId: outbound.requestId,
          text: outbound.text,
          delivery: outbound.delivery,
        })
      case "composer-prefill":
        return this.#client.notify(AOS_METHODS.notify.composerPrefill, {
          sessionId,
          runId: outbound.runId,
          text: outbound.text,
        })
      case "request-permission":
      case "elicitation":
        return this.#ask(outbound)
    }
  }

  /** Issues one server→client request and settles it as a resume reply. */
  #ask(outbound: InterruptOutbound) {
    const promise = (
      outbound.kind === "request-permission"
        ? this.#askPermission(outbound)
        : this.#askElicitation(outbound)
    ).catch((cause: unknown) => this.report(cause))
    this.#pending = { interruptId: outbound.interruptId, promise }
  }

  async #askPermission(
    outbound: Extract<AcpOutbound, { kind: "request-permission" }>
  ) {
    const response = await this.#client.request(
      methods.client.session.requestPermission,
      { ...outbound.request, sessionId: this.#scope.threadId }
    )
    const request = this.#interrupt(outbound.interruptId)
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
        requestId: outbound.interruptId,
      }
    )
    const request = this.#interrupt(outbound.interruptId)
    const { replyFromElicitation } = this.#context.translators
    // The answered question reaches the transcript before the run resumes, so
    // the call that asked it stops reading as unanswered while the next segment
    // streams.
    const record = answeredQuestionOutbound(request, response)
    if (record) await this.send(record)
    await this.#settle(request, replyFromElicitation(request, response))
  }

  /** The interrupt an answer belongs to; a settled one can no longer be answered. */
  #interrupt(interruptId: string) {
    const request = this.#coordinator
      .snapshot(this.#scope)
      .interrupts.find(({ id }) => id === interruptId)
    if (!request) throw staleInterrupt()
    return request
  }

  /** Starts the next run segment once every pending interrupt is answered. */
  async #settle(request: PendingRequest, reply: RequestReply) {
    this.#log("info", "acp.request.answered", {
      interruptId: request.id,
      status: reply.status,
    })
    if (this.#pending?.interruptId === request.id) this.#pending = undefined
    this.#replies.set(request.id, reply)
    const { interrupts } = this.#coordinator.snapshot(this.#scope)
    if (!interrupts.every(({ id }) => this.#replies.has(id))) return
    const resume = interrupts.flatMap(({ id }) => {
      const entry = this.#replies.get(id)
      return entry ? [entry] : []
    })
    this.#replies.clear()
    const runId = crypto.randomUUID()
    this.#consume(
      await this.#coordinator.start(
        this.#scope,
        {
          threadId: this.#scope.threadId,
          runId,
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
          resume,
        },
        this.#access(runId)
      )
    )
  }
}

export function createSessionAttachment(options: SessionAttachmentOptions) {
  return new SessionAttachment(options)
}

export type { SessionAttachment }
