import {
  methods,
  type AgentContext,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import { AOS_METHODS, AOS_META_KEY, AOS_STOP_REASONS } from "../../protocol/acp"
import type { PendingRequest, RequestReply } from "../core/events"
import type {
  NewTurnRunInput,
  ServerAttachmentStage,
  SessionScope,
} from "../core/runtime"
import type { CoordinatedRunSubscription } from "../core/session-coordinator"
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

export type SessionAttachmentOptions = {
  context: AcpConnectionContext
  /** The Session's Agent, provider identity, and public `threadId`. */
  scope: SessionScope
  /** The connection's send port for client-side ACP methods. */
  client: AgentContext
}

class SessionAttachment {
  readonly #context: AcpConnectionContext
  readonly #scope: SessionScope
  readonly #client: AgentContext
  #subscription: CoordinatedRunSubscription | undefined
  #pending: { interruptId: string; promise: Promise<void> } | undefined
  readonly #replies = new Map<string, RequestReply>()
  #state = initialTranslateState
  #sequence = 0
  #stopRequested = false
  #detached = false

  constructor(options: SessionAttachmentOptions) {
    this.#context = options.context
    this.#scope = options.scope
    this.#client = options.client
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
        this.#access()
      )
    )
  }

  /** Admits one user turn and subscribes to the segment it starts. */
  async startTurn(input: NewTurnRunInput, stage?: ServerAttachmentStage) {
    this.#consume(
      await this.#coordinator.start(
        this.#scope,
        input,
        this.#access(),
        ...(stage ? [stage] : [])
      )
    )
  }

  /** Requests Stop, reporting an unsettled provider as `execution: stopping`. */
  async cancel() {
    const status = await this.#coordinator.stop(
      this.#scope,
      this.#context.principalId
    )
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

  /** Re-issues the requests a recovered wait is still holding. */
  async reissuePending() {
    const { pendingRequestToOutbound } = this.#context.translators
    for (const request of this.#coordinator.snapshot(this.#scope).interrupts) {
      if (this.#pending?.interruptId === request.id) continue
      if (this.#replies.has(request.id)) continue
      this.#ask(pendingRequestToOutbound(request, this.#context.lane))
    }
  }

  update(update: SessionUpdate) {
    return this.#client.notify(methods.client.session.update, {
      sessionId: this.#scope.threadId,
      update,
    })
  }

  /** Reports a failure that has no request to answer. */
  async report(cause: unknown) {
    const { runtime } = this.#context.runtimeInstance
    await this.#client
      .notify(AOS_METHODS.notify.error, {
        sessionId: this.#scope.threadId,
        ...errorNotificationOf(runtime, cause),
      })
      .catch(() => undefined)
  }

  detach() {
    this.#detached = true
    this.#subscription?.close()
    this.#subscription = undefined
    this.#replies.clear()
  }

  get #coordinator() {
    return this.#context.runtimeInstance.sessions
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

  #access() {
    const { connectionId, principalId, lane } = this.#context
    return {
      subscriberId: `${connectionId}:${this.#scope.threadId}`,
      controllerId: principalId,
      lane,
      canControl: lane === "operator",
    }
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
    const { replyFromPermission } = this.#context.translators
    await this.#settle(request, replyFromPermission(request, response))
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
    if (this.#pending?.interruptId === request.id) this.#pending = undefined
    this.#replies.set(request.id, reply)
    const { interrupts } = this.#coordinator.snapshot(this.#scope)
    if (!interrupts.every(({ id }) => this.#replies.has(id))) return
    const resume = interrupts.flatMap(({ id }) => {
      const entry = this.#replies.get(id)
      return entry ? [entry] : []
    })
    this.#replies.clear()
    this.#consume(
      await this.#coordinator.start(
        this.#scope,
        {
          threadId: this.#scope.threadId,
          runId: crypto.randomUUID(),
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
          resume,
        },
        this.#access()
      )
    )
  }
}

export function createSessionAttachment(options: SessionAttachmentOptions) {
  return new SessionAttachment(options)
}

export type { SessionAttachment }
