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
})
