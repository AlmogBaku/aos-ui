import { describe, expect, it } from "vitest"

import { harness, open, type Recorded } from "../test-harness"

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
})
