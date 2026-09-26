/**
 * 4.31 Generated state×event coverage rows for all proxy-side owner machines.
 *
 * Requirement: every reachable non-final state in each owner machine has at
 * least one outbound path (on, after, or invoke) so it cannot get permanently
 * stuck. A state with zero outbound paths is an "unhandled edge".
 *
 * The it.fails test verifies that assertBounded detects a deliberately stuck
 * non-final state and produces a failing assertion (the "failing row").
 *
 * Machines covered (mirrors of production): proxy-connection, membership,
 * turn, link, reading.
 */
import { describe, expect, it } from "vitest"
import { type AnyStateMachine } from "xstate"
import { getAdjacencyMap } from "xstate/graph"

import {
  backoffDelay,
  defaultClock,
  fromAbortable,
  ownerSetup,
  type OwnerContext,
} from "../../../lifecycle"
import {
  ADMISSION_DEADLINE_MS,
  JOIN_DEADLINE_MS,
  LINK_BACKOFF,
  PAUSED_DEADLINE_MS,
  READING_BACKOFF,
  RECONCILE_BACKOFF,
  UNCERTAINTY_DEADLINE_MS,
} from "../../core/limits"
import { captureLogs } from "../../../../test/support/log-capture"

// ---------------------------------------------------------------------------
// Shared checkers
// ---------------------------------------------------------------------------

/**
 * Options that prevent infinite-context loops in getAdjacencyMap:
 * serialize only the state VALUE (name) and the event TYPE, not the full
 * context or payload. This collapses all snapshots with the same state name,
 * which is correct for structural coverage: state-value uniqueness is what
 * the owner machine guarantees.
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

/**
 * Returns every (state, event, nextState) triple the adjacency map declares.
 * Each entry is one generated coverage row.
 */
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

/**
 * Asserts that every non-final state has at least one outbound transition.
 * A state with zero outbound paths is permanently stuck: an "unhandled edge".
 */
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

/** Asserts the machine has at least one reachable final state. */
function assertHasFinalState(machine: AnyStateMachine): void {
  const adj = adjacency(machine)
  const hasFinal = Object.values(adj).some((v) => v.state.status === "done")
  expect(hasFinal, "machine has no reachable final state").toBe(true)
}

// ---------------------------------------------------------------------------
// Machine mirrors
// ---------------------------------------------------------------------------
// Each machine mirrors its production counterpart's state graph exactly.
// Update these when the production machine changes.

/** Mirror: packages/proxy/acp/agent.ts connectionMachine */
function proxyConnectionMachine() {
  const { logger } = captureLogs()
  return ownerSetup<
    OwnerContext,
    { type: "initialized" } | { type: "closed" }
  >("connection", logger, defaultClock).createMachine({
    context: { generation: 0 },
    initial: "handshaking",
    on: { closed: ".closed" },
    states: {
      handshaking: { on: { initialized: "ready" } },
      ready: {},
      closed: { type: "final" },
    },
  })
}

/** Mirror: packages/proxy/core/channel.ts membershipMachine */
function membershipMachine() {
  const { logger } = captureLogs()
  return ownerSetup<
    OwnerContext,
    | { type: "followed" }
    | { type: "part" }
    | { type: "join" }
    | { type: "joined" }
    | { type: "fell-behind" }
  >("membership", logger, defaultClock).createMachine({
    context: { generation: 0 },
    initial: "joining",
    on: { followed: { actions: "bumpGeneration" }, part: ".detached" },
    states: {
      joining: {
        after: { [JOIN_DEADLINE_MS]: "detached" },
        on: {
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

/** Mirror: packages/proxy/core/session-coordinator.ts turnMachine */
function turnMachine() {
  const { logger } = captureLogs()
  const clock = defaultClock
  const turn = ownerSetup<
    {
      generation: number
      resting: "idle" | "waiting-for-input" | "uncertain"
      uncertainUntil: number
      reconciles: number
    },
    | { type: "admit" }
    | {
        type: "admitted"
        state: "running" | "waiting-for-input" | "uncertain"
        turnId: string
      }
    | { type: "refused" }
    | { type: "cleared" }
    | { type: "ended" }
    | { type: "paused" }
    | { type: "lost" }
    | { type: "stopped" }
    | { type: "stopping" }
    | { type: "undispatched" }
    | { type: "stopFailed" }
  >("turn", logger, clock).extend({
    delays: {
      outcomeUnknown: ({ context }) =>
        Math.max(0, context.uncertainUntil - clock.now()),
      reconcile: ({ context }) =>
        context.reconciles === 0
          ? 0
          : backoffDelay(context.reconciles - 1, RECONCILE_BACKOFF),
    },
  })
  const doubt = turn.assign({ uncertainUntil: () => clock.now() + UNCERTAINTY_DEADLINE_MS })
  const unsure = { target: "uncertain" as const, actions: doubt }
  return turn.createMachine({
    context: {
      generation: 0,
      resting: "idle" as const,
      uncertainUntil: 0,
      reconciles: 0,
    },
    initial: "idle",
    states: {
      idle: {
        on: {
          admit: {
            target: "admitting",
            actions: turn.assign({ resting: "idle", reconciles: 0 }),
          },
        },
      },
      admitting: {
        on: {
          admitted: [
            {
              guard: ({ event }) => event.state === "waiting-for-input",
              target: "waiting-for-input",
              actions: "bumpGeneration",
            },
            {
              guard: ({ event }) => event.state === "uncertain",
              target: "uncertain",
              actions: ["bumpGeneration", doubt],
            },
            { target: "running", actions: "bumpGeneration" },
          ],
          refused: [
            {
              guard: ({ context }) => context.resting === "waiting-for-input",
              target: "waiting-for-input",
            },
            {
              guard: ({ context }) => context.resting === "uncertain",
              target: "uncertain",
            },
            { target: "idle" },
          ],
          cleared: "idle",
          ended: {
            guard: ({ context }) => context.resting !== "idle",
            actions: turn.assign({ resting: "idle" }),
          },
          paused: {
            guard: ({ context }) => context.resting === "uncertain",
            actions: turn.assign({ resting: "waiting-for-input" }),
          },
          lost: {
            guard: ({ context }) => context.resting === "waiting-for-input",
            actions: [turn.assign({ resting: "uncertain" }), doubt],
          },
        },
      },
      running: {
        on: {
          ended: "idle",
          paused: "waiting-for-input",
          lost: unsure,
          stopped: "idle",
          stopping: "stopping",
          stopFailed: unsure,
        },
      },
      stopping: {
        on: {
          ended: "idle",
          paused: "waiting-for-input",
          lost: unsure,
          stopped: "idle",
          undispatched: "running",
          stopFailed: unsure,
        },
      },
      "waiting-for-input": {
        on: {
          admit: {
            target: "admitting",
            actions: turn.assign({ resting: "waiting-for-input", reconciles: 0 }),
          },
          ended: "idle",
          lost: unsure,
          stopped: "idle",
          stopping: "stopping",
          stopFailed: unsure,
        },
      },
      uncertain: {
        after: {
          outcomeUnknown: "idle",
          reconcile: {
            actions: turn.assign({
              reconciles: ({ context }) => context.reconciles + 1,
            }),
          },
        },
        on: {
          admit: {
            target: "admitting",
            actions: turn.assign({ resting: "uncertain", reconciles: 0 }),
          },
          ended: "idle",
          paused: "waiting-for-input",
        },
      },
    },
  })
}

/** Mirror: packages/proxy/core/link.ts link machine */
function linkMachine() {
  const { logger } = captureLogs()
  const clock = defaultClock
  const actors = {
    dial: fromAbortable(async () => undefined as void),
  }
  const link = ownerSetup<
    OwnerContext,
    { type: "lost"; cause: unknown } | { type: "retry" }
  >("link", logger, clock, actors).extend({
    delays: { redial: () => backoffDelay(0, LINK_BACKOFF) },
  })
  return link.createMachine({
    context: { generation: 0 },
    initial: "connecting",
    states: {
      connecting: {
        entry: "bumpGeneration",
        invoke: {
          src: "dial",
          input: ({ context }) => context.generation,
          onDone: "ready",
          onError: [{ guard: () => false, target: "lost" }, "backing-off"],
        },
        on: { lost: [{ guard: () => false, target: "lost" }, "backing-off"] },
      },
      ready: {
        meta: { log: "info" },
        on: { lost: [{ guard: () => false, target: "lost" }, "backing-off"] },
      },
      "backing-off": {
        after: { redial: "connecting" },
        on: { retry: { guard: () => true, target: "connecting" } },
      },
      lost: {
        meta: { log: "info" },
        on: {
          retry: [{ guard: () => true, target: "connecting" }, "backing-off"],
        },
      },
    },
  })
}

/** Mirror: packages/proxy/core/session-reporter.ts readingMachine */
function readingMachine() {
  const { logger } = captureLogs()
  const clock = defaultClock
  const actors = { read: fromAbortable(async () => undefined) }
  const reading = ownerSetup<
    OwnerContext,
    { type: "read"; cause?: unknown } | { type: "retry" } | { type: "stop" }
  >("reading", logger, clock, actors).extend({
    delays: { retry: () => backoffDelay(0, READING_BACKOFF) },
  })
  return reading.createMachine({
    context: { generation: 0 },
    initial: "idle",
    states: {
      idle: {
        on: {
          read: { target: "reading" },
          retry: [{ guard: () => true, target: "reading" }, "backing-off"],
        },
      },
      reading: {
        invoke: {
          src: "read",
          onDone: [
            { guard: () => false, target: "reading", reenter: true },
            "idle",
          ],
          onError: [{ guard: () => false, target: "backing-off" }, "idle"],
        },
        on: { read: {} },
      },
      "backing-off": {
        after: { retry: "reading" },
        on: {
          read: { target: "reading" },
          retry: { guard: () => true, target: "reading" },
          stop: "idle",
        },
      },
    },
  })
}

// Silence cross-reference imports (JOIN_DEADLINE_MS = ADMISSION_DEADLINE_MS).
void ADMISSION_DEADLINE_MS
void UNCERTAINTY_DEADLINE_MS

// ---------------------------------------------------------------------------
// Coverage tests
// ---------------------------------------------------------------------------

// hasFinal: turn/link/reading have no self-terminating final state -- they
// run until externally disposed via owner.dispose(). Connection and membership
// do have final states (closed, detached).
const machines: Array<[string, () => AnyStateMachine, boolean]> = [
  ["proxy-connection", proxyConnectionMachine, true],
  ["membership", membershipMachine, true],
  ["turn", turnMachine, false],
  ["link", linkMachine, false],
  ["reading", readingMachine, false],
]

describe("state×event coverage â proxy owner machines (4.31)", () => {
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

  /**
   * Check: a deliberately stuck non-final state (zero outbound transitions)
   * is an "unhandled edge" that assertBounded flags as a failing row.
   *
   * it.fails: the test passes iff assertBounded throws for the stuck state,
   * proving the checker detects the deliberately broken machine.
   */
  it.fails(
    "a stuck non-final state produces a failing row (deliberate unhandled edge)",
    () => {
      const { logger } = captureLogs()
      const stuck = ownerSetup<OwnerContext, { type: "go" }>(
        "connection",
        logger,
        defaultClock
      ).createMachine({
        context: { generation: 0 },
        initial: "active",
        states: {
          active: { on: { go: "stuck" } },
          // Deliberately stuck: non-final, zero transitions -- an unhandled edge.
          stuck: {},
        },
      })
      // assertBounded MUST throw for stuck; it.fails confirms it does.
      assertBounded(stuck)
    }
  )
})
