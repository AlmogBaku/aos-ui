import { describe, expect, it } from "vitest"

import {
  parsePublicApplicationConfiguration,
  parsePublicRuntimeConfiguration,
  resolveRuntimeConfiguration,
  serializePublicRuntimeConfiguration,
} from "./runtime-config"

describe("browser runtime configuration", () => {
  it("round-trips the AOS proxy configuration without a provider URL", () => {
    const resolved = resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "aos" })
    expect(serializePublicRuntimeConfiguration(resolved)).toEqual({
      mode: "aos",
    })
    expect(parsePublicRuntimeConfiguration({ mode: "aos" })).toEqual(resolved)
  })

  it("keeps fixture explicit and composer capability switches independent", () => {
    expect(
      parsePublicRuntimeConfiguration({
        mode: "fixture",
        composerModelSelectorEnabled: false,
      })
    ).toMatchObject({
      status: "ready",
      mode: "fixture",
      composerFeatures: {
        modelSelectorEnabled: false,
        contextEnabled: true,
      },
    })
  })

  it("rejects provider settings and unrecognized public fields", () => {
    for (const input of [
      undefined,
      {},
      { mode: "hermes", baseUrl: "/hermes" },
      { mode: "aos", providerUrl: "http://127.0.0.1:9119" },
      { mode: "aos", apiKey: "secret" },
    ]) {
      expect(parsePublicRuntimeConfiguration(input)).toEqual({
        status: "unavailable",
        reason: "invalid-public-config",
      })
    }
  })

  it("recognizes the isolated guest listener without treating it as a runtime", () => {
    expect(
      parsePublicApplicationConfiguration({
        surface: "guest",
        basePath: "/api/guest/v1/",
        lane: "guest",
      })
    ).toEqual({
      status: "ready",
      surface: "guest",
      basePath: "/api/guest/v1",
      lane: "guest",
      composerSlashCommandsEnabled: false,
    })
  })

  it("enables guest slash-command suggestions only when the public guest flag is true", () => {
    expect(
      parsePublicApplicationConfiguration({
        surface: "guest",
        basePath: "/api/guest/v1",
        lane: "guest",
        composerSlashCommandsEnabled: true,
      })
    ).toMatchObject({
      status: "ready",
      surface: "guest",
      composerSlashCommandsEnabled: true,
    })
  })
})
