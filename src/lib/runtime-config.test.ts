import { describe, expect, it } from "vitest"

import { resolveRuntimeConfiguration } from "./runtime-config"

describe("resolveRuntimeConfiguration", () => {
  it("defaults the browser to the normalized AOS proxy", () => {
    expect(resolveRuntimeConfiguration({})).toMatchObject({
      status: "ready",
      mode: "aos",
    })
  })

  it("does not expose the retired hermes browser mode", () => {
    expect(
      resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "hermes" })
    ).toEqual({ status: "unavailable", reason: "invalid-runtime-mode" })
  })
})
