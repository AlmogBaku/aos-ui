import { methods } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { AOS_META_KEY, AOS_METHODS } from "../../../protocol/acp"
import { useFakeClock } from "../../../../test/support/fake-clock"
import {
  chunk,
  harness,
  open,
  prompt,
  said,
  SESSION,
  turnStarted,
  type Browser,
} from "../test-harness"

/** A resume at the cursor a browser holds of `turnId`, as its rejoin sends. */
function rejoin(browser: Browser, turnId: string | undefined, after: number) {
  return browser.agent.request(methods.agent.session.resume, {
    sessionId: SESSION,
    cwd: "/",
    _meta: { [AOS_META_KEY]: { turnId, after } },
  })
}

describe("gone Session faults", () => {
  it("tells every member of a Session gone mid-turn once, reads it no more, and resumes it from the provider", async () => {
    const test = await harness({ providerIds: true })
    const other = await test.connect("connection-2")
    await test.list()
    await other.list()
    await open(test)
    await open(other)
    await prompt(test, "Summarize")
    test.sources[0]?.emit(turnStarted())
    chunk(test.sources[0], "Live")
    for (const { recorder } of [test, other])
      await recorder.wait(said("Live"), "an update carrying Live")
    const { turnId } = test.coordinator.snapshot(test.scope)
    const clock = useFakeClock()
    test.faults.gone(test.scope)

    // Both sockets drop, and both browsers rejoin at their cursor.
    test.close()
    other.close()
    const browsers = [
      await test.connect("connection-3"),
      await test.connect("connection-4"),
    ]
    for (const browser of browsers) {
      await browser.list()
      await rejoin(browser, turnId, 2)
    }
    await clock.advance(60_000)

    for (const browser of browsers)
      expect(browser.recorder.of(AOS_METHODS.notify.error)).toEqual([
        {
          method: AOS_METHODS.notify.error,
          params: {
            sessionId: SESSION,
            code: "not_found",
            message: "not_found",
          },
        },
      ])
    expect(test.logs.transitions({ owner: "reading" })).not.toContainEqual([
      "reading",
      "backing-off",
    ])
    const [browser] = browsers
    const resumed = await rejoin(browser!, turnId, 2)
    expect(resumed._meta?.[AOS_META_KEY]).toEqual({ resync: true })
    await expect(
      browser!.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
        replayFrom: { type: "start" },
      })
    ).rejects.toMatchObject({ code: -32002 })
    for (const each of browsers) each.close()
  })

  it("ends every member and the execution of a Session a from-start resume finds gone", async () => {
    const test = await harness({ providerIds: true })
    const other = await test.connect("connection-2")
    await test.list()
    await other.list()
    await open(test)
    await open(other)
    await prompt(test, "Summarize")
    test.sources[0]?.emit(turnStarted())
    chunk(test.sources[0], "Live")
    await other.recorder.wait(said("Live"), "an update carrying Live")
    test.faults.gone(test.scope)

    await expect(
      test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
        replayFrom: { type: "start" },
      })
    ).rejects.toMatchObject({ code: -32002 })

    expect(other.recorder.of(AOS_METHODS.notify.error)).toEqual([
      {
        method: AOS_METHODS.notify.error,
        params: { sessionId: SESSION, code: "not_found", message: "not_found" },
      },
    ])
    expect(test.coordinator.gauges().executions).toBe(0)
    other.close()
  })
})
