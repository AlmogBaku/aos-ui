import { describe, expect, it } from "vitest"

import {
  PendingRequestKind,
  type ExecutionEvent,
  type PendingRequest,
  type RequestReply,
} from "./events"
import type { MemberAct, MemberConnection, Middleware } from "./member"
import {
  ServerRequestStaleError,
  ServerTurnConflictError,
  type ServerTurnWatcher,
  type SessionScope,
} from "./runtime"
import {
  createChannel,
  type RoomMember,
  type RoomScope,
  type RoomTurn,
} from "./channel"
import type { SessionCoordinator } from "./session-coordinator"

const SCOPE: SessionScope = {
  agentId: "researcher",
  sessionId: "session-1",
  threadId: "thread-operator",
}

function turn(turnId: string, at = 0): RoomTurn {
  return {
    turnId,
    messageId: `message-${turnId}`,
    content: [{ kind: "text", text: `prompt ${turnId}` }],
    at,
  }
}

function member(
  options: {
    follow?: () => Promise<"following" | "idle">
    followedTurn?: string
    sendTurn?: () => void | Promise<void>
  } = {}
) {
  const sent: string[] = []
  const reported: unknown[] = []
  let follows = 0
  let invalidations = 0
  const fake: RoomMember = {
    sendTurn(sentTurn) {
      sent.push(sentTurn.turnId)
      return options.sendTurn?.()
    },
    follow() {
      follows += 1
      return options.follow?.() ?? Promise.resolve("following")
    },
    followedTurn: () => options.followedTurn,
    invalidate() {
      invalidations += 1
    },
    report(cause) {
      reported.push(cause)
    },
  }
  return {
    fake,
    sent,
    reported,
    follows: () => follows,
    invalidations: () => invalidations,
  }
}

function harness() {
  const snapshots = new Map<string, { state: string; turnId?: string }>()
  const clock = { now: 0 }
  const key = (scope: RoomScope) => `${scope.agentId}/${scope.sessionId}`
  const rooms = createChannel({
    snapshot: (scope) => snapshots.get(key(scope)) ?? { state: "idle" },
    now: () => clock.now,
    backstopMs: 1_000,
  })
  const setSnapshot = (
    snapshot: { state: string; turnId?: string },
    scope: RoomScope = SCOPE
  ) => snapshots.set(key(scope), snapshot)
  return { rooms, clock, setSnapshot }
}

/** A send that fails the first time, so only a later catch-up delivers it. */
function failOnce() {
  let failed = false
  return () => {
    if (failed) return
    failed = true
    throw new Error("first send failed")
  }
}

/** Lets fire-and-forget sends from `add` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createChannel", () => {
  it("broadcasts a turn to every member but the sender, once each", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const first = member()
    const second = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    rooms.add(SCOPE, first.fake, { hasPrompt: false })
    rooms.add(SCOPE, second.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })

    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    expect(sender.sent).toEqual([])
    expect(first.sent).toEqual(["turn-1"])
    expect(second.sent).toEqual(["turn-1"])
  })

  it("does not add a sender that is not a member", async () => {
    const { rooms, setSnapshot } = harness()
    const listener = member()
    const outsider = member()
    rooms.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })

    await rooms.broadcastTurn(SCOPE, turn("turn-1"), outsider.fake)
    await rooms.broadcastTurn(SCOPE, turn("turn-1b"), listener.fake)

    expect(outsider.sent).toEqual([])
  })

  it("puts one provider Session in one room whatever the threadId", async () => {
    const { rooms, setSnapshot } = harness()
    const operator = member()
    const guest = member()
    rooms.add(SCOPE, operator.fake, { hasPrompt: false })
    rooms.add({ ...SCOPE, threadId: "thread-guest" }, guest.fake, {
      hasPrompt: false,
    })
    setSnapshot({ state: "running", turnId: "turn-1" })

    await rooms.broadcastTurn(SCOPE, turn("turn-1"), operator.fake)

    expect(guest.sent).toEqual(["turn-1"])
  })

  it("keeps another sessionId in another room", async () => {
    const { rooms, setSnapshot } = harness()
    const other = { ...SCOPE, sessionId: "session-2" }
    const sender = member()
    const elsewhere = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    rooms.add(other, elsewhere.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    setSnapshot({ state: "running", turnId: "turn-1" }, other)

    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    await rooms.sync(other)

    expect(elsewhere.sent).toEqual([])
  })

  it("stops delivering to a removed member and drops an empty room", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const leaver = member()
    const removeSender = rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    const removeLeaver = rooms.add(SCOPE, leaver.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    removeLeaver()
    removeLeaver()

    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    expect(leaver.sent).toEqual([])

    removeSender()
    const newcomer = member()
    rooms.add(SCOPE, newcomer.fake, { hasPrompt: false })
    await settle()
    expect(newcomer.sent).toEqual([])
  })

  it("ignores a repeat add of the same member", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    const remove = rooms.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    const again = rooms.add(SCOPE, listener.fake, { hasPrompt: false })
    await settle()
    expect(listener.sent).toEqual(["turn-1"])

    again()
    remove()
    await rooms.broadcastTurn(SCOPE, turn("turn-2"), sender.fake)
    expect(listener.sent).toEqual(["turn-1"])
  })

  it("delivers the current prompt once to a joining member", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    const joiner = member()
    const holder = member()
    rooms.add(SCOPE, joiner.fake, { hasPrompt: false })
    rooms.add(SCOPE, holder.fake, { hasPrompt: true })
    await settle()
    await rooms.sync(SCOPE)

    expect(joiner.sent).toEqual(["turn-1"])
    expect(holder.sent).toEqual([])
    expect(sender.sent).toEqual([])
  })

  it.each([
    ["the Session went idle", { state: "idle", turnId: "turn-1" }],
    ["another turn is live", { state: "running", turnId: "turn-2" }],
  ])("drops a prompt that is no longer current: %s", async (_, later) => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    setSnapshot(later)
    const joiner = member()
    rooms.add(SCOPE, joiner.fake, { hasPrompt: false })
    await settle()

    expect(joiner.sent).toEqual([])
  })

  it.each(["uncertain", "waiting-for-input"])(
    "treats %s as live",
    async (state) => {
      const { rooms, setSnapshot } = harness()
      const sender = member()
      rooms.add(SCOPE, sender.fake, { hasPrompt: false })
      setSnapshot({ state: "running", turnId: "turn-1" })
      await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

      setSnapshot({ state, turnId: "turn-1" })
      const joiner = member()
      rooms.add(SCOPE, joiner.fake, { hasPrompt: false })
      await settle()

      expect(joiner.sent).toEqual(["turn-1"])
    }
  )

  it("drops an old prompt at the backstop, but not while waiting for input", async () => {
    const { rooms, clock, setSnapshot } = harness()
    const sender = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "waiting-for-input", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1", 0), sender.fake)
    clock.now = 5_000

    const waiting = member()
    rooms.add(SCOPE, waiting.fake, { hasPrompt: false })
    await settle()
    expect(waiting.sent).toEqual(["turn-1"])

    setSnapshot({ state: "running", turnId: "turn-1" })
    const late = member()
    rooms.add(SCOPE, late.fake, { hasPrompt: false })
    await settle()
    expect(late.sent).toEqual([])
  })

  it("keeps a continued prompt deliverable without re-sending it", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    rooms.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "waiting-for-input", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    rooms.continueTurn(SCOPE, "turn-1", "turn-2")
    setSnapshot({ state: "running", turnId: "turn-2" })
    const joiner = member()
    rooms.add(SCOPE, joiner.fake, { hasPrompt: false })
    await settle()
    await rooms.sync(SCOPE)

    expect(joiner.sent).toEqual(["turn-2"])
    expect(listener.sent).toEqual(["turn-1"])
    expect(sender.sent).toEqual([])
  })

  it("syncs by delivering to members that lack the prompt and following all", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    const missed = member({ sendTurn: failOnce() })
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    rooms.add(SCOPE, listener.fake, { hasPrompt: false })
    rooms.add(SCOPE, missed.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    await rooms.sync(SCOPE)

    expect(missed.sent).toEqual(["turn-1", "turn-1"])
    expect(listener.sent).toEqual(["turn-1"])
    expect(sender.sent).toEqual([])
    expect([sender, listener, missed].map((m) => m.follows())).toEqual([
      1, 1, 1,
    ])
  })

  it("invalidates only a member shown a room prompt whose reply it missed", async () => {
    const { rooms, setSnapshot } = harness()
    const idle = () => Promise.resolve("idle" as const)
    const sender = member({ follow: idle })
    const missed = member({ follow: idle })
    const streamed = member({ follow: idle, followedTurn: "turn-1" })
    const holder = member({ follow: idle })
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    rooms.add(SCOPE, missed.fake, { hasPrompt: false })
    rooms.add(SCOPE, streamed.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    rooms.add(SCOPE, holder.fake, { hasPrompt: true })
    setSnapshot({ state: "idle", turnId: "turn-1" })

    await rooms.sync(SCOPE)

    expect(missed.invalidations()).toBe(1)
    expect(sender.invalidations()).toBe(0)
    expect(streamed.invalidations()).toBe(0)
    expect(holder.invalidations()).toBe(0)
  })

  it("reports a failing member and still serves the others", async () => {
    const { rooms, setSnapshot } = harness()
    const sendFailure = new Error("send failed")
    const followFailure = new Error("follow failed")
    const sender = member()
    const brokenSend = member({
      sendTurn: () => {
        throw sendFailure
      },
    })
    const brokenFollow = member({ follow: () => Promise.reject(followFailure) })
    const healthy = member()
    for (const each of [sender, brokenSend, brokenFollow, healthy]) {
      rooms.add(SCOPE, each.fake, { hasPrompt: false })
    }
    setSnapshot({ state: "running", turnId: "turn-1" })

    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)
    expect(brokenSend.reported).toEqual([sendFailure])
    expect(healthy.sent).toEqual(["turn-1"])

    await rooms.sync(SCOPE)
    expect(brokenFollow.reported).toEqual([followFailure])
    expect(healthy.sent).toEqual(["turn-1"])
    expect(healthy.follows()).toBe(1)
    expect(healthy.reported).toEqual([])
  })

  it("catches up one member alone", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const late = member({ sendTurn: failOnce() })
    const other = member({ sendTurn: failOnce() })
    for (const each of [sender, late, other]) {
      rooms.add(SCOPE, each.fake, { hasPrompt: false })
    }
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    await rooms.catchUp(SCOPE, late.fake)

    expect(late.sent).toEqual(["turn-1", "turn-1"])
    expect(late.follows()).toBe(1)
    expect(other.sent).toEqual(["turn-1"])
    expect(other.follows()).toBe(0)
  })

  it("re-seats a member so a reopened view gets the prompt its history lacks", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    const listener = member()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    rooms.add(SCOPE, listener.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    rooms.reseat(SCOPE, listener.fake, { hasPrompt: false })
    rooms.reseat(SCOPE, sender.fake, { hasPrompt: false })
    const holder = member()
    rooms.add(SCOPE, holder.fake, { hasPrompt: false })
    rooms.reseat(SCOPE, holder.fake, { hasPrompt: true })
    await settle()
    await rooms.sync(SCOPE)

    expect(listener.sent).toEqual(["turn-1", "turn-1"])
    expect(sender.sent).toEqual(["turn-1"])
    expect(holder.sent).toEqual(["turn-1"])
  })

  it("reads the current prompt only while its turn is live", async () => {
    const { rooms, setSnapshot } = harness()
    const sender = member()
    expect(rooms.current(SCOPE)).toBeUndefined()
    rooms.add(SCOPE, sender.fake, { hasPrompt: false })
    setSnapshot({ state: "running", turnId: "turn-1" })
    await rooms.broadcastTurn(SCOPE, turn("turn-1"), sender.fake)

    expect(rooms.current(SCOPE)).toEqual(turn("turn-1"))
    expect(sender.sent).toEqual([])

    setSnapshot({ state: "idle", turnId: "turn-1" })
    expect(rooms.current(SCOPE)).toBeUndefined()
  })
})

/** A runtime whose Session the rooms watch, driven by hand. */
function adoptingHarness() {
  let state: { state: string; turnId?: string } = { state: "idle" }
  const watchers: ServerTurnWatcher[] = []
  const listeners = new Set<(event: ExecutionEvent) => void>()
  const discovered: Array<{ scope: SessionScope; lane: string }> = []
  let stopped = 0
  let discover: () => Promise<unknown> = async () => undefined
  const rooms = createChannel({
    snapshot: () => state,
    adoption: {
      watch(_scope, watcher) {
        watchers.push(watcher)
        return () => {
          stopped += 1
        }
      },
      async discover(scope, lane) {
        discovered.push({ scope, lane })
        return discover()
      },
      observe(_scope, listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  return {
    rooms,
    watchers,
    discovered,
    stopped: () => stopped,
    observers: () => listeners.size,
    /** The runtime starts `turnId`, which the next `discover` adopts. */
    runtimeStarts(turnId: string) {
      discover = async () => {
        state = { state: "running", turnId }
      }
    },
    failDiscover(cause: unknown) {
      discover = async () => {
        throw cause
      }
    },
    end(turnId: string) {
      state = { state: "idle", turnId }
      for (const listener of listeners)
        listener({
          agentId: SCOPE.agentId,
          sessionId: SCOPE.sessionId,
          turnId,
          occurredAt: "2026-09-23T00:00:00Z",
          kind: "turn-finished",
        })
    },
  }
}

const GUEST_SCOPE: SessionScope = { ...SCOPE, threadId: "thread-guest" }

describe("createChannel adopting runtime-started turns", () => {
  it("watches while the room has members and stops when the last leaves", () => {
    const runtime = adoptingHarness()
    const removeFirst = runtime.rooms.add(SCOPE, member().fake, {
      hasPrompt: false,
    })
    const removeSecond = runtime.rooms.add(SCOPE, member().fake, {
      hasPrompt: false,
    })

    expect(runtime.watchers).toHaveLength(1)
    removeFirst()
    expect(runtime.stopped()).toBe(0)
    removeSecond()
    expect(runtime.stopped()).toBe(1)
    expect(runtime.observers()).toBe(0)
  })

  it("adopts a turn the runtime started and brings every member into it", async () => {
    const runtime = adoptingHarness()
    const first = member()
    const second = member()
    runtime.rooms.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.rooms.add(SCOPE, second.fake, { hasPrompt: false })
    runtime.runtimeStarts("aos-recovered-1")

    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toHaveLength(1)
    expect(first.follows()).toBe(1)
    expect(second.follows()).toBe(1)
  })

  it("reloads every member when an adopted turn ends, for the prompt it never showed", async () => {
    const runtime = adoptingHarness()
    const first = member()
    const second = member()
    runtime.rooms.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.rooms.add(SCOPE, second.fake, { hasPrompt: false })
    runtime.runtimeStarts("aos-recovered-1")
    runtime.watchers[0]!.onTurn()
    await settle()

    runtime.end("aos-recovered-1")
    await settle()

    expect(first.invalidations()).toBe(1)
    expect(second.invalidations()).toBe(1)
  })

  it("asks the runtime again when the room's own turn ends, without a reload", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.rooms.add(SCOPE, first.fake, { hasPrompt: false })

    runtime.end("turn-1")
    await settle()

    expect(first.invalidations()).toBe(0)
    expect(runtime.discovered).toHaveLength(1)
  })

  it("adopts as an operator even when a guest joined first", async () => {
    const runtime = adoptingHarness()
    runtime.rooms.add(GUEST_SCOPE, member().fake, {
      hasPrompt: false,
      lane: "guest",
    })
    runtime.rooms.add(SCOPE, member().fake, { hasPrompt: false })

    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toEqual([{ scope: SCOPE, lane: "operator" }])
  })

  it("adopts under the guest lane when only a guest is in the room", async () => {
    const runtime = adoptingHarness()
    runtime.rooms.add(GUEST_SCOPE, member().fake, {
      hasPrompt: false,
      lane: "guest",
    })

    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toEqual([{ scope: GUEST_SCOPE, lane: "guest" }])
  })

  it("skips a conflict silently and adopts at the proxy turn's end", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.rooms.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.failDiscover(new ServerTurnConflictError())
    runtime.watchers[0]!.onTurn()
    await settle()
    expect(first.reported).toEqual([])
    expect(first.follows()).toBe(0)

    runtime.runtimeStarts("aos-recovered-1")
    runtime.end("turn-1")
    await settle()

    expect(first.follows()).toBe(1)
  })

  it("reports any other failure and stays usable", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.rooms.add(SCOPE, first.fake, { hasPrompt: false })
    const failure = new Error("discover failed")
    runtime.failDiscover(failure)
    runtime.watchers[0]!.onTurn()
    await settle()
    const watchFailure = new Error("watch lost")
    runtime.watchers[0]!.onError(watchFailure)

    expect(first.reported).toEqual([failure, watchFailure])
    runtime.runtimeStarts("aos-recovered-1")
    runtime.watchers[0]!.onTurn()
    await settle()
    expect(first.follows()).toBe(1)
  })

  it("asks once more when a trigger arrives while adopting", async () => {
    const runtime = adoptingHarness()
    runtime.rooms.add(SCOPE, member().fake, { hasPrompt: false })

    runtime.watchers[0]!.onTurn()
    runtime.watchers[0]!.onTurn()
    runtime.watchers[0]!.onTurn()
    await settle()

    expect(runtime.discovered).toHaveLength(2)
  })

  it("rechecks after a member's own start fails", async () => {
    const runtime = adoptingHarness()
    const first = member()
    runtime.rooms.add(SCOPE, first.fake, { hasPrompt: false })
    runtime.runtimeStarts("aos-recovered-1")

    await runtime.rooms.recheck(SCOPE)

    expect(first.follows()).toBe(1)
  })
})

const GUEST = "guest:token-1"

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  responseSchema: { type: "string", enum: ["once", "deny"] },
}

const QUESTION: PendingRequest = {
  requestId: "question-1",
  kind: PendingRequestKind.Elicitation,
  questions: [{ choices: ["Yes"], multiple: false, custom: false }],
}

/**
 * One member seated on a Session waiting on `requests`, over a coordinator
 * that records the answers it is given. `decline` is what the member's stack
 * does with each request it is asked, and `hide` hides every request.
 */
function seated(
  options: {
    requests?: PendingRequest[]
    startedBy?: string
    decline?: (requestId: string, act: MemberAct) => void
    hide?: boolean
  } = {}
) {
  let requests = options.requests ?? [APPROVAL]
  const observers = new Set<(event: ExecutionEvent) => void>()
  const log: string[] = []
  const state = { live: true }
  const coordinator = {
    subscribeReadings: () => () => undefined,
    snapshot: () => ({
      state: requests.length > 0 ? "waiting-for-input" : "idle",
      turnId: "turn-1",
      requests: [...requests],
      ...(options.startedBy === undefined
        ? {}
        : { startedBy: options.startedBy }),
    }),
    observeScope(_scope: SessionScope, listener: (e: ExecutionEvent) => void) {
      observers.add(listener)
      return () => observers.delete(listener)
    },
    /** Resolves one open request, as any member's answer or Stop does. */
    async answer(_scope: SessionScope, reply: RequestReply) {
      if (!requests.some(({ requestId }) => requestId === reply.requestId))
        throw new ServerRequestStaleError()
      log.push(
        `answered:${reply.requestId}:${reply.status}:${String(reply.payload)}`
      )
      requests = requests.filter(
        ({ requestId }) => requestId !== reply.requestId
      )
      for (const observer of observers)
        observer({
          agentId: SCOPE.agentId,
          sessionId: SCOPE.sessionId,
          turnId: "turn-1",
          occurredAt: "2026-09-24T00:00:00Z",
          kind: "attention-resolved",
          requestId: reply.requestId,
        })
      return undefined
    },
  } as unknown as SessionCoordinator
  const middleware: Middleware = {
    event(event, act) {
      if (event.kind !== "request-asked") return event
      options.decline?.(event.request.requestId, act)
      return options.hide ? undefined : event
    },
  }
  const connection: MemberConnection = {
    async send(event) {
      log.push(
        event.kind === "request-asked"
          ? `asked:${event.request.requestId}`
          : event.kind === "request-withdrawn"
            ? `withdrawn:${event.requestId}`
            : event.kind
      )
    },
    live: () => state.live,
  }
  const seat = createChannel({ snapshot: () => ({ state: "idle" }) }).join(
    {
      principal: { id: GUEST, role: "guest" },
      middleware: [middleware],
      connection,
    },
    SCOPE,
    {
      coordinator,
      subscriberId: "subscriber-1",
      log: () => undefined,
      describe: () => ({ code: "failed", message: "failed" }),
      feeds: new Set(),
    }
  )
  seat.enterRoom()
  return { seat, log, state, coordinator }
}

const declining = (requestId: string, act: MemberAct) => act.decline(requestId)

describe("a seat's declines", () => {
  it("denies a permission in the member's own turn once the member was offered it", async () => {
    const test = seated({ startedBy: GUEST, decline: declining })

    test.seat.reissuePending()
    await settle()

    expect(test.log).toEqual([
      "asked:approval-1",
      "answered:approval-1:resolved:deny",
    ])
  })

  it("cancels a permission that offers no deny", async () => {
    const test = seated({
      startedBy: GUEST,
      decline: declining,
      hide: true,
      requests: [{ ...APPROVAL, responseSchema: { enum: ["once"] } }],
    })

    test.seat.reissuePending()
    await settle()

    expect(test.log).toEqual(["answered:approval-1:cancelled:undefined"])
  })

  it("leaves a request alone in a turn the member did not start", async () => {
    for (const startedBy of ["operator:owner", undefined]) {
      const test = seated({
        decline: declining,
        hide: true,
        ...(startedBy ? { startedBy } : {}),
      })

      test.seat.reissuePending()
      await settle()

      expect(test.log).toEqual([])
    }
  })

  it("never declines a question, or a request it did not ask this member", async () => {
    const test = seated({
      startedBy: GUEST,
      hide: true,
      requests: [QUESTION, { ...APPROVAL, requestId: "approval-2" }],
      decline: (requestId, act) => {
        act.decline(requestId)
        act.decline("approval-unasked")
      },
    })

    test.seat.reissuePending()
    await settle()

    expect(test.log).toEqual(["answered:approval-2:resolved:deny"])
  })

  it("skips a decline whose connection stopped being live before it ran", async () => {
    const test = seated({ startedBy: GUEST, decline: declining, hide: true })

    test.seat.reissuePending()
    test.state.live = false
    await settle()

    expect(test.log).toEqual([])
  })

  it("drops a second decline of the same request silently", async () => {
    const test = seated({
      startedBy: GUEST,
      hide: true,
      decline: (requestId, act) => {
        act.decline(requestId)
        act.decline(requestId)
      },
    })

    test.seat.reissuePending()
    await settle()

    expect(test.log).toEqual(["answered:approval-1:resolved:deny"])
  })

  it("gives a member no answer and no withdrawal of a request its stack hid", async () => {
    const test = seated({ hide: true })

    test.seat.reissuePending()
    expect(() => test.seat.request("approval-1")).toThrow(
      ServerRequestStaleError
    )
    await test.coordinator.answer(SCOPE, {
      requestId: "approval-1",
      status: "cancelled",
    })
    await settle()

    expect(test.log).toEqual(["answered:approval-1:cancelled:undefined"])
  })

  it("withdraws a request it delivered once another member answers it", async () => {
    const test = seated()

    test.seat.reissuePending()
    await settle()
    expect(test.seat.request("approval-1")).toEqual(APPROVAL)
    await test.coordinator.answer(SCOPE, {
      requestId: "approval-1",
      status: "cancelled",
    })
    await settle()

    expect(test.log).toEqual([
      "asked:approval-1",
      "answered:approval-1:cancelled:undefined",
      "withdrawn:approval-1",
    ])
  })
})
