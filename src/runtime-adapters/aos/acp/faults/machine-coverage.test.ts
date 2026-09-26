/**
 * 4.31 Generated state×event coverage rows for browser-side owner machines.
 *
 * Requirement: every reachable non-final state in each owner machine has at
 * least one outbound path (on, after, or invoke) so it cannot get permanently
 * stuck. A state with zero outbound paths is an "unhandled edge".
 *
 * Machines covered (mirrors of production): browser-connection, session-owner.
 */
import { describe, expect, it } from "vitest"
import { type AnyStateMachine } from "xstate"
import { getAdjacencyMap } from "xstate/graph"

import {
  backoffDelay,
  defaultClock,
  fromAbortable,
  ownerSetup,
} from "@aos/lifecycle"
import {
  CAPACITY_BACKOFF,
  HANDSHAKE_DEADLINE_MS,
  RECONNECT_BACKOFF,
  STABLE_AFTER_MS,
} from "../limits"
import { captureLogs } from "../../../../../test/support/log-capture"

// ---------------------------------------------------------------------------
// Shared checkers (mirrors of packages/proxy/acp/faults/machine-coverage.test.ts)
// ---------------------------------------------------------------------------

/**
 * Options that prevent infinite-context loops in getAdjacencyMap.
 * See packages/proxy/acp/faults/machine-coverage.test.ts for rationale.
 */
const ADJACENCY_OPTS = {
  serializeState: (s: unknown) =>
    JSON.stringify((s as { value: unknown }).value),
  serializeEvent: (e: unknown) =>
    JSON.stringify({ type: (e as { type: string }).type }),
}

type AdjEntry = {
  state: { status: string; value: unknown }
  transitions: Record<string, { state: { value: unknown } }>
}

function adjacency(machine: AnyStateMachine): Record<string, AdjEntry> {
  return getAdjacencyMap(
    machine as never,
    ADJACENCY_OPTS as never
  ) as unknown as Record<string, AdjEntry>
}

function declaredRows(machine: AnyStateMachine) {
  const adj = adjacency(machine)
  const rows: Array<{
    state: unknown
    event: string
    next: unknown
    isFinal: boolean
  }> = []
  for (const adjVal of Object.values(adj)) {
    const isFinal = adjVal.state.status === "done"
    for (const [eventKey, trans] of Object.entries(adjVal.transitions)) {
      try {
        const event = (JSON.parse(eventKey) as { type: string }).type
        rows.push({ state: adjVal.state.value, event, next: trans.state.value, isFinal })
      } catch {
        // malformed event key -- skip
      }
    }
  }
  return rows
}

function assertBounded(machine: AnyStateMachine): void {
  const adj = adjacency(machine)
  for (const adjVal of Object.values(adj)) {
    if (adjVal.state.status === "done") continue
    const paths = Object.keys(adjVal.transitions).length
    expect(
      paths,
      `state "${String(adjVal.state.value)}" is non-final with zero outbound transitions (stuck)`
    ).toBeGreaterThan(0)
  }
}

function assertHasFinalState(machine: AnyStateMachine): void {
  const adj = adjacency(machine)
  const hasFinal = Object.values(adj).some((v) => v.state.status === "done")
  expect(hasFinal, "machine has no reachable final state").toBe(true)
}

// ---------------------------------------------------------------------------
// Machine mirrors
// ---------------------------------------------------------------------------

/** Mirror: src/runtime-adapters/aos/acp/connection.ts browser connection machine */
function browserConnectionMachine() {
  const { logger } = captureLogs()
  const clock = defaultClock
  const actors = {
    open: fromAbortable(async () => undefined),
    handshake: fromAbortable(async () => undefined),
    recover: fromAbortable(async () => undefined),
  }
  type ConnContext = { generation: number; attempt: number }
  type ConnEvent =
    | { type: "closed"; code: number }
    | { type: "close" }
  // connectionSetup is defined before .extend so connectionSetup.assign works.
  const connectionSetup = ownerSetup<ConnContext, ConnEvent, typeof actors>(
    "connection",
    logger,
    clock,
    actors
  )
  const extended = connectionSetup.extend({
    delays: {
      handshake: HANDSHAKE_DEADLINE_MS,
      stable: STABLE_AFTER_MS,
      reconnect: () => backoffDelay(0, RECONNECT_BACKOFF),
      capacity: () => CAPACITY_BACKOFF.minMs,
    },
    guards: {
      inProcess: () => false,
      policyViolation: ({ event }) => event.type === "closed" && event.code === 1008,
      tryAgainLater: ({ event }) => event.type === "closed" && event.code === 1013,
    },
    actions: {
      closeTransport: () => {},
      markReady: () => {},
      lose: () => {},
      countAttempt: connectionSetup.assign({
        attempt: ({ context }) => context.attempt + 1,
      }),
      resetAttempts: connectionSetup.assign({ attempt: 0 }),
    },
  })
  const onTransportClosed = [
    { guard: "inProcess", target: "closed" },
    { guard: "policyViolation", target: "closed" },
    { guard: "tryAgainLater", target: "capacity" },
    { target: "reconnecting" },
  ] as const
  return extended.createMachine({
    context: { generation: 0, attempt: 0 },
    initial: "connecting",
    on: { close: ".closed" },
    states: {
      connecting: {
        entry: "bumpGeneration",
        invoke: { src: "open", onDone: "handshaking" },
        on: { closed: onTransportClosed },
        after: { handshake: { actions: "closeTransport" } },
      },
      handshaking: {
        invoke: {
          src: "handshake",
          onDone: "ready",
          onError: { actions: "closeTransport" },
        },
        on: { closed: onTransportClosed },
        after: { handshake: { actions: "closeTransport" } },
      },
      ready: {
        entry: "markReady",
        invoke: {
          src: "recover",
          onDone: { actions: "resetAttempts" },
          onError: { actions: "closeTransport" },
        },
        on: { closed: onTransportClosed },
        after: { stable: { actions: "resetAttempts" } },
      },
      reconnecting: {
        meta: { log: "info" },
        entry: "lose",
        after: {
          reconnect: { target: "connecting", actions: "countAttempt" },
        },
      },
      capacity: {
        meta: { log: "info" },
        entry: "lose",
        after: { capacity: "connecting" },
      },
      closed: { type: "final", meta: { log: "info" } },
    },
  })
}

/** Mirror: src/runtime-adapters/aos/acp/connection.ts sessionMachine */
function sessionOwnerMachine() {
  const { logger } = captureLogs()
  const clock = defaultClock
  const sessionActors = {
    join: fromAbortable(async () => undefined),
  }
  type SessContext = { generation: number; attempt: number; sessionId: string }
  type SessEvent =
    | { type: "lost" }
    | { type: "ready" }
    | { type: "replay" }
    | { type: "gone" }
  // sessionOwnerSetup is defined before .extend so sessionOwnerSetup.assign works.
  const sessionOwnerSetup = ownerSetup<SessContext, SessEvent, typeof sessionActors>(
    "session-owner",
    logger,
    clock,
    sessionActors
  )
  const sessionSetup = sessionOwnerSetup.extend({
    delays: {
      retry: () => backoffDelay(0, RECONNECT_BACKOFF),
    },
    guards: {
      replayOwed: () => false,
      transportLost: () => false,
    },
    actions: {
      oweReplay: () => {},
      countAttempt: sessionOwnerSetup.assign({
        attempt: ({ context }) => context.attempt + 1,
      }),
      resetAttempts: sessionOwnerSetup.assign({ attempt: 0 }),
    },
  })
  return sessionSetup.createMachine({
    context: { generation: 0, attempt: 0, sessionId: "test-session" },
    initial: "joining",
    on: { replay: { actions: "oweReplay" }, gone: ".gone" },
    states: {
      joining: {
        entry: "bumpGeneration",
        invoke: {
          src: "join",
          input: ({ context }) => context.sessionId,
          onDone: [
            { guard: "replayOwed", target: "joining", reenter: true },
            { target: "joined", actions: "resetAttempts" },
          ],
          onError: [
            { guard: () => false, target: "gone" },
            { guard: "transportLost", target: "detached" },
            { guard: () => false, target: "refused" },
            { target: "unavailable" },
          ],
        },
        on: { lost: "detached" },
      },
      joined: {
        on: {
          lost: "detached",
          replay: { target: "joining", actions: "oweReplay" },
        },
      },
      unavailable: {
        meta: { log: "info" },
        after: { retry: { target: "joining", actions: "countAttempt" } },
        on: { lost: "detached" },
      },
      refused: { meta: { log: "info" }, on: { lost: "detached" } },
      detached: { on: { ready: "joining" } },
      gone: { type: "final", meta: { log: "info" } },
    },
  })
}

// ---------------------------------------------------------------------------
// Coverage tests
// ---------------------------------------------------------------------------

// browser-connection: has a final state (closed).
// session-owner: has a final state (gone).
const machines: Array<[string, () => AnyStateMachine, boolean]> = [
  ["browser-connection", browserConnectionMachine, true],
  ["session-owner", sessionOwnerMachine, true],
]

describe("state×event coverage â browser owner machines (4.31)", () => {
  for (const [name, makeMachine, hasFinal] of machines) {
    describe(name, () => {
      if (hasFinal) {
        it("has at least one reachable final state", () => {
          assertHasFinalState(makeMachine())
        })
      }

      it("every non-final state has at least one outbound transition (not stuck)", () => {
        assertBounded(makeMachine())
      })

      it("generates at least one declared row", () => {
        const rows = declaredRows(makeMachine())
        expect(rows.length).toBeGreaterThan(0)
      })

      it("every declared transition has a valid next-state value", () => {
        const rows = declaredRows(makeMachine())
        for (const row of rows) {
          expect(
            row.next,
            `transition ${String(row.state)} --${row.event}--> undefined`
          ).toBeDefined()
        }
      })
    })
  }
})
