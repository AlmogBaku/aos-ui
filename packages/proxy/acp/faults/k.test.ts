import { methods } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import { AOS_JSONRPC_ERRORS } from "../../../protocol/acp"
import { useFakeClock } from "../../../../test/support/fake-clock"
import { harness, open, SESSION, type Recorded } from "../test-harness"

const modelOptions = (entry: Recorded) =>
  JSON.stringify(entry.params).includes("config_option_update")

/** How many times the Session's model options were read for its members. */
function modelReads(test: Awaited<ReturnType<typeof harness>>) {
  return test.logs
    .records()
    .filter(
      ({ message, fields }) =>
        message === "reading.transition" &&
        fields.reading === "models" &&
        fields.to === "reading"
    ).length
}

describe("membership faults", () => {
  it("gives a late joiner the model options its Session last read, without reading them again", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await open(test)
    await test.recorder.wait(modelOptions, "the first browser's model options")
    const other = await test.connect("connection-2")
    await other.list()

    await open(other)
    await other.recorder.wait(modelOptions, "the late joiner's model options")

    expect(modelReads(test)).toBe(1)
    test.close()
    other.close()
  })

  it("answers a resume whose model read fails and sends the model options once a re-read lands", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const clock = useFakeClock()
    test.faults.failOnce("models")

    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await clock.advance(1_000)

    await test.recorder.wait(modelOptions, "the re-read model options")
    expect(modelReads(test)).toBe(2)
    test.close()
  })

  it("ends a join whose replay never settles at its deadline and frees its place for the next join", async () => {
    const test = await harness()
    await test.list()
    const clock = useFakeClock()
    test.faults.hangUntilAborted("history")

    const refused = expect(
      test.agent.request(methods.agent.session.resume, {
        sessionId: SESSION,
        cwd: "/",
        replayFrom: { type: "start" },
      })
    ).rejects.toMatchObject({
      code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
    })
    await clock.advance(30_000)
    await refused
    expect(
      test.logs.transitions({ owner: "membership", sessionId: SESSION })
    ).toContainEqual(["joining", "detached"])

    // A join still holding the place would leave the next one without its
    // execution, which only a joined membership is shown.
    const from = test.recorder.entries.length
    await test.agent.request(methods.agent.session.resume, {
      sessionId: SESSION,
      cwd: "/",
    })
    await clock.advance(0)
    await test.recorder.wait(
      (entry) =>
        test.recorder.entries.indexOf(entry) >= from &&
        JSON.stringify(entry.params).includes("state_update"),
      "the next join's execution"
    )
    test.close()
  })
})
