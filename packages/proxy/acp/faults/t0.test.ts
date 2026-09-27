import { describe, expect, it } from "vitest"

import {
  createOwner,
  defaultClock,
  ownerSetup,
  type Logger,
} from "../../../lifecycle"
import { AGENT, harness, MODELS, SESSION } from "../test-harness"

/** A membership owner for one Session: idle → joining → joined. */
function membership(logger: Logger, session: string) {
  const machine = ownerSetup("membership", logger, defaultClock).createMachine({
    context: { generation: 0 },
    initial: "idle",
    states: {
      idle: { on: { join: "joining" } },
      joining: { on: { joined: "joined" } },
      joined: { meta: { log: "info" } },
    },
  })
  return createOwner(machine, {
    logger,
    clock: defaultClock,
    bindings: { sessionId: session },
  })
}

describe("fault harness", () => {
  it("fails an armed operation's next call once", async () => {
    const test = await harness()
    const { runtime } = test.runtimeInstance

    test.faults.failOnce("models")
    await expect(runtime.models(AGENT, SESSION)).rejects.toThrow()
    await expect(runtime.models(AGENT, SESSION)).resolves.toEqual(MODELS)
    test.close()
  })

  it("captures each owner's transitions under its Session", async () => {
    const test = await harness()
    const first = membership(test.logs.logger, "session-1")
    const second = membership(test.logs.logger, "session-2")

    first.actor.send({ type: "join" })
    second.actor.send({ type: "join" })
    first.actor.send({ type: "joined" })

    const { transitions } = test.logs
    expect(
      transitions({ owner: "membership", sessionId: "session-1" })
    ).toEqual([
      ["idle", "joining"],
      ["joining", "joined"],
    ])
    expect(
      transitions({ owner: "membership", sessionId: "session-2" })
    ).toEqual([["idle", "joining"]])
    first.dispose()
    second.dispose()
    test.close()
  })
})
