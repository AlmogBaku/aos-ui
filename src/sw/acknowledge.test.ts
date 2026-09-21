import { describe, expect, it } from "vitest"

import { acknowledge } from "./acknowledge"

describe("the answer a window owes a notification click", () => {
  it("answers yes as soon as the window replies on its port", async () => {
    const { port, answered } = acknowledge(1_000)

    port.postMessage({ type: "aos:open-ack" })

    await expect(answered).resolves.toBe(true)
  })

  it("answers no once the deadline passes in silence", async () => {
    const { answered } = acknowledge(5)

    await expect(answered).resolves.toBe(false)
  })

  it("ignores a window that answers after it gave up", async () => {
    const { port, answered } = acknowledge(5)
    await expect(answered).resolves.toBe(false)

    // The port the worker held is closed, so a late answer reaches nothing and
    // the click it belonged to -- already handled by an opened window -- is not
    // reopened by it.
    expect(() => port.postMessage({ type: "aos:open-ack" })).not.toThrow()
    await expect(answered).resolves.toBe(false)
  })
})
