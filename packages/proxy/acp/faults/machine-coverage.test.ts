/**
 * 4.31 Generated state×event rows from every proxy owner machine, each built
 * by its production builder over stub dependencies: every state is final or
 * has a way out, so no owner is held for good.
 */
import { describe, it } from "vitest"
import type { AnyStateMachine } from "xstate"

import { defaultClock, ownerSetup, type OwnerContext } from "../../../lifecycle"
import { captureLogs } from "../../../../test/support/log-capture"
import {
  assertBounded,
  assertHasFinalState,
} from "../../../../test/support/machine-coverage"
import { membershipMachine } from "../../core/channel"
import { linkMachine, READY_LINK } from "../../core/link"
import { turnMachine } from "../../core/session-coordinator"
import { readingMachine } from "../../core/session-reporter"
import { connectionMachine } from "../agent"

const { logger } = captureLogs()
const clock = defaultClock

/** Each machine, and whether it ends by itself rather than on dispose. */
const MACHINES: [string, () => AnyStateMachine, boolean][] = [
  ["proxy-connection", () => connectionMachine(logger, clock), true],
  ["membership", () => membershipMachine(logger, clock), true],
  [
    "turn",
    () => turnMachine(logger, clock, { reconcile() {}, outcomeUnknown() {} }),
    false,
  ],
  [
    "link",
    () =>
      linkMachine({
        dial: async () => undefined,
        failures: () => 1,
        ends: () => false,
        fail() {},
        up() {},
        takes: () => true,
        logger,
        clock,
      }),
    false,
  ],
  [
    "reading",
    () =>
      readingMachine(
        {
          scope: { agentId: "agent-1" },
          listeners: new Map(),
          stale: true,
          owed: new Set(),
          next: new Set(),
          failures: 0,
          log: logger,
        },
        {
          name: "reading-1",
          read: async () => undefined,
          link: READY_LINK,
          budget: { take: () => true },
          publicError: () => undefined,
          logger,
          clock,
        }
      ),
    false,
  ],
]

describe("state×event coverage of the proxy owner machines", () => {
  for (const [name, machine, ends] of MACHINES)
    describe(name, () => {
      it("leaves every non-final state by some transition", () => {
        assertBounded(machine())
      })
      if (ends)
        it("reaches its final state", () => {
          assertHasFinalState(machine())
        })
    })

  it.fails("fails a row for a non-final state with no way out", () => {
    const stuck = ownerSetup<OwnerContext, { type: "go" }>(
      "connection",
      logger,
      clock
    ).createMachine({
      context: { generation: 0 },
      initial: "active",
      states: { active: { on: { go: "stuck" } }, stuck: {} },
    })
    assertBounded(stuck)
  })
})
