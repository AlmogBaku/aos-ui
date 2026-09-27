import { describe, expect, it, vi } from "vitest"

import { backoffDelay, defaultClock } from "../../lifecycle"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import { providerSessionId, sessionId } from "./ids"
import { READING_BACKOFF } from "./limits"
import { READY_LINK, type LinkState, type ServerLink } from "./link"
import { SessionReporter } from "./session-reporter"

const scope = {
  agentId: "researcher",
  providerSessionId: providerSessionId("provider-1"),
  sessionId: sessionId("session-1"),
}

function cells(
  read: () => Promise<string>,
  { link = READY_LINK, logs = captureLogs() } = {}
) {
  return new SessionReporter<string>({
    name: "usage",
    read,
    link,
    budget: { take: () => true },
    publicError: () => undefined,
    logger: logs.logger,
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

  it("keeps delivering a released cell's readings to a listener it still has", async () => {
    const clock = useFakeClock()
    const read = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("before")
      .mockResolvedValue("after")
    const reporter = cells(read)
    const subscriber = listener()
    reporter.subscribe("session-1", scope, "browser", subscriber)
    await clock.advance(0)

    reporter.release("session-1")
    reporter.report("session-1")
    await clock.advance(0)

    expect(subscriber.mock.calls).toEqual([["before"], ["after"]])
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

  it("re-reads a failed read at once when the link is up again", async () => {
    const clock = useFakeClock()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValue("reading")
    const listeners = new Set<(state: LinkState) => void>()
    const link: ServerLink = {
      state: () => "lost",
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const logs = captureLogs()
    const subscriber = listener()
    cells(read, { link, logs }).subscribe(
      "session-1",
      scope,
      "subscriber",
      subscriber
    )
    await clock.advance(0)

    for (const ready of listeners) ready("ready")
    await clock.advance(0)

    expect(subscriber).toHaveBeenCalledWith("reading")
    // The failed read is logged by its cell and kind, never its message.
    expect(logs.records()).toContainEqual({
      level: "warn",
      message: "reading.failed",
      fields: {
        reading: "usage",
        agentId: "researcher",
        sessionId: "session-1",
        kind: "unclassified",
      },
    })
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
