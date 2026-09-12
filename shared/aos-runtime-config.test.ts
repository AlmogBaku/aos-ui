import { describe, expect, it } from "vitest"

import {
  parsePublicRuntimeConfiguration,
  resolveRuntimeConfiguration,
  serializePublicRuntimeConfiguration,
} from "./runtime-config"

describe("provider-neutral AOS runtime configuration", () => {
  it("defaults to the normalized AOS proxy", () => {
    expect(resolveRuntimeConfiguration({})).toMatchObject({
      status: "ready",
      mode: "aos",
    })
  })

  it("selects the same-origin proxy without exposing a provider URL", () => {
    const resolved = resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "aos" })
    expect(resolved).toEqual({
      status: "ready",
      mode: "aos",
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: true,
      },
    })
    expect(serializePublicRuntimeConfiguration(resolved)).toEqual({
      mode: "aos",
    })
    expect(parsePublicRuntimeConfiguration({ mode: "aos" })).toEqual(resolved)
    expect(
      parsePublicRuntimeConfiguration({
        mode: "aos",
        providerUrl: "http://127.0.0.1:9119",
      })
    ).toEqual({ status: "unavailable", reason: "invalid-public-config" })
  })

  it.each(["opencode", "hermes", "ag-ui", "openclaw"])(
    "rejects retired direct browser runtime mode %s",
    (mode) => {
      expect(resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: mode })).toEqual(
        { status: "unavailable", reason: "invalid-runtime-mode" }
      )
      expect(parsePublicRuntimeConfiguration({ mode })).toEqual({
        status: "unavailable",
        reason: "invalid-public-config",
      })
    }
  )
})
