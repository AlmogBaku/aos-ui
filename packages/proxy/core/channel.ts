import {
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
import { JOIN_DEADLINE_MS, PAUSED_DEADLINE_MS } from "./limits"
import {
  beforeLiveTurn,
  lastPromptIndex,
  persistedCorrections,
} from "./replay-page"
import {
  ReplyStatus,
  TurnEventKind,
  type ExecutionEvent,
  type PendingRequest,
  type RequestReply,
} from "./events"
import {
  CommandRefusedError,
  hasSession,
  promptText,
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
  /** Tell the member's browser to reload the Session from history. */
  invalidate(): void | Promise<void>
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

/** The bounded history one from-start read or one older page reads. */
const HISTORY_REPLAY_LIMIT = 500

/** How far back history pages reach; older history reads as truncated. */
export const HISTORY_MAX_OFFSET = 100_000

/** Whether an older page exists within the reach, past the one just read. */
export function hasOlderPage(page: SessionHistoryResponse) {
  return (
    !page.truncated &&
    page.nextOffset < page.total &&
    page.nextOffset > page.offset &&
    page.nextOffset < HISTORY_MAX_OFFSET
  )
}

/**
 * Where a page shows the live turn's prompt, or `-1`. A correction is a steer
 * inside the turn, so the prompt is the last user message before them.
 */
function promptIndex(turn: ChannelTurn, history: SessionHistoryResponse) {
  const index = lastPromptIndex(history)
  const prompt = history.messages[index]
  if (!prompt || !Array.isArray(prompt.content)) return -1
  const text = prompt.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
  // A prompt without text matches any other, so it never names the live one.
  const expected = promptText(turn.content).trim()
  return expected && text.trim() === expected ? index : -1
}

/**
 * Whether a resume already shows the live turn's prompt: its cursor sits inside
 * that turn, or the page it replayed ends on that prompt.
 */
function showsPrompt(
  turn: ChannelTurn | undefined,
  position: ResumePosition,
  history?: SessionHistoryResponse
) {
  if (!turn) return false
  if (position.turnId === turn.turnId) return true
  return history !== undefined && promptIndex(turn, history) >= 0
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
  backstopMs = DEFAULT_BACKSTOP_MS,
}: {
  /** Coordinator view of a Session: state and the live segment's turnId. */
  snapshot: (scope: ChannelScope) => { state: string; turnId?: string }
  /** Absent when the runtime cannot report the turns it starts. */
  adoption?: ChannelAdoption
  /** The monotonic clock a turn's admission and the backstop read. */
  clock: Clock
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
    await attempt(member, () => member.invalidate())
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
    else void send(member, delivery, turn)
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

  async function adoptOnce(channel: Channel) {
    const joined = adopter(channel)
    if (!adoption || !joined) return
    const [member, { scope }] = joined
    const before = snapshot(scope).turnId
    try {
      await adoption.discover(scope)
    } catch (cause) {
      // A proxy turn still starting refuses it; that turn's end asks again.
      if (!(cause instanceof ServerTurnConflictError)) member.report(cause)
      return
    }
    const { state, turnId } = snapshot(scope)
    if (state === "idle" || turnId === undefined || turnId === before) return
    channel.adopted = turnId
    await syncChannel(scope, channel)
  }

  /**
   * Every turn's end asks the runtime once more, which finds a turn it started
   * while the proxy's own ran. An adopted turn's end reloads every member,
   * since none of them was shown its prompt.
   */
  function onExecution(channel: Channel, event: ExecutionEvent) {
    if (event.kind !== "turn-finished" && event.kind !== "turn-failed") return
    if (event.turnId === channel.adopted) {
      channel.adopted = undefined
      for (const member of channel.memberships.keys())
        void attempt(member, () => member.invalidate())
    }
    void adopt(channel)
  }

  function subscribe(scope: SessionScope, channel: Channel) {
    if (!adoption) return
    const unsubscribeExecutions = adoption.subscribeExecutions(scope, (event) =>
      onExecution(channel, event)
    )
    const unsubscribeTurns = adoption.subscribeTurns(scope, {
      onTurn: () => void adopt(channel),
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
        channel = { memberships: new Map() }
        channels.set(key, channel)
      }
      const joined = channel
      const remove = () => {
        joined.memberships.delete(member)
        if (joined.memberships.size === 0 && channels.get(key) === joined) {
          channels.delete(key)
          joined.unsubscribe?.()
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
  /**
   * The logger the membership machine is set up on; each membership writes
   * on its own.
   */
  logger: Logger
  clock?: Clock
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
function membershipMachine(logger: Logger, clock: Clock) {
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
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

export function createChannels(options: CreateChannelsOptions) {
  const { coordinator, runtime, logger } = options
  const clock = options.clock ?? defaultClock
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
      HISTORY_REPLAY_LIMIT,
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
    while (hasOlderPage(page)) {
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
        { ...membership, coordinator, clock },
        owner
      )
    },

    /**
     * Resumes one member's view of its Session, rebuilt from its history
     * first when `replay` asks: the newest page alone for a member that
     * `paged` older history itself. The join lands once the answer is
     * written, and the Session's execution, readings and row reach the member
     * as events after it. A Session waiting on input asks its runtime whether
     * the wait still stands, which the answer does not wait for. A resume the
     * journal serves asks the provider nothing first: the reads its join
     * starts, and the turn subscription, find a Session gone meanwhile and end
     * it, which spares every rejoin a round trip.
     */
    async resume(
      membership: Membership,
      position: ResumePosition,
      replay?: { paged: boolean }
    ): Promise<CommandResults["resume"]> {
      const resumed = await membership.resume(
        position,
        replay && (() => readReplay(membership.scope, replay.paged))
      )
      if (membership.pending) {
        membership.joined()
        return resumed
      }
      const { scope } = membership
      const { state, turnId } = coordinator.snapshot(scope)
      membership.joined({ turnId })
      if (state === "waiting-for-input") void channels.recheck(scope)
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
  /** The turn this member last asked its client to rebuild the view for. */
  #reloadedTurn: string | undefined
  /**
   * Set while a from-start replay rebuilds the view: the channel waits for it.
   */
  #rebuilding = false
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
      invalidate: () => this.#invalidate(),
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
    if (declines.size > 0)
      void sent
        .catch(() => undefined)
        .then(() => Promise.all([...declines].map((id) => this.#decline(id))))
    return sent
  }

  /**
   * Builds this member's view on resume. `read` gives the page a from-start
   * resume replays, which rebuilds the view first; without it the view keeps
   * what it holds up to `position`. Either way the member then joins the
   * channel and follows the live turn. Returns the page it replayed, and
   * `resync` when the view must rebuild itself. A join that has not landed
   * by its deadline detaches the membership, and the resume rejects then; one
   * that finds its Session gone ends it.
   */
  resume(
    position: ResumePosition,
    read?: () => Promise<SessionHistoryResponse>
  ) {
    this.#releaseCells()
    this.#send({ type: "join" })
    return unlessAborted(this.#resume(position, read), this.#detaching).catch(
      (cause: unknown) => {
        this.endIfGone(cause)
        throw cause
      }
    )
  }

  async #resume(
    position: ResumePosition,
    read?: () => Promise<SessionHistoryResponse>
  ): Promise<{ history?: SessionHistoryResponse; resync?: true }> {
    // A fresh invitation has no history to replay and no turn to follow.
    if (this.pending) return {}
    // A correction the provider persisted the moment it accepted the steer is
    // already in this page, so the journal's acknowledgement of it is dropped.
    const replay = read ? await this.#replayHistory(read) : undefined
    const history = replay?.history
    // Joined after its history and before any other provider read, so a turn
    // another browser starts meanwhile reaches it, prompt first.
    this.joinChannel(
      showsPrompt(this.#channels.current(this.#scope), position, history),
      history !== undefined
    )
    // A view rebuilt from the whole page holds the turn as far as it had
    // streamed when the page was read, so its stream continues from there on.
    if (replay && replay.restarted === undefined) {
      await this.#followPage(replay)
      return { history: replay.history }
    }
    // A cursor for another turn cannot position this one, and a cursor the
    // journal no longer holds cannot be served: both need a full reload. A view
    // rebuilt from a page cut where the turn began owns nothing of it, so it
    // follows without a cursor.
    const resync = await this.#followPositioned(replay ? {} : position, replay)
    return { ...(history === undefined ? {} : { history }), ...resync }
  }

  /**
   * Lands this member's join once the response to it has been written. From
   * then on the member is given its Session's readings, each the last value
   * at once and then each change, so none overtakes that response. A resume
   * that `answered` with the execution of one turn has it restated.
   */
  joined(answered?: { turnId: string | undefined }) {
    this.afterResponse(async () => {
      if (!this.#owner.actor.getSnapshot().matches("joining")) return
      this.#send({ type: "joined" })
      this.#cells = this.#subscribeCells(answered)
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
      void task().catch((cause: unknown) => this.report(cause))
    }, 0)
  }

  /**
   * Shows this member one older page of its Session. A page resumes
   * nothing: the view keeps its channel, follow, and reports, and learns
   * only where the next page starts. Beside a live turn the view streams from
   * its start, a turn longer than the newest page leaves its first rows on
   * older pages too, so a page holding a row stored after the turn began is
   * cut as the newest page is. A page wholly before the turn is kept, so the
   * clock skew the cut allows never drops the end of the turn before it.
   */
  showOlderPage(
    page: SessionHistoryResponse,
    older: { cursor: string; offset: number }
  ) {
    const at = this.#coordinator.replayStart(this.#scope)?.at
    const reached =
      at !== undefined &&
      page.messages.some(
        (message) =>
          message.role !== "activity" && Date.parse(message.createdAt) >= at
      )
    return this.#showHistory(
      reached ? (beforeLiveTurn(page, at) ?? page) : page,
      older
    )
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
   * The page a from-start resume replays. A running turn the coordinator
   * replays from its start is shown by that replay alone: the stream the
   * member held stops before the page is read, and the page is cut where the
   * turn began, so `restarted` names the turn the view then shows only while
   * its follow streams it. A page that cannot be cut there, or a turn adopted
   * without its native start, is kept whole and its follow `reset`. Any other
   * turn keeps the page, whose history stands for the start the journal no
   * longer holds, and its live events follow it. A turn that starts during the
   * read waits for the page and is replayed the same way.
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
    if (restarted) await this.#restartStream()
    let history: SessionHistoryResponse
    try {
      history = await read()
    } catch (cause) {
      // A turn that started during the read was held back, so it streams the
      // same way a restarted one does once its reload failed.
      await this.#recoverReplay(restarted?.turnId, started())
      throw cause
    }
    const held = started()
    const shown =
      restarted ?? (held ? this.#coordinator.replayStart(scope) : undefined)
    if (!shown)
      return { history, held, streamed: this.#coordinator.streamed(scope) }
    const cut =
      shown.at === undefined ? undefined : beforeLiveTurn(history, shown.at)
    return {
      history: cut ?? history,
      held,
      restarted: shown.turnId,
      reset: cut === undefined,
    }
  }

  /**
   * Ends the hold of a from-start replay that failed before the view was
   * rebuilt. The stream stopped on `restarted` is gone: the view is asked to
   * reload, and once that failed too, it streams the turn from its prompt, as
   * it does a turn the hold kept `held` back.
   */
  async #recoverReplay(restarted: string | undefined, held: boolean) {
    this.#rebuilding = false
    if (restarted ? !(await this.#reloadOnce(restarted)) : held) {
      this.joinChannel(false, true)
      await this.#follow(true).catch(() => undefined)
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
      await this.#recoverReplay(replay.restarted, replay.held)
      throw cause
    }
  }

  /**
   * Follows the live turn beside a whole page from as far as it had `streamed`
   * when the page was read. A journal that pruned that point since streams its
   * live events alone, and a turn that ended with it adds nothing to the page.
   */
  async #followPage(replay: {
    corrections: number
    streamed?: { turnId: string; after: number }
  }) {
    const { corrections, streamed } = replay
    const follow = (after: number): Promise<unknown> =>
      this.#follow(true, after, corrections).catch((cause: unknown) => {
        if (!(cause instanceof ReplayCursorLostError)) throw cause
        return after === 0 ? undefined : follow(0)
      })
    const { turnId } = this.#coordinator.snapshot(this.#scope)
    await follow(streamed && streamed.turnId === turnId ? streamed.after : 0)
  }

  /**
   * Subscribes to the live turn, reporting a cursor that cannot position it.
   * A view whose stream `restarted` on a turn shows it only while this follow
   * streams that turn; a view whose page could not be cut for it is `reset`.
   */
  async #followPositioned(
    position: ResumePosition,
    replay?: { corrections: number; restarted?: string; reset?: boolean }
  ): Promise<{ resync?: true }> {
    const positioned =
      position.turnId === undefined ||
      position.turnId === this.#coordinator.snapshot(this.#scope).turnId
    const restarted = replay?.restarted
    const followed = await this.#follow(
      true,
      replay?.reset ? "reset" : positioned ? position.after : undefined,
      replay?.corrections
    ).catch(() => null)
    if (restarted !== undefined && followed !== restarted) {
      // A view rebuilt from the start does not act on `resync`, and this one
      // lacks the rest of its turn: have it rebuild again once this response
      // lands.
      this.afterResponse(async () => {
        await this.#reloadOnce(restarted)
      })
      return { resync: true }
    }
    return positioned && followed !== null ? {} : { resync: true }
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
   * Tells the member to rebuild this Session's view from history, once per
   * turn: a rebuild that fails the same way again must not ask again. Returns
   * whether it asked.
   */
  async #reloadOnce(turnId: string) {
    if (this.#reloadedTurn === turnId) return false
    this.#reloadedTurn = turnId
    await this.#invalidate()
    return true
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
    const { messageId } = clientTurnIds(
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
      void entered?.then((release) => release())
      // No turn started, so no turn end asks the runtime for one it started
      // meanwhile, which may be what refused this one.
      void this.#channels.recheck(this.#scope)
      if (cause instanceof ServerTurnConflictError)
        this.afterResponse(() => this.catchUp())
      // A start the provider may have taken is shown to every member as the
      // coordinator settles it.
      if (cause instanceof ServerTurnUncertainError)
        this.afterResponse(() => this.#channels.sync(this.#scope))
      throw cause
    }
    const release = await enter()
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
          if (event.kind === "attention-resolved")
            this.#withdraw(event.requestId)
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
    const { state, turnId } = this.#coordinator.snapshot(this.#scope)
    return this.emit({
      kind: "execution",
      state,
      ...(turnId === undefined ? {} : { turnId }),
      sequence: this.#sequence,
    })
  }

  /**
   * Subscribes this member to its Session's readings, which its stack shows it
   * or hides. The coordinator's reporter re-reads a value that is unreadable
   * right after joining, usually the provider's agent still being built, and
   * leaves the last reading standing if it never becomes readable. The
   * execution is restated once, for the resume that `answered` with it: each
   * later move reaches the member on its turn's stream, which a reading would
   * run ahead of.
   */
  #subscribeCells(answered?: { turnId: string | undefined }) {
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
    let restating = answered
    const readings = coordinator.subscribeReadings(this.#scope, membershipId, {
      execution: async () => {
        const turn = restating
        restating = undefined
        if (turn)
          await this.#restate(turn.turnId).catch((cause: unknown) =>
            this.report(cause)
          )
      },
      usage: (usage) => this.#deliver({ kind: "usage", usage }),
      model: (models) => this.#deliver({ kind: "model", models }),
      gone: (cause) => this.#end(cause),
    })
    const capabilities = subscribeCapabilities()
    const row = this.#options.subscribeRow(
      (row) => void this.#deliver({ kind: "session-info", row })
    )
    return () => {
      readings()
      capabilities()
      row()
    }
  }

  /**
   * Restates the execution a resume answered with, unless the turn it named
   * as `turnId` was replaced since, and asks again the requests a recovered
   * wait still holds.
   */
  async #restate(turnId: string | undefined) {
    // A turn admitted since the answer was built reports itself on its own
    // stream; restating it here would run ahead of that stream.
    if (this.#coordinator.snapshot(this.#scope).turnId === turnId)
      await this.reportExecution()
    if (this.#coordinator.state(this.#scope) === "waiting-for-input")
      this.reissuePending()
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

  /** Reports a failure that has no request to answer. */
  async report(cause: unknown) {
    if (!this.endIfGone(cause)) await this.emit({ kind: "error", cause })
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
    void this.emit({ kind: "error", cause }).catch(() => undefined)
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
   * ever did, so a member is never streamed one turn twice. Returns the
   * turnId it streams, or `undefined` when no turn is live.
   */
  #follow(
    refollow: boolean,
    after?: number | "reset",
    replayedCorrections = 0
  ) {
    return this.#exclusive(async (): Promise<string | undefined> => {
      if (this.detached) return undefined
      const { state, turnId } = this.#coordinator.snapshot(this.#scope)
      if (state === "idle" || turnId === undefined) return undefined
      const carried = refollow ? this.#subscription?.turnId : this.#followedTurn
      if (carried === turnId) return turnId
      this.#consume(
        await this.#coordinator.recover(
          this.#scope,
          {
            sessionId: this.#scope.sessionId,
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

  /** Enters one subscribing task that holds until the returned release. */
  #enter() {
    return new Promise<() => void>((entered) => {
      void this.#exclusive(
        () => new Promise<void>((release) => entered(() => release()))
      )
    })
  }

  /** Asks the member to reload the Session from history. */
  async #invalidate() {
    await this.emit({ kind: "invalidated" }).catch(() => undefined)
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
    // A restarted stream is the same segment, whose Stop stays acknowledged.
    if (subscription.turnId !== this.#followedTurn) this.#stopRequested = false
    this.#followedTurn = subscription.turnId
    this.#send({ type: "followed" })
    void this.#pump(
      subscription,
      this.#owner.generation,
      replayedCorrections,
      shown
    )
  }

  /**
   * Shows one subscription's segment to the member, event by event. The
   * stream is the membership's `generation` until a later follow replaces it.
   */
  async #pump(
    subscription: CoordinatedTurnSubscription,
    generation: number,
    replayedCorrections: number,
    shown?: Promise<void>
  ) {
    const dropped = this.#dropped
    const stream: TurnStream = {
      turnId: subscription.turnId,
      replayedCorrections,
      get dropped() {
        return dropped.has(subscription)
      },
    }
    let overflow: FanoutOverflowError | undefined
    try {
      await shown
      for await (const { sequence, event } of subscription.events) {
        if (stream.dropped) break
        this.#sequence = sequence
        await this.emit({
          kind: "turn",
          stream,
          sequence,
          event,
          stopping: this.#stopping,
        })
        if (event.kind === TurnEventKind.TurnRequiresAction && !stream.dropped)
          for (const request of event.requests) this.#offer(request)
      }
    } catch (cause) {
      if (cause instanceof FanoutOverflowError) overflow = cause
      else await this.report(cause)
    } finally {
      if (!this.#owner.stale(generation)) this.#subscription = undefined
    }
    // The stream that replaced a dropped one settles the segment instead.
    if (stream.dropped) return
    if (overflow) return this.#resync(subscription.turnId, overflow)
  }

  /**
   * Tells the member that what it holds of this Session is incomplete,
   * because the stream it was reading was dropped for falling behind its
   * bounds.
   *
   * The turn itself is unharmed and may still be going, so this is not a turn
   * failure and the segment did not settle: reporting either would leave the
   * member believing a turn it only saw part of had ended. The member owes
   * itself the Session from the start, which is what invalidation asks for.
   */
  async #resync(turnId: string, overflow: FanoutOverflowError) {
    this.#options.logger.error(
      {
        membershipId: this.#options.membershipId,
        turnId,
        events: overflow.events,
        bytes: overflow.bytes,
      },
      "membership.detached"
    )
    this.#send({ type: "fell-behind" })
    await this.#invalidate()
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
    void this.emit({
      kind: "request-asked",
      request,
      ...(open.startedBy === undefined ? {} : { startedBy: open.startedBy }),
    })
  }

  /**
   * Withdraws a request the Session resolved from this member, which is told
   * only of a request its connection was handed.
   */
  #withdraw(requestId: string) {
    this.#offered.delete(requestId)
    if (!this.#delivered.delete(requestId)) return
    void this.emit({ kind: "request-withdrawn", requestId })
  }

  #openRequest(requestId: string) {
    return this.#coordinator
      .snapshot(this.#scope)
      .requests.find((pending) => pending.requestId === requestId)
  }
}

export type { Membership }
