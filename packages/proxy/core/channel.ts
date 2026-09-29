import {
  backoffDelay,
  createOwner,
  defaultClock,
  ownerSetup,
  type Clock,
  type Logger,
  type Owner,
  type OwnerContext,
} from "../../lifecycle"
import type {
  SessionHistoryResponse,
  SessionModelsResponse,
  SessionModelUpdateRequest,
} from "../../protocol"
import {
  JOIN_DEADLINE_MS,
  PAUSED_DEADLINE_MS,
  READING_BACKOFF,
  READING_RETRIES,
} from "./limits"
import { persistedCorrections, withoutLiveRows } from "./replay-page"
import {
  isAwaitingStopFailure,
  isRedialableFailure,
  ReplyStatus,
  TurnEventKind,
  type ExecutionEvent,
  type PendingRequest,
  type RequestReply,
  type TurnEvent,
} from "./events"
import {
  CommandRefusedError,
  hasSession,
  runEvents,
  type CommandResults,
  type Member,
  type MemberScope,
  type PromptPart,
  type SessionEvent,
  type TurnStream,
} from "./member"
import {
  ServerRequestStaleError,
  ServerTurnConflictError,
  ServerTurnEndedError,
  ServerTurnUncertainError,
  type ServerRuntime,
  type ServerTurnListener,
  type SessionScope,
} from "./runtime"
import {
  clientTurnIds,
  ReplayCursorLostError,
  type CoordinatedTurnSubscription,
  type CoordinatorAccess,
  type ClientSend,
  type CreateInput,
  type SessionCoordinator,
  type StartOptions,
} from "./session-coordinator"
import type { SessionRow } from "./session-rows"
import { FanoutOverflowError } from "./subscriber-fanout"

/**
 * A channel is one provider Session; its members are the connections that
 * have joined it. The coordinator already fans a turn's stream out to many
 * followers, so a channel only carries what the stream cannot: the prompt that
 * started the turn, and a nudge to reload when a member saw a prompt but missed
 * its reply. A channel with members also subscribes to its Session, so a turn the
 * runtime starts by itself is adopted and streamed to every member like one of
 * their own.
 */

export type ChannelScope = Pick<SessionScope, "agentId" | "providerSessionId">

export type ChannelTurn = {
  turnId: string
  messageId: string
  content: readonly PromptPart[]
  /** When the turn was admitted, on the channels' monotonic clock. */
  at: number
}

export type MembershipDelivery = {
  /** Send this turn's prompt to the member as its user_message. */
  sendTurn(turn: ChannelTurn): void | Promise<void>
  /** Subscribe the member to the current turn's stream. */
  follow(): Promise<"following" | "idle">
  /** The turnId the member's own subscription last carried, if any. */
  followedTurn(): string | undefined
  /**
   * Rebuild the member's view from the Session's history, once its stream of
   * the `ended` turn, if it reads one, has shown that turn's end.
   */
  rebuild(ended?: string): void | Promise<void>
  /** Record a send/follow failure for this member alone. */
  report(cause: unknown): void
}

export type Channels = ReturnType<typeof createChannels>
type ChannelTable = ReturnType<typeof createChannelTable>
/** What lets a channel adopt a turn the runtime started by itself. */
export type ChannelAdoption = {
  subscribeTurns(scope: SessionScope, listener: ServerTurnListener): () => void
  /** Adopts the runtime's running turn, if any. */
  discover(scope: SessionScope): Promise<unknown>
  /** The Session's execution feed. */
  subscribeExecutions(
    scope: ChannelScope,
    listener: (event: ExecutionEvent) => void
  ): () => void
}

type Delivery = {
  /** The member's own scope, which an adoption runs under. */
  scope: SessionScope
  /** The turnId whose prompt this member already holds. */
  delivered?: string
  /** Whether the channel sent that prompt, rather than the member owning it. */
  fromChannel: boolean
}

type Channel = {
  turn?: ChannelTurn
  memberships: Map<MembershipDelivery, Delivery>
  /** Ends the channel's turn subscription and its execution feed. */
  unsubscribe?: () => void
  /** One adoption runs at a time; a trigger meanwhile asks for one more. */
  adopting?: boolean
  again?: boolean
  /** The turn this channel adopted, whose prompt no member has seen. */
  adopted?: string
  /** Failed discovers in a row, which the next retry backs off on. */
  failures: number
  /** The pending retry of a failed discover. */
  retry?: unknown
  /** Bumped when the channel closes: a discover answered since changes nothing. */
  generation: number
}

const DEFAULT_BACKSTOP_MS = 60 * 60 * 1000

/**
 * How a declined permission is answered: the one-time refusal when the
 * request offers it, so no lasting rule lands on the Agent, and a
 * cancellation otherwise.
 */
function declineReply(request: PendingRequest): RequestReply {
  const choices = request.responseSchema?.enum
  return Array.isArray(choices) && choices.includes("deny")
    ? {
        requestId: request.requestId,
        status: ReplyStatus.Resolved,
        payload: "deny",
      }
    : { requestId: request.requestId, status: ReplyStatus.Cancelled }
}

/** Where a resuming view already reaches in the live turn. */
export type ResumePosition = { turnId?: string; after?: number }

/**
 * How a resume builds its view: rebuilt from history `fromStart`, and from
 * the newest page alone for a member that `paged` older history itself.
 */
export type ResumeView = { fromStart: boolean; paged: boolean }

/**
 * How history is read: the bounded `pageSize` one from-start read or one
 * older page reads, and the `maxOffset` pages reach back to; older history
 * reads as truncated.
 */
export type HistoryReach = { pageSize: number; maxOffset: number }

export const HISTORY_REACH: HistoryReach = { pageSize: 500, maxOffset: 100_000 }

/** Whether an older page exists within the reach, past the one just read. */
export function hasOlderPage(page: SessionHistoryResponse, maxOffset: number) {
  return (
    !page.truncated &&
    page.nextOffset < page.total &&
    page.nextOffset > page.offset &&
    page.nextOffset < maxOffset
  )
}

/**
 * Whether a resume already shows the live turn's prompt: its cursor sits inside
 * that turn, or the page it replayed holds the prompt's id, the one the
 * provider stored it under.
 */
function showsPrompt(
  turn: ChannelTurn | undefined,
  position: ResumePosition,
  history?: SessionHistoryResponse
) {
  if (!turn) return false
  if (position.turnId === turn.turnId) return true
  return history?.messages.some(({ id }) => id === turn.messageId) ?? false
}

/** A turn's state as a member's view reads it, from the event that set it. */
function statedBy(event: TurnEvent) {
  switch (event.kind) {
    case TurnEventKind.TurnStarted:
      return "running"
    case TurnEventKind.TurnRequiresAction:
      return "requires_action"
    case TurnEventKind.TurnEnded:
      return "idle"
    case TurnEventKind.TurnFailed:
      return isAwaitingStopFailure(event) ? "requires_action" : "idle"
    default:
      return undefined
  }
}

/**
 * The same state, from the coordinator's view of the Session. Stopping and
 * uncertain read as no stream event does, so a resume always states them.
 */
function viewState(state: string, awaitingStop?: boolean) {
  if (state === "waiting-for-input" || (state === "running" && awaitingStop))
    return "requires_action"
  return state
}

/**
 * Keyed like the coordinator's `scopeKey`, never by the public `sessionId`: a
 * guest's public id differs from the operator's for the same provider Session.
 */
function channelKey(scope: ChannelScope) {
  return `${scope.agentId}\u0000${scope.providerSessionId}`
}

/** Runs one member's call so its failure reaches only that member. */
async function attempt<T>(
  member: MembershipDelivery,
  call: () => T | Promise<T>
): Promise<T | undefined> {
  try {
    return await call()
  } catch (cause) {
    member.report(cause)
    return undefined
  }
}

/**
 * The member an adoption runs as: the first to join. The coordinator reports
 * the turn under this member's Session, and activity and push read it.
 */
function adopter(channel: Channel) {
  return [...channel.memberships].at(0)
}

function createChannelTable({
  snapshot,
  adoption,
  clock,
  logger,
  backstopMs = DEFAULT_BACKSTOP_MS,
}: {
  /** Coordinator view of a Session: state and the live segment's turnId. */
  snapshot: (scope: ChannelScope) => { state: string; turnId?: string }
  /** Absent when the runtime cannot report the turns it starts. */
  adoption?: ChannelAdoption
  /** The monotonic clock a turn's admission and the backstop read. */
  clock: Clock
  /**
   * Where the channels write, and the logger the membership machine is set
   * up on; each membership writes on its own.
   */
  logger: Logger
  backstopMs?: number
}) {
  const channels = new Map<string, Channel>()

  /**
   * The cached prompt while its turn is still live. A finished execution keeps
   * its old turnId in the coordinator, so only the state check ends it.
   */
  function currentTurn(scope: ChannelScope, channel: Channel) {
    const { turn } = channel
    if (!turn) return undefined
    const { state, turnId } = snapshot(scope)
    const live = state !== "idle" && turnId === turn.turnId
    // A question may wait on a person indefinitely; the backstop only guards
    // against a turn the coordinator never reports as ended.
    const expired =
      state !== "waiting-for-input" && clock.now() - turn.at > backstopMs
    if (live && !expired) return turn
    channel.turn = undefined
    return undefined
  }

  async function send(
    member: MembershipDelivery,
    delivery: Delivery,
    turn: ChannelTurn
  ) {
    // Marked while in flight so a concurrent sync cannot repeat it, and
    // unmarked on failure so the next sync retries it.
    const { delivered, fromChannel } = delivery
    delivery.delivered = turn.turnId
    delivery.fromChannel = true
    try {
      await member.sendTurn(turn)
    } catch (cause) {
      member.report(cause)
      if (delivery.delivered !== turn.turnId) return
      delivery.delivered = delivered
      delivery.fromChannel = fromChannel
    }
  }

  async function catchUpMember(
    scope: ChannelScope,
    channel: Channel,
    member: MembershipDelivery,
    delivery: Delivery
  ) {
    const turn = currentTurn(scope, channel)
    if (turn && delivery.delivered !== turn.turnId) {
      await send(member, delivery, turn)
    }
    // Read before following: the prompt may be dropped meanwhile.
    const shown = delivery.fromChannel ? delivery.delivered : undefined
    const following = await attempt(member, () => member.follow())
    if (following !== "idle" || !shown || member.followedTurn() === shown) {
      return
    }
    // Shown a prompt whose reply it never streamed; history has the reply.
    delivery.fromChannel = false
    await attempt(member, () => member.rebuild())
  }

  async function syncChannel(scope: ChannelScope, channel: Channel) {
    await Promise.all(
      [...channel.memberships].map(([member, delivery]) =>
        catchUpMember(scope, channel, member, delivery)
      )
    )
  }

  /** Records what a member holds of the live turn, sending it the prompt if not. */
  function join(
    channel: Channel,
    member: MembershipDelivery,
    delivery: Delivery,
    hasPrompt: boolean
  ) {
    channel.memberships.set(member, delivery)
    const turn = currentTurn(delivery.scope, channel)
    if (!turn) return
    if (hasPrompt) delivery.delivered = turn.turnId
    else
      send(member, delivery, turn).catch((err: unknown) =>
        logger.error({ err }, "channel.send.failed")
      )
  }

  /**
   * Asks the runtime for a turn it started by itself and, when it adopts one,
   * brings every member into it. Runs one at a time per channel, and once more
   * when asked again meanwhile.
   */
  async function adopt(channel: Channel) {
    if (channel.adopting) {
      channel.again = true
      return
    }
    channel.adopting = true
    try {
      do {
        channel.again = false
        await adoptOnce(channel)
      } while (channel.again)
    } finally {
      channel.adopting = false
    }
  }

  /** Asks in the background: nothing awaits the ask, so a failure is logged. */
  function adoptLater(channel: Channel) {
    adopt(channel).catch((err: unknown) =>
      logger.error({ err }, "channel.adopt.failed")
    )
  }

  async function adoptOnce(channel: Channel) {
    // This ask replaces a retry still pending.
    clock.clearTimeout(channel.retry)
    channel.retry = undefined
    const joined = adopter(channel)
    if (!adoption || !joined) return
    const [member, { scope }] = joined
    const { generation } = channel
    const before = snapshot(scope).turnId
    try {
      await adoption.discover(scope)
    } catch (cause) {
      if (channel.generation !== generation) return
      // A proxy turn still starting refuses it; that turn's end asks again.
      if (cause instanceof ServerTurnConflictError) return
      retryAdoption(channel)
      member.report(cause)
      return
    }
    if (channel.generation !== generation) return
    channel.failures = 0
    const { state, turnId } = snapshot(scope)
    if (state === "idle" || turnId === undefined || turnId === before) return
    channel.adopted = turnId
    await syncChannel(scope, channel)
  }

  /**
   * Asks again on backoff after a failed discover, so a turn the runtime
   * started is not missed until the next turn's end; past the budget, that
   * end asks.
   */
  function retryAdoption(channel: Channel) {
    if (channel.failures >= READING_RETRIES) {
      channel.failures = 0
      return
    }
    const delay = backoffDelay(channel.failures, READING_BACKOFF)
    channel.failures += 1
    channel.retry = clock.setTimeout(() => {
      channel.retry = undefined
      adoptLater(channel)
    }, delay)
  }

  /** Ends a memberless channel's feeds and its pending retry. */
  function close(channel: Channel) {
    channel.generation += 1
    clock.clearTimeout(channel.retry)
    channel.retry = undefined
    channel.unsubscribe?.()
  }

  /**
   * Every turn's end asks the runtime once more, which finds a turn it started
   * while the proxy's own ran. An adopted turn's end rebuilds every member's
   * view from history, which holds the prompt none of them was shown.
   */
  function onExecution(channel: Channel, event: ExecutionEvent) {
    if (event.kind !== "turn-finished" && event.kind !== "turn-failed") return
    if (event.turnId === channel.adopted) {
      channel.adopted = undefined
      for (const member of channel.memberships.keys())
        attempt(member, () => member.rebuild(event.turnId)).catch(
          (err: unknown) => logger.error({ err }, "channel.rebuild.failed")
        )
    }
    adoptLater(channel)
  }

  function subscribe(scope: SessionScope, channel: Channel) {
    if (!adoption) return
    const unsubscribeExecutions = adoption.subscribeExecutions(scope, (event) =>
      onExecution(channel, event)
    )
    const unsubscribeTurns = adoption.subscribeTurns(scope, {
      onTurn: () => adoptLater(channel),
      onError: (cause) => adopter(channel)?.[0].report(cause),
    })
    channel.unsubscribe = () => {
      unsubscribeTurns()
      unsubscribeExecutions()
    }
  }

  return {
    add(
      scope: SessionScope,
      member: MembershipDelivery,
      options: { hasPrompt: boolean }
    ) {
      const key = channelKey(scope)
      let channel = channels.get(key)
      const created = !channel
      if (!channel) {
        channel = { memberships: new Map(), failures: 0, generation: 0 }
        channels.set(key, channel)
      }
      const joined = channel
      const remove = () => {
        joined.memberships.delete(member)
        if (joined.memberships.size === 0 && channels.get(key) === joined) {
          channels.delete(key)
          close(joined)
        }
      }
      if (joined.memberships.has(member)) return remove
      join(joined, member, { scope, fromChannel: false }, options.hasPrompt)
      // Subscribed once the first member joins, so a turn already running
      // has someone to adopt it as.
      if (created) subscribe(scope, joined)
      return remove
    },

    /**
     * Rejoins a member after its view was rebuilt from history, which
     * holds the live prompt only when `hasPrompt` says so.
     */
    rejoin(
      scope: ChannelScope,
      member: MembershipDelivery,
      options: { hasPrompt: boolean }
    ) {
      const channel = channels.get(channelKey(scope))
      const delivery = channel?.memberships.get(member)
      if (channel && delivery)
        join(
          channel,
          member,
          { scope: delivery.scope, fromChannel: false },
          options.hasPrompt
        )
    },

    /** Called only after the coordinator admitted `turn`. */
    async broadcastTurn(
      scope: ChannelScope,
      turn: ChannelTurn,
      sender: MembershipDelivery
    ) {
      const channel = channels.get(channelKey(scope))
      // No member means nobody to tell, and a memberless channel would leak.
      if (!channel) return
      channel.turn = turn
      const own = channel.memberships.get(sender)
      if (own) {
        own.delivered = turn.turnId
        own.fromChannel = false
      }
      // A member already shown the turn, as a repeat's first sender was, is
      // not shown it again.
      await Promise.all(
        [...channel.memberships]
          .filter(
            ([member, delivery]) =>
              member !== sender && delivery.delivered !== turn.turnId
          )
          .map(([member, delivery]) => send(member, delivery, turn))
      )
    },

    /** An answered question resumes the same prompt under a fresh turnId. */
    continueTurn(scope: ChannelScope, fromTurnId: string, toTurnId: string) {
      const channel = channels.get(channelKey(scope))
      if (!channel?.turn || channel.turn.turnId !== fromTurnId) return
      channel.turn = { ...channel.turn, turnId: toTurnId }
      for (const delivery of channel.memberships.values()) {
        if (delivery.delivered === fromTurnId) delivery.delivered = toTurnId
      }
    },

    /** The live turn's prompt, which a resume checks its own replay against. */
    current(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      return channel ? currentTurn(scope, channel) : undefined
    },

    async catchUp(scope: ChannelScope, member: MembershipDelivery) {
      const channel = channels.get(channelKey(scope))
      const delivery = channel?.memberships.get(member)
      if (channel && delivery)
        await catchUpMember(scope, channel, member, delivery)
    },

    async sync(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      if (channel) await syncChannel(scope, channel)
    },

    /**
     * Asks the runtime once for a turn no turn end will report: one a
     * member's failed start may have lost to, or one behind a wait a resume
     * found.
     */
    async recheck(scope: ChannelScope) {
      const channel = channels.get(channelKey(scope))
      if (channel) await adopt(channel)
    },

    /** How many members every channel holds, for the health gauges. */
    memberships() {
      let count = 0
      for (const channel of channels.values()) count += channel.memberships.size
      return count
    },
  }
}

type CreateChannelsOptions = Omit<
  Parameters<typeof createChannelTable>[0],
  "snapshot" | "clock"
> & {
  coordinator: SessionCoordinator
  /** Where a resume and an older page read the Session's history. */
  runtime: Pick<ServerRuntime, "history">
  clock?: Clock
  /** Defaults to `HISTORY_REACH`; a small one stands for a long Session. */
  historyReach?: HistoryReach
}

/** How a transport joins one member to one Session. */
export type MembershipOptions = {
  /** The membership the coordinator knows this member's stream by. */
  membershipId: string
  /** Where the membership writes, already naming its member and its Session. */
  logger: Logger
  /** The public code and message a failure is logged under. */
  describe: (cause: unknown) => { code: string; message: string }
  /** The Session's row as a replaying cell: the known row, then each change. */
  subscribeRow: (listener: (row: SessionRow) => void) => () => void
}

/** A membership's options, with the coordinator and clock its channels share. */
type MembershipContext = MembershipOptions & {
  coordinator: SessionCoordinator
  clock: Clock
  /** The history a from-start view replays, the newest page alone if `paged`. */
  readReplay: (
    scope: SessionScope,
    paged: boolean
  ) => Promise<SessionHistoryResponse>
}

/**
 * What moves a membership: a join and the answer that lands it, each stream
 * it follows, falling behind that stream's bounds, and parting.
 */
type MembershipSignal =
  | { type: "join" }
  | { type: "joined" }
  | { type: "followed" }
  | { type: "fell-behind" }
  | { type: "part" }

/**
 * One membership's lifetime: joining until the answer to its join lands,
 * joined while it follows its Session, paused once it fell behind until its
 * view rejoins, and detached for good once it parts or a deadline passes.
 * Each stream it follows is a generation of its own, so a stream another one
 * replaced settles nothing.
 */
export function membershipMachine(logger: Logger, clock: Clock) {
  return ownerSetup<OwnerContext, MembershipSignal>(
    "membership",
    logger,
    clock
  ).createMachine({
    context: { generation: 0 },
    initial: "joining",
    on: {
      followed: { actions: "bumpGeneration" },
      part: ".detached",
    },
    states: {
      joining: {
        after: { [JOIN_DEADLINE_MS]: "detached" },
        on: {
          // A membership a read or write made first gives each join its
          // whole deadline.
          join: { target: "joining", reenter: true },
          joined: "joined",
          "fell-behind": "paused",
        },
      },
      joined: { on: { join: "joining", "fell-behind": "paused" } },
      paused: {
        after: { [PAUSED_DEADLINE_MS]: "detached" },
        on: { join: "joining" },
      },
      detached: { type: "final" },
    },
  })
}

type MembershipOwner = Owner<ReturnType<typeof membershipMachine>>

/** A join its membership's end cut short, which the next join may land. */
export class MembershipDetachedError extends Error {
  constructor() {
    super("The membership detached before its join landed")
    this.name = "MembershipDetachedError"
  }
}

/** Settles as `work` does, unless `signal` aborts first: then with its reason. */
export function unlessAborted<T>(work: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    work
      .finally(() => signal.removeEventListener("abort", abort))
      .then(resolve, reject)
  })
}

export function createChannels(options: CreateChannelsOptions) {
  const { coordinator, runtime, logger } = options
  const clock = options.clock ?? defaultClock
  const historyReach = options.historyReach ?? HISTORY_REACH
  const channels = createChannelTable({
    ...options,
    clock,
    snapshot: (scope) => coordinator.snapshot(scope),
  })
  const machine = membershipMachine(logger, clock)
  /** The memberships reading an older page: one page at a time each. */
  const paging = new WeakSet<Membership>()

  /** One history page, `offset` rows back from the newest. */
  function readHistory(scope: SessionScope, offset = 0) {
    return runtime.history(
      scope.agentId,
      scope.providerSessionId,
      historyReach.pageSize,
      offset
    )
  }

  /**
   * The history a from-start resume replays. ACP replays all retained
   * history; a member that pages older history itself gets the newest page
   * and where the page before it starts. Either way the reach bounds the
   * reading.
   */
  async function readReplay(scope: SessionScope, paged: boolean) {
    const newest = await readHistory(scope)
    if (paged) return newest
    const older: SessionHistoryResponse["messages"][] = []
    // A turn stored between two reads shifts the offsets, so the same message
    // can come back on the next older page.
    const seen = new Set(newest.messages.map(({ id }) => id))
    let page = newest
    while (hasOlderPage(page, historyReach.maxOffset)) {
      page = await readHistory(scope, page.nextOffset)
      older.unshift(page.messages.filter(({ id }) => !seen.has(id)))
      for (const { id } of page.messages) seen.add(id)
    }
    return {
      ...newest,
      messages: [...older.flat(), ...newest.messages],
      nextOffset: page.nextOffset,
      truncated: page.truncated,
    }
  }

  return {
    ...channels,
    historyReach,
    /** Joins one member to one Session until the membership detaches. */
    join(member: Member, scope: MemberScope, membership: MembershipOptions) {
      const owner = createOwner(machine, {
        logger: membership.logger,
        clock,
        bindings: {
          agentId: scope.agentId,
          membershipId: membership.membershipId,
        },
      })
      return new Membership(
        channels,
        member,
        scope,
        { ...membership, coordinator, clock, readReplay },
        owner
      )
    },

    /**
     * Resumes one member's view of its Session, rebuilt from its history
     * first when `view` asks `fromStart` or its position cannot be followed:
     * the newest page alone for a member that `paged` older history itself.
     * The view reads the history, then the
     * live events the journal buffered, then the Session's state, before the
     * answer. The join lands once the answer is written, and the Session's
     * readings and row reach the member as events after it. A Session waiting
     * on input asks its runtime whether the wait still stands, which the
     * answer does not wait for. A resume the journal serves asks the provider
     * nothing first: the reads its join starts, and the turn subscription,
     * find a Session gone meanwhile and end it, which spares every rejoin a
     * round trip.
     */
    async resume(
      membership: Membership,
      position: ResumePosition,
      view?: ResumeView
    ): Promise<CommandResults["resume"]> {
      const resumed = await membership.resume(position, view)
      membership.joined()
      if (
        !membership.pending &&
        coordinator.state(membership.scope) === "waiting-for-input"
      )
        channels
          .recheck(membership.scope)
          .catch((err: unknown) =>
            logger.error({ err }, "channel.adopt.failed")
          )
      return resumed
    },

    /**
     * Shows one member an older page of its Session, as tagged updates ahead
     * of the answer. A member reads one page at a time.
     */
    async olderPage(
      membership: Membership,
      older: { cursor: string; offset: number }
    ): Promise<CommandResults["older-page"]> {
      if (paging.has(membership)) throw new CommandRefusedError("invalid")
      paging.add(membership)
      try {
        const page = await readHistory(membership.scope, older.offset)
        // A cursor past this Session's history was never issued for it. One
        // at its end was: a runtime that estimates `total` learns the start
        // only by reading an empty page there.
        if (older.offset > page.total) throw new CommandRefusedError("invalid")
        await membership.showOlderPage(page, older)
        return { page }
      } catch (cause) {
        membership.endIfGone(cause)
        throw cause
      } finally {
        paging.delete(membership)
      }
    },

    /**
     * Creates a Session in `agentId` for `principalId`. A repeat of a client
     * id answers the Session its first create made.
     */
    createSession(agentId: string, input: CreateInput, principalId: string) {
      return coordinator.createSession(agentId, input, principalId)
    },

    /**
     * Switches the Session's model. Every member hears the switch, and the
     * `membership` that asked for it once its answer is written.
     */
    switchModel(
      scope: SessionScope,
      write: SessionModelUpdateRequest,
      membership?: Membership
    ): Promise<SessionModelsResponse> {
      return coordinator.switchModel(
        scope,
        write,
        membership &&
          ((report) => membership.afterResponse(async () => report()))
      )
    },
  }
}

/**
 * One Session as one member observes it: at most one coordinator
 * subscription, the cursor it has reached, and the requests it was asked.
 *
 * A membership owns only the member's subscriber lifetime. Detaching
 * releases the subscription, its place in the Session's channel and the
 * readings it was given, and nothing else: the native Session, the
 * coordinator's logical execution, and a pending request all outlive it.
 */
class Membership {
  readonly #channels: ChannelTable
  readonly #member: Member
  readonly #addressed: MemberScope
  readonly #options: MembershipContext
  #subscription: CoordinatedTurnSubscription | undefined
  /** Subscriptions a restart dropped, whose remaining events nobody is owed. */
  readonly #dropped = new WeakSet<CoordinatedTurnSubscription>()
  /**
   * The requests this member's stack was offered and not settled, and those
   * of them its connection was handed: a decline needs the first, an answer
   * and a withdrawal the second.
   */
  readonly #offered = new Set<string>()
  readonly #delivered = new Set<string>()
  #sequence = 0
  #stopRequested = false
  /** The turnId the latest subscription carried, which outlives its stream. */
  #followedTurn: string | undefined
  /** The turn whose stream this member last fell behind and rebuilt for. */
  #rebuiltTurn: string | undefined
  /** Whether this member's view pages older history itself. */
  #paged = false
  /** Settles once the member was shown what the journal buffered. */
  #caughtUp: Promise<void> = Promise.resolve()
  /** The turn state the member's stream last showed it since its resume. */
  #stated: string | undefined
  /**
   * Set while a resume builds the view, which is told the turn's state once
   * caught up: what a follow meanwhile replays says no state of its own.
   */
  #restating = false
  /**
   * The turn whose stream an interrupt ended, which this member follows again
   * once its coordinator settles whether it still runs.
   */
  #interrupted: string | undefined
  /**
   * Set while a from-start replay rebuilds the view: the channel waits for it.
   */
  #rebuilding = false
  /** The last stream this member was shown, settling once it has shown all. */
  #streamed: { turnId: string; done: Promise<void> } | undefined
  /**
   * The follow or start in flight. Both subscribe this member, so one waits
   * for the other rather than both subscribing it to the same turn.
   */
  #entering: Promise<unknown> | undefined
  /** This member as the Session's channel addresses it. */
  readonly #delivery: MembershipDelivery
  #partChannel: (() => void) | undefined
  /** Releases the Session's readings, which the member is given once joined. */
  #cells: (() => void) | undefined
  readonly #owner: MembershipOwner
  /** Aborts as the membership detaches, which ends a join still in flight. */
  readonly #detaching: AbortSignal

  constructor(
    channels: ChannelTable,
    member: Member,
    scope: MemberScope,
    options: MembershipContext,
    owner: MembershipOwner
  ) {
    this.#channels = channels
    this.#member = member
    this.#addressed = scope
    this.#options = options
    this.#owner = owner
    this.#detaching = owner.stack.adopt(new AbortController(), (controller) =>
      controller.abort(new MembershipDetachedError())
    ).signal
    owner.stack.defer(() => {
      this.#partChannel?.()
      this.#releaseCells()
      this.#subscription?.close()
      this.#subscription = undefined
    })
    this.#delivery = {
      sendTurn: ({ messageId, content }) =>
        this.#rebuilding
          ? undefined
          : this.emit({ kind: "prompt", messageId, content, own: false }),
      // A view being rebuilt rejoins and follows once its page lands.
      follow: async () =>
        this.#rebuilding || (await this.#follow(false)) !== undefined
          ? "following"
          : "idle",
      followedTurn: () => this.#followedTurn,
      rebuild: async (ended) => {
        if (ended !== undefined && this.#streamed?.turnId === ended)
          await this.#streamed.done
        await this.#rebuild()
      },
      // A Session the provider reports gone ends each of its memberships.
      report: (cause) => {
        if (this.detached || this.endIfGone(cause)) return
        const failure = options.describe(cause)
        options.logger.error(
          { errorCode: failure.code, message: failure.message },
          "channel.failed"
        )
      },
    }
  }

  /** The Session this member joined, as its transport resolved it. */
  get scope() {
    return this.#scope
  }

  /**
   * Whether this member addresses an invitation whose Session does not exist
   * yet. It is shown what it can do until its first Send creates the Session,
   * which joins it anew.
   */
  get pending() {
    return !hasSession(this.#addressed)
  }

  get #scope(): SessionScope {
    if (!hasSession(this.#addressed))
      throw new Error("The invited Session does not exist yet")
    return this.#addressed
  }

  /** Whether this membership is over: it parted, or a deadline passed. */
  get detached() {
    return this.#owner.stack.disposed
  }

  /**
   * Shows this member one event of its Session, through its stack. A member
   * that detached is shown nothing, and neither is one whose stack hides it: a
   * resolved promise rather than `undefined`, because callers chain on what
   * this returns, and never an extra await, because a turn's delivery order
   * rides on the send starting now. What the stack declines runs once the
   * event is delivered.
   */
  emit(event: SessionEvent): Promise<void> {
    if (this.detached) return Promise.resolve()
    const declines = new Set<string>()
    const shown = runEvents(
      this.#member.middleware,
      { sessionId: this.#addressed.sessionId, ...event },
      { decline: (requestId) => declines.add(requestId) }
    )
    if (shown?.kind === "request-asked")
      this.#delivered.add(shown.request.requestId)
    const sent = shown ? this.#member.connection.send(shown) : Promise.resolve()
    // The caller learns whether the event was sent; the declines run either
    // way.
    const decline = () =>
      Promise.all([...declines].map((id) => this.#decline(id)))
    if (declines.size > 0)
      sent
        .then(decline, decline)
        .catch((err: unknown) =>
          this.#options.logger.warn(
            { err },
            "membership.request.decline.failed"
          )
        )
    return sent
  }

  /**
   * Builds this member's view on resume, as its `view` asks. One from the
   * start is rebuilt from history first; any other keeps what it holds up to
   * `position`, and is rebuilt all the same when that cannot be positioned.
   * The view keeps whether it pages older history, for each rebuild after.
   * Either way the
   * member joins the channel, reads the live events the journal buffered and
   * then the Session's state. Returns the page it replayed. A join that has
   * not landed by its deadline detaches the membership, and the resume
   * rejects then; one that finds its Session gone ends it.
   */
  resume(
    position: ResumePosition,
    view: ResumeView = { fromStart: false, paged: this.#paged }
  ) {
    this.#releaseCells()
    // The resume answers before its join lands; a Session found gone between
    // the two still ends this member.
    if (!this.pending)
      this.#cells = this.#options.coordinator.subscribeReadings(
        this.#scope,
        this.#options.membershipId,
        { gone: (cause) => this.#end(cause) }
      )
    this.#send({ type: "join" })
    this.#paged = view.paged
    return unlessAborted(
      this.#resume(position, view.fromStart),
      this.#detaching
    ).catch((cause: unknown) => {
      this.endIfGone(cause)
      throw cause
    })
  }

  async #resume(
    position: ResumePosition,
    fromStart: boolean
  ): Promise<{ history?: SessionHistoryResponse }> {
    // A fresh invitation has no history to replay and no turn to follow.
    if (this.pending) return {}
    this.#stated = undefined
    this.#restating = true
    try {
      const history =
        fromStart || !(await this.#followPositioned(position))
          ? await this.#replay()
          : undefined
      await this.#reportView()
      return history === undefined ? {} : { history }
    } finally {
      this.#restating = false
    }
  }

  /**
   * Closes a view with the Session's state, once the member was shown what
   * the journal buffered: stated unless its stream already said it, with the
   * requests a wait still holds asked again.
   */
  async #reportView() {
    await this.#caughtUp
    const { state, awaitingStop } = this.#coordinator.snapshot(this.#scope)
    const stated = viewState(state, awaitingStop)
    if (this.#stated !== stated) {
      this.#stated = stated
      await this.reportExecution()
    }
    if (state === "waiting-for-input") this.reissuePending()
  }

  /**
   * Rebuilds the view from history and follows the live turn beside it,
   * returning the page it showed.
   */
  async #replay(): Promise<SessionHistoryResponse> {
    // A correction the provider persisted the moment it accepted the steer is
    // already in this page, so the journal's acknowledgement of it is dropped.
    const replay = await this.#replayHistory(() =>
      this.#options.readReplay(this.#scope, this.#paged)
    )
    // Joined after its history and before any other provider read, so a turn
    // another browser starts meanwhile reaches it, prompt first.
    this.joinChannel(
      showsPrompt(this.#channels.current(this.#scope), {}, replay.history),
      true
    )
    const followed = await this.#followPage(replay)
    // A turn that ended before it was followed took the rows the page left to
    // its replay, and history now holds them.
    if ("cut" in replay && followed !== replay.cut) return this.#replay()
    return replay.history
  }

  /**
   * Rebuilds this member's view in place, as a from-start resume builds it:
   * what a view that fell behind, lost its place, or was shown a prompt
   * without its reply is owed. One that cannot be rebuilt pauses.
   */
  async #rebuild() {
    if (this.detached || this.pending) return
    try {
      await this.#resume({}, true)
    } catch (cause) {
      this.#send({ type: "fell-behind" })
      await this.report(cause)
    }
  }

  /**
   * Lands this member's join once the response to it has been written. From
   * then on the member is given its Session's readings, each the last value
   * at once and then each change, so none overtakes that response.
   */
  joined() {
    this.afterResponse(async () => {
      if (!this.#owner.actor.getSnapshot().matches("joining")) return
      this.#send({ type: "joined" })
      // Taken before the resume's hold is let go, so the Session stays held.
      const held = this.#cells
      this.#cells = this.#subscribeCells()
      held?.()
    })
  }

  /**
   * Runs work once the response for the current request has been written. The
   * caller must have settled every await its response needs before calling
   * this: the task fires on the next turn of the loop, so anything still
   * pending in the handler lets these notifications reach the client before
   * the response does.
   */
  afterResponse(task: () => Promise<void>) {
    setTimeout(() => {
      task().catch((cause: unknown) => this.report(cause))
    }, 0)
  }

  /**
   * Shows this member one older page of its Session. A page resumes
   * nothing: the view keeps its channel, follow, and reports, and learns
   * only where the next page starts. A turn longer than the newest page
   * leaves its first rows on older pages too, and the live turn's replay owns
   * those, so the page drops them as the newest page does.
   */
  showOlderPage(
    page: SessionHistoryResponse,
    older: { cursor: string; offset: number }
  ) {
    const live = this.#coordinator.replayStart(this.#scope)?.ids
    return this.#showHistory(live ? withoutLiveRows(page, live) : page, older)
  }

  /** Shows this member a history page at the cursor it has reached. */
  #showHistory(
    page: SessionHistoryResponse,
    older?: { cursor: string; offset: number }
  ) {
    return this.emit({
      kind: "history",
      page,
      sequence: this.#sequence,
      ...(older ? { older } : {}),
    })
  }

  /**
   * The page a from-start resume replays. The stream the member held stops
   * before the page is read. A running turn the coordinator replays from its
   * start is shown by that replay: the page drops each row the journal
   * buffered, joined by id, so the turn shows once. Any other turn
   * keeps the page, whose history stands for the start the journal no longer
   * holds, and its live events follow it from as far as it had `streamed`. A
   * turn that starts during the read waits for the page and is replayed the
   * same way.
   */
  async #replayPage(read: () => Promise<SessionHistoryResponse>) {
    const scope = this.#scope
    const liveTurn = () => {
      const { state, turnId } = this.#coordinator.snapshot(scope)
      return state === "idle" ? undefined : turnId
    }
    const before = liveTurn()
    const started = () => {
      const after = liveTurn()
      return after !== undefined && after !== before
    }
    const restarted = this.#coordinator.replayStart(scope)
    // The channel's prompts and streams wait while the view is rebuilt, so
    // none lands above the page; `joinChannel` or a recovery ends the hold.
    this.#rebuilding = true
    // Any live stream waits for the page, so none of it lands inside it.
    const stopped = restarted !== undefined || before !== undefined
    if (stopped) await this.#restartStream()
    let history: SessionHistoryResponse
    try {
      history = await read()
    } catch (cause) {
      // A turn that started during the read was held back, so it streams the
      // same way a stopped one does once its reload failed.
      await this.#recoverReplay(stopped || started())
      throw cause
    }
    const held = started()
    // Read after the page, so a row the journal buffered during the read is
    // dropped from it too.
    const shown =
      restarted || held ? this.#coordinator.replayStart(scope) : undefined
    const replay = { held, stopped }
    if (!shown)
      return {
        ...replay,
        history,
        ...(restarted ? {} : { streamed: this.#coordinator.streamed(scope) }),
      }
    return {
      ...replay,
      history: withoutLiveRows(history, shown.ids),
      cut: shown.turnId,
    }
  }

  /**
   * Ends the hold of a from-start replay that failed before the view was
   * rebuilt. A stream the replay stopped, or a turn the hold kept back, still
   * `needsFollow`: the view streams it from its prompt.
   */
  async #recoverReplay(needsFollow: boolean) {
    this.#rebuilding = false
    if (needsFollow) {
      this.joinChannel(false, true)
      await this.#follow(true).catch((err: unknown) =>
        this.#options.logger.warn({ err }, "membership.follow.failed")
      )
    }
  }

  /**
   * Rebuilds the view from the page a from-start resume replays. A page that
   * cannot reach the view recovers as a failed read does, so the channel's
   * turns still reach it.
   */
  async #replayHistory(read: () => Promise<SessionHistoryResponse>) {
    const replay = await this.#replayPage(read)
    try {
      // Counted on the authoritative page, before a member's stack rebuilds
      // its messages: a guest's projection keeps no user-turn metadata.
      const corrections = persistedCorrections(replay.history)
      await this.#showHistory(replay.history)
      return { ...replay, corrections }
    } catch (cause) {
      await this.#recoverReplay(replay.stopped || replay.held)
      throw cause
    }
  }

  /**
   * Follows the live turn beside a page from as far as it had `streamed` when
   * the page was read, or else as the page left it to the journal. A journal
   * that pruned that point since streams its live events alone, and a turn
   * that ended with it adds nothing to the page. Returns the turnId it streams.
   */
  async #followPage(replay: {
    corrections: number
    streamed?: { turnId: string; after: number }
  }) {
    const { corrections, streamed } = replay
    const { turnId } = this.#coordinator.snapshot(this.#scope)
    if (streamed && streamed.turnId === turnId) {
      const followed = await this.#follow(
        true,
        streamed.after,
        corrections
      ).catch((cause: unknown) => {
        if (!(cause instanceof ReplayCursorLostError)) throw cause
        return null
      })
      if (followed !== null) return followed
    }
    return this.#follow(true, undefined, corrections)
  }

  /**
   * Follows the live turn from `position`, returning whether the view holds
   * the Session from there: a cursor for another turn, one the journal no
   * longer holds, or none beside a turn the journal cannot replay whole
   * leaves the view to be rebuilt from history.
   */
  async #followPositioned(position: ResumePosition) {
    this.joinChannel(showsPrompt(this.#channels.current(this.#scope), position))
    const { state, turnId } = this.#coordinator.snapshot(this.#scope)
    if (position.turnId !== undefined && position.turnId !== turnId)
      return false
    const { after } = position
    if (after === undefined) {
      if (state === "idle" || turnId === undefined) return true
      if (!this.#coordinator.replayStart(this.#scope)) return false
      await this.#follow(true)
      return true
    }
    // A settled turn streams nothing more: the view holds it once its cursor
    // reached the turn's last event.
    if (state === "idle") return this.#coordinator.holds(this.#scope, after)
    return this.#follow(true, after).then(
      () => true,
      (cause: unknown) => {
        // Only a lost cursor rebuilds; a Session gone or unavailable answers so.
        if (!(cause instanceof ReplayCursorLostError)) throw cause
        return false
      }
    )
  }

  /**
   * Drops the stream this member is reading, so its next follow replays the
   * turn from the start to a view about to be rebuilt from history. The turn
   * stays followed, so the channel does not subscribe this member meanwhile.
   */
  async #restartStream() {
    await this.#exclusive(async () => {
      const subscription = this.#subscription
      if (!subscription) return
      this.#subscription = undefined
      this.#dropped.add(subscription)
      subscription.close()
    })
  }

  /**
   * Admits one user turn and subscribes to the segment it starts, settling
   * once the coordinator admitted or refused it and the channel was shown
   * the turn. This member is shown its prompt and then the turn once the
   * answer is written. A turn another member won is followed instead; a
   * repeat of the turn this member follows shows it nothing again, and one of
   * a turn the channel was shown, which reached it as it joined, only the
   * turn. `echo` reads the prompt as members are shown it, once admitted.
   */
  async startTurn(
    input: ClientSend,
    echo: () => readonly PromptPart[],
    options: StartOptions = {}
  ): Promise<CommandResults["send"]> {
    // Joined before admission, so a turn that wins the race still reaches it.
    this.joinChannel()
    const ids = clientTurnIds(
      this.#member.principal.id,
      this.#scope.sessionId,
      input.clientId
    )
    // Entered from the admission to the showing, so no follow subscribes this
    // member to the turn first. A first admission enters once its prompt is
    // prepared, so a slow one keeps no other turn from reaching this member.
    let entered: Promise<() => void> | undefined
    const enter = () => (entered ??= this.#enter())
    let subscription
    try {
      subscription = await this.#coordinator.start(
        this.#scope,
        {
          ...input,
          prepare: async () => {
            const prepared = await input.prepare()
            await enter()
            return prepared
          },
        },
        this.#access(),
        options
      )
    } catch (cause) {
      entered
        ?.then((release) => release())
        .catch((err: unknown) =>
          this.#options.logger.error({ err }, "membership.release.failed")
        )
      // A Session the start found gone is over: nothing asks after it again.
      if (this.endIfGone(cause)) throw cause
      // No turn started, so no turn end asks the runtime for one it started
      // meanwhile, which may be what refused this one.
      this.#channels
        .recheck(this.#scope)
        .catch((err: unknown) =>
          this.#options.logger.error({ err }, "channel.adopt.failed")
        )
      if (cause instanceof ServerTurnConflictError)
        this.afterResponse(() => this.catchUp())
      // A start the provider may have taken, or a turn that ended before its
      // prompt was stored, is shown to every member as the coordinator holds it.
      if (
        cause instanceof ServerTurnUncertainError ||
        cause instanceof ServerTurnEndedError
      )
        this.afterResponse(() => this.#channels.sync(this.#scope))
      throw cause
    }
    const release = await enter()
    // The prompt goes by the id its provider stored it under.
    const messageId = subscription.messageId ?? ids.messageId
    let turn: ChannelTurn
    try {
      if (subscription.turnId === this.#followedTurn) {
        subscription.close()
        return { messageId }
      }
      const { turnId } = subscription
      const content = echo()
      const announced = this.#channels.current(this.#scope)?.turnId === turnId
      const answered = new Promise<void>((resolve) => {
        this.afterResponse(async () => resolve())
      })
      this.#consume(
        subscription,
        0,
        announced
          ? answered
          : answered.then(() =>
              this.emit({ kind: "prompt", messageId, content, own: true })
            )
      )
      if (announced) return { messageId }
      turn = { turnId, messageId, content, at: this.#options.clock.now() }
    } finally {
      release()
    }
    // A turn that started is answered as started, whatever showing it met.
    await this.announce(turn).catch((cause: unknown) => this.report(cause))
    return { messageId }
  }

  /**
   * Joins this member to the Session's channel. `hasPrompt` says the view
   * holds the live turn's prompt; a `replayed` view was just rebuilt from
   * history, so a member already joined rejoins from what it holds.
   */
  joinChannel(hasPrompt = false, replayed = false) {
    this.#rebuilding = false
    if (this.detached) return
    if (!this.#partChannel) {
      const part = this.#channels.add(this.#scope, this.#delivery, {
        hasPrompt,
      })
      // A request the Session resolves, through another member's answer or a
      // Stop, is withdrawn here so this member stops offering it.
      const unsubscribe = this.#coordinator.subscribeScope(
        this.#scope,
        (event) => {
          if (event.kind !== "attention-resolved") return
          this.#withdraw(event.requestId)
          this.#followContinued(event.turnId)
        }
      )
      this.#partChannel = () => {
        part()
        unsubscribe()
      }
    } else if (replayed)
      this.#channels.rejoin(this.#scope, this.#delivery, { hasPrompt })
  }

  /**
   * Shows the channel a turn this member admitted, then brings every member in.
   */
  async announce(turn: ChannelTurn) {
    await this.#channels.broadcastTurn(this.#scope, turn, this.#delivery)
    await this.#channels.sync(this.#scope)
  }

  /** Brings this member alone into whatever turn the channel is running. */
  catchUp() {
    return this.#channels.catchUp(this.#scope, this.#delivery)
  }

  /** Requests Stop, reporting an unsettled provider as `stopping`. */
  async cancel() {
    const status = await this.#coordinator.stop(this.#scope)
    if (status !== "stopping") return
    this.#stopRequested = true
    await this.reportExecution()
  }

  /**
   * Reports the Session's execution outside a turn stream: what a resume or
   * an acknowledged Stop owes the member.
   */
  reportExecution() {
    const { state, turnId, awaitingStop, startedAt } =
      this.#coordinator.snapshot(this.#scope)
    return this.emit({
      kind: "execution",
      state,
      ...(turnId === undefined ? {} : { turnId }),
      ...(awaitingStop ? { awaitingStop } : {}),
      ...(startedAt === undefined ? {} : { startedAt }),
      sequence: this.#sequence,
    })
  }

  /**
   * Subscribes this member to its Session's readings, which its stack shows it
   * or hides. The coordinator's reporter re-reads a value that is unreadable
   * right after joining, usually the provider's agent still being built, and
   * leaves the last reading standing if it never becomes readable. The
   * execution is never restated here: the resume stated it, and each later
   * move reaches the member on its turn's stream, which a reading would run
   * ahead of.
   */
  #subscribeCells() {
    const { coordinator, membershipId } = this.#options
    const { agentId, sessionId } = this.#addressed
    const subscribeCapabilities = () =>
      coordinator.subscribeCapabilities(
        { agentId, sessionId },
        membershipId,
        (capabilities) => this.#deliver({ kind: "commands", capabilities })
      )
    // A fresh invitation has no Session to read, only what it can do there.
    if (this.pending) return subscribeCapabilities()
    const readings = coordinator.subscribeReadings(this.#scope, membershipId, {
      execution: () => this.#followInterrupted(),
      usage: (usage) => this.#deliver({ kind: "usage", usage }),
      model: (models) => this.#deliver({ kind: "model", models }),
      gone: (cause) => this.#end(cause),
    })
    const capabilities = subscribeCapabilities()
    const row = this.#options.subscribeRow((row) => {
      this.#deliver({ kind: "session-info", row }).catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.row.failed")
      )
    })
    return () => {
      readings()
      capabilities()
      row()
    }
  }

  /**
   * Follows the turn an interrupt cut this member's stream of again, from
   * where the member stopped, once the coordinator settled it: every member
   * keeps following a turn whose native link dropped, and none has to redial.
   * A turn a reconcile confirmed running streams on; one that ended meanwhile
   * replays how it ended from its journal. Asked as the stream ends and at
   * each move of the Session's execution, so a settle that lands first is not
   * missed.
   */
  async #followInterrupted() {
    const turnId = this.#interrupted
    if (turnId === undefined) return
    const current = this.#coordinator.snapshot(this.#scope)
    // Still reconciling: the move that settles it asks again.
    if (current.state === "uncertain") return
    this.#interrupted = undefined
    if (current.turnId !== turnId) return
    await this.#follow(true, this.#sequence, 0, turnId).catch(
      (cause: unknown) =>
        // A cursor the journal no longer holds leaves history the only way on.
        cause instanceof ReplayCursorLostError
          ? this.#rebuild()
          : this.report(cause)
    )
  }

  #releaseCells() {
    this.#cells?.()
    this.#cells = undefined
  }

  /** Moves this membership, which nothing moves once it detached. */
  #send(signal: MembershipSignal) {
    if (!this.detached) this.#owner.actor.send(signal)
  }

  /** Asks again the requests a recovered wait is still holding. */
  reissuePending() {
    for (const request of this.#coordinator.snapshot(this.#scope).requests)
      this.#offer(request)
  }

  /**
   * Reports a failure that has no request to answer. One the member cannot
   * be shown is logged, so a report never fails in turn.
   */
  async report(cause: unknown) {
    if (this.endIfGone(cause)) return
    await this.emit({ kind: "error", cause }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.report.failed")
    )
  }

  /**
   * Ends this membership when `cause` finds its Session gone. The coordinator
   * tells each member whose readings it holds and drops the Session; this
   * member, whose readings a join may not hold yet, is told as well. Returns
   * whether the Session was gone.
   */
  endIfGone(cause: unknown) {
    if (this.pending || !this.#coordinator.endIfGone(this.#scope, cause))
      return false
    if (!this.detached) this.#end(cause)
    return true
  }

  /** Tells this member its Session is gone, and parts. */
  #end(cause: unknown) {
    this.emit({ kind: "error", cause }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.gone.failed")
    )
    this.part()
  }

  /** Steers the turn this member follows, which a later turn has not replaced. */
  steer(requestId: string, text: string) {
    const expectedTurnId = this.#followedTurn
    if (expectedTurnId === undefined) throw new ServerTurnConflictError()
    return this.#coordinator.steer(this.#scope, {
      requestId,
      expectedTurnId,
      text,
    })
  }

  /**
   * The open request this member answers. One settled, or never handed to
   * this member, is stale.
   */
  request(requestId: string) {
    const request = this.#delivered.has(requestId)
      ? this.#openRequest(requestId)
      : undefined
    if (!request) throw new ServerRequestStaleError()
    return request
  }

  /**
   * Gives the Session this member's answer to one request. A question's
   * `answers` reach the member before the turn continues, so the call that
   * asked it stops reading as unanswered while the next segment streams. The
   * answer that leaves nothing open continues the turn, and every member
   * follows it.
   */
  async answer(
    request: PendingRequest,
    reply: RequestReply,
    answers?: string[][]
  ) {
    if (answers)
      await this.emit({ kind: "question-answered", request, answers })
    await this.#settle(reply)
  }

  /** Detaches this member, first withdrawing each request it was offered. */
  part() {
    for (const requestId of [...this.#offered]) this.#withdraw(requestId)
    this.#send({ type: "part" })
  }

  /** Gives the Session one reply of this member's. */
  async #settle(reply: RequestReply) {
    this.#options.logger.info(
      { requestId: reply.requestId, status: reply.status },
      "membership.request.answered"
    )
    // Before the answer resolves this request, so the member answering it
    // is not withdrawn its own request, and a second decline finds none.
    this.#offered.delete(reply.requestId)
    this.#delivered.delete(reply.requestId)
    const continued = await this.#coordinator.answer(this.#scope, reply)
    if (!continued) return
    this.#channels.continueTurn(this.#scope, continued.from, continued.turnId)
    await this.#channels.sync(this.#scope)
  }

  /**
   * Follows a wait the Session continued with no answer, as a Stop or the
   * runtime itself ends one: the same prompt runs on under a fresh turnId.
   */
  #followContinued(from: string) {
    const { state, turnId } = this.#coordinator.snapshot(this.#scope)
    if (state !== "running" || turnId === undefined || turnId === from) return
    this.#channels.continueTurn(this.#scope, from, turnId)
    this.catchUp().catch((cause: unknown) => this.report(cause))
  }

  /**
   * Declines one request as the member's stack decided, which alone knows
   * which requests are its to decline. Only a request this member was offered
   * and the Session still holds, while its credential holds; any other
   * decline, a second one from another tab included, is dropped silently.
   */
  async #decline(requestId: string) {
    if (
      this.detached ||
      !this.#offered.has(requestId) ||
      !this.#member.connection.live()
    )
      return
    const request = this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
    if (!request) return
    try {
      await this.#settle(declineReply(request))
    } catch (cause) {
      if (!(cause instanceof ServerRequestStaleError)) await this.report(cause)
    }
  }

  /**
   * Subscribes to the live turn unless this member already carries it. A
   * resume asks whether its current subscription does, so it can re-follow a
   * turn whose stream it lost; the channel asks whether any subscription
   * ever did, so a member is never streamed one turn twice. `ended` names a
   * turn followed even once it ended, whose end the member is still owed.
   * Without a cursor `after`, a turn the journal holds from its first event
   * replays whole, and any other streams its live events alone; one that has
   * none left to stream is stated instead. Returns the turnId it streams, or
   * `undefined` when no turn is live.
   */
  #follow(
    refollow: boolean,
    after?: number,
    replayedCorrections = 0,
    ended?: string
  ) {
    return this.#exclusive(async (): Promise<string | undefined> => {
      if (this.detached) return undefined
      const { state, turnId } = this.#coordinator.snapshot(this.#scope)
      if (turnId === undefined || (state === "idle" && turnId !== ended))
        return undefined
      const carried = refollow ? this.#subscription?.turnId : this.#followedTurn
      if (carried === turnId) return turnId
      const cursor = after ?? this.#startCursor(refollow)
      let subscription
      try {
        subscription = await this.#coordinator.recover(
          this.#scope,
          {
            sessionId: this.#scope.sessionId,
            turnId,
            ...(cursor === undefined ? {} : { after: cursor }),
          },
          this.#access()
        )
      } catch (cause) {
        if (after !== undefined || !(cause instanceof ReplayCursorLostError))
          throw cause
        await this.#reportView()
        return undefined
      }
      this.#consume(subscription, replayedCorrections)
      return turnId
    })
  }

  /**
   * Where a follow with no cursor reads the live turn from: its first event
   * when the journal holds it, else its live events. A member that followed
   * the turn a wait's end continued holds that journal as far as it went.
   */
  #startCursor(refollow: boolean) {
    const start = this.#coordinator.replayStart(this.#scope)
    if (!start) return 0
    const { continues } = start
    return !refollow && continues?.turnId === this.#followedTurn
      ? continues?.after
      : undefined
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

  /** Enters one subscribing task that holds until the returned release. */
  #enter() {
    return new Promise<() => void>((entered) => {
      this.#exclusive(
        () => new Promise<void>((release) => entered(() => release()))
      ).catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.enter.failed")
      )
    })
  }

  /**
   * Shows one reading the coordinator reported. Nothing awaits a deferred
   * one, so this reports its own failure rather than rejecting into nowhere.
   */
  #deliver(event: SessionEvent) {
    return this.emit(event).catch((cause: unknown) => this.report(cause))
  }

  get #coordinator() {
    return this.#options.coordinator
  }

  /**
   * Whether Stop was acknowledged for the stream being read. The coordinator
   * clears its own `stopping` state as soon as the provider settles, which is
   * the same event the member has to be shown as cancelled, so the
   * acknowledgement is latched until the next segment.
   */
  get #stopping() {
    return (
      this.#stopRequested ||
      this.#coordinator.snapshot(this.#scope).state === "stopping"
    )
  }

  /** How the coordinator sees one subscription of this member. */
  #access(): CoordinatorAccess {
    return {
      membershipId: this.#options.membershipId,
      principalId: this.#member.principal.id,
    }
  }

  /** Follows one subscription, whose stream waits for `shown` when given. */
  #consume(
    subscription: CoordinatedTurnSubscription,
    replayedCorrections: number,
    shown?: Promise<void>
  ) {
    // A member that detached while its subscription was admitted keeps none.
    if (this.detached) {
      subscription.close()
      return
    }
    this.#subscription = subscription
    this.#interrupted = undefined
    // A restarted stream is the same segment, whose Stop stays acknowledged.
    if (subscription.turnId !== this.#followedTurn) this.#stopRequested = false
    this.#followedTurn = subscription.turnId
    this.#send({ type: "followed" })
    let caughtUp = () => {}
    this.#caughtUp = new Promise<void>((resolve) => (caughtUp = resolve))
    const done = this.#pump(
      subscription,
      this.#owner.generation,
      replayedCorrections,
      { restating: this.#restating, caughtUp },
      shown
    )
      .catch((err: unknown) =>
        this.#options.logger.error({ err }, "membership.stream.failed")
      )
      .finally(caughtUp)
    this.#streamed = { turnId: subscription.turnId, done }
  }

  /**
   * Shows one subscription's segment to the member, event by event, settling
   * `caughtUp` once it showed what the journal buffered. A view `restating`
   * is shown that buffer without its states or requests, which it is told as
   * they stand once caught up. The stream is the membership's `generation`
   * until a later follow replaces it.
   */
  async #pump(
    subscription: CoordinatedTurnSubscription,
    generation: number,
    replayedCorrections: number,
    view: { restating: boolean; caughtUp: () => void },
    shown?: Promise<void>
  ) {
    let buffered = subscription.replayed ?? 0
    if (buffered === 0) view.caughtUp()
    const dropped = this.#dropped
    const stream: TurnStream = {
      turnId: subscription.turnId,
      replayedCorrections,
      get dropped() {
        return dropped.has(subscription)
      },
    }
    let overflow: FanoutOverflowError | undefined
    let interrupted = false
    try {
      await shown
      for await (const { sequence, event } of subscription.events) {
        if (stream.dropped) break
        this.#sequence = sequence
        interrupted = isRedialableFailure(event)
        const replayed = view.restating && buffered > 0
        await this.emit({
          kind: "turn",
          stream,
          sequence,
          event,
          stopping: this.#stopping,
          ...(replayed ? { replayed: true as const } : {}),
        })
        if (!replayed) {
          this.#stated = statedBy(event) ?? this.#stated
          if (
            event.kind === TurnEventKind.TurnRequiresAction &&
            !stream.dropped
          )
            for (const request of event.requests) this.#offer(request)
        }
        if (--buffered === 0) view.caughtUp()
      }
    } catch (cause) {
      if (cause instanceof FanoutOverflowError) overflow = cause
      else await this.report(cause)
    } finally {
      if (!this.#owner.stale(generation)) this.#subscription = undefined
    }
    // The stream that replaced a dropped one settles the segment instead.
    if (stream.dropped) return
    if (overflow) return this.#fellBehind(subscription.turnId, overflow)
    // An interrupt ends the stream, not the turn: its reconcile decides that.
    if (interrupted && !this.#owner.stale(generation)) {
      this.#interrupted = subscription.turnId
      await this.#followInterrupted()
      return
    }
    // A stream that could not carry the wait it ended on, such as the reset of
    // a discovered turn no journal replays, still leaves its requests open.
    if (this.#coordinator.state(this.#scope) === "waiting-for-input")
      this.reissuePending()
  }

  /**
   * Rebuilds the view of a member whose stream was dropped for falling behind
   * its bounds, once per turn: one that falls behind the same turn again is
   * paused until it resumes.
   *
   * The turn itself is unharmed and may still be going, so this is not a turn
   * failure and the segment did not settle: reporting either would leave the
   * member believing a turn it only saw part of had ended. The member owes
   * itself the Session from history, then the turn's live events and state.
   */
  async #fellBehind(turnId: string, overflow: FanoutOverflowError) {
    this.#options.logger.error(
      {
        membershipId: this.#options.membershipId,
        turnId,
        events: overflow.events,
        bytes: overflow.bytes,
      },
      "membership.fell-behind"
    )
    if (this.#rebuiltTurn === turnId) {
      this.#send({ type: "fell-behind" })
      return
    }
    this.#rebuiltTurn = turnId
    await this.#rebuild()
  }

  /**
   * Asks this member one request. A request already asked here, or one the
   * Session no longer waits on, is not asked again, however a replay or a
   * reissue reaches it.
   */
  #offer(request: PendingRequest) {
    if (this.#offered.has(request.requestId)) return
    const open = this.#coordinator.snapshot(this.#scope)
    if (!open.requests.some(({ requestId }) => requestId === request.requestId))
      return
    this.#offered.add(request.requestId)
    this.emit({
      kind: "request-asked",
      request,
      ...(open.startedBy === undefined ? {} : { startedBy: open.startedBy }),
    }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.request.offer.failed")
    )
  }

  /**
   * Withdraws a request the Session resolved from this member, which is told
   * only of a request its connection was handed.
   */
  #withdraw(requestId: string) {
    this.#offered.delete(requestId)
    if (!this.#delivered.delete(requestId)) return
    this.emit({ kind: "request-withdrawn", requestId }).catch((err: unknown) =>
      this.#options.logger.warn({ err }, "membership.request.withdraw.failed")
    )
  }

  #openRequest(requestId: string) {
    return this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
  }
}

export type { Membership }
