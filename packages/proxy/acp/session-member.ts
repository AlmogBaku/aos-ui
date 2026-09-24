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
import type {
  PendingRequest,
  PromptTurnInput,
  RequestReply,
} from "../core/events"
import type { ServerAttachmentStage, SessionScope } from "../core/runtime"
import type { CoordinatedTurnSubscription } from "../core/session-coordinator"
import { FanoutOverflowError } from "../core/subscriber-fanout"
import { redactForLog } from "../redaction"
import type { RoomMember, RoomTurn } from "../core/channel"
import { promptText } from "../core/member"
import { promptBlocks } from "./prompt-content"
import { answeredQuestionOutbound } from "./translate/requests"
import {
  initialTranslateState,
  type AcpConnectionContext,
  type AcpOutbound,
} from "./types"
import { errorNotificationOf, staleRequest } from "./validation"

/**
 * One Session as one ACP connection observes it: at most one coordinator
 * subscription, the reducer state that subscription's turn segment carries, and
 * the one server→client request its pending interaction is waiting on.
 *
 * The member owns only the browser subscriber lifetime. Leaving releases
 * the subscription and its seat in the Session's room, and nothing else: the
 * native Session, the coordinator's logical execution, and a pending
 * interaction all outlive it.
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

/** The vendor stop reasons that mean the turn failed rather than finished. */
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
 * diagnoses one turn by. `errorCode` is the name `acp.error` already logs the
 * same classification under.
 */
function turnFailureOf(update: SessionUpdate) {
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

export type SessionMemberOptions = {
  context: AcpConnectionContext
  /** The Session's Agent, provider identity, and public `threadId`. */
  scope: SessionScope
  /** The connection's send port for client-side ACP methods. */
  client: AgentContext
}

class SessionMember {
  readonly #context: AcpConnectionContext
  readonly #scope: SessionScope
  readonly #client: AgentContext
  #subscription: CoordinatedTurnSubscription | undefined
  /** Subscriptions a restart dropped, whose remaining events nobody is owed. */
  readonly #dropped = new WeakSet<CoordinatedTurnSubscription>()
  /** The requests this member asked and has not settled, by requestId. */
  readonly #pending = new Map<
    string,
    { promise: Promise<void>; controller: AbortController }
  >()
  #sequence = 0
  #stopRequested = false
  #left = false
  /** The turnId the latest subscription carried, which outlives its stream. */
  #followedTurn: string | undefined
  /** The turn this member last asked its client to rebuild the view for. */
  #reloadedTurn: string | undefined
  /** Set while a from-start replay rebuilds the view: the room waits for it. */
  #rebuilding = false
  /**
   * The follow or start in flight. Both subscribe this member, so one waits
   * for the other rather than both subscribing it to the same turn.
   */
  #entering: Promise<unknown> | undefined
  /** This member as the Session's room addresses it. */
  readonly #seat: RoomMember
  #leaveRoom: (() => void) | undefined
  readonly #leaveReadings: () => void

  constructor(options: SessionMemberOptions) {
    this.#context = options.context
    this.#scope = options.scope
    this.#client = options.client
    this.#leaveReadings = this.#coordinator.subscribeReadings(
      this.#scope,
      this.#subscriberId,
      {
        usage: (usage) => this.#deliver(usageUpdate(usage)),
        // ACP restates the whole option set on a model switch.
        model: (models) =>
          this.#deliver({
            sessionUpdate: "config_option_update",
            configOptions: this.#context.translators.configOptionsOf(models),
          }),
      }
    )
    this.#seat = {
      sendTurn: (turn) => (this.#rebuilding ? undefined : this.#sendTurn(turn)),
      // A view being rebuilt is seated afresh and follows once its page lands.
      follow: async () =>
        this.#rebuilding || (await this.#follow(false)) !== undefined
          ? "following"
          : "idle",
      followedTurn: () => this.#followedTurn,
      invalidate: () => this.#invalidate(),
      report: (cause) => {
        if (this.#left) return
        const { runtime } = this.#context.runtimeInstance
        const failure = errorNotificationOf(runtime, cause)
        this.#log("error", "acp.room.failed", {
          errorCode: failure.code,
          message: failure.message,
        })
      },
    }
  }

  /**
   * Subscribes to the Session's live turn, if one is still in flight, and
   * returns the turnId it streams. `after` is the cursor the view holds, or
   * `"reset"` for a view holding part of the turn it cannot position.
   * `replayedCorrections` names the steer acknowledgements this subscription
   * must drop because the history it follows already carried them.
   */
  follow(after?: number | "reset", replayedCorrections = 0) {
    return this.#follow(true, after, replayedCorrections)
  }

  /**
   * Drops the stream this member is reading, so its next follow replays the
   * turn from the start to a view about to be rebuilt from history. The turn
   * stays followed, so the room does not subscribe this member meanwhile.
   */
  async restartStream() {
    await this.#exclusive(async () => {
      const subscription = this.#subscription
      if (!subscription) return
      this.#subscription = undefined
      this.#dropped.add(subscription)
      subscription.close()
    })
  }

  /**
   * Keeps the room's prompts and streams from this view while it is rebuilt
   * from history, so none lands above the page. `enterRoom` or `releaseRoom`
   * ends it.
   */
  holdRoom() {
    this.#rebuilding = true
  }

  releaseRoom() {
    this.#rebuilding = false
  }

  /**
   * Tells the client to rebuild this Session's view from history, once per
   * turn: a rebuild that fails the same way again must not ask again. Returns
   * whether it asked.
   */
  async reloadOnce(turnId: string) {
    if (this.#reloadedTurn === turnId) return false
    this.#reloadedTurn = turnId
    await this.#invalidate()
    return true
  }

  /** Admits one user turn and subscribes to the segment it starts. */
  async startTurn(input: PromptTurnInput, stage?: ServerAttachmentStage) {
    await this.#exclusive(async () => {
      let subscription
      try {
        subscription = await this.#coordinator.start(
          this.#scope,
          input,
          this.#access(),
          ...(stage ? [stage] : [])
        )
      } catch (cause) {
        // No turn started, so no turn end asks the runtime for one it started
        // meanwhile, which may be what refused this one.
        void this.#context.rooms.recheck(this.#scope)
        throw cause
      }
      await this.#consume(subscription, 0)
    })
  }

  /**
   * Takes this member's seat in the Session's room. `hasPrompt` says the view
   * holds the live turn's prompt; a `replayed` view was just rebuilt from
   * history, so a member already seated is seated afresh from what it holds.
   */
  enterRoom(hasPrompt = false, replayed = false) {
    this.#rebuilding = false
    if (this.#left) return
    const { rooms } = this.#context
    if (!this.#leaveRoom) {
      const leave = rooms.add(this.#scope, this.#seat, {
        hasPrompt,
        lane: this.#context.lane,
      })
      // A request the Session resolves, through another member's answer or a
      // Stop, is withdrawn here so this UI stops offering it.
      const unobserve = this.#coordinator.observeScope(this.#scope, (event) => {
        if (event.kind === "attention-resolved") this.#withdraw(event.requestId)
      })
      this.#leaveRoom = () => {
        leave()
        unobserve()
      }
    } else if (replayed) rooms.reseat(this.#scope, this.#seat, { hasPrompt })
  }

  /** Shows the room a turn this member admitted, then brings every member in. */
  async announce(turn: RoomTurn) {
    const { rooms } = this.#context
    await rooms.broadcastTurn(this.#scope, turn, this.#seat)
    await rooms.sync(this.#scope)
  }

  /** Brings this member alone into whatever turn the room is running. */
  catchUp() {
    return this.#context.rooms.catchUp(this.#scope, this.#seat)
  }

  /** Requests Stop, reporting an unsettled provider as `execution: stopping`. */
  async cancel() {
    const status = await this.#coordinator.stop(this.#scope, this.#controllerId)
    if (status !== "stopping") return
    this.#stopRequested = true
    await this.reportExecution()
  }

  /**
   * Reports the Session's execution as one `state_update`. A turn segment's
   * `state_update`s come from the translator; this is the out-of-band one a
   * resume or an acknowledged Stop owes the client.
   */
  reportExecution() {
    const { state, turnId } = this.#coordinator.snapshot(this.#scope)
    const meta =
      turnId === undefined
        ? {}
        : {
            _meta: {
              [AOS_META_KEY]: {
                sequence: this.#sequence,
                turnId,
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
   * Owes this member the Session's current context usage, which a joining
   * client needs for its gauge. The coordinator's reporter defers a window that
   * is unreadable right after joining, usually the provider's agent still being
   * built, and leaves the last reading standing if it never becomes readable.
   */
  reportUsage() {
    return this.#coordinator.reportUsage(this.#scope, this.#subscriberId)
  }

  /** Re-issues the requests a recovered wait is still holding. */
  async reissuePending() {
    const { pendingRequestToOutbound } = this.#context.translators
    for (const request of this.#coordinator.snapshot(this.#scope).requests)
      this.#ask(pendingRequestToOutbound(request, this.#context.lane))
  }

  /**
   * Sends one translated item outside a turn segment, which is what a replay is:
   * the same `session/update` and `_aos/*` notifications the turn pump sends,
   * under the sequence this attachment has reached.
   */
  send(outbound: AcpOutbound) {
    return this.#send(outbound, this.#sequence)
  }

  /** The Session this member attaches, as its connection resolved it. */
  get scope() {
    return this.#scope
  }

  update(update: SessionUpdate) {
    // Nothing to tell a client that has gone. A resolved promise rather than
    // `undefined`, because callers chain on what this returns.
    if (this.#left) return Promise.resolve()
    const failure = turnFailureOf(update)
    if (failure) this.#log("error", "acp.turn.failed", failure)
    return this.#client.notify(methods.client.session.update, {
      sessionId: this.#scope.threadId,
      update,
    })
  }

  /**
   * Reports a failure that has no request to answer.
   *
   * A left member reports nothing. Its deferred work outlives the
   * client by a task or two, so whatever it was carrying fails on a socket the
   * browser already closed: that is the operator navigating away, not a fault
   * this deployment has to answer for. Logging it as one buries the failures
   * that are real.
   */
  async report(cause: unknown) {
    if (this.#left) return
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

  leave() {
    this.#left = true
    this.#leaveRoom?.()
    this.#leaveReadings()
    this.#subscription?.close()
    this.#subscription = undefined
    for (const requestId of [...this.#pending.keys()]) this.#withdraw(requestId)
  }

  /**
   * Subscribes to the live turn unless this member already carries it. A
   * resume asks whether its current subscription does, so it can re-follow a
   * turn whose stream it lost; the room asks whether any subscription ever
   * did, so a member is never streamed one turn twice. Returns the turnId it
   * streams, or `undefined` when no turn is live.
   */
  #follow(
    refollow: boolean,
    after?: number | "reset",
    replayedCorrections = 0
  ) {
    return this.#exclusive(async (): Promise<string | undefined> => {
      if (this.#left) return undefined
      const { state, turnId } = this.#coordinator.snapshot(this.#scope)
      if (state === "idle" || turnId === undefined) return undefined
      const carried = refollow ? this.#subscription?.turnId : this.#followedTurn
      if (carried === turnId) return turnId
      this.#consume(
        await this.#coordinator.recover(
          this.#scope,
          {
            threadId: this.#scope.threadId,
            turnId,
            ...(after === "reset"
              ? { reset: true as const }
              : after === undefined
                ? {}
                : { after }),
          },
          this.#access()
        ),
        replayedCorrections
      )
      return turnId
    })
  }

  /** Runs one subscribing task once every earlier one has settled. */
  async #exclusive<T>(task: () => Promise<T>) {
    while (this.#entering) await this.#entering.catch(() => undefined)
    const entering = task()
    this.#entering = entering
    try {
      return await entering
    } finally {
      if (this.#entering === entering) this.#entering = undefined
    }
  }

  /**
   * Shows this member a prompt another member sent. A guest sees only the
   * text its projection allows, and nothing when that is none of it; an
   * operator sees the blocks rebuilt from the fields a browser writes.
   */
  #sendTurn({ messageId, content }: RoomTurn) {
    const { guest } = this.#context
    const text = guest?.project.turn(promptText(content))
    if (guest && text === undefined) return
    return this.update({
      sessionUpdate: "user_message",
      messageId,
      content:
        text === undefined ? promptBlocks(content) : [{ type: "text", text }],
    })
  }

  /** Asks the client to reload the Session from history. */
  async #invalidate() {
    // A left member has no client left to resync, exactly as it has
    // none to report a failure to.
    if (this.#left) return
    await this.#client
      .notify(AOS_METHODS.notify.sessionInvalidated, {
        sessionId: this.#scope.threadId,
      })
      .catch(() => undefined)
  }

  /**
   * Sends one reading the coordinator reported. Nothing awaits a deferred one,
   * so this reports its own failure rather than rejecting into nowhere.
   */
  #deliver(update: SessionUpdate) {
    return this.update(update).catch((cause: unknown) => this.report(cause))
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

  /** The subscriber the coordinator knows this member's stream by. */
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
   * projection replaces the turn stream with its allowlisted events and grants
   * control of what it follows, so a guest may Stop any turn in its Session,
   * not only one it started.
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
    subscription: CoordinatedTurnSubscription,
    replayedCorrections: number
  ) {
    // A member that left while its subscription was being admitted keeps none.
    if (this.#left) {
      subscription.close()
      return
    }
    this.#subscription = subscription
    // A restarted stream is the same segment, whose Stop stays acknowledged.
    if (subscription.turnId !== this.#followedTurn) this.#stopRequested = false
    this.#followedTurn = subscription.turnId
    void this.#pump(subscription, replayedCorrections)
  }

  /**
   * Translates one subscription's segment. The reducer state is the segment's
   * own, so an earlier segment still draining never mixes into a later one.
   */
  async #pump(
    subscription: CoordinatedTurnSubscription,
    replayedCorrections: number
  ) {
    const { translateTurnEvent } = this.#context.translators
    let state = { ...initialTranslateState, replayedCorrections }
    let overflow: FanoutOverflowError | undefined
    try {
      for await (const { sequence, event } of subscription.events) {
        if (this.#dropped.has(subscription)) break
        this.#sequence = sequence
        const translated = translateTurnEvent(state, event, {
          turnId: subscription.turnId,
          sequence,
          lane: this.#context.lane,
          stopping: this.#stopping,
        })
        state = translated.state
        for (const outbound of translated.outbound) {
          if (this.#dropped.has(subscription)) break
          await this.#send(outbound, sequence)
        }
      }
    } catch (cause) {
      if (cause instanceof FanoutOverflowError) overflow = cause
      else await this.report(cause)
    } finally {
      if (this.#subscription === subscription) this.#subscription = undefined
    }
    // The stream that replaced a dropped one settles the segment instead.
    if (this.#dropped.has(subscription)) return
    if (overflow) return this.#resync(subscription.turnId, overflow)
  }

  /**
   * Tells the client that what it holds of this Session is incomplete, because
   * the stream it was reading was dropped for falling behind its bounds.
   *
   * The turn itself is unharmed and may still be going, so this is not a turn
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
    await this.#invalidate()
  }

  async #send(outbound: AcpOutbound, sequence: number) {
    const sessionId = this.#scope.threadId
    switch (outbound.kind) {
      case "update":
        return this.update(outbound.update)
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
        // The coordinator's model reporter restates the options.
        return
      case "request-permission":
      case "elicitation":
        return this.#ask(outbound)
    }
  }

  /**
   * Issues one server→client request and settles it as a request reply. A
   * request already open here, or one the Session no longer waits on, is not
   * asked again, however a replay or a reissue reaches it.
   */
  #ask(outbound: RequestOutbound) {
    if (
      this.#pending.has(outbound.requestId) ||
      !this.#openRequest(outbound.requestId)
    )
      return
    const controller = new AbortController()
    const { signal } = controller
    const promise = (
      outbound.kind === "request-permission"
        ? this.#askPermission(outbound, signal)
        : this.#askElicitation(outbound, signal)
    ).catch((cause: unknown) =>
      // A withdrawn request is refused as cancelled, which is no failure.
      signal.aborted ? undefined : this.report(cause)
    )
    this.#pending.set(outbound.requestId, { promise, controller })
  }

  /** Cancels a request the Session resolved, which is `$/cancel_request`. */
  #withdraw(requestId: string) {
    const pending = this.#pending.get(requestId)
    if (!pending) return
    this.#pending.delete(requestId)
    pending.controller.abort()
  }

  async #askPermission(
    outbound: Extract<AcpOutbound, { kind: "request-permission" }>,
    signal: AbortSignal
  ) {
    const response = await this.#client.request(
      methods.client.session.requestPermission,
      { ...outbound.request, sessionId: this.#scope.threadId },
      { cancellationSignal: signal }
    )
    // An answer that crossed its withdrawal is no longer this member's to give.
    if (signal.aborted) return
    const request = this.#pendingRequest(outbound.requestId)
    const { guest, translators } = this.#context
    const reply = translators.replyFromPermission(request, response)
    // A guest may answer only within the scope it was offered, so its
    // projection refuses a widened grant the way the guest turn route does.
    await this.#settle(
      request,
      guest ? guest.project.permissionReply(request, reply) : reply
    )
  }

  async #askElicitation(
    outbound: Extract<AcpOutbound, { kind: "elicitation" }>,
    signal: AbortSignal
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
      },
      { cancellationSignal: signal }
    )
    if (signal.aborted) return
    const request = this.#pendingRequest(outbound.requestId)
    const { replyFromElicitation } = this.#context.translators
    // The answered question reaches the transcript before the turn continues, so
    // the call that asked it stops reading as unanswered while the next segment
    // streams.
    const lane = this.#context.lane
    const record = answeredQuestionOutbound(request, response, lane)
    if (record) await this.send(record)
    await this.#settle(request, replyFromElicitation(request, response, lane))
  }

  #openRequest(requestId: string) {
    return this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
  }

  /** The request an answer belongs to; a settled one can no longer be answered. */
  #pendingRequest(requestId: string) {
    const request = this.#openRequest(requestId)
    if (!request) throw staleRequest()
    return request
  }

  /**
   * Gives the Session this member's answer to one request. The answer that
   * leaves nothing open continues the turn, and every member follows it.
   */
  async #settle(request: PendingRequest, reply: RequestReply) {
    this.#log("info", "acp.request.answered", {
      requestId: request.requestId,
      status: reply.status,
    })
    // Before the answer resolves this request, so the member answering it
    // does not withdraw it from itself.
    this.#pending.delete(request.requestId)
    const continued = await this.#coordinator.answer(this.#scope, reply)
    if (!continued) return
    const { rooms } = this.#context
    rooms.continueTurn(this.#scope, continued.from, continued.turnId)
    await rooms.sync(this.#scope)
  }
}

export function createSessionMember(options: SessionMemberOptions) {
  return new SessionMember(options)
}

export type { SessionMember }
