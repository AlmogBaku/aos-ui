import type { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import type { SessionScope } from "../core/runtime"

/**
 * A room is one provider Session; its members are the connections that have
 * it open. The coordinator already fans a turn's stream out to many followers,
 * so a room only carries what the stream cannot: the prompt that started the
 * turn, and a nudge to reload when a member saw a prompt but missed its reply.
 */

export type RoomScope = Pick<SessionScope, "agentId" | "sessionId">

export type RoomTurn = {
  turnId: string
  messageId: string
  content: readonly ContentBlock[]
  /** Epoch ms when the turn was admitted. */
  at: number
  /** An answered question resumed the turn, so its live stream starts there. */
  continued?: true
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

export type SessionRooms = ReturnType<typeof createSessionRooms>

type Delivery = {
  /** The turnId whose prompt this member already holds. */
  delivered?: string
  /** Whether the room sent that prompt, rather than the member owning it. */
  fromRoom: boolean
}

type Room = {
  turn?: RoomTurn
  members: Map<RoomMember, Delivery>
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

export function createSessionRooms({
  snapshot,
  now = Date.now,
  backstopMs = DEFAULT_BACKSTOP_MS,
}: {
  /** Coordinator view of a Session: state and the live segment's turnId. */
  snapshot: (scope: RoomScope) => { state: string; turnId?: string }
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

  /** Records what a member holds of the live turn, sending it the prompt if not. */
  function seat(
    scope: RoomScope,
    room: Room,
    member: RoomMember,
    hasPrompt: boolean
  ) {
    const delivery: Delivery = { fromRoom: false }
    room.members.set(member, delivery)
    const turn = currentTurn(scope, room)
    if (!turn) return
    if (hasPrompt) delivery.delivered = turn.turnId
    else void send(member, delivery, turn)
  }

  return {
    add(scope: RoomScope, member: RoomMember, options: { hasPrompt: boolean }) {
      const key = roomKey(scope)
      let room = rooms.get(key)
      if (!room) {
        room = { members: new Map() }
        rooms.set(key, room)
      }
      const joined = room
      const remove = () => {
        joined.members.delete(member)
        if (joined.members.size === 0 && rooms.get(key) === joined) {
          rooms.delete(key)
        }
      }
      if (joined.members.has(member)) return remove
      seat(scope, joined, member, options.hasPrompt)
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
      if (room?.members.has(member))
        seat(scope, room, member, options.hasPrompt)
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
      room.turn = { ...room.turn, turnId: toTurnId, continued: true }
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
      if (!room) return
      await Promise.all(
        [...room.members].map(([member, delivery]) =>
          catchUpMember(scope, room, member, delivery)
        )
      )
    },
  }
}
