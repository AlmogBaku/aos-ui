/**
 * 4.31 Generated state×event rows from every browser owner machine, each
 * built by its production builder over stub dependencies: every state is
 * final or has a way out, so no owner is held for good.
 */
import { describe, it } from "vitest"
import type { AnyStateMachine } from "xstate"

import { defaultClock } from "@aos/lifecycle"
import { captureLogs } from "../../../../../test/support/log-capture"
import {
  assertBounded,
  assertHasFinalState,
} from "../../../../../test/support/machine-coverage"
import { connectionMachine, sessionMachine } from "../connection"

const { logger } = captureLogs()
const clock = defaultClock

const MACHINES: [string, () => AnyStateMachine][] = [
  [
    "browser-connection",
    () =>
      connectionMachine({
        open: async () => undefined,
        handshake: async () => undefined,
        recover: async () => undefined,
        inProcess: false,
        closeTransport() {},
        markReady() {},
        lose() {},
        logger,
        clock,
      }),
  ],
  [
    "session-owner",
    () =>
      sessionMachine(
        {
          join: async () => undefined,
          replayOwed: () => false,
          oweReplay() {},
          transportLost: () => false,
          refuse() {},
          logger,
          clock,
        },
        "session-1",
        "joining"
      ),
  ],
]

describe("state×event coverage of the browser owner machines", () => {
  for (const [name, machine] of MACHINES)
    describe(name, () => {
      it("leaves every non-final state by some transition", () => {
        assertBounded(machine())
      })
      it("reaches its final state", () => {
        assertHasFinalState(machine())
      })
    })
})
