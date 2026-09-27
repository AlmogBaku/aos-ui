import { expect } from "vitest"
import { createActor, type AnyStateMachine } from "xstate"
import { getAdjacencyMap } from "xstate/graph"

type Adjacency = Record<
  string,
  {
    state: { status: string; value: unknown }
    transitions: Record<string, unknown>
  }
>

/**
 * The machine's state×event rows from `fromState` on, or from its initial
 * state: one per state it reaches and event that state declares (an `on`, an
 * `after`, or an invoke's outcome). States are keyed by value and events by
 * type, so a context that keeps growing, as a generation does, still ends the
 * walk.
 */
function adjacency(machine: AnyStateMachine, fromState?: unknown) {
  return getAdjacencyMap(
    machine as never,
    {
      serializeState: (snapshot: { value: unknown }) =>
        JSON.stringify(snapshot.value),
      serializeEvent: (event: { type: string }) =>
        JSON.stringify({ type: event.type }),
      ...(fromState === undefined ? {} : { fromState }),
    } as never
  ) as unknown as Adjacency
}

/**
 * Every state the machine declares is final or has a way out: a state with
 * none is an unhandled edge, which holds its owner for good. Each state is
 * walked from itself, so one only a guard the stubs hold shut reaches is
 * still checked. Owner machines are flat: their states are the root's.
 */
export function assertBounded(machine: AnyStateMachine) {
  const { context } = createActor(machine).getSnapshot() as {
    context: unknown
  }
  for (const value of Object.keys(machine.root.states)) {
    const from = machine.resolveState({ value, context } as never)
    for (const { state, transitions } of Object.values(
      adjacency(machine, from)
    )) {
      if (state.status === "done") continue
      expect(
        Object.keys(transitions).length,
        `state "${String(state.value)}" is non-final with no outbound transition`
      ).toBeGreaterThan(0)
    }
  }
}

/** The machine reaches a final state, where its owner releases what it holds. */
export function assertHasFinalState(machine: AnyStateMachine) {
  expect(
    Object.values(adjacency(machine)).some(
      ({ state }) => state.status === "done"
    ),
    "machine has no reachable final state"
  ).toBe(true)
}
