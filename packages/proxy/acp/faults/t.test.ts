import { client } from "@agentclientprotocol/sdk/experimental/v2"
import { describe, it } from "vitest"

import { useFakeClock } from "../../../../test/support/fake-clock"
import { assertLeakFree } from "../../../../test/support/leak-oracle"
import { harness } from "../test-harness"

describe("leak oracle", () => {
  /**
   * A socket that closes before completing the initialize handshake must
   * release every feed it opened and leave no pending timers. This row
   * failed before K 3.37 (observers were not released) and passes now.
   */
  it("a socket closed before initialize leaves zero observers and zero timers", async () => {
    const clock = useFakeClock()
    const test = await harness()

    // Close a second connection before it completes its initialize handshake.
    const early = client({ name: "aos-browser" }).connect(test.agentApp())
    early.close()

    // Close the primary connection too.
    test.close()

    // Flush the microtasks that complete the cleanup in both connections'
    // onRequest(initialize) handlers before asserting.
    await clock.advance(0)

    assertLeakFree(test)
  })
})
