import { describe, expect, it } from "vitest"

import { resolveRuntimeConfiguration } from "./runtime-config"

describe("resolveRuntimeConfiguration", () => {
  it("defaults the browser to the normalized AOS proxy", () => {
    expect(resolveRuntimeConfiguration({})).toMatchObject({
      status: "ready",
      mode: "aos",
    })
  })

  it.each(["opencode", "hermes", "ag-ui", "openclaw"])(
    "does not expose the retired %s browser mode",
    (mode) => {
      expect(resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: mode })).toEqual(
        { status: "unavailable", reason: "invalid-runtime-mode" }
      )
    }
  )
})
