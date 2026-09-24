import type { ExecutionEvent } from "./events"
import type { PromptPart } from "./member"
import {
  ServerTurnConflictError,
  type ServerTurnWatcher,
  type SessionScope,
} from "./runtime"

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

export function createChannel({
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
