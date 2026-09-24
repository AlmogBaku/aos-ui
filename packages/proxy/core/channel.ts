import type { SessionHistoryResponse } from "../../protocol"
import {
  PendingRequestKind,
  ReplyStatus,
  TurnEventKind,
  type ExecutionEvent,
  type PendingRequest,
  type PromptTurnInput,
  type RequestReply,
} from "./events"
import {
  runEvents,
  type Feed,
  type Member,
  type PromptPart,
  type SessionEvent,
  type TurnStream,
} from "./member"
import {
  ServerRequestStaleError,
  ServerTurnConflictError,
  type ServerAttachmentStage,
  type ServerTurnWatcher,
  type SessionScope,
} from "./runtime"
import type {
  CoordinatedTurnSubscription,
  CoordinatorAccess,
  SessionCoordinator,
} from "./session-coordinator"
import { FanoutOverflowError } from "./subscriber-fanout"

/**
 * A room is one provider Session; its members are the connections that have
 * it open. The coordinator already fans a turn's stream out to many followers,
 * so a room only carries what the stream cannot: the prompt that started the
 * turn, and a nudge to reload when a member saw a prompt but missed its reply.
 * A room with members also watches its Session, so a turn the runtime starts
 * by itself is adopted and streamed to every member like one of their own.
 */

export type RoomScope = Pick<SessionScope, "agentId" | "sessionId">

export type RoomTurn = {
  turnId: string
  messageId: string
  content: readonly PromptPart[]
  /** Epoch ms when the turn was admitted. */
  at: number
}

export type RoomMember = {
  /** Send this turn's prompt to the member as its user_message. */
  sendTurn(turn: RoomTurn): void | Promise<void>
  /** Subscribe the member to the current turn's stream. */
  follow(): Promise<"following" | "idle">
  /** The turnId the member's own subscription last carried, if any. */
  followedTurn(): string | undefined
  /** Tell the member's browser to reload the Session from history. */
  invalidate(): void | Promise<void>
  /** Record a send/follow failure for this member alone. */
  report(cause: unknown): void
}

export type Channel = ReturnType<typeof createChannel>
type Rooms = ReturnType<typeof createRooms>

type Lane = "operator" | "guest"

/** What lets a room adopt a turn the runtime started by itself. */
export type RoomAdoption = {
  watch(scope: SessionScope, watcher: ServerTurnWatcher): () => void
  /** Adopts the runtime's running turn, if any, counted under `lane`. */
  discover(scope: SessionScope, lane: Lane): Promise<unknown>
  /** The Session's execution feed. */
  observe(
    scope: RoomScope,
    listener: (event: ExecutionEvent) => void
  ): () => void
}

type Delivery = {
  /** The member's own scope and lane, which an adoption runs under. */
  scope: SessionScope
  lane: Lane
  /** The turnId whose prompt this member already holds. */
  delivered?: string
  /** Whether the room sent that prompt, rather than the member owning it. */
  fromRoom: boolean
}

type Room = {
  turn?: RoomTurn
  members: Map<RoomMember, Delivery>
  /** Ends the room's watch and its execution feed. */
  unwatch?: () => void
  /** One adoption runs at a time; a trigger meanwhile asks for one more. */
  adopting?: boolean
  again?: boolean
  /** The turn this room adopted, whose prompt no member has seen. */
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

/**
 * Keyed like the coordinator's `scopeKey`, never by `threadId`: a guest's
 * thread differs from the operator's for the same provider Session.
 */
function roomKey(scope: RoomScope) {
  return `${scope.agentId}\u0000${scope.sessionId}`
}

/** Runs one member's call so its failure reaches only that member. */
async function attempt<T>(
  member: RoomMember,
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
 * The member an adoption runs as. An operator comes first: the coordinator
 * reports the turn under this member's thread, and activity and push read it.
 */
function adopter(room: Room) {
  const members = [...room.members]
  return members.find(([, { lane }]) => lane === "operator") ?? members[0]
}

function createRooms({
  snapshot,
  adoption,
  now = Date.now,
  backstopMs = DEFAULT_BACKSTOP_MS,
}: {
  /** Coordinator view of a Session: state and the live segment's turnId. */
  snapshot: (scope: RoomScope) => { state: string; turnId?: string }
  /** Absent when the runtime cannot report the turns it starts. */
  adoption?: RoomAdoption
  now?: () => number
  backstopMs?: number
}) {
  const rooms = new Map<string, Room>()

  /**
   * The cached prompt while its turn is still live. A finished execution keeps
   * its old turnId in the coordinator, so only the state check ends it.
   */
  function currentTurn(scope: RoomScope, room: Room) {
    const { turn } = room
    if (!turn) return undefined
    const { state, turnId } = snapshot(scope)
    const live = state !== "idle" && turnId === turn.turnId
    // A question may wait on a person indefinitely; the backstop only guards
    // against a turn the coordinator never reports as ended.
    const expired =
      state !== "waiting-for-input" && now() - turn.at > backstopMs
    if (live && !expired) return turn
    room.turn = undefined
    return undefined
  }

  async function send(member: RoomMember, delivery: Delivery, turn: RoomTurn) {
    // Marked while in flight so a concurrent sync cannot repeat it, and
    // unmarked on failure so the next sync retries it.
    const { delivered, fromRoom } = delivery
    delivery.delivered = turn.turnId
    delivery.fromRoom = true
    try {
      await member.sendTurn(turn)
    } catch (cause) {
      member.report(cause)
      if (delivery.delivered !== turn.turnId) return
      delivery.delivered = delivered
      delivery.fromRoom = fromRoom
    }
  }

  async function catchUpMember(
    scope: RoomScope,
    room: Room,
    member: RoomMember,
    delivery: Delivery
  ) {
    const turn = currentTurn(scope, room)
    if (turn && delivery.delivered !== turn.turnId) {
      await send(member, delivery, turn)
    }
    // Read before following: the prompt may be dropped meanwhile.
    const shown = delivery.fromRoom ? delivery.delivered : undefined
    const following = await attempt(member, () => member.follow())
    if (following !== "idle" || !shown || member.followedTurn() === shown) {
      return
    }
    // Shown a prompt whose reply it never streamed; history has the reply.
    delivery.fromRoom = false
    await attempt(member, () => member.invalidate())
  }

  async function syncRoom(scope: RoomScope, room: Room) {
    await Promise.all(
      [...room.members].map(([member, delivery]) =>
        catchUpMember(scope, room, member, delivery)
      )
    )
  }

  /** Records what a member holds of the live turn, sending it the prompt if not. */
  function seat(
    room: Room,
    member: RoomMember,
    delivery: Delivery,
    hasPrompt: boolean
  ) {
    room.members.set(member, delivery)
    const turn = currentTurn(delivery.scope, room)
    if (!turn) return
    if (hasPrompt) delivery.delivered = turn.turnId
    else void send(member, delivery, turn)
  }

  /**
   * Asks the runtime for a turn it started by itself and, when it adopts one,
   * brings every member into it. Runs one at a time per room, and once more
   * when asked again meanwhile.
   */
  async function adopt(room: Room) {
    if (room.adopting) {
      room.again = true
      return
    }
    room.adopting = true
    try {
      do {
        room.again = false
        await adoptOnce(room)
      } while (room.again)
    } finally {
      room.adopting = false
    }
  }

  async function adoptOnce(room: Room) {
    const seated = adopter(room)
    if (!adoption || !seated) return
    const [member, { scope, lane }] = seated
    const before = snapshot(scope).turnId
    try {
      await adoption.discover(scope, lane)
    } catch (cause) {
      // A proxy turn still starting refuses it; that turn's end asks again.
      if (!(cause instanceof ServerTurnConflictError)) member.report(cause)
      return
    }
    const { state, turnId } = snapshot(scope)
    if (state === "idle" || turnId === undefined || turnId === before) return
    room.adopted = turnId
    await syncRoom(scope, room)
  }

  /**
   * Every turn's end asks the runtime once more, which finds a turn it started
   * while the proxy's own ran. An adopted turn's end reloads every member,
   * since none of them was shown its prompt.
   */
  function onExecution(room: Room, event: ExecutionEvent) {
    if (event.kind !== "turn-finished" && event.kind !== "turn-failed") return
    if (event.turnId === room.adopted) {
      room.adopted = undefined
      for (const member of room.members.keys())
        void attempt(member, () => member.invalidate())
    }
    void adopt(room)
  }

  function watch(scope: SessionScope, room: Room) {
    if (!adoption) return
    const unobserve = adoption.observe(scope, (event) =>
      onExecution(room, event)
    )
    const unwatch = adoption.watch(scope, {
      onTurn: () => void adopt(room),
      onError: (cause) => adopter(room)?.[0].report(cause),
    })
    room.unwatch = () => {
      unwatch()
      unobserve()
    }
  }

  return {
    add(
      scope: SessionScope,
      member: RoomMember,
      options: { hasPrompt: boolean; lane?: Lane }
    ) {
      const key = roomKey(scope)
      let room = rooms.get(key)
      const created = !room
      if (!room) {
        room = { members: new Map() }
        rooms.set(key, room)
      }
      const joined = room
      const remove = () => {
        joined.members.delete(member)
        if (joined.members.size === 0 && rooms.get(key) === joined) {
          rooms.delete(key)
          joined.unwatch?.()
        }
      }
      if (joined.members.has(member)) return remove
      const delivery: Delivery = {
        scope,
        lane: options.lane ?? "operator",
        fromRoom: false,
      }
      seat(joined, member, delivery, options.hasPrompt)
      // Watched once the first member is seated, so a turn already running
      // has someone to adopt it as.
      if (created) watch(scope, joined)
      return remove
    },

    /**
     * Seats a member afresh after its view was rebuilt from history, which
     * holds the live prompt only when `hasPrompt` says so.
     */
    reseat(
      scope: RoomScope,
      member: RoomMember,
      options: { hasPrompt: boolean }
    ) {
      const room = rooms.get(roomKey(scope))
      const delivery = room?.members.get(member)
      if (room && delivery)
        seat(
          room,
          member,
          { scope: delivery.scope, lane: delivery.lane, fromRoom: false },
          options.hasPrompt
        )
    },

    /** Called only after the coordinator admitted `turn`. */
    async broadcastTurn(scope: RoomScope, turn: RoomTurn, sender: RoomMember) {
      const room = rooms.get(roomKey(scope))
      // No member means nobody to tell, and a memberless room would leak.
      if (!room) return
      room.turn = turn
      const own = room.members.get(sender)
      if (own) {
        own.delivered = turn.turnId
        own.fromRoom = false
      }
      await Promise.all(
        [...room.members]
          .filter(([member]) => member !== sender)
          .map(([member, delivery]) => send(member, delivery, turn))
      )
    },

    /** An answered question resumes the same prompt under a fresh turnId. */
    continueTurn(scope: RoomScope, fromTurnId: string, toTurnId: string) {
      const room = rooms.get(roomKey(scope))
      if (!room?.turn || room.turn.turnId !== fromTurnId) return
      room.turn = { ...room.turn, turnId: toTurnId }
      for (const delivery of room.members.values()) {
        if (delivery.delivered === fromTurnId) delivery.delivered = toTurnId
      }
    },

    /** The live turn's prompt, which a resume checks its own replay against. */
    current(scope: RoomScope) {
      const room = rooms.get(roomKey(scope))
      return room ? currentTurn(scope, room) : undefined
    },

    async catchUp(scope: RoomScope, member: RoomMember) {
      const room = rooms.get(roomKey(scope))
      const delivery = room?.members.get(member)
      if (room && delivery) await catchUpMember(scope, room, member, delivery)
    },

    async sync(scope: RoomScope) {
      const room = rooms.get(roomKey(scope))
      if (room) await syncRoom(scope, room)
    },

    /**
     * A member's own start failed without a turn to end, so no turn end asks
     * the runtime; this asks once instead.
     */
    async recheck(scope: RoomScope) {
      const room = rooms.get(roomKey(scope))
      if (room) await adopt(room)
    },
  }
}

type CreateChannelOptions = Parameters<typeof createRooms>[0]

/** How a transport seats one member in one Session. */
export type SeatOptions = {
  coordinator: SessionCoordinator
  /** The subscriber the coordinator knows this member's stream by. */
  subscriberId: string
  /** One structured line per Session-level event; the transport redacts it. */
  log: (
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>
  ) => void
  /** The public code and message a failure is logged under. */
  describe: (cause: unknown) => { code: string; message: string }
  /** The readings this member is given, as authentication chose them. */
  feeds: ReadonlySet<Feed>
}

export function createChannel(options: CreateChannelOptions) {
  const rooms = createRooms(options)
  return {
    ...rooms,
    /** Seats one member in one Session; the seat lasts until it leaves. */
    join(member: Member, scope: SessionScope, seat: SeatOptions) {
      return new Seat(rooms, member, scope, seat)
    },
  }
}

/**
 * One Session as one member observes it: at most one coordinator
 * subscription, the cursor it has reached, and the requests it was asked.
 *
 * A seat owns only the member's subscriber lifetime. Leaving releases the
 * subscription and its place in the Session's room, and nothing else: the
 * native Session, the coordinator's logical execution, and a pending request
 * all outlive it.
 */
class Seat {
  readonly #rooms: Rooms
  readonly #member: Member
  readonly #scope: SessionScope
  readonly #options: SeatOptions
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

  constructor(
    rooms: Rooms,
    member: Member,
    scope: SessionScope,
    options: SeatOptions
  ) {
    this.#rooms = rooms
    this.#member = member
    this.#scope = scope
    this.#options = options
    const { feeds } = options
    this.#leaveReadings = this.#coordinator.subscribeReadings(
      scope,
      options.subscriberId,
      {
        ...(feeds.has("usage")
          ? { usage: (usage) => this.#deliver({ kind: "usage", usage }) }
          : {}),
        ...(feeds.has("model")
          ? { model: (models) => this.#deliver({ kind: "model", models }) }
          : {}),
      }
    )
    this.#seat = {
      sendTurn: ({ messageId, content }) =>
        this.#rebuilding
          ? undefined
          : this.emit({ kind: "prompt", messageId, content, own: false }),
      // A view being rebuilt is seated afresh and follows once its page lands.
      follow: async () =>
        this.#rebuilding || (await this.#follow(false)) !== undefined
          ? "following"
          : "idle",
      followedTurn: () => this.#followedTurn,
      invalidate: () => this.#invalidate(),
      report: (cause) => {
        if (this.#left) return
        const failure = options.describe(cause)
        this.#log("error", "acp.room.failed", {
          errorCode: failure.code,
          message: failure.message,
        })
      },
    }
  }

  /** The Session this member attaches, as its transport resolved it. */
  get scope() {
    return this.#scope
  }

  /**
   * Shows this member one event of its Session, through its stack. A member
   * that left is shown nothing, and neither is one whose stack hides it: a
   * resolved promise rather than `undefined`, because callers chain on what
   * this returns, and never an extra await, because a turn's delivery order
   * rides on the send starting now. What the stack declines runs once the
   * event is delivered.
   */
  emit(event: SessionEvent): Promise<void> {
    if (this.#left) return Promise.resolve()
    const declines = new Set<string>()
    const shown = runEvents(
      this.#member.middleware,
      { sessionId: this.#scope.threadId, ...event },
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

  /** Shows this member a history page at the cursor it has reached. */
  showHistory(
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
   * Tells the member to rebuild this Session's view from history, once per
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
        void this.#rooms.recheck(this.#scope)
        throw cause
      }
      this.#consume(subscription, 0)
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
    if (!this.#leaveRoom) {
      const leave = this.#rooms.add(this.#scope, this.#seat, {
        hasPrompt,
        lane: this.#member.principal.role,
      })
      // A request the Session resolves, through another member's answer or a
      // Stop, is withdrawn here so this member stops offering it.
      const unobserve = this.#coordinator.observeScope(this.#scope, (event) => {
        if (event.kind === "attention-resolved") this.#withdraw(event.requestId)
      })
      this.#leaveRoom = () => {
        leave()
        unobserve()
      }
    } else if (replayed)
      this.#rooms.reseat(this.#scope, this.#seat, { hasPrompt })
  }

  /** Shows the room a turn this member admitted, then brings every member in. */
  async announce(turn: RoomTurn) {
    await this.#rooms.broadcastTurn(this.#scope, turn, this.#seat)
    await this.#rooms.sync(this.#scope)
  }

  /** Brings this member alone into whatever turn the room is running. */
  catchUp() {
    return this.#rooms.catchUp(this.#scope, this.#seat)
  }

  /** Requests Stop, reporting an unsettled provider as `stopping`. */
  async cancel() {
    const status = await this.#coordinator.stop(
      this.#scope,
      this.#member.principal.id
    )
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
   * Owes this member the Session's current context usage, which a joining
   * member needs for its gauge. The coordinator's reporter defers a window
   * that is unreadable right after joining, usually the provider's agent still
   * being built, and leaves the last reading standing if it never becomes
   * readable.
   */
  reportUsage() {
    return this.#coordinator.reportUsage(
      this.#scope,
      this.#options.subscriberId
    )
  }

  /** Asks again the requests a recovered wait is still holding. */
  reissuePending() {
    for (const request of this.#coordinator.snapshot(this.#scope).requests)
      this.#offer(request)
  }

  /** Reports a failure that has no request to answer. */
  async report(cause: unknown) {
    await this.emit({ kind: "error", cause })
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

  leave() {
    for (const requestId of [...this.#offered]) this.#withdraw(requestId)
    this.#left = true
    this.#leaveRoom?.()
    this.#leaveReadings()
    this.#subscription?.close()
    this.#subscription = undefined
  }

  /** Gives the Session one reply of this member's. */
  async #settle(reply: RequestReply) {
    this.#log("info", "acp.request.answered", {
      requestId: reply.requestId,
      status: reply.status,
    })
    // Before the answer resolves this request, so the member answering it
    // is not withdrawn its own request, and a second decline finds none.
    this.#offered.delete(reply.requestId)
    this.#delivered.delete(reply.requestId)
    const continued = await this.#coordinator.answer(this.#scope, reply)
    if (!continued) return
    this.#rooms.continueTurn(this.#scope, continued.from, continued.turnId)
    await this.#rooms.sync(this.#scope)
  }

  /**
   * Declines one permission request for this member. Only a request this
   * member was offered and has not settled, in a turn this member started,
   * while its credential holds; any other decline, a second one from another
   * tab included, is dropped silently.
   */
  async #decline(requestId: string) {
    if (
      this.#left ||
      !this.#offered.has(requestId) ||
      !this.#member.connection.live()
    )
      return
    const open = this.#coordinator.snapshot(this.#scope)
    const request = open.requests.find(
      (pending) => pending.requestId === requestId
    )
    if (
      request?.kind !== PendingRequestKind.Permission ||
      open.startedBy !== this.#member.principal.id
    )
      return
    try {
      await this.#settle(declineReply(request))
    } catch (cause) {
      if (!(cause instanceof ServerRequestStaleError)) await this.report(cause)
    }
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

  #log(
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>
  ) {
    this.#options.log(level, event, {
      sessionId: this.#scope.threadId,
      ...fields,
    })
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

  /**
   * How the coordinator sees one subscription of this member. A member may
   * Stop any turn in its Session, not only one it started.
   */
  #access(): CoordinatorAccess {
    return {
      subscriberId: this.#options.subscriberId,
      controllerId: this.#member.principal.id,
      lane: this.#member.principal.role,
      canControl: true,
    }
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

  /** Shows one subscription's segment to the member, event by event. */
  async #pump(
    subscription: CoordinatedTurnSubscription,
    replayedCorrections: number
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
      if (this.#subscription === subscription) this.#subscription = undefined
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
    this.#log("error", "acp.fanout.detached", {
      subscriberId: this.#options.subscriberId,
      turnId,
      events: overflow.events,
      bytes: overflow.bytes,
    })
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

export type { Seat }
