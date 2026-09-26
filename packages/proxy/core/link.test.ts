import { describe, expect, it, vi } from "vitest"

import { defaultClock } from "../../lifecycle"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import { failureOf } from "./failures"
import { createLink } from "./link"

describe("createLink", () => {
  it("stops dialing after five failed dials and tries one more ten seconds on", async () => {
    const clock = useFakeClock()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const dial = vi.fn(() => Promise.reject(new Error("refused")))
    const link = createLink({
      dial,
      publicError: () => undefined,
      logger: captureLogs().logger,
      clock: defaultClock,
      bindings: { link: "native" },
    })

    // At half jitter the redials wait 125, 250, 500 and 1_000 ms.
    await clock.advance(1_875)
    expect(dial).toHaveBeenCalledTimes(5)
    // The redials the backoff keeps taking meet the open circuit.
    await clock.advance(9_999)
    expect(dial).toHaveBeenCalledTimes(5)
    // The first redial past the half-open wait is dialed, within the cap.
    await clock.advance(5_001)
    expect(dial).toHaveBeenCalledTimes(6)
    link.dispose()
  })

  it("stays lost on refused credentials until its upstream turns ready, warning once per kind", async () => {
    const clock = useFakeClock()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const refused = new Error("refused")
    const dial = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(undefined)
    let turnReady!: () => void
    const logs = captureLogs()
    const link = createLink({
      dial,
      publicError: (cause) =>
        cause === refused
          ? failureOf("runtime_authentication_required", cause)
          : undefined,
      upstream: {
        state: () => "lost",
        subscribe: (listener) => {
          turnReady = () => listener("ready")
          return () => {}
        },
      },
      logger: logs.logger,
      clock: defaultClock,
      bindings: { link: "native" },
    })

    await clock.advance(60_000)
    expect(dial).toHaveBeenCalledTimes(1)
    // Each time the upstream turns ready the link dials once more.
    turnReady()
    await clock.advance(0)
    expect(dial).toHaveBeenCalledTimes(2)
    expect(link.state()).toBe("lost")
    // An unavailable dial keeps to its backoff: 500 ms at half jitter.
    turnReady()
    await clock.advance(500)
    expect(dial).toHaveBeenCalledTimes(4)
    expect(link.state()).toBe("ready")
    expect(
      logs
        .records()
        .filter(({ message }) => message === "link.failed")
        .map(({ fields }) => fields.kind)
    ).toEqual(["runtime_authentication_required", "unavailable"])
    link.dispose()
  })
})
