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
import type { CoordinatedTurnSubscription } from "../core/session-coordinator"
import { FanoutOverflowError } from "../core/subscriber-fanout"
import { redactForLog } from "../redaction"
import { promptCopy, promptText } from "./prompt-content"
import type { RoomMember, RoomTurn } from "./session-rooms"
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

/**
 * What a deferred usage report waits before each re-read, in order. The budget
 * is bounded: a provider that has not built its agent within half a minute is
 * not building one, and the next turn owes the client a reading anyway.
 */
const USAGE_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
]

export type SessionMemberOptions = {
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

class SessionMember {
  readonly #context: AcpConnectionContext
  readonly #scope: SessionScope
  readonly #client: AgentContext
  readonly #readUsage: () => Promise<SessionContextResponse>
  readonly #readModels: () => Promise<SessionModelsResponse>
  #subscription: CoordinatedTurnSubscription | undefined
  /** Subscriptions a restart dropped, whose remaining events nobody is owed. */
  readonly #dropped = new WeakSet<CoordinatedTurnSubscription>()
  #pending: { requestId: string; promise: Promise<void> } | undefined
  readonly #replies = new Map<string, RequestReply>()
  #sequence = 0
  #stopRequested = false
  #left = false
  /** The turnId the latest subscription carried, which outlives its stream. */
  #followedTurn: string | undefined
  /**
   * The follow or start in flight. Both subscribe this member, so one waits
   * for the other rather than both subscribing it to the same turn.
   */
  #entering: Promise<unknown> | undefined
  /** This member as the Session's room addresses it. */
  readonly #seat: RoomMember
  #leaveRoom: (() => void) | undefined
  #usageRetry: ReturnType<typeof setTimeout> | undefined
  /** Which usage report is live; a chain a newer trigger replaced stops. */
  #usageChain = 0

  constructor(options: SessionMemberOptions) {
    this.#context = options.context
    this.#scope = options.scope
    this.#client = options.client
    this.#readUsage = options.readUsage
    this.#readModels = options.readModels
    this.#seat = {
      sendTurn: (turn) => this.#sendTurn(turn),
      follow: async () =>
        (await this.#follow(false)) === undefined ? "idle" : "following",
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
   * returns the turnId it streams. `replayedCorrections` names the steer
   * acknowledgements this subscription must drop because the history it
   * follows already carried them.
   */
  follow(after?: number, replayedCorrections = 0) {
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

  /** Admits one user turn and subscribes to the segment it starts. */
  async startTurn(input: PromptTurnInput, stage?: ServerAttachmentStage) {
    await this.#exclusive(async () =>
      this.#consume(
        await this.#coordinator.start(
          this.#scope,
          input,
          this.#access(),
          ...(stage ? [stage] : [])
        ),
        0
      )
    )
  }

  /**
   * Takes this member's seat in the Session's room. `hasPrompt` says the view
   * holds the live turn's prompt; a `replayed` view was just rebuilt from
   * history, so a member already seated is seated afresh from what it holds.
   */
  enterRoom(hasPrompt = false, replayed = false) {
    if (this.#left) return
    const { rooms } = this.#context
    if (!this.#leaveRoom)
      this.#leaveRoom = rooms.add(this.#scope, this.#seat, { hasPrompt })
    else if (replayed) rooms.reseat(this.#scope, this.#seat, { hasPrompt })
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
   * Reports the Session's context usage. Every join and every settled turn
   * owes the client one of these, because the window moves with the
   * conversation and its size moves with the model the Session runs.
   *
   * A window that is unreadable right after joining is usually the provider's
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
    this.#cancelUsageRetry()
    this.#subscription?.close()
    this.#subscription = undefined
    this.#replies.clear()
  }

  /**
   * Subscribes to the live turn unless this member already carries it. A
   * resume asks whether its current subscription does, so it can re-follow a
   * turn whose stream it lost; the room asks whether any subscription ever
   * did, so a member is never streamed one turn twice. Returns the turnId it
   * streams, or `undefined` when no turn is live.
   */
  #follow(refollow: boolean, after?: number, replayedCorrections = 0) {
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
            ...(after === undefined ? {} : { after }),
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
        text === undefined ? promptCopy(content) : [{ type: "text", text }],
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
   * One reading of the window, or one deferred attempt at the next. A chain a
   * newer trigger replaced stops here rather than sending a reading the client
   * has already moved past.
   */
  async #sendUsage(chain: number, attempt: number) {
    if (this.#left || chain !== this.#usageChain) return
    const usage = await this.#readUsage().catch(() => undefined)
    if (this.#left || chain !== this.#usageChain) return
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
      // than rejecting into nowhere, exactly as the turn pump's report does.
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
        return this.#reportModel(outbound.modelId)
      case "request-permission":
      case "elicitation":
        return this.#ask(outbound)
    }
  }

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

  /**
   * Issues one server→client request and settles it as a request reply. A
   * request already open or already answered here is not asked again, however
   * a replay or a reissue reaches it.
   */
  #ask(outbound: RequestOutbound) {
    if (
      this.#pending?.requestId === outbound.requestId ||
      this.#replies.has(outbound.requestId)
    )
      return
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
    // projection refuses a widened grant the way the guest turn route does.
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
    // The answered question reaches the transcript before the turn continues, so
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

  /** Starts the next turn segment once every pending request is answered. */
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
    const from = this.#coordinator.snapshot(this.#scope).turnId
    const turnId = crypto.randomUUID()
    await this.#exclusive(async () =>
      this.#consume(
        await this.#coordinator.start(
          this.#scope,
          { turnId, replies },
          this.#access()
        ),
        0
      )
    )
    // Outside the admission above: syncing follows every member, this one
    // included, and a follow waits for the admission it would be inside.
    const { rooms } = this.#context
    if (from !== undefined) rooms.continueTurn(this.#scope, from, turnId)
    await rooms.sync(this.#scope)
  }
}

export function createSessionMember(options: SessionMemberOptions) {
  return new SessionMember(options)
}

export type { SessionMember }
