import { describe, expect, it, vi } from "vitest"

import { backoffDelay, defaultClock } from "../../lifecycle"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import { providerSessionId, sessionId } from "./ids"
import { READING_BACKOFF } from "./limits"
import { SessionReporter } from "./session-reporter"

const scope = {
  agentId: "researcher",
  providerSessionId: providerSessionId("provider-1"),
  sessionId: sessionId("session-1"),
}

function cells(read: () => Promise<string>) {
  return new SessionReporter<string>({
    name: "usage",
    read,
    logger: captureLogs().logger,
    clock: defaultClock,
  })
}

const listener = () => vi.fn<(reading: string) => Promise<void>>(async () => {})

describe("SessionReporter", () => {
  it("gives a second subscriber the value the first one's read took", async () => {
    const clock = useFakeClock()
    const read = vi.fn(async () => "reading")
    const reporter = cells(read)
    reporter.subscribe("session-1", scope, "first", listener())
    await clock.advance(0)

    const second = listener()
    reporter.subscribe("session-1", scope, "second", second)

    expect(second).toHaveBeenCalledWith("reading")
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("re-reads a failed read once its backoff elapses", async () => {
    const clock = useFakeClock()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValue("reading")
    const subscriber = listener()
    cells(read).subscribe("session-1", scope, "subscriber", subscriber)

    const delay = backoffDelay(0, READING_BACKOFF)
    await clock.advance(delay - 1)
    expect(subscriber).not.toHaveBeenCalled()
    await clock.advance(1)
    expect(subscriber).toHaveBeenCalledWith("reading")
  })

  it("gives a subscriber back after a reconnect the last value while a fresh read runs", async () => {
    const clock = useFakeClock()
    const read = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("before")
      .mockResolvedValue("after")
    const reporter = cells(read)
    const leave = reporter.subscribe("session-1", scope, "browser", listener())
    await clock.advance(0)
    leave()

    const returning = listener()
    reporter.subscribe("session-1", scope, "browser", returning)
    expect(returning.mock.calls).toEqual([["before"]])

    await clock.advance(0)
    expect(returning.mock.calls).toEqual([["before"], ["after"]])
  })
})
