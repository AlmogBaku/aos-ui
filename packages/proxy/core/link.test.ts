import { describe, expect, it, vi } from "vitest"

import { defaultClock } from "../../lifecycle"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
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
})
