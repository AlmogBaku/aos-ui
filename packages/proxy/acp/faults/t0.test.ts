import { describe, expect, it, vi } from "vitest"

import {
  createOwner,
  defaultClock,
  ownerSetup,
  type Logger,
} from "../../../lifecycle"
import { useFakeClock } from "../../../../test/support/fake-clock"
import { providerSessionId, sessionId } from "../../core/ids"
import { SessionReporter } from "../../core/session-reporter"
import { AGENT, harness, MODELS, SESSION } from "../test-harness"

const scope = {
  agentId: "researcher",
  providerSessionId: providerSessionId("provider-1"),
  sessionId: sessionId("session-1"),
}

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
  it("fires each reporter retry exactly at its delay", async () => {
    const clock = useFakeClock()
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValue("reading")
    const reporter = new SessionReporter({
      read,
      retryDelaysMs: [1_000, 2_000],
    })
    const listener = vi.fn<(reading: string) => Promise<void>>(async () => {})
    reporter.subscribe("session-1", scope, "subscriber", listener)

    await reporter.report("session-1")
    await clock.advance(2_999)
    expect(listener).not.toHaveBeenCalled()
    await clock.advance(1)
    expect(listener).toHaveBeenCalledWith("reading")
  })

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
