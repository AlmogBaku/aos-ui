import { client, methods } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import {
  ACP_PROTOCOL_VERSION,
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
} from "../../../protocol/acp"
import { useFakeClock } from "../../../../test/support/fake-clock"
import { assertLeakFree } from "../../../../test/support/leak-oracle"
import type { OwnerKind } from "../../../lifecycle"
import { createGuestInvitationService } from "../../auth/guest-invitation"
import { AttachmentStageRegistry } from "../../core/attachment-stages"
import { TurnEventKind } from "../../core/events"
import {
  ADMISSION_DEADLINE_MS,
  JOIN_DEADLINE_MS,
  LINK_BACKOFF,
  READING_BACKOFF,
  RECONCILE_BACKOFF,
  UNCERTAINTY_DEADLINE_MS,
} from "../../core/limits"
import type { ServerTurnListener } from "../../core/runtime"
import { createGuestConnection } from "../../guest/acp"
import {
  AGENT,
  CONNECTION,
  CREATED,
  SESSION,
  chunk,
  connectClient,
  EventSource,
  flow,
  harness,
  turnStarted,
  withoutStates,
  type HarnessOptions,
  type Recorder,
} from "../test-harness"
import type { FaultOperation } from "../test-faults"

type Test = Awaited<ReturnType<typeof harness>>
type Proxy = ReturnType<Test["restart"]>
type Agent = Test["agent"]

const GUEST_REF = "guest-ref"

/** ACP's resource-not-found, the answer for a Session its provider lost. */
const NOT_FOUND = -32002

/** What each member holds of the live stage's turn: its start and one chunk. */
const LIVE_CURSOR = 2

/** What an adapter call past its own deadline rejects with: nothing happened. */
const unavailable = () =>
  new DOMException("The operation timed out.", "TimeoutError")

/** Long past every retry an owner may still have scheduled. */
const HORIZON_MS = 60_000

/**
 * The fake clock fires a zero-delay timer armed while it ticks one millisecond
 * later, so work done "at once" after a deadline lands a tick past it.
 */
const TICK_MS = 1

/** Every operation a fault can reach, whose calls a row counts. */
const OPERATIONS: readonly FaultOperation[] = [
  "start",
  "recover",
  "discover",
  "models",
  "context",
  "workspaceCapabilities",
  "history",
  "getSession",
  "createSession",
  "updateModel",
  "updateSession",
  "deleteSession",
  "listAllSessions",
  "listSessions",
  "listAgents",
  "runtimeInfo",
  "resolveInvitedSession",
  "subscribeCatalogChanges",
]

/** One browser's membership: the Session id it names, and what it received. */
type Member = {
  agent: Agent
  recorder: Recorder
  sessionId: string
  close(): void
}

/** A guest browser that redeemed an invitation to the seeded Session. */
async function connectGuest(proxy: Proxy): Promise<Member> {
  const invitations = createGuestInvitationService({
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: "deployment-a",
    runtimeId: proxy.runtimeInstance.id,
    keys: [{ id: "current", secret: new Uint8Array(32).fill(7) }],
    ttlSeconds: 259_200,
  })
  const { token } = await invitations.issue({ agentId: AGENT, ref: GUEST_REF })
  const context = createGuestConnection(
    {
      publicOrigin: "https://guest.example.test",
      runtimeInstance: proxy.runtimeInstance,
      invitations,
      attachmentStages: new AttachmentStageRegistry(),
      channels: proxy.channels,
      catalog: proxy.catalog,
      guestActiveExecutions: 2,
      logger: proxy.logs.logger,
    },
    "guest-connection"
  )
  const { connection, recorder } = connectClient(context, {
    name: "aos-guest-browser",
  })
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    info: { name: "aos-guest-browser", version: "1" },
    capabilities: { _meta: { [AOS_META_KEY]: { historyPages: true } } },
  })
  await connection.agent.request(methods.agent.auth.login, {
    methodId: AOS_AUTH_METHOD_INVITE,
    _meta: { [AOS_META_KEY]: { token } },
  })
  return {
    agent: connection.agent,
    recorder,
    sessionId: GUEST_REF,
    close: () => connection.close(),
  }
}

/** An operator browser on `proxy`, registered with the Session's Agent. */
async function connectOperator(proxy: Proxy, connectionId: string) {
  const browser = await proxy.connect(connectionId)
  await browser.list()
  return { ...browser, sessionId: SESSION }
}

/**
 * The runtime starting a turn of its own: `subscribeTurns` announces it and
 * `discover` hands it over, as an adapter does for a turn it did not start.
 */
function foreignTurns() {
  const listeners = new Set<ServerTurnListener>()
  let running: { handle: EventSource; startedAt: number } | undefined
  return {
    options: {
      subscribeTurns: (_scope, listener) => {
        listeners.add(listener)
        if (running) listener.onTurn()
        return () => listeners.delete(listener)
      },
      discover: async () =>
        running && { ...running, state: "running" as const, fromStart: true },
    } satisfies HarnessOptions,
    /** Starts a turn, or attaches a new stream to one, as a subscriber sees. */
    start() {
      running = { handle: new EventSource(), startedAt: Date.now() }
      for (const listener of listeners) listener.onTurn()
      return running.handle
    },
    end() {
      running?.handle.emit({ kind: TurnEventKind.TurnEnded })
      running = undefined
    },
  }
}

type Table = {
  test: Test
  /** The proxy process the members are connected to now. */
  proxy: Proxy
  clock: ReturnType<typeof useFakeClock>
  operator: Member
  guest: Member
  /** Every browser a row opened, which the runner closes. */
  browsers: Array<{ close(): void }>
  foreign: ReturnType<typeof foreignTurns>
  /** The turn stream the provider is running, as the members follow it. */
  source(): EventSource
  /** The live stage's turn, as its members' cursors name it. */
  turnId?: string
  /** What the fault left in flight, which must settle within the row's bound. */
  settling: Promise<unknown>[]
}

/** Resumes `member`'s Session and lets its owed state go out. */
async function join(
  t: Table,
  member: Member,
  params: Record<string, unknown> = {}
) {
  const answer = await member.agent.request(methods.agent.session.resume, {
    sessionId: member.sessionId,
    cwd: "/",
    ...params,
  })
  await t.clock.advance(0)
  return answer
}

const fromStart = { replayFrom: { type: "start" } }

/** A resume at the cursor `member` holds of the live turn, as a rejoin sends. */
const atCursor = (turnId: string | undefined, after: number) => ({
  _meta: { [AOS_META_KEY]: { turnId, after } },
})

/** Sends one prompt under a client id, as the browser's composer does. */
function send(member: Member, clientId = "client-1") {
  const answered = member.agent.request(methods.agent.session.prompt, {
    sessionId: member.sessionId,
    prompt: [{ type: "text", text: "Summarize" }],
    _meta: { [AOS_META_KEY]: { clientId } },
  })
  // A refusal may come only past a deadline; it is the row's to read then.
  answered.catch(() => undefined)
  return answered
}

/** Both members resume at the cursor the live stage left them, as a redial does. */
async function redial(t: Table) {
  for (const member of members(t))
    await join(t, member, atCursor(t.turnId, LIVE_CURSOR))
}

/** The updates of `kind` one member received for its Session. */
function updatesOf(member: Member, kind: string) {
  return member.recorder
    .of(methods.client.session.update)
    .filter(
      ({ params }) =>
        (params as { update: { sessionUpdate: string } }).update
          .sessionUpdate === kind
    )
}

/** The `_aos/error` notices one member received, by code. */
function notices(member: Member) {
  return member.recorder
    .of(AOS_METHODS.notify.error)
    .map(({ params }) => (params as { code: string }).code)
}

/** The turn stream `member` was shown, without the states that bracket it. */
const shownTo = (member: Member) =>
  withoutStates(flow(member.recorder, member.sessionId))

/** Streams the rest of the reply and ends the turn on `source`. */
async function finish(t: Table, source: EventSource) {
  chunk(source, " reply")
  source.emit({ kind: TurnEventKind.TurnEnded })
  await t.clock.advance(0)
}

/**
 * The running turn's stream fails and ends the way a dropped native link ends
 * it.
 */
async function dropLink(t: Table) {
  const dropped = t.source()
  dropped.emit({
    kind: TurnEventKind.TurnFailed,
    code: "AOS_CONNECTION_INTERRUPTED",
  })
  dropped.finish()
  await t.clock.advance(0)
}

/**
 * The native link drops, and each later recover answers with a new stream of
 * the same turn.
 */
async function interrupt(t: Table) {
  t.test.recover.mockImplementation(async () => {
    const source = new EventSource()
    t.test.sources.push(source)
    return source
  })
  await dropLink(t)
}

/** The failure code of each turn end one member was shown, in order. */
function endings(member: Member) {
  return updatesOf(member, "state_update").flatMap(({ params }) => {
    const { update } = params as {
      update: { stopReason?: string; _meta?: Record<string, { code?: string }> }
    }
    const code = update._meta?.[AOS_META_KEY]?.code
    return update.stopReason === undefined || code === undefined ? [] : [code]
  })
}

const members = (t: Table) => [t.operator, t.guest]

/** Each member was shown each of `items` once, in order, and the turn's end. */
function bothShown(t: Table, items: string[]) {
  for (const member of members(t)) {
    expect(shownTo(member).filter((item) => items.includes(item))).toEqual(
      items
    )
    expect(JSON.stringify(member.recorder.entries)).toContain("end_turn")
  }
}

type Stage = "connected" | "joined" | "live"

type Row = {
  operation: string
  fault:
    | "fails once"
    | "hangs until aborted"
    | "gone"
    | "answers after its own events"
    | "native link drop"
    | "proxy restart"
  /** Where the operator and the guest are when the fault is armed. */
  stage: Stage
  options?: HarnessOptions
  /** Whether the runtime starts turns of its own, which the channel adopts. */
  foreign?: true
  /** Arms the fault and drives the journey that meets it. */
  meet(t: Table): Promise<void>
  /** How long after the fault the journey has recovered, on the fake clock. */
  bound: number
  /** What the recovered journey shows. */
  recovered(t: Table): Promise<void> | void
  /** How often each operation was called from the fault on, and long after. */
  calls: Partial<Record<FaultOperation, number>>
  /** The owner transitions the recovery took. */
  transitions?: Partial<Record<OwnerKind, [string, string][]>>
}

const ROWS: Row[] = [
  // --- fails once: readings the membership owes retry on their backoff.
  {
    operation: "models",
    fault: "fails once",
    stage: "connected",
    async meet(t) {
      t.test.faults.failOnce("models", unavailable())
      await join(t, t.operator)
      await join(t, t.guest)
    },
    bound: READING_BACKOFF.baseMs,
    recovered(t) {
      expect(updatesOf(t.operator, "config_option_update")).toHaveLength(1)
      // Models are an operator feed a guest is not granted.
      expect(updatesOf(t.guest, "config_option_update")).toEqual([])
    },
    calls: { models: 2 },
    transitions: {
      reading: [
        ["reading", "backing-off"],
        ["backing-off", "reading"],
      ],
    },
  },
  {
    operation: "context",
    fault: "fails once",
    stage: "connected",
    async meet(t) {
      t.test.faults.failOnce("context", unavailable())
      await join(t, t.operator)
      await join(t, t.guest)
    },
    bound: READING_BACKOFF.baseMs,
    recovered(t) {
      expect(updatesOf(t.operator, "usage_update")).toHaveLength(1)
      // Usage is an operator feed a guest is not granted.
      expect(updatesOf(t.guest, "usage_update")).toEqual([])
    },
    calls: { context: 2 },
    transitions: {
      reading: [
        ["reading", "backing-off"],
        ["backing-off", "reading"],
      ],
    },
  },
  {
    operation: "workspaceCapabilities",
    fault: "fails once",
    stage: "connected",
    async meet(t) {
      t.test.faults.failOnce("workspaceCapabilities", unavailable())
      await join(t, t.operator)
      await join(t, t.guest)
    },
    bound: READING_BACKOFF.baseMs,
    recovered(t) {
      for (const member of members(t))
        expect(updatesOf(member, "available_commands_update")).toHaveLength(1)
    },
    // Each member reads its own: the operator's twice, the guest's once.
    calls: { workspaceCapabilities: 3 },
    transitions: {
      reading: [
        ["reading", "backing-off"],
        ["backing-off", "reading"],
      ],
    },
  },
  // --- fails once: a join is refused at once, and its repeat lands.
  {
    operation: "history",
    fault: "fails once",
    stage: "connected",
    async meet(t) {
      t.test.faults.failOnce("history", unavailable())
      await expect(join(t, t.operator, fromStart)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
      await join(t, t.guest, fromStart)
    },
    bound: 0,
    async recovered(t) {
      await join(t, t.operator, fromStart)
      // Each member is shown the stored conversation once.
      for (const member of members(t)) expect(shownTo(member)).toHaveLength(1)
    },
    calls: { history: 3 },
  },
  {
    operation: "getSession",
    fault: "fails once",
    stage: "connected",
    async meet(t) {
      t.test.faults.failOnce("getSession", unavailable())
      await join(t, t.operator)
      await join(t, t.guest)
    },
    bound: 0,
    recovered(t) {
      // The member keeps the row it was listed, and the rest of what it is owed.
      expect(updatesOf(t.operator, "session_info_update")).toHaveLength(1)
      for (const member of members(t))
        expect(updatesOf(member, "state_update")).toHaveLength(1)
      expect(t.test.channels.memberships()).toBe(2)
    },
    calls: { getSession: 2 },
  },
  {
    operation: "resolveInvitedSession",
    fault: "fails once",
    stage: "connected",
    async meet(t) {
      t.test.faults.failOnce("resolveInvitedSession", unavailable())
      await join(t, t.operator)
      await expect(join(t, t.guest)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      await join(t, t.guest)
      expect(updatesOf(t.guest, "state_update")).toHaveLength(1)
      expect(t.test.channels.memberships()).toBe(2)
    },
    calls: { resolveInvitedSession: 2 },
  },
  {
    operation: "runtimeInfo",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("runtimeInfo", unavailable())
      const refused = client({ name: "aos-browser" }).connect(t.test.agentApp())
      await expect(
        refused.agent.request(methods.agent.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          info: { name: "aos-browser", version: "1" },
        })
      ).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
      t.browsers.push(refused)
    },
    bound: 0,
    async recovered(t) {
      t.browsers.push(await connectOperator(t.test, "connection-2"))
    },
    calls: { runtimeInfo: 2 },
  },
  {
    operation: "subscribeCatalogChanges",
    fault: "fails once",
    stage: "connected",
    options: {
      arm: (faults) =>
        faults.failOnce("subscribeCatalogChanges", unavailable()),
    },
    async meet() {},
    bound: LINK_BACKOFF.baseMs,
    recovered() {},
    calls: { subscribeCatalogChanges: 1 },
    transitions: {
      link: [
        ["connecting", "backing-off"],
        ["backing-off", "connecting"],
        ["connecting", "ready"],
      ],
    },
  },
  // --- fails once: a command is refused at once, and its repeat lands.
  {
    operation: "start",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("start", unavailable())
      await expect(send(t.operator)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      // The repeat names the same client id: the failed admission is forgotten.
      await send(t.operator)
      t.source().emit(turnStarted())
      await finish(t, t.source())
      bothShown(t, ["chunk  reply"])
    },
    calls: { start: 2 },
  },
  {
    operation: "createSession",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("createSession", unavailable())
      await expect(create(t)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      // The repeat names the same client id: the failed creation is forgotten.
      await expect(create(t)).resolves.toMatchObject({ sessionId: CREATED })
    },
    calls: { createSession: 2 },
  },
  {
    operation: "updateModel",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("updateModel", unavailable())
      await expect(setModel(t)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      // One line names the request the refused command came in.
      expect(
        t.test.logs
          .records()
          .filter(({ message }) => message === "connection.command.failed")
      ).toEqual([
        {
          level: "warn",
          message: "connection.command.failed",
          fields: {
            connectionId: CONNECTION,
            role: "operator",
            command: "set-config",
            requestId: 3,
            errorCode: "temporarily_unavailable",
          },
        },
      ])
      await setModel(t)
    },
    calls: { updateModel: 2 },
  },
  {
    operation: "updateSession",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("updateSession", unavailable())
      await expect(rename(t)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      await rename(t)
    },
    calls: { updateSession: 2 },
  },
  {
    operation: "deleteSession",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("deleteSession", unavailable())
      await expect(remove(t)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      await remove(t)
    },
    calls: { deleteSession: 2 },
  },
  {
    operation: "listAllSessions",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("listAllSessions", unavailable())
      await expect(t.test.list()).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      await expect(t.test.list()).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: SESSION })],
      })
    },
    calls: { listAllSessions: 2 },
  },
  {
    operation: "listSessions",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("listSessions", unavailable())
      await expect(listAgentSessions(t)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      await expect(listAgentSessions(t)).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: SESSION })],
      })
    },
    calls: { listSessions: 2 },
  },
  {
    operation: "listAgents",
    fault: "fails once",
    stage: "joined",
    async meet(t) {
      t.test.faults.failOnce("listAgents", unavailable())
      await expect(listAgents(t)).rejects.toMatchObject({
        code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
      })
    },
    bound: 0,
    async recovered(t) {
      await expect(listAgents(t)).resolves.toBeDefined()
    },
    calls: { listAgents: 2 },
  },
  // --- fails once: the coordinator's reconcile retries on its backoff.
  {
    operation: "recover",
    fault: "fails once",
    stage: "live",
    async meet(t) {
      t.test.faults.failOnce("recover", unavailable())
      await interrupt(t)
    },
    bound: RECONCILE_BACKOFF.baseMs,
    async recovered(t) {
      await redial(t)
      await finish(t, t.source())
      bothShown(t, ["chunk  reply"])
    },
    calls: { recover: 2 },
    transitions: {
      turn: [
        ["running", "uncertain"],
        ["uncertain", "admitting"],
        ["admitting", "uncertain"],
        ["admitting", "running"],
      ],
    },
  },
  // --- hangs until aborted: each call ends at its own deadline.
  nestedDeadlines(),
  {
    operation: "discover",
    fault: "fails once",
    stage: "joined",
    foreign: true,
    async meet(t) {
      t.test.faults.failOnce("discover", unavailable())
      const source = t.foreign.start()
      await t.clock.advance(0)
      chunk(source, "Early")
      await t.clock.advance(0)
    },
    bound: READING_BACKOFF.baseMs,
    async recovered(t) {
      t.foreign.end()
      await t.clock.advance(0)
      bothShown(t, ["chunk Early"])
    },
    // The failed ask, its retry, and the one more ask its end makes.
    calls: { discover: 3 },
  },
  {
    operation: "native link",
    fault: "native link drop",
    stage: "live",
    async meet(t) {
      await interrupt(t)
    },
    bound: 0,
    async recovered(t) {
      await finish(t, t.source())
      bothShown(t, ["chunk  reply"])
    },
    calls: { recover: 1 },
    transitions: {
      turn: [
        ["running", "uncertain"],
        ["uncertain", "admitting"],
        ["admitting", "running"],
      ],
    },
  },
  {
    // No recover confirms the turn, so its deadline ends it: each member it
    // interrupted is told how, and none has to redial.
    operation: "unconfirmed turn",
    fault: "native link drop",
    stage: "live",
    async meet(t) {
      t.test.recover.mockRejectedValue(unavailable())
      await dropLink(t)
    },
    bound: UNCERTAINTY_DEADLINE_MS,
    recovered(t) {
      for (const member of members(t))
        expect(endings(member).at(-1)).toBe("AOS_OUTCOME_UNKNOWN")
    },
    // Each reconcile asks on a jittered backoff, so no count is fixed.
    calls: {},
    transitions: { turn: [["uncertain", "idle"]] },
  },
  {
    operation: "recover",
    fault: "hangs until aborted",
    stage: "live",
    async meet(t) {
      t.test.faults.hangUntilAborted("recover")
      await interrupt(t)
    },
    bound: ADMISSION_DEADLINE_MS + RECONCILE_BACKOFF.baseMs,
    async recovered(t) {
      await redial(t)
      await finish(t, t.source())
      bothShown(t, ["chunk  reply"])
    },
    calls: { recover: 2 },
    transitions: {
      turn: [
        ["uncertain", "admitting"],
        ["admitting", "uncertain"],
        ["admitting", "running"],
      ],
    },
  },
  {
    operation: "history",
    fault: "hangs until aborted",
    stage: "connected",
    async meet(t) {
      t.test.faults.hangUntilAborted("history")
      t.settling.push(
        expect(join(t, t.operator, fromStart)).rejects.toMatchObject({
          code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
        })
      )
      await join(t, t.guest)
    },
    bound: JOIN_DEADLINE_MS,
    async recovered(t) {
      // A join still holding its place would leave the next one without the
      // execution only a joined membership is shown.
      await join(t, t.operator)
      expect(updatesOf(t.operator, "state_update")).toHaveLength(1)
    },
    calls: { history: 1 },
    transitions: { membership: [["joining", "detached"]] },
  },
  // --- gone: every member is told once, and nothing asks for it again.
  {
    operation: "history",
    fault: "gone",
    stage: "live",
    async meet(t) {
      t.test.faults.gone(t.test.scope)
      await expect(join(t, t.operator, fromStart)).rejects.toMatchObject({
        code: NOT_FOUND,
      })
    },
    bound: 0,
    recovered(t) {
      expect(notices(t.guest)).toEqual(["not_found"])
      expect(t.test.coordinator.gauges().executions).toBe(0)
    },
    calls: { history: 1 },
  },
  {
    operation: "session reads",
    fault: "gone",
    stage: "live",
    async meet(t) {
      t.test.faults.gone(t.test.scope)
      // Both sockets drop, and both browsers rejoin at their cursor.
      for (const member of members(t)) member.close()
      t.operator = await connectOperator(t.test, "connection-3")
      t.guest = await connectGuest(t.test)
      t.browsers.push(t.operator, t.guest)
      await redial(t)
    },
    bound: 0,
    async recovered(t) {
      for (const member of members(t))
        expect(notices(member)).toEqual(["not_found"])
      // A later rejoin learns its cursor is lost, and a reload is refused.
      const resumed = await join(t, t.operator, atCursor(t.turnId, LIVE_CURSOR))
      expect(resumed._meta?.[AOS_META_KEY]).toEqual({ resync: true })
      await expect(join(t, t.operator, fromStart)).rejects.toMatchObject({
        code: NOT_FOUND,
      })
    },
    calls: {},
  },
  {
    // Deleted while the native link was down: whichever call meets it first
    // ends it for every owner, the uncertain turn with it.
    operation: "native link",
    fault: "gone",
    stage: "live",
    async meet(t) {
      t.test.faults.gone(t.test.scope)
      await interrupt(t)
    },
    bound: 0,
    recovered(t) {
      for (const member of members(t))
        expect(notices(member)).toEqual(["not_found"])
      expect(t.test.coordinator.gauges().executions).toBe(0)
    },
    calls: {},
    transitions: { turn: [["running", "uncertain"]] },
  },
  // --- answers after its own events: each member is shown each event once.
  {
    operation: "start",
    fault: "answers after its own events",
    stage: "joined",
    async meet(t) {
      t.test.faults.answerAfterEvents("start")
      const answer = send(t.operator)
      await t.clock.advance(0)
      chunk(t.source(), "Early")
      await answer
      await t.clock.advance(0)
    },
    bound: 0,
    async recovered(t) {
      await finish(t, t.source())
      bothShown(t, ["chunk Early", "chunk  reply"])
    },
    calls: { start: 1 },
  },
  {
    operation: "recover",
    fault: "answers after its own events",
    stage: "live",
    async meet(t) {
      t.test.faults.answerAfterEvents("recover")
      await interrupt(t)
      chunk(t.source(), "Early")
      await t.clock.advance(0)
    },
    bound: 0,
    async recovered(t) {
      await redial(t)
      await finish(t, t.source())
      bothShown(t, ["chunk Early", "chunk  reply"])
    },
    calls: { recover: 1 },
  },
  {
    operation: "discover",
    fault: "answers after its own events",
    stage: "joined",
    foreign: true,
    async meet(t) {
      t.test.faults.answerAfterEvents("discover")
      const source = t.foreign.start()
      await t.clock.advance(0)
      chunk(source, "Early")
      await t.clock.advance(0)
    },
    bound: 0,
    async recovered(t) {
      t.foreign.end()
      await t.clock.advance(0)
      bothShown(t, ["chunk Early"])
    },
    // The adoption, and the one more ask its end makes.
    calls: { discover: 2 },
  },
  // --- a journey across every owner.
  {
    operation: "every owner",
    fault: "proxy restart",
    stage: "live",
    foreign: true,
    async meet(t) {
      for (const member of members(t)) member.close()
      await t.clock.advance(0)
      t.test.coordinator.close()
      await t.clock.advance(0)
      // The native turn runs on, and the new process attaches to it afresh.
      t.test.sources.push(t.foreign.start())
      t.proxy = t.test.restart()
      t.operator = await connectOperator(t.proxy, "connection-3")
      t.guest = await connectGuest(t.proxy)
      t.browsers.push(t.operator, t.guest)
    },
    bound: 0,
    async recovered(t) {
      // Neither cursor means anything to the new process.
      for (const member of members(t)) {
        const answer = await join(t, member, atCursor(t.turnId, LIVE_CURSOR))
        expect(answer._meta?.[AOS_META_KEY]).toEqual({ resync: true })
      }
      chunk(t.source(), " reply")
      t.foreign.end()
      await t.clock.advance(0)
      bothShown(t, ["chunk  reply"])
    },
    // The adoption, and the one more ask its end makes.
    calls: { discover: 2 },
  },
]

/**
 * A start that never answers proves the deadlines nest: its adapter call is
 * aborted first, its admission ends after, and the browser's prompt is
 * answered after both, at the admission deadline the row's bound names.
 */
function nestedDeadlines(): Row {
  // How many lines the proxy had logged when each happened.
  const marks: { aborted?: number; answered?: number } = {}
  const mark = (t: Table) => t.test.logs.records().length
  const reconciled = new EventSource()
  return {
    operation: "start",
    fault: "hangs until aborted",
    stage: "joined",
    async meet(t) {
      t.test.faults.hangUntilAborted("start")
      t.test.recover.mockImplementationOnce(async () => {
        t.test.sources.push(reconciled)
        return reconciled
      })
      const answer = send(t.operator)
      await t.clock.advance(0)
      const signal = t.test.faults.calls("start")[0]?.[3] as AbortSignal
      signal.addEventListener("abort", () => (marks.aborted = mark(t)))
      t.settling.push(
        expect(
          answer.finally(() => (marks.answered = mark(t)))
        ).rejects.toMatchObject({
          code: AOS_JSONRPC_ERRORS.uncertainMutation,
        })
      )
    },
    bound: ADMISSION_DEADLINE_MS + TICK_MS,
    async recovered(t) {
      const admissionEnded = t.test.logs
        .records()
        .findIndex(
          ({ message, fields }) =>
            message.startsWith("turn.") && fields.from === "admitting"
        )
      expect(marks.aborted).toBeLessThanOrEqual(admissionEnded)
      expect(admissionEnded).toBeLessThan(marks.answered!)
      // The reconciled turn settles, and the Session takes the next prompt.
      reconciled.emit({ kind: TurnEventKind.TurnEnded })
      await t.clock.advance(0)
      await send(t.operator, "client-2")
      t.source().emit(turnStarted())
      await finish(t, t.source())
      bothShown(t, ["chunk  reply"])
    },
    calls: { start: 2, recover: 1 },
    transitions: {
      turn: [
        ["admitting", "uncertain"],
        ["uncertain", "admitting"],
        ["admitting", "running"],
      ],
    },
  }
}

/** Lets what `command` owes the members go out once it is answered. */
async function settle<T>(t: Table, command: Promise<T>) {
  const answer = await command
  await t.clock.advance(0)
  return answer
}

const setModel = (t: Table) =>
  settle(
    t,
    t.operator.agent.request(methods.agent.session.setConfigOption, {
      sessionId: SESSION,
      configId: "model",
      type: "id",
      value: "opus",
    })
  )

const rename = (t: Table) =>
  settle(
    t,
    t.operator.agent.request(AOS_METHODS.session.update, {
      sessionId: SESSION,
      title: "Renamed",
    })
  )

const remove = (t: Table) =>
  settle(
    t,
    t.operator.agent.request(methods.agent.session.delete, {
      sessionId: SESSION,
    })
  )

const create = (t: Table) => settle(t, t.test.create({ clientId: "create-1" }))

const listAgentSessions = (t: Table) =>
  t.operator.agent.request(methods.agent.session.list, {
    _meta: { [AOS_META_KEY]: { agentId: AGENT } },
  })

const listAgents = (t: Table) =>
  t.operator.agent.request(AOS_METHODS.agents.list, {})

async function stageTo(t: Table, stage: Stage) {
  if (stage === "connected") return
  await join(t, t.operator)
  await join(t, t.guest)
  if (stage === "joined") return
  await send(t.operator)
  t.source().emit(turnStarted())
  chunk(t.source(), "Live")
  await t.clock.advance(0)
  for (const member of members(t))
    expect(shownTo(member)).toContain("chunk Live")
  t.turnId = t.test.coordinator.snapshot(t.test.scope).turnId
}

const counts = (test: Test) =>
  Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      test.faults.calls(operation).length,
    ])
  )

describe("proxy fault table", () => {
  it.each(ROWS)("$operation × $fault", async (row) => {
    const clock = useFakeClock()
    const foreign = foreignTurns()
    const test = await harness({
      providerIds: true,
      ...(row.foreign ? foreign.options : {}),
      ...row.options,
    })
    const operator = { ...test, sessionId: SESSION }
    await test.list()
    const guest = await connectGuest(test)
    const t: Table = {
      test,
      proxy: test,
      clock,
      operator,
      guest,
      browsers: [operator, guest],
      foreign,
      source: () => test.sources.at(-1)!,
      settling: [],
    }
    await stageTo(t, row.stage)
    const before = counts(test)

    await row.meet(t)
    await clock.advance(row.bound)
    await Promise.all(t.settling)
    await row.recovered(t)
    await clock.advance(0)

    const recovered = counts(test)
    await clock.advance(HORIZON_MS)
    const after = counts(test)
    // Nothing is asked again once recovered: not a Session gone, not a read.
    expect(after).toEqual(recovered)
    for (const [operation, count] of Object.entries(row.calls))
      expect(after[operation]! - before[operation]!, `${operation} calls`).toBe(
        count
      )
    for (const [owner, pairs] of Object.entries(row.transitions ?? {}))
      expect(test.logs.transitions({ owner: owner as OwnerKind })).toEqual(
        expect.arrayContaining(pairs)
      )

    for (const browser of t.browsers) browser.close()
    await clock.advance(0)
    assertLeakFree(t.proxy)
  })
})

describe("leak oracle", () => {
  /**
   * A socket that closes before completing the initialize handshake must
   * release every feed it opened and leave no pending timers. This row
   * failed before K 3.37 (observers were not released) and passes now.
   */
  it("a socket closed before initialize leaves zero observers and zero timers", async () => {
    const clock = useFakeClock()
    const test = await harness()

    // Close a second connection before it completes its initialize handshake.
    const early = client({ name: "aos-browser" }).connect(test.agentApp())
    early.close()

    // Close the primary connection too.
    test.close()

    // Flush the microtasks that complete the cleanup in both connections'
    // onRequest(initialize) handlers before asserting.
    await clock.advance(0)

    assertLeakFree(test)
  })
})
